'use strict';
/*
 * 网络可用性判定与等待 —— 支撑「断网时等到联网了再签到」。
 *
 * 背景：计划任务的 RunOnlyIfNetworkAvailable 只在「任务启动前」检查一次；
 * Wi-Fi 已连、但上游没网（路由器/宽带故障）时任务照样会启动，请求直接
 * ENOTFOUND，整轮失败，要等到下一个时段才重试（2026-10-02 实测：
 * 09:00 的触发因不在线错过，直到 12:06 网络恢复才被 StartWhenAvailable 补跑）。
 *
 * 这里提供三件事：
 *   - isNetworkError()  判断异常是否属于「网络不可用」，而不是 token 失效等业务错误；
 *   - isOnline()        主动探测：对签到用到的站点发 HEAD 请求，任一有 HTTP 响应即视为在线；
 *   - waitForNetwork()  在时限内轮询探测，直到恢复联网或超时。
 *
 * 探测刻意用「能否建立 HTTP 连接」而不是 ping / DNS：
 *   - DNS 有缓存，断网时会给出假阳性（解析成功但连不上）；
 *   - ping 常被防火墙/运营商挡掉，同样不可靠。
 */

const DEFAULT_PROBE_HOSTS = ['https://www.workbuddy.cn', 'https://api.trae.cn'];
const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 20000;
const PROGRESS_EVERY_MS = 60000;

// Node 的 fetch 失败会包成 TypeError: fetch failed，真实错误码在 err.cause.code 里，
// 所以必须把 cause 链一起看（isNetworkError 会逐层展开）。
const NETWORK_ERROR_RE = new RegExp([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED',
  'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET',
  'UND_ERR_', 'fetch failed', 'socket hang up', 'TimeoutError', 'AbortError',
  'operation was aborted',
].join('|'), 'i');

/** 判断异常/消息是否属于「网络不可用」。接受 Error 或字符串。 */
function isNetworkError(input) {
  if (!input) return false;
  if (typeof input === 'string') return NETWORK_ERROR_RE.test(input);
  const parts = [];
  for (let e = input, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    if (e.code) parts.push(String(e.code));
    if (e.name) parts.push(String(e.name));
    if (e.message) parts.push(String(e.message));
  }
  return NETWORK_ERROR_RE.test(parts.join(' | '));
}

/** 探针主机列表：CHECKIN_NET_PROBE_HOSTS（逗号分隔）> 默认两个签到站点 */
function probeHosts() {
  const env = String(process.env.CHECKIN_NET_PROBE_HOSTS || '').trim();
  const list = env
    ? env.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_PROBE_HOSTS.slice();
  return list.map((h) => (/^https?:\/\//i.test(h) ? h : 'https://' + h));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 单个探针：有 HTTP 响应（哪怕 4xx/5xx）→ 在线；非网络类错误（如证书问题）→ 也认为链路通 */
async function probeOne(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctrl.signal });
    return true;
  } catch (e) {
    return !isNetworkError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** 是否在线：任一探针主机可达即为在线（并行探测，整体耗时约等于单个超时） */
async function isOnline(opts = {}) {
  const hosts = opts.hosts || probeHosts();
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_PROBE_TIMEOUT_MS;
  if (!hosts.length) return true; // 没配探针就当作在线，绝不因此卡住签到
  try {
    const results = await Promise.all(hosts.map((h) => probeOne(h, timeoutMs)));
    return results.some(Boolean);
  } catch (_) {
    return true; // 探测自身异常时不阻断主流程
  }
}

/**
 * 等待网络恢复。
 * @returns {Promise<boolean>} true = 在时限内恢复；false = 超时仍未恢复
 */
async function waitForNetwork(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 0;
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (timeoutMs <= 0) return false;
  const start = Date.now();
  let lastProgressAt = start;
  for (;;) {
    if (await isOnline({ hosts: opts.hosts, timeoutMs: opts.probeTimeoutMs })) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return false;
    if (onProgress && Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
      lastProgressAt = Date.now();
      try { onProgress(elapsed, timeoutMs); } catch (_) { /* 进度日志失败不影响等待 */ }
    }
    await sleep(Math.min(intervalMs, timeoutMs - elapsed));
  }
}

/** 本地时间是否处于「刚过午夜」的跨天保护窗口（0 点起 minutes 分钟内） */
function inCrossDayWindow(minutes, now = new Date()) {
  const n = Number(minutes);
  if (!(n > 0)) return false;
  return now.getHours() * 60 + now.getMinutes() < n;
}

/** 把毫秒写成可读时长，避免小阈值下出现「超过 0 分钟」这种文案 */
function formatDuration(ms) {
  if (ms >= 60000) {
    const m = ms / 60000;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + ' 分钟';
  }
  if (ms >= 1000) return Math.round(ms / 1000) + ' 秒';
  return Math.max(0, Math.round(ms)) + ' 毫秒';
}

module.exports = {
  DEFAULT_PROBE_HOSTS,
  isNetworkError,
  probeHosts,
  isOnline,
  waitForNetwork,
  inCrossDayWindow,
  formatDuration,
};
