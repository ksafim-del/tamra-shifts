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

/* ---------- per-employee rules set by the manager ---------- */
// A night shift = one whose time-of-day bucket is 'night' (starts 17:00 or later, and isn't a
// long "ביניים" shift).
function isNightTemplate(template) { return !!template && timeBucketOf(template) === 'night'; }
// The exact number of shifts per week the manager set for this employee (1-7), or null for
// "flexible" (no fixed number — shifts are shared out fairly by hours instead). Anything outside
// 1-7 (e.g. an old leftover value) counts as flexible — same rule as the screen uses.
function shiftTarget(employee) {
  const n = Number(employee && employee.maxShiftsPerWeek);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
}

/* ---------- schedule generation (weekly: Sunday-Saturday) ---------- */
// The generator makes several differently-shuffled attempts and keeps the best one — a single
// pass sometimes can't give everybody their exact number of shifts. Bounded both by a number of
// attempts and by wall-clock time, so generating a week never holds the server up for long.
const GENERATION_ATTEMPTS = 40;
const GENERATION_TIME_BUDGET_MS = 1500;
const CHAIN_SEARCH_BUDGET = 3000; // rule checks one repair search may spend before giving up

/**
 * @param {string} weekStart Sunday YYYY-MM-DD
 * @param {object} data { employees, shiftTemplates, availability, meta, priorAssignments, followingAssignments, fixedAssignments }
 *   availability: this week's submitted picks, each { employeeId, date, choice }. An employee/date
 *   combination with no entry defaults to 'all' (available) — the mandatory-selection rule is
 *   enforced at submission time (the UI won't let someone send an incomplete week), not here, so a
 *   week nobody has submitted yet still generates normally instead of leaving every shift empty.
 *   priorAssignments / followingAssignments: assignments of the week before / the week after
 *   (when they exist), for the rest and night rules across the week boundary. Each must carry a
 *   precomputed _startTs (ms).
 *   fixedAssignments: this week's shifts the manager placed by hand and wants kept — they stay
 *   exactly as they are (even if they break a rule — that was the manager's call), count towards
 *   each person's number of shifts and rest/night rules, and the generator fills around them.
 *   They are NOT included in the returned `assignments` (they're already saved).
 *
 * Rules, strongest first — the generator never breaks a rule to satisfy one below it:
 *   1. hard rules: the employee's role/gender, their submitted availability, minimum rest between
 *      shifts, "night only" employees get night shifts only, and nobody works a morning/noon shift
 *      the day after a night shift;
 *   2. the number of shifts the manager set per employee (maxShiftsPerWeek) — never more, and as
 *      close to exactly that number as the rules above allow (any shortfall is reported back in
 *      quotaIssues so the manager can see who and why);
 *   3. filling every shift (whatever is still open after that is reported as understaffed);
 *   4. at least one senior fuel attendant per fuel shift;
 *   5. fairness: employees without a fixed number share the remaining shifts evenly by hours.
 */
