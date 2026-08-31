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

test('initSchema seeds default settings and the 6 shift templates from spec (no office)', async () => {
  const store = await freshStore();
  const settings = await store.getSettings();
  assert.strictEqual(settings.weeklyGenerationDow, 4);
  assert.strictEqual(settings.minRestHours, 24);
  const templates = await store.listShiftTemplates();
  assert.strictEqual(templates.length, 6);
  const fuelMorning = templates.find(t => t.roleId === 'fuel' && t.start === '05:00');
  assert.strictEqual(fuelMorning.needed, 3);
  assert.ok(!templates.some(t => t.roleId === 'office'), 'office shifts should not be seeded');
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
  const found = await store.getEmployeeByPin(e.id, '1234');
  assert.strictEqual(found.name, 'דני כהן');
  const wrongPin = await store.getEmployeeByPin(e.id, '0000');
  assert.strictEqual(wrongPin, null);
  const list = await store.listEmployees();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].pin, undefined, 'pin must not leak in default listing');
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
