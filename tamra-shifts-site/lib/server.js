'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const S = require('./schedule.js');
const auth = require('./auth.js');
const actions = require('./actions.js');
const xlsxTruth = require('./xlsx-truth.js');
const xlsxWriter = require('./xlsx-writer.js');
const scheduleExport = require('./schedule-export.js');
const push = require('./push.js');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VALID_ROLES = ['fuel', 'store']; // office removed — no shifts are scheduled for it anymore
const VALID_GENDERS = ['male', 'female'];
function isValidTimeStr(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
// Shifts per week the manager sets for an employee: null/'' = flexible, otherwise a whole number 1-7.
function isValidShiftTarget(v) { return v == null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 7); }
function normShiftTarget(v) { return v == null || v === '' ? null : Number(v); }
function isValidDaysArray(d) { return Array.isArray(d) && d.length > 0 && d.every(x => Number.isInteger(x) && x >= 0 && x <= 6); }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// 8MB covers a base64-encoded .xlsx upload (the hours-truth report) comfortably;
// every other route in this app sends tiny JSON payloads, so this is a shared ceiling, not a per-route budget.
const MAX_JSON_BODY = 8 * 1024 * 1024;
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) { reject(new Error('body_too_large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  // No build/versioning step in this app, so filenames never change between deploys —
  // without an explicit no-cache header, browsers (mobile especially) can keep serving
  // a stale app.js/styles.css indefinitely after a new deploy. Always revalidate.
  const NO_CACHE = 'no-store, no-cache, must-revalidate';
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback: unknown non-/api routes serve index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': NO_CACHE });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': NO_CACHE });
    res.end(data);
  });
}

