'use strict';
// Business actions that combine store + schedule + notifications. Shared between
// the interactive API routes and the cron endpoints, so "manual generate" and
// "automatic Thursday generate" are guaranteed to behave identically.
const S = require('./schedule.js');
const mailer = require('./mailer.js');

async function generateWeek(store, weekStart, { force } = {}) {
  const existing = await store.getScheduleWeek(weekStart);
  if (existing && !force) {
    return { skipped: true, reason: 'already_generated', week: existing };
  }
  const [employees, shiftTemplates, constraints, meta] = await Promise.all([
    store.listEmployees(), store.listShiftTemplates(), store.listConstraints(), store.getSettings(),
  ]);
  const priorWeekStart = S.addWeeks(weekStart, -1);
  const priorWeek = await store.getScheduleWeek(priorWeekStart);
  const templatesById = {};
  shiftTemplates.forEach(t => { templatesById[t.id] = t; });
  const priorAssignments = (priorWeek ? priorWeek.assignments : []).map(a =>
    Object.assign({}, a, { _startTs: S.shiftStartTs(a, templatesById) }));

  const result = S.generateSchedule(weekStart, { employees, shiftTemplates, constraints, meta, priorAssignments });
  await store.saveGeneratedSchedule(weekStart, result.assignments, result.understaffed, result.generatedAt);

  // A regeneration of the same week (manual "הפק מחדש", or the automatic Thursday run) replaces
  // this week's status notification instead of piling another one on top of the last.
  await store.replaceScheduleStatusNotification(weekStart);

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

  const settings = meta;
  if (settings.managerEmail) {
    const subject = result.understaffed.length
      ? 'לוז שבועי הופק עם משמרות חסרות — ' + weekStart
      : 'לוז שבועי הופק — ' + weekStart;
    const body = result.understaffed.length
      ? 'הלוז לשבוע ' + weekStart + ' הופק אוטומטית. יש ' + result.understaffed.length + ' משמרות ללא איוש מלא — יש להיכנס לאתר ולשבץ ידנית.'
      : 'הלוז לשבוע ' + weekStart + ' הופק אוטומטית וכל המשמרות מאוישות.';
    await mailer.sendMail({ to: settings.managerEmail, subject, text: body });
  }

  return { skipped: false, week: await store.getScheduleWeek(weekStart) };
}

async function openSwapRequest(store, { assignmentId, requesterId, kind }) {
  const assignment = await store.getAssignment(assignmentId);
  if (!assignment) throw new Error('assignment_not_found');
  if (assignment.employeeId !== requesterId) throw new Error('not_owner');
  const requester = await store.getEmployee(requesterId);
  const employees = await store.listEmployees();
  const templates = await store.listShiftTemplates();
  const template = templates.find(t => t.id === assignment.shiftTemplateId);
  const peers = employees.filter(e => e.active && e.roleId === requester.roleId && e.id !== requesterId);

  const swapId = await store.createSwapRequest({ assignmentId, requesterId, roleId: requester.roleId, kind });

  const label = kind === 'noshow' ? 'לא יכול/ה להגיע ל' : 'מבקש/ת החלפה ל';
  const desc = (template ? template.label + ' ' + assignment.date + ' (' + template.start + '-' + template.end + ')' : assignment.date);

  for (const peer of peers) {
    await store.addNotification({
      audience: 'employee', employeeId: peer.id, type: 'swap-open', relatedId: swapId,
      text: requester.name + ' ' + label + ' משמרת: ' + desc + '. אפשר/י לקחת אותה מתוך "הלוז שלי".',
      severity: 'info', channels: ['inapp'],
    });
  }

  await store.addNotification({
    audience: 'manager', type: 'swap-open', relatedId: swapId,
    text: requester.name + ' ' + label + ' משמרת: ' + desc + (peers.length ? '' : ' — אין עוד עובד/ת פעיל/ה באותו תפקיד לפנות אליו/ה!'),
    severity: peers.length ? 'info' : 'warning',
    channels: peers.length ? ['inapp'] : ['inapp', 'email'],
  });

  if (!peers.length) {
    const settings = await store.getSettings();
    if (settings.managerEmail) {
      await mailer.sendMail({
        to: settings.managerEmail,
        subject: 'דרוש שיבוץ ידני — אין מחליף זמין',
        text: requester.name + ' ' + label + ' משמרת ' + desc + ' ואין עובד/ת אחר/ת פעיל/ה באותו תפקיד. נדרש טיפול ידני.',
      });
    }
  }

  return swapId;
}

async function claimSwapRequest(store, { swapId, claimerId }) {
  const swap = await store.getSwapRequest(swapId);
  if (!swap || swap.status !== 'open') throw new Error('not_open');
  const claimer = await store.getEmployee(claimerId);
  const requester = await store.getEmployee(swap.requesterId);
  if (!claimer || claimer.roleId !== swap.roleId) throw new Error('wrong_role');
  const assignment = await store.getAssignment(swap.assignmentId);
  if (!assignment) throw new Error('assignment_not_found');

  await store.updateSwapRequest(swapId, { status: 'claimed', claimedBy: claimerId, resolved: true });
  if (swap.kind === 'noshow') {
    await store.setAssignmentNoShow(assignment.id, false); // stays covered, just by someone else
  }
  // reassign the shift to the claimer
  await store.removeAssignment(assignment.id);
  await store.addAssignment(assignment.weekStart, assignment.date, assignment.shiftTemplateId, claimerId);

  await store.addNotification({
    audience: 'employee', employeeId: swap.requesterId, type: 'swap-claimed', relatedId: swapId,
    text: (claimer ? claimer.name : 'עובד/ת') + ' לקח/ה את המשמרת שלך בתאריך ' + assignment.date + '.',
    severity: 'info', channels: ['inapp'],
  });
  await store.addNotification({
    audience: 'manager', type: 'swap-claimed', relatedId: swapId,
    text: (claimer ? claimer.name : '?') + ' קיבל/ה על עצמו/ה את המשמרת של ' + (requester ? requester.name : '?') + ' בתאריך ' + assignment.date + '.',
    severity: 'info', channels: ['inapp'],
  });
  return true;
}

async function cancelSwapRequest(store, { swapId, requesterId }) {
  const swap = await store.getSwapRequest(swapId);
  if (!swap) throw new Error('not_found');
  if (swap.requesterId !== requesterId) throw new Error('not_owner');
  if (swap.status !== 'open') throw new Error('not_open');
  await store.deleteSwapRequest(swapId, requesterId);
  return true;
}

module.exports = { generateWeek, openSwapRequest, claimSwapRequest, cancelSwapRequest };
