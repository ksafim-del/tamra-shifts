'use strict';
// Business actions that combine store + schedule + notifications. Shared between
// the interactive API routes and the cron endpoints, so "manual generate" and
// "automatic Thursday generate" are guaranteed to behave identically.
const S = require('./schedule.js');
const mailer = require('./mailer.js');
const push = require('./push.js');

// ---------- small formatting helpers for notification text ----------
const DOW_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
function fmtDateShort(ds) { const p = ds.split('-'); return p[2] + '.' + p[1]; }
function fmtDay(ds) { return 'יום ' + DOW_NAMES[S.dowOf(ds)] + ' ' + fmtDateShort(ds); }
function weekRangeLabel(weekStart) { return fmtDateShort(weekStart) + ' עד ' + fmtDateShort(S.addDays(weekStart, 6)); }
function shiftDesc(template, date) {
  if (!template) return fmtDay(date);
  // "05:00 עד 13:00" rather than "05:00–13:00": inside right-to-left Hebrew text a bare
  // number–number range gets flipped by the bidi algorithm and shows as "13:00–05:00".
  return template.label + ', ' + fmtDay(date) + ' (' + template.start + ' עד ' + template.end + ')';
}
function pushTitle(settings) {
  return settings && settings.companyName ? ('משמרות – ' + settings.companyName) : 'משמרות';
}
// A push-service hiccup must never fail the action that triggered it (the schedule/assignment
// change has already been saved by then) — log and move on.
function safePush(promise, what) {
  return promise.catch((err) => console.error('[push] ' + what + ' failed:', err && err.message));
}

// In-app notification (the "התראות" tab) + a phone push, for specific employees only.
async function notifyEmployees(store, settings, employeeIds, n) {
  if (!employeeIds.length) return;
  for (const employeeId of employeeIds) {
    await store.addNotification({
      audience: 'employee', employeeId, type: n.type, relatedId: n.relatedId,
      text: n.text, severity: n.severity || 'info', channels: ['inapp', 'push'],
    });
  }
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings), body: n.pushBody || n.text, tag: n.tag, url: n.url || '/?tab=mynotifs',
  }, push.toEmployees(employeeIds)), n.type + ' push');
}

// Retracts the "X is asking for a swap — you can take it" offers that went out to the
// requester's peers, once the offer no longer stands (claimed, cancelled, or the shift is gone).
async function retractSwapOffers(store, swapIds) {
  for (const id of swapIds) {
    await store.deleteNotifications({ audience: 'employee', type: 'swap-open', relatedId: id });
  }
}

// The manager's per-employee rules (see lib/schedule.js generateSchedule) as they apply to one
// more shift for `employee`: returns the list of rules it would break —
//   'night_only'  — the employee is marked "night only" and this isn't a night shift;
//   'after_night' — a day shift the day after one of their night shifts, or a night shift the
//                   evening before one of their day shifts;
//   'quota_full'  — they already have the number of shifts per week set for them (checkQuota).
// Auto-generation never breaks these; a manual assignment can, after the manager confirms.
async function ruleWarnings(store, employee, template, date, { checkQuota, ignoreAssignmentId } = {}) {
  const warnings = [];
  const night = S.isNightTemplate(template);
  if (employee.nightOnly && !night) warnings.push('night_only');
  const templatesById = {};
  (await store.listShiftTemplates()).forEach(t => { templatesById[t.id] = t; });
  const nearby = (await store.listAssignmentsInRange(S.addDays(date, -1), S.addDays(date, 1)))
    .filter(a => a.employeeId === employee.id && a.id !== ignoreAssignmentId);
  const prevDay = S.addDays(date, -1), nextDay = S.addDays(date, 1);
  const breaksNightRule = nearby.some(a => {
    const t = templatesById[a.shiftTemplateId];
    if (!t) return false;
    if (!night && a.date === prevDay && S.isNightTemplate(t)) return true;
    if (night && a.date === nextDay && !S.isNightTemplate(t)) return true;
    return false;
  });
  if (breaksNightRule) warnings.push('after_night');
  const target = S.shiftTarget(employee);
  if (checkQuota && target != null) {
    const weekStart = S.weekKeyOf(date);
    const inWeek = (await store.listAssignmentsInRange(weekStart, S.addDays(weekStart, 6))).filter(a => a.employeeId === employee.id && a.id !== ignoreAssignmentId);
    if (inWeek.length >= target) warnings.push('quota_full');
  }
  return warnings;
}

