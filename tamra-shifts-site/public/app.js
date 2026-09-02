(function () {
'use strict';

/* ---------- tiny date helpers (client-side mirrors of lib/schedule.js; server is authoritative) ---------- */
function pad2(n){ return String(n).padStart(2,'0'); }
function dateStrOf(y,m,d){ return y+'-'+pad2(m)+'-'+pad2(d); }
function todayStr(){ var d=new Date(); return dateStrOf(d.getFullYear(),d.getMonth()+1,d.getDate()); }
function weekKeyOf(dateStr){ var dp=dateStr.split('-').map(Number); var d=new Date(dp[0],dp[1]-1,dp[2]); d.setDate(d.getDate()-d.getDay()); return dateStrOf(d.getFullYear(),d.getMonth()+1,d.getDate()); }
function addDays(dateStr,delta){ var dp=dateStr.split('-').map(Number); var d=new Date(dp[0],dp[1]-1,dp[2]+delta); return dateStrOf(d.getFullYear(),d.getMonth()+1,d.getDate()); }
function addWeeks(wk,delta){ return addDays(wk,delta*7); }
function addMonths(mk,delta){ var p=mk.split('-').map(Number); var d=new Date(p[0],p[1]-1+delta,1); return d.getFullYear()+'-'+pad2(d.getMonth()+1); }
function monthKeyOf(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1); }
function monthLabel(mk){ var p=mk.split('-'); var names=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר']; return names[Number(p[1])-1]+' '+p[0]; }
function fmtDateShort(ds){ var p=ds.split('-'); return p[2]+'.'+p[1]; }
function weekLabel(wk){ var end=addDays(wk,6); return fmtDateShort(wk)+'–'+fmtDateShort(end)+'.'+wk.split('-')[0]; }
function dowName(n){ return ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'][n]; }
function dowOfDateStr(ds){ var p=ds.split('-').map(Number); return new Date(p[0],p[1]-1,p[2]).getDay(); }
function dayDateHtml(ds){ if(!ds) return '—'; return '<b>' + dowName(dowOfDateStr(ds)) + '</b> <span class="mono">' + fmtDateShort(ds) + '</span>'; }
function nextGenerationWeek(){ return addWeeks(weekKeyOf(todayStr()),1); }
function deadlineForWeek(weekStart, genDow){ genDow = genDow==null?4:genDow; return addDays(weekStart, genDow-8); }
function timeToMinutes(t){ var p=t.split(':').map(Number); return p[0]*60+p[1]; }
function durationHours(start,end){ var s=timeToMinutes(start), e=timeToMinutes(end); if(e<=s) e+=1440; return (e-s)/60; }
function fmtHours(h){ return (Math.round(h*10)/10).toLocaleString('he-IL'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
// office was removed as a role option; a pre-existing office employee (if any) still
// needs to render honestly rather than being silently relabeled as fuel/store.
function roleClass(id){ return id==='fuel'?'role-fuel':(id==='store'?'role-store':'role-other'); }
function roleLabel(id){ return id==='fuel'?'מתדלק/ת':(id==='store'?'עובד/ת חנות':'פקיד/ה (הוסר)'); }
function roleLabelPlural(id){ return id==='fuel'?'מתדלקים':(id==='store'?'עובדי חנות':'אחר'); }
function genderLabel(g){ return g==='male'?'זכר':(g==='female'?'נקבה':'לא צוין'); }
function genderClass(g){ return g==='male'?'gender-male':(g==='female'?'gender-female':'gender-unset'); }

/* ---------- app state ---------- */
var STATE = null; // { session, me, settings, employees, shiftTemplates }
var CACHE = { weeks:{}, constraints:null, swaps:null, notifications:null, hours:{}, employeesFull:null, truthHours:null };
var PUBLIC_EMPLOYEES = []; // populated pre-login so the employee login dropdown works without auth
var ui = { tab:null, loginMode:'employee', loginErr:'', currentWeek: weekKeyOf(todayStr()), currentMonth: monthKeyOf(new Date()), modal:null, busy:false, scheduleRole:'fuel', truthBusy:false, truthError:'', employeesGender:'all' };

/* ---------- api ---------- */
function api(method, path, body) {
  var opts = { method: method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(path, opts).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: data };
    });
  });
}

function toast(text, kind) {
  var zone = document.getElementById('toastzone');
  var el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = text;
  zone.appendChild(el);
  setTimeout(function () { el.remove(); }, 4200);
}

/* ---------- bootstrap / auth ---------- */
function boot() {
  api('GET', '/api/bootstrap').then(function (r) {
    if (!r.ok) {
      STATE = null; ui.tab = null;
      api('GET', '/api/public/employees').then(function (pr) { PUBLIC_EMPLOYEES = pr.ok ? pr.data.employees : []; render(); });
      return;
    }
    STATE = r.data;
    if (!ui.tab) ui.tab = STATE.session.type === 'manager' ? 'overview' : 'myschedule';
    render();
  });
}

function login(mode, employeeId, pin) {
  ui.busy = true; render();
  api('POST', '/api/login', mode === 'manager' ? { mode: 'manager', pin: pin } : { mode: 'employee', employeeId: employeeId, pin: pin }).then(function (r) {
    ui.busy = false;
    if (!r.ok) { ui.loginErr = 'קוד שגוי — נסה/י שוב'; render(); return; }
    ui.loginErr = '';
    boot();
  });
}
function logout() {
  api('POST', '/api/logout').then(function () {
    STATE = null; CACHE = { weeks:{}, constraints:null, swaps:null, notifications:null, hours:{}, employeesFull:null, truthHours:null }; ui.tab = null;
    api('GET', '/api/public/employees').then(function (pr) { PUBLIC_EMPLOYEES = pr.ok ? pr.data.employees : []; render(); });
  });
}

/* ---------- data loaders (cache + render) ---------- */
function loadWeek(wk, cb) {
  api('GET', '/api/schedule/' + wk).then(function (r) {
    if (r.ok) CACHE.weeks[wk] = r.data.week;
    if (cb) cb();
    render();
  });
}
function loadConstraints(cb) {
  var qs = STATE.session.type === 'manager' ? '' : '';
  api('GET', '/api/constraints' + qs).then(function (r) { if (r.ok) CACHE.constraints = r.data.constraints; if (cb) cb(); render(); });
}
function loadSwaps(cb) {
  // fetch full history (not just open) so resolved requests still show who claimed them
  api('GET', '/api/swaps').then(function (r) { if (r.ok) CACHE.swaps = r.data.swaps; if (cb) cb(); render(); });
}
function loadNotifications(cb) {
  api('GET', '/api/notifications').then(function (r) { if (r.ok) CACHE.notifications = r.data.notifications; if (cb) cb(); render(); });
}
function loadHours(mk, cb) {
  api('GET', '/api/hours/' + mk).then(function (r) { if (r.ok) CACHE.hours[mk] = r.data.hours; if (cb) cb(); render(); });
}
function loadEmployeesFull(cb) {
  api('GET', '/api/employees').then(function (r) { if (r.ok) CACHE.employeesFull = r.data.employees; if (cb) cb(); render(); });
}
function refreshBootstrapEmployees() {
  api('GET', '/api/bootstrap').then(function (r) { if (r.ok) { STATE.employees = r.data.employees; STATE.shiftTemplates = r.data.shiftTemplates; render(); } });
}

/* ---------- true-hours (.xlsx) upload ---------- */
function arrayBufferToBase64(buf) {
  var bytes = new Uint8Array(buf);
  var binary = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}
function handleTruthFile(file) {
  if (!file) return;
  ui.truthBusy = true; ui.truthError = ''; render();
  var reader = new FileReader();
  reader.onload = function () {
    var b64;
    try { b64 = arrayBufferToBase64(reader.result); } catch (e) {
      ui.truthBusy = false; ui.truthError = 'שגיאה בקריאת הקובץ'; render(); return;
    }
    api('POST', '/api/hours/truth', { fileBase64: b64 }).then(function (r) {
      ui.truthBusy = false;
      if (!r.ok) {
        ui.truthError = (r.data && r.data.error === 'parse_failed')
          ? 'לא הצלחתי לקרוא את הקובץ — יש לוודא שזהו קובץ האקסל המקורי (דוח סיכום שעות) מהמערכת, בלי לשנות אותו'
          : 'שגיאה בעיבוד הקובץ';
        render(); return;
      }
      CACHE.truthHours = r.data;
      render();
    });
  };
  reader.onerror = function () { ui.truthBusy = false; ui.truthError = 'שגיאה בקריאת הקובץ'; render(); };
  reader.readAsArrayBuffer(file);
}

/* ---------- actions ---------- */
function closeModal() { ui.modal = null; render(); }

function handleAction(action, el, ev) {
  if (action === 'seg-mode') { ui.loginMode = el.getAttribute('data-mode'); ui.loginErr = ''; render(); return; }
  if (action === 'set-tab') { ui.tab = el.getAttribute('data-tab'); ui.modal = null; render(); ensureTabData(); return; }
  if (action === 'logout') { logout(); return; }
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'theme-toggle') { toggleTheme(); return; }

  if (action === 'week-prev') { ui.currentWeek = addWeeks(ui.currentWeek, -1); render(); loadWeek(ui.currentWeek); return; }
  if (action === 'week-next') { ui.currentWeek = addWeeks(ui.currentWeek, 1); render(); loadWeek(ui.currentWeek); return; }
  if (action === 'week-gen-target') { ui.currentWeek = nextGenerationWeek(); render(); loadWeek(ui.currentWeek); return; }
  if (action === 'set-schedule-role') { ui.scheduleRole = el.getAttribute('data-role'); render(); return; }
  if (action === 'set-employees-gender') { ui.employeesGender = el.getAttribute('data-gender'); render(); return; }
  if (action === 'month-prev') { ui.currentMonth = addMonths(ui.currentMonth, -1); render(); loadHours(ui.currentMonth); return; }
  if (action === 'month-next') { ui.currentMonth = addMonths(ui.currentMonth, 1); render(); loadHours(ui.currentMonth); return; }

  if (action === 'generate-schedule') { ui.modal = { type: 'confirm-generate' }; render(); return; }
  if (action === 'confirm-generate-go') {
    closeModal();
    api('POST', '/api/schedule/' + ui.currentWeek + '/generate', {}).then(function (r) {
      if (!r.ok) { toast('שגיאה בהפקת הלוז', 'err'); return; }
      if (r.data.skipped) toast('כבר קיים לוז לשבוע זה', 'err');
      else toast(r.data.week.understaffed.length ? ('הלוז הופק — ' + r.data.week.understaffed.length + ' משמרות לא מאוישות') : 'הלוז הופק בהצלחה, הכול מאויש', r.data.week.understaffed.length ? 'err' : 'ok');
      CACHE.weeks[ui.currentWeek] = r.data.week;
      render();
    });
    return;
  }
  if (action === 'regenerate-force') {
    closeModal();
    api('POST', '/api/schedule/' + ui.currentWeek + '/generate', { force: true }).then(function (r) {
      if (r.ok) { CACHE.weeks[ui.currentWeek] = r.data.week; toast('הלוז הופק מחדש', 'ok'); render(); }
    });
    return;
  }
  if (action === 'remove-assignment') {
    var aid = el.getAttribute('data-aid');
    api('DELETE', '/api/assignment/' + aid).then(function (r) { if (r.ok) { toast('ההקצאה הוסרה'); loadWeek(ui.currentWeek); } });
    return;
  }
  if (action === 'assign-slot') {
    var date = el.getAttribute('data-date'), tid = el.getAttribute('data-tid'), empId = el.value;
    if (!empId) return;
    api('POST', '/api/schedule/' + ui.currentWeek + '/assign', { date: date, shiftTemplateId: tid, employeeId: empId }).then(function (r) {
      if (r.ok) {
        if (r.data.constraintConflict) toast('שובץ/ה — אבל בניגוד לאילוץ שהעובד/ת הגיש/ה! נשלחה התראה', 'err');
        else toast('שובץ', 'ok');
        loadWeek(ui.currentWeek);
      } else toast('שגיאה בשיבוץ', 'err');
    });
    return;
  }

  if (action === 'add-employee') { ui.modal = { type: 'employee-form' }; render(); return; }
  if (action === 'edit-employee') {
    var id = el.getAttribute('data-id');
    var emp = (CACHE.employeesFull || []).find(function (e) { return e.id === id; });
    ui.modal = { type: 'employee-form', employee: emp }; render(); return;
  }
  if (action === 'deactivate-employee') {
    var eid = el.getAttribute('data-id');
    var emp2 = (CACHE.employeesFull || []).find(function (e) { return e.id === eid; });
    api('PATCH', '/api/employees/' + eid, { active: !(emp2 && emp2.active) }).then(function (r) {
      if (r.ok) { toast('עודכן'); loadEmployeesFull(); refreshBootstrapEmployees(); }
    });
    return;
  }

  if (action === 'add-constraint') { ui.modal = { type: 'constraint-form' }; render(); return; }
  if (action === 'delete-constraint') {
    var cid = el.getAttribute('data-id');
    api('DELETE', '/api/constraints/' + cid).then(function (r) { if (r.ok) { toast('נמחק'); loadConstraints(); } });
    return;
  }

  if (action === 'request-swap' || action === 'report-noshow') {
    var aid2 = el.getAttribute('data-aid');
    var kind = action === 'report-noshow' ? 'noshow' : 'swap';
    api('POST', '/api/assignment/' + aid2 + '/swap-request', { kind: kind }).then(function (r) {
      if (r.ok) { toast('הבקשה נשלחה לעובדים המתאימים', 'ok'); loadWeek(weekKeyOf((CACHE.weeks[ui.currentWeek] && CACHE.weeks[ui.currentWeek].assignments.find(function(a){return a.id===aid2;}) || {}).date || ui.currentWeek)); CACHE.swaps = null; }
      else toast('שגיאה בשליחת הבקשה', 'err');
    });
    return;
  }
  if (action === 'claim-swap') {
    var sid = el.getAttribute('data-id');
    api('POST', '/api/swaps/' + sid + '/claim').then(function (r) {
      if (r.ok) { toast('לקחת את המשמרת!', 'ok'); CACHE.swaps = null; CACHE.weeks = {}; loadSwaps(); }
      else toast('לא ניתן היה לקחת את המשמרת', 'err');
    });
    return;
  }
  if (action === 'cancel-swap') {
    var csid = el.getAttribute('data-id');
    api('DELETE', '/api/swaps/' + csid).then(function (r) {
      if (r.ok) { toast('הבקשה בוטלה', 'ok'); CACHE.swaps = null; loadSwaps(); }
      else toast('לא ניתן היה לבטל את הבקשה', 'err');
    });
    return;
  }
  if (action === 'mark-notif-read') {
    var nid = el.getAttribute('data-id');
    api('POST', '/api/notifications/' + nid + '/read').then(function () { loadNotifications(); });
    return;
  }
  if (action === 'mark-all-read') {
    api('POST', '/api/notifications/read-all').then(function (r) { if (r.ok) loadNotifications(); });
    return;
  }
  if (action === 'open-truth-picker') {
    var inp = document.getElementById('truthFileInput');
    if (inp) inp.click();
    return;
  }
  if (action === 'clear-truth-hours') { CACHE.truthHours = null; ui.truthError = ''; render(); return; }
}

