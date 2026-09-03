'use strict';
// Builds the "export to Excel" workbook for one generated week — one sheet per role (fuel/store),
// laid out like a weekly calendar: a row per day (Sunday..Saturday), a column per shift, so a
// manager can see the whole week at a glance instead of scrolling a long flat list. Pure data-
// shaping only; the actual .xlsx bytes come from xlsx-writer.js.
const S = require('./schedule.js');

const DOW_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const ROLE_LABELS = { fuel: 'מתדלקים', store: 'עובדי חנות' };
const UNFILLED = '— (חסר איוש)';

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

    const headerRow = ['יום', 'תאריך'].concat(roleTemplates.map((t) => t.label + ' (' + t.start + '-' + t.end + ')'));

    const dayRows = [];
    for (let d = 0; d < 7; d++) {
      const ds = S.addDays(weekStart, d);
      const dow = S.dowOf(ds);
      const row = [DOW_NAMES_HE[dow], fmtDateDDMMYYYY(ds)];
      roleTemplates.forEach((t) => {
        if (t.days.indexOf(dow) === -1) {
          row.push(''); // this shift doesn't run on this day at all
          return;
        }
        const assigned = assignments.filter((a) => a.date === ds && a.shiftTemplateId === t.id);
        if (!assigned.length) {
          row.push(UNFILLED);
          return;
        }
        const names = assigned
          .map((a) => (employeesById[a.employeeId] ? employeesById[a.employeeId].name : '?'))
          .sort((a, b) => a.localeCompare(b, 'he'));
        row.push(names.join(', '));
      });
      dayRows.push(row);
    }

    return {
      name: ROLE_LABELS[roleId],
      rows: [[(companyName || 'תמרה') + ' — לוז שבועי — ' + ROLE_LABELS[roleId] + ' — שבוע ' + rangeLabel], headerRow, ...dayRows],
      colWidths: [10, 12].concat(roleTemplates.map(() => 24)),
    };
  });
}

module.exports = { buildScheduleSheets, weekRangeLabel, fmtDateDDMMYYYY };
