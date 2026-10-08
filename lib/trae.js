'use strict';
/*
 * Trae CN 自动签到模块
 * - 自动从本机 Trae 客户端 storage.json 提取登录态
 * - 解密 iCubeAuthInfo（"tc" 格式：AES-128-CBC + SHA-512 密钥派生 + HMAC 校验）
 * - 调用 api.trae.cn 的 checkin_credits 接口完成每日签到
 * 解密算法来源：kenuoseclab/trae-local-api（已在本机 storage.json 实测验证）
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isNetworkError } = require('./net.js');

// ---- Trae CN 前端硬编码 salt（64 字节，每组两条异或得到实际 salt）----
const SALT_A = Uint8Array.from([
  82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,
  124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,
  84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,
  8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37
]);
const SALT_B = Uint8Array.from([
  31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,
  96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,
  160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,
  23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125
]);
const SALT_C = Uint8Array.from([
  191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,
  135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,
  51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,
  18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209
]);
const SALT_D = Uint8Array.from([
  246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,
  50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,
  175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,
  86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170
]);

function xorSalts(a, b) {
  const r = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = a[i] ^ b[i];
  return r;
}

function detectEncType(header) {
  if (header[0] === 0x74 && header[1] === 0x63 &&
      header[2] === 0x05 && header[3] === 0x10 &&
      header[4] === 0x00 && header[5] === 0x00) return 'AES';
  if (header[0] === 18 && header[1] === 57 &&
      header[2] === 32 && header[3] === 32 &&
      header[4] === 2 && header[5] === 3) return 'AES_PRIVATE';
  return 'UNKNOWN';
}

function deriveKeyAndIV(randomBytes, encType) {
  const salt = encType === 'AES_PRIVATE' ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B);
  const hashOfRandom = crypto.createHash('sha512').update(randomBytes).digest();
  const finalHash = crypto.createHash('sha512')
    .update(Buffer.concat([hashOfRandom, Buffer.from(salt)])).digest();
  return { aesKey: finalHash.slice(0, 16), iv: finalHash.slice(16, 32) };
}

function decryptStorageValue(base64Value) {
  const buffer = Buffer.from(base64Value, 'base64');
  const header = buffer.slice(0, 6);
  const randomBytes = buffer.slice(6, 38);
  const encryptedData = buffer.slice(38);
  const encType = detectEncType(header);
  if (encType === 'UNKNOWN') throw new Error('未知的 iCubeAuthInfo 加密类型');
  const { aesKey, iv } = deriveKeyAndIV(randomBytes, encType);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  const storedHash = decrypted.slice(0, 64);
  const plaintext = decrypted.slice(64);
  const computedHash = crypto.createHash('sha512').update(plaintext).digest();
  if (!storedHash.equals(computedHash)) {
    throw new Error('哈希校验失败，解密可能不正确（客户端版本变化？）');
  }
  return plaintext.toString('utf8');
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~')) p = path.join(process.env.HOME || process.env.USERPROFILE || '', p.slice(1));
  return p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => process.env[n] || m);
}

function findStoragePath(cfg) {
  if (cfg && cfg.storageJson) {
    const p = expandPath(cfg.storageJson);
    if (fs.existsSync(p)) return p;
  }
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
  const candidates = [
    // 优先 Trae CN：它是活跃客户端，storage.json 内含自动刷新的 cloudide token
    'Trae CN/User/globalStorage/storage.json',
    'Trae/User/globalStorage/storage.json',
    'TRAE SOLO CN/User/globalStorage/storage.json',
    'TRAE SOLO/User/globalStorage/storage.json',
  ];
  for (const c of candidates) {
    const p = path.join(appData, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 提取客户端真正用于接口认证的设备 ID。
 * 关键（2026-09-28 实测）：claim 接口会校验 x-device-id 必须与 token 绑定的
 * aha 设备 ID 一致；该 ID 以 storage.json 的键名 `iCubeAuthInfo://icube-dc:<数字ID>`
 * 形式存在（如 <你的-aha-设备ID>）。若误用 `telemetry.devDeviceId`（另一个 UUID），
 * 服务端会返回 9074「当前参与用户太多，请稍后再试」——看起来像限流，实为设备不匹配。
 */