function toggleTheme() {
  var root = document.documentElement;
  var cur = root.getAttribute('data-theme');
  root.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
}

/* ---------- forms ---------- */
function handleSubmit(action, form) {
  var f = new FormData(form);
  if (action === 'login-form') {
    if (ui.loginMode === 'manager') login('manager', null, f.get('pin'));
    else login('employee', f.get('employeeId'), f.get('pin'));
    return;
  }
  if (action === 'submit-employee') {
    var payload = { name: f.get('name'), roleId: f.get('roleId'), pin: f.get('pin'), gender: f.get('gender') || null };
    var editing = ui.modal && ui.modal.employee;
    var call = editing ? api('PATCH', '/api/employees/' + ui.modal.employee.id, payload) : api('POST', '/api/employees', payload);
    call.then(function (r) {
      if (!r.ok) { toast('שגיאה בשמירה', 'err'); return; }
      toast('נשמר', 'ok'); closeModal(); loadEmployeesFull(); refreshBootstrapEmployees();
    });
    return;
  }
  if (action === 'submit-constraint') {
    var kind = f.get('kind');
    var payload2 = { kind: kind, allDay: f.get('allDay') === 'on' };
    if (kind === 'date') payload2.date = f.get('date'); else payload2.dayOfWeek = Number(f.get('dayOfWeek'));
    if (!payload2.allDay) { payload2.start = f.get('start'); payload2.end = f.get('end'); }
    api('POST', '/api/constraints', payload2).then(function (r) {
      if (r.status === 409) { toast('המועד האחרון להגשת אילוץ לשבוע שמכיל תאריך זה כבר עבר — יש לפנות להנהלה', 'err'); return; }
      if (!r.ok) { toast('שגיאה', 'err'); return; }
      toast('האילוץ נשמר', 'ok'); closeModal(); loadConstraints();
    });
    return;
  }
  if (action === 'save-settings') {
    var payload3 = {
      companyName: f.get('companyName'), managerPin: f.get('managerPin'), managerEmail: f.get('managerEmail'),
      nightStart: f.get('nightStart'), nightEnd: f.get('nightEnd'),
      shabbatStartDay: Number(f.get('shabbatStartDay')), shabbatStartTime: f.get('shabbatStartTime'),
      shabbatEndDay: Number(f.get('shabbatEndDay')), shabbatEndTime: f.get('shabbatEndTime'),
      dailyOvertimeThreshold: Number(f.get('dailyOvertimeThreshold')), minRestHours: Number(f.get('minRestHours')),
      weeklyGenerationDow: Number(f.get('weeklyGenerationDow')),
    };
    api('PATCH', '/api/settings', payload3).then(function (r) {
      if (r.ok) { STATE.settings = r.data.settings; toast('ההגדרות נשמרו', 'ok'); render(); }
      else toast('שגיאה בשמירה', 'err');
    });
    return;
  }
}

