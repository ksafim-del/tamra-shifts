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
function nextGenerationWeek(){ return addWeeks(weekKeyOf(todayStr()),1); }
function deadlineForWeek(weekStart, genDow){ genDow = genDow==null?4:genDow; return addDays(weekStart, genDow-8); }
function timeToMinutes(t){ var p=t.split(':').map(Number); return p[0]*60+p[1]; }
function durationHours(start,end){ var s=timeToMinutes(start), e=timeToMinutes(end); if(e<=s) e+=1440; return (e-s)/60; }
function fmtHours(h){ return (Math.round(h*10)/10).toLocaleString('he-IL'); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function roleClass(id){ return id==='fuel'?'role-fuel':(id==='store'?'role-store':'role-office'); }
function roleLabel(id){ return id==='fuel'?'מתדלק/ת':(id==='store'?'עובד/ת חנות':'פקיד/ה'); }

/* ---------- app state ---------- */
var STATE = null; // { session, me, settings, employees, shiftTemplates }
var CACHE = { weeks:{}, constraints:null, swaps:null, notifications:null, hours:{}, employeesFull:null };
var PUBLIC_EMPLOYEES = []; // populated pre-login so the employee login dropdown works without auth
var ui = { tab:null, loginMode:'employee', loginErr:'', currentWeek: weekKeyOf(todayStr()), currentMonth: monthKeyOf(new Date()), modal:null, busy:false };

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
    STATE = null; CACHE = { weeks:{}, constraints:null, swaps:null, notifications:null, hours:{}, employeesFull:null }; ui.tab = null;
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
  api('GET', '/api/swaps?status=open').then(function (r) { if (r.ok) CACHE.swaps = r.data.swaps; if (cb) cb(); render(); });
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
      if (r.ok) { toast('שובץ', 'ok'); loadWeek(ui.currentWeek); } else toast('שגיאה בשיבוץ', 'err');
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
  if (action === 'mark-notif-read') {
    var nid = el.getAttribute('data-id');
    api('POST', '/api/notifications/' + nid + '/read').then(function () { loadNotifications(); });
    return;
  }
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
    var payload = { name: f.get('name'), roleId: f.get('roleId'), pin: f.get('pin') };
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
});

function ensureTabData() {
  if (!STATE) return;
  var tab = ui.tab;
  if (tab === 'schedule' || tab === 'myschedule') { if (!CACHE.weeks[ui.currentWeek]) loadWeek(ui.currentWeek); }
  if (tab === 'overview') { if (!CACHE.weeks[weekKeyOf(todayStr())]) loadWeek(weekKeyOf(todayStr())); if (!CACHE.swaps) loadSwaps(); }
  if (tab === 'employees' && !CACHE.employeesFull) loadEmployeesFull();
  if (tab === 'requests' && !CACHE.swaps) loadSwaps();
  if ((tab === 'myconstraints') && !CACHE.constraints) loadConstraints();
  if ((tab === 'hours' || tab === 'myhours') && !CACHE.hours[ui.currentMonth]) loadHours(ui.currentMonth);
  if ((tab === 'mynotifs' || tab === 'overview') && !CACHE.notifications) loadNotifications();
  if (tab === 'myswaps' && !CACHE.swaps) loadSwaps();
}

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
    ? [['overview', 'סקירה'], ['schedule', 'לוז שבועי'], ['employees', 'עובדים'], ['requests', 'בקשות'], ['hours', 'דוח שעות'], ['settings', 'הגדרות']]
    : [['myschedule', 'הלוז שלי'], ['myconstraints', 'האילוצים שלי'], ['myswaps', 'החלפות'], ['myhours', 'השעות שלי'], ['mynotifs', 'התראות']];
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
    + '<div class="tabbar">' + tabs.map(function (t) { return '<button data-action="set-tab" data-tab="' + t[0] + '" class="' + (ui.tab === t[0] ? 'active' : '') + '">' + t[1] + '</button>'; }).join('') + '</div>'
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
  var html = '<div class="kpis">'
    + '<div class="kpi"><div class="num">' + (STATE.employees.filter(function(e){return e.active;}).length) + '</div><div class="lbl">עובדים פעילים</div></div>'
    + '<div class="kpi"><div class="num">' + (understaffed == null ? '—' : understaffed) + '</div><div class="lbl">משמרות חסרות איוש (שבוע נוכחי)</div></div>'
    + '<div class="kpi"><div class="num">' + unread + '</div><div class="lbl">התראות שלא נקראו</div></div>'
    + '</div>';

  html += '<div class="card"><div class="card-head"><h2>תקלות והודעות לפי יום — ' + weekLabel(wk) + '</h2></div>';
  if (!week) {
    html += '<div class="empty">טוען…</div>';
  } else {
    var swaps = CACHE.swaps || [];
    var rows = '';
    for (var d = 0; d < 7; d++) {
      var ds = addDays(wk, d);
      var dow = new Date(ds.split('-').map(Number)[0], ds.split('-').map(Number)[1] - 1, ds.split('-').map(Number)[2]).getDay();
      var items = [];
      week.understaffed.filter(function (u) { return u.date === ds; }).forEach(function (u) {
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === u.shiftTemplateId; });
        items.push('<span class="understaffed">חסר ' + u.missing + '</span> ' + esc(t ? t.label : ''));
      });
      week.assignments.filter(function (a) { return a.date === ds && a.noShow; }).forEach(function (a) {
        var emp = STATE.employees.find(function (e) { return e.id === a.employeeId; });
        var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
        items.push('<span class="understaffed">לא הגיע/ה</span> ' + esc(emp ? emp.name : '?') + (t ? ' (' + esc(t.label) + ')' : ''));
      });
      week.assignments.filter(function (a) { return a.date === ds; }).forEach(function (a) {
        var openSwap = swaps.find(function (s) { return s.assignmentId === a.id && s.status === 'open'; });
        if (openSwap) {
          var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
          items.push('<span class="pill status-open">בקשת החלפה פתוחה</span> ' + esc(t ? t.label : ''));
        }
      });
      var dayNotifs = notifs.filter(function (n) {
        var nd = new Date(n.ts);
        return dateStrOf(nd.getFullYear(), nd.getMonth() + 1, nd.getDate()) === ds;
      });
      var notifItems = dayNotifs.map(function (n) {
        var time = new Date(n.ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
        return '<span class="mono">' + time + '</span> ' + (n.read ? '' : '<b>') + esc(n.text) + (n.read ? '' : '</b>');
      });
      rows += '<tr><td style="width:120px"><b>' + dowName(dow) + '</b> <span class="mono">' + fmtDateShort(ds) + '</span></td>'
        + '<td>' + (items.length ? items.join('<br>') : '<span style="color:var(--ok)">אין תקלות</span>') + '</td>'
        + '<td>' + (notifItems.length ? notifItems.join('<br>') : '—') + '</td>'
        + '</tr>';
    }
    html += '<table class="xltable"><thead><tr><th style="width:120px">יום</th><th>תקלות</th><th>הודעות</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  html += '</div>';
  return html;
}

