'use strict';
/*
 * WorkBuddy 自动签到模块（逆向自桌面端 app.asar，已实测可用）
 *
 * 原理：读取本机登录态 -> 取出 accessToken(JWT) -> 调用腾讯官方签到接口。
 *   - 状态查询：POST {endpoint}/v2/billing/meter/checkin-activity-status
 *   - 执行签到：POST {endpoint}/v2/billing/meter/daily-checkin
 *   - 端点：默认 https://www.workbuddy.cn （已验证；亦可用 copilot.tencent.com）
 *   - 鉴权头：Authorization: Bearer <token>  +  X-User-Id: <uid>  （X-Domain 可选）
 *   - 幂等：daily-checkin 返回 code=0 成功；code=10001 表示今日已签到（网关会包成 HTTP 400，必须看响应体 code）
 *
 * token 来源优先级：
 *   1) config.workbuddy.atRestSecretKey 设置时，尝试离线解密 workbuddy-desktop.info（实验性，需静态主密钥）
 *   2) config.workbuddy.accessToken —— 明文 JWT（本机已抓取，约 55 天有效，主路径）
 *   3) 若未来客户端改为明文存储，自动读取 workbuddy-desktop.info
 *   uid 同样可取自 config.workbuddy.uid，或从 JWT 的 sub 字段解析。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pickBestToken } = require('./token-sources.js');
const { isNetworkError } = require('./net.js');

const DEFAULT_ENDPOINT = (process.env.WB_ENDPOINT || 'https://www.workbuddy.cn').replace(/\/+$/, '');

function b64urlDecode(s) {
  s += '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s, 'base64');
}

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    return null;
  }
}

function getDesktopInfoPath() {
  const rel = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
  const cands = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, rel));
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, rel));
  } else if (process.platform === 'darwin') {
    cands.push(path.join(process.env.HOME || '', 'Library', 'Application Support', rel));
  } else {
    cands.push(path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), rel));
  }
  for (const f of cands) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// 实验性：用静态主密钥离线解密 workbuddy-desktop.info 的 $wbEncrypted 字段。
// 需要正确的 AAD 构造；若失败返回 null，由上层回退到 JWT。
function tryDecryptInfo(atRestSecretKey) {
  try {
    const infoPath = getDesktopInfoPath();
    if (!infoPath || !atRestSecretKey) return null;
    const j = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const acc = j.auth && j.auth.accessToken;
    if (!acc || typeof acc !== 'object' || !acc.$wbEncrypted) return null; // 非加密或已是明文
    const env = acc.envelope;
    const symKey = crypto.createHash('sha256').update(Buffer.from(atRestSecretKey, 'base64')).digest();
    const e = JSON.parse(Buffer.from(env, 'base64').toString('utf8'));
    const nonce = Buffer.from(e.nonce, 'base64');
    const tagAndCipher = Buffer.from(e.ciphertext, 'base64');
    const authTag = tagAndCipher.slice(-16);
    const cipher = tagAndCipher.slice(0, -16);
    // 已知信封结构，但 AAD 精确构造依赖客户端 buildAuthenticatedContextAad，留作实验。
    const aad = Buffer.from(`${e.keyId}:${e.suite}`, 'utf8');
    const decipher = crypto.createDecipheriv('aes-256-gcm', symKey, nonce, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    const pt = Buffer.concat([decipher.update(cipher), decipher.final()]);
    return {
      accessToken: pt.toString('utf8'),
      uid: (j.account && j.account.uid) || '',
      domain: (j.auth && j.auth.domain) || '',
    };
  } catch (_) {
    return null;
  }
}

function resolveCredentials(cfg) {
  const wb = cfg.workbuddy || {};
  let token = String(wb.accessToken || '').trim();
  let uid = String(wb.uid || '').trim();
  let domain = String(wb.domain || '').trim();
  let source = token ? 'config' : '';

  // 1) 离线解密（实验性，需静态主密钥）
  if (!token && wb.atRestSecretKey) {
    const d = tryDecryptInfo(wb.atRestSecretKey);
    if (d && d.accessToken) {
      token = d.accessToken;
      uid = uid || (d.uid || '');
      domain = domain || (d.domain || '');
      source = 'atRest';
    }
  }

  // 2) 明文 info 文件（未来客户端可能改为明文）
  if (!token) {
    const infoPath = getDesktopInfoPath();
    if (infoPath) {
      try {
        const j = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        if (j.auth && j.auth.accessToken && typeof j.auth.accessToken === 'string') {
          token = j.auth.accessToken;
          uid = uid || (j.account && j.account.uid) || '';
          domain = domain || (j.auth.domain) || '';
          source = 'info-plain';
        }
      } catch (_) { /* ignore */ }
    }
  }

  // 3) 多来源采集：扫描本机客户端日志，取"有效期最长"的 JWT（实现自动续期）
  try {
    const best = pickBestToken(token);
    if (best && best.token && best.token !== token) {
      // 仅当采集到的 token 比现有更新（exp 更大）时才替换
      const cur = token ? decodeJwtPayload(token) : null;
      const curExp = cur && cur.exp ? cur.exp : 0;
      if (best.exp > curExp) {
        token = best.token;
        source = best.source === 'config' ? source : (best.source + (best.file ? ':' + path.basename(best.file) : ''));
      }
    }
  } catch (_) { /* 采集失败不影响主流程 */ }

  // 4) 从 JWT 解析 uid
  if (token) {
    const p = decodeJwtPayload(token);
    if (p && p.sub) uid = uid || p.sub;
  }

  return { token, uid, domain, source };
}

