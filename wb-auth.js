'use strict';
/*
 * WorkBuddy 认证模块（OAuth 设备授权流）
 *
 * 背景：WorkBuddy 客户端 5.6+ 起本机登录态 workbuddy-desktop.info 里的 accessToken
 *       是 $wbEncrypted 加密对象，无法离线解密；网页端用 Keycloak，cookie/localStorage
 *       里也不存在明文 JWT。因此上游那套「扫日志找 JWT / 读 info 文件」的做法在
 *       当前版本上必然拿不到凭证。
 *
 * 本模块改用官方插件授权流（与官方桌面客户端同一套接口）：
 *   POST /v2/plugin/auth/state?platform=workbuddy   -> { state, authUrl }
 *   GET  /v2/plugin/auth/token?state=<state>        -> { accessToken, refreshToken, domain }
 *   GET  /v2/plugin/login/account?state=<state>     -> 账号资料（uid 等）
 *   POST /v2/plugin/auth/token/refresh              -> 用 X-Refresh-Token 换新 token
 *
 * 用法：
 *   node wb-auth.js login      # 首次授权：打印一个链接，你在浏览器里确认一次
 *   node wb-auth.js refresh    # 手动刷新
 *   node wb-auth.js ensure     # 供 checkin.js 调用：必要时自动刷新（静默，退出码表结果）
 *   node wb-auth.js status     # 打印当前凭证状态
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG = path.join(ROOT, 'config.json');
const EP = (process.env.WB_ENDPOINT || 'https://www.codebuddy.cn').replace(/\/+$/, '');
const PREFIX = '/v2/plugin';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const EARLY_REFRESH_HOURS = 20;   // 主动刷新阈值（官方 token 有效期远大于此）

const H = (extra) => Object.assign({ Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA }, extra || {});
const log = (m) => {
  const ts = new Date().toISOString();
  console.log('[' + ts + '] ' + m);
  try { fs.appendFileSync(path.join(ROOT, 'wb-auth.log'), '[' + ts + '] ' + m + '\n'); } catch (_) {}
};
const mask = (t) => (t ? String(t).slice(0, 8) + '…(len ' + String(t).length + ')' : '(空)');

function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, '')); }
function saveConfig(cfg) {
  const tmp = CONFIG + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG);
}
async function jpost(url, body, headers) {
  const r = await fetch(url, { method: 'POST', headers: H(headers), body: JSON.stringify(body || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, text: t };
}
async function jget(url, headers) {
  const r = await fetch(url, { method: 'GET', headers: H(headers) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { status: r.status, json: j, text: t };
}
const okCode = (j) => !!j && (j.code === 0 || j.code === 200);
const str = (o, ...keys) => { for (const k of keys) { const v = o && o[k]; if (typeof v === 'string' && v) return v; } return ''; };

/** 用 refresh_token 换新 access_token */
async function refresh() {
  const cfg = loadConfig();
  const wb = cfg.workbuddy || {};
  const rt = String(wb.refreshToken || '').trim();
  if (!rt) { log('无 refreshToken，无法刷新，需要重新授权：node wb-auth.js login'); return false; }

  const url = EP + PREFIX + '/auth/token/refresh';
  const headers = { Authorization: 'Bearer ' + String(wb.accessToken || ''), 'X-Refresh-Token': rt };
  if (wb.uid) headers['X-User-Id'] = String(wb.uid);

  const r = await jpost(url, {}, headers);
  if (!okCode(r.json)) {
    log('刷新失败：HTTP ' + r.status + ' ' + ((r.json && (r.json.message || r.json.msg)) || r.text.slice(0, 120)));
    return false;
  }
  const d = (r.json && r.json.data) || {};
  const at = str(d, 'accessToken', 'access_token');
  if (!at) { log('刷新响应缺少 accessToken'); return false; }

  cfg.workbuddy.accessToken = at;
  const nrt = str(d, 'refreshToken', 'refresh_token');
  if (nrt) cfg.workbuddy.refreshToken = nrt;
  if (str(d, 'domain')) cfg.workbuddy.domain = str(d, 'domain');
  cfg.workbuddy.refreshedAt = Date.now();
  if (d.expiresIn) cfg.workbuddy.expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  if (d.refreshExpiresIn) cfg.workbuddy.refreshExpiresAt = Date.now() + Number(d.refreshExpiresIn) * 1000;
  saveConfig(cfg);
  log('刷新成功，accessToken=' + mask(at) + (nrt ? '，refreshToken 已滚动更新' : ''));
  return true;
}

