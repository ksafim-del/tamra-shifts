'use strict';
/*
 * Pure, dependency-free scheduling & hours logic for תמרה דלקים (96) בע"מ.
 * Ported faithfully from the original client-side artifact implementation.
 * Every function here is pure (no DB, no I/O) so it can be unit-tested directly.
 */

function pad2(n) { return String(n).padStart(2, '0'); }

function dateStrOf(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

function todayStr(tz) {
  // tz: not used for real TZ conversion here; server should be run with TZ=Asia/Jerusalem
  const d = new Date();
  return dateStrOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function tsFor(dateStr, timeStr) {
  const dp = dateStr.split('-').map(Number);
  const tp = timeStr.split(':').map(Number);
  return new Date(dp[0], dp[1] - 1, dp[2], tp[0], tp[1], 0, 0).getTime();
}

function weekKeyOf(dateStr) {
  const dp = dateStr.split('-').map(Number);
  const d = new Date(dp[0], dp[1] - 1, dp[2]);
  d.setDate(d.getDate() - d.getDay());
  return dateStrOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function addDays(dateStr, delta) {
  const dp = dateStr.split('-').map(Number);
  const d = new Date(dp[0], dp[1] - 1, dp[2] + delta);
  return dateStrOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function addWeeks(weekKey, delta) { return addDays(weekKey, delta * 7); }

function dowOf(dateStr) {
  const dp = dateStr.split('-').map(Number);
  return new Date(dp[0], dp[1] - 1, dp[2]).getDay();
}

function timeToMinutes(t) { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; }

function durationHours(start, end) {
  const s = timeToMinutes(start); let e = timeToMinutes(end);
  if (e <= s) e += 1440;
  return (e - s) / 60;
}

function nextGenerationWeek(today) {
  return addWeeks(weekKeyOf(today || todayStr()), 1);
}

function deadlineForWeek(weekStart, weeklyGenerationDow) {
  const genDow = (weeklyGenerationDow == null ? 4 : weeklyGenerationDow);
  return addDays(weekStart, genDow - 8);
}

function constraintDeadlinePassed(dateStr, weeklyGenerationDow, now) {
  const genDow = (weeklyGenerationDow == null ? 4 : weeklyGenerationDow);
  const targetWeekStart = weekKeyOf(dateStr);
  const deadlineDate = addDays(targetWeekStart, genDow - 8);
  const deadlineTs = tsFor(deadlineDate, '23:59');
  return (now == null ? Date.now() : now) > deadlineTs;
}

function seededRandom(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return (h % 10000) / 10000;
}

function shiftStartTs(a, templatesById) {
  return tsFor(a.date, templatesById[a.shiftTemplateId].start);
}
function shiftEndTs(a, templatesById) {
  const t = templatesById[a.shiftTemplateId];
  return shiftStartTs(a, templatesById) + durationHours(t.start, t.end) * 3600000;
}

/* ---------- shabbat / night windows ---------- */
function shabbatWindowFor(ts, meta) {
  const d = new Date(ts);
  const dow = d.getDay();
  const startDay = meta.shabbatStartDay == null ? 5 : meta.shabbatStartDay;
  const endDay = meta.shabbatEndDay == null ? 6 : meta.shabbatEndDay;
  let deltaToStart = startDay - dow;
  if (deltaToStart > 0) deltaToStart -= 7; // most recent occurrence at/before today
  const fri = new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaToStart);
  const [sh, sm] = (meta.shabbatStartTime || '16:00').split(':').map(Number);
  const start = new Date(fri.getFullYear(), fri.getMonth(), fri.getDate(), sh, sm, 0, 0);
  const deltaEnd = endDay - startDay >= 0 ? (endDay - startDay) : (endDay - startDay + 7);
  const sat = new Date(fri.getFullYear(), fri.getMonth(), fri.getDate() + deltaEnd);
  const [eh, em] = (meta.shabbatEndTime || '20:00').split(':').map(Number);
  sat.setHours(eh, em, 0, 0);
  if (sat.getTime() <= start.getTime()) sat.setDate(sat.getDate() + 7);
  return { start: start.getTime(), end: sat.getTime() };
}
function isInShabbat(ts, meta) {
  const w = shabbatWindowFor(ts, meta);
  if (ts >= w.start && ts < w.end) return true;
  const wPrev = shabbatWindowFor(ts - 7 * 86400000, meta);
  return ts >= wPrev.start && ts < wPrev.end;
}
function isInNightWindow(ts, meta) {
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  const ns = timeToMinutes(meta.nightStart || '22:00');
  const ne = timeToMinutes(meta.nightEnd || '06:00');
  if (ns <= ne) return mins >= ns && mins < ne;
  return mins >= ns || mins < ne;
}

/* ---------- availability (replaces the old free-form "constraints" model) ----------
 * Each employee picks one of 5 choices per day for the week being generated: 'all' (available
 * all day), 'morning', 'noon', 'night', or 'none' (can't work at all that day). Every shift
 * template is bucketed into one of those same three time-of-day windows by its start time — a
 * long "ביניים" (split/interval) shift that spans more than one window is bucketed as 'all'
 * instead, since only someone who is free the whole day can realistically cover it.
 */
function timeBucketOf(template) {
  if (template.label && template.label.indexOf('ביניים') !== -1) return 'all';
  const m = timeToMinutes(template.start);
  if (m < 720) return 'morning'; // before 12:00
  if (m < 1020) return 'noon';   // 12:00–16:59
  return 'night';                // 17:00+
}
function isAvailableForShift(choice, bucket) {
  if (!choice || choice === 'none') return false;
  if (choice === 'all') return true;
  return choice === bucket;
}

/* ---------- senior fuel attendant ("מתדלק/ת ותיק/ה") tenure auto-promotion ----------
 * A fuel attendant automatically becomes "senior" once they've been registered in the system
 * for more than two months, regardless of the manual isSenior flag. isEffectivelySenior()
 * combines the manual flag with this tenure rule; it is the single source of truth used both
 * for schedule generation and for anything displaying the badge.
 */
const SENIOR_TENURE_MONTHS = 2;
function seniorEligibleByTenure(createdAt, now) {
  if (!createdAt) return false;
  const d = new Date(createdAt);
  d.setMonth(d.getMonth() + SENIOR_TENURE_MONTHS);
  return (now == null ? Date.now() : now) >= d.getTime();
}
function isEffectivelySenior(employee, now) {
  if (!employee) return false;
  if (employee.isSeniorManual) return true;
  if (employee.roleId !== 'fuel') return false;
  return seniorEligibleByTenure(employee.createdAt, now);
}

/* ---------- scheduling constraints (legacy — kept for backward compatibility with any
 * still-stored data and the pure deadline helper below, but no longer used by generateSchedule,
 * which now runs on the availability model above) ---------- */
function isBlocked(employeeId, dateStr, start, end, constraints) {
  const dow = dowOf(dateStr);
  let sMin = timeToMinutes(start), eMin = timeToMinutes(end);
  if (eMin <= sMin) eMin += 1440;
  return constraints.some(function (c) {
    if (c.employeeId !== employeeId) return false;
    if (c.kind === 'date' && c.date === dateStr) {
      if (c.allDay) return true;
      let cs = timeToMinutes(c.start), ce = timeToMinutes(c.end);
      if (ce <= cs) ce += 1440;
      return sMin < ce && cs < eMin;
    }
    if (c.kind === 'recurring' && c.dayOfWeek === dow) {
      if (c.allDay) return true;
      let cs2 = timeToMinutes(c.start), ce2 = timeToMinutes(c.end);
      if (ce2 <= cs2) ce2 += 1440;
      return sMin < ce2 && cs2 < eMin;
    }
    return false;
  });
}

function hasRestConflict(employeeId, dateStr, start, minRestHours, existingAssignments) {
  const restMs = (minRestHours || 24) * 3600000;
  const candStart = tsFor(dateStr, start);
  return existingAssignments.some(function (a) {
    if (a.employeeId !== employeeId) return false;
    return Math.abs(candStart - a._startTs) < restMs;
  });
}

/* ---------- schedule generation (weekly: Sunday-Saturday) ---------- */
/**
 * @param {string} weekStart Sunday YYYY-MM-DD
 * @param {object} data { employees, shiftTemplates, availability, meta, priorAssignments }
 *   availability: this week's submitted picks, each { employeeId, date, choice }. An employee/date
 *   combination with no entry defaults to 'all' (available) — the mandatory-selection rule is
 *   enforced at submission time (the UI won't let someone send an incomplete week), not here, so a
 *   week nobody has submitted yet still generates normally instead of leaving every shift empty.
 *   priorAssignments: assignments from the week before (for cross-week 24h rest checks), each
 *   must carry a precomputed _startTs (ms) — pass raw assignments through withStartTs() first.
 */
function generateSchedule(weekStart, data) {
  const { employees, shiftTemplates, meta } = data;
  const availability = data.availability || [];
  const priorAssignments = data.priorAssignments || [];
  const templatesById = {};
  shiftTemplates.forEach(function (t) { templatesById[t.id] = t; });
  const availByKey = {};
  availability.forEach(function (a) { availByKey[a.employeeId + '|' + a.date] = a.choice; });

  const assignments = [];
  const understaffed = [];
  const seniorIssues = [];
  const hoursTally = {};
  employees.filter(function (e) { return e.active; }).forEach(function (e) { hoursTally[e.id] = 0; });

  for (let d = 0; d < 7; d++) {
    const ds = addDays(weekStart, d);
    const dow = dowOf(ds);
    const templates = shiftTemplates.filter(function (t) { return t.active && t.days.indexOf(dow) !== -1 && t.autoAssign !== false; });
    templates.forEach(function (t) {
      const need = t.needed;
      const bucket = timeBucketOf(t);
      const restCheckPool = priorAssignments.concat(assignments.map(function (a) {
        return Object.assign({}, a, { _startTs: tsFor(a.date, templatesById[a.shiftTemplateId].start) });
      }));
      let pool = employees.filter(function (e) { return e.active && e.roleId === t.roleId; });
      if (t.requiredGender) pool = pool.filter(function (e) { return e.gender === t.requiredGender; });
      pool = pool.filter(function (e) {
        const choice = availByKey[e.id + '|' + ds];
        return isAvailableForShift(choice === undefined ? 'all' : choice, bucket);
      });
      pool = pool.filter(function (e) { return !hasRestConflict(e.id, ds, t.start, meta.minRestHours, restCheckPool); });
      pool = pool.filter(function (e) {
        if (!e.maxShiftsPerWeek) return true;
        const cnt = assignments.filter(function (a) { return a.employeeId === e.id; }).length;
        return cnt < e.maxShiftsPerWeek;
      });
      pool.sort(function (a, b) {
        const diff = hoursTally[a.id] - hoursTally[b.id];
        if (diff !== 0) return diff;
        return seededRandom(ds + t.id + a.id) - seededRandom(ds + t.id + b.id);
      });
      const chosen = pool.slice(0, need);
      // Every fuel shift must have at least one "מתדלק ותיק" (senior fuel attendant) on it. If the
      // fair hours-balanced pick above didn't happen to include one but a senior was available
      // further down the pool, swap them in for the chosen employee with the most hours so far —
      // keeps the fairness rule intact for everyone else while still satisfying the requirement
      // whenever it's actually possible to.
      if (t.roleId === 'fuel' && chosen.length > 0 && !chosen.some(function (e) { return e.isSenior; })) {
        const seniorCandidate = pool.slice(need).find(function (e) { return e.isSenior; });
        if (seniorCandidate) {
          let swapOutIdx = 0;
          for (let i = 1; i < chosen.length; i++) {
            if (hoursTally[chosen[i].id] > hoursTally[chosen[swapOutIdx].id]) swapOutIdx = i;
          }
          chosen[swapOutIdx] = seniorCandidate;
        }
      }
      chosen.forEach(function (e) {
        assignments.push({ date: ds, shiftTemplateId: t.id, employeeId: e.id, noShow: false });
        hoursTally[e.id] += durationHours(t.start, t.end);
      });
      if (chosen.length < need) {
        understaffed.push({ date: ds, shiftTemplateId: t.id, missing: need - chosen.length });
      }
      // Staffed but with no senior at all (none was available in the pool) — a real gap, but a
      // different one than being short-handed, so it's tracked and surfaced separately.
      if (t.roleId === 'fuel' && chosen.length > 0 && !chosen.some(function (e) { return e.isSenior; })) {
        seniorIssues.push({ date: ds, shiftTemplateId: t.id });
      }
    });
  }
  return { assignments, understaffed, seniorIssues, generatedAt: Date.now() };
}

/**
 * @param {string} monthKey "YYYY-MM"
 * @param {Array} allAssignments assignments across all weeks, each with .date, .shiftTemplateId, .employeeId, .noShow
 * @param {object} templatesById
 * @param {object} meta
 */
function computeMonthlyHours(monthKey, allAssignments, templatesById, meta) {
  const result = {};
  const byEmp = {};
  allAssignments.forEach(function (a) {
    if (a.noShow) return;
    if (a.date.slice(0, 7) !== monthKey) return;
    (byEmp[a.employeeId] = byEmp[a.employeeId] || []).push(a);
  });
  Object.keys(byEmp).forEach(function (empId) {
    const list = byEmp[empId].slice().sort(function (a, b) {
      return shiftStartTs(a, templatesById) - shiftStartTs(b, templatesById);
    });
    const dailyCum = {};
    const buckets = { regular: 0, overtime: 0, night: 0, shabbat: 0 };
    list.forEach(function (a) {
      const startTs = shiftStartTs(a, templatesById), endTs = shiftEndTs(a, templatesById);
      const dayKey = a.date;
      let cum = dailyCum[dayKey] || 0;
      const sliceMin = 15, sliceH = sliceMin / 60;
      for (let ts = startTs; ts < endTs; ts += sliceMin * 60000) {
        let bucket;
        if (isInShabbat(ts, meta)) bucket = 'shabbat';
        else if (isInNightWindow(ts, meta)) bucket = 'night';
        else if (cum + sliceH > (meta.dailyOvertimeThreshold || 8) + 1e-9) bucket = 'overtime';
        else bucket = 'regular';
        buckets[bucket] += sliceH;
        cum += sliceH;
      }
      dailyCum[dayKey] = cum;
    });
    buckets.total = buckets.regular + buckets.overtime + buckets.night + buckets.shabbat;
    result[empId] = buckets;
  });
  return result;
}

module.exports = {
  pad2, dateStrOf, todayStr, tsFor, weekKeyOf, addDays, addWeeks, dowOf,
  timeToMinutes, durationHours, nextGenerationWeek, deadlineForWeek,
  constraintDeadlinePassed, seededRandom, shiftStartTs, shiftEndTs,
  isInShabbat, isInNightWindow, isBlocked, hasRestConflict,
  timeBucketOf, isAvailableForShift,
  SENIOR_TENURE_MONTHS, seniorEligibleByTenure, isEffectivelySenior,
  generateSchedule, computeMonthlyHours,
};
