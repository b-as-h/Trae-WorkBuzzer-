'use strict';
/*
 * 签到面板 · 本地 Web 服务（零依赖）
 * 仅监听 127.0.0.1，不对外暴露；API 一律不返回明文凭证。
 *
 * 路由：
 *   GET  /                        面板页面
 *   GET  /api/ping                存活探测（轻量）
 *   GET  /api/status              汇总状态（账号 / 签到 / 积分 / 凭证 / 定时 / 自启）
 *   POST /api/checkin             立即签到（可按账号批量：body.accounts = [账号ID]）
 *   GET  /api/log                 日志尾部
 *   GET  /api/accounts            账号列表
 *   POST /api/accounts            账号增删改（add / rename / enable / sides / trae-token / remove）
 *   POST /api/schedule            设置每日触发时间
 *   POST /api/autostart           开机自动补签 开/关
 *   POST /api/hourly              未签到时按间隔重试 开/关 + 间隔
 *   POST /api/wb-login/start      指定账号的 WorkBuddy 授权：申请 state，返回授权链接
 *   GET  /api/wb-login/poll       轮询授权结果（按账号写回令牌）
 *
 * 多账号数据都在 config.json 的 accounts 里；旧版单账号配置会被 lib/accounts.js
 * 自动视为一个 ID 为 default 的账号，面板第一次做账号管理时落盘迁移。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const accountsLib = require('./lib/accounts.js');
const dailyState = require('./lib/daily-state.js');
const traeLib = require('./lib/trae.js');

const ROOT = __dirname;
const UI = path.join(ROOT, 'ui', 'index.html');
const LOG = path.join(ROOT, 'checkin.log');
const HISTORY = path.join(ROOT, 'state', 'credits-history.json');
const CFG = accountsLib.CONFIG_PATH;
const WSCRIPT = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const VBS = path.join(ROOT, 'run-hidden.vbs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const TASK = 'DailyCheckin';
const NET_TASK = 'DailyCheckinOnNet';
const LOGON_TASK = 'DailyCheckinOnLogon';
const HOURLY_TASK = 'DailyCheckinHourly';
const PANEL_CFG = path.join(ROOT, 'state', 'panel.json');
const DEFAULT_TIMES = ['00:01', '09:00', '13:00', '17:00', '21:00'];
/** 批量签到的最长等待：按账号顺序执行，账号多时确实会久一些 */
const CHECKIN_TIMEOUT_MS = 15 * 60 * 1000;
/** WorkBuddy 实时状态缓存：面板每 30 秒轮询一次，没必要每个账号每次都打接口 */
const LIVE_TTL_MS = 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());

