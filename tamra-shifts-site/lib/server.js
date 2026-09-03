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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const VALID_ROLES = ['fuel', 'store']; // office removed — no shifts are scheduled for it anymore
const VALID_GENDERS = ['male', 'female'];

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

  async function requireSession(req) {
    const session = auth.sessionFromRequest(req, secret);
    return session;
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
    if (body.mode === 'manager') {
      const settings = await store.getSettings();
      if (String(body.pin) !== String(settings.managerPin)) return sendJson(res, 401, { error: 'bad_pin' });
      res.setHeader('Set-Cookie', auth.makeSessionCookie({ type: 'manager' }, secret, secureCookies));
      return sendJson(res, 200, { session: { type: 'manager' } });
    }
    if (body.mode === 'employee') {
      const emp = await store.getEmployeeByPin(body.employeeId, String(body.pin || ''));
      if (!emp) return sendJson(res, 401, { error: 'bad_pin' });
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
    return sendJson(res, 200, { session, me, settings: publicSettings, employees, shiftTemplates });
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
    const emp = await store.createEmployee({ name: body.name, roleId: body.roleId, pin: String(body.pin), maxShiftsPerWeek: body.maxShiftsPerWeek || null, gender: body.gender || null });
    return sendJson(res, 200, { employee: emp });
  });
  route('PATCH', '/api/employees/:id', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    // Only block switching TO an invalid role; editing other fields on a legacy
    // (e.g. pre-existing office) employee should not be blocked by this.
    if (body.roleId && body.roleId !== 'office' && !VALID_ROLES.includes(body.roleId)) return sendJson(res, 400, { error: 'invalid_role' });
    if (body.gender && !VALID_GENDERS.includes(body.gender)) return sendJson(res, 400, { error: 'invalid_gender' });
    const emp = await store.updateEmployee(params.id, body);
    if (!emp) return sendJson(res, 404, { error: 'not_found' });
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
    const id = await store.createShiftTemplate(body);
    return sendJson(res, 200, { id });
  });
  route('PATCH', '/api/templates/:id', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    await store.updateShiftTemplate(params.id, body);
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
    return sendJson(res, 200, { week: week || { weekStart: params.weekStart, assignments: [], understaffed: [], generatedAt: null } });
  });
  route('POST', '/api/schedule/:weekStart/generate', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    const result = await actions.generateWeek(store, params.weekStart, { force: !!(body && body.force) });
    return sendJson(res, 200, result);
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
  route('POST', '/api/schedule/:weekStart/assign', async (req, res, params, body) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    const [templates, constraints, employee] = await Promise.all([
      store.listShiftTemplates(), store.listConstraints(body.employeeId), store.getEmployee(body.employeeId),
    ]);
    const template = templates.find(t => t.id === body.shiftTemplateId);
    const constraintConflict = !!template && S.isBlocked(body.employeeId, body.date, template.start, template.end, constraints);
    const id = await store.addAssignment(params.weekStart, body.date, body.shiftTemplateId, body.employeeId);
    if (constraintConflict) {
      const desc = (template.label + ' ' + body.date + ' (' + template.start + '-' + template.end + ')');
      await store.addNotification({
        audience: 'manager', type: 'constraint-conflict', relatedId: id,
        text: 'שובץ/ה ' + (employee ? employee.name : 'עובד/ת') + ' למשמרת ' + desc + ' בניגוד לאילוץ שהגיש/ה.',
        severity: 'warning', channels: ['inapp'],
      });
    }
    return sendJson(res, 200, { id, constraintConflict });
  });
  route('DELETE', '/api/assignment/:id', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session || session.type !== 'manager') return sendJson(res, 403, { error: 'forbidden' });
    await store.removeAssignment(params.id);
    return sendJson(res, 200, { ok: true });
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

  // ---- hours report ----
  route('GET', '/api/hours/:monthKey', async (req, res, params) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    const [assignments, shiftTemplates, settings] = await Promise.all([
      store.listAssignmentsInRange(params.monthKey + '-01', params.monthKey + '-31'),
      store.listShiftTemplates(), store.getSettings(),
    ]);
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
    await store.markNotificationRead(params.id);
    return sendJson(res, 200, { ok: true });
  });
  route('POST', '/api/notifications/read-all', async (req, res) => {
    const session = await requireSession(req);
    if (!session) return sendJson(res, 401, { error: 'not_authenticated' });
    if (session.type === 'manager') await store.markAllNotificationsRead({ audience: 'manager' });
    else await store.markAllNotificationsRead({ audience: 'employee', employeeId: session.employeeId });
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