/* ---------- event delegation ---------- */
document.addEventListener('click', function (e) {
  var actEl = e.target.closest('[data-action]');
  if (!actEl || actEl.tagName === 'FORM') return;
  var action = actEl.getAttribute('data-action');
  if (action === 'close-modal' && actEl.classList.contains('modal-bg') && e.target !== actEl) return;
  handleAction(action, actEl, e);
});
document.addEventListener('submit', function (e) {
  var form = e.target.closest('form[data-action]');
  if (!form) return;
  e.preventDefault();
  handleSubmit(form.getAttribute('data-action'), form);
});
document.addEventListener('change', function (e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.getAttribute('data-action') === 'assign-slot') handleAction('assign-slot', el, e);
  if (el.getAttribute('data-action') === 'truth-file-picked') {
    var f = el.files && el.files[0];
    el.value = ''; // allow re-selecting the same file again later
    handleTruthFile(f);
  }
});
document.addEventListener('dragover', function (e) {
  var dz = e.target.closest && e.target.closest('[data-dropzone]');
  if (!dz) return;
  e.preventDefault();
  dz.classList.add('dragover');
});
document.addEventListener('dragleave', function (e) {
  var dz = e.target.closest && e.target.closest('[data-dropzone]');
  if (!dz) return;
  dz.classList.remove('dragover');
});
document.addEventListener('drop', function (e) {
  var dz = e.target.closest && e.target.closest('[data-dropzone]');
  if (!dz) return;
  e.preventDefault();
  dz.classList.remove('dragover');
  var files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) handleTruthFile(files[0]);
});

function ensureTabData() {
  if (!STATE) return;
  var tab = ui.tab;
  if (tab === 'schedule' || tab === 'myschedule') { if (!CACHE.weeks[ui.currentWeek]) loadWeek(ui.currentWeek); }
  if (tab === 'overview') { if (!CACHE.weeks[weekKeyOf(todayStr())]) loadWeek(weekKeyOf(todayStr())); if (!CACHE.swaps) loadSwaps(); }
  if (tab === 'employees' && !CACHE.employeesFull) loadEmployeesFull();
  if (tab === 'requests' && !CACHE.swaps) loadSwaps();
  if ((tab === 'requests' || tab === 'myconstraints') && !CACHE.constraints) loadConstraints();
  if ((tab === 'hours' || tab === 'myhours') && !CACHE.hours[ui.currentMonth]) loadHours(ui.currentMonth);
  if ((tab === 'mynotifs' || tab === 'overview' || tab === 'requests') && !CACHE.notifications) loadNotifications();
  if (tab === 'myswaps' && !CACHE.swaps) loadSwaps();
}

// Other people (an employee claiming a swap, reporting a no-show, submitting a constraint)
// change shared data server-side without this tab knowing — there's no push/websocket here,
// so poll quietly in the background while a relevant tab is open. Full-list refreshes only
// (never while a modal/form is open) so nothing interrupts something the user is mid-typing.
var LIVE_POLL_MS = 25000;
setInterval(function () {
  if (!STATE || !ui.tab || ui.modal) return;
  var tab = ui.tab;
  if (tab === 'schedule' || tab === 'myschedule') loadWeek(ui.currentWeek);
  if (tab === 'overview') { loadWeek(weekKeyOf(todayStr())); loadSwaps(); loadNotifications(); }
  if (tab === 'requests') { loadSwaps(); loadConstraints(); loadNotifications(); }
  if (tab === 'myswaps') loadSwaps();
  if (tab === 'mynotifs') loadNotifications();
}, LIVE_POLL_MS);

/* ============================================================ RENDER ============================================================ */
function render() {
  var app = document.getElementById('app');
  if (!STATE) { app.innerHTML = loginHtml(); return; }
  app.innerHTML = shellHtml();
}

function loginHtml() {
  var mode = ui.loginMode;
  var employeeOptions = (PUBLIC_EMPLOYEES || [])
    .map(function (e) { return '<option value="' + e.id + '">' + esc(e.name) + ' — ' + esc(roleLabel(e.roleId)) + '</option>'; }).join('');
  return '<div class="loginwrap"><div class="loginbox">'
    + '<h1>לוח משמרות תמרה</h1>'
    + '<div class="seg" style="width:100%;display:flex;margin-bottom:16px;">'
    + '<button type="button" style="flex:1" data-action="seg-mode" data-mode="employee" class="' + (mode === 'employee' ? 'active' : '') + '">כניסת עובד/ת</button>'
    + '<button type="button" style="flex:1" data-action="seg-mode" data-mode="manager" class="' + (mode === 'manager' ? 'active' : '') + '">כניסת מנהל/ת</button>'
    + '</div>'
    + '<form id="login-form" data-action="login-form">'
    + (mode === 'employee' ? ('<div class="field"><label>שם</label><select name="employeeId" required>' + (employeeOptions || '<option value="">אין עדיין עובדים רשומים</option>') + '</select></div>') : '')
    + '<div class="field"><label>קוד PIN</label><input type="password" inputmode="numeric" name="pin" required autocomplete="off"></div>'
    + (ui.loginErr ? '<div class="banner err">' + esc(ui.loginErr) + '</div>' : '')
    + '<button class="btn" type="submit" style="width:100%;justify-content:center;margin-top:8px;" ' + (ui.busy ? 'disabled' : '') + '>כניסה</button>'
    + '</form></div></div>';
}

