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
  assert.strictEqual(storeMorning.autoAssign, false, 'store morning is manual-only');
  const storeMiddle = templates.find(t => t.label === 'ביניים חנות');
  assert.deepStrictEqual(storeMiddle.days.slice().sort(), [2,6]);
  assert.ok(!templates.some(t => t.roleId === 'office'), 'office shifts should not be seeded');
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
  assert.strictEqual(storeMorning.autoAssign, false, 'store morning becomes manual-only');

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