function findAhaDeviceId(storage) {
  for (const k of Object.keys(storage)) {
    const m = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(k);
    if (m) return m[1];
  }
  return '';
}

function extractAuth(storagePath) {
  const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  const ahaId = findAhaDeviceId(storage);
  if (!ahaId) {
    // aha 设备 ID 缺失 = Trae 客户端 storage.json 结构变了。
    // 此时回退用的 telemetry ID 会被服务端拒绝并回报 9074（伪装成"高峰期"），
    // 极易被误判为限流。2026-09-28 踩过一次，这里显式告警便于快速定位。
    console.warn('[Trae] 警告：storage.json 未找到 aha 设备 ID（键名形如 iCubeAuthInfo://icube-dc:<数字>），'
      + '已回退到 telemetry 设备 ID —— 这会导致接口持续返回 9074，请核对 Trae 客户端版本是否变更。');
  }
  const deviceId = ahaId || storage['telemetry.devDeviceId'] || storage['telemetry.machineId'] || '';
  let key = null;
  for (const k of Object.keys(storage)) {
    if (k.startsWith('iCubeAuthInfo')) { key = k; break; }
  }
  if (!key) throw new Error('storage.json 中未找到 iCubeAuthInfo 键');
  const raw = storage[key];
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    return { auth: JSON.parse(raw), deviceId, source: 'plaintext' };
  }
  return { auth: JSON.parse(decryptStorageValue(raw)), deviceId, source: 'decrypted' };
}

/** 读取客户端版本号（供 x-app-version 头使用；缺失时该头不发送） */
function extractAppVersion(storagePath) {
  try {
    const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    return storage['iCubeLastVersion'] || '';
  } catch (_) { return ''; }
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** 解析 JWT 的 exp（秒），失败返回 0 */
function jwtExp(token) {
  try {
    const s = String(token).split('.')[1];
    if (!s) return 0;
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : 0;
  } catch (_) { return 0; }
}

/**
 * 从本机 Trae 客户端 storage.json 自动提取 Cloud-IDE token。
 * 键 `iCubeAuthInfo://icube.cloudide`（加密值）由客户端主动维护并自动刷新，
 * 有效期通常约 14 天（远长于网页会话 token 的 ~8 小时）。
 * 这是实现"无人值守自动签到"的关键来源：只要客户端处于登录态即可自动取到新 token。
 */
function extractCloudIdeToken(cfg) {
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', 'AppData', 'Roaming');
  const candidates = [];
  if (cfg && cfg.cloudideStorage) candidates.push(expandPath(cfg.cloudideStorage));
  candidates.push(
    path.join(appData, 'Trae CN', 'User', 'globalStorage', 'storage.json'),
    path.join(appData, 'Trae', 'User', 'globalStorage', 'storage.json'),
    path.join(appData, 'TRAE SOLO CN', 'User', 'globalStorage', 'storage.json'),
  );
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    try {
      const storage = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const k of Object.keys(storage)) {
        if (!k.startsWith('iCubeAuthInfo://icube.cloudide')) continue;
        const raw = storage[k];
        let obj = null;
        if (typeof raw === 'string' && raw.trim().startsWith('{')) {
          obj = JSON.parse(raw);            // 明文（未来版本可能如此）
        } else if (typeof raw === 'string') {
          obj = JSON.parse(decryptStorageValue(raw));  // 加密态解密
        }
        if (obj && typeof obj.token === 'string' && JWT_RE.test(obj.token)) {
          return { token: obj.token, source: 'client-storage', exp: jwtExp(obj.token), storagePath: p };
        }
      }
    } catch (_) { /* 尝试下一个来源 */ }
  }
  return null;
}

/**
 * 解析 Trae token，返回 { token, source, exp }。
 * 多来源择优：手动配置 / 客户端 storage.json（自动刷新）/ token 缓存文件，
 * 三者中取有效期（exp）最长者；同分时优先级 manual > client-storage > file。
 */