function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return dflt; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const t = p + '.tmp';
  fs.writeFileSync(t, JSON.stringify(obj, null, 2));
  fs.renameSync(t, p);
}
function loadConfig() {
  try {
    return accountsLib.readConfig(CFG);
  } catch (_) {
    return { accounts: [] };
  }
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
function bumpDay(h, day, platform, credits, accountId) {
  if (!day || !credits) return;
  h.days[day] = h.days[day] || {};
  h.days[day][platform] = Math.max(Number(h.days[day][platform] || 0), Number(credits));
  if (accountId) {
    const by = h.days[day].byAccount = h.days[day].byAccount || {};
    by[accountId] = by[accountId] || {};
    by[accountId][platform] = Math.max(Number(by[accountId][platform] || 0), Number(credits));
  }
}
/**
 * 从日志里补记签到数额。
 * 日志格式：`[ISO] [账号:名称] [Trae|WorkBuddy] 成功：…`（单账号时没有「账号:」段，
 * 与 v1 日志完全一致，这里按第一个账号归属，保证老日志也能统计）。
 */
function harvestFromLog(h, accountList) {
  let raw = ''; try { raw = fs.readFileSync(LOG, 'utf8'); } catch (_) { return h; }
  const byName = new Map();
  for (const a of accountList || []) byName.set(a.name, a.id);
  const fallback = accountList && accountList.length ? accountList[0].id : null;
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\[([0-9T:.\-Z]+)\]\s*(?:\[账号:([^\]]+)\]\s*)?\[(Trae|WorkBuddy)\]\s*成功(.*)$/);
    if (!m) continue;
    const d = new Date(m[1]); if (isNaN(d)) continue;
    const acctId = (m[2] && byName.get(m[2])) || fallback;
    const rest = m[4] || '';
    if (m[3] === 'Trae') {
      const c = rest.match(/获得积分=(\d+)/);
      if (c) bumpDay(h, dayKey(d), 'trae', Number(c[1]), acctId);
    } else {
      const c = rest.match(/"credits?"\s*:\s*(\d+)/);
      if (c) bumpDay(h, dayKey(d), 'workbuddy', Number(c[1]), acctId);
    }
  }
  return h;
}
function creditsSummary(h, accountId) {
  const days = Object.keys(h.days).sort();
  const pick = (d, k) => {
    const day = h.days[d] || {};
    if (accountId) return Number((day.byAccount && day.byAccount[accountId] && day.byAccount[accountId][k]) || 0);
    return Number(day[k] || 0);
  };
  const sum = (k) => days.reduce((a, d) => a + pick(d, k), 0);
  const wb = sum('workbuddy'), tr = sum('trae');
  return {
    workbuddy: wb, trae: tr, total: wb + tr, days: days.filter((d) => pick(d, 'workbuddy') || pick(d, 'trae')).length,
    recent: days.slice(-7).reverse().map((d) => ({ date: d, trae: pick(d, 'trae'), workbuddy: pick(d, 'workbuddy') })),
  };
}

// ── WorkBuddy 实时状态（按账号，带缓存） ─────────────────────────────────
const liveCache = new Map(); // accountId -> { at, data }
async function wbLive(cfg, acct, useCache = true) {
  const wb = accountsLib.effectiveWorkbuddy(cfg, acct);
  if (!wb.accessToken) return null;
  const cached = liveCache.get(acct.id);
  if (useCache && cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.data;
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
    const data = j && j.code === 0 && j.data ? j.data : null;
    liveCache.set(acct.id, { at: Date.now(), data });
    return data;
  } catch (_) { clearTimeout(timer); return cached ? cached.data : null; }
}

// ── 凭证 ─────────────────────────────────────────────────────────────────
function traeCredsInfo(cfg, acct) {
  const eff = accountsLib.effectiveTrae(cfg, acct);
  const manualToken = !!String(eff.manualToken || '').trim();
  let info = null;
  try { info = traeLib.resolveTokenInfo(eff); } catch (_) { info = null; }
  if (!info && !manualToken) return null;
  const exp = info && info.exp ? info.exp : null;
  return {
    configured: true,
    exp,
    daysLeft: exp ? (exp * 1000 - Date.now()) / 86400000 : null,
    source: info ? info.source : 'manual(config)',
    manual: manualToken,
    deviceId: String(eff.deviceId || ''),
  };
}
function wbCredsInfo(cfg, acct) {
  const wb = accountsLib.effectiveWorkbuddy(cfg, acct);
  if (!wb.accessToken && !wb.refreshToken) return null;
  const p = decodeJwt(wb.accessToken);
  return {
    configured: true,
    exp: p && p.exp ? p.exp : null,
    daysLeft: p && p.exp ? (p.exp * 1000 - Date.now()) / 86400000 : null,
    uid: wb.uid || '', domain: wb.domain || '', refreshedAt: wb.refreshedAt || null,
    hasRefresh: !!wb.refreshToken,
  };
}