// ---------- "the schedule changed" notes to the whole team ----------
// When the manager edits a week by hand, everyone in the affected team — fuel attendants for a
// fuel shift, store employees for a store shift, never the other team — is told. Edits usually
// come in bursts (add, remove, add...), so they're collected per week+team and sent as ONE note
// once the manager has stopped editing for a minute, instead of a separate ping for every click.
// (The employee who was added/removed also gets their own personal note right away.)
let teamChangeDelayMs = Number(process.env.SCHEDULE_CHANGE_NOTIFY_DELAY_MS || 60000);
const pendingTeamChanges = new Map();
function setTeamChangeDelay(ms) { teamChangeDelayMs = ms; }
const ROLE_TEAM = { fuel: 'המתדלקים', store: 'עובדי החנות' };
const storeIds = new WeakMap(); // one queue per store (company), keyed by the store object itself
let nextStoreId = 1;
function queueTeamChange(store, weekStart, roleId, line) {
  if (!storeIds.has(store)) storeIds.set(store, nextStoreId++);
  const key = storeIds.get(store) + '|' + weekStart + '|' + roleId;
  let p = pendingTeamChanges.get(key);
  if (!p) { p = { store, weekStart, roleId, lines: [] }; pendingTeamChanges.set(key, p); }
  p.lines.push(line);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => { sendTeamChange(key).catch(err => console.error('[team-change] failed:', err && err.message)); }, teamChangeDelayMs);
  if (p.timer.unref) p.timer.unref();
}
async function sendTeamChange(key) {
  const p = pendingTeamChanges.get(key);
  if (!p) return;
  pendingTeamChanges.delete(key);
  clearTimeout(p.timer);
  const { store, weekStart, roleId, lines } = p;
  const [employees, settings] = await Promise.all([store.listEmployees(), store.getSettings()]);
  const team = employees.filter(e => e.active && e.roleId === roleId).map(e => e.id);
  if (!team.length) return;
  const teamName = ROLE_TEAM[roleId] || 'הצוות';
  const shown = lines.slice(0, 8).map(l => '• ' + l);
  if (lines.length > shown.length) shown.push('• ועוד ' + (lines.length - shown.length) + ' שינויים');
  for (const employeeId of team) {
    await store.addNotification({
      audience: 'employee', employeeId, type: 'schedule-changed', relatedId: weekStart,
      text: 'עדכון בסידור ' + teamName + ' לשבוע ' + weekRangeLabel(weekStart) + ':\n' + shown.join('\n'),
      severity: 'info', channels: ['inapp', 'push'],
    });
  }
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings),
    body: 'עודכן סידור ' + teamName + ' לשבוע ' + weekRangeLabel(weekStart) + (lines.length > 1 ? (' (' + lines.length + ' שינויים)') : (': ' + lines[0])),
    tag: 'schedule-change-' + roleId + '-' + weekStart,
    url: '/?tab=myschedule',
  }, push.toEmployees(team)), 'schedule-changed');
}
function dropTeamChanges(store, weekStart) {
  const id = storeIds.get(store);
  if (!id) return;
  for (const [key, p] of Array.from(pendingTeamChanges.entries())) {
    if (key.indexOf(id + '|' + weekStart + '|') === 0) { clearTimeout(p.timer); pendingTeamChanges.delete(key); }
  }
}
// Sends every queued team note now (tests, and a clean way to not wait for the timer).
async function flushTeamChanges() {
  for (const key of Array.from(pendingTeamChanges.keys())) await sendTeamChange(key);
}

