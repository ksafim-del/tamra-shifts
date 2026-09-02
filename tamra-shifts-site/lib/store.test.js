'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { makeSqliteAdapter } = require('./db-sqlite.js');
const { initSchema, makeStore } = require('./store.js');

async function freshStore() {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  return makeStore(db);
}

test('initSchema seeds default settings and the 10 shift templates from spec (no office)', async () => {
  const store = await freshStore();
  const settings = await store.getSettings();
  assert.strictEqual(settings.weeklyGenerationDow, 4);
  assert.strictEqual(settings.minRestHours, 24);
  const templates = await store.listShiftTemplates();
  assert.strictEqual(templates.length, 10);
  const fuelMorning = templates.find(t => t.roleId === 'fuel' && t.label === 'בוקר מתדלקים');
  assert.strictEqual(fuelMorning.needed, 3);
  assert.deepStrictEqual(fuelMorning.days, [0,1,2,3,4,5], 'regular fuel morning excludes Saturday');
  const satMiddle = templates.find(t => t.label === 'ביניים מתדלקים (שבת)');
  assert.deepStrictEqual(satMiddle.days, [6]);
  assert.strictEqual(satMiddle.start, '09:00');
  assert.strictEqual(satMiddle.end, '21:00');
  const storeMorning = templates.find(t => t.roleId === 'store' && t.label === 'בוקר חנות');
  assert.strictEqual(storeMorning.autoAssign, true, 'store morning is auto-filled like any other shift');
  assert.strictEqual(storeMorning.allowExtra, true, 'store morning always keeps the manual "add one more" option');
  const storeMiddle = templates.find(t => t.label === 'ביניים חנות');
  assert.deepStrictEqual(storeMiddle.days.slice().sort(), [2,6]);
  assert.ok(!templates.some(t => t.roleId === 'office'), 'office shifts should not be seeded');
  const storeNight = templates.find(t => t.roleId === 'store' && t.label === 'לילה חנות');
  assert.strictEqual(storeNight.requiredGender, 'male', 'store night shift is male-only in generation');
  const fuelNight = templates.find(t => t.roleId === 'fuel' && t.label === 'לילה מתדלקים');
  assert.strictEqual(fuelNight.requiredGender, null, 'no gender restriction on other shifts');
});

test('applyScheduleTemplateSpecV3 backfills required_gender=male onto a pre-existing store night template', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  // simulate a database seeded before this rule existed: store night present, no required_gender
  const row = await db.get("SELECT id FROM shift_templates WHERE role_id = 'store' AND label = 'לילה חנות'", []);
  await db.run('UPDATE shift_templates SET required_gender = NULL WHERE id = ?', [row.id]);
  let templates = await store.listShiftTemplates();
  assert.strictEqual(templates.find(t => t.id === row.id).requiredGender, null, 'sanity: cleared for the test');

  await initSchema(db); // simulates a redeploy startup

  templates = await store.listShiftTemplates();
  assert.strictEqual(templates.find(t => t.id === row.id).requiredGender, 'male');

  await initSchema(db); // idempotency: running it again must not error or change anything further
  templates = await store.listShiftTemplates();
  assert.strictEqual(templates.find(t => t.id === row.id).requiredGender, 'male');
});

test('applyScheduleTemplateSpecV4 backfills auto_assign+allow_extra onto a pre-existing manual-only store morning template', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  // simulate a database still on the old manual-only spec (as V2 used to leave it)
  const row = await db.get("SELECT id FROM shift_templates WHERE role_id = 'store' AND label = 'בוקר חנות'", []);
  await db.run('UPDATE shift_templates SET auto_assign = 0, allow_extra = 0 WHERE id = ?', [row.id]);
  let templates = await store.listShiftTemplates();
  let t = templates.find(tt => tt.id === row.id);
  assert.strictEqual(t.autoAssign, false, 'sanity: reset to manual-only for the test');
  assert.strictEqual(t.allowExtra, false, 'sanity: reset for the test');

  await initSchema(db); // simulates a redeploy startup

  templates = await store.listShiftTemplates();
  t = templates.find(tt => tt.id === row.id);
  assert.strictEqual(t.autoAssign, true, 'store morning is auto-filled again');
  assert.strictEqual(t.allowExtra, true, 'the manual "add one more" option stays available');

  await initSchema(db); // idempotency
  templates = await store.listShiftTemplates();
  t = templates.find(tt => tt.id === row.id);
  assert.strictEqual(t.autoAssign, true);
  assert.strictEqual(t.allowExtra, true);
});