/** 单账号摘要（面板账号管理卡片用） */
function accountSummary(cfg, acct, st, h) {
  const today = {};
  for (const side of accountsLib.SIDES) {
    const slot = dailyState.accountSlot(st, acct.id);
    const done = dailyState.isDone(st, acct.id, side);
    today[side] = done ? { ok: true, at: (slot[side] && slot[side].at) || null } : { ok: false };
  }
  const c = creditsSummary(h, acct.id);
  return {
    id: acct.id,
    name: acct.name,
    enabled: acct.enabled !== false,
    legacy: !!acct.legacy,
    sides: { trae: accountsLib.sideEnabled(acct, 'trae'), workbuddy: accountsLib.sideEnabled(acct, 'workbuddy') },
    today,
    credits: { trae: c.trae, workbuddy: c.workbuddy, total: c.total },
    creds: { trae: traeCredsInfo(cfg, acct), workbuddy: wbCredsInfo(cfg, acct) },
  };
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
// 用 --quiet-skip 运行：当天所有账号都已完成时，checkin.js 会在抢锁与写日志之前直接返回，
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

// ── 账号管理 ─────────────────────────────────────────────────────────────
/** 读 → 改 → 原子写回 config.json；返回值由 fn 决定 */
function mutateConfig(fn) {
  const cfg = loadConfig();
  const out = fn(cfg);
  accountsLib.writeConfig(cfg);
  return out;
}
function accountListOut(withLive) {
  const cfg = loadConfig();
  const list = accountsLib.resolveAccounts(cfg);
  const st = dailyState.loadState();
  const h = harvestFromLog(loadHistory(), list);
  const out = list.map((a) => accountSummary(cfg, a, st, h));
  if (withLive) {
    for (let i = 0; i < out.length; i += 1) {
      const live = liveCache.get(list[i].id);
      if (live && live.data) out[i].live = { todayCheckedIn: !!live.data.today_checked_in, streakDays: live.data.streak_days };
    }
  }
  return out;
}

// ── 签到 ─────────────────────────────────────────────────────────────────
let running = false;
function runCheckin(force, accountIds) {
  if (running) return { ok: false, busy: true, message: '已有一个签到任务在运行' };
  running = true;
  try {
    const args = [path.join(ROOT, 'checkin.js')];
    if (force) args.push('--force');
    if (Array.isArray(accountIds) && accountIds.length) args.push('--accounts', accountIds.map((s) => String(s).trim()).filter(Boolean).join(','));
    const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: CHECKIN_TIMEOUT_MS, windowsHide: true });
    return { ok: r.status === 0, message: (r.stdout || '').trim().split('\n').slice(-6).join('\n'), status: r.status };
  } finally { running = false; }
}

function logTail(n = 60) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-n);
  } catch (_) { return []; }
}

// ── WorkBuddy 授权（按账号） ──────────────────────────────────────────────
const EP = 'https://www.codebuddy.cn', PREFIX = '/v2/plugin';
let oauth = null; // { state, createdAt, accountId }
const H = (extra) => Object.assign({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA }, extra || {});
const okc = (j) => !!j && (j.code === 0 || j.code === 200);
const str = (o, ...ks) => { for (const k of ks) { const v = o && o[k]; if (typeof v === 'string' && v) return v; } return ''; };

function resolveAccountOrThrow(cfg, idOrName) {
  const acct = idOrName ? accountsLib.findAccount(cfg, idOrName) : accountsLib.resolveAccounts(cfg)[0];
  if (!acct) throw new Error('未找到账号：' + (idOrName || '(空)'));
  return acct;
}