// Builds a week's schedule as a DRAFT: only the manager sees it (and is told it's waiting for
// approval); employees see and hear nothing until the manager approves it with publishWeek.
//   - a week nobody touched yet: generated from scratch;
//   - a week the manager started filling in by hand (not generated yet): those shifts are kept
//     exactly as they are and the generator fills in the rest around them;
//   - an already generated week: only with force — keepManual keeps the manager's hand-made
//     changes and regenerates the rest, otherwise everything is regenerated. A week that was
//     already published goes back to being a draft until approved again.
async function generateWeek(store, weekStart, { force, keepManual } = {}) {
  const existing = await store.getScheduleWeek(weekStart);
  if (existing && existing.generatedAt && !force) {
    return { skipped: true, reason: 'already_generated', week: existing };
  }
  const keep = !existing ? 'none'
    : !existing.generatedAt ? 'all'           // built by hand so far — keep all of it
    : keepManual ? 'manual' : 'none';
  const fixedAssignments = !existing ? [] : existing.assignments.filter(a => keep === 'all' || (keep === 'manual' && a.manual));
  const [employees, shiftTemplates, availability, meta] = await Promise.all([
    store.listEmployees(), store.listShiftTemplates(),
    store.listAvailability({ fromDate: weekStart, toDate: S.addDays(weekStart, 6) }),
    store.getSettings(),
  ]);
  // The weeks on either side, so rest and night rules hold across the week boundary too (the
  // week after matters when an already-built week is regenerated).
  const [priorWeek, nextWeek] = await Promise.all([store.getScheduleWeek(S.addWeeks(weekStart, -1)), store.getScheduleWeek(S.addWeeks(weekStart, 1))]);
  const templatesById = {};
  shiftTemplates.forEach(t => { templatesById[t.id] = t; });
  const withStart = (week) => (week ? week.assignments : [])
    .filter(a => templatesById[a.shiftTemplateId])
    .map(a => Object.assign({}, a, { _startTs: S.shiftStartTs(a, templatesById) }));

  const result = S.generateSchedule(weekStart, { employees, shiftTemplates, availability, meta, priorAssignments: withStart(priorWeek), followingAssignments: withStart(nextWeek), fixedAssignments });
  dropTeamChanges(store, weekStart); // the week is being redone — its pending edit notes are moot
  await store.saveGeneratedSchedule(weekStart, result.assignments, result.understaffed, result.generatedAt, { keep });
  const wasPublished = existing ? existing.published : false;
  if (wasPublished) await store.unpublishWeek(weekStart); // changed again — back to draft until re-approved

  // Regenerating replaces the week's (generated) assignment rows, so a swap request still open
  // for one of them now points at a shift that no longer exists — drop those (and their offers).
  const droppedSwaps = await store.deleteOpenSwapsInRange(weekStart, S.addDays(weekStart, 6));
  await retractSwapOffers(store, droppedSwaps);

  // A regeneration of the same week (manual "הפק מחדש", or the automatic Thursday run) replaces
  // this week's status notification instead of piling another one on top of the last.
  await store.replaceScheduleStatusNotification(weekStart);

  if (result.seniorIssues.length) {
    await store.addNotification({
      audience: 'manager', type: 'no-senior-fuel', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekStart + ' — ' + result.seniorIssues.length + ' משמרות מתדלקים מאוישות ללא אף מתדלק/ת ותיק/ה. לפירוט: לשונית "לוז שבועי".',
      severity: 'warning', channels: ['inapp'],
    });
  }

  const awaiting = ' הלוז ממתין לאישור שלך בלשונית "לוז שבועי" — העובדים יראו אותו רק אחרי האישור.';
  if (result.understaffed.length) {
    // A short, organized summary rather than one line per missing slot — the full breakdown
    // is always visible in the "לוז שבועי" tab itself, so the notification just needs to say
    // how many and where to look, grouped by role for a bit of useful shape.
    const roleLabels = { fuel: 'מתדלקים', store: 'עובדי חנות' };
    const missingByRole = {};
    let totalMissing = 0;
    result.understaffed.forEach(u => {
      const t = templatesById[u.shiftTemplateId];
      const roleId = t ? t.roleId : 'אחר';
      missingByRole[roleId] = (missingByRole[roleId] || 0) + u.missing;
      totalMissing += u.missing;
    });
    const breakdown = Object.keys(missingByRole)
      .map(r => missingByRole[r] + ' ' + (roleLabels[r] || r))
      .join(', ');
    await store.addNotification({
      audience: 'manager', type: 'understaffed', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekStart + ' הופק — ' + totalMissing + ' משמרות ללא איוש (' + breakdown + ').' + awaiting,
      severity: 'warning', channels: ['inapp', 'email'],
    });
  } else {
    await store.addNotification({
      audience: 'manager', type: 'generated', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekStart + ' הופק, כל המשמרות מאוישות.' + awaiting,
      severity: 'info', channels: ['inapp'],
    });
  }

  // Who couldn't be given the number of shifts the manager set for them (their availability, rest
  // rules or "night only" didn't leave enough room) — so the manager can see it and decide.
  await store.deleteNotifications({ audience: 'manager', type: 'quota-shortfall', relatedId: weekStart });
  if (result.quotaIssues && result.quotaIssues.length) {
    const nameOf = {}; employees.forEach(e => { nameOf[e.id] = e.name; });
    await store.addNotification({
      audience: 'manager', type: 'quota-shortfall', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekStart + ' — לא כל העובדים קיבלו את מספר המשמרות שהוגדר להם (בגלל הזמינות שהגישו, כללי המנוחה או "לילה בלבד"): '
        + result.quotaIssues.map(q => (nameOf[q.employeeId] || '?') + ' ' + q.assigned + '/' + q.target).join(', ') + '. אפשר להשלים בשיבוץ ידני.',
      severity: 'warning', channels: ['inapp'],
    });
  }

  const settings = meta;
  if (settings.managerEmail) {
    const companyPrefix = settings.companyName ? ('[' + settings.companyName + '] ') : '';
    const subject = companyPrefix + (result.understaffed.length
      ? 'לוז שבועי הופק עם משמרות חסרות — ממתין לאישור — ' + weekStart
      : 'לוז שבועי הופק — ממתין לאישור — ' + weekStart);
    const body = (result.understaffed.length
      ? 'הלוז לשבוע ' + weekStart + ' הופק. יש ' + result.understaffed.length + ' משמרות ללא איוש מלא — יש להיכנס לאתר ולשבץ ידנית.'
      : 'הלוז לשבוע ' + weekStart + ' הופק וכל המשמרות מאוישות.') + ' העובדים יראו אותו רק אחרי שתאשר/י אותו באתר (לשונית "לוז שבועי").';
    await mailer.sendMail({ to: settings.managerEmail, subject, text: body });
  }

  // Phone push to the manager only — employees hear about it when it's approved (publishWeek).
  // Never lets a push-service hiccup fail the schedule generation, which is already saved.
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings),
    body: 'הלוז לשבוע ' + weekRangeLabel(weekStart) + ' מוכן וממתין לאישור שלך'
      + (result.understaffed.length ? (' (' + result.understaffed.length + ' משמרות ללא איוש)') : ''),
    tag: 'schedule-' + weekStart,
    url: '/?tab=schedule&week=' + weekStart,
  }, push.toManagers()), 'schedule-generated (manager)');

  return { skipped: false, week: await store.getScheduleWeek(weekStart), wasPublished };
}