function shellHtml() {
  var isMgr = STATE.session.type === 'manager';
  var tabs = isMgr
    ? [['overview', 'סקירה', '🏠'], ['schedule', 'לוז שבועי', '📅'], ['employees', 'עובדים', '👥'], ['requests', 'בקשות', '📨'], ['hours', 'דוח שעות', '⏱️'], ['settings', 'הגדרות', '⚙️']]
    : [['myschedule', 'הלוז שלי', '📅'], ['myconstraints', 'האילוצים שלי', '📝'], ['myswaps', 'החלפות', '🔁'], ['myhours', 'השעות שלי', '⏱️'], ['mynotifs', 'התראות', '🔔']];
  ensureTabDataOnce();
  var body;
  if (isMgr) {
    switch (ui.tab) {
      case 'overview': body = overviewHtml(); break;
      case 'schedule': body = scheduleHtml(); break;
      case 'employees': body = employeesHtml(); break;
      case 'requests': body = requestsHtml(); break;
      case 'hours': body = hoursHtml(); break;
      case 'settings': body = settingsHtml(); break;
      default: body = '';
    }
  } else {
    switch (ui.tab) {
      case 'myschedule': body = myScheduleHtml(); break;
      case 'myconstraints': body = myConstraintsHtml(); break;
      case 'myswaps': body = mySwapsHtml(); break;
      case 'myhours': body = myHoursHtml(); break;
      case 'mynotifs': body = notifsHtml(); break;
      default: body = '';
    }
  }
  return '<div class="topbar"><div class="brand">' + esc(STATE.settings.companyName || 'תמרה') + '<small>' + (isMgr ? 'ממשק ניהול' : esc(STATE.me ? STATE.me.name : '')) + '</small></div>'
    + '<div style="display:flex;gap:8px;"><button class="iconbtn" data-action="theme-toggle">☀︎/☾</button><button class="btn secondary sm" data-action="logout">התנתקות</button></div></div>'
    + '<div class="tabbar">' + tabs.map(function (t) { return '<button data-action="set-tab" data-tab="' + t[0] + '" class="' + (ui.tab === t[0] ? 'active' : '') + '"><span class="tab-ic">' + t[2] + '</span><span class="tab-lb">' + t[1] + '</span></button>'; }).join('') + '</div>'
    + '<div class="wrap">' + body + '</div>'
    + modalHtml();
}

var _lastEnsuredTab = null;
function ensureTabDataOnce() { if (_lastEnsuredTab !== ui.tab) { _lastEnsuredTab = ui.tab; ensureTabData(); } }

/* ---------- overview (manager) ---------- */
function overviewHtml() {
  var wk = weekKeyOf(todayStr());
  var week = CACHE.weeks[wk];
  var understaffed = week ? week.understaffed.length : null;
  var notifs = CACHE.notifications || [];
  var unread = notifs.filter(function (n) { return !n.read; }).length;
  var html = '';
  if (!STATE.employees.length) {
    html += '<div class="card"><div class="card-head"><h2>ברוכים הבאים ללוח המשמרות</h2></div>'
      + '<div class="helpcard"><b>איך מתחילים:</b><ol>'
      + '<li>מוסיפים את העובדים הראשונים בלשונית <b>עובדים</b> — שם, תפקיד וקוד PIN אישי לכל אחד/ת.</li>'
      + '<li>כל עובד/ת נכנס/ת דרך אותו קישור בדיוק, בוחר/ת את השם שלו/ה ומקליד/ה את הקוד — ומגיש/ה משם את האילוצים.</li>'
      + '<li>בלשונית <b>לוז שבועי</b> לוחצים על "הפק לוז" — השיבוץ נעשה אוטומטית לפי האילוצים, בחלוקה הוגנת.</li>'
      + '</ol></div>'
      + '<div style="margin-top:14px;"><button class="btn" data-action="set-tab" data-tab="employees">בואו נתחיל — הוספת עובד/ת ראשון/ה</button></div>'
      + '</div>';
  }
  html += '<div class="kpis">'
    + '<div class="kpi kpi-neutral"><span class="kpi-ic">👥</span><div class="num">' + (STATE.employees.filter(function(e){return e.active;}).length) + '</div><div class="lbl">עובדים פעילים</div></div>'
    + '<div class="kpi ' + (understaffed ? 'kpi-warn' : 'kpi-ok') + '"><span class="kpi-ic">' + (understaffed ? '⚠️' : '✅') + '</span><div class="num">' + (understaffed == null ? '—' : understaffed) + '</div><div class="lbl">משמרות חסרות איוש (שבוע נוכחי)</div></div>'
    + '<div class="kpi ' + (unread ? 'kpi-accent' : 'kpi-neutral') + '"><span class="kpi-ic">🔔</span><div class="num">' + unread + '</div><div class="lbl">התראות שלא נקראו</div></div>'
    + '</div>';

  html += '<div class="card"><div class="card-head"><h2>סדר יום — ' + weekLabel(wk) + '</h2></div>';
  if (!week) {
    html += '<div class="empty">טוען…</div>';
  } else {
    var swaps = CACHE.swaps || [];
    var dayHtml = '';
    for (var d = 0; d < 7; d++) {
      var ds = addDays(wk, d);
      var chips = [];
      week.understaffed.filter(function (u) { return u.date === ds; }).forEach(function (u) {
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === u.shiftTemplateId; });
        chips.push('<span class="chip chip-err">חסר ' + u.missing + ' — ' + esc(t ? t.label : '') + '</span>');
      });
      week.assignments.filter(function (a) { return a.date === ds && a.noShow; }).forEach(function (a) {
        var emp = STATE.employees.find(function (e) { return e.id === a.employeeId; });
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
        chips.push('<span class="chip chip-err">לא הגיע/ה — ' + esc(emp ? emp.name : '?') + (t ? ' (' + esc(t.label) + ')' : '') + '</span>');
      });
      week.assignments.filter(function (a) { return a.date === ds; }).forEach(function (a) {
        var openSwap = swaps.find(function (s) { return s.assignmentId === a.id && s.status === 'open'; });
        if (openSwap) {
          var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
          chips.push('<span class="chip chip-open">בקשת החלפה פתוחה — ' + esc(t ? t.label : '') + '</span>');
        }
      });
      var dayNotifs = notifs.filter(function (n) {
        var nd = new Date(n.ts);
        return dateStrOf(nd.getFullYear(), nd.getMonth() + 1, nd.getDate()) === ds;
      });
      var notifRows = dayNotifs.map(function (n) {
        var time = new Date(n.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        return '<div class="agenda-notif' + (n.read ? '' : ' unread') + '"><span class="mono">' + time + '</span> ' + esc(n.text) + '</div>';
      }).join('');
      var hasIssue = chips.length > 0;
      dayHtml += '<div class="agenda-day' + (ds === todayStr() ? ' today' : '') + (hasIssue ? ' has-issue' : '') + '">'
        + '<div class="agenda-day-head">'
        + '<div class="agenda-day-title">' + dayDateHtml(ds) + '</div>'
        + '<span class="pill ' + (hasIssue ? 'pill-issue' : 'pill-clear') + '">' + (hasIssue ? (chips.length + ' תקלות') : 'הכול תקין') + '</span>'
        + '</div>'
        + (chips.length ? ('<div class="agenda-chips">' + chips.join('') + '</div>') : '')
        + (notifRows ? ('<div class="agenda-notifs">' + notifRows + '</div>') : '')
        + '</div>';
    }
    html += '<div class="agenda">' + dayHtml + '</div>';
  }
  html += '</div>';
  return html;
}

