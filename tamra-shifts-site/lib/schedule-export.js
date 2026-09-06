'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { buildScheduleSheets, weekRangeLabel, fmtDateDDMMYYYY } = require('./schedule-export.js');

const TEMPLATES = [
  { id: 't-fuel-morning', roleId: 'fuel', label: 'בוקר מתדלקים', start: '06:00', end: '14:00', needed: 1, days: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 't-fuel-night', roleId: 'fuel', label: 'לילה מתדלקים', start: '22:00', end: '06:00', needed: 1, days: [0, 1, 2, 3, 4, 5], active: true }, // no night shift on Saturday
  { id: 't-store-morning', roleId: 'store', label: 'בוקר חנות', start: '06:00', end: '13:00', needed: 1, days: [0, 1, 2, 3, 4, 5, 6], active: true },
  { id: 't-inactive', roleId: 'fuel', label: 'לא פעיל', start: '01:00', end: '02:00', needed: 1, days: [0], active: false },
];

const EMPLOYEES = [
  { id: 'e1', name: 'דני כהן' },
  { id: 'e2', name: 'אבי לוי' },
];

const UNFILLED_PLACEHOLDER = '— חסר איוש —';
const NOT_RUNNING_PLACEHOLDER = '–';

test('fmtDateDDMMYYYY / weekRangeLabel format dates as d.m.yyyy', () => {
  assert.strictEqual(fmtDateDDMMYYYY('2026-08-30'), '30.08.2026');
  assert.strictEqual(weekRangeLabel('2026-08-30'), '30.08.2026–05.09.2026');
});

test('buildScheduleSheets produces one calendar-style sheet per role: a row per day, a column per shift', () => {
  const assignments = [
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e1' },
  ];
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, assignments, 'תמרה דלקים (96) בע"מ');

  assert.strictEqual(sheets.length, 2);
  assert.strictEqual(sheets[0].name, 'מתדלקים');
  assert.strictEqual(sheets[1].name, 'עובדי חנות');
  // fuel sheet: יום + תאריך + 2 shift columns (inactive template excluded)
  assert.deepStrictEqual(sheets[0].colWidths, [10, 12, 24, 24]);

  // row 0 = title (merged conceptually into col A), row 1 = header, rows 2-8 = the 7 days
  assert.ok(sheets[0].rows[0][0].includes('תמרה דלקים'));
  assert.ok(sheets[0].rows[0][0].includes('מתדלקים'));
  assert.deepStrictEqual(sheets[0].rows[1], ['יום', 'תאריך', 'בוקר מתדלקים\n06:00–14:00', 'לילה מתדלקים\n22:00–06:00']);
  assert.strictEqual(sheets[0].rows.length, 2 + 7, 'title + header + one row per day of the week');

  // Sunday 30.08: morning is assigned to דני כהן, night is unfilled
  const sunday = sheets[0].rows[2];
  assert.deepStrictEqual(sunday, ['ראשון', '30.08.2026', 'דני כהן', UNFILLED_PLACEHOLDER]);

  // Saturday: fuel-night template doesn't run (day 6 not in its `days` list) -> a plain dash, not the "unfilled" placeholder
  const saturday = sheets[0].rows[8];
  assert.strictEqual(saturday[0], 'שבת');
  assert.strictEqual(saturday[3], NOT_RUNNING_PLACEHOLDER, 'a shift that does not run on this day should render as a plain dash, not the unfilled placeholder');

  // inactive template must not produce a column at all
  assert.strictEqual(sheets[0].rows[1].length, 4);

  // store sheet still lists its own unfilled shift as a placeholder cell
  const storeSunday = sheets[1].rows[2];
  assert.deepStrictEqual(storeSunday, ['ראשון', '30.08.2026', UNFILLED_PLACEHOLDER]);
});

test('buildScheduleSheets attaches styling metadata (title merge, frozen header, per-cell styles, row heights) for a clean-looking export', () => {
  const { STYLES } = require('./xlsx-writer.js');
  const assignments = [
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e1' },
  ];
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, assignments, 'תמרה');
  const fuelSheet = sheets[0];

  // title row merged across every data column, so it reads as one banner instead of a lone A1 cell
  assert.deepStrictEqual(fuelSheet.merges, ['A1:D1']);
  // day/date columns + header row frozen so they stay in view while scrolling a busy week
  assert.deepStrictEqual(fuelSheet.freeze, { x: 2, y: 2 });
  // one style id per cell, same shape as `rows`
  assert.strictEqual(fuelSheet.styles.length, fuelSheet.rows.length);
  assert.strictEqual(fuelSheet.styles[0][0], STYLES.title);
  assert.deepStrictEqual(fuelSheet.styles[1], fuelSheet.rows[1].map(() => STYLES.header));
  assert.deepStrictEqual(fuelSheet.styles[2].slice(0, 2), [STYLES.daylabel, STYLES.daylabel]);
  assert.strictEqual(fuelSheet.styles[2][2], STYLES.data, 'a filled shift cell uses the data style');
  assert.strictEqual(fuelSheet.styles[2][3], STYLES.missing, 'an unfilled shift cell uses the missing style');
  // taller rows than a default so wrapped multi-name cells and the two-line header stay readable
  assert.ok(fuelSheet.rowHeights.every((h) => h >= 22));
});

test('buildScheduleSheets joins multiple employees on the same shift/day with a comma, sorted by Hebrew name, and falls back to "?" for an unknown employee id', () => {
  const assignments = [
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e2' }, // אבי לוי
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'e1' }, // דני כהן
    { date: '2026-08-30', shiftTemplateId: 't-fuel-morning', employeeId: 'ghost' }, // no matching employee
  ];
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, assignments, 'תמרה');
  const cell = sheets[0].rows[2][2]; // Sunday, "בוקר מתדלקים" column
  // '?' sorts before Hebrew letters under the 'he' locale collator; the two real names keep their
  // Hebrew-alphabetical order relative to each other.
  assert.strictEqual(cell, '?, אבי לוי, דני כהן');
});

test('buildScheduleSheets falls back to "תמרה" when companyName is missing', () => {
  const sheets = buildScheduleSheets('2026-08-30', TEMPLATES, EMPLOYEES, [], undefined);
  assert.ok(sheets[0].rows[0][0].startsWith('תמרה —'));
});