test('cleanupVerboseUnderstaffedNotifications rewrites an old-format notification to the short summary, and leaves a short one alone', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  // exact shape the old (pre-fix) notification code used to write: one line per missing slot
  const oldText = 'הלוז לשבוע 2026-08-30 הופק אך יש משמרות לא מאוישות:\n'
    + '2026-08-30 לילה מתדלקים (21:00-05:00) — חסרים 1\n'
    + '2026-08-30 לילה חנות (21:00-07:00) — חסרים 1\n'
    + '2026-08-31 צהריים מתדלקים (13:00-21:00) — חסרים 2';
  const oldId = await store.addNotification({ audience: 'manager', type: 'understaffed', text: oldText, severity: 'warning' });
  const alreadyShortId = await store.addNotification({ audience: 'manager', type: 'understaffed', text: 'הלוז לשבוע 2026-09-06 הופק — 3 משמרות ללא איוש (2 מתדלקים, 1 עובדי חנות). לפירוט מלא: לשונית "לוז שבועי".', severity: 'warning' });

  await initSchema(db); // simulates a redeploy startup with the cleanup migration now present

  const notifs = await store.listNotifications({ audience: 'manager' });
  const rewritten = notifs.find(n => n.id === oldId);
  assert.ok(rewritten.text.indexOf('\n') === -1, 'no more multi-line dump');
  assert.strictEqual(rewritten.text, 'הלוז לשבוע 2026-08-30 הופק — 4 משמרות ללא איוש (3 מתדלקים, 1 עובדי חנות). לפירוט מלא: לשונית "לוז שבועי".');
  const untouched = notifs.find(n => n.id === alreadyShortId);
  assert.strictEqual(untouched.text, 'הלוז לשבוע 2026-09-06 הופק — 3 משמרות ללא איוש (2 מתדלקים, 1 עובדי חנות). לפירוט מלא: לשונית "לוז שבועי".', 'already-short notifications are left alone');

  await initSchema(db); // idempotency: nothing left to rewrite
  const notifs2 = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(notifs2.find(n => n.id === oldId).text, rewritten.text);
});