// The manager approved the week: from now on employees see it. Each active employee gets a
// personal note (in the app + on the phone) with how many shifts they got that week.
async function publishWeek(store, weekStart) {
  const week = await store.getScheduleWeek(weekStart);
  if (!week || !week.assignments.length) throw new Error('empty_week');
  const [employees, settings] = await Promise.all([store.listEmployees(), store.getSettings()]);
  const wasPublishedBefore = await store.publishWeek(weekStart);
  dropTeamChanges(store, weekStart); // everyone gets the full picture now — edit notes are moot
  const verb = wasPublishedBefore ? ' עודכן' : ' פורסם';
  await store.deleteNotifications({ audience: 'employee', type: 'schedule-published', relatedId: weekStart });
  const countByEmp = {};
  week.assignments.forEach(a => { countByEmp[a.employeeId] = (countByEmp[a.employeeId] || 0) + 1; });
  const team = employees.filter(x => x.active);
  for (const e of team) {
    const n = countByEmp[e.id] || 0;
    await store.addNotification({
      audience: 'employee', employeeId: e.id, type: 'schedule-published', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekRangeLabel(weekStart) + verb + ' — ' + (n ? ('שובצת ל-' + n + ' משמרות. לפרטים: לשונית "הלוז שלי".') : 'לא שובצת למשמרות בשבוע הזה.'),
      severity: 'info', channels: ['inapp', 'push'],
    });
  }
  // One push per person, so each one says how many shifts *they* got.
  for (const e of team) {
    const n = countByEmp[e.id] || 0;
    await safePush(push.broadcastTo(store, {
      title: pushTitle(settings),
      body: 'הלוז לשבוע ' + weekRangeLabel(weekStart) + verb + ' — ' + (n ? ('יש לך ' + n + ' משמרות') : 'לא שובצת השבוע'),
      tag: 'schedule-' + weekStart,
      url: '/?tab=myschedule&week=' + weekStart,
    }, push.toEmployees([e.id]), { quiet: true }), 'schedule-published');
  }
  console.log('[publish] week', weekStart, 'published to', team.length, 'employees');
  return { published: true, wasPublishedBefore, employees: team.length };
}

