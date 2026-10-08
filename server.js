'use strict';
/*
 * 签到面板 · 本地 Web 服务（零依赖）
 * 仅监听 127.0.0.1，不对外暴露；API 一律不返回明文凭证。
 *
 * 路由：
 *   GET  /                        面板页面
 *   GET  /api/status              汇总状态（签到 / 积分 / 凭证 / 定时 / 自启）
 *   POST /api/checkin             立即签到一次
 *   GET  /api/log                 日志尾部
 *   POST /api/schedule            设置每日触发时间
 *   POST /api/autostart           开机自动补签 开/关
 *   POST /api/wb-login/start      WorkBuddy 授权：申请 state，返回授权链接
 *   GET  /api/wb-login/poll       轮询授权结果
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const UI = path.join(ROOT, 'ui', 'index.html');
const LOG = path.join(ROOT, 'checkin.log');
const STATE = path.join(ROOT, 'state', 'daily-status.json');
const HISTORY = path.join(ROOT, 'state', 'credits-history.json');
const CFG = path.join(ROOT, 'config.json');
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const VBS = path.join(ROOT, 'run-hidden.vbs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TASK = 'DailyCheckin';
const NET_TASK = 'DailyCheckinOnNet';
const LOGON_TASK = 'DailyCheckinOnLogon';
const HOURLY_TASK = 'DailyCheckinHourly';
const PANEL_CFG = path.join(ROOT, 'state', 'panel.json');
const DEFAULT_TIMES = ['00:01', '09:00', '13:00', '17:00', '21:00'];

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return dflt; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2));
  fs.renameSync(t, p);
}
function decodeJwt(t) {
  try { const s = String(t).split('.')[1]; if (!s) return null;
    return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch (_) { return null; }
}
function ps(cmd, timeout = 30000) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout, windowsHide: true }).trim();
  } catch (e) { return ''; }
}

// ── 积分历史 ─────────────────────────────────────────────────────────────
function loadHistory() { const h = readJson(HISTORY, null); return h && h.days ? h : { days: {} }; }
function bumpDay(h, day, platform, credits) {
  if (!day || !credits) return;
  h.days[day] = h.days[day] || {};
  h.days[day][platform] = Math.max(Number(h.days[day][platform] || 0), Number(credits));
}
/** 从日志里补记 Trae 的领取数额（日志有「获得积分=N」时） */
function harvestTraeFromLog(h) {
  let raw = ''; try { raw = fs.readFileSync(LOG, 'utf8'); } catch (_) { return h; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\[([0-9T:.\-Z]+)\].*\[Trae\]\s*成功.*获得积分=(\d+)/);
    if (m) { const d = new Date(m[1]); if (!isNaN(d)) bumpDay(h, dayKey(d), 'trae', Number(m[2])); }
  }
  return h;
}
function creditsSummary(h) {
  const days = Object.keys(h.days).sort();
  const sum = (k) => days.reduce((a, d) => a + Number(h.days[d][k] || 0), 0);
  const wb = sum('workbuddy'), tr = sum('trae');
  return { workbuddy: wb, trae: tr, total: wb + tr, days: days.length,
    recent: days.slice(-7).reverse().map((d) => ({ date: d, trae: Number(h.days[d].trae || 0), workbuddy: Number(h.days[d].workbuddy || 0) })) };
}

// ── WorkBuddy 实时状态 ───────────────────────────────────────────────────
async function wbLive() {
  const cfg = readJson(CFG, {});
  const wb = (cfg && cfg.workbuddy) || {};
  if (!wb.accessToken) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wb.accessToken, 'X-User-Id': String(wb.uid || ''),
        'X-Domain': String(wb.domain || ''), Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: '{}', signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => null);
    return j && j.code === 0 && j.data ? j.data : null;
  } catch (_) { clearTimeout(timer); return null; }
}

// ── 凭证 ─────────────────────────────────────────────────────────────────
function credsInfo() {
  const cfg = readJson(CFG, {});
  const out = { trae: null, workbuddy: null };
  try {
    const ti = require('./lib/trae.js').resolveTokenInfo();
    if (ti && ti.exp) out.trae = { exp: ti.exp, daysLeft: (ti.exp * 1000 - Date.now()) / 86400000, source: ti.source };
  } catch (_) {}
  const wb = (cfg && cfg.workbuddy) || {};
  if (wb.accessToken) {
    const p = decodeJwt(wb.accessToken);
    out.workbuddy = { exp: p && p.exp ? p.exp : null,
      daysLeft: p && p.exp ? (p.exp * 1000 - Date.now()) / 86400000 : null,
      uid: wb.uid || '', domain: wb.domain || '', refreshedAt: wb.refreshedAt || null,
      hasRefresh: !!wb.refreshToken };
  }
  return out;
}