test('dedupeScheduleStatusNotifications collapses old stacked-up regeneration rows for the same week down to the latest, and backfills related_id', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  // simulate three pre-fix rows for the same week, left over from three separate regenerations,
  // none of them carrying related_id (that column wasn't populated for these types yet)
  await db.run('INSERT INTO notifications (id, audience, employee_id, type, text, severity, related_id, channels, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    ['n1', 'manager', null, 'understaffed', 'הלוז לשבוע 2026-08-30 הופק — 5 משמרות ללא איוש (5 מתדלקים). לפירוט מלא: לשונית "לוז שבועי".', 'warning', null, '["inapp"]', 1000]);
  await db.run('INSERT INTO notifications (id, audience, employee_id, type, text, severity, related_id, channels, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    ['n2', 'manager', null, 'understaffed', 'הלוז לשבוע 2026-08-30 הופק — 2 משמרות ללא איוש (2 מתדלקים). לפירוט מלא: לשונית "לוז שבועי".', 'warning', null, '["inapp"]', 2000]);
  await db.run('INSERT INTO notifications (id, audience, employee_id, type, text, severity, related_id, channels, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    ['n3', 'manager', null, 'generated', 'הלוז לשבוע 2026-08-30 הופק בהצלחה, כל המשמרות מאוישות.', 'info', null, '["inapp"]', 3000]);
  // an unrelated week's single row must be left alone
  await db.run('INSERT INTO notifications (id, audience, employee_id, type, text, severity, related_id, channels, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
    ['n4', 'manager', null, 'generated', 'הלוז לשבוע 2026-09-06 הופק בהצלחה, כל המשמרות מאוישות.', 'info', null, '["inapp"]', 4000]);

  await initSchema(db); // simulates a redeploy startup with the dedupe migration now present

  const notifs = await store.listNotifications({ audience: 'manager' });
  const forThatWeek = notifs.filter(n => n.text.indexOf('לשבוע 2026-08-30') !== -1);
  assert.strictEqual(forThatWeek.length, 1, 'only the latest regeneration status survives');
  assert.strictEqual(forThatWeek[0].id, 'n3', 'the most recently created row is the one kept');
  assert.strictEqual(forThatWeek[0].relatedId, '2026-08-30', 'related_id backfilled so future regenerations can replace it');
  const otherWeek = notifs.find(n => n.id === 'n4');
  assert.strictEqual(otherWeek.relatedId, '2026-09-06', 'untouched single row still gets related_id backfilled');

  await initSchema(db); // idempotency: nothing left to collapse
  const notifs2 = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(notifs2.filter(n => n.text.indexOf('לשבוע 2026-08-30') !== -1).length, 1);
});

test('generateWeek replaces the previous status notification instead of stacking a new one on regeneration', async () => {
  const store = await freshStore();
  const { generateWeek } = require('./actions.js');

  await generateWeek(store, '2026-09-13', { force: true });
  const first = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(first.length, 1, 'first generation writes exactly one status notification');
  const firstText = first[0].text;

  await generateWeek(store, '2026-09-13', { force: true });
  const second = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(second.length, 1, 'regenerating the same week replaces the status instead of adding another');
  assert.strictEqual(second[0].relatedId, '2026-09-13');
  assert.strictEqual(second[0].text, firstText, 'same inputs regenerate the same status text');
  assert.notStrictEqual(second[0].id, first[0].id, 'it really is a fresh row, not a leftover mutated in place');
});

test('applyScheduleTemplateSpecV2 migrates a pre-existing (old-shape) database on next startup', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  // Replace the (already-current) seed with the OLD pre-migration shape by hand, simulating a
  // production database seeded before this change: Saturday included in morning/afternoon,
  // store morning still auto-assigned, none of the new templates present.
  await db.run('DELETE FROM shift_templates', []);
  const morningId = await store.createShiftTemplate({ roleId: 'fuel', label: 'בוקר מתדלקים', start: '05:00', end: '13:00', needed: 3, days: [0,1,2,3,4,5,6] });
  const afternoonId = await store.createShiftTemplate({ roleId: 'fuel', label: 'צהריים מתדלקים', start: '13:00', end: '21:00', needed: 2, days: [0,1,2,3,4,5,6] });
  const nightId = await store.createShiftTemplate({ roleId: 'fuel', label: 'לילה מתדלקים', start: '21:00', end: '05:00', needed: 1, days: [0,1,2,3,4,5,6] });
  const storeMorningId = await store.createShiftTemplate({ roleId: 'store', label: 'בוקר חנות', start: '06:00', end: '13:00', needed: 1, days: [0,1,2,3,4,5,6] });

  await initSchema(db); // simulates a redeploy startup against the already-seeded (old-shape) database

  const templates = await store.listShiftTemplates();
  const morning = templates.find(t => t.id === morningId);
  const afternoon = templates.find(t => t.id === afternoonId);
  const night = templates.find(t => t.id === nightId);
  const storeMorning = templates.find(t => t.id === storeMorningId);

  assert.deepStrictEqual(morning.days, [0,1,2,3,4,5], 'fuel morning drops Saturday');
  assert.deepStrictEqual(afternoon.days, [0,1,2,3,4,5], 'fuel afternoon drops Saturday');
  assert.deepStrictEqual(night.days, [0,1,2,3,4,5,6], 'fuel night is untouched, still covers Saturday');
  // V2 sets store morning manual-only, but V4 (which always runs right after in the same
  // initSchema call) brings it back to auto-filled with an extra manual-add option — so the
  // end state after a real startup is the current spec, not V2's intermediate one.
  assert.strictEqual(storeMorning.autoAssign, true, 'store morning ends up auto-filled (current spec, via V4)');
  assert.strictEqual(storeMorning.allowExtra, true);

  const satMorning = templates.find(t => t.roleId === 'fuel' && t.label === 'בוקר מתדלקים (שבת)');
  const satMiddle = templates.find(t => t.roleId === 'fuel' && t.label === 'ביניים מתדלקים (שבת)');
  const satAfternoon = templates.find(t => t.roleId === 'fuel' && t.label === 'צהריים מתדלקים (שבת)');
  const storeMiddle = templates.find(t => t.roleId === 'store' && t.label === 'ביניים חנות');
  assert.ok(satMorning && satMorning.needed === 1 && satMorning.days.length === 1 && satMorning.days[0] === 6);
  assert.ok(satMiddle && satMiddle.start === '09:00' && satMiddle.end === '21:00');
  assert.ok(satAfternoon && satAfternoon.start === '13:00' && satAfternoon.end === '23:00');
  assert.ok(storeMiddle && storeMiddle.start === '10:00' && storeMiddle.end === '17:00');
  assert.deepStrictEqual(storeMiddle.days.slice().sort(), [2, 6]);

  // idempotency: running it again (another redeploy) must not duplicate anything
  await initSchema(db);
  const templates2 = await store.listShiftTemplates();
  assert.strictEqual(templates2.length, templates.length);
});

test('office templates get deactivated on the next startup, even if pre-existing', async () => {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  const id = await store.createShiftTemplate({ roleId: 'office', label: 'משרד', start: '08:00', end: '17:00', needed: 2, days: [0,1,2,3,4] });
  assert.strictEqual((await store.listShiftTemplates()).find(t => t.id === id).active, true);
  await initSchema(db); // simulates redeploy startup against an already-seeded database
  assert.strictEqual((await store.listShiftTemplates()).find(t => t.id === id).active, false);
});

test('employee CRUD + pin login', async () => {
  const store = await freshStore();
  const e = await store.createEmployee({ name: 'דני כהן', roleId: 'fuel', pin: '1234' });
  assert.ok(e.id);
  assert.strictEqual(e.gender, null, 'gender is optional and defaults to null');
  const found = await store.getEmployeeByPin(e.id, '1234');
  assert.strictEqual(found.name, 'דני כהן');
  const wrongPin = await store.getEmployeeByPin(e.id, '0000');
  assert.strictEqual(wrongPin, null);
  const list = await store.listEmployees();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].pin, undefined, 'pin must not leak in default listing');
});