async function wbLoginStart(accountId) {
  const cfg = loadConfig();
  const acct = resolveAccountOrThrow(cfg, accountId);
  const r = await fetch(EP + PREFIX + '/auth/state?platform=workbuddy', { method: 'POST', headers: H(), body: '{}' });
  const j = await r.json().catch(() => null);
  if (!okc(j)) return { ok: false, message: '申请授权失败' };
  const d = (j && j.data) || {};
  const state = str(d, 'state');
  const authUrl = str(d, 'authUrl', 'auth_url', 'url') || (EP + '/login?state=' + state);
  oauth = { state, createdAt: Date.now(), accountId: acct.id };
  return { ok: true, authUrl, expiresIn: 600, accountId: acct.id, accountName: acct.name };
}
async function wbLoginPoll(accountId) {
  if (!oauth) return { done: true, ok: false, message: '没有进行中的授权，请重新发起' };
  if (accountId && oauth.accountId !== accountId) {
    return { done: true, ok: false, message: '当前授权针对的是另一个账号，请重新发起' };
  }
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
  const cfg = loadConfig();
  const acct = accountsLib.findAccount(cfg, oauth.accountId) || accountsLib.resolveAccounts(cfg)[0];
  const patch = {
    accessToken: at,
    refreshToken: str(d, 'refreshToken', 'refresh_token') || accountsLib.effectiveWorkbuddy(cfg, acct).refreshToken || '',
    uid: uid || accountsLib.effectiveWorkbuddy(cfg, acct).uid || '',
    domain: str(d, 'domain') || accountsLib.effectiveWorkbuddy(cfg, acct).domain || '',
    refreshedAt: Date.now(),
  };
  if (d.expiresIn) patch.expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  accountsLib.setWorkbuddyCreds(cfg, acct.id, patch);
  accountsLib.writeConfig(cfg);
  // 换了/重授了 WorkBuddy 账号后，当天「已完成」的判断可能属于上一个账号，清掉让它重新核对
  try {
    const st = dailyState.loadState();
    if (st.accounts && st.accounts[acct.id]) { st.accounts[acct.id].workbuddy = null; dailyState.saveState(st); }
  } catch (_) {}
  liveCache.delete(acct.id);
  oauth = null;
  return { done: true, ok: true, nickname: nick, uid, accountId: acct.id, accountName: acct.name };
}

// ── 汇总 ─────────────────────────────────────────────────────────────────
async function buildStatus() {
  const today = dayKey();
  const cfg = loadConfig();
  const list = accountsLib.resolveAccounts(cfg);
  const st = dailyState.loadState();
  const h = harvestFromLog(loadHistory(), list);

  // WorkBuddy 实时状态：按账号查（带 60 秒缓存），顺带把签到日期补进历史
  const lives = await Promise.all(list.map((a) => wbLive(cfg, a)));
  for (let i = 0; i < list.length; i += 1) {
    const live = lives[i];
    if (!live) continue;
    if (Array.isArray(live.checkin_dates)) for (const d of live.checkin_dates) bumpDay(h, d, 'workbuddy', live.daily_credit || 100, list[i].id);
    if (live.today_checked_in && live.today_credit) bumpDay(h, today, 'workbuddy', live.today_credit, list[i].id);
  }
  writeJson(HISTORY, h);

  const accountsOut = list.map((a, i) => {
    const s = accountSummary(cfg, a, st, h);
    const live = lives[i];
    if (live) s.live = { todayCheckedIn: !!live.today_checked_in, todayCredit: live.today_credit, dailyCredit: live.daily_credit,
      streakDays: live.streak_days, checkinDates: live.checkin_dates || [] };
    return s;
  });
  const first = accountsOut[0] || null;
  // 兼容字段 workbuddyLive：取第一个查到实时状态的账号
  const firstWithWb = accountsOut.find((a) => a.live) || first;
  const doneAccounts = accountsOut.filter((a) => {
    const sides = Object.keys(a.sides).filter((k) => a.sides[k]);
    return sides.length > 0 && sides.every((k) => a.today[k].ok);
  }).length;
  const enabledAccounts = accountsOut.filter((a) => a.enabled).length;

  return {
    now: new Date().toISOString(),
    busy: running,
    accountCount: accountsOut.length,
    enabledCount: enabledAccounts,
    doneCount: doneAccounts,
    accounts: accountsOut,
    // ── 兼容字段（v1 面板/脚本只认这些）：一律指向第一个账号 ──
    today: first ? first.today : { trae: { ok: false }, workbuddy: { ok: false } },
    workbuddyLive: firstWithWb && firstWithWb.live ? firstWithWb.live : null,
    credits: creditsSummary(h),
    creds: first ? first.creds : { trae: null, workbuddy: null },
    // ── 全局设置 ──
    schedule: scheduleInfo(),
    autostart: autostartInfo() !== 'absent',
    hourly: hourlyInfo(),
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const JSON_CT = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
const send = (res, code, obj) => { res.writeHead(code, JSON_CT); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (_) { r({}); } }); });