/** 供 checkin.js 调用：凭证缺失或临期时自动刷新 */
async function ensure() {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { log('config.json 读取失败：' + e.message); return false; }
  const wb = cfg.workbuddy || {};
  if (!wb.accessToken && !wb.refreshToken) {
    log('未配置 WorkBuddy 凭证，请先运行：node wb-auth.js login');
    return false;
  }
  const ageH = wb.refreshedAt ? (Date.now() - wb.refreshedAt) / 3600000 : Infinity;
  if (!wb.accessToken || ageH >= EARLY_REFRESH_HOURS) {
    log('凭证' + (wb.accessToken ? '已 ' + ageH.toFixed(1) + ' 小时未刷新' : '缺失') + '，尝试刷新…');
    return await refresh();
  }
  return true;
}

/** 首次设备授权 */
async function login() {
  const r = await jpost(EP + PREFIX + '/auth/state?platform=workbuddy', {});
  if (!okCode(r.json)) {
    log('申请授权失败：HTTP ' + r.status + ' ' + r.text.slice(0, 200));
    return false;
  }
  const d = (r.json && r.json.data) || {};
  const state = str(d, 'state');
  const authUrl = str(d, 'authUrl', 'auth_url', 'url') || (EP + '/login?state=' + state);
  if (!state) { log('响应缺少 state'); return false; }

  console.log('');
  console.log('  ┌────────────────────────────────────────────────────────────┐');
  console.log('  │  请在浏览器中打开下面的链接，用你的 WorkBuddy 账号确认授权  │');
  console.log('  └────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  ' + authUrl);
  console.log('');
  console.log('  （链接 10 分钟内有效；授权后本窗口会自动继续，无需其它操作）');
  console.log('');
  log('等待授权中…');

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((s) => setTimeout(s, 3000));
    const p = await jget(EP + PREFIX + '/auth/token?state=' + encodeURIComponent(state), {});
    if (!okCode(p.json)) continue;
    const pd = (p.json && p.json.data) || {};
    const at = str(pd, 'accessToken', 'access_token');
    if (!at) continue;

    // 拉账号资料拿 uid
    let uid = '', nick = '';
    try {
      const a = await jget(EP + PREFIX + '/login/account?state=' + encodeURIComponent(state), { Authorization: 'Bearer ' + at });
      const ad = (a.json && a.json.data) || {};
      uid = str(ad, 'uid') || str(ad.account || {}, 'uid');
      nick = str(ad, 'nickname') || str(ad.account || {}, 'nickname');
    } catch (_) {}

    const cfg = loadConfig();
    cfg.workbuddy = cfg.workbuddy || {};
    cfg.workbuddy.accessToken = at;
    cfg.workbuddy.refreshToken = str(pd, 'refreshToken', 'refresh_token') || cfg.workbuddy.refreshToken || '';
    cfg.workbuddy.uid = uid || cfg.workbuddy.uid || '';
    cfg.workbuddy.domain = str(pd, 'domain') || cfg.workbuddy.domain || '';
    cfg.workbuddy.refreshedAt = Date.now();
    if (pd.expiresIn) cfg.workbuddy.expiresAt = Date.now() + Number(pd.expiresIn) * 1000;
    saveConfig(cfg);
    log('✅ 授权成功' + (nick ? '（' + nick + '）' : '') + '  uid=' + (uid || '未取到'));
    log('   accessToken=' + mask(at) + '   refreshToken=' + mask(cfg.workbuddy.refreshToken));
    return true;
  }
  log('授权超时，请重新运行：node wb-auth.js login');
  return false;
}

async function status() {
  const cfg = loadConfig();
  const wb = cfg.workbuddy || {};
  console.log('  accessToken : ' + mask(wb.accessToken));
  console.log('  refreshToken: ' + mask(wb.refreshToken));
  console.log('  uid         : ' + (wb.uid || '(空)'));
  console.log('  domain      : ' + (wb.domain || '(空)'));
  console.log('  上次刷新    : ' + (wb.refreshedAt ? new Date(wb.refreshedAt).toLocaleString('zh-CN', { hour12: false }) : '(从未)'));
  if (wb.refreshExpiresAt) console.log('  refresh 到期: ' + new Date(wb.refreshExpiresAt).toLocaleString('zh-CN', { hour12: false }));
}

const cmd = (process.argv[2] || 'status').toLowerCase();
(async () => {
  let ok = true;
  if (cmd === 'login') ok = await login();
  else if (cmd === 'refresh') ok = await refresh();
  else if (cmd === 'ensure') ok = await ensure();
  else await status();
  process.exit(ok ? 0 : 1);
})().catch((e) => { log('异常：' + (e && e.message ? e.message : e)); process.exit(1); });