test('employee gender is stored and editable', async () => {
  const store = await freshStore();
  const e = await store.createEmployee({ name: 'שרה לוי', roleId: 'store', pin: '5555', gender: 'female' });
  assert.strictEqual(e.gender, 'female');
  const updated = await store.updateEmployee(e.id, { gender: 'male' });
  assert.strictEqual(updated.gender, 'male');
});

test('BIGINT timestamp fields always come back as JS numbers (Postgres returns BIGINT as strings)', async () => {
  const store = await freshStore();
  const e = await store.createEmployee({ name: 'E1', roleId: 'fuel', pin: '1111' });
  await store.addNotification({ audience: 'manager', type: 'generated', text: 'x' });
  const [notif] = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(typeof notif.ts, 'number');
  assert.ok(!isNaN(new Date(notif.ts).getTime()), 'new Date(ts) must not be Invalid Date');

  await store.addConstraint({ employeeId: e.id, kind: 'date', date: '2026-09-10', allDay: true });
  const [constraint] = await store.listConstraints(e.id);
  assert.strictEqual(typeof constraint.createdAt, 'number');
});

test('schedule save/read round-trip + constraints + notifications', async () => {
  const store = await freshStore();
  const e1 = await store.createEmployee({ name: 'E1', roleId: 'fuel', pin: '1111' });
  await store.saveGeneratedSchedule('2026-08-30', [
    { date: '2026-08-30', shiftTemplateId: 'x', employeeId: e1.id },
  ], [{ date: '2026-08-31', shiftTemplateId: 'y', missing: 1 }], Date.now());
  const week = await store.getScheduleWeek('2026-08-30');
  assert.strictEqual(week.assignments.length, 1);
  assert.strictEqual(week.understaffed.length, 1);

  const cid = await store.addConstraint({ employeeId: e1.id, kind: 'date', date: '2026-09-01', allDay: true });
  const cons = await store.listConstraints(e1.id);
  assert.strictEqual(cons.length, 1);
  assert.strictEqual(cons[0].id, cid);

  const nid = await store.addNotification({ audience: 'manager', type: 'urgent', text: 'test', channels: ['inapp','email'] });
  const notifs = await store.listNotifications({ audience: 'manager' });
  assert.strictEqual(notifs.length, 1);
  assert.deepStrictEqual(notifs[0].channels, ['inapp','email']);
});

