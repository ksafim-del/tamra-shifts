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

test('timeBucketOf buckets a shift by its start time, except a "ביניים" (split) shift which always requires all-day availability', () => {
  assert.strictEqual(S.timeBucketOf({ label: 'בוקר מתדלקים', start: '05:00' }), 'morning');
  assert.strictEqual(S.timeBucketOf({ label: 'בוקר חנות', start: '06:00' }), 'morning');
  assert.strictEqual(S.timeBucketOf({ label: 'צהריים מתדלקים', start: '13:00' }), 'noon');
  assert.strictEqual(S.timeBucketOf({ label: 'לילה מתדלקים', start: '21:00' }), 'night');
  assert.strictEqual(S.timeBucketOf({ label: 'ביניים מתדלקים (שבת)', start: '09:00' }), 'all');
  assert.strictEqual(S.timeBucketOf({ label: 'ביניים חנות', start: '10:00' }), 'all');
  // boundary cases: exactly 12:00 is noon, exactly 17:00 is night
  assert.strictEqual(S.timeBucketOf({ label: 'x', start: '12:00' }), 'noon');
  assert.strictEqual(S.timeBucketOf({ label: 'x', start: '17:00' }), 'night');
});

test('isAvailableForShift: "all" covers every bucket, "none" covers nothing, a specific bucket only matches itself', () => {
  assert.strictEqual(S.isAvailableForShift('all', 'morning'), true);
  assert.strictEqual(S.isAvailableForShift('all', 'night'), true);
  assert.strictEqual(S.isAvailableForShift('none', 'morning'), false);
  assert.strictEqual(S.isAvailableForShift('morning', 'morning'), true);
  assert.strictEqual(S.isAvailableForShift('morning', 'noon'), false);
  assert.strictEqual(S.isAvailableForShift(undefined, 'morning'), false, 'an explicit missing/falsy choice is treated as unavailable by this pure function — callers default a truly-unsubmitted day to \'all\' themselves');
});

test('seniorEligibleByTenure: false before two months, true at and after exactly two months', () => {
  const hired = new Date(2026, 0, 15).getTime(); // 15.01.2026
  const oneMonthLater = new Date(2026, 1, 15).getTime();
  const almostTwoMonths = new Date(2026, 2, 14).getTime();
  const exactlyTwoMonths = new Date(2026, 2, 15).getTime();
  const wellPast = new Date(2026, 5, 1).getTime();
  assert.strictEqual(S.seniorEligibleByTenure(hired, oneMonthLater), false);
  assert.strictEqual(S.seniorEligibleByTenure(hired, almostTwoMonths), false);
  assert.strictEqual(S.seniorEligibleByTenure(hired, exactlyTwoMonths), true);
  assert.strictEqual(S.seniorEligibleByTenure(hired, wellPast), true);
  assert.strictEqual(S.seniorEligibleByTenure(null, wellPast), false, 'no createdAt at all is never tenure-eligible');
});

test('isEffectivelySenior: a manual flag always wins; tenure-based auto-promotion only ever applies to the fuel role', () => {
  const now = new Date(2026, 5, 1).getTime();
  const longAgo = new Date(2025, 0, 1).getTime();
  const recent = new Date(2026, 4, 20).getTime();
  assert.strictEqual(S.isEffectivelySenior({ isSeniorManual: true, roleId: 'store', createdAt: recent }, now), true, 'a manual flag makes anyone senior regardless of role or tenure');
  assert.strictEqual(S.isEffectivelySenior({ isSeniorManual: false, roleId: 'fuel', createdAt: longAgo }, now), true, 'a fuel attendant employed well over two months is auto-senior');
  assert.strictEqual(S.isEffectivelySenior({ isSeniorManual: false, roleId: 'fuel', createdAt: recent }, now), false, 'a fuel attendant employed under two months is not yet senior');
  assert.strictEqual(S.isEffectivelySenior({ isSeniorManual: false, roleId: 'store', createdAt: longAgo }, now), false, 'tenure alone never promotes a non-fuel employee');
  assert.strictEqual(S.isEffectivelySenior(null, now), false);
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

test('generateSchedule only assigns employees matching a template\'s requiredGender (store night = male-only)', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'store-night', roleId: 'store', start: '21:00', end: '07:00', needed: 1, active: true, days: [0,1,2,3,4,5,6], requiredGender: 'male' },
  ];
  const employees = [
    { id: 'e0', name: 'Female', roleId: 'store', active: true, gender: 'female' },
    { id: 'e1', name: 'Male', roleId: 'store', active: true, gender: 'male' },
  ];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] });
  assert.strictEqual(result.assignments.length, 7);
  assert.ok(result.assignments.every(a => a.employeeId === 'e1'), 'only the male employee should ever be chosen for the night store shift');
});

test('generateSchedule reports understaffed (not a silent skip) when requiredGender leaves nobody eligible', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'store-night', roleId: 'store', start: '21:00', end: '07:00', needed: 1, active: true, days: [0], requiredGender: 'male' },
  ];
  const employees = [{ id: 'e0', name: 'Female', roleId: 'store', active: true, gender: 'female' }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, constraints: [], meta, priorAssignments: [] });
  assert.strictEqual(result.assignments.length, 0);
  assert.strictEqual(result.understaffed.length, 1);
  assert.strictEqual(result.understaffed[0].missing, 1);
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

