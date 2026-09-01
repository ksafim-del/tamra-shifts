'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { makeSqliteAdapter } = require('./db-sqlite.js');
const { initSchema, makeStore } = require('./store.js');
const { createServer } = require('./server.js');
const S = require('./schedule.js');
const { buildFakeWorkbook, sampleRows } = require('./test-helpers/xlsx-fixture.js');

async function startTestServer() {
  const db = makeSqliteAdapter(':memory:');
  await initSchema(db);
  const store = makeStore(db);
  const server = createServer(store, { sessionSecret: 'test-secret', secureCookies: false, cronSecret: 'cron-test' });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, store, base: 'http://127.0.0.1:' + port };
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0];
}

test('manager login + bootstrap + employee CRUD via HTTP', async (t) => {
  const { server, base } = await startTestServer();
  t.after(() => server.close());

  const badLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '0000' }) });
  assert.strictEqual(badLogin.status, 401);

  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  assert.strictEqual(login.status, 200);
  const cookie = extractCookie(login);
  assert.ok(cookie);

  const boot = await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } });
  const bootBody = await boot.json();
  assert.strictEqual(boot.status, 200);
  assert.strictEqual(bootBody.session.type, 'manager');
  assert.strictEqual(bootBody.shiftTemplates.length, 6);

  const create = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'דני כהן', roleId: 'fuel', pin: '1111' }) });
  const createBody = await create.json();
  assert.strictEqual(create.status, 200);
  assert.ok(createBody.employee.id);

  // no-cookie access is rejected
  const noAuth = await fetch(base + '/api/employees');
  assert.strictEqual(noAuth.status, 403);
});

test('employee login with PIN and full swap-request flow between two employees, manager sees escalation when alone', async (t) => {
  const { server, store, base } = await startTestServer();
  t.after(() => server.close());

  const mgrLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  const mgrCookie = extractCookie(mgrLogin);

  const e1res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד1', roleId: 'fuel', pin: '1111' }) });
  const e1 = (await e1res.json()).employee;

  // solo employee of this role -> no peers to ask -> manager gets urgent notification immediately
  const genRes = await fetch(base + '/api/schedule/2026-08-30/generate', { method: 'POST', headers: { Cookie: mgrCookie } });
  const genBody = await genRes.json();
  assert.strictEqual(genRes.status, 200);
  assert.ok(genBody.week.understaffed.length > 0, 'only 1 fuel employee for 6 daily slots must understaff');

  const empLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e1.id, pin: '1111' }) });
  assert.strictEqual(empLogin.status, 200);
  const empCookie = extractCookie(empLogin);

  const week = await (await fetch(base + '/api/schedule/2026-08-30', { headers: { Cookie: empCookie } })).json();
  const myAssignment = week.week.assignments.find(a => a.employeeId === e1.id);
  assert.ok(myAssignment, 'employee should have at least one assignment');

  const swapRes = await fetch(base + '/api/assignment/' + myAssignment.id + '/swap-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ kind: 'swap' }) });
  assert.strictEqual(swapRes.status, 200);

  const mgrNotifs = await (await fetch(base + '/api/notifications', { headers: { Cookie: mgrCookie } })).json();
  const escalation = mgrNotifs.notifications.find(n => n.type === 'swap-open');
  assert.ok(escalation, 'manager should be notified of the swap request');
  assert.ok(escalation.text.includes('אין עוד עובד'), 'manager notification should flag no peer is available');

  // now add a second fuel employee, request again, verify they get an in-app notification and can claim
  const e2res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד2', roleId: 'fuel', pin: '2222' }) });
  const e2 = (await e2res.json()).employee;
  const e2Login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e2.id, pin: '2222' }) });
  const e2Cookie = extractCookie(e2Login);

  const week2 = await (await fetch(base + '/api/schedule/2026-08-30', { headers: { Cookie: empCookie } })).json();
  const another = week2.week.assignments.find(a => a.employeeId === e1.id && a.id !== myAssignment.id);
  assert.ok(another, 'employee should have a second assignment to test claim flow on');
  await fetch(base + '/api/assignment/' + another.id + '/swap-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ kind: 'swap' }) });

  const e2Notifs = await (await fetch(base + '/api/notifications', { headers: { Cookie: e2Cookie } })).json();
  assert.ok(e2Notifs.notifications.some(n => n.type === 'swap-open'), 'peer should be notified of the open swap');

  const swaps = await (await fetch(base + '/api/swaps?status=open', { headers: { Cookie: e2Cookie } })).json();
  const openSwap = swaps.swaps.find(s => s.assignmentId === another.id);
  assert.ok(openSwap);

  const claimRes = await fetch(base + '/api/swaps/' + openSwap.id + '/claim', { method: 'POST', headers: { Cookie: e2Cookie } });
  assert.strictEqual(claimRes.status, 200);

  const week3 = await (await fetch(base + '/api/schedule/2026-08-30', { headers: { Cookie: mgrCookie } })).json();
  const reassigned = week3.week.assignments.find(a => a.date === another.date && a.shiftTemplateId === another.shiftTemplateId);
  assert.strictEqual(reassigned.employeeId, e2.id, 'shift should now belong to the claiming employee');
});