function notifIcon(n) {
  if (n.severity === 'warning') return '⚠️';
  if (n.type === 'swap-claimed' || n.type === 'generated') return '✅';
  if (n.type === 'swap-open') return '🔁';
  if (n.type === 'understaffed') return '⚠️';
  return 'ℹ️';
}
function notifDayLabel(ts) {
  var d = new Date(ts);
  var ds = dateStrOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
  var t = todayStr();
  if (ds === t) return 'היום';
  if (ds === addDays(t, -1)) return 'אתמול';
  return dowName(dowOfDateStr(ds)) + ', ' + fmtDateShort(ds);
}
function notifListHtml(list) {
  if (!list || !list.length) return '<div class="empty">אין התראות</div>';
  var unreadCount = list.filter(function (n) { return !n.read; }).length;
  var groups = [];
  var lastLabel = null;
  list.forEach(function (n) {
    var label = notifDayLabel(n.ts);
    if (label !== lastLabel) { groups.push({ label: label, items: [] }); lastLabel = label; }
    groups[groups.length - 1].items.push(n);
  });
  var html = unreadCount
    ? '<div class="notif-filterbar"><button class="btn secondary sm" data-action="mark-all-read">סמן הכול כנקרא (' + unreadCount + ')</button></div>'
    : '';
  html += '<div class="notiflist">' + groups.map(function (g) {
    return '<div class="notifgroup-label">' + esc(g.label) + '</div>' + g.items.map(function (n) {
      var time = new Date(n.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      return '<div class="notifitem' + (n.read ? '' : ' unread') + (n.severity === 'warning' ? ' sev-warning' : '') + '">'
        + '<div class="nf-icon">' + notifIcon(n) + '</div>'
        + '<div class="nf-body"><div class="nf-text">' + esc(n.text).replace(/\n/g, '<br>') + '</div><div class="nf-time">' + time + '</div></div>'
        + (n.read ? '' : '<button class="iconbtn" data-action="mark-notif-read" data-id="' + n.id + '" title="סמן כנקרא">✓</button>')
        + '</div>';
    }).join('');
  }).join('') + '</div>';
  return html;
}

/* ---------- schedule (manager) ---------- */
function scheduleHtml() {
  var wk = ui.currentWeek;
  var week = CACHE.weeks[wk];
  var genDow = STATE.settings.weeklyGenerationDow;
  var deadline = deadlineForWeek(nextGenerationWeek(), genDow);

  var roles = [];
  STATE.shiftTemplates.forEach(function (t) { if (t.active && roles.indexOf(t.roleId) === -1) roles.push(t.roleId); });
  if (!roles.length) roles = ['fuel', 'store'];
  if (roles.indexOf(ui.scheduleRole) === -1) ui.scheduleRole = roles[0];
  var roleFilter = ui.scheduleRole;

  var html = '<div class="card"><div class="card-head">'
    + '<h2>לוז שבועי — ' + weekLabel(wk) + '</h2>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn secondary sm" data-action="week-prev">◀ שבוע קודם</button><button class="btn secondary sm" data-action="week-gen-target">שבוע להפקה</button><button class="btn secondary sm" data-action="week-next">שבוע הבא ▶</button></div>'
    + '</div>'
    + (roles.length > 1
        ? ('<div class="seg" style="margin-bottom:12px;">' + roles.map(function (r) {
            return '<button type="button" data-action="set-schedule-role" data-role="' + r + '" class="' + (r === roleFilter ? 'active' : '') + '">' + esc(roleLabelPlural(r)) + '</button>';
          }).join('') + '</div>')
        : '')
    + '<div class="helpcard">הפקת הלוז מיועדת ליום חמישי, לשבוע המתחיל ' + weekLabel(nextGenerationWeek()) + '. הגשת אילוצי עובדים לשבוע זה ננעלת ביום רביעי ' + fmtDateShort(deadline) + ' בשעה 23:59.</div>';

  if (!week) { html += '<div class="empty">טוען…</div></div>'; return html; }

  var roleUnderstaffed = week.understaffed.filter(function (u) {
    var t = STATE.shiftTemplates.find(function (tt) { return tt.id === u.shiftTemplateId; });
    return t && t.roleId === roleFilter;
  });
  if (roleUnderstaffed.length) {
    html += '<div class="banner err">⚠️ יש ' + roleUnderstaffed.length + ' משמרות ' + esc(roleLabelPlural(roleFilter)) + ' ללא איוש מלא השבוע — ראה/י פירוט בכרטיסי הימים למטה וניתן לשבץ ידנית.</div>';
  }
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">'
    + (week.generatedAt ? '<button class="btn secondary sm" data-action="regenerate-force">הפק מחדש (דורס)</button>' : '<button class="btn" data-action="generate-schedule">הפק לוז</button>')
    + '</div></div>';

  html += '<div class="card"><div class="calgrid">' + [0,1,2,3,4,5,6].map(function (d) {
    var ds = addDays(wk, d);
    var dow = dowOfDateStr(ds);
    var templates = STATE.shiftTemplates.filter(function (t) { return t.active && t.roleId === roleFilter && t.days.indexOf(dow) !== -1; });
    var body;
    if (!templates.length) {
      body = '<div class="calday-empty">אין משמרות מוגדרות</div>';
    } else {
      body = templates.map(function (t) {
        var assigned = week.assignments.filter(function (a) { return a.date === ds && a.shiftTemplateId === t.id; });
        var missing = t.needed - assigned.length;
        var manualOnly = t.autoAssign === false; // e.g. store morning: never auto-filled, never "missing" — just an optional manual add
        return '<div class="calevent ' + roleClass(t.roleId) + '">'
          + '<div><span class="pill ' + roleClass(t.roleId) + '">' + esc(t.label) + '</span></div>'
          + '<div class="cal-time">' + t.start + '–' + t.end + '</div>'
          + '<div class="cal-emps">' + assigned.map(function (a) {
              var emp = STATE.employees.find(function (e) { return e.id === a.employeeId; });
              return '<span class="cal-chip">' + esc(emp ? emp.name : '?') + ' <button data-action="remove-assignment" data-aid="' + a.id + '">✕</button></span>';
            }).join('')
          + (missing > 0 && !manualOnly ? '<span class="cal-chip understaffed">חסר ' + missing + '</span>' : '')
          + '</div>'
          + (missing > 0 ? ('<select data-action="assign-slot" data-date="' + ds + '" data-tid="' + t.id + '"><option value="">+ שיבוץ ידני</option>' + STATE.employees.filter(function(e){return e.active && e.roleId===t.roleId;}).map(function(e){return '<option value="'+e.id+'">'+esc(e.name)+'</option>';}).join('') + '</select>') : '')
          + '</div>';
      }).join('');
    }
    return '<div class="calday' + (ds === todayStr() ? ' today' : '') + '"><div class="calday-head"><div class="dname">' + dowName(dow) + '</div><div class="ddate">' + fmtDateShort(ds) + '</div></div><div class="calday-body">' + body + '</div></div>';
  }).join('') + '</div></div>';
  return html;
}

/* ---------- employees (manager) ---------- */
function employeesHtml() {
  var all = CACHE.employeesFull || STATE.employees;
  var genderFilter = ui.employeesGender || 'all';
  var list = genderFilter === 'all' ? all : all.filter(function (e) { return e.gender === genderFilter; });
  return '<div class="card"><div class="card-head"><h2>עובדים</h2><button class="btn" data-action="add-employee">+ הוספת עובד/ת</button></div>'
    + '<div class="seg" style="margin-bottom:12px;">'
      + '<button type="button" data-action="set-employees-gender" data-gender="all" class="' + (genderFilter==='all'?'active':'') + '">הכול (' + all.length + ')</button>'
      + '<button type="button" data-action="set-employees-gender" data-gender="male" class="' + (genderFilter==='male'?'active':'') + '">זכר (' + all.filter(function(e){return e.gender==='male';}).length + ')</button>'
      + '<button type="button" data-action="set-employees-gender" data-gender="female" class="' + (genderFilter==='female'?'active':'') + '">נקבה (' + all.filter(function(e){return e.gender==='female';}).length + ')</button>'
    + '</div>'
    + '<table><thead><tr><th>שם</th><th>תפקיד</th><th>מגדר</th><th>PIN</th><th>סטטוס</th><th></th></tr></thead><tbody>'
    + list.map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td><td><span class="pill ' + roleClass(e.roleId) + '">' + esc(roleLabel(e.roleId)) + '</span></td>'
        + '<td><span class="pill ' + genderClass(e.gender) + '">' + esc(genderLabel(e.gender)) + '</span></td>'
        + '<td class="mono">' + esc(e.pin || '••••') + '</td><td>' + (e.active ? 'פעיל/ה' : 'לא פעיל/ה') + '</td>'
        + '<td><button class="iconbtn" data-action="edit-employee" data-id="' + e.id + '">עריכה</button> <button class="iconbtn" data-action="deactivate-employee" data-id="' + e.id + '">' + (e.active ? 'השבתה' : 'הפעלה') + '</button></td></tr>';
    }).join('') + '</tbody></table>'
    + (list.length ? '' : '<div class="empty">' + (all.length ? 'אין עובדים בסינון הזה' : 'אין עדיין עובדים — הוסיפו את הראשון/ה') + '</div>')
    + '</div>';
}

