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

async function generateWeek(store, weekStart, { force } = {}) {
  const existing = await store.getScheduleWeek(weekStart);
  if (existing && !force) {
    return { skipped: true, reason: 'already_generated', week: existing };
  }
  const [employees, shiftTemplates, availability, meta] = await Promise.all([
    store.listEmployees(), store.listShiftTemplates(),
    store.listAvailability({ fromDate: weekStart, toDate: S.addDays(weekStart, 6) }),
    store.getSettings(),
  ]);
  const priorWeekStart = S.addWeeks(weekStart, -1);
  const priorWeek = await store.getScheduleWeek(priorWeekStart);
  const templatesById = {};
  shiftTemplates.forEach(t => { templatesById[t.id] = t; });
  const priorAssignments = (priorWeek ? priorWeek.assignments : [])
    .filter(a => templatesById[a.shiftTemplateId])
    .map(a => Object.assign({}, a, { _startTs: S.shiftStartTs(a, templatesById) }));

  const result = S.generateSchedule(weekStart, { employees, shiftTemplates, availability, meta, priorAssignments });
  await store.saveGeneratedSchedule(weekStart, result.assignments, result.understaffed, result.generatedAt);

  // Regenerating replaces every assignment row of the week, so any swap request still open for
  // this week now points at a shift that no longer exists — drop those (and their offers).
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
      text: 'הלוז לשבוע ' + weekStart + ' הופק — ' + totalMissing + ' משמרות ללא איוש (' + breakdown + '). לפירוט מלא: לשונית "לוז שבועי".',
      severity: 'warning', channels: ['inapp', 'email'],
    });
  } else {
    await store.addNotification({
      audience: 'manager', type: 'generated', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekStart + ' הופק בהצלחה, כל המשמרות מאוישות.',
      severity: 'info', channels: ['inapp'],
    });
  }

  // Every active employee gets a personal "the schedule is out" note in their own התראות tab,
  // with how many shifts they got — replacing the previous one if this week is regenerated.
  await store.deleteNotifications({ audience: 'employee', type: 'schedule-published', relatedId: weekStart });
  const countByEmp = {};
  result.assignments.forEach(a => { countByEmp[a.employeeId] = (countByEmp[a.employeeId] || 0) + 1; });
  for (const e of employees.filter(x => x.active)) {
    const n = countByEmp[e.id] || 0;
    await store.addNotification({
      audience: 'employee', employeeId: e.id, type: 'schedule-published', relatedId: weekStart,
      text: 'הלוז לשבוע ' + weekRangeLabel(weekStart) + ' פורסם — ' + (n ? ('שובצת ל-' + n + ' משמרות. לפרטים: לשונית "הלוז שלי".') : 'לא שובצת למשמרות בשבוע הזה.'),
      severity: 'info', channels: ['inapp'],
    });
  }

  const settings = meta;
  if (settings.managerEmail) {
    const companyPrefix = settings.companyName ? ('[' + settings.companyName + '] ') : '';
    const subject = companyPrefix + (result.understaffed.length
      ? 'לוז שבועי הופק עם משמרות חסרות — ' + weekStart
      : 'לוז שבועי הופק — ' + weekStart);
    const body = result.understaffed.length
      ? 'הלוז לשבוע ' + weekStart + ' הופק אוטומטית. יש ' + result.understaffed.length + ' משמרות ללא איוש מלא — יש להיכנס לאתר ולשבץ ידנית.'
      : 'הלוז לשבוע ' + weekStart + ' הופק אוטומטית וכל המשמרות מאוישות.';
    await mailer.sendMail({ to: settings.managerEmail, subject, text: body });
  }

  // Phone push — the manager gets the staffing summary, employees get "go look at your shifts".
  // Never lets a push-service hiccup fail the schedule generation, which is already saved.
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings),
    body: result.understaffed.length
      ? ('הלוז לשבוע ' + weekStart + ' הופק — ' + result.understaffed.length + ' משמרות ללא איוש')
      : ('הלוז לשבוע ' + weekStart + ' הופק בהצלחה, כל המשמרות מאוישות'),
    tag: 'schedule-' + weekStart,
    url: '/?tab=schedule',
  }, push.toManagers()), 'schedule-generated (manager)');
  await safePush(push.broadcastTo(store, {
    title: pushTitle(settings),
    body: 'הלוז לשבוע ' + weekRangeLabel(weekStart) + ' פורסם — אפשר לראות את המשמרות שלך',
    tag: 'schedule-' + weekStart,
    url: '/?tab=myschedule',
  }, push.toEmployees(employees.filter(e => e.active).map(e => e.id))), 'schedule-generated (employees)');

  return { skipped: false, week: await store.getScheduleWeek(weekStart) };
}