async function apiCall(endpoint, token, uid, domain, p) {
  const headers = {
    Authorization: 'Bearer ' + token,
    'X-User-Id': String(uid || ''),
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (domain) headers['X-Domain'] = String(domain);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(endpoint + p, { method: 'POST', headers, body: '{}', signal: ctrl.signal });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch (_) { /* keep text */ }
    return { httpStatus: res.status, json: j, text };
  } finally {
    clearTimeout(t);
  }
}

async function workbuddyCheckin(cfg = {}) {
  const { token, uid, domain, source } = resolveCredentials(cfg);
  if (!token) {
    return {
      ok: false,
      message: '未找到 WorkBuddy token：请配置 config.workbuddy.accessToken（运行 capture-workbuddy-token.js 获取），' +
        '或在 config.workbuddy.atRestSecretKey 填入静态主密钥做离线解密。',
    };
  }
  if (!uid) {
    return { ok: false, message: '缺少 X-User-Id（uid），无法调用接口（可在 config.workbuddy.uid 补填）' };
  }
  const srcTag = source ? `（token来源：${source}）` : '';

  // token 过期预检
  const payload = decodeJwtPayload(token);
  if (payload && payload.exp) {
    const remainMs = payload.exp * 1000 - Date.now();
    if (remainMs <= 0) {
      return { ok: false, message: 'WorkBuddy token 已过期，请运行 capture-workbuddy-token.js 重新获取' };
    }
    if (remainMs < 3 * 86400 * 1000) {
      console.warn('[WorkBuddy] 警告：token 将于 ' + new Date(payload.exp * 1000).toISOString() + ' 过期，请尽快重抓');
    }
  }

  const endpoint = DEFAULT_ENDPOINT;

  // 1) 查状态（主要用于 401/403 探测，不作为幂等唯一依据）
  let r;
  try {
    r = await apiCall(endpoint, token, uid, domain, '/v2/billing/meter/checkin-activity-status');
  } catch (e) {
    // 网络类异常标记出来：上层会等联网恢复后重试，而不是等到下一个时段
    return { ok: false, networkError: isNetworkError(e), message: '查询签到状态失败: ' + e.message };
  }
  if (r.httpStatus === 401 || r.httpStatus === 403) {
    return { ok: false, message: 'WorkBuddy token 失效(HTTP ' + r.httpStatus + ')，请重新获取' };
  }

  // 2) 执行签到（幂等：code=10001 视为已签到）
  let c;
  try {
    c = await apiCall(endpoint, token, uid, domain, '/v2/billing/meter/daily-checkin');
  } catch (e) {
    return { ok: false, networkError: isNetworkError(e), message: '执行签到失败: ' + e.message };
  }
  if (c.httpStatus === 401 || c.httpStatus === 403) {
    return { ok: false, message: 'WorkBuddy token 失效(HTTP ' + c.httpStatus + ')，请重新获取' };
  }
  const j = c.json;
  const code = j && (typeof j.code === 'number' ? j.code : (j.code !== undefined ? Number(j.code) : null));
  // 积分/连续天数：响应里是单数 credit 与 snake_case 的 streak_days（2026-09-29 实测），
  // 取出来供日志与系统通知使用（通知里「积分 100 · 连续 3 天」比「成功」有信息量得多）
  const credits = (j && j.data && (j.data.credit !== undefined ? j.data.credit : j.data.credits)) ?? null;
  const streakDays = (j && j.data && j.data.streak_days !== undefined) ? j.data.streak_days : null;
  if (code === 0) {
    return { ok: true, credits, streakDays, message: 'WorkBuddy 签到成功' + srcTag, preview: JSON.stringify(j).slice(0, 200), source };
  }
  if (code === 10001) {
    // alreadyCheckedIn：供上层做「跨天保护」判断 —— 0 点刚过时接口可能还在报昨天的状态
    return { ok: true, alreadyCheckedIn: true, credits, streakDays, message: 'WorkBuddy 今日已签到（幂等）' + srcTag, preview: JSON.stringify(j).slice(0, 200), source };
  }
  return { ok: false, message: 'WorkBuddy 接口返回异常 code=' + code + ' ' + (c.text || '').slice(0, 200) };
}

module.exports = { workbuddyCheckin, resolveCredentials, decodeJwtPayload };
