'use strict';
/*
 * WorkBuddy 认证模块（OAuth 设备授权流）· 多账号版
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
 * 每个账号各有一份 WorkBuddy 凭证（config.json → accounts[].workbuddy）。
 * 授权是按账号做的：一个账号在浏览器里确认一次，令牌只写进那个账号。
 *
 * 用法：
 *   node wb-auth.js login   [--account <账号ID|名称>]   # 首次授权：打印链接，浏览器确认一次
 *   node wb-auth.js refresh [--account <账号ID|名称>]   # 手动刷新
 *   node wb-auth.js ensure  [--account <账号ID|名称>]   # 供 checkin.js 调用：必要时自动刷新
 *                                                       # 省略 --account 时刷新所有启用 WorkBuddy 的账号
 *   node wb-auth.js status                              # 打印每个账号的凭证状态
 *
 * 只有单账号时 --account 可以省略；多账号时必须指明，否则会打印可选账号列表并退出。
 */
const fs = require('fs');
const path = require('path');
const accounts = require('./lib/accounts.js');

const ROOT = accounts.ROOT;
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
const str = (o, ...keys) => { for (const k of keys) { const v = o && o[k]; if (typeof v === 'string' && v) return v; } return ''; };
const okCode = (j) => !!j && (j.code === 0 || j.code === 200);

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

// ── 账号定位 ─────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
function accountArg() {
  const i = ARGS.indexOf('--account');
  if (i >= 0 && ARGS[i + 1]) return ARGS[i + 1];
  const eq = ARGS.find((a) => a.startsWith('--account='));
  return eq ? eq.slice('--account='.length) : '';
}

function loadCfg() { return accounts.loadConfig(); }

/** 定位要操作的账号：指定了就用指定的；只有一个账号时可省略；多个账号时必须显式指定 */
function targetAccount(cfg, arg) {
  const list = accounts.resolveAccounts(cfg);
  if (arg) {
    const a = accounts.findAccount(cfg, arg);
    if (!a) {
      throw new Error('未找到账号「' + arg + '」。当前账号：' + list.map((x) => x.id + '(' + x.name + ')').join('、'));
    }
    return a;
  }
  if (list.length === 1) return list[0];
  throw new Error('存在多个账号，请用 --account <账号ID|名称> 指定操作对象：\n    '
    + list.map((x) => x.id + '  ' + x.name).join('\n    '));
}

/** 把新令牌写回该账号（会顺带把旧版单账号配置迁移成 accounts 结构） */
function saveCreds(cfg, accountId, creds) {
  const r = accounts.setWorkbuddyCreds(cfg, accountId, creds);
  accounts.writeConfig(cfg);
  return r;
}

// ── 刷新 ─────────────────────────────────────────────────────────────────
/** 用 refresh_token 换新 access_token */
async function refresh(accountRef) {
  const { cfg } = loadCfg();
  const acct = targetAccount(cfg, accountRef);
  const wb = accounts.effectiveWorkbuddy(cfg, acct);
  const rt = String(wb.refreshToken || '').trim();
  if (!rt) {
    log('[' + acct.name + '] 无 refreshToken，无法刷新，需要重新授权：node wb-auth.js login --account ' + acct.id);
    return false;
  }

  const url = EP + PREFIX + '/auth/token/refresh';
  const headers = { Authorization: 'Bearer ' + String(wb.accessToken || ''), 'X-Refresh-Token': rt };
  if (wb.uid) headers['X-User-Id'] = String(wb.uid);

  const r = await jpost(url, {}, headers);
  if (!okCode(r.json)) {
    log('[' + acct.name + '] 刷新失败：HTTP ' + r.status + ' ' + ((r.json && (r.json.message || r.json.msg)) || r.text.slice(0, 120)));
    return false;
  }
  const d = (r.json && r.json.data) || {};
  const at = str(d, 'accessToken', 'access_token');
  if (!at) { log('[' + acct.name + '] 刷新响应缺少 accessToken'); return false; }

  const patch = { accessToken: at, refreshedAt: Date.now() };
  const nrt = str(d, 'refreshToken', 'refresh_token');
  if (nrt) patch.refreshToken = nrt;
  if (str(d, 'domain')) patch.domain = str(d, 'domain');
  if (d.expiresIn) patch.expiresAt = Date.now() + Number(d.expiresIn) * 1000;
  if (d.refreshExpiresIn) patch.refreshExpiresAt = Date.now() + Number(d.refreshExpiresIn) * 1000;
  saveCreds(cfg, acct.id, patch);
  log('[' + acct.name + '] 刷新成功，accessToken=' + mask(at) + (nrt ? '，refreshToken 已滚动更新' : ''));
  return true;
}