function notifListHtml(list) {
  if (!list || !list.length) return '<div class="empty">אין התראות</div>';
  return '<table><tbody>' + list.map(function (n) {
    return '<tr><td style="width:110px" class="mono">' + new Date(n.ts).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</td>'
      + '<td>' + (n.read ? '' : '<b>') + esc(n.text).replace(/\n/g, '<br>') + (n.read ? '' : '</b>') + '</td>'
      + '<td style="width:80px">' + (n.read ? '' : '<button class="iconbtn" data-action="mark-notif-read" data-id="' + n.id + '">סמן כנקרא</button>') + '</td></tr>';
  }).join('') + '</tbody></table>';
}

/* ---------- schedule (manager) ---------- */
function scheduleHtml() {
  var wk = ui.currentWeek;
  var week = CACHE.weeks[wk];
  var genDow = STATE.settings.weeklyGenerationDow;
  var deadline = deadlineForWeek(nextGenerationWeek(), genDow);
  var html = '<div class="card"><div class="card-head">'
    + '<h2>לוז שבועי — ' + weekLabel(wk) + '</h2>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn secondary sm" data-action="week-prev">◀ שבוע קודם</button><button class="btn secondary sm" data-action="week-gen-target">שבוע להפקה</button><button class="btn secondary sm" data-action="week-next">שבוע הבא ▶</button></div>'
    + '</div>'
    + '<div class="helpcard">הפקת הלוז מיועדת ליום חמישי, לשבוע המתחיל ' + weekLabel(nextGenerationWeek()) + '. הגשת אילוצי עובדים לשבוע זה ננעלת ביום רביעי ' + fmtDateShort(deadline) + ' בשעה 23:59.</div>';

  if (!week) { html += '<div class="empty">טוען…</div></div>'; return html; }

  if (week.understaffed && week.understaffed.length) {
    html += '<div class="banner err">יש ' + week.understaffed.length + ' משמרות ללא איוש מלא השבוע — ראה/י פירוט בכרטיסי הימים למטה וניתן לשבץ ידנית.</div>';
  }
  html += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">'
    + (week.generatedAt ? '<button class="btn secondary sm" data-action="regenerate-force">הפק מחדש (דורס)</button>' : '<button class="btn" data-action="generate-schedule">הפק לוז</button>')
    + '</div></div>';

  html += '<div class="card"><table><thead><tr><th style="width:110px">יום</th><th>משמרת</th><th style="width:110px">שעות</th><th>עובדים משובצים</th></tr></thead><tbody>';
  for (var d = 0; d < 7; d++) {
    var ds = addDays(wk, d);
    var dow = new Date(ds.split('-').map(Number)[0], ds.split('-').map(Number)[1]-1, ds.split('-').map(Number)[2]).getDay();
    var templates = STATE.shiftTemplates.filter(function (t) { return t.active && t.days.indexOf(dow) !== -1; });
    var dayCell = '<td rowspan="' + Math.max(templates.length, 1) + '" style="vertical-align:top;border-inline-end:1px solid var(--border);"><b>' + dowName(dow) + '</b><br><span class="mono">' + fmtDateShort(ds) + '</span></td>';
    if (!templates.length) {
      html += '<tr>' + dayCell + '<td colspan="3" class="empty">אין משמרות מוגדרות ליום זה</td></tr>';
      continue;
    }
    templates.forEach(function (t, ti) {
      var assigned = week.assignments.filter(function (a) { return a.date === ds && a.shiftTemplateId === t.id; });
      var missing = t.needed - assigned.length;
      html += '<tr>' + (ti === 0 ? dayCell : '')
        + '<td><span class="pill ' + roleClass(t.roleId) + '">' + esc(t.label) + '</span></td>'
        + '<td class="mono">' + t.start + '–' + t.end + '</td>'
        + '<td>' + assigned.map(function (a) {
            var emp = STATE.employees.find(function (e) { return e.id === a.employeeId; });
            return '<span style="margin-inline-end:8px;display:inline-block;">' + esc(emp ? emp.name : '?') + ' <button class="iconbtn" data-action="remove-assignment" data-aid="' + a.id + '">✕</button></span>';
          }).join('')
        + (missing > 0 ? ('<span class="understaffed" style="margin-inline-end:8px;">חסר ' + missing + '</span> <select data-action="assign-slot" data-date="' + ds + '" data-tid="' + t.id + '"><option value="">+ שיבוץ ידני</option>' + STATE.employees.filter(function(e){return e.active && e.roleId===t.roleId;}).map(function(e){return '<option value="'+e.id+'">'+esc(e.name)+'</option>';}).join('') + '</select>') : '')
        + '</td></tr>';
    });
  }
  html += '</tbody></table></div>';
  return html;
}