function resolveTokenInfo(cfg) {
  const cands = [];
  if (cfg && cfg.manualToken) {
    cands.push({ token: cfg.manualToken, source: 'manual(config)', exp: jwtExp(cfg.manualToken), prio: 3 });
  }
  const auto = extractCloudIdeToken(cfg);
  if (auto) { auto.prio = 2; cands.push(auto); }
  const tokenFile = expandPath(cfg && cfg.tokenFile ? cfg.tokenFile : path.join(__dirname, '..', 'trae-token.json'));
  if (fs.existsSync(tokenFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (j && j.token && JWT_RE.test(j.token)) {
        cands.push({ token: j.token, source: 'file:' + path.basename(tokenFile), exp: jwtExp(j.token), prio: 1 });
      }
    } catch (_) { /* ignore */ }
  }
  const valid = cands.filter(c => c.token);
  if (!valid.length) return null;
  valid.sort((a, b) => ((b.exp || 0) - (a.exp || 0)) || ((b.prio || 0) - (a.prio || 0)));
  return valid[0];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postJson(url, headers, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* keep text */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function maskToken(t) {
  if (!t || t.length < 12) return '<empty>';
  return t.slice(0, 6) + '…' + t.slice(-6);
}

/**
 * 执行 Trae 签到。返回 { ok, alreadyCheckedIn, credits, message }
 */
async function traeCheckin(cfg = {}) {
  const host = cfg.host || 'https://api.trae.cn';
  const maxRetry = cfg.maxRetry ?? 10;
  const minWait = cfg.minWait ?? 15000;
  const maxWait = cfg.maxWait ?? 30000;
  // 总时限（毫秒）：到点即停止重试并返回失败，避免无人值守时无限空转
  const deadlineMs = cfg.deadlineMs ?? 8 * 60 * 1000;
  const startAt = Date.now();
  const overDeadline = () => (Date.now() - startAt) > deadlineMs;

  const storagePath = findStoragePath(cfg);
  if (!storagePath) throw new Error('未找到 Trae storage.json（客户端未安装或未登录？可在 config.json 指定 storageJson）');
  const { auth, deviceId, source } = extractAuth(storagePath);
  const appVersion = extractAppVersion(storagePath);
  const tokenInfo = resolveTokenInfo(cfg);
  const token = tokenInfo ? tokenInfo.token : null;
  if (!token) {
    return {
      ok: false,
      message: '未找到 Trae token：请确保 Trae CN 客户端处于登录状态（脚本会自动从客户端 storage.json 提取），' +
        '或在 config.json 设置 manualToken / 运行 capture 流程写入 trae-token.json。',
    };
  }
  const tokenExpDays = tokenInfo.exp ? ((tokenInfo.exp * 1000 - Date.now()) / 86400000) : null;
  if (!deviceId) throw new Error('未能提取 Trae device-id');

  // 请求头须与 Trae 客户端保持一致（客户端实现见 resources/app/out/main.js 的 fb()）：
  // x-device-id 必须是 aha 设备 ID，且带 region/版本/平台信息；缺项 claim 会被判 9074。
  const platform = process.platform === 'win32' ? 'Windows'
    : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const headers = {
    'Authorization': 'Cloud-IDE-JWT ' + token,
    'x-device-id': deviceId,
    'X-User-Region': cfg.region || 'CN',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-device-type': platform,
    'x-device-brand': platform,
    'x-os-version': os.release(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (appVersion) headers['x-app-version'] = appVersion;
  // 客户端 POST body 固定为 { req_source }（IDE=1 / Lite=2），空 body 亦会被判 9074
  const reqBody = { req_source: 1 };

  // 1) 查询今日状态
  const statusUrl = host + '/trae/api/v2/ug/checkin_credits/status';
  let statusRes;
  try {
    statusRes = await postJson(statusUrl, headers, reqBody);
  } catch (e) {
    // 断网（ENOTFOUND / 超时等）单独标记：交给上层「等联网后再重试」，
    // 不要在这里耗掉退避重试与 8 分钟总时限（那会让断网时的整轮白等）
    if (isNetworkError(e)) {
      return {
        ok: false, networkError: true,
        tokenSource: tokenInfo.source, tokenExpDays,
        message: '查询签到状态失败（断网）: ' + e.message,
      };
    }
    return { ok: false, message: '查询签到状态失败: ' + e.message };
  }
  const sc = statusRes.json;
  if (sc && sc.code === 9004) {
    return { ok: false, tokenSource: tokenInfo.source, tokenExpDays, message: '接口返回 9004：请求头/token 不正确，请检查（token 可能过期）' };
  }
  // 若已签到则直接返回（多时段触发时避免重复领取与无效重试）
  const already = sc && (
    sc.data && (sc.data.checkedIn === true || sc.data.checked_in === true || sc.data.did_checked_in === true ||
      sc.data.isCheckedIn === true || sc.data.hasCheckedIn === true) ||
    sc.checkedIn === true || sc.checked_in === true || sc.did_checked_in === true
  );
  if (already) {
    return {
      ok: true, alreadyCheckedIn: true, credits: null,
      message: 'Trae 今日已签到（跳过领取）',
      source, storagePath, tokenSource: tokenInfo.source, tokenExpDays,
      deviceId: maskToken(deviceId),
    };
  }

  // 2) 领取（带 9074 重试）
  const claimUrl = host + '/trae/api/v2/ug/checkin_credits/claim';
  let lastMsg = '';
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    if (overDeadline()) {
      lastMsg = `已达总时限(${Math.round(deadlineMs/60000)}分钟)，停止重试`;
      break;
    }
    let claimRes;
    try {
      claimRes = await postJson(claimUrl, headers, reqBody);
    } catch (e) {
      lastMsg = '领取请求异常: ' + e.message;
      if (isNetworkError(e)) {
        return {
          ok: false, networkError: true,
          tokenSource: tokenInfo.source, tokenExpDays, deviceId: maskToken(deviceId),
          message: 'Trae 签到失败（断网）: ' + e.message,
        };
      }
      if (overDeadline()) break;
      await sleep(minWait);
      continue;
    }
    const cc = claimRes.json;
    if (claimRes.status === 200 && cc && (cc.code === 0 || cc.success === true)) {
      // 积分字段名各版本不一，逐个兜：credits / credit / reward / amount
      // （2026-09-29：WorkBuddy 侧实测响应里用的是单数 `data.credit`，故一并纳入候选）
      const credits = (cc.data && (cc.data.credits ?? cc.data.credit ?? cc.data.reward ?? cc.data.amount)) ?? null;
      // 注意：这里不加 alreadyCheckedIn —— 能走到本行说明 status 查询时还没签到，
      // 该字段恒为 false，留着只会误导调用方（真正的"已签到"在上面已提前 return）。
      return { ok: true, credits, message: 'Trae 签到成功', source, storagePath, tokenSource: tokenInfo.source, tokenExpDays, deviceId: maskToken(deviceId) };
    }
    if (cc && cc.code === 9074) {
      // 9074 有两种成因：真实高峰限流，或 x-device-id 与 token 不匹配（见 findAhaDeviceId）
      lastMsg = `高峰期/设备校验未通过(9074)，重试 ${attempt}/${maxRetry}`;
      if (overDeadline()) break;
      const wait = Math.floor(minWait + Math.random() * (maxWait - minWait));
      await sleep(wait);
      continue;
    }
    if (cc && cc.code === 9004) {
      return {
        ok: false,
        tokenSource: tokenInfo.source,
        tokenExpDays,
        message: `接口返回 9004：token/device-id 不正确（当前 token 来源=${tokenInfo.source}` +
          (tokenExpDays != null ? `，剩余 ${tokenExpDays.toFixed(2)} 天` : '') + '）',
      };
    }
    // 其他错误
    lastMsg = '领取返回: ' + JSON.stringify(cc || claimRes.text).slice(0, 200);
    if (attempt < maxRetry && !overDeadline()) await sleep(Math.floor(minWait / 2));
  }
  return { ok: false, tokenSource: tokenInfo.source, tokenExpDays, deviceId: maskToken(deviceId), message: 'Trae 签到失败: ' + lastMsg };
}

module.exports = { traeCheckin, extractAuth, findStoragePath, resolveTokenInfo, extractCloudIdeToken, decryptStorageValue, jwtExp, findAhaDeviceId, extractAppVersion, maskToken };