// ── 计划任务 ─────────────────────────────────────────────────────────────
function scheduleInfo() {
  const q = "\$t=Get-ScheduledTask -TaskName " + TASK + " -ErrorAction SilentlyContinue; if(\$t){ \$i=Get-ScheduledTaskInfo -TaskName " + TASK + "; [pscustomobject]@{ times=@(\$t.Triggers | ForEach-Object { if(\$_.StartBoundary){ ([datetime]\$_.StartBoundary).ToString('HH:mm') } }); state=[string]\$t.State; next=if(\$i.NextRunTime){\$i.NextRunTime.ToString('yyyy-MM-dd HH:mm')}else{''} } | ConvertTo-Json -Compress } else { '{}' }";
  const raw = ps(q);
  let o = {}; try { o = JSON.parse(raw || '{}'); } catch (_) {}
  const times = Array.isArray(o.times) ? o.times.filter(Boolean) : (o.times ? [o.times] : []);
  const netRaw = ps("if(Get-ScheduledTask -TaskName " + NET_TASK + " -ErrorAction SilentlyContinue){'1'}else{'0'}");
  return { times: times.length ? times.sort() : DEFAULT_TIMES, state: o.state || '未注册', next: o.next || '',
    registered: !!o.state, netTask: netRaw === '1' };
}
function setSchedule(times) {
  const list = times.map((t) => "'" + String(t).replace(/'/g, '') + "'").join(',');
  const cmd = "\$tr=@(" + list + ") | ForEach-Object { New-ScheduledTaskTrigger -Daily -At \$_ }; "
    + "Set-ScheduledTask -TaskName " + TASK + " -Trigger \$tr | Out-Null; 'ok'";
  ps(cmd);
  // 以实际写入结果为准，不靠字符串匹配判断成败
  const now = scheduleInfo().times;
  return now.length === times.length && times.every((t) => now.includes(t));
}

// ── 开机自启（登录时补签） ────────────────────────────────────────────────
function autostartInfo() {
  return ps("if(Get-ScheduledTask -TaskName " + LOGON_TASK + " -ErrorAction SilentlyContinue){ (Get-ScheduledTask -TaskName " + LOGON_TASK + ").State.ToString() } else { 'absent' }");
}
function setAutostart(on) {
  if (!on) {
    ps("Unregister-ScheduledTask -TaskName " + LOGON_TASK + " -Confirm:\$false -ErrorAction SilentlyContinue; 'ok'");
    return autostartInfo() === 'absent';
  }
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const cmd = [
    "\$act=New-ScheduledTaskAction -Execute " + q(WSCRIPT) + " -Argument " + q('//B //Nologo "' + VBS + '" --quiet-skip') + " -WorkingDirectory " + q(ROOT),
    "\$me=\"$env:USERDOMAIN\\$env:USERNAME\"",
    // -AtLogOn 必须显式带 -User：不指定时触发器作用于「所有用户」，注册会被拒绝（Access is denied）
    "\$trg=New-ScheduledTaskTrigger -AtLogOn -User \$me",
    "\$trg.Delay='PT30S'",
    "\$set=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "\$pr=New-ScheduledTaskPrincipal -UserId \$me -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName " + LOGON_TASK + " -Action \$act -Trigger \$trg -Settings \$set -Principal \$pr -Force | Out-Null; 'ok'",
  ].join('; ');
  ps(cmd, 60000);
  return autostartInfo() !== 'absent'; // 以实际注册结果为准，不靠字符串匹配
}

// ── 未签到时按间隔自动重试 ────────────────────────────────────────────────
// 用 --quiet-skip 运行：当天两端都已完成时，checkin.js 会在抢锁与写日志之前直接返回，
// 因此这个任务可以全天候常驻 —— 不产生日志噪音，也不发任何网络请求。
const HOURLY_LABEL = { 0.5: '30 分钟', 1: '1 小时', 2: '2 小时', 3: '3 小时', 6: '6 小时' };

function panelCfg() { return readJson(PANEL_CFG, {}) || {}; }

function hourlyInfo() {
  const enabled = ps("if(Get-ScheduledTask -TaskName " + HOURLY_TASK + " -ErrorAction SilentlyContinue){'1'}else{'0'}") === '1';
  const cfg = panelCfg();
  const hours = Number((cfg.hourly && cfg.hourly.hours) || 1);
  let next = '';
  if (enabled) {
    next = ps("try{ (Get-ScheduledTaskInfo -TaskName " + HOURLY_TASK + ").NextRunTime.ToString('yyyy-MM-dd HH:mm') }catch{ '' }");
  }
  return { enabled, hours, label: HOURLY_LABEL[hours] || (hours + ' 小时'), next };
}

function setHourly(enabled, hours) {
  const cfg = panelCfg();
  cfg.hourly = { hours: Number(hours) || 1 };
  writeJson(PANEL_CFG, cfg);

  if (!enabled) {
    ps("Unregister-ScheduledTask -TaskName " + HOURLY_TASK + " -Confirm:\$false -ErrorAction SilentlyContinue; 'ok'");
    return hourlyInfo();
  }

  const mins = Math.max(5, Math.round((Number(hours) || 1) * 60));
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const cmd = [
    "\$act=New-ScheduledTaskAction -Execute " + q(WSCRIPT) + " -Argument " + q('//B //Nologo "' + VBS + '" --quiet-skip') + " -WorkingDirectory " + q(ROOT),
    "\$me=\"$env:USERDOMAIN\\$env:USERNAME\"",
    // 锚点取今天 00:30；RepetitionDuration 给足，即使锚点已过，
    // 任务计划程序仍会按 interval 落在下一个周期点（NextRunTime 会实测核对）。
    "\$anchor=(Get-Date).Date.AddMinutes(30)",
    "\$trg=New-ScheduledTaskTrigger -Once -At \$anchor -RepetitionInterval (New-TimeSpan -Minutes " + mins + ") -RepetitionDuration (New-TimeSpan -Days 3650)",
    "\$set=New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "\$pr=New-ScheduledTaskPrincipal -UserId \$me -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName " + HOURLY_TASK + " -Action \$act -Trigger \$trg -Settings \$set -Principal \$pr -Force -ErrorAction SilentlyContinue | Out-Null",
  ].join('; ');
  ps(cmd, 60000);
  return hourlyInfo(); // 以实际注册结果为准
}

// ── 签到 ─────────────────────────────────────────────────────────────────
let running = false;
function runCheckin(force) {
  if (running) return { ok: false, busy: true, message: '已有一个签到任务在运行' };
  running = true;
  try {
    const args = [path.join(ROOT, 'checkin.js')];
    if (force) args.push('--force');
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 9 * 60 * 1000, windowsHide: true });
    return { ok: r.status === 0, message: (r.stdout || '').trim().split('\n').slice(-6).join('\n'), status: r.status };
  } finally { running = false; }
}