/* ---------- requests (manager) ---------- */
function swapRowHtml(s) {
  var emp = STATE.employees.find(function (e) { return e.id === s.requesterId; });
  var t = STATE.shiftTemplates.find(function (tt) { return tt.id === s.shiftTemplateId; });
  var claimer = s.claimedBy ? STATE.employees.find(function (e) { return e.id === s.claimedBy; }) : null;
  return '<tr><td>' + esc(emp ? emp.name : '?') + '</td><td><span class="pill ' + roleClass(s.roleId) + '">' + esc(roleLabel(s.roleId)) + '</span></td><td>' + (s.kind === 'noshow' ? 'לא יכול/ה להגיע' : 'בקשת החלפה') + '</td>'
    + '<td style="white-space:nowrap;">' + dayDateHtml(s.date) + '</td>'
    + '<td>' + (t ? ('<span class="pill ' + roleClass(t.roleId) + '">' + esc(t.label) + '</span> <span class="mono">' + t.start + '–' + t.end + '</span>') : '—') + '</td>'
    + '<td><span class="pill status-' + s.status + '">' + (s.status === 'open' ? 'פתוח' : 'נענה') + '</span></td>'
    + '<td>' + (claimer ? esc(claimer.name) : '—') + '</td></tr>';
}
var SWAP_TABLE_HEAD = '<thead><tr><th>מבקש/ת</th><th>תפקיד</th><th>סוג</th><th style="white-space:nowrap;">יום ותאריך</th><th>משמרת</th><th>סטטוס</th><th>נענתה ע"י</th></tr></thead>';

function constraintRowHtml(c) {
  var emp = STATE.employees.find(function (e) { return e.id === c.employeeId; });
  return '<tr><td>' + esc(emp ? emp.name : '?') + '</td>'
    + '<td>' + (c.kind === 'date' ? 'תאריך' : 'קבוע') + '</td>'
    + '<td style="white-space:nowrap;">' + (c.kind === 'date' ? dayDateHtml(c.date) : ('<b>' + dowName(c.dayOfWeek) + '</b> (כל שבוע)')) + '</td>'
    + '<td>' + (c.allDay ? 'כל היום' : (c.start + '–' + c.end)) + '</td></tr>';
}
var CONSTRAINT_TABLE_HEAD = '<thead><tr><th>עובד/ת</th><th>סוג</th><th style="white-space:nowrap;">יום ותאריך</th><th>שעות</th></tr></thead>';

function requestsHtml() {
  var all = CACHE.swaps || [];
  var open = all.filter(function (s) { return s.status === 'open'; });
  var resolved = all.filter(function (s) { return s.status !== 'open'; });
  var notifs = CACHE.notifications || [];
  var unread = notifs.filter(function (n) { return !n.read; }).length;
  var constraints = CACHE.constraints || [];

  var html = '<div class="card"><div class="card-head"><h2>בקשות פתוחות' + (open.length ? ' — ' + open.length : '') + '</h2></div>'
    + (open.length
        ? ('<table class="xltable">' + SWAP_TABLE_HEAD + '<tbody>' + open.map(swapRowHtml).join('') + '</tbody></table>')
        : '<div class="empty">אין בקשות פתוחות כרגע — הכול מטופל</div>')
    + '</div>';

  html += '<div class="card"><div class="card-head"><h2>היסטוריית בקשות</h2></div>'
    + (resolved.length
        ? ('<table class="xltable">' + SWAP_TABLE_HEAD + '<tbody>' + resolved.map(swapRowHtml).join('') + '</tbody></table>')
        : '<div class="empty">אין עדיין היסטוריה</div>')
    + '</div>';

  html += '<div class="card"><div class="card-head"><h2>אילוצים וימי חופש שהוגשו' + (constraints.length ? ' — ' + constraints.length : '') + '</h2></div>'
    + (constraints.length
        ? ('<table class="xltable">' + CONSTRAINT_TABLE_HEAD + '<tbody>' + constraints.map(constraintRowHtml).join('') + '</tbody></table>')
        : '<div class="empty">לא הוגשו אילוצים עדיין</div>')
    + '</div>';

  html += '<div class="card"><div class="card-head"><h2>יומן התראות' + (unread ? ' — ' + unread + ' חדשות' : '') + '</h2></div>' + notifListHtml(notifs) + '</div>';
  return html;
}

/* ---------- hours (manager) ---------- */
function hoursHtml() {
  var mk = ui.currentMonth;
  var data = CACHE.hours[mk];
  var html = '<div class="card"><div class="card-head"><h2>דוח שעות — ' + monthLabel(mk) + '</h2>'
    + '<div><button class="btn secondary sm" data-action="month-prev">◀</button> <button class="btn secondary sm" data-action="month-next">▶</button></div></div>';
  if (!data) { html += '<div class="empty">טוען…</div></div>'; return html; }
  var rows = Object.keys(data).map(function (empId) {
    var emp = STATE.employees.find(function (e) { return e.id === empId; });
    var b = data[empId];
    return '<tr><td>' + esc(emp ? emp.name : empId) + '</td><td class="mono">' + fmtHours(b.regular) + '</td><td class="mono">' + fmtHours(b.overtime) + '</td><td class="mono">' + fmtHours(b.night) + '</td><td class="mono">' + fmtHours(b.shabbat) + '</td><td class="mono"><b>' + fmtHours(b.total) + '</b></td></tr>';
  });
  html += (rows.length ? ('<table><thead><tr><th>עובד/ת</th><th>רגילות</th><th>נוספות</th><th>לילה</th><th>שבת</th><th>סה"כ</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>') : '<div class="empty">אין נתונים לחודש זה</div>');
  html += '</div>';
  html += truthDropzoneHtml();
  return html;
}

/* ---------- hours (manager): "true" hours from the fingerprint-system .xlsx export ---------- */
function truthDropzoneHtml() {
  var html = '<div class="card"><div class="card-head"><h2>דוח שעות אמת</h2>'
    + (CACHE.truthHours ? '<button class="btn secondary sm" data-action="clear-truth-hours">קובץ חדש</button>' : '')
    + '</div>'
    + '<div class="helpcard">גררו לכאן את קובץ האקסל של דוח סיכום השעות שמייצאת מערכת הכניסה־יציאה (טביעת אצבע), ונשווה אותו לעובדים באתר.</div>';
  if (!CACHE.truthHours) {
    html += '<div class="dropzone' + (ui.truthBusy ? ' busy' : '') + '" data-dropzone data-action="' + (ui.truthBusy ? '' : 'open-truth-picker') + '">'
      + '<input type="file" id="truthFileInput" data-action="truth-file-picked" accept=".xlsx" style="display:none">'
      + (ui.truthBusy
          ? '<div class="dropzone-icon">⏳</div><div>מעבד את הקובץ…</div>'
          : '<div class="dropzone-icon">📄</div><div>גררו קובץ אקסל לכאן, או הקליקו לבחירה</div>')
      + '</div>';
    if (ui.truthError) html += '<div class="err-msg">' + esc(ui.truthError) + '</div>';
  } else {
    html += truthHoursHtml();
  }
  html += '</div>';
  return html;
}

