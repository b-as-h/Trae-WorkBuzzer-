'use strict';
/*
 * WorkBuddy token 自动抓取 / 刷新
 * 用法：
 *   node capture-workbuddy-token.js            # 无头模式，自动提取并写回 config.json（供计划任务/DailyCheckin 调用）
 *   node capture-workbuddy-token.js --login    # 有头模式，首次登录用（打开可见浏览器，你登录一次）
 *   node capture-workbuddy-token.js --force    # 忽略现有 token，强制重新抓取
 *
 * 原理：
 *   使用 Playwright 的 persistent context（用户数据目录 .wb-browser-profile/），
 *   登录态会长期保存在磁盘上。之后每次运行都复用该登录态，从浏览器会话中
 *   直接读取当前有效的 Bearer token（浏览器会自动用 refresh_token 续期），
 *   写回 config.json 的 workbuddy.accessToken。
 *
 * 这样即使 55 天后原 token 过期，只要浏览器登录态还在，就能自动拿到新 token，
 * 无需你手动操作。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PROFILE_DIR = path.join(ROOT, '.wb-browser-profile');
const STATE_FILE = path.join(ROOT, '_wb_capture_state.json');
const HOME_URL = 'https://www.workbuddy.cn';
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const args = process.argv.slice(2);
const DO_LOGIN = args.includes('--login');
const FORCE = args.includes('--force');

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
  try { fs.appendFileSync(path.join(ROOT, 'capture.log'), `[${ts}] ${msg}\n`); } catch (_) {}
}

function loadConfig() {
  // 剥掉可能的 UTF-8 BOM（记事本另存会加），否则 JSON.parse 会失败
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
}

function saveConfig(cfg) {
  // 原子写入
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    let s = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

function isUsable(token) {
  if (!token || !JWT_RE.test(token)) return false;
  const p = decodeJwtPayload(token);
  // 必须是「载荷能解出 JSON 且带 exp」的真 JWT。
  // 否则腾讯的 KC_STATE_CHECKER 这类仅"看着像三段式"的 cookie 会被误判成 token，
  // 导致还没登录就提前"抓取成功"、写回一个用不了的假凭证。
  if (!p || !p.exp) return false;
  return p.exp * 1000 > Date.now() + 60 * 1000; // 至少还有 1 分钟
}

// 从任意来源对象中递归找 JWT
function findJwtDeep(obj, depth = 0) {
  if (depth > 6 || obj == null) return null;
  if (typeof obj === 'string') return JWT_RE.test(obj) ? obj : null;
  if (typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && JWT_RE.test(v)) return v;
    if (typeof v === 'object') {
      const r = findJwtDeep(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

async function extractTokenFromContext(context) {
  // 1) 从 localStorage / sessionStorage 找
  for (const page of context.pages()) {
    try {
      const vals = await page.evaluate(() => {
        const out = {};
        try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out['ls:' + k] = localStorage.getItem(k); } } catch (_) {}
        try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out['ss:' + k] = sessionStorage.getItem(k); } } catch (_) {}
        return out;
      });
      const hit = findJwtDeep(vals);
      if (hit) return { token: hit, via: 'storage', url: page.url() };
    } catch (_) {}
  }
  // 2) 从 cookie 找
  try {
    const cookies = await context.cookies();
    for (const c of cookies) {
      if (c.value && JWT_RE.test(c.value)) return { token: c.value, via: 'cookie:' + c.name };
    }
  } catch (_) {}
  return null;
}

async function interceptNetworkToken(context) {
  // 被动监听：从已发出的请求头里抓 Authorization
  let captured = null;
  context.on('request', (req) => {
    if (captured) return;
    try {
      const h = req.headers() || {};
      const a = h['authorization'] || h['Authorization'];
      if (a && a.startsWith('Bearer ')) {
        const t = a.slice(7).trim();
        if (JWT_RE.test(t)) captured = t;
      }
    } catch (_) {}
  });
  return () => captured;
}

async function main() {
  let playwright;
  try { playwright = require('playwright'); }
  catch (e) {
    log('未找到 playwright，请先执行：npm install playwright && npx playwright install chromium');
    process.exit(2);
  }
  const { chromium } = playwright;

  // 非 --force 且现有 token 仍有效 → 直接跳过（省时）
  if (!FORCE) {
    try {
      const cfg0 = loadConfig();
      const cur = cfg0?.workbuddy?.accessToken;
      if (isUsable(cur)) {
        log('当前 config.json 中的 token 仍有效，无需刷新（用 --force 可强制重抓）');
        process.exit(0);
      }
      log('当前 token 无效或即将过期，开始刷新...');
    } catch (_) {}
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: process.env.WB_BROWSER_CHANNEL || 'msedge', // 复用系统 Edge，免装 150MB Chromium
    headless: !DO_LOGIN,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const getNetToken = await interceptNetworkToken(context);
  const page = context.pages()[0] || await context.newPage();

  log('打开 ' + HOME_URL + (DO_LOGIN ? '（有头模式：请在此浏览器中登录）' : '（无头模式）'));
  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log('打开页面超时/失败（继续尝试提取）：' + e.message);
  }

  // 等待 & 轮询提取：最多 90 秒（有头模式给你时间登录）
  const deadline = Date.now() + (DO_LOGIN ? Number(process.env.WB_LOGIN_WINDOW_MS || 30 * 60 * 1000) : 90 * 1000);
  let found = null;
  while (Date.now() < deadline) {
    found = await extractTokenFromContext(context);
    if (!found || !isUsable(found.token)) {
      const net = getNetToken();
      if (net && isUsable(net)) found = { token: net, via: 'network' };
    }
    if (found && isUsable(found.token)) break;
    // 触发一次页面交互，促使前端发出带 token 的请求。
    // 有头登录模式下绝不刷新：每 3 秒 reload 会把正在进行的扫码/验证码流程直接打断。
    if (!DO_LOGIN) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  await context.close();

  if (!found || !isUsable(found.token)) {
    log('未能获取到有效的 WorkBuddy token。');
    log('可能原因：浏览器登录态已失效。请运行： node capture-workbuddy-token.js --login  手动登录一次。');
    saveState({ ok: false, at: Date.now(), reason: 'no-usable-token' });
    process.exit(1);
  }

  const cfg = loadConfig();
  cfg.workbuddy = cfg.workbuddy || {};
  cfg.workbuddy.accessToken = found.token;
  const p = decodeJwtPayload(found.token);
  if (p && p.sub) cfg.workbuddy.uid = p.sub; // 自动同步 uid
  saveConfig(cfg);

  const exp = p && p.exp ? new Date(p.exp * 1000).toISOString() : '未知';
  log('✅ 已更新 config.json 的 WorkBuddy token（来源=' + (found.via || '?') + '，到期=' + exp + '）');
  saveState({ ok: true, at: Date.now(), exp: p && p.exp ? p.exp : null, via: found.via });
  process.exit(0);
}

function saveState(obj) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2)); } catch (_) {}
}

main().catch(e => { log('抓取异常：' + (e && e.message ? e.message : e)); process.exit(1); });