async function openSwapRequest(store, { assignmentId, requesterId, kind }) {
  const assignment = await store.getAssignment(assignmentId);
  if (!assignment) throw new Error('assignment_not_found');
  if (assignment.employeeId !== requesterId) throw new Error('not_owner');
  if (await store.getOpenSwapForAssignment(assignmentId)) throw new Error('already_open');
  if (!(await store.isWeekPublished(assignment.weekStart))) throw new Error('not_published');
  const requester = await store.getEmployee(requesterId);
  const [employees, templates, settings] = await Promise.all([store.listEmployees(), store.listShiftTemplates(), store.getSettings()]);
  const template = templates.find(t => t.id === assignment.shiftTemplateId);
  // Only colleagues in the SAME role as the requester — a fuel shift can only be taken by
  // another מתדלק/ת, a store shift only by another עובד/ת חנות — so the other team never
  // sees (in-app or on the phone) swap requests that aren't relevant to them.
  // ...and not "night only" colleagues for a day shift, since they couldn't take it anyway.
  const peers = employees.filter(e => e.active && e.roleId === requester.roleId && e.id !== requesterId &&
    !(e.nightOnly && !S.isNightTemplate(template)));

  const swapId = await store.createSwapRequest({ assignmentId, requesterId, roleId: requester.roleId, kind });

  const label = kind === 'noshow' ? 'לא יכול/ה להגיע ל' : 'מבקש/ת החלפה ל';
  const desc = shiftDesc(template, assignment.date);

  for (const peer of peers) {
    await store.addNotification({
      audience: 'employee', employeeId: peer.id, type: 'swap-open', relatedId: swapId,
      text: requester.name + ' ' + label + 'משמרת: ' + desc + '. אפשר לקחת אותה מלשונית "החלפות".',
      severity: 'info', channels: ['inapp', 'push'],
    });
  }

  await store.addNotification({
    audience: 'manager', type: 'swap-open', relatedId: swapId,
    text: requester.name + ' ' + label + 'משמרת: ' + desc + (peers.length ? '' : ' — אין עוד עובד/ת פעיל/ה באותו תפקיד לפנות אליו/ה!'),
    severity: peers.length ? 'info' : 'warning',
    channels: peers.length ? ['inapp'] : ['inapp', 'email'],
  });

  if (!peers.length && settings.managerEmail) {
    const companyPrefix = settings.companyName ? ('[' + settings.companyName + '] ') : '';
    await mailer.sendMail({
      to: settings.managerEmail,
      subject: companyPrefix + 'דרוש שיבוץ ידני — אין מחליף זמין',
      text: requester.name + ' ' + label + 'משמרת ' + desc + ' ואין עובד/ת אחר/ת פעיל/ה באותו תפקיד. נדרש טיפול ידני.',
    });
  }

  // Phone push: same-role peers (who can take it) and the manager — never the other team.
  const body = requester.name + ' ' + label + 'משמרת: ' + desc;
  await safePush(push.broadcastTo(store, { title: pushTitle(settings), body, tag: 'swap-' + swapId, url: '/?tab=myswaps' },
    push.toEmployees(peers.map(p => p.id))), 'swap-request (peers)');
  await safePush(push.broadcastTo(store, { title: pushTitle(settings), body, tag: 'swap-' + swapId, url: '/?tab=requests' },
    push.toManagers()), 'swap-request (manager)');

  return swapId;
}

