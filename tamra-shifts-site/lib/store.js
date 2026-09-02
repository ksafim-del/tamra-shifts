'use strict';
const crypto = require('node:crypto');

function uid() { return crypto.randomBytes(9).toString('base64url'); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_id TEXT NOT NULL,
  pin TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  max_shifts_per_week INTEGER,
  gender TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS shift_templates (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  label TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  needed INTEGER NOT NULL,
  days TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  auto_assign INTEGER NOT NULL DEFAULT 1,
  required_gender TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  week_start TEXT PRIMARY KEY,
  understaffed TEXT NOT NULL,
  generated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,
  week_start TEXT NOT NULL,
  date TEXT NOT NULL,
  shift_template_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  no_show INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_assignments_week ON assignments(week_start);
CREATE INDEX IF NOT EXISTS idx_assignments_date ON assignments(date);
CREATE INDEX IF NOT EXISTS idx_assignments_emp ON assignments(employee_id);
CREATE TABLE IF NOT EXISTS constraints (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  date TEXT,
  day_of_week INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_constraints_emp ON constraints(employee_id);
CREATE TABLE IF NOT EXISTS swap_requests (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  claimed_by TEXT,
  date TEXT,
  shift_template_id TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  employee_id TEXT,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  related_id TEXT,
  channels TEXT NOT NULL DEFAULT '["inapp"]',
  read INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_audience ON notifications(audience, employee_id);
`;

const DEFAULT_SETTINGS = {
  companyName: 'תמרה דלקים (96) בע"מ',
  managerPin: '1234',
  managerEmail: 'ksafim@tdlakim.co.il',
  nightStart: '22:00',
  nightEnd: '06:00',
  shabbatStartDay: 5,
  shabbatStartTime: '16:00',
  shabbatEndDay: 6,
  shabbatEndTime: '20:00',
  dailyOvertimeThreshold: 8,
  weeklyHoursDefault: 42,
  escalationHours: 12,
  minRestHours: 24,
  weeklyGenerationDow: 4,
};

const DEFAULT_TEMPLATES = [
  // Sunday-Friday for fuel — Saturday is covered by the three dedicated שבת templates below instead.
  { roleId: 'fuel', label: 'בוקר מתדלקים', start: '05:00', end: '13:00', needed: 3, days: [0,1,2,3,4,5] },
  { roleId: 'fuel', label: 'צהריים מתדלקים', start: '13:00', end: '21:00', needed: 2, days: [0,1,2,3,4,5] },
  { roleId: 'fuel', label: 'לילה מתדלקים', start: '21:00', end: '05:00', needed: 1, days: [0,1,2,3,4,5,6] }, // night stays the same every day, including Saturday
  { roleId: 'fuel', label: 'בוקר מתדלקים (שבת)', start: '05:00', end: '13:00', needed: 1, days: [6] },
  { roleId: 'fuel', label: 'ביניים מתדלקים (שבת)', start: '09:00', end: '21:00', needed: 1, days: [6] },
  { roleId: 'fuel', label: 'צהריים מתדלקים (שבת)', start: '13:00', end: '23:00', needed: 1, days: [6] },
  // store morning is manual-only: the slot exists so a manager can staff it by hand, but the
  // automatic weekly generator never fills it on its own (autoAssign: false).
  { roleId: 'store', label: 'בוקר חנות', start: '06:00', end: '13:00', needed: 1, days: [0,1,2,3,4,5,6], autoAssign: false },
  { roleId: 'store', label: 'צהריים חנות', start: '13:00', end: '21:00', needed: 1, days: [0,1,2,3,4,5,6] },
  // night store shift is male-only during automatic generation (physical-safety staffing rule);
  // a manager can still manually assign anyone through the "+ שיבוץ ידני" dropdown.
  { roleId: 'store', label: 'לילה חנות', start: '21:00', end: '07:00', needed: 1, days: [0,1,2,3,4,5,6], requiredGender: 'male' },
  { roleId: 'store', label: 'ביניים חנות', start: '10:00', end: '17:00', needed: 1, days: [2,6] }, // Tuesday + Saturday
  // office shifts intentionally not scheduled — see deactivateOfficeTemplates below.
];

// One-time repair for databases created before timestamp columns were widened to BIGINT
// (millisecond epoch values overflow Postgres's 32-bit INTEGER), plus later column additions.
// Safe to run every startup: each statement is a no-op once already applied, and each is
// isolated so a failure on one can't block the rest.
async function migrateTimestampColumns(db) {
  if (db.dialect !== 'postgres') return;
  const alters = [
    'ALTER TABLE employees ALTER COLUMN created_at TYPE BIGINT',
    'ALTER TABLE schedules ALTER COLUMN generated_at TYPE BIGINT',
    'ALTER TABLE constraints ALTER COLUMN created_at TYPE BIGINT',
    'ALTER TABLE swap_requests ALTER COLUMN created_at TYPE BIGINT',
    'ALTER TABLE swap_requests ALTER COLUMN resolved_at TYPE BIGINT',
    'ALTER TABLE notifications ALTER COLUMN created_at TYPE BIGINT',
    'ALTER TABLE swap_requests ADD COLUMN IF NOT EXISTS date TEXT',
    'ALTER TABLE swap_requests ADD COLUMN IF NOT EXISTS shift_template_id TEXT',
    'ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS auto_assign INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE employees ADD COLUMN IF NOT EXISTS gender TEXT',
    'ALTER TABLE shift_templates ADD COLUMN IF NOT EXISTS required_gender TEXT',
  ];
  for (const s of alters) {
    try { await db.exec(s); } catch (e) { console.warn('[migrate]', s, '->', e.message); }
  }
}

// Updates the fuel/store shift templates to the current spec on every startup, on any
// database seeded before this change (including production). Idempotent: each step only
// acts when the live data doesn't already match, so re-running it is always a no-op once
// applied — same "self-healing on startup" approach as deactivateOfficeTemplates below.
async function applyScheduleTemplateSpecV2(db) {
  const rows = await db.all('SELECT * FROM shift_templates', []);

  async function dropDay(roleId, label, dayToRemove) {
    const row = rows.find(r => r.role_id === roleId && r.label === label);
    if (!row) return;
    const days = JSON.parse(row.days);
    if (days.indexOf(dayToRemove) === -1) return;
    await db.run('UPDATE shift_templates SET days = ? WHERE id = ?', [JSON.stringify(days.filter(d => d !== dayToRemove)), row.id]);
  }
  // Saturday for fuel is now covered by the three dedicated שבת templates below instead of
  // the regular Sunday-Friday morning/afternoon templates.
  await dropDay('fuel', 'בוקר מתדלקים', 6);
  await dropDay('fuel', 'צהריים מתדלקים', 6);

  async function ensureTemplate(t) {
    if (rows.find(r => r.role_id === t.roleId && r.label === t.label)) return;
    await db.run(
      'INSERT INTO shift_templates (id, role_id, label, start_time, end_time, needed, days, active, auto_assign, required_gender) VALUES (?,?,?,?,?,?,?,1,?,?)',
      [uid(), t.roleId, t.label, t.start, t.end, t.needed, JSON.stringify(t.days), t.autoAssign === false ? 0 : 1, t.requiredGender || null]
    );
  }
  await ensureTemplate({ roleId: 'fuel', label: 'בוקר מתדלקים (שבת)', start: '05:00', end: '13:00', needed: 1, days: [6] });
  await ensureTemplate({ roleId: 'fuel', label: 'ביניים מתדלקים (שבת)', start: '09:00', end: '21:00', needed: 1, days: [6] });
  await ensureTemplate({ roleId: 'fuel', label: 'צהריים מתדלקים (שבת)', start: '13:00', end: '23:00', needed: 1, days: [6] });
  await ensureTemplate({ roleId: 'store', label: 'ביניים חנות', start: '10:00', end: '17:00', needed: 1, days: [2, 6] });

  // store morning is manual-only from now on — it should never be auto-filled by generation.
  const storeMorning = rows.find(r => r.role_id === 'store' && r.label === 'בוקר חנות');
  if (storeMorning && Number(storeMorning.auto_assign) !== 0) {
    await db.run('UPDATE shift_templates SET auto_assign = 0 WHERE id = ?', [storeMorning.id]);
  }
}

// Store night shifts are male-only during automatic generation (a staffing-safety rule) —
// backfills required_gender on any database that already seeded the store night template
// before this rule existed. Idempotent: only writes when not already set, same pattern as V2.
async function applyScheduleTemplateSpecV3(db) {
  const row = await db.get("SELECT id, required_gender FROM shift_templates WHERE role_id = 'store' AND label = 'לילה חנות'", []);
  if (row && row.required_gender !== 'male') {
    await db.run('UPDATE shift_templates SET required_gender = ? WHERE id = ?', ['male', row.id]);
  }
}

// The office role is no longer scheduled. Runs every startup, on any database that
// already seeded the old default templates (including ones created before this
// change) — idempotent via the "active = 1" guard, so it's a no-op once applied.
async function deactivateOfficeTemplates(db) {
  await db.run("UPDATE shift_templates SET active = 0 WHERE role_id = 'office' AND active = 1", []);
}

// "understaffed" notifications used to be written as one long multi-line dump (a line per
// missing slot). That format was later replaced with a short single-line summary, but existing
// notifications already in the database keep whatever text they were created with — a
// notification's text is a historical record, never rewritten by normal app code — so any
// dumped before the change still shows the old wall of text in the overview's day agenda
// forever. This one-time cleanup rewrites those specific rows to match the current short
// format. Matched by the old format's fixed marker phrase, so it naturally becomes a no-op
// (nothing left to match) once every old-format row has been rewritten — safe to run every
// startup, same "self-healing" approach as the migrations above.
async function cleanupVerboseUnderstaffedNotifications(db) {
  const marker = ' הופק אך יש משמרות לא מאוישות:\n';
  const roleLabels = { fuel: 'מתדלקים', store: 'עובדי חנות' };
  const rows = await db.all("SELECT id, text FROM notifications WHERE type = 'understaffed'", []);
  for (const row of rows) {
    const idx = row.text.indexOf(marker);
    if (idx === -1) continue; // already short-form (or some other shape) — leave it alone
    const head = row.text.slice(0, idx);
    const lines = row.text.slice(idx + marker.length).split('\n').filter(Boolean);
    let total = 0;
    const byRole = {};
    lines.forEach(line => {
      const m = line.match(/חסרים (\d+)\s*$/);
      const missing = m ? Number(m[1]) : 0;
      total += missing;
      const roleId = line.indexOf('חנות') !== -1 ? 'store' : 'fuel';
      byRole[roleId] = (byRole[roleId] || 0) + missing;
    });
    const breakdown = Object.keys(byRole).map(r => byRole[r] + ' ' + (roleLabels[r] || r)).join(', ');
    const newText = head + ' הופק — ' + total + ' משמרות ללא איוש (' + breakdown + '). לפירוט מלא: לשונית "לוז שבועי".';
    await db.run('UPDATE notifications SET text = ? WHERE id = ?', [newText, row.id]);
  }
}

// Before "generated"/"understaffed" notifications became a per-week status that a regeneration
// replaces (see store.replaceScheduleStatusNotification), every regeneration of the same week
// just added another row — so a week that was regenerated a few times (manually, or by the
// automatic Thursday run) has several old status lines still stacked under one day in the
// overview, even though only the most recent one is still true. This one-time cleanup collapses
// each week's existing rows down to the latest one, and backfills related_id on the survivor
// (older rows predate that column being used here, so it's matched by parsing the week out of
// the text instead) so future regenerations can find and replace it going forward. Safe to run
// every startup: once a week has at most one row left, there is nothing further to collapse.
async function dedupeScheduleStatusNotifications(db) {
  const rows = await db.all(
    "SELECT id, text FROM notifications WHERE audience = 'manager' AND type IN ('generated','understaffed') ORDER BY created_at ASC",
    []
  );
  const byWeek = {};
  rows.forEach(row => {
    const m = row.text.match(/לשבוע (\d{4}-\d{2}-\d{2})/);
    if (!m) return;
    (byWeek[m[1]] = byWeek[m[1]] || []).push(row);
  });
  for (const week of Object.keys(byWeek)) {
    const group = byWeek[week];
    const survivor = group[group.length - 1]; // rows were fetched oldest-first, so the last is the latest
    for (const row of group) {
      if (row.id !== survivor.id) await db.run('DELETE FROM notifications WHERE id = ?', [row.id]);
    }
    await db.run('UPDATE notifications SET related_id = ? WHERE id = ?', [week, survivor.id]);
  }
}

async function initSchema(db) {
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(Boolean);
  for (const s of statements) await db.exec(s + ';');
  await migrateTimestampColumns(db);
  const row = await db.get('SELECT data FROM settings WHERE id = 1', []);
  if (!row) {
    await db.run('INSERT INTO settings (id, data) VALUES (1, ?)', [JSON.stringify(DEFAULT_SETTINGS)]);
  }
  const tCount = await db.get('SELECT COUNT(*) as c FROM shift_templates', []);
  if (!tCount || Number(tCount.c) === 0) {
    for (const t of DEFAULT_TEMPLATES) {
      await db.run(
        'INSERT INTO shift_templates (id, role_id, label, start_time, end_time, needed, days, active, auto_assign, required_gender) VALUES (?,?,?,?,?,?,?,1,?,?)',
        [uid(), t.roleId, t.label, t.start, t.end, t.needed, JSON.stringify(t.days), t.autoAssign === false ? 0 : 1, t.requiredGender || null]
      );
    }
  }
  await deactivateOfficeTemplates(db);
  await applyScheduleTemplateSpecV2(db);
  await applyScheduleTemplateSpecV3(db);
  await cleanupVerboseUnderstaffedNotifications(db);
  await dedupeScheduleStatusNotifications(db);
}

function rowToEmployee(r, includePin) {
  const e = { id: r.id, name: r.name, roleId: r.role_id, active: !!r.active, maxShiftsPerWeek: r.max_shifts_per_week || null, gender: r.gender || null };
  if (includePin) e.pin = r.pin;
  return e;
}
function rowToTemplate(r) {
  return { id: r.id, roleId: r.role_id, label: r.label, start: r.start_time, end: r.end_time, needed: r.needed, days: JSON.parse(r.days), active: !!r.active, autoAssign: r.auto_assign == null ? true : !!r.auto_assign, requiredGender: r.required_gender || null };
}
function rowToConstraint(r) {
  // created_at is a BIGINT column — Postgres' driver returns those as strings (to avoid
  // precision loss), which makes new Date(str) on the frontend produce "Invalid Date".
  // Number(...) here keeps every dialect returning a plain JS number.
  return { id: r.id, employeeId: r.employee_id, kind: r.kind, date: r.date || null, dayOfWeek: r.day_of_week == null ? null : r.day_of_week, allDay: !!r.all_day, start: r.start_time || null, end: r.end_time || null, createdAt: Number(r.created_at) };
}
function rowToAssignment(r) {
  return { id: r.id, weekStart: r.week_start, date: r.date, shiftTemplateId: r.shift_template_id, employeeId: r.employee_id, noShow: !!r.no_show };
}
function rowToSwap(r) {
  return { id: r.id, assignmentId: r.assignment_id, requesterId: r.requester_id, roleId: r.role_id, kind: r.kind, status: r.status, claimedBy: r.claimed_by || null, createdAt: Number(r.created_at), resolvedAt: r.resolved_at == null ? null : Number(r.resolved_at), date: r.date || null, shiftTemplateId: r.shift_template_id || null };
}
function rowToNotification(r) {
  return { id: r.id, audience: r.audience, employeeId: r.employee_id || null, type: r.type, text: r.text, severity: r.severity, relatedId: r.related_id || null, channels: JSON.parse(r.channels), read: !!r.read, ts: Number(r.created_at) };
}

function makeStore(db) {
  return {
    db,
    uid,

    async getSettings() {
      const row = await db.get('SELECT data FROM settings WHERE id = 1', []);
      return row ? JSON.parse(row.data) : Object.assign({}, DEFAULT_SETTINGS);
    },
    async updateSettings(patch) {
      const cur = await this.getSettings();
      const next = Object.assign({}, cur, patch);
      await db.run('UPDATE settings SET data = ? WHERE id = 1', [JSON.stringify(next)]);
      return next;
    },

    async listEmployees({ includePin } = {}) {
      const rows = await db.all('SELECT * FROM employees ORDER BY created_at ASC', []);
      return rows.map(r => rowToEmployee(r, includePin));
    },
    async getEmployee(id, { includePin } = {}) {
      const row = await db.get('SELECT * FROM employees WHERE id = ?', [id]);
      return row ? rowToEmployee(row, includePin) : null;
    },
    async getEmployeeByPin(id, pin) {
      const row = await db.get('SELECT * FROM employees WHERE id = ? AND pin = ? AND active = 1', [id, pin]);
      return row ? rowToEmployee(row, true) : null;
    },
    async createEmployee({ name, roleId, pin, maxShiftsPerWeek, gender }) {
      const id = uid();
      await db.run(
        'INSERT INTO employees (id, name, role_id, pin, active, max_shifts_per_week, gender, created_at) VALUES (?,?,?,?,1,?,?,?)',
        [id, name, roleId, pin, maxShiftsPerWeek || null, gender || null, Date.now()]
      );
      return this.getEmployee(id);
    },
    async updateEmployee(id, patch) {
      const cur = await db.get('SELECT * FROM employees WHERE id = ?', [id]);
      if (!cur) return null;
      const next = {
        name: patch.name != null ? patch.name : cur.name,
        role_id: patch.roleId != null ? patch.roleId : cur.role_id,
        pin: patch.pin != null ? patch.pin : cur.pin,
        active: patch.active != null ? (patch.active ? 1 : 0) : cur.active,
        max_shifts_per_week: patch.maxShiftsPerWeek !== undefined ? patch.maxShiftsPerWeek : cur.max_shifts_per_week,
        gender: patch.gender != null ? patch.gender : cur.gender,
      };
      await db.run('UPDATE employees SET name=?, role_id=?, pin=?, active=?, max_shifts_per_week=?, gender=? WHERE id=?',
        [next.name, next.role_id, next.pin, next.active, next.max_shifts_per_week, next.gender, id]);
      return this.getEmployee(id);
    },

    async listShiftTemplates() {
      const rows = await db.all('SELECT * FROM shift_templates', []);
      return rows.map(rowToTemplate);
    },
    async createShiftTemplate(t) {
      const id = uid();
      await db.run('INSERT INTO shift_templates (id, role_id, label, start_time, end_time, needed, days, active, auto_assign, required_gender) VALUES (?,?,?,?,?,?,?,1,?,?)',
        [id, t.roleId, t.label, t.start, t.end, t.needed, JSON.stringify(t.days), t.autoAssign === false ? 0 : 1, t.requiredGender || null]);
      return id;
    },
    async updateShiftTemplate(id, patch) {
      const cur = await db.get('SELECT * FROM shift_templates WHERE id = ?', [id]);
      if (!cur) return null;
      const next = {
        role_id: patch.roleId != null ? patch.roleId : cur.role_id,
        label: patch.label != null ? patch.label : cur.label,
        start_time: patch.start != null ? patch.start : cur.start_time,
        end_time: patch.end != null ? patch.end : cur.end_time,
        needed: patch.needed != null ? patch.needed : cur.needed,
        days: patch.days != null ? JSON.stringify(patch.days) : cur.days,
        active: patch.active != null ? (patch.active ? 1 : 0) : cur.active,
        auto_assign: patch.autoAssign != null ? (patch.autoAssign ? 1 : 0) : cur.auto_assign,
        required_gender: patch.requiredGender !== undefined ? (patch.requiredGender || null) : cur.required_gender,
      };
      await db.run('UPDATE shift_templates SET role_id=?, label=?, start_time=?, end_time=?, needed=?, days=?, active=?, auto_assign=?, required_gender=? WHERE id=?',
        [next.role_id, next.label, next.start_time, next.end_time, next.needed, next.days, next.active, next.auto_assign, next.required_gender, id]);
      return true;
    },

    async getScheduleWeek(weekStart) {
      const row = await db.get('SELECT * FROM schedules WHERE week_start = ?', [weekStart]);
      const assignments = await db.all('SELECT * FROM assignments WHERE week_start = ?', [weekStart]);
      // A week can have manual assignments (added via the "+ שיבוץ ידני" dropdown) before it has
      // ever been auto-generated — there's no `schedules` row yet in that case. Only treat the
      // week as truly empty (return null) when there's neither a generated schedule nor any
      // manual assignment; otherwise those assignments would be invisible until generation, and
      // then silently wiped out the moment someone did generate (generateWeek only skips an
      // already-generated week, and without this a manually-assigned week never counted as one).
      if (!row && !assignments.length) return null;
      const templateRows = await db.all('SELECT id, active FROM shift_templates', []);
      const activeById = {};
      templateRows.forEach(t => { activeById[t.id] = !!t.active; });
      // Drop stale understaffed entries left over from a shift template that has since been
      // deactivated/removed (e.g. the old office role) — the "understaffed" list is a snapshot
      // taken at generation time and never rewritten, so a role removed afterwards would
      // otherwise keep showing "missing" forever for a week generated before the removal.
      // A shiftTemplateId we have no record of at all is left in place rather than hidden —
      // safer to show a possibly-orphaned entry than to silently swallow a real one.
      const understaffed = row
        ? JSON.parse(row.understaffed).filter(u => !Object.prototype.hasOwnProperty.call(activeById, u.shiftTemplateId) || activeById[u.shiftTemplateId])
        : [];
      return { weekStart, understaffed, generatedAt: row ? Number(row.generated_at) : null, assignments: assignments.map(rowToAssignment) };
    },
    async listAllWeekKeys() {
      const rows = await db.all('SELECT week_start FROM schedules ORDER BY week_start ASC', []);
      return rows.map(r => r.week_start);
    },
    async saveGeneratedSchedule(weekStart, assignments, understaffed, generatedAt) {
      await db.run('DELETE FROM assignments WHERE week_start = ?', [weekStart]);
      await db.run('DELETE FROM schedules WHERE week_start = ?', [weekStart]);
      await db.run('INSERT INTO schedules (week_start, understaffed, generated_at) VALUES (?,?,?)',
        [weekStart, JSON.stringify(understaffed), generatedAt]);
      for (const a of assignments) {
        await db.run('INSERT INTO assignments (id, week_start, date, shift_template_id, employee_id, no_show) VALUES (?,?,?,?,?,0)',
          [uid(), weekStart, a.date, a.shiftTemplateId, a.employeeId]);
      }
    },
    async addAssignment(weekStart, date, shiftTemplateId, employeeId) {
      const id = uid();
      await db.run('INSERT INTO assignments (id, week_start, date, shift_template_id, employee_id, no_show) VALUES (?,?,?,?,?,0)',
        [id, weekStart, date, shiftTemplateId, employeeId]);
      return id;
    },
    async removeAssignment(id) { await db.run('DELETE FROM assignments WHERE id = ?', [id]); },
    async getAssignment(id) {
      const row = await db.get('SELECT * FROM assignments WHERE id = ?', [id]);
      return row ? rowToAssignment(row) : null;
    },
    async setAssignmentNoShow(id, noShow) {
      await db.run('UPDATE assignments SET no_show = ? WHERE id = ?', [noShow ? 1 : 0, id]);
    },
    async listAssignmentsInRange(fromDate, toDate) {
      const rows = await db.all('SELECT * FROM assignments WHERE date >= ? AND date <= ? ORDER BY date ASC', [fromDate, toDate]);
      return rows.map(rowToAssignment);
    },
    async listAssignmentsForEmployee(employeeId, fromDate) {
      const rows = await db.all('SELECT * FROM assignments WHERE employee_id = ? AND date >= ? ORDER BY date ASC', [employeeId, fromDate]);
      return rows.map(rowToAssignment);
    },

    async listConstraints(employeeId) {
      const rows = employeeId
        ? await db.all('SELECT * FROM constraints WHERE employee_id = ? ORDER BY created_at DESC', [employeeId])
        : await db.all('SELECT * FROM constraints ORDER BY created_at DESC', []);
      return rows.map(rowToConstraint);
    },
    async addConstraint(c) {
      const id = uid();
      await db.run('INSERT INTO constraints (id, employee_id, kind, date, day_of_week, all_day, start_time, end_time, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, c.employeeId, c.kind, c.date || null, c.dayOfWeek == null ? null : c.dayOfWeek, c.allDay ? 1 : 0, c.start || null, c.end || null, Date.now()]);
      return id;
    },
    async deleteConstraint(id, employeeId) {
      if (employeeId) return db.run('DELETE FROM constraints WHERE id = ? AND employee_id = ?', [id, employeeId]);
      return db.run('DELETE FROM constraints WHERE id = ?', [id]);
    },

    async createSwapRequest(s) {
      const id = uid();
      // snapshot the shift's date/template at request time — a claim later re-creates the
      // assignment row (new id) for the claimer, so this must not depend on that row surviving.
      const assignment = await this.getAssignment(s.assignmentId);
      await db.run('INSERT INTO swap_requests (id, assignment_id, requester_id, role_id, kind, status, claimed_by, date, shift_template_id, created_at, resolved_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
        [id, s.assignmentId, s.requesterId, s.roleId, s.kind, 'open', null, assignment ? assignment.date : null, assignment ? assignment.shiftTemplateId : null, Date.now()]);
      return id;
    },
    async listSwapRequests({ status } = {}) {
      const rows = status
        ? await db.all('SELECT * FROM swap_requests WHERE status = ? ORDER BY created_at DESC', [status])
        : await db.all('SELECT * FROM swap_requests ORDER BY created_at DESC', []);
      return rows.map(rowToSwap);
    },
    async getSwapRequest(id) {
      const row = await db.get('SELECT * FROM swap_requests WHERE id = ?', [id]);
      return row ? rowToSwap(row) : null;
    },
    async getOpenSwapForAssignment(assignmentId) {
      const row = await db.get("SELECT * FROM swap_requests WHERE assignment_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", [assignmentId]);
      return row ? rowToSwap(row) : null;
    },
    async updateSwapRequest(id, patch) {
      const cur = await db.get('SELECT * FROM swap_requests WHERE id = ?', [id]);
      if (!cur) return null;
      const next = {
        status: patch.status != null ? patch.status : cur.status,
        claimed_by: patch.claimedBy !== undefined ? patch.claimedBy : cur.claimed_by,
        resolved_at: patch.resolved ? Date.now() : cur.resolved_at,
      };
      await db.run('UPDATE swap_requests SET status=?, claimed_by=?, resolved_at=? WHERE id=?', [next.status, next.claimed_by, next.resolved_at, id]);
      return this.getSwapRequest(id);
    },
    async deleteSwapRequest(id, requesterId) {
      if (requesterId) return db.run('DELETE FROM swap_requests WHERE id = ? AND requester_id = ?', [id, requesterId]);
      return db.run('DELETE FROM swap_requests WHERE id = ?', [id]);
    },

    async addNotification(n) {
      const id = uid();
      await db.run('INSERT INTO notifications (id, audience, employee_id, type, text, severity, related_id, channels, read, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)',
        [id, n.audience, n.employeeId || null, n.type, n.text, n.severity || 'info', n.relatedId || null, JSON.stringify(n.channels || ['inapp']), Date.now()]);
      return id;
    },
    // A "generated"/"understaffed" notification is a status for one week, not a log entry —
    // regenerating the same week (manually via "הפק מחדש", or the automatic Thursday run)
    // should replace the previous status, not stack another line under it. Called right before
    // writing the new status notification for weekStart.
    async replaceScheduleStatusNotification(weekStart) {
      await db.run("DELETE FROM notifications WHERE audience = 'manager' AND type IN ('generated','understaffed') AND related_id = ?", [weekStart]);
    },
    async listNotifications({ audience, employeeId, limit } = {}) {
      let rows;
      if (audience === 'employee' && employeeId) {
        rows = await db.all('SELECT * FROM notifications WHERE audience = ? AND employee_id = ? ORDER BY created_at DESC LIMIT ?', ['employee', employeeId, limit || 100]);
      } else if (audience) {
        rows = await db.all('SELECT * FROM notifications WHERE audience = ? ORDER BY created_at DESC LIMIT ?', [audience, limit || 100]);
      } else {
        rows = await db.all('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?', [limit || 100]);
      }
      return rows.map(rowToNotification);
    },
    async markNotificationRead(id) { await db.run('UPDATE notifications SET read = 1 WHERE id = ?', [id]); },
    async markAllNotificationsRead({ audience, employeeId } = {}) {
      if (audience === 'employee' && employeeId) {
        await db.run("UPDATE notifications SET read = 1 WHERE audience = 'employee' AND employee_id = ? AND read = 0", [employeeId]);
      } else if (audience) {
        await db.run('UPDATE notifications SET read = 1 WHERE audience = ? AND read = 0', [audience]);
      } else {
        await db.run('UPDATE notifications SET read = 1 WHERE read = 0', []);
      }
    },
  };
}

module.exports = { initSchema, makeStore, DEFAULT_SETTINGS, DEFAULT_TEMPLATES, uid };