function truthHoursHtml() {
  var d = CACHE.truthHours;
  var matched = (d.matched || []).slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'he'); });
  var unmatched = d.unmatched || [];
  var html = '<div class="helpcard">קובץ המערכת מכיל רק חלוקה לשעות רגילות ושעות נוספות (שתי דרגות, לפי חוק) — אין בו פירוט נפרד לשעות לילה או שבת, ולכן דוח זה מציג את החלוקה הזו בלבד ולא את חלוקת רגילות/לילה/שבת/נוספות שמופיעה בדוח השעות הרגיל של האתר.</div>';
  html += matched.length
    ? ('<table class="xltable"><thead><tr><th>עובד/ת</th><th>ימי עבודה</th><th>רגילות</th><th>נוספות א׳</th><th>נוספות ב׳</th><th>חריגות</th><th>סה"כ בפועל</th></tr></thead><tbody>'
        + matched.map(function (m) {
            return '<tr><td>' + esc(m.name) + '</td><td class="mono">' + m.workDays + '</td><td class="mono">' + fmtHours(m.regular) + '</td><td class="mono">' + fmtHours(m.overtimeA) + '</td><td class="mono">' + fmtHours(m.overtimeB) + '</td><td class="mono">' + fmtHours(m.exceptional) + '</td><td class="mono"><b>' + fmtHours(m.totalHours) + '</b></td></tr>';
          }).join('') + '</tbody></table>')
    : '<div class="empty">לא נמצאו עובדים תואמים בקובץ</div>';
  if (unmatched.length) {
    html += '<div class="card-head" style="margin-top:16px;"><h3>לא זוהו באתר — ' + unmatched.length + '</h3></div>'
      + '<div class="helpcard">השמות הבאים מופיעים בקובץ אך לא נמצא עובד/ת תואמ/ת פעיל/ה באתר (למשל שם כתוב אחרת). אפשר לתקן את שם העובד/ת בעמוד "עובדים" כך שיתאים בדיוק לשם בקובץ, ואז להעלות את הקובץ שוב.</div>'
      + '<table class="xltable"><thead><tr><th>שם בקובץ</th><th>ימי עבודה</th><th>סה"כ שעות</th></tr></thead><tbody>'
      + unmatched.map(function (u) { return '<tr><td>' + esc(u.fileName) + '</td><td class="mono">' + u.workDays + '</td><td class="mono">' + fmtHours(u.totalHours) + '</td></tr>'; }).join('')
      + '</tbody></table>';
  }
  return html;
}

/* ---------- settings (manager) ---------- */
function settingsHtml() {
  var m = STATE.settings;
  return '<div class="card"><form data-action="save-settings">'
    + '<h2>הגדרות</h2>'
    + '<div class="field-row"><div class="field"><label>שם החברה</label><input name="companyName" value="' + esc(m.companyName) + '"></div>'
    + '<div class="field"><label>קוד PIN למנהל/ת</label><input name="managerPin" value="' + esc(m.managerPin) + '" pattern="[0-9]{4,6}"></div>'
    + '<div class="field"><label>אימייל למנהל/ת</label><input type="email" name="managerEmail" value="' + esc(m.managerEmail) + '"></div></div>'
    + '<h3>שעות לילה</h3><div class="field-row"><div class="field"><label>תחילת לילה</label><input type="time" name="nightStart" value="' + esc(m.nightStart) + '"></div><div class="field"><label>סיום לילה</label><input type="time" name="nightEnd" value="' + esc(m.nightEnd) + '"></div></div>'
    + '<h3>שבת</h3><div class="field-row"><div class="field"><label>יום תחילה</label><select name="shabbatStartDay">' + [0,1,2,3,4,5,6].map(function(d){return '<option value="'+d+'"'+(d===m.shabbatStartDay?' selected':'')+'>'+dowName(d)+'</option>';}).join('') + '</select></div>'
    + '<div class="field"><label>שעת תחילה</label><input type="time" name="shabbatStartTime" value="' + esc(m.shabbatStartTime) + '"></div>'
    + '<div class="field"><label>יום סיום</label><select name="shabbatEndDay">' + [0,1,2,3,4,5,6].map(function(d){return '<option value="'+d+'"'+(d===m.shabbatEndDay?' selected':'')+'>'+dowName(d)+'</option>';}).join('') + '</select></div>'
    + '<div class="field"><label>שעת סיום</label><input type="time" name="shabbatEndTime" value="' + esc(m.shabbatEndTime) + '"></div></div>'
    + '<h3>כללי שעות</h3><div class="field-row"><div class="field"><label>סף שעות נוספות ליום</label><input type="number" step="0.5" name="dailyOvertimeThreshold" value="' + esc(m.dailyOvertimeThreshold) + '"></div>'
    + '<div class="field"><label>מנוחה מינימלית (שעות)</label><input type="number" name="minRestHours" value="' + esc(m.minRestHours) + '"></div></div>'
    + '<h3>לוז שבועי אוטומטי</h3><div class="field"><label>יום הפקת הלוז</label><select name="weeklyGenerationDow">' + [0,1,2,3,4,5,6].map(function(d){return '<option value="'+d+'"'+(d===m.weeklyGenerationDow?' selected':'')+'>'+dowName(d)+'</option>';}).join('') + '</select></div>'
    + '<div class="helpcard">כל יום חמישי בבוקר, השרת מפיק לבד את הלוז לשבוע הבא — לא צריך לבקש את זה. הגשת אילוצים לשבוע נעולה אוטומטית ביום רביעי בלילה שלפניו.</div>'
    + '<button class="btn" type="submit" style="margin-top:14px;">שמירה</button>'
    + '</form></div>';
}

/* ---------- employee: my schedule ---------- */
function myScheduleHtml() {
  var wk = ui.currentWeek;
  var week = CACHE.weeks[wk];
  var html = '<div class="card"><div class="card-head"><h2>הלוז שלי — ' + weekLabel(wk) + '</h2>'
    + '<div><button class="btn secondary sm" data-action="week-prev">◀</button> <button class="btn secondary sm" data-action="week-next">▶</button></div></div>';
  if (!week) { html += '<div class="empty">טוען…</div></div>'; return html; }
  if (!week.generatedAt) { html += '<div class="empty">הלוז לשבוע זה עדיין לא הופק</div></div>'; return html; }
  var mine = week.assignments.filter(function (a) { return a.employeeId === STATE.me.id; });
  var swaps = CACHE.swaps || [];
  html += '<div class="calgrid">' + [0,1,2,3,4,5,6].map(function (d) {
    var ds = addDays(wk, d);
    var dayAssignments = mine.filter(function (a) { return a.date === ds; });
    var body;
    if (!dayAssignments.length) {
      body = '<div class="calday-empty">אין משמרת</div>';
    } else {
      body = dayAssignments.map(function (a) {
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
        var openReq = swaps.find(function (s) { return s.assignmentId === a.id && s.status === 'open'; });
        return '<div class="calevent ' + roleClass(t ? t.roleId : '') + '">'
          + '<div><span class="pill ' + roleClass(t ? t.roleId : '') + '">' + esc(t ? t.label : '') + '</span></div>'
          + '<div class="cal-time">' + (t ? t.start + '–' + t.end : '') + '</div>'
          + '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">' + (openReq
              ? '<span class="pill status-open">בקשה פתוחה</span>'
              : ('<button class="btn secondary sm" data-action="request-swap" data-aid="' + a.id + '">בקש/י החלפה</button><button class="btn sm danger" data-action="report-noshow" data-aid="' + a.id + '">לא אוכל/ה להגיע</button>'))
          + '</div></div>';
      }).join('');
    }
    return '<div class="calday' + (ds === todayStr() ? ' today' : '') + '"><div class="calday-head"><div class="dname">' + dowName(dowOfDateStr(ds)) + '</div><div class="ddate">' + fmtDateShort(ds) + '</div></div><div class="calday-body">' + body + '</div></div>';
  }).join('') + '</div></div>';
  return html;
}

/* ---------- employee: my constraints ---------- */
function myConstraintsHtml() {
  var list = CACHE.constraints || [];
  var target = nextGenerationWeek();
  var deadline = deadlineForWeek(target, STATE.settings.weeklyGenerationDow);
  return '<div class="card"><div class="card-head"><h2>האילוצים שלי</h2><button class="btn" data-action="add-constraint">+ הוספת אילוץ</button></div>'
    + '<div class="helpcard">אילוצים לשבוע ' + weekLabel(target) + ' ניתן להגיש עד יום רביעי ' + fmtDateShort(deadline) + ' בשעה 23:59. לאחר מכן יש לפנות להנהלה לעדכון ידני.</div>'
    + (list.length ? ('<table class="xltable"><thead><tr><th>סוג</th><th style="white-space:nowrap;">יום ותאריך</th><th>שעות</th><th></th></tr></thead><tbody>' + list.map(function (c) {
        return '<tr><td>' + (c.kind === 'date' ? 'תאריך' : 'קבוע') + '</td><td style="white-space:nowrap;">' + (c.kind === 'date' ? dayDateHtml(c.date) : ('<b>' + dowName(c.dayOfWeek) + '</b> (כל שבוע)')) + '</td><td>' + (c.allDay ? 'כל היום' : (c.start + '–' + c.end)) + '</td><td><button class="iconbtn" data-action="delete-constraint" data-id="' + c.id + '">מחיקה</button></td></tr>';
      }).join('') + '</tbody></table>') : '<div class="empty">לא הוגשו אילוצים</div>')
    + '</div>';
}

