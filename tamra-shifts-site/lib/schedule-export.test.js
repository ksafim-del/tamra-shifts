'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { buildScheduleSheets, weekRangeLabel, fmtDateDDMMYYYY } = require('./schedule-export.js');

const TEMPLATES = [
  { id: 't-fuel-morning', roleId: 'fuel', label: 'בוקר מתדלקים', start: '06:00', end: '14:00', needed: 1, days: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 't-fuel-night', roleId: 'fuel', label: 'לילה מתדלקים', start: '22:00', end: '06:00', needed: 1, days: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 't-store-morning', roleId: 'store', label: 'בוקר חנות', start: '06:00', end: '13:00', needed: 1, days: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 't-inactive', roleId: 'fuel', label: 'לא פעיל', start: '01:00', end: '02:00', needed: 1, days: [0], active: false },
];

const EMPLOYEES = [
  { id: 'e1', name: 'דני כהן' },
  { id: 'e2', name: 'אבי לוי' },
];

test('fmtDateDDMMYYYY / weekRangeLabel format dates as d.m.yyyy', () => {
  assert.strictEqual(fmtDateDDMMYYYY('2026-08-30'), '30.08.2026');
  assert.strictEqual(weekRangeLabel('2026-08-30'), '30.08.2026–05.09.2026');
});

test('buildScheduleSheets produces one sheet per role with title + header + day rows', () => {
  const assignments = [
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e1' },
  ];
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, assignments, 'תמרה דלקים (96) בע"מ');

  assert.strictEqual(sheets.length, 2);
  assert.strictEqual(sheets[0].name, 'מתדלקים');
  assert.strictEqual(sheets[1].name, 'עובדי חנות');
  assert.deepStrictEqual(sheets[0].colWidths, [10, 12, 22, 14, 20]);

  // row 0 = title, row 1 = header, row 2+ = data
  assert.ok(sheets[0].rows[0][0].includes('תמרה דלקים'));
  assert.ok(sheets[0].rows[0][0].includes('מתדלקים'));
  assert.deepStrictEqual(sheets[0].rows[1], ['יום', 'תאריך', 'משמרת', 'שעות', 'עובד/ת']);

  // Sunday 30.08 fuel-morning has an assignment -> employee name row
  const sundayMorningRow = sheets[0].rows.find((r) => r[1] === '30.08.2026' && r[2] === 'בוקר מתדלקים');
  assert.deepStrictEqual(sundayMorningRow, ['ראשון', '30.08.2026', 'בוקר מתדלקים', '06:00-14:00', 'דני כהן']);

  // Sunday 30.08 fuel-night has no assignment -> placeholder row
  const sundayNightRow = sheets[0].rows.find((r) => r[1] === '30.08.2026' && r[2] === 'לילה מתדלקים');
  assert.deepStrictEqual(sundayNightRow, ['ראשון', '30.08.2026', 'לילה מתדלקים', '22:00-06:00', '— (חסר איוש)']);

  // inactive template must not appear anywhere
  assert.ok(!sheets[0].rows.some((r) => r[2] === 'לא פעיל'));

  // store sheet still lists its own unfilled shift as a placeholder row
  const storeRow = sheets[1].rows.find((r) => r[1] === '30.08.2026' && r[2] === 'בוקר חנות');
  assert.deepStrictEqual(storeRow, ['ראשון', '30.08.2026', 'בוקר חנות', '06:00-13:00', '— (חסר איוש)']);
});

test('buildScheduleSheets sorts multiple employees on the same shift by Hebrew name, and unknown employee ids fall back to "?"', () => {
  const assignments = [
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e2' }, // אבי לוי
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e1' }, // דני כהן
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'ghost' }, // no matching employee
  ];
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, assignments, 'תמרה');
  const rows = sheets[0].rows.filter((r) => r[1] === '30.08.2026' && r[2] === 'בוקר מתדלקים');
  assert.strictEqual(rows.length, 3);
  const names = rows.map((r) => r[4]).sort((a, b) => a.localeCompare(b, 'he'));
  // Hebrew locale-aware sort: אבי before דני; just confirm both real names are present alongside the "?" fallback
  assert.deepStrictEqual(names.slice().sort(), ['?', 'אבי לוי', 'דני כהן'].slice().sort());
  assert.ok(rows.some((r) => r[4] === 'אבי לוי') && rows.some((r) => r[4] === 'דני כהן') && rows.some((r) => r[4] === '?'));
  // real employee names remain in Hebrew-locale order relative to each other
  const realNamesOnly = rows.map((r) => r[4]).filter((n) => n !== '?');
  assert.deepStrictEqual(realNamesOnly, ['אבי לוי', 'דני כהן']);
});

test('buildScheduleSheets falls back to "תמרה" when companyName is missing', () => {
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, [], undefined);
  assert.ok(sheets[0].rows[0][0].startsWith('תמרה —'));
});