async function openSwapRequest(store, { assignmentId, requesterId, kind }) {
  const assignment = await store.getAssignment(assignmentId);
  if (!assignment) throw new Error('assignment_not_found');
  if (assignment.employeeId !== requesterId) throw new Error('not_owner');
  if (await store.getOpenSwapForAssignment(assignmentId)) throw new Error('already_open');
  const requester = await store.getEmployee(requesterId);
  const [employees, templates, settings] = await Promise.all([store.listEmployees(), store.listShiftTemplates(), store.getSettings()]);
  const template = templates.find(t => t.id === assignment.shiftTemplateId);
  // Only colleagues in the SAME role as the requester — a fuel shift can only be taken by
  // another מתדלק/ת, a store shift only by another עובד/ת חנות — so the other team never
  // sees (in-app or on the phone) swap requests that aren't relevant to them.
  const peers = employees.filter(e => e.active && e.roleId === requester.roleId && e.id !== requesterId);

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
  }

  if (!(await store.claimOpenSwapRequest(swapId, claimerId))) throw new Error('not_open'); // someone else was faster
  if (swap.kind === 'noshow') {
    await store.setAssignmentNoShow(assignment.id, false); // stays covered, just by someone else
  }
  // reassign the shift to the claimer
  await store.removeAssignment(assignment.id);
  await store.addAssignment(assignment.weekStart, assignment.date, assignment.shiftTemplateId, claimerId);

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
// Both of these tell the affected employee right away (in-app + phone), so a shift added or
// taken away by hand never goes unnoticed. Shifts already in the past are edited silently —
// that's the manager fixing history for the hours report, not news for the employee.

async function manualAssign(store, { weekStart, date, shiftTemplateId, employeeId }) {
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

  const bucket = S.timeBucketOf(template);
  const choice = availRows.length ? availRows[0].choice : 'all'; // no submission yet => treated as available
  const constraintConflict = !S.isAvailableForShift(choice, bucket);

  const id = await store.addAssignment(weekStart, date, shiftTemplateId, employeeId);
  const desc = shiftDesc(template, date);
  if (constraintConflict) {
    await store.addNotification({
      audience: 'manager', type: 'constraint-conflict', relatedId: id,
      text: 'שובץ/ה ' + employee.name + ' למשמרת ' + desc + ' בניגוד לזמינות שהגיש/ה.',
      severity: 'warning', channels: ['inapp'],
    });
  }
  const notified = date >= S.todayStr();
  if (notified) {
    await notifyEmployees(store, settings, [employeeId], {
      type: 'shift-added', relatedId: id,
      text: 'שובצת למשמרת: ' + desc + '.',
      tag: 'shift-' + id, url: '/?tab=myschedule',
    });
  }
  return { id, constraintConflict, notified };
}

async function manualRemove(store, assignmentId) {
  const assignment = await store.getAssignment(assignmentId);
  if (!assignment) throw new Error('not_found');
  const [templates, settings] = await Promise.all([store.listShiftTemplates(), store.getSettings()]);
  const template = templates.find(t => t.id === assignment.shiftTemplateId);
  await store.removeAssignment(assignmentId);
  const droppedSwaps = await store.deleteOpenSwapsForAssignment(assignmentId);
  await retractSwapOffers(store, droppedSwaps);
  const notified = assignment.date >= S.todayStr();
  if (notified) {
    await notifyEmployees(store, settings, [assignment.employeeId], {
      type: 'shift-removed', relatedId: assignmentId,
      text: 'הוסרת מהמשמרת: ' + shiftDesc(template, assignment.date) + '.',
      severity: 'warning', tag: 'shift-' + assignmentId, url: '/?tab=myschedule',
    });
  }
  return { notified };
}

module.exports = { generateWeek, openSwapRequest, claimSwapRequest, cancelSwapRequest, manualAssign, manualRemove };
