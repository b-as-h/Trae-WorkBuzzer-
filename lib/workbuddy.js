'use strict';
/*
 * WorkBuddy 自动签到模块（接口逆向自桌面端 app.asar，已实测可用）
 *
 *   - 状态查询：POST {endpoint}/v2/billing/meter/checkin-activity-status
 *   - 执行签到：POST {endpoint}/v2/billing/meter/daily-checkin
 *   - 端点：默认 https://www.workbuddy.cn（实测 workbuddy.cn / codebuddy.cn /
 *     copilot.tencent.com 三个域名均可用）
 *   - 鉴权头：Authorization: Bearer <token>  +  X-User-Id: <uid>  （X-Domain 可选）
 *   - 幂等：daily-checkin 返回 code=0 成功；code=10001 表示今日已签到
 *     （网关会包成 HTTP 400，所以必须看响应体的 code 而不是 HTTP 状态码）
 *
 * 凭证只从 config.json 读取，由 wb-auth.js 走官方插件 OAuth 授权流获取并自动续期。
 * 曾经尝试过的三条「本机自动取 token」路径均已证实走不通，故不再保留代码：
 *   1) 离线解密 workbuddy-desktop.info —— 其 accessToken 是 $wbEncrypted 加密对象，
 *      解密需要客户端内部构造的 AAD，无法稳定复现
 *   2) 读明文 info 文件 —— 文件存在，但该字段是加密的，不是明文
 *   3) 扫描客户端日志找 JWT —— 网页端已改用 Keycloak，日志中不存在明文 JWT
 */
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

/** 取 WorkBuddy 凭证（只认 config.json，由 wb-auth.js 写入与续期） */
function resolveCredentials(cfg) {
  const wb = cfg.workbuddy || {};
  const token = String(wb.accessToken || '').trim();
  let uid = String(wb.uid || '').trim();
  const domain = String(wb.domain || '').trim();
  if (token && !uid) {
    const p = decodeJwtPayload(token);
    if (p && p.sub) uid = p.sub;
  }
  return { token, uid, domain, source: token ? 'config' : '' };
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
      message: '未找到 WorkBuddy 凭证，请先运行：node wb-auth.js login',
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
      return { ok: false, message: 'WorkBuddy token 已过期，请运行：node wb-auth.js login' };
    }
    if (remainMs < 3 * 86400 * 1000) {
      console.warn('[WorkBuddy] 警告：token 将于 ' + new Date(payload.exp * 1000).toISOString() + ' 过期（wb-auth.js 会在 20 小时内自动续期，若持续失败请重新授权）');
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