function generateSchedule(weekStart, data) {
  const startedAt = Date.now();
  const { employees, shiftTemplates, meta } = data;
  const availability = data.availability || [];
  const outside = (data.priorAssignments || []).concat(data.followingAssignments || []);
  const fixedAssignments = data.fixedAssignments || [];
  const restMs = (meta.minRestHours || 24) * 3600000;
  const templatesById = {};
  shiftTemplates.forEach(function (t) { templatesById[t.id] = t; });
  const availByKey = {};
  availability.forEach(function (a) { availByKey[a.employeeId + '|' + a.date] = a.choice; });
  const active = employees.filter(function (e) { return e.active; });
  const targetOf = {};
  active.forEach(function (e) { targetOf[e.id] = shiftTarget(e); });

  // Every slot to fill this week, in order (day by day, then template order).
  const slots = [];
  for (let d = 0; d < 7; d++) {
    const ds = addDays(weekStart, d);
    const dow = dowOf(ds);
    shiftTemplates.filter(function (t) { return t.active && t.days.indexOf(dow) !== -1 && t.autoAssign !== false; })
      .forEach(function (t) {
        slots.push({ ds: ds, t: t, bucket: timeBucketOf(t), night: isNightTemplate(t), start: tsFor(ds, t.start), prevDay: addDays(ds, -1), nextDay: addDays(ds, 1) });
      });
  }
  // Who could ever take each slot, ignoring the rules that depend on other assignments.
  function staticallyEligible(e, slot) {
    if (e.roleId !== slot.t.roleId) return false;
    if (slot.t.requiredGender && e.gender !== slot.t.requiredGender) return false;
    if (e.nightOnly && !slot.night) return false;
    const choice = availByKey[e.id + '|' + slot.ds];
    return isAvailableForShift(choice === undefined ? 'all' : choice, slot.bucket);
  }
  const eligibleBySlot = slots.map(function (slot) { return active.filter(function (e) { return staticallyEligible(e, slot); }); });
  const eligibleSet = eligibleBySlot.map(function (list) { const set = {}; list.forEach(function (e) { set[e.id] = true; }); return set; });
  // remainingFrom[empId][i] = how many slots from index i onward this employee could take at all
  const remainingFrom = {};
  active.forEach(function (e) {
    const arr = new Array(slots.length + 1).fill(0);
    for (let i = slots.length - 1; i >= 0; i--) arr[i] = arr[i + 1] + (eligibleSet[i][e.id] ? 1 : 0);
    remainingFrom[e.id] = arr;
  });
  // The manager's kept shifts: those on a slot the generator fills are pinned onto that slot;
  // any other (e.g. on a manual-only shift type) still counts for rest/night rules and the
  // person's number of shifts.
  const fixedBySlot = slots.map(function () { return []; });
  const fixedOutsideCount = {};
  const activeById = {};
  active.forEach(function (e) { activeById[e.id] = e; });
  fixedAssignments.forEach(function (a) {
    const e = activeById[a.employeeId];
    if (!e) return;
    const i = slots.findIndex(function (s) { return s.ds === a.date && s.t.id === a.shiftTemplateId; });
    if (i !== -1 && fixedBySlot[i].indexOf(e) === -1) { fixedBySlot[i].push(e); return; }
    const t = templatesById[a.shiftTemplateId];
    if (t) outside.push({ employeeId: e.id, date: a.date, shiftTemplateId: t.id, _startTs: tsFor(a.date, t.start) });
    fixedOutsideCount[e.id] = (fixedOutsideCount[e.id] || 0) + 1;
  });
  function isFixed(e, i) { return fixedBySlot[i].indexOf(e) !== -1; }

  // The neighbouring weeks: shift start times, night dates (last week) and day-shift dates (next week).
  const outsideStarts = {}, outsideNightDates = {}, outsideDayDates = {};
  outside.forEach(function (a) {
    const t = templatesById[a.shiftTemplateId];
    (outsideStarts[a.employeeId] = outsideStarts[a.employeeId] || []).push(a._startTs);
    if (!t) return;
    if (isNightTemplate(t)) (outsideNightDates[a.employeeId] = outsideNightDates[a.employeeId] || {})[a.date] = true;
    else (outsideDayDates[a.employeeId] = outsideDayDates[a.employeeId] || {})[a.date] = true;
  });

  // A simple lower bound on how short of their set numbers people must end up (by role: more
  // shifts promised than exist; by person: fewer days they could work than promised) — once an
  // attempt reaches it, more attempts can't improve on that.
  const quotaLowerBound = (function () {
    let total = 0;
    ['fuel', 'store'].concat(Array.from(new Set(active.map(function (e) { return e.roleId; })))).filter(function (r, i, arr) { return arr.indexOf(r) === i; }).forEach(function (roleId) {
      const capacity = slots.filter(function (s) { return s.t.roleId === roleId; }).reduce(function (sum, s) { return sum + s.t.needed; }, 0);
      const people = active.filter(function (e) { return e.roleId === roleId && targetOf[e.id] != null; });
      const promised = people.reduce(function (sum, e) { return sum + targetOf[e.id]; }, 0);
      let perPerson = 0;
      if (restMs > 16 * 3600000) { // with more than 16h rest, at most one shift per calendar day
        people.forEach(function (e) {
          const days = {};
          slots.forEach(function (s, i) { if (eligibleSet[i][e.id]) days[s.ds] = true; });
          perPerson += Math.max(0, targetOf[e.id] - Object.keys(days).length);
        });
      }
      total += Math.max(promised - capacity, perPerson, 0);
    });
    return total;
  })();

  function attempt(run, deadline) {
    const bySlot = slots.map(function () { return []; });
    const slotsOf = {}, hoursTally = {}, countByEmp = {};
    active.forEach(function (e) { hoursTally[e.id] = 0; countByEmp[e.id] = fixedOutsideCount[e.id] || 0; slotsOf[e.id] = []; });
    let checks = 0; // rule checks spent by the current repair search

    function tieBreak(slot, e) { return seededRandom(slot.ds + slot.t.id + e.id + (run ? '#' + run : '')); }
    function place(e, i) {
      bySlot[i].push(e); slotsOf[e.id].push(i);
      hoursTally[e.id] += durationHours(slots[i].t.start, slots[i].t.end); countByEmp[e.id] += 1;
    }
    function unplace(e, i) {
      bySlot[i] = bySlot[i].filter(function (x) { return x !== e; });
      slotsOf[e.id] = slotsOf[e.id].filter(function (x) { return x !== i; });
      hoursTally[e.id] -= durationHours(slots[i].t.start, slots[i].t.end); countByEmp[e.id] -= 1;
    }
    // The single source of truth for "could e work slot i right now" (optionally pretending e is
    // not on slot `ignoring`) — used by both the first pass and the repair moves, so every rule is
    // applied identically everywhere: eligibility, the set number of shifts, minimum rest, and the
    // after-night rule in both directions (including the neighbouring weeks).
    function canTake(e, i, ignoring) {
      checks++;
      const slot = slots[i];
      if (!eligibleSet[i][e.id] || bySlot[i].indexOf(e) !== -1) return false;
      const target = targetOf[e.id];
      if (target != null && countByEmp[e.id] - (ignoring != null ? 1 : 0) >= target) return false;
      if (!slot.night && outsideNightDates[e.id] && outsideNightDates[e.id][slot.prevDay]) return false;
      if (slot.night && outsideDayDates[e.id] && outsideDayDates[e.id][slot.nextDay]) return false;
      const ext = outsideStarts[e.id];
      if (ext) { for (let k = 0; k < ext.length; k++) if (Math.abs(slot.start - ext[k]) < restMs) return false; }
      const mine = slotsOf[e.id];
      for (let k = 0; k < mine.length; k++) {
        const j = mine[k];
        if (j === ignoring) continue;
        const o = slots[j];
        if (Math.abs(slot.start - o.start) < restMs) return false;
        if (!slot.night && o.night && o.ds === slot.prevDay) return false; // day shift right after a night
        if (slot.night && !o.night && o.ds === slot.nextDay) return false; // night right before a day shift
      }
      return true;
    }

    // the manager's kept shifts go in first, exactly as they are
    fixedBySlot.forEach(function (list, i) { list.forEach(function (e) { place(e, i); }); });

    // ---- first pass: fill the week slot by slot ----
    slots.forEach(function (slot, i) {
      const need = Math.max(0, slot.t.needed - bySlot[i].length);
      const pool = eligibleBySlot[i].filter(function (e) { return canTake(e, i); });
      // Who gets the slot: first anyone still short of the number of shifts the manager set for
      // them — the one with the fewest spare opportunities left goes first, since they're the
      // hardest to satisfy later — then everyone else, fewest hours first.
      const keys = {};
      pool.forEach(function (e) {
        const target = targetOf[e.id];
        keys[e.id] = target != null
          ? [0, remainingFrom[e.id][i] - (target - countByEmp[e.id]) + (run ? tieBreak(slot, e) * 2 : 0), tieBreak(slot, e)]
          : [1, hoursTally[e.id], tieBreak(slot, e)];
      });
      pool.sort(function (a, b) { return compareScores(keys[a.id], keys[b.id]); });
      const chosen = pool.slice(0, need);
      // Every fuel shift must have at least one "מתדלק ותיק" (senior fuel attendant) on it. If the
      // pick above didn't include one but a senior was available further down the pool, swap them
      // in — replacing, preferably, someone without a fixed number of shifts (so nobody's set
      // number is put at risk), the one with the most hours so far.
      if (slot.t.roleId === 'fuel' && chosen.length > 0 && !chosen.concat(bySlot[i]).some(function (e) { return e.isSenior; })) {
        const seniorCandidate = pool.slice(need).find(function (e) { return e.isSenior; });
        if (seniorCandidate) {
          let swapOutIdx = 0;
          for (let k = 1; k < chosen.length; k++) {
            const a = chosen[k], b = chosen[swapOutIdx];
            const aFlex = targetOf[a.id] == null, bFlex = targetOf[b.id] == null;
            if ((aFlex && !bFlex) || (aFlex === bFlex && hoursTally[a.id] > hoursTally[b.id])) swapOutIdx = k;
          }
          chosen[swapOutIdx] = seniorCandidate;
        }
      }
      chosen.forEach(function (e) { place(e, i); });
    });

    // ---- repair: the first pass can paint itself into a corner (someone used up early in the
    // week was the only one who could have helped later). Fix what it can, one safe move at a
    // time — every move strictly reduces the shortfall, so this always ends. ----
    function hasRoom(i) { return bySlot[i].length < slots[i].t.needed; }
    function flexHolderOf(i, seenEmps) { return bySlot[i].find(function (y) { return targetOf[y.id] == null && !isFixed(y, i) && !(seenEmps && seenEmps[y.id]); }); }
    // A chain of moves ending in a free spot: e takes slot A; whoever had A (with a set number of
    // their own) moves to slot B; ... until someone lands in an open slot or bumps an employee
    // without a set number. Limited depth and a budget of rule checks.
    function findChain(emp, from, depth, seenSlots, seenEmps) {
      seenEmps[emp.id] = true;
      const ign = from == null ? undefined : from;
      const takeable = [];
      for (let i = 0; i < slots.length; i++) {
        if (checks > CHAIN_SEARCH_BUDGET) return null;
        if (seenSlots[i] || !canTake(emp, i, ign)) continue;
        if (hasRoom(i)) return [{ emp: emp, from: from, to: i }];
        const flex = flexHolderOf(i, seenEmps);
        if (flex) return [{ emp: emp, from: from, to: i, bump: flex }];
        takeable.push(i);
      }
      if (depth <= 0) return null;
      for (const i of takeable) {
        for (const x of bySlot[i]) {
          if (seenEmps[x.id] || isFixed(x, i)) continue;
          const nextSeen = Object.assign({}, seenSlots); nextSeen[i] = true;
          const sub = findChain(x, i, depth - 1, nextSeen, Object.assign({}, seenEmps));
          if (sub) return sub.concat([{ emp: emp, from: from, to: i }]);
          if (checks > CHAIN_SEARCH_BUDGET) return null;
        }
      }
      return null;
    }
    function applyChain(plan) {
      plan.forEach(function (m) {
        if (m.from != null) unplace(m.emp, m.from);
        if (m.bump) unplace(m.bump, m.to);
        place(m.emp, m.to);
      });
    }
    // Move one of e's own shifts elsewhere if that frees room (e.g. a rest window) for one more.
    function relocateForOneMore(e) {
      for (const k of slotsOf[e.id].slice()) {
        if (isFixed(e, k)) continue; // the manager's kept shifts never move
        for (let k2 = 0; k2 < slots.length; k2++) {
          if (checks > CHAIN_SEARCH_BUDGET) return false;
          if (k2 === k || !canTake(e, k2, k)) continue;
          const holder2 = hasRoom(k2) ? null : flexHolderOf(k2);
          if (!hasRoom(k2) && !holder2) continue;
          unplace(e, k);
          if (holder2) unplace(holder2, k2);
          place(e, k2);
          for (let i = 0; i < slots.length; i++) {
            if (!canTake(e, i)) continue;
            const holder = hasRoom(i) ? null : flexHolderOf(i);
            if (hasRoom(i) || holder) { if (holder) unplace(holder, i); place(e, i); return true; }
          }
          // didn't help — put everything back exactly as it was
          unplace(e, k2);
          if (holder2) place(holder2, k2);
          place(e, k);
        }
      }
      return false;
    }
    // Phase 1: get people up to their set numbers. Someone whose search failed isn't searched
    // again until some other move has changed the picture.
    let failed = {};
    for (let guard = 0; guard < 1000; guard++) {
      if (run > 0 && Date.now() > deadline) break;
      const e = active.find(function (x) { return targetOf[x.id] != null && countByEmp[x.id] < targetOf[x.id] && !failed[x.id]; });
      if (!e) break;
      checks = 0;
      const plan = findChain(e, null, 3, {}, {});
      if (plan) { applyChain(plan); failed = {}; continue; }
      checks = 0;
      if (relocateForOneMore(e)) { failed = {}; continue; }
      failed[e.id] = true;
    }
    // Phase 2: fill whatever is still open with anyone who can legally take it.
    slots.forEach(function (slot, i) {
      while (hasRoom(i)) {
        const cand = eligibleBySlot[i].filter(function (e) { return canTake(e, i); })
          .sort(function (a, b) { return hoursTally[a.id] - hoursTally[b.id] || tieBreak(slot, a) - tieBreak(slot, b); })[0];
        if (!cand) break;
        place(cand, i);
      }
    });

    // ---- final tallies ----
    const assignments = [], understaffed = [], seniorIssues = [], quotaIssues = [];
    slots.forEach(function (slot, i) {
      const here = bySlot[i];
      here.forEach(function (e) { if (!isFixed(e, i)) assignments.push({ date: slot.ds, shiftTemplateId: slot.t.id, employeeId: e.id, noShow: false }); });
      if (here.length < slot.t.needed) understaffed.push({ date: slot.ds, shiftTemplateId: slot.t.id, missing: slot.t.needed - here.length });
      // Staffed but with no senior at all (none was available) — a real gap, but a different one
      // than being short-handed, so it's tracked and surfaced separately.
      if (slot.t.roleId === 'fuel' && here.length > 0 && !here.some(function (e) { return e.isSenior; })) seniorIssues.push({ date: slot.ds, shiftTemplateId: slot.t.id });
    });
    active.forEach(function (e) {
      const target = targetOf[e.id];
      if (target != null && countByEmp[e.id] < target) quotaIssues.push({ employeeId: e.id, target: target, assigned: countByEmp[e.id] });
    });
    const flexHours = active.filter(function (e) { return targetOf[e.id] == null; }).map(function (e) { return hoursTally[e.id]; });
    const score = [
      quotaIssues.reduce(function (sum, q) { return sum + (q.target - q.assigned); }, 0),
      understaffed.reduce(function (sum, u) { return sum + u.missing; }, 0),
      seniorIssues.length,
      flexHours.length ? Math.max.apply(null, flexHours) - Math.min.apply(null, flexHours) : 0,
    ];
    return { assignments, understaffed, seniorIssues, quotaIssues, score };
  }

  const deadline = startedAt + GENERATION_TIME_BUDGET_MS;
  let best = null;
  for (let run = 0; run < GENERATION_ATTEMPTS; run++) {
    if (run > 0 && Date.now() > deadline) break;
    const r = attempt(run, deadline);
    if (!best || compareScores(r.score, best.score) < 0) best = r;
    if (run >= 5 && best.score[0] <= quotaLowerBound && best.score[1] === 0 && best.score[2] === 0) break; // can't do meaningfully better
    if (run >= 2 && best.score[0] <= quotaLowerBound && quotaLowerBound > 0) break; // shortfall is unavoidable; stop early
  }
  return { assignments: best.assignments, understaffed: best.understaffed, seniorIssues: best.seniorIssues, quotaIssues: best.quotaIssues, generatedAt: Date.now() };
}
function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
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
  timeBucketOf, isAvailableForShift, isNightTemplate, shiftTarget,
  SENIOR_TENURE_MONTHS, seniorEligibleByTenure, isEffectivelySenior,
  generateSchedule, computeMonthlyHours,
};