/* ---------- employee: my swaps ---------- */
function mySwapsHtml() {
  var swaps = (CACHE.swaps || []).filter(function (s) { return s.requesterId === STATE.me.id || s.roleId === STATE.me.roleId; });
  return '<div class="card"><div class="card-head"><h2>החלפות</h2></div>'
    + (swaps.length ? ('<table class="xltable"><thead><tr><th>מבקש/ת</th><th>סוג</th><th style="white-space:nowrap;">יום ותאריך</th><th>משמרת</th><th>סטטוס</th><th></th></tr></thead><tbody>' + swaps.map(function (s) {
        var emp = STATE.employees.find(function (e) { return e.id === s.requesterId; });
        var isMine = s.requesterId === STATE.me.id;
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === s.shiftTemplateId; });
        var claimer = s.claimedBy ? STATE.employees.find(function (e) { return e.id === s.claimedBy; }) : null;
        var lastCol = '';
        if (!isMine && s.status === 'open') lastCol = '<button class="btn sm" data-action="claim-swap" data-id="' + s.id + '">אני אקח/קח</button>';
        else if (isMine && s.status === 'open') lastCol = '<button class="btn sm danger" data-action="cancel-swap" data-id="' + s.id + '">ביטול בקשה</button>';
        else if (claimer) lastCol = 'נלקח ע"י ' + esc(claimer.name);
        return '<tr><td>' + esc(isMine ? 'אני' : (emp ? emp.name : '?')) + '</td><td>' + (s.kind === 'noshow' ? 'לא יכול/ה להגיע' : 'בקשת החלפה') + '</td>'
          + '<td style="white-space:nowrap;">' + dayDateHtml(s.date) + '</td>'
          + '<td>' + (t ? ('<span class="pill ' + roleClass(t.roleId) + '">' + esc(t.label) + '</span> <span class="mono">' + t.start + '–' + t.end + '</span>') : '—') + '</td>'
          + '<td><span class="pill status-' + s.status + '">' + (s.status === 'open' ? 'פתוח' : 'נענה') + '</span></td>'
          + '<td>' + lastCol + '</td></tr>';
      }).join('') + '</tbody></table>') : '<div class="empty">אין בקשות רלוונטיות כרגע</div>')
    + '</div>';
}

/* ---------- employee: my hours ---------- */
function myHoursHtml() {
  var mk = ui.currentMonth;
  var data = CACHE.hours[mk];
  var html = '<div class="card"><div class="card-head"><h2>השעות שלי — ' + monthLabel(mk) + '</h2>'
    + '<div><button class="btn secondary sm" data-action="month-prev">◀</button> <button class="btn secondary sm" data-action="month-next">▶</button></div></div>';
  if (!data) { html += '<div class="empty">טוען…</div></div>'; return html; }
  var b = data[STATE.me.id];
  if (!b) { html += '<div class="empty">אין נתונים לחודש זה</div></div>'; return html; }
  html += '<div class="kpis"><div class="kpi"><div class="num">' + fmtHours(b.regular) + '</div><div class="lbl">רגילות</div></div>'
    + '<div class="kpi"><div class="num">' + fmtHours(b.overtime) + '</div><div class="lbl">נוספות</div></div>'
    + '<div class="kpi"><div class="num">' + fmtHours(b.night) + '</div><div class="lbl">לילה</div></div>'
    + '<div class="kpi"><div class="num">' + fmtHours(b.shabbat) + '</div><div class="lbl">שבת</div></div>'
    + '<div class="kpi"><div class="num"><b>' + fmtHours(b.total) + '</b></div><div class="lbl">סה"כ</div></div></div></div>';
  return html;
}

/* ---------- employee: notifications ---------- */
function notifsHtml() {
  return '<div class="card"><div class="card-head"><h2>התראות</h2></div>' + notifListHtml(CACHE.notifications || []) + '</div>';
}

/* ---------- modals ---------- */
function modalHtml() {
  if (!ui.modal) return '';
  var m = ui.modal;
  var inner = '';
  if (m.type === 'confirm-generate') {
    inner = '<h3>הפקת לוז לשבוע ' + weekLabel(ui.currentWeek) + '</h3><p>המערכת תשבץ אוטומטית את כל העובדים הפעילים לפי האילוצים שהוגשו, חלוקה הוגנת, וללא שתי משמרות תוך 24 שעות. אפשר לערוך ידנית אחר כך.</p>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;"><button class="btn secondary" data-action="close-modal">ביטול</button><button class="btn" id="confirm-generate-go" data-action="confirm-generate-go">הפק לוז</button></div>';
  } else if (m.type === 'employee-form') {
    var e = m.employee;
    inner = '<h3>' + (e ? 'עריכת עובד/ת' : 'הוספת עובד/ת') + '</h3><form data-action="submit-employee">'
      + '<div class="field"><label>שם</label><input name="name" required value="' + (e ? esc(e.name) : '') + '"></div>'
      + '<div class="field"><label>תפקיד</label><select name="roleId"><option value="fuel"' + (e && e.roleId==='fuel'?' selected':'') + '>מתדלק/ת</option><option value="store"' + (e && e.roleId==='store'?' selected':'') + '>עובד/ת חנות</option>'
        + (e && e.roleId === 'office' ? '<option value="office" selected>פקיד/ה (תפקיד שהוסר — אפשר לבחור תפקיד אחר)</option>' : '') + '</select></div>'
      + '<div class="field"><label>קוד PIN אישי</label><input name="pin" pattern="[0-9]{4,6}" required value="' + (e ? esc(e.pin||'') : '') + '"></div>'
      + '<div class="field"><label>מגדר</label><select name="gender" required><option value="">בחר/י</option><option value="male"' + (e && e.gender==='male'?' selected':'') + '>זכר</option><option value="female"' + (e && e.gender==='female'?' selected':'') + '>נקבה</option></select></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;"><button type="button" class="btn secondary" data-action="close-modal">ביטול</button><button class="btn" type="submit">שמירה</button></div>'
      + '</form>';
  } else if (m.type === 'constraint-form') {
    inner = '<h3>הוספת אילוץ</h3><form data-action="submit-constraint">'
      + '<div class="field"><label>סוג</label><select name="kind" id="constraint-kind-select" onchange="document.getElementById(\'ck-date\').style.display=this.value===\'date\'?\'\':\'none\';document.getElementById(\'ck-dow\').style.display=this.value===\'recurring\'?\'\':\'none\';"><option value="date">תאריך ספציפי</option><option value="recurring">יום קבוע בשבוע</option></select></div>'
      + '<div class="field" id="ck-date"><label>תאריך</label><input type="date" name="date" value="' + todayStr() + '"></div>'
      + '<div class="field" id="ck-dow" style="display:none"><label>יום בשבוע</label><select name="dayOfWeek">' + [0,1,2,3,4,5,6].map(function(d){return '<option value="'+d+'">'+dowName(d)+'</option>';}).join('') + '</select></div>'
      + '<div class="field"><label><input type="checkbox" name="allDay" style="width:auto;display:inline-block;"> כל היום</label></div>'
      + '<div class="field-row"><div class="field"><label>משעה</label><input type="time" name="start" value="08:00"></div><div class="field"><label>עד שעה</label><input type="time" name="end" value="16:00"></div></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;"><button type="button" class="btn secondary" data-action="close-modal">ביטול</button><button class="btn" type="submit">שמירה</button></div>'
      + '</form>';
  }
  return '<div class="modal-bg" data-action="close-modal"><div class="modal">' + inner + '</div></div>';
}

/* ---------- boot ---------- */
boot();
})();