// True when [aStart, aEnd) and [bStart, bEnd) overlap.
function overlaps(aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; }

async function claimSwapRequest(store, { swapId, claimerId }) {
  const swap = await store.getSwapRequest(swapId);
  if (!swap || swap.status !== 'open') throw new Error('not_open');
  if (swap.requesterId === claimerId) throw new Error('own_request');
  const claimer = await store.getEmployee(claimerId);
  const requester = await store.getEmployee(swap.requesterId);
  if (!claimer || !claimer.active || claimer.roleId !== swap.roleId) throw new Error('wrong_role');
  const assignment = await store.getAssignment(swap.assignmentId);
  if (!assignment) throw new Error('assignment_not_found');
  const [templates, settings] = await Promise.all([store.listShiftTemplates(), store.getSettings()]);
  const templatesById = {};
  templates.forEach(t => { templatesById[t.id] = t; });
  const template = templatesById[assignment.shiftTemplateId];

  // Can't take a shift that overlaps one you're already working (e.g. the same shift, or a
  // night shift running into it) — you'd be booked in two places at once.
  if (template) {
    const start = S.shiftStartTs(assignment, templatesById);
    const end = S.shiftEndTs(assignment, templatesById);
    const nearby = await store.listAssignmentsInRange(S.addDays(assignment.date, -1), S.addDays(assignment.date, 1));
    const clash = nearby.some(a => a.employeeId === claimerId && templatesById[a.shiftTemplateId] &&
      overlaps(start, end, S.shiftStartTs(a, templatesById), S.shiftEndTs(a, templatesById)));
    if (clash) throw new Error('overlap');
    // The manager's night rules apply to swaps too — only the manager can make an exception.
    const warnings = await ruleWarnings(store, claimer, template, assignment.date);
    if (warnings.includes('night_only')) throw new Error('night_only');
    if (warnings.includes('after_night')) throw new Error('after_night');
  }

  if (!(await store.claimOpenSwapRequest(swapId, claimerId))) throw new Error('not_open'); // someone else was faster
  if (swap.kind === 'noshow') {
    await store.setAssignmentNoShow(assignment.id, false); // stays covered, just by someone else
  }
  // reassign the shift to the claimer
  await store.removeAssignment(assignment.id);
  await store.addAssignment(assignment.weekStart, assignment.date, assignment.shiftTemplateId, claimerId, { manual: true });

  // The offer is taken — nobody else should keep seeing "you can take it".
  await retractSwapOffers(store, [swapId]);

  const desc = shiftDesc(template, assignment.date);
  await notifyEmployees(store, settings, [swap.requesterId], {
    type: 'swap-claimed', relatedId: swapId,
    text: (claimer ? claimer.name : 'עובד/ת') + ' לקח/ה את המשמרת שלך: ' + desc + '.',
    tag: 'swap-' + swapId, url: '/?tab=myschedule',
  });
  await store.addNotification({
    audience: 'manager', type: 'swap-claimed', relatedId: swapId,
    text: (claimer ? claimer.name : '?') + ' קיבל/ה על עצמו/ה את המשמרת של ' + (requester ? requester.name : '?') + ': ' + desc + '.',
    severity: 'info', channels: ['inapp'],
  });
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings),
    body: (claimer ? claimer.name : '?') + ' לקח/ה את המשמרת של ' + (requester ? requester.name : '?') + ': ' + desc,
    tag: 'swap-' + swapId, url: '/?tab=requests',
  }, push.toManagers()), 'swap-claimed (manager)');
  return true;
}

async function cancelSwapRequest(store, { swapId, requesterId }) {
  const swap = await store.getSwapRequest(swapId);
  if (!swap) throw new Error('not_found');
  if (swap.requesterId !== requesterId) throw new Error('not_owner');
  if (swap.status !== 'open') throw new Error('not_open');
  await store.deleteSwapRequest(swapId, requesterId);
  await retractSwapOffers(store, [swapId]);
  return true;
}