function makeApp(store, opts) {
  const secret = opts.sessionSecret;
  const secureCookies = !!opts.secureCookies;
  const cronSecret = opts.cronSecret;

  // An employee's session cookie stays valid for 30 days — but if the manager deactivates
  // (or deletes) that employee in the meantime, their access must end right away, not whenever
  // the cookie happens to expire.
  async function requireSession(req) {
    const session = auth.sessionFromRequest(req, secret);
    if (session && session.type === 'employee') {
      const emp = await store.getEmployee(session.employeeId);
      if (!emp || !emp.active) return null;
    }
    return session;
  }

  // ---- brute-force protection for the PIN login ----
  // PINs are short (4-6 digits), so without a limit anyone could simply try them all. After
  // LOGIN_MAX_FAILS wrong PINs for the same account from the same address within
  // LOGIN_WINDOW_MS, further attempts are refused until the window passes. In-memory is enough
  // here: a single small instance, and a restart only ever makes it more lenient.
  // Two counters per attempt: one per (address + account), and one per account regardless of
  // address (a higher limit), so switching addresses doesn't give an attacker unlimited tries.
  const LOGIN_MAX_FAILS = 8;
  const LOGIN_MAX_FAILS_ANY_IP = 25;
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const loginFails = new Map();
  // Render's proxy appends the real client address as the LAST X-Forwarded-For entry; earlier
  // entries come from the client itself and can't be trusted.
  function clientIp(req) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) { const parts = String(fwd).split(',').map(x => x.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
    return (req.socket && req.socket.remoteAddress) || '';
  }
  function loginKeys(req, body) {
    const account = body.mode === 'manager' ? 'manager' : 'emp:' + String(body.employeeId || '').slice(0, 64);
    return [{ key: clientIp(req) + '|' + account, max: LOGIN_MAX_FAILS }, { key: '*|' + account, max: LOGIN_MAX_FAILS_ANY_IP }];
  }
  function failEntry(key) {
    const e = loginFails.get(key);
    if (e && Date.now() - e.first > LOGIN_WINDOW_MS) { loginFails.delete(key); return null; }
    return e || null;
  }
  function loginBlocked(keys) { return keys.some(k => { const e = failEntry(k.key); return !!e && e.count >= k.max; }); }
  function loginFailed(keys) {
    keys.forEach(k => {
      const e = failEntry(k.key);
      if (e) e.count++; else loginFails.set(k.key, { first: Date.now(), count: 1 });
    });
    if (loginFails.size > 5000) { // keep memory bounded: drop expired entries, then the oldest
      for (const key of Array.from(loginFails.keys())) failEntry(key);
      for (const key of Array.from(loginFails.keys())) { if (loginFails.size <= 4000) break; loginFails.delete(key); }
    }
  }
  function loginSucceeded(keys) { keys.forEach(k => loginFails.delete(k.key)); }

  // ---- automatic weekly generation ----
  // There's no always-on scheduler on this hosting plan (the free web service sleeps when idle,
  // and no separate cron job is set up), so instead: once the availability deadline for next
  // week has passed (Wednesday 23:59 by default), the first visit to the site generates next
  // week's schedule if nobody has generated it (or started assigning it by hand) yet. The
  // manager can still "הפק מחדש" afterwards, and can turn this off in the settings.
  const autoGenerateEnabled = !!opts.autoGenerate;
  let autoGenLastCheck = 0;
  let autoGenRunning = null;
  function maybeAutoGenerate() {
    if (!autoGenerateEnabled || autoGenRunning) return autoGenRunning;
    if (Date.now() - autoGenLastCheck < 5 * 60 * 1000) return null;
    autoGenLastCheck = Date.now();
    autoGenRunning = (async () => {
      const settings = await store.getSettings();
      if (settings.autoGenerate === false) return;
      const target = S.nextGenerationWeek();
      if (!S.constraintDeadlinePassed(target, settings.weeklyGenerationDow)) return;
      if (await store.getScheduleWeek(target)) return; // already generated, or being built by hand
      const result = await actions.generateWeek(store, target);
      console.log('[auto-generate] week', target, result.skipped ? 'skipped' : ('generated, understaffed=' + result.week.understaffed.length));
    })().catch((err) => console.error('[auto-generate] failed:', err && err.message)).finally(() => { autoGenRunning = null; });
    return autoGenRunning;
  }

  async function currentEmployee(session) {
    if (!session || session.type !== 'employee') return null;
    return store.getEmployee(session.employeeId);
  }

  // ---- route handlers ----
  const routes = [];
  function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }
  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const parts = r.pattern.split('/').filter(Boolean);
      const actual = pathname.split('/').filter(Boolean);
      if (parts.length !== actual.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
        else if (parts[i] !== actual[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  route('GET', '/api/public/employees', async (req, res) => {
    const employees = await store.listEmployees();
    return sendJson(res, 200, { employees: employees.filter(e => e.active).map(e => ({ id: e.id, name: e.name, roleId: e.roleId })) });
  });

  route('POST', '/api/login', async (req, res, params, body) => {
    const keys = loginKeys(req, body);
    if (loginBlocked(keys)) return sendJson(res, 429, { error: 'too_many_attempts' });
    if (body.mode === 'manager') {
      const settings = await store.getSettings();
      if (String(body.pin) !== String(settings.managerPin)) { loginFailed(keys); return sendJson(res, 401, { error: 'bad_pin' }); }
      loginSucceeded(keys);
      res.setHeader('Set-Cookie', auth.makeSessionCookie({ type: 'manager' }, secret, secureCookies));
      return sendJson(res, 200, { session: { type: 'manager' } });
    }
    if (body.mode === 'employee') {
      const emp = await store.getEmployeeByPin(body.employeeId, String(body.pin || ''));
      if (!emp) {
        if (await store.getEmployee(String(body.employeeId || ''))) loginFailed(keys); // only count real accounts
        return sendJson(res, 401, { error: 'bad_pin' });
      }
      loginSucceeded(keys);
      res.setHeader('Set-Cookie', auth.makeSessionCookie({ type: 'employee', employeeId: emp.id }, secret, secureCookies));
      return sendJson(res, 200, { session: { type: 'employee', employeeId: emp.id, name: emp.name } });
    }
    return sendJson(res, 400, { error: 'bad_mode' });
  });

  route('POST', '/api/logout', async (req, res) => {
    res.setHeader('Set-Cookie', auth.clearSessionCookie(secureCookies));
    return sendJson(res, 200, { ok: true });
  });

  route('GET', '/api/bootstrap', async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    // Usually an instant no-op (see above). When it does generate, wait a few seconds so this
    // visitor already sees the new week — but never hold the page hostage to a slow email/push.
    const gen = maybeAutoGenerate();
    if (gen) await Promise.race([gen, new Promise(r => setTimeout(r, 4000))]);
    const settings = await store.getSettings();
    const employees = await store.listEmployees();
    const shiftTemplates = await store.listShiftTemplates();
    const publicSettings = session.type === 'manager' ? settings : {
      companyName: settings.companyName, weeklyGenerationDow: settings.weeklyGenerationDow,
      nightStart: settings.nightStart, nightEnd: settings.nightEnd,
      shabbatStartDay: settings.shabbatStartDay, shabbatStartTime: settings.shabbatStartTime,
      shabbatEndDay: settings.shabbatEndDay, shabbatEndTime: settings.shabbatEndTime,
    };
    let me = null;
    if (session.type === 'employee') { me = await store.getEmployee(session.employeeId); }
    // Manager: weeks (from this one on) whose schedule is built but still waiting for approval.
    const draftWeeks = session.type === 'manager' ? await store.listDraftWeeks(S.weekKeyOf(S.todayStr())) : undefined;
    return sendJson(res, 200, { session, me, settings: publicSettings, employees, shiftTemplates, pushPublicKey: push.getPublicKey(), draftWeeks });
  });

  // ---- push notifications (see lib/push.js + public/sw.js) ----
  route('POST', '/api/push/subscribe', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const sub = body && body.subscription;
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return sendJson(res, 400, { error: 'invalid_subscription' });
    await store.savePushSubscription({
      endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth,
      subjectType: session.type, subjectId: session.type === 'employee' ? session.employeeId : null,
    });
    return sendJson(res, 200, { ok: true });
  });
  route('POST', '/api/push/unsubscribe', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    if (!body || !body.endpoint) return sendJson(res, 400, { error: 'missing_endpoint' });
    await store.deletePushSubscription(body.endpoint);
    return sendJson(res, 200, { ok: true });
  });

  // ---- employees (manager only) ----
  route('GET', '/api/employees', async (req, res) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    return sendJson(res, 200, { employees: await store.listEmployees({ includePin: true }) });
  });
  route('POST', '/api/employees', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    if (!body.name || !body.roleId || !body.pin) return sendJson(res, 400, { error: 'missing_fields' });
    if (!VALID_ROLES.includes(body.roleId)) return sendJson(res, 400, { error: 'invalid_role' });
    if (body.gender && !VALID_GENDERS.includes(body.gender)) return sendJson(res, 400, { error: 'invalid_gender' });
    if (!isValidShiftTarget(body.maxShiftsPerWeek)) return sendJson(res, 400, { error: 'invalid_shifts_per_week' });
    const emp = await store.createEmployee({ name: body.name, roleId: body.roleId, pin: String(body.pin), maxShiftsPerWeek: normShiftTarget(body.maxShiftsPerWeek), gender: body.gender || null, isSenior: !!body.isSenior, nightOnly: !!body.nightOnly });
    return sendJson(res, 200, { employee: emp });
  });
  route('PATCH', '/api/employees/:id', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    // Only block switching TO an invalid role; editing other fields on a legacy
    // (e.g. pre-existing office) employee should not be blocked by this.
    if (body.roleId && body.roleId !== 'office' && !VALID_ROLES.includes(body.roleId)) return sendJson(res, 400, { error: 'invalid_role' });
    if (body.gender && !VALID_GENDERS.includes(body.gender)) return sendJson(res, 400, { error: 'invalid_gender' });
    if (body.maxShiftsPerWeek !== undefined && !isValidShiftTarget(body.maxShiftsPerWeek)) return sendJson(res, 400, { error: 'invalid_shifts_per_week' });
    const patch = Object.assign({}, body);
    if (patch.maxShiftsPerWeek !== undefined) patch.maxShiftsPerWeek = normShiftTarget(patch.maxShiftsPerWeek);
    if (patch.nightOnly !== undefined) patch.nightOnly = !!patch.nightOnly;
    const emp = await store.updateEmployee(params.id, patch);
    if (!emp) return sendJson(res, 404, { error: 'not_found' });
    // A deactivated employee's phones stop getting this company's notifications.
    if (body.active === false) await store.deletePushSubscriptionsForEmployee(emp.id);
    return sendJson(res, 200, { employee: emp });
  });

  // ---- shift templates (manager only) ----
  route('GET', '/api/templates', async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    return sendJson(res, 200, { shiftTemplates: await store.listShiftTemplates() });
  });
  route('POST', '/api/templates', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    if (!body.label || typeof body.label !== 'string' || !body.label.trim()) return sendJson(res, 400, { error: 'missing_label' });
    if (!VALID_ROLES.includes(body.roleId)) return sendJson(res, 400, { error: 'invalid_role' });
    if (!isValidTimeStr(body.start) || !isValidTimeStr(body.end)) return sendJson(res, 400, { error: 'invalid_time' });
    if (!Number.isFinite(Number(body.needed)) || Number(body.needed) < 1) return sendJson(res, 400, { error: 'invalid_needed' });
    if (!isValidDaysArray(body.days)) return sendJson(res, 400, { error: 'invalid_days' });
    const id = await store.createShiftTemplate({
      roleId: body.roleId, label: body.label.trim(), start: body.start, end: body.end,
      needed: Math.floor(Number(body.needed)), days: body.days,
      autoAssign: body.autoAssign, requiredGender: body.requiredGender, allowExtra: body.allowExtra,
    });
    return sendJson(res, 200, { id });
  });
  route('PATCH', '/api/templates/:id', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    // Only block switching TO an invalid role; editing other fields on a legacy
    // (e.g. pre-existing office) template should not be blocked by this.
    if (body.roleId != null && body.roleId !== 'office' && !VALID_ROLES.includes(body.roleId)) return sendJson(res, 400, { error: 'invalid_role' });
    if (body.label != null && (typeof body.label !== 'string' || !body.label.trim())) return sendJson(res, 400, { error: 'missing_label' });
    if (body.start != null && !isValidTimeStr(body.start)) return sendJson(res, 400, { error: 'invalid_time' });
    if (body.end != null && !isValidTimeStr(body.end)) return sendJson(res, 400, { error: 'invalid_time' });
    if (body.needed != null && (!Number.isFinite(Number(body.needed)) || Number(body.needed) < 1)) return sendJson(res, 400, { error: 'invalid_needed' });
    if (body.days != null && !isValidDaysArray(body.days)) return sendJson(res, 400, { error: 'invalid_days' });
    const patch = Object.assign({}, body);
    if (patch.label != null) patch.label = patch.label.trim();
    if (patch.needed != null) patch.needed = Math.floor(Number(patch.needed));
    const ok = await store.updateShiftTemplate(params.id, patch);
    if (!ok) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, { ok: true });
  });

  // ---- settings (manager only) ----
  route('PATCH', '/api/settings', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    const next = await store.updateSettings(body);
    return sendJson(res, 200, { settings: next });
  });

  // ---- schedule ----
  route('GET', '/api/schedule/:weekStart', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const week = await store.getScheduleWeek(params.weekStart);
    const empty = { weekStart: params.weekStart, assignments: [], understaffed: [], seniorIssues: [], generatedAt: null, published: false, publishedAt: null };
    // Employees only ever see a week once the manager has approved (published) it.
    if (session.type !== 'manager' && (!week || !week.published)) return sendJson(res, 200, { week: empty });
    return sendJson(res, 200, { week: week || empty });
  });
  route('POST', '/api/schedule/:weekStart/generate', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    const result = await actions.generateWeek(store, params.weekStart, { force: !!(body && body.force), keepManual: !!(body && body.keepManual) });
    return sendJson(res, 200, result);
  });
  // The manager approves the week's schedule — only now do employees see it (and get told).
  route('POST', '/api/schedule/:weekStart/publish', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    try {
      const result = await actions.publishWeek(store, params.weekStart);
      return sendJson(res, 200, Object.assign(result, { week: await store.getScheduleWeek(params.weekStart) }));
    } catch (e) {
      if (e.message === 'empty_week') return sendJson(res, 400, { error: e.message });
      throw e;
    }
  });
  route('GET', '/api/schedule/:weekStart/export.xlsx', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    const [week, templates, employees, settings] = await Promise.all([
      store.getScheduleWeek(params.weekStart), store.listShiftTemplates(), store.listEmployees(), store.getSettings(),
    ]);
    if (!week) return sendJson(res, 404, { error: 'not_generated' });
    const sheets = scheduleExport.buildScheduleSheets(params.weekStart, templates, employees, week.assignments, settings.companyName);
    const buffer = xlsxWriter.buildWorkbook(sheets);
    const asciiName = 'schedule-' + params.weekStart + '.xlsx';
    const utf8Name = encodeURIComponent('לוז שבועי ' + params.weekStart + '.xlsx');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + utf8Name,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  });
  // Manual add/remove by the manager — see actions.manualAssign/manualRemove, which also
  // notify the affected employee.
  route('POST', '/api/schedule/:weekStart/assign', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    try {
      const result = await actions.manualAssign(store, { weekStart: params.weekStart, date: body.date, shiftTemplateId: body.shiftTemplateId, employeeId: body.employeeId, override: !!body.override });
      return sendJson(res, 200, result);
    } catch (e) {
      if (e.message === 'needs_confirmation') return sendJson(res, 409, { error: e.message, warnings: e.warnings });
      if (e.message === 'already_assigned') return sendJson(res, 409, { error: e.message });
      if (['invalid_date', 'invalid_template', 'invalid_employee'].includes(e.message)) return sendJson(res, 400, { error: e.message });
      throw e;
    }
  });
  route('DELETE', '/api/assignment/:id', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    try {
      const result = await actions.manualRemove(store, params.id);
      return sendJson(res, 200, Object.assign({ ok: true }, result));
    } catch (e) {
      if (e.message === 'not_found') return sendJson(res, 404, { error: e.message });
      throw e;
    }
  });

  // ---- swap / no-show flow ----
  route('POST', '/api/assignment/:id/swap-request', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'employee') return sendJson(res, 403, { error: 'forbidden' });
    try {
      const swapId = await actions.openSwapRequest(store, { assignmentId: params.id, requesterId: session.employeeId, kind: body.kind === 'noshow' ? 'noshow' : 'swap' });
      return sendJson(res, 200, { id: swapId });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  });
  route('GET', '/api/swaps', async (req, res, params, body, query) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const status = query.get('status') || undefined;
    let swaps = await store.listSwapRequests({ status });
    if (session.type === 'employee') {
      const me = await store.getEmployee(session.employeeId);
      swaps = swaps.filter(s => s.roleId === me.roleId || s.requesterId === session.employeeId);
    }
    // Still-open requests get a "potential replacement" candidate list: active employees of the
    // same role, other than the requester, whose submitted availability actually covers this
    // shift's date/time-of-day. Skipped for resolved requests — nobody needs to see it once a
    // request is claimed or cancelled.
    const openOnes = swaps.filter(s => s.status === 'open');
    if (openOnes.length) {
      const [employees, templates] = await Promise.all([store.listEmployees(), store.listShiftTemplates()]);
      const templatesById = {}; templates.forEach(t => { templatesById[t.id] = t; });
      for (const s of openOnes) {
        const template = s.shiftTemplateId ? templatesById[s.shiftTemplateId] : null;
        if (!template || !s.date) { s.candidates = []; continue; }
        const bucket = S.timeBucketOf(template);
        const avail = await store.listAvailability({ fromDate: s.date, toDate: s.date });
        const choiceByEmp = {}; avail.forEach(a => { choiceByEmp[a.employeeId] = a.choice; });
        s.candidates = employees
          .filter(e => e.active && e.roleId === s.roleId && e.id !== s.requesterId && !(e.nightOnly && !S.isNightTemplate(template)))
          .filter(e => S.isAvailableForShift(choiceByEmp[e.id] === undefined ? 'all' : choiceByEmp[e.id], bucket))
          .map(e => ({ id: e.id, name: e.name }));
      }
    }
    swaps.forEach(s => { if (s.candidates === undefined) s.candidates = []; });
    return sendJson(res, 200, { swaps });
  });
  route('POST', '/api/swaps/:id/claim', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'employee') return sendJson(res, 403, { error: 'forbidden' });
    try {
      await actions.claimSwapRequest(store, { swapId: params.id, claimerId: session.employeeId });
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  });
  route('DELETE', '/api/swaps/:id', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'employee') return sendJson(res, 403, { error: 'forbidden' });
    try {
      await actions.cancelSwapRequest(store, { swapId: params.id, requesterId: session.employeeId });
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  });

  // ---- constraints ----
  route('GET', '/api/constraints', async (req, res, params, body, query) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    if (session.type === 'manager') {
      const employeeId = query.get('employeeId') || undefined;
      return sendJson(res, 200, { constraints: await store.listConstraints(employeeId) });
    }
    return sendJson(res, 200, { constraints: await store.listConstraints(session.employeeId) });
  });
  route('POST', '/api/constraints', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const employeeId = session.type === 'manager' ? (body.employeeId || null) : session.employeeId;
    if (!employeeId) return sendJson(res, 400, { error: 'missing_employee' });
    if (session.type === 'employee' && body.kind === 'date') {
      const settings = await store.getSettings();
      if (S.constraintDeadlinePassed(body.date, settings.weeklyGenerationDow)) {
        return sendJson(res, 409, { error: 'deadline_passed' });
      }
    }
    const id = await store.addConstraint({ employeeId, kind: body.kind, date: body.date, dayOfWeek: body.dayOfWeek, allDay: body.allDay, start: body.start, end: body.end });
    return sendJson(res, 200, { id });
  });
  route('DELETE', '/api/constraints/:id', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const employeeId = session.type === 'employee' ? session.employeeId : null;
    await store.deleteConstraint(params.id, employeeId);
    return sendJson(res, 200, { ok: true });
  });

  // ---- availability (the 5-choice-per-day model that replaced free-form constraints) ----
  const AVAILABILITY_CHOICES = ['all', 'morning', 'noon', 'night', 'none'];
  route('GET', '/api/availability', async (req, res, params, body, query) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const weekStart = query.get('weekStart');
    const fromDate = weekStart || undefined;
    const toDate = weekStart ? S.addDays(weekStart, 6) : undefined;
    const employeeId = session.type === 'manager' ? (query.get('employeeId') || undefined) : session.employeeId;
    return sendJson(res, 200, { availability: await store.listAvailability({ employeeId, fromDate, toDate }) });
  });
  route('POST', '/api/availability', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const employeeId = session.type === 'manager' ? (body.employeeId || null) : session.employeeId;
    if (!employeeId) return sendJson(res, 400, { error: 'missing_employee' });
    const weekStart = body.weekStart;
    const days = Array.isArray(body.days) ? body.days : [];
    if (!weekStart || days.length !== 7) return sendJson(res, 400, { error: 'invalid_payload' });
    const expectedDates = [0, 1, 2, 3, 4, 5, 6].map(d => S.addDays(weekStart, d));
    const byDate = {};
    days.forEach(d => { byDate[d.date] = d.choice; });
    for (const ds of expectedDates) {
      if (!AVAILABILITY_CHOICES.includes(byDate[ds])) return sendJson(res, 400, { error: 'invalid_choice' });
    }
    if (session.type === 'employee') {
      const settings = await store.getSettings();
      if (S.constraintDeadlinePassed(weekStart, settings.weeklyGenerationDow)) {
        return sendJson(res, 409, { error: 'deadline_passed' });
      }
    }
    await store.setWeekAvailability(employeeId, expectedDates.map(ds => ({ date: ds, choice: byDate[ds] })));
    return sendJson(res, 200, { ok: true });
  });

  // ---- hours report ----
  route('GET', '/api/hours/:monthKey', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    let [assignments, shiftTemplates, settings] = await Promise.all([
      store.listAssignmentsInRange(params.monthKey + '-01', params.monthKey + '-31'),
      store.listShiftTemplates(), store.getSettings(),
    ]);
    if (session.type === 'employee') { // drafts the manager hasn't approved yet don't count for employees
      const published = new Set(await store.listPublishedWeeks());
      assignments = assignments.filter(a => published.has(a.weekStart));
    }
    const templatesById = {}; shiftTemplates.forEach(t => templatesById[t.id] = t);
    let result = S.computeMonthlyHours(params.monthKey, assignments, templatesById, settings);
    if (session.type === 'employee') {
      result = result[session.employeeId] ? { [session.employeeId]: result[session.employeeId] } : {};
    }
    return sendJson(res, 200, { hours: result });
  });

  // ---- hours report: "true" hours from the fingerprint attendance-system .xlsx export ----
  route('POST', '/api/hours/truth', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    if (!body.fileBase64) return sendJson(res, 400, { error: 'missing_file' });
    let buf;
    try { buf = Buffer.from(body.fileBase64, 'base64'); } catch (e) { return sendJson(res, 400, { error: 'invalid_file' }); }
    let parsed;
    try { parsed = xlsxTruth.parseTruthWorkbook(buf); }
    catch (e) { return sendJson(res, 400, { error: 'parse_failed', message: e.message }); }

    const employees = await store.listEmployees();
    const byName = {};
    employees.forEach((e) => { byName[xlsxTruth.normalizeName(e.name)] = e; });

    const matched = [], unmatched = [];
    parsed.employees.forEach((row) => {
      const emp = byName[xlsxTruth.normalizeName(row.fullName)];
      const entry = {
        fileName: row.fullName, workDays: row.workDays, totalHours: row.totalHours,
        regular: row.regular, overtimeA: row.overtimeA, overtimeB: row.overtimeB, exceptional: row.exceptional,
      };
      if (emp) matched.push(Object.assign({ employeeId: emp.id, name: emp.name, roleId: emp.roleId }, entry));
      else unmatched.push(entry);
    });
    return sendJson(res, 200, { sheetUsed: parsed.sheetUsed, matched, unmatched });
  });

  // ---- notifications ----
  route('GET', '/api/notifications', async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const notifs = session.type === 'manager'
      ? await store.listNotifications({ audience: 'manager' })
      : await store.listNotifications({ audience: 'employee', employeeId: session.employeeId });
    return sendJson(res, 200, { notifications: notifs });
  });
  route('POST', '/api/notifications/:id/read', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    await store.markNotificationRead(params.id, session.type === 'manager' ? { audience: 'manager' } : { audience: 'employee', employeeId: session.employeeId });
    return sendJson(res, 200, { ok: true });
  });
  route('POST', '/api/notifications/read-all', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const upTo = Number(body && body.upTo) || undefined;
    if (session.type === 'manager') await store.markAllNotificationsRead({ audience: 'manager', upTo });
    else await store.markAllNotificationsRead({ audience: 'employee', employeeId: session.employeeId, upTo });
    return sendJson(res, 200, { ok: true });
  });

  // ---- cron endpoints (called by Render's scheduled job, not by browsers) ----
  route('POST', '/api/cron/generate-week', async (req, res, params, body, query) => {
    if (!cronSecret || req.headers['x-cron-secret'] !== cronSecret) return sendJson(res, 403, { error: 'forbidden' });
    const weekStart = S.nextGenerationWeek();
    const result = await actions.generateWeek(store, weekStart);
    return sendJson(res, 200, result);
  });

  return async function handle(req, res) {
    try {
      const u = new URL(req.url, 'http://x');
      const pathname = u.pathname;
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
      const m = matchRoute(req.method, pathname);
      if (!m) return sendJson(res, 404, { error: 'no_such_route' });
      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      }
      await m.handler(req, res, m.params, body, u.searchParams);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    }
  };
}

function createServer(store, opts) {
  const app = makeApp(store, opts);
  return http.createServer(app);
}

module.exports = { createServer, makeApp };