/* ---------- employees (manager) ---------- */
function employeesHtml() {
  var list = CACHE.employeesFull || STATE.employees;
  return '<div class="card"><div class="card-head"><h2>עובדים</h2><button class="btn" data-action="add-employee">+ הוספת עובד/ת</button></div>'
    + '<table><thead><tr><th>שם</th><th>תפקיד</th><th>PIN</th><th>סטטוס</th><th></th></tr></thead><tbody>'
    + list.map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td><td><span class="pill ' + roleClass(e.roleId) + '">' + esc(roleLabel(e.roleId)) + '</span></td>'
        + '<td class="mono">' + esc(e.pin || '••••') + '</td><td>' + (e.active ? 'פעיל/ה' : 'לא פעיל/ה') + '</td>'
        + '<td><button class="iconbtn" data-action="edit-employee" data-id="' + e.id + '">עריכה</button> <button class="iconbtn" data-action="deactivate-employee" data-id="' + e.id + '">' + (e.active ? 'השבתה' : 'הפעלה') + '</button></td></tr>';
    }).join('') + '</tbody></table>'
    + (list.length ? '' : '<div class="empty">אין עדיין עובדים — הוסיפו את הראשון/ה</div>')
    + '</div>';
}

/* ---------- requests (manager) ---------- */
function requestsHtml() {
  var swaps = CACHE.swaps || [];
  return '<div class="card"><div class="card-head"><h2>בקשות החלפה / הברזה פתוחות</h2></div>'
    + (swaps.length ? ('<table><thead><tr><th>מבקש/ת</th><th>תפקיד</th><th>סוג</th><th>סטטוס</th></tr></thead><tbody>' + swaps.map(function (s) {
        var emp = STATE.employees.find(function (e) { return e.id === s.requesterId; });
        return '<tr><td>' + esc(emp ? emp.name : '?') + '</td><td><span class="pill ' + roleClass(s.roleId) + '">' + esc(roleLabel(s.roleId)) + '</span></td><td>' + (s.kind === 'noshow' ? 'לא יכול/ה להגיע' : 'בקשת החלפה') + '</td><td><span class="pill status-' + s.status + '">' + (s.status === 'open' ? 'פתוח' : 'נענה') + '</span></td></tr>';
      }).join('') + '</tbody></table>') : '<div class="empty">אין בקשות פתוחות כרגע</div>')
    + '</div>'
    + '<div class="card"><div class="card-head"><h2>כל ההתראות למנהל</h2></div>' + notifListHtml(CACHE.notifications || []) + '</div>';
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
  var mine = week.assignments.filter(function (a) { return a.employeeId === STATE.me.id; });
  if (!mine.length) { html += '<div class="empty">אין לך משמרות בשבוע זה' + (week.generatedAt ? '' : ' (הלוז עדיין לא הופק)') + '</div></div>'; return html; }
  var swaps = CACHE.swaps || [];
  html += '<table class="xltable"><thead><tr><th>תאריך</th><th>משמרת</th><th>שעות</th><th></th></tr></thead><tbody>'
    + mine.map(function (a) {
      var t = STATE.shiftTemplates.find(function (tt) { return tt.id === a.shiftTemplateId; });
      var openReq = swaps.find(function (s) { return s.assignmentId === a.id && s.status === 'open'; });
      return '<tr><td>' + fmtDateShort(a.date) + '</td><td><span class="pill ' + roleClass(t ? t.roleId : '') + '">' + esc(t ? t.label : '') + '</span></td><td class="mono">' + (t ? t.start + '–' + t.end : '') + '</td>'
        + '<td>' + (openReq ? '<span class="pill status-open">בקשה פתוחה</span>' : ('<button class="btn secondary sm" data-action="request-swap" data-aid="' + a.id + '">בקש/י החלפה</button> <button class="btn sm danger" data-action="report-noshow" data-aid="' + a.id + '">לא אוכל/ה להגיע</button>')) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  return html;
}

/* ---------- employee: my constraints ---------- */
function myConstraintsHtml() {
  var list = CACHE.constraints || [];
  var target = nextGenerationWeek();
  var deadline = deadlineForWeek(target, STATE.settings.weeklyGenerationDow);
  return '<div class="card"><div class="card-head"><h2>האילוצים שלי</h2><button class="btn" data-action="add-constraint">+ הוספת אילוץ</button></div>'
    + '<div class="helpcard">אילוצים לשבוע ' + weekLabel(target) + ' ניתן להגיש עד יום רביעי ' + fmtDateShort(deadline) + ' בשעה 23:59. לאחר מכן יש לפנות להנהלה לעדכון ידני.</div>'
    + (list.length ? ('<table><thead><tr><th>סוג</th><th>מתי</th><th>שעות</th><th></th></tr></thead><tbody>' + list.map(function (c) {
        return '<tr><td>' + (c.kind === 'date' ? 'תאריך' : 'קבוע') + '</td><td>' + (c.kind === 'date' ? fmtDateShort(c.date) : dowName(c.dayOfWeek)) + '</td><td>' + (c.allDay ? 'כל היום' : (c.start + '–' + c.end)) + '</td><td><button class="iconbtn" data-action="delete-constraint" data-id="' + c.id + '">מחיקה</button></td></tr>';
      }).join('') + '</tbody></table>') : '<div class="empty">לא הוגשו אילוצים</div>')
    + '</div>';
}

/* ---------- employee: my swaps ---------- */
function mySwapsHtml() {
  var swaps = (CACHE.swaps || []).filter(function (s) { return s.requesterId === STATE.me.id || s.roleId === STATE.me.roleId; });
  return '<div class="card"><div class="card-head"><h2>החלפות</h2></div>'
    + (swaps.length ? ('<table><thead><tr><th>מבקש/ת</th><th>סוג</th><th>סטטוס</th><th></th></tr></thead><tbody>' + swaps.map(function (s) {
        var emp = STATE.employees.find(function (e) { return e.id === s.requesterId; });
        var isMine = s.requesterId === STATE.me.id;
        return '<tr><td>' + esc(isMine ? 'אני' : (emp ? emp.name : '?')) + '</td><td>' + (s.kind === 'noshow' ? 'לא יכול/ה להגיע' : 'בקשת החלפה') + '</td><td><span class="pill status-' + s.status + '">' + (s.status === 'open' ? 'פתוח' : 'נענה') + '</span></td>'
          + '<td>' + (!isMine && s.status === 'open' ? ('<button class="btn sm" data-action="claim-swap" data-id="' + s.id + '">אני אקח/קח</button>') : '') + '</td></tr>';
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
      + '<div class="field"><label>תפקיד</label><select name="roleId"><option value="fuel"' + (e && e.roleId==='fuel'?' selected':'') + '>מתדלק/ת</option><option value="store"' + (e && e.roleId==='store'?' selected':'') + '>עובד/ת חנות</option><option value="office"' + (e && e.roleId==='office'?' selected':'') + '>פקיד/ה</option></select></div>'
      + '<div class="field"><label>קוד PIN אישי</label><input name="pin" pattern="[0-9]{4,6}" required value="' + (e ? esc(e.pin||'') : '') + '"></div>'
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