test('getScheduleWeek surfaces manual assignments even before the week has ever been generated, and that counts as "already has a schedule"', async () => {
  const { generateWeek } = require('./actions.js');
  const store = await freshStore();
  const e1 = await store.createEmployee({ name: 'E1', roleId: 'fuel', pin: '1111' });
  const templates = await store.listShiftTemplates();
  const morning = templates.find(t => t.roleId === 'fuel' && t.label === 'בוקר מתדלקים');

  assert.strictEqual(await store.getScheduleWeek('2026-09-13'), null, 'a week with nothing at all is still null');

  await store.addAssignment('2026-09-13', '2026-09-13', morning.id, e1.id);
  const week = await store.getScheduleWeek('2026-09-13');
  assert.ok(week, 'a manual assignment alone makes the week non-null');
  assert.strictEqual(week.assignments.length, 1);
  assert.strictEqual(week.generatedAt, null);
  assert.deepStrictEqual(week.understaffed, []);

  // generating that week now must not silently wipe out the manual assignment
  const result = await generateWeek(store, '2026-09-13');
  assert.strictEqual(result.skipped, true, 'a week that already has a manual assignment is treated as already scheduled');
  const stillThere = await store.getScheduleWeek('2026-09-13');
  assert.strictEqual(stillThere.assignments.length, 1, 'the manual assignment must survive an unforced generate');
});

test('swap request lifecycle', async () => {
  const store = await freshStore();
  const e1 = await store.createEmployee({ name: 'E1', roleId: 'fuel', pin: '1111' });
  const aid = await store.addAssignment('2026-08-30', '2026-08-30', 'tpl1', e1.id);
  const sid = await store.createSwapRequest({ assignmentId: aid, requesterId: e1.id, roleId: 'fuel', kind: 'swap' });
  let swap = await store.getSwapRequest(sid);
  assert.strictEqual(swap.status, 'open');
  const e2 = await store.createEmployee({ name: 'E2', roleId: 'fuel', pin: '2222' });
  await store.updateSwapRequest(sid, { status: 'claimed', claimedBy: e2.id, resolved: true });
  swap = await store.getSwapRequest(sid);
  assert.strictEqual(swap.status, 'claimed');
  assert.strictEqual(swap.claimedBy, e2.id);
  assert.ok(swap.resolvedAt);
});

test('swap request can be deleted by its requester only', async () => {
  const store = await freshStore();
  const e1 = await store.createEmployee({ name: 'E1', roleId: 'fuel', pin: '1111' });
  const e2 = await store.createEmployee({ name: 'E2', roleId: 'fuel', pin: '2222' });
  const aid = await store.addAssignment('2026-08-30', '2026-08-30', 'tpl1', e1.id);
  const sid = await store.createSwapRequest({ assignmentId: aid, requesterId: e1.id, roleId: 'fuel', kind: 'swap' });
  await store.deleteSwapRequest(sid, e2.id); // wrong requester -> no-op
  assert.ok(await store.getSwapRequest(sid), 'request should survive a delete attempt by a non-owner');
  await store.deleteSwapRequest(sid, e1.id);
  assert.strictEqual(await store.getSwapRequest(sid), null);
});

test('getScheduleWeek drops understaffed entries for a shift template that was later deactivated', async () => {
  const store = await freshStore();
  const officeTplId = await store.createShiftTemplate({ roleId: 'office', label: 'משרד', start: '08:00', end: '17:00', needed: 2, days: [0,1,2,3,4] });
  const activeTpl = (await store.listShiftTemplates()).find(t => t.roleId === 'fuel');
  await store.saveGeneratedSchedule('2026-08-30', [], [
    { date: '2026-08-30', shiftTemplateId: officeTplId, missing: 2 },
    { date: '2026-08-31', shiftTemplateId: activeTpl.id, missing: 1 },
  ], Date.now());
  await store.updateShiftTemplate(officeTplId, { active: false });
  const week = await store.getScheduleWeek('2026-08-30');
  assert.strictEqual(week.understaffed.length, 1, 'stale entry for the deactivated office template should be filtered out');
  assert.strictEqual(week.understaffed[0].shiftTemplateId, activeTpl.id);
});