test('employee can cancel their own open swap request, but not someone else\'s', async (t) => {
  const { server, base } = await startTestServer();
  t.after(() => server.close());
  const mgrLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  const mgrCookie = extractCookie(mgrLogin);
  const e1res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד1', roleId: 'fuel', pin: '1111' }) });
  const e1 = (await e1res.json()).employee;
  const e2res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד2', roleId: 'fuel', pin: '2222' }) });
  const e2 = (await e2res.json()).employee;
  await fetch(base + '/api/schedule/2026-08-30/generate', { method: 'POST', headers: { Cookie: mgrCookie } });

  const empLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e1.id, pin: '1111' }) });
  const empCookie = extractCookie(empLogin);
  const week = await (await fetch(base + '/api/schedule/2026-08-30', { headers: { Cookie: empCookie } })).json();
  const myAssignment = week.week.assignments.find(a => a.employeeId === e1.id);
  const swapRes = await fetch(base + '/api/assignment/' + myAssignment.id + '/swap-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ kind: 'swap' }) });
  const swapId = (await swapRes.json()).id;

  const e2Login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e2.id, pin: '2222' }) });
  const e2Cookie = extractCookie(e2Login);
  const wrongDelete = await fetch(base + '/api/swaps/' + swapId, { method: 'DELETE', headers: { Cookie: e2Cookie } });
  assert.strictEqual(wrongDelete.status, 400, 'a peer must not be able to cancel someone else\'s request');

  const ownDelete = await fetch(base + '/api/swaps/' + swapId, { method: 'DELETE', headers: { Cookie: empCookie } });
  assert.strictEqual(ownDelete.status, 200);
  const swapsAfter = await (await fetch(base + '/api/swaps', { headers: { Cookie: mgrCookie } })).json();
  assert.ok(!swapsAfter.swaps.some(s => s.id === swapId), 'cancelled request should be gone');
});

test('constraint deadline enforcement over HTTP (locked week rejected, far week accepted)', async (t) => {
  const { server, base } = await startTestServer();
  t.after(() => server.close());
  const mgrLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  const mgrCookie = extractCookie(mgrLogin);
  const e1res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד1', roleId: 'fuel', pin: '1111' }) });
  const e1 = (await e1res.json()).employee;
  const empLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e1.id, pin: '1111' }) });
  const empCookie = extractCookie(empLogin);

  // NOTE: this test's pass/fail depends on wall-clock "now" relative to fixed dates below,
  // matching the same fixture dates verified against the schedule.test.js unit tests.
  const now = Date.now();
  const nextWeekLocked = S.constraintDeadlinePassed('2099-01-06', 4, now); // arbitrary far week for structural check only
  assert.strictEqual(typeof nextWeekLocked, 'boolean');

  // Use a date far enough in the future that it is provably still open regardless of "today".
  const farDate = S.addDays(S.todayStr(), 60);
  const okRes = await fetch(base + '/api/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ kind: 'date', date: farDate, allDay: true }) });
  assert.strictEqual(okRes.status, 200);

  // A date inside the immediately-next generation week (already locked as of "now") must be rejected.
  const lockedWeek = S.nextGenerationWeek();
  const lockedDate = S.addDays(lockedWeek, 2);
  const blockedRes = await fetch(base + '/api/constraints', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ kind: 'date', date: lockedDate, allDay: true }) });
  // Whether this is actually locked depends on "today" vs the deadline; assert consistency with the pure function instead of a hardcoded expectation.
  const shouldBeLocked = S.constraintDeadlinePassed(lockedDate, 4);
  assert.strictEqual(blockedRes.status, shouldBeLocked ? 409 : 200);
});

