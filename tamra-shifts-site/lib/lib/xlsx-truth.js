'use strict';
const assert = require('node:assert');
const test = require('node:test');
const { parseTruthWorkbook, normalizeName } = require('./xlsx-truth.js');
const { buildFakeWorkbook, sampleRows } = require('./test-helpers/xlsx-fixture.js');

test('parseTruthWorkbook reads header-mapped employee rows, skips the branch-total row, stops at the grand-total row', () => {
  const buf = buildFakeWorkbook('תצורה עשרונית', sampleRows());
  const result = parseTruthWorkbook(buf);
  assert.strictEqual(result.sheetUsed, 'תצורה עשרונית');
  assert.strictEqual(result.employees.length, 3);

  const marwa = result.employees.find((e) => e.id === '206524720');
  assert.deepStrictEqual(marwa, {
    id: '206524720', firstName: 'MARWA', fullName: 'מרווה עאבד',
    workDays: 21, totalHours: 129.72, regular: 126.2, overtimeA: 2, overtimeB: 1.52, exceptional: 0,
  });

  // branch-total row (id 999999999, empty full name) must be skipped, not counted as an employee
  assert.ok(!result.employees.find((e) => e.id === '999999999'));
  // the row after "סיכום כללי:" must never be reached
  assert.ok(!result.employees.find((e) => e.fullName === ''));
  assert.strictEqual(result.employees[result.employees.length - 1].fullName, 'עובד לא קיים באתר');
});

test('parseTruthWorkbook reads the "hours" (HH:MM) sheet just as well when that is the only sheet present', () => {
  const buf = buildFakeWorkbook('תצורת שעות', sampleRows());
  const result = parseTruthWorkbook(buf);
  assert.strictEqual(result.sheetUsed, 'תצורת שעות');
  assert.strictEqual(result.employees.length, 3);
});

test('parseTruthWorkbook throws a clear error on a file with no recognizable header row', () => {
  const buf = buildFakeWorkbook('Sheet1', [['not', 'a', 'real', 'report']]);
  assert.throws(() => parseTruthWorkbook(buf), /header_not_found/);
});

test('normalizeName strips quotes/gershayim and collapses whitespace so file names match site names', () => {
  assert.strictEqual(normalizeName('  עלי  חגאזי '), 'עלי חגאזי');
  assert.strictEqual(normalizeName('תמרה דלקים 96 בע"מ'), 'תמרה דלקים 96 בעמ');
  assert.strictEqual(normalizeName("ד'ן ג'קסון"), 'דן גקסון');
  assert.strictEqual(normalizeName(normalizeName('עלי חגאזי')), normalizeName('  עלי   חגאזי  '));
});