// ---------- manual schedule edits by the manager ----------
// On a PUBLISHED week, both of these tell the affected employee right away (in-app + phone) and
// queue a note to their team, so a shift added or taken away by hand never goes unnoticed. On a
// draft week nobody but the manager sees the schedule yet, so edits are silent — everyone hears
// about the final result when the manager approves it. Shifts already in the past are edited
// silently too — that's the manager fixing history for the hours report, not news.

async function manualAssign(store, { weekStart, date, shiftTemplateId, employeeId, override }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || S.weekKeyOf(date) !== weekStart) throw new Error('invalid_date');
  const [templates, employee, availRows, settings, week] = await Promise.all([
    store.listShiftTemplates(), store.getEmployee(employeeId),
    store.listAvailability({ employeeId, fromDate: date, toDate: date }), store.getSettings(),
    store.getScheduleWeek(weekStart),
  ]);
  const template = templates.find(t => t.id === shiftTemplateId);
  if (!template) throw new Error('invalid_template');
  if (!employee || !employee.active) throw new Error('invalid_employee');
  if (week && week.assignments.some(a => a.date === date && a.shiftTemplateId === shiftTemplateId && a.employeeId === employeeId)) {
    throw new Error('already_assigned');
  }

  // Breaking one of the manager's own rules (night only / after a night / set number of shifts)
  // is allowed by hand — but only once the manager has seen the warning and confirmed.
  const warnings = await ruleWarnings(store, employee, template, date, { checkQuota: true });
  if (warnings.length && !override) {
    const err = new Error('needs_confirmation');
    err.warnings = warnings;
    throw err;
  }

  const bucket = S.timeBucketOf(template);
  const choice = availRows.length ? availRows[0].choice : 'all'; // no submission yet => treated as available
  const constraintConflict = !S.isAvailableForShift(choice, bucket);

  const id = await store.addAssignment(weekStart, date, shiftTemplateId, employeeId, { manual: true });
  const desc = shiftDesc(template, date);
  if (constraintConflict) {
    await store.addNotification({
      audience: 'manager', type: 'constraint-conflict', relatedId: id,
      text: 'שובץ/ה ' + employee.name + ' למשמרת ' + desc + ' בניגוד לזמינות שהגיש/ה.',
      severity: 'warning', channels: ['inapp'],
    });
  }
  const notified = date >= S.todayStr() && await store.isWeekPublished(weekStart);
  if (notified) {
    await notifyEmployees(store, settings, [employeeId], {
      type: 'shift-added', relatedId: id,
      text: 'שובצת למשמרת: ' + desc + '.',
      tag: 'shift-' + id, url: '/?tab=myschedule',
    });
    queueTeamChange(store, weekStart, template.roleId, employee.name + ' שובץ/ה ל' + desc);
  }
  return { id, constraintConflict, notified, warnings };
}

async function manualRemove(store, assignmentId) {
  const assignment = await store.getAssignment(assignmentId);
  if (!assignment) throw new Error('not_found');
  const [templates, settings] = await Promise.all([store.listShiftTemplates(), store.getSettings()]);
  const template = templates.find(t => t.id === assignment.shiftTemplateId);
  const employee = await store.getEmployee(assignment.employeeId);
  await store.removeAssignment(assignmentId);
  const droppedSwaps = await store.deleteOpenSwapsForAssignment(assignmentId);
  await retractSwapOffers(store, droppedSwaps);
  const notified = assignment.date >= S.todayStr() && await store.isWeekPublished(assignment.weekStart);
  if (notified) {
    await notifyEmployees(store, settings, [assignment.employeeId], {
      type: 'shift-removed', relatedId: assignmentId,
      text: 'הוסרת מהמשמרת: ' + shiftDesc(template, assignment.date) + '.',
      severity: 'warning', tag: 'shift-' + assignmentId, url: '/?tab=myschedule',
    });
    if (template) queueTeamChange(store, assignment.weekStart, template.roleId, (employee ? employee.name : '?') + ' הוסר/ה מ' + shiftDesc(template, assignment.date));
  }
  return { notified };
}

module.exports = { generateWeek, publishWeek, openSwapRequest, claimSwapRequest, cancelSwapRequest, manualAssign, manualRemove, flushTeamChanges, setTeamChangeDelay };