test('hours report buckets are exposed per role via HTTP', async (t) => {
  const { server, base } = await startTestServer();
  t.after(() => server.close());
  const mgrLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  const mgrCookie = extractCookie(mgrLogin);
  await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד1', roleId: 'fuel', pin: '1111' }) });
  await fetch(base + '/api/schedule/2026-08-30/generate', { method: 'POST', headers: { Cookie: mgrCookie } });
  const hours = await (await fetch(base + '/api/hours/2026-08', { headers: { Cookie: mgrCookie } })).json();
  const anyEmp = Object.values(hours.hours)[0];
  assert.ok(anyEmp);
  assert.ok(Math.abs(anyEmp.total - (anyEmp.regular + anyEmp.overtime + anyEmp.night + anyEmp.shabbat)) < 0.01);
});

test('POST /api/hours/truth: manager-only, parses the uploaded attendance .xlsx and matches by full name', async (t) => {
  const { server, base } = await startTestServer();
  t.after(() => server.close());
  const mgrLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manager', pin: '1234' }) });
  const mgrCookie = extractCookie(mgrLogin);

  // one employee whose name matches a row in the fixture file, one who doesn't appear in it at all
  const e1res = await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'מרווה עאבד', roleId: 'fuel', pin: '1111' }) });
  const e1 = (await e1res.json()).employee;
  await fetch(base + '/api/employees', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ name: 'עובד ללא קובץ', roleId: 'store', pin: '2222' }) });

  const fileBase64 = buildFakeWorkbook('תצורה עשרונית', sampleRows()).toString('base64');

  const noAuth = await fetch(base + '/api/hours/truth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileBase64 }) });
  assert.strictEqual(noAuth.status, 403); // this route's manager-only gate returns 403 for both "not a manager" and "no session", matching every other manager-only route in this file

  const empLogin = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'employee', employeeId: e1.id, pin: '1111' }) });
  const empCookie = extractCookie(empLogin);
  const asEmployee = await fetch(base + '/api/hours/truth', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: empCookie }, body: JSON.stringify({ fileBase64 }) });
  assert.strictEqual(asEmployee.status, 403);

  const badFile = await fetch(base + '/api/hours/truth', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ fileBase64: Buffer.from('not a real xlsx').toString('base64') }) });
  assert.strictEqual(badFile.status, 400);
  assert.strictEqual((await badFile.json()).error, 'parse_failed');

  const res = await fetch(base + '/api/hours/truth', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mgrCookie }, body: JSON.stringify({ fileBase64 }) });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.sheetUsed, 'תצורה עשרונית');
  assert.strictEqual(body.matched.length, 1);
  assert.strictEqual(body.matched[0].employeeId, e1.id);
  assert.strictEqual(body.matched[0].regular, 126.2);
  assert.strictEqual(body.matched[0].overtimeA, 2);
  assert.strictEqual(body.matched[0].overtimeB, 1.52);
  // the other two file rows (ASAD JERIS, and the row named "עובד לא קיים באתר") have no matching site employee
  assert.strictEqual(body.unmatched.length, 2);
  assert.ok(body.unmatched.every((u) => u.fileName !== 'מרווה עאבד'));
});
