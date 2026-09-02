'use strict';
const assert = require('node:assert');
const test = require('node:test');
const S = require('./schedule.js');

test('weekKeyOf finds the Sunday of the week', () => {
  assert.strictEqual(S.weekKeyOf('2026-08-27'), '2026-08-23'); // Thu -> Sun
  assert.strictEqual(S.weekKeyOf('2026-08-30'), '2026-08-30'); // Sun -> itself
});

test('deadlineForWeek matches manually-verified value (Wed 26.08 for week 30.08-05.09)', () => {
  assert.strictEqual(S.deadlineForWeek('2026-08-30', 4), '2026-08-26');
});

test('constraintDeadlinePassed: locked week is blocked, far future week is not', () => {
  const now = S.tsFor('2026-08-27', '10:00'); // "today" = Thursday 27.08
  assert.strictEqual(S.constraintDeadlinePassed('2026-09-01', 4, now), true); // inside 30.08-05.09, locked
  assert.strictEqual(S.constraintDeadlinePassed('2026-09-22', 4, now), false); // far future, open
});

test('durationHours handles overnight shifts', () => {
  assert.strictEqual(S.durationHours('21:00', '05:00'), 8);
  assert.strictEqual(S.durationHours('05:00', '13:00'), 8);
  assert.strictEqual(S.durationHours('13:00', '21:00'), 8);
});

test('generateSchedule: never double-books within 24h, fills all slots when adequately staffed', () => {
  const meta = { minRestHours: 24, nightStart: '22:00', nightEnd: '06:00', shabbatStartDay: 5, shabbatStartTime: '16:00', shabbatEndDay: 6, shabbatEndTime: '20:00', dailyOvertimeThreshold: 8 };
  const shiftTemplates = [
    { id: 'fuel-morning', roleId: 'fuel', start: '05:00', end: '13:00', needed: 3, active: true, days: [0,1,2,3,4,5,6] },
    { id: 'fuel-noon', roleId: 'fuel', start: '13:00', end: '21:00', needed: 2, active: true, days: [0,1,2,3,4,5,6] },
    { id: 'fuel-night', roleId: 'fuel', start: '21:00', end: '05:00', needed: 1, active: true, days: [0,1,2,3,4,5,6] },
  ];
  const employees = Array.from({length: 8}, (_, i) => ({ id: 'e' + i, name: 'E' + i, roleId: 'fuel', active: true }));
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] });
  assert.strictEqual(result.understaffed.length, 0, 'fully staffed with 8 employees for 6 daily slots');
  // verify no employee has two shifts starting within 24h of each other
  const byEmp = {};
  result.assignments.forEach(a => { (byEmp[a.employeeId] = byEmp[a.employeeId] || []).push(a); });
  const templatesById = Object.fromEntries(shiftTemplates.map(t => [t.id, t]));
  Object.values(byEmp).forEach(list => {
    const starts = list.map(a => S.shiftStartTs(a, templatesById)).sort((a,b)=>a-b);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i-1] >= 24*3600000, 'rest violation: ' + (starts[i]-starts[i-1])/3600000 + 'h');
    }
  });
  assert.strictEqual(result.assignments.length, 7 * 6); // 7 days * 6 daily slots
});

test('generateSchedule: understaffed slots are reported, never force-filled in violation of rest rule', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-morning', roleId: 'fuel', start: '05:00', end: '13:00', needed: 3, active: true, days: [0,1,2,3,4,5,6] },
  ];
  const employees = [{ id: 'e0', name: 'E0', roleId: 'fuel', active: true }]; // only 1 employee for 3 needed
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] });
  assert.strictEqual(result.understaffed.length, 7); // every day short by 2
  result.understaffed.forEach(u => assert.strictEqual(u.missing, 2));
  assert.strictEqual(result.assignments.length, 7); // one shift per day for the single employee
});

test('generateSchedule respects cross-week prior assignments for the 24h rule', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-night', roleId: 'fuel', start: '21:00', end: '05:00', needed: 1, active: true, days: [0] }, // Sunday only
  ];
  const employees = [{ id: 'e0', name: 'E0', roleId: 'fuel', active: true }];
  const templatesById = { 'fuel-night': shiftTemplates[0] };
  // prior week's Saturday 21:00 shift for e0 -> next week's Sunday 21:00 shift is exactly 24h later (OK)
  const priorAssignments = [{ date: '2026-08-29', shiftTemplateId: 'fuel-night', employeeId: 'e0' }]
    .map(a => Object.assign({}, a, { _startTs: S.shiftStartTs(a, templatesById) }));
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments });
  assert.strictEqual(result.assignments.length, 1); // exactly 24h gap is allowed
});

test('generateSchedule skips autoAssign:false templates entirely — never filled, never reported understaffed', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'store-morning', roleId: 'store', start: '06:00', end: '13:00', needed: 1, active: true, days: [0,1,2,3,4,5,6], autoAssign: false },
    { id: 'store-noon', roleId: 'store', start: '13:00', end: '21:00', needed: 1, active: true, days: [0,1,2,3,4,5,6] },
  ];
  const employees = [{ id: 'e0', name: 'E0', roleId: 'store', active: true }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] });
  assert.ok(!result.assignments.some(a => a.shiftTemplateId === 'store-morning'), 'manual-only template must never be auto-filled');
  assert.ok(!result.understaffed.some(u => u.shiftTemplateId === 'store-morning'), 'manual-only template must never be flagged understaffed');
  assert.strictEqual(result.assignments.filter(a => a.shiftTemplateId === 'store-noon').length, 7, 'the auto-assign template still gets filled normally');
});

test('generateSchedule only applies a Saturday-only template (days:[6]) on Saturday', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-sat-mid', roleId: 'fuel', start: '09:00', end: '21:00', needed: 1, active: true, days: [6] },
  ];
  const employees = [{ id: 'e0', name: 'E0', roleId: 'fuel', active: true }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] }); // week of Sun 2026-08-30
  assert.strictEqual(result.assignments.length, 1);
  assert.strictEqual(result.assignments[0].date, '2026-09-05'); // the Saturday of that week
});

test('computeMonthlyHours buckets sum to total and shabbat/night take priority', () => {
  const meta = { nightStart: '22:00', nightEnd: '06:00', shabbatStartDay: 5, shabbatStartTime: '16:00', shabbatEndDay: 6, shabbatEndTime: '20:00', dailyOvertimeThreshold: 8 };
  const templatesById = { 'fuel-night': { id: 'fuel-night', start: '21:00', end: '05:00' } };
  // Friday night shift 21:00-05:00 straddles shabbat start (16:00 Fri) and night window
  const assignments = [{ date: '2026-08-28', shiftTemplateId: 'fuel-night', employeeId: 'e0', noShow: false }]; // Friday
  const result = S.computeMonthlyHours('2026-08', assignments, templatesById, meta);
  const b = result['e0'];
  assert.ok(Math.abs(b.total - 8) < 0.01);
  assert.ok(b.shabbat > 0, 'expected some shabbat hours for a Friday night shift');
});

console.log('All schedule.test.js assertions defined (run with `node --test`).');