test('generateSchedule respects submitted availability: unavailable employees are skipped, missing submissions default to available', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-morning', label: 'בוקר מתדלקים', roleId: 'fuel', start: '05:00', end: '13:00', needed: 1, active: true, days: [0] },
  ];
  // e0 explicitly marked unavailable that morning; e1 explicitly marked available; e2 never submitted anything.
  const employees = [
    { id: 'e0', name: 'E0', roleId: 'fuel', active: true },
    { id: 'e1', name: 'E1', roleId: 'fuel', active: true },
    { id: 'e2', name: 'E2', roleId: 'fuel', active: true },
  ];
  const availability = [
    { employeeId: 'e0', date: '2026-08-30', choice: 'none' },
    { employeeId: 'e1', date: '2026-08-30', choice: 'morning' },
  ];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability, meta, priorAssignments: [] });
  const chosenIds = result.assignments.map(a => a.employeeId);
  assert.ok(!chosenIds.includes('e0'), 'explicitly unavailable employee must never be chosen');
  // e1 (explicitly available) and e2 (never submitted -> defaults to available) are both eligible;
  // needed is 1, so exactly one of them gets it — either is correct, e0 never is.
  assert.strictEqual(chosenIds.length, 1);
  assert.ok(chosenIds[0] === 'e1' || chosenIds[0] === 'e2');
});

test('generateSchedule: an availability choice outside the shift\'s time bucket excludes the employee (e.g. "morning-only" for an afternoon shift)', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-noon', label: 'צהריים מתדלקים', roleId: 'fuel', start: '13:00', end: '21:00', needed: 1, active: true, days: [0] },
  ];
  const employees = [{ id: 'e0', name: 'E0', roleId: 'fuel', active: true }];
  const availability = [{ employeeId: 'e0', date: '2026-08-30', choice: 'morning' }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability, meta, priorAssignments: [] });
  assert.strictEqual(result.assignments.length, 0);
  assert.strictEqual(result.understaffed.length, 1);
});

test('generateSchedule: a "ביניים" shift only accepts employees who marked "all day" availability, even if they picked the shift\'s own start-of-day bucket', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-beinaim', label: 'ביניים מתדלקים (שבת)', roleId: 'fuel', start: '09:00', end: '21:00', needed: 1, active: true, days: [6] },
  ];
  const employees = [
    { id: 'e0', name: 'MorningOnly', roleId: 'fuel', active: true },
    { id: 'e1', name: 'AllDay', roleId: 'fuel', active: true },
  ];
  const availability = [
    { employeeId: 'e0', date: '2026-09-05', choice: 'morning' }, // Saturday
    { employeeId: 'e1', date: '2026-09-05', choice: 'all' },
  ];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability, meta, priorAssignments: [] });
  assert.deepStrictEqual(result.assignments.map(a => a.employeeId), ['e1']);
});

test('generateSchedule: a fuel shift staffed but with no senior fuel attendant available is flagged in seniorIssues, not understaffed', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-morning', label: 'בוקר מתדלקים', roleId: 'fuel', start: '05:00', end: '13:00', needed: 1, active: true, days: [0] },
  ];
  const employees = [{ id: 'e0', name: 'Junior', roleId: 'fuel', active: true, isSenior: false }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability: [], meta, priorAssignments: [] });
  assert.strictEqual(result.assignments.length, 1, 'the shift is still filled as usual');
  assert.strictEqual(result.understaffed.length, 0, 'headcount is met, so this is not an understaffed slot');
  assert.deepStrictEqual(result.seniorIssues, [{ date: '2026-08-30', shiftTemplateId: 'fuel-morning' }]);
});

test('generateSchedule: prefers swapping in an available senior fuel attendant over a strict hours-fairness pick, when one is available', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'fuel-morning', label: 'בוקר מתדלקים', roleId: 'fuel', start: '05:00', end: '13:00', needed: 1, active: true, days: [0] },
  ];
  // e0 has fewer hours so far (would normally win the fairness sort) but isn't senior; e1 is senior.
  const employees = [
    { id: 'e0', name: 'Junior', roleId: 'fuel', active: true, isSenior: false },
    { id: 'e1', name: 'Senior', roleId: 'fuel', active: true, isSenior: true },
  ];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability: [], meta, priorAssignments: [] });
  assert.deepStrictEqual(result.assignments.map(a => a.employeeId), ['e1']);
  assert.strictEqual(result.seniorIssues.length, 0);
});

test('generateSchedule: senior-swap rule only applies to fuel shifts, never store', () => {
  const meta = { minRestHours: 24 };
  const shiftTemplates = [
    { id: 'store-morning', label: 'בוקר חנות', roleId: 'store', start: '06:00', end: '13:00', needed: 1, active: true, days: [0] },
  ];
  const employees = [{ id: 'e0', name: 'Store', roleId: 'store', active: true, isSenior: false }];
  const result = S.generateSchedule('2026-08-30', { employees, shiftTemplates, availability: [], meta, priorAssignments: [] });
  assert.strictEqual(result.assignments.length, 1);
  assert.deepStrictEqual(result.seniorIssues, [], 'the senior requirement is fuel-only');
});

console.log('All schedule.test.js assertions defined (run with `node --test`).');