/** 账号管理接口的统一实现：改完 config 后回读账号列表，避免"写了但没生效"的假成功 */
function handleAccountsAction(body) {
  const action = String(body.action || '').toLowerCase();
  const id = body.id ? String(body.id) : '';
  let message = '';
  const cfg = loadConfig();
  if (action === 'add') {
    const acct = accountsLib.addAccount(cfg, body.name);
    accountsLib.writeConfig(cfg);
    message = '已添加账号「' + acct.name + '」，默认只开启 WorkBuddy，请为它单独授权';
  } else if (action === 'rename') {
    const name = String(body.name || '').trim();
    if (!name) return { ok: false, message: '账号名不能为空' };
    const a = accountsLib.updateAccount(cfg, id, { name });
    if (!a) return { ok: false, message: '未找到账号：' + id };
    accountsLib.writeConfig(cfg);
    message = '已重命名为「' + a.name + '」';
  } else if (action === 'enable') {
    const a = accountsLib.updateAccount(cfg, id, { enabled: !!body.enabled });
    if (!a) return { ok: false, message: '未找到账号：' + id };
    accountsLib.writeConfig(cfg);
    message = a.enabled ? '已启用「' + a.name + '」' : '已停用「' + a.name + '」（凭证保留，不再参与签到）';
  } else if (action === 'sides') {
    const patch = {};
    if (typeof body.trae === 'boolean') patch.trae = body.trae;
    if (typeof body.workbuddy === 'boolean') patch.workbuddy = body.workbuddy;
    const a = accountsLib.updateAccount(cfg, id, patch);
    if (!a) return { ok: false, message: '未找到账号：' + id };
    accountsLib.writeConfig(cfg);
    message = '已更新「' + a.name + '」的签到端开关';
  } else if (action === 'trae-token') {
    const a = accountsLib.setTraeCreds(cfg, id, body.token, body.deviceId);
    if (!a) return { ok: false, message: '未找到账号：' + id };
    accountsLib.writeConfig(cfg);
    message = String(body.token || '').trim()
      ? '已保存「' + a.name + '」的 Trae 凭证并开启 Trae 签到'
      : '已清除「' + a.name + '」的 Trae 凭证并关闭 Trae 签到';
  } else if (action === 'remove') {
    const acct = accountsLib.findAccount(cfg, id);
    if (!acct) return { ok: false, message: '未找到账号：' + id };
    accountsLib.removeAccount(cfg, acct.id);
    accountsLib.writeConfig(cfg);
    try { dailyState.dropAccount(dailyState.loadState(), acct.id); } catch (_) {}
    liveCache.delete(acct.id);
    message = '已删除账号「' + acct.name + '」及其凭证';
  } else {
    return { ok: false, message: '未知操作：' + action };
  }
  return { ok: true, message, accounts: accountListOut(false) };
}

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
    if (req.method === 'GET' && p === '/api/accounts') return send(res, 200, { accounts: accountListOut(false) });
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = await readBody(req);
      const out = handleAccountsAction(body);
      return send(res, out.ok ? 200 : 400, out);
    }
    if (req.method === 'POST' && p === '/api/checkin') {
      const body = await readBody(req);
      const ids = Array.isArray(body.accounts) ? body.accounts : [];
      const r = runCheckin(!!body.force, ids);
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
    if (req.method === 'POST' && p === '/api/wb-login/start') {
      const body = await readBody(req);
      return send(res, 200, await wbLoginStart(body.accountId));
    }
    if (req.method === 'GET' && p === '/api/wb-login/poll') {
      return send(res, 200, await wbLoginPoll(url.searchParams.get('accountId') || ''));
    }
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
