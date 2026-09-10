'use strict';
// Builds the "export to Excel" workbook for one generated week — one sheet per role (fuel/store),
// laid out like a weekly calendar: a row per day (Sunday..Saturday), a column per shift, so a
// manager can see the whole week at a glance instead of scrolling a long flat list. Pure data-
// shaping only; the actual .xlsx bytes come from xlsx-writer.js.
const S = require('./schedule.js');
const { STYLES } = require('./xlsx-writer.js');

const DOW_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const ROLE_LABELS = { fuel: 'מתדלקים', store: 'עובדי חנות' };
const UNFILLED = '— חסר איוש —';
const NOT_RUNNING = '–';

function fmtDateDDMMYYYY(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return d + '.' + m + '.' + y;
}

function weekRangeLabel(weekStart) {
  return fmtDateDDMMYYYY(weekStart) + '–' + fmtDateDDMMYYYY(S.addDays(weekStart, 6));
}

/**
 * @param {string} weekStart
 * @param {Array} templates shift templates (rowToTemplate shape: id, roleId, label, start, end, needed, days, active)
 * @param {Array} employees (id, name, roleId, active, ...)
 * @param {Array} assignments this week's assignments (date, shiftTemplateId, employeeId)
 * @param {string} companyName
 * @returns {Array<{name: string, rows: Array, colWidths: number[]}>} sheets, ready for xlsx-writer's buildWorkbook
 */
function buildScheduleSheets(weekStart, templates, employees, assignments, companyName) {
  const employeesById = {};
  employees.forEach((e) => { employeesById[e.id] = e; });
  const rangeLabel = weekRangeLabel(weekStart);

  return ['fuel', 'store'].map((roleId) => {
    const roleTemplates = templates
      .filter((t) => t.active && t.roleId === roleId)
      .slice()
      .sort((a, b) => S.timeToMinutes(a.start) - S.timeToMinutes(b.start));
    const totalCols = 2 + roleTemplates.length;

    const titleRow = [(companyName || 'תמרה') + ' — לוז שבועי — ' + ROLE_LABELS[roleId] + ' — שבוע ' + rangeLabel];
    const headerRow = ['יום', 'תאריך'].concat(roleTemplates.map((t) => t.label + '\n' + t.start + '–' + t.end));

    const dayRows = [];
    const dayStyles = [];
    for (let d = 0; d < 7; d++) {
      const ds = S.addDays(weekStart, d);
      const dow = S.dowOf(ds);
      const row = [DOW_NAMES_HE[dow], fmtDateDDMMYYYY(ds)];
      const styleRow = [STYLES.daylabel, STYLES.daylabel];
      roleTemplates.forEach((t) => {
        if (t.days.indexOf(dow) === -1) {
          row.push(NOT_RUNNING); // this shift doesn't run on this day at all
          styleRow.push(STYLES.missing);
          return;
        }
        const assigned = assignments.filter((a) => a.date === ds && a.shiftTemplateId === t.id);
        if (!assigned.length) {
          row.push(UNFILLED);
          styleRow.push(STYLES.missing);
          return;
        }
        const names = assigned
          .map((a) => (employeesById[a.employeeId] ? employeesById[a.employeeId].name : '?'))
          .sort((a, b) => a.localeCompare(b, 'he'));
        row.push(names.join(', '));
        styleRow.push(STYLES.data);
      });
      dayRows.push(row);
      dayStyles.push(styleRow);
    }

    const rows = [titleRow, headerRow, ...dayRows];
    const styles = [
      [STYLES.title],
      headerRow.map(() => STYLES.header),
      ...dayStyles,
    ];
    const rowHeights = [22, 34, ...dayRows.map(() => 32)];
    const lastCol = colLettersLocal(totalCols - 1);

    return {
      name: ROLE_LABELS[roleId],
      rows: rows,
      colWidths: [10, 12].concat(roleTemplates.map(() => 24)),
      styles: styles,
      rowHeights: rowHeights,
      merges: ['A1:' + lastCol + '1'],
      freeze: { x: 2, y: 2 },
    };
  });
}

// Local copy of the 0-based-column -> letters conversion (kept tiny and dependency-free rather
// than reaching into xlsx-writer's internals for one helper).
function colLettersLocal(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { buildScheduleSheets, weekRangeLabel, fmtDateDDMMYYYY };