function logTail(n = 60) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch (_) { return []; }
}

// ── WorkBuddy 授权 ───────────────────────────────────────────────────────
const EP = 'https://www.codebuddy.cn', PREFIX = '/v2/plugin';
let oauth = null; // { state, createdAt }
const H = (extra) => Object.assign({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA }, extra || {});
const okc = (j) => !!j && (j.code === 0 || j.code === 200);
const str = (o, ...ks) => { for (const k of ks) { const v = o && o[k]; if (typeof v === 'string' && v) return v; } return ''; };

async function wbLoginStart() {
  const r = await fetch(EP + PREFIX + '/auth/state?platform=workbuddy', { method: 'POST', headers: H(), body: '{}' });
  const j = await r.json().catch(() => null);
  if (!okc(j)) return { ok: false, message: '申请授权失败' };
  const d = (j && j.data) || {};
  const state = str(d, 'state');
  const authUrl = str(d, 'authUrl', 'auth_url', 'url') || (EP + '/login?state=' + state);
  oauth = { state, createdAt: Date.now() };
  return { ok: true, authUrl, expiresIn: 600 };
}
async function wbLoginPoll() {
  if (!oauth) return { done: true, ok: false, message: '没有进行中的授权，请重新发起' };
  if (Date.now() - oauth.createdAt > 10 * 60 * 1000) { oauth = null; return { done: true, ok: false, message: '授权超时，请重新发起' }; }
  const p = await fetch(EP + PREFIX + '/auth/token?state=' + encodeURIComponent(oauth.state), { headers: H() });
  const j = await p.json().catch(() => null);
  if (!okc(j)) return { done: false };
  const d = (j && j.data) || {};
  const at = str(d, 'accessToken', 'access_token');
  if (!at) return { done: false };
  let uid = '', nick = '';
  try {
    const a = await fetch(EP + PREFIX + '/login/account?state=' + encodeURIComponent(oauth.state), { headers: H({ Authorization: 'Bearer ' + at }) });
    const aj = await a.json().catch(() => null);
    const ad = (aj && aj.data) || {};
    uid = str(ad, 'uid') || str(ad.account || {}, 'uid');
    nick = str(ad, 'nickname') || str(ad.account || {}, 'nickname');
  } catch (_) {}
  const cfg = readJson(CFG, {});
  cfg.workbuddy = cfg.workbuddy || {};
  cfg.workbuddy.accessToken = at;
  cfg.workbuddy.refreshToken = str(d, 'refreshToken', 'refresh_token') || cfg.workbuddy.refreshToken || '';
  cfg.workbuddy.uid = uid || cfg.workbuddy.uid || '';
  cfg.workbuddy.domain = str(d, 'domain') || cfg.workbuddy.domain || '';
  cfg.workbuddy.refreshedAt = Date.now();
  if (d.expiresIn) cfg.workbuddy.expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  writeJson(CFG, cfg);
  oauth = null;
  return { done: true, ok: true, nickname: nick, uid };
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
async function buildStatus() {
  const today = dayKey();
  const st = readJson(STATE, null);
  const live = await wbLive();
  const h = harvestTraeFromLog(loadHistory());
  if (live) {
    if (Array.isArray(live.checkin_dates)) for (const d of live.checkin_dates) bumpDay(h, d, 'workbuddy', live.daily_credit || 100);
    if (live.today_checked_in && live.today_credit) bumpDay(h, today, 'workbuddy', live.today_credit);
  }
  writeJson(HISTORY, h);
  const same = st && st.date === today;
  return {
    now: new Date().toISOString(),
    today: {
      trae: same && st.trae && st.trae.ok ? { ok: true, at: st.trae.at } : { ok: false },
      workbuddy: same && st.workbuddy && st.workbuddy.ok ? { ok: true, at: st.workbuddy.at } : { ok: false },
    },
    workbuddyLive: live ? { todayCheckedIn: !!live.today_checked_in, todayCredit: live.today_credit, dailyCredit: live.daily_credit,
      streakDays: live.streak_days, checkinDates: live.checkin_dates || [] } : null,
    credits: creditsSummary(h),
    creds: credsInfo(),
    schedule: scheduleInfo(),
    autostart: autostartInfo() !== 'absent',
    hourly: hourlyInfo(),
    busy: running,
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const JSON_CT = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const send = (res, code, obj) => { res.writeHead(code, JSON_CT); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (_) { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = fs.readFileSync(UI, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // 轻量存活探针：/api/status 会做实时查询（数秒），启动探测必须用这个
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, pid: process.pid });
    if (req.method === 'GET' && p === '/api/status') return send(res, 200, await buildStatus());
    if (req.method === 'GET' && p === '/api/log') return send(res, 200, { lines: logTail(Number(url.searchParams.get('lines') || 60)) });
    if (req.method === 'POST' && p === '/api/checkin') {
      const body = await readBody(req);
      const r = runCheckin(!!body.force);
      return send(res, 200, Object.assign(r, { status: await buildStatus() }));
    }
    if (req.method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      const times = (body.times || []).map((t) => String(t).trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
      if (!times.length) return send(res, 400, { ok: false, message: '至少需要一个合法时间 HH:MM' });
      const ok = setSchedule(Array.from(new Set(times)).sort());
      return send(res, 200, { ok, schedule: scheduleInfo() });
    }
    if (req.method === 'POST' && p === '/api/autostart') {
      const body = await readBody(req);
      const ok = setAutostart(!!body.enabled);
      return send(res, 200, { ok, autostart: autostartInfo() !== 'absent' });
    }
    if (req.method === 'POST' && p === '/api/hourly') {
      const body = await readBody(req);
      const want = !!body.enabled;
      const info = setHourly(want, Number(body.hours) || 1);
      return send(res, 200, { ok: info.enabled === want, hourly: info });
    }
    if (req.method === 'POST' && p === '/api/wb-login/start') return send(res, 200, await wbLoginStart());
    if (req.method === 'GET' && p === '/api/wb-login/poll') return send(res, 200, await wbLoginPoll());
    return send(res, 404, { ok: false, message: 'not found' });
  } catch (e) {
    return send(res, 500, { ok: false, message: String(e && e.message || e) });
  }
});

const PORT = Number(process.env.PANEL_PORT || 8795);
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error('端口 ' + PORT + ' 已被占用，面板可能已在运行。'); process.exit(2); }
  console.error(String(e && e.message || e)); process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('签到面板已启动： http://127.0.0.1:' + PORT + '/');
});