/** 单账号：凭证缺失或临期时自动刷新 */
async function ensureOne(accountRef) {
  let cfg;
  try { cfg = loadCfg().cfg; } catch (e) { log('config.json 读取失败：' + e.message); return false; }
  const acct = targetAccount(cfg, accountRef);
  const wb = accounts.effectiveWorkbuddy(cfg, acct);
  if (!wb.accessToken && !wb.refreshToken) {
    log('[' + acct.name + '] 未配置 WorkBuddy 凭证，请先授权：node wb-auth.js login --account ' + acct.id);
    return false;
  }
  const ageH = wb.refreshedAt ? (Date.now() - wb.refreshedAt) / 3600000 : Infinity;
  if (!wb.accessToken || ageH >= EARLY_REFRESH_HOURS) {
    log('[' + acct.name + '] 凭证' + (wb.accessToken ? '已 ' + ageH.toFixed(1) + ' 小时未刷新' : '缺失') + '，尝试刷新…');
    return await refresh(acct.id);
  }
  return true;
}

/** 供 checkin.js 调用：指定账号则只刷它，否则刷新所有「启用且开启 WorkBuddy」的账号 */
async function ensure() {
  const arg = accountArg();
  if (arg) return await ensureOne(arg);
  let cfg;
  try { cfg = loadCfg().cfg; } catch (e) { log('config.json 读取失败：' + e.message); return false; }
  const list = accounts.resolveAccounts(cfg).filter((a) => a.enabled !== false && accounts.sideEnabled(a, 'workbuddy'));
  if (!list.length) { log('没有启用 WorkBuddy 的账号，无需刷新'); return false; }
  let all = true;
  for (const a of list) {
    if (!await ensureOne(a.id)) all = false;
  }
  return all;
}

// ── 首次设备授权 ─────────────────────────────────────────────────────────
async function login(accountRef) {
  let cfg;
  try { cfg = loadCfg().cfg; } catch (e) { log('config.json 读取失败：' + e.message); return false; }
  let acct;
  try { acct = targetAccount(cfg, accountRef); } catch (e) { log(e.message); return false; }

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
  console.log('  授权目标账号：' + acct.name + '（' + acct.id + '）');
  console.log('');
  console.log('  ' + authUrl);
  console.log('');
  console.log('  （链接 10 分钟内有效；授权后本窗口会自动继续，无需其它操作）');
  console.log('');
  log('等待授权中…（账号：' + acct.name + '）');

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

    const fresh = loadCfg().cfg;
    const patch = {
      accessToken: at,
      refreshToken: str(pd, 'refreshToken', 'refresh_token') || accounts.effectiveWorkbuddy(fresh, targetAccount(fresh, acct.id)).refreshToken || '',
      uid: uid || accounts.effectiveWorkbuddy(fresh, targetAccount(fresh, acct.id)).uid || '',
      domain: str(pd, 'domain') || accounts.effectiveWorkbuddy(fresh, targetAccount(fresh, acct.id)).domain || '',
      refreshedAt: Date.now(),
    };
    if (pd.expiresIn) patch.expiresAt = Date.now() + Number(pd.expiresIn) * 1000;
    const saved = saveCreds(fresh, acct.id, patch);
    log('✅ 授权成功（' + acct.name + (nick ? ' / ' + nick : '') + '）  uid=' + (uid || '未取到'));
    log('   accessToken=' + mask(at) + '   refreshToken=' + mask(saved && saved.workbuddy && saved.workbuddy.refreshToken));
    return true;
  }
  log('授权超时，请重新运行：node wb-auth.js login --account ' + acct.id);
  return false;
}

// ── 状态 ─────────────────────────────────────────────────────────────────
function fmtExp(ts) {
  if (!ts) return '(未知)';
  return new Date(Number(ts)).toLocaleString('zh-CN', { hour12: false });
}

async function status() {
  let cfg;
  try { cfg = loadCfg().cfg; } catch (e) { console.log('  config.json 读取失败：' + e.message); return; }
  const list = accounts.resolveAccounts(cfg);
  console.log('');
  console.log('  WorkBuddy 凭证（共 ' + list.length + ' 个账号）');
  console.log('  ' + '='.repeat(62));
  for (const acct of list) {
    const wb = accounts.effectiveWorkbuddy(cfg, acct);
    const enabled = acct.enabled !== false && accounts.sideEnabled(acct, 'workbuddy');
    console.log('  [' + acct.name + ']  ' + acct.id + (enabled ? '' : '  （已停用/未开启 WorkBuddy）'));
    console.log('    accessToken : ' + mask(wb.accessToken));
    console.log('    refreshToken: ' + mask(wb.refreshToken));
    console.log('    uid         : ' + (wb.uid || '(空)'));
    console.log('    domain      : ' + (wb.domain || '(空)'));
    console.log('    上次刷新    : ' + (wb.refreshedAt ? new Date(wb.refreshedAt).toLocaleString('zh-CN', { hour12: false }) : '(从未)'));
    if (wb.refreshExpiresAt) console.log('    refresh 到期: ' + fmtExp(wb.refreshExpiresAt));
    console.log('');
  }
}

const cmd = (ARGS.find((a) => !a.startsWith('--')) || 'status').toLowerCase();
(async () => {
  let ok = true;
  if (cmd === 'login') ok = await login(accountArg());
  else if (cmd === 'refresh') ok = await refresh(accountArg());
  else if (cmd === 'ensure') ok = await ensure();
  else await status();
  process.exit(ok ? 0 : 1);
})().catch((e) => { log('异常：' + (e && e.message ? e.message : e)); process.exit(1); });
