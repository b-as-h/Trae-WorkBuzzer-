'use strict';
/*
 * 自动签到主程序：依次执行 WorkBuddy 与 Trae 签到，结果写入日志。
 *
 * 用法：
 *   node checkin.js               # 正常跑；当天两端都已完成 → 整轮直接跳过
 *   node checkin.js --force       # 忽略「当日已完成」标记，强制重跑（排障用）
 *   node checkin.js --quiet-skip  # 两端今日都完成时静默退出（不写日志、不抢锁），供联网补签触发任务用
 *   node checkin.js --no-notify   # 本轮不发系统通知（排障用）
 *
 * 计划任务每天调用本文件 5 次（00:01 / 09:00 / 13:00 / 17:00 / 21:00），
 * 实际由 run-hidden.vbs 以隐藏窗口拉起，不会弹出命令提示符。
 * 另有 DailyCheckinOnNet：系统报告「网络已连接」时立即补跑一次（断网兜底的最后一层）。
 *
 * 设计要点：
 *   - 无感运行：wscript 隐藏窗口启动 node，全程无可见窗口、无交互
 *   - 当日幂等：任一端签到成功即写入 state/daily-status.json 的当天记录，
 *     后续时段的触发会跳过该端；两端都完成则整轮直接退出（只留一行日志），
 *     不再每个时段重复走一遍签到流程；跨天自动重置
 *   - WorkBuddy：凭证临期时自动调用 wb-auth.js 续期（纯 HTTP，无需浏览器）
 *   - Trae：自动从客户端 storage.json 提取 token（约 14 天有效、客户端自动刷新），
 *     内置 9074 限流重试 + 8 分钟总时限；已签到则直接跳过
 *   - 两端独立容错，互不影响：一端失败只重试该端，不会让另一端重复签到
 *   - 断网兜底：请求失败若判定为「网络不可用」，本轮会在预算内等网络恢复再重试；
 *     等不到就交给联网事件任务与下一个时段，绝不把「断网」当成「签到失败」草草收场
 *   - 跨天保护：0 点刚过时接口返回的「今日已签到」可能还是昨天的状态，不记为当日完成
 *   - 系统通知：成功每天一条汇总（不打扰档位），失败/漏签风险必提醒
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { traeCheckin } = require('./lib/trae.js');
const { workbuddyCheckin, decodeJwtPayload } = require('./lib/workbuddy.js');
const dailyState = require('./lib/daily-state.js');
const net = require('./lib/net.js');
const notify = require('./lib/notify.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'checkin.log');
// WorkBuddy 凭证由 wb-auth.js（官方插件 OAuth 授权流）获取与续期，详见其头部说明。
const AUTH_SCRIPT = path.join(ROOT, 'wb-auth.js');

const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const QUIET_SKIP = ARGS.includes('--quiet-skip');
const NO_NOTIFY = ARGS.includes('--no-notify');

// ── 运行防护 ─────────────────────────────────────────────────────────────
// 计划任务现在通过 wscript 立即返回（隐藏窗口启动），于是任务层面的
//   · MultipleInstances=IgnoreNew（互斥）
//   · ExecutionTimeLimit=PT15M（运行上限）
// 都不再生效。这两件事改由脚本自己兜住，否则会静默退化：
//   1) 单实例锁：上一次还没跑完（例如 Trae 正在退避重试）时，下一次触发直接退出
//   2) 看门狗：任何异常挂起都会在 WATCHDOG_MS 后强制结束并留一行日志
const LOCK_PATH = path.join(ROOT, 'state', 'run.lock.json');
const WATCHDOG_MS = Number(process.env.CHECKIN_WATCHDOG_MS) > 0
  ? Number(process.env.CHECKIN_WATCHDOG_MS)
  : 20 * 60 * 1000;

function readLock() {
  try {
    // 去掉可能的 UTF-8 BOM：被记事本等工具改存后会带 BOM，JSON.parse 会失败，
    // 那样锁会被当成"没有锁"而静默失效
    const raw = fs.readFileSync(LOCK_PATH, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/** 同步小睡：仅用于抢锁时跨过极短的"文件已建、内容未写"窗口（Node 主线程允许 Atomics.wait） */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {}
}

/**
 * 原子创建锁文件：用 'wx' 打开（文件已存在则直接失败）。
 * 这样抢锁是"单步原子操作"，不会再出现两个进程同时读到"无锁"、然后双双写入的竞态。
 */
function tryCreateLock() {
  try {
    const fd = fs.openSync(LOCK_PATH, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        startedAtLocal: new Date().toISOString(),
      }));
    } finally { fs.closeSync(fd); }
    return true;
  } catch (_) { return false; }
}

/** 尝试抢占单实例锁；锁持有者进程已死或锁过期时自动接管 */
function acquireLock() {
  try { fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true }); } catch (_) {}
  if (tryCreateLock()) return { ok: true };

  // 已存在锁文件：判断持有者是否还活着、锁是否已过期。
  // 注意 openSync('wx') 与 writeSync 之间有一个极短窗口 —— 此刻文件已存在但内容为空，
  // readLock() 会解析失败；若立刻当成"损坏锁"删掉，就会误删别人刚创建的锁、两个进程同时跑。
  // 因此内容解析不出来时先短暂等待再重读一次，跨过这个窗口。
  let cur = readLock();
  if (!cur) {
    sleepSync(150);
    cur = readLock();
  }
  if (cur && cur.pid) {
    const age = Date.now() - (cur.startedAt || 0);
    let alive = false;
    try { process.kill(cur.pid, 0); alive = true; } catch (_) { alive = false; }
    if (alive && cur.pid !== process.pid && age < WATCHDOG_MS) {
      return { ok: false, holder: cur };
    }
  }
  // 持有者已死 / 锁过期 / 锁文件损坏（半截 JSON → readLock 返回 null）→ 清掉后重试一次
  try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  if (tryCreateLock()) return { ok: true };
  if (!fs.existsSync(LOCK_PATH)) {
    // 锁文件根本建不出来（目录不可写等）→ 不能因此阻塞签到，降级放行
    return { ok: true, degraded: true };
  }
  const again = readLock();
  return { ok: false, holder: again || { pid: '未知', startedAtLocal: '未知' } };
}

/** 只释放自己持有的锁，避免误删后来者的锁 */
function releaseLock() {
  try {
    const cur = readLock();
    if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch (_) { /* ignore */ }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('未找到 config.json，请先复制 config.example.json 并填写');
  }
  // 剥掉可能的 UTF-8 BOM：用记事本等工具编辑保存过的话会带上 BOM，
  // 否则 JSON.parse 直接抛错，表现为「配上 token 反而跑不起来」
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

// ── 日志轮转 ─────────────────────────────────────────────────────────────
// 后台无人值守运行，日志只增不减会一直长下去。超过 CHECKIN_LOG_MAX_BYTES 时
// 把当前日志改名存档为 checkin.log.1 / .2 / …（取第一个未占用的序号，
// 不覆盖、不删除任何已有文件），然后从空文件继续写。
const MAX_LOG_BYTES = Number(process.env.CHECKIN_LOG_MAX_BYTES) > 0
  ? Number(process.env.CHECKIN_LOG_MAX_BYTES)
  : 1024 * 1024; // 默认 1 MiB

/** 把字节数写成可读单位，避免小阈值下出现「超过 0 KiB」这种文案 */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} 字节`;
}

function rollLogIfNeeded() {
  let size;
  try {
    size = fs.statSync(LOG_PATH).size;
  } catch (_) {
    return; // 文件还不存在，无需轮转
  }
  if (size < MAX_LOG_BYTES) return;
  for (let i = 1; i <= 999; i += 1) {
    const archived = `${LOG_PATH}.${i}`;
    if (fs.existsSync(archived)) continue;
    try {
      fs.renameSync(LOG_PATH, archived);
      return archived;
    } catch (_) {
      return; // 改名失败不阻塞主流程，继续往原文件追加
    }
  }
}

function log(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}`;
  // 隐藏窗口运行时控制台不可见/可能已被回收，写控制台失败不能影响落盘
  try { console.log(msg); } catch (_) {}
  try {
    const archived = rollLogIfNeeded();
    if (archived) {
      fs.appendFileSync(LOG_PATH, `[${ts}] [日志轮转] 上一份日志超过 ${formatBytes(MAX_LOG_BYTES)}，已存档为 ${path.basename(archived)}\n`);
    }
    fs.appendFileSync(LOG_PATH, msg + '\n');
  } catch (_) {}
}

// 判断是否需要"抓取刷新"：
// 汇总 config + 本机日志采集后，若仍无 3 天内不会过期的有效 token，则需要刷新。
function needRefreshWorkbuddyToken(cfg) {
  try {
    const wb = (cfg && cfg.workbuddy) || {};
    // 完全没有凭证 → 需要（重新）授权
    if (!wb.accessToken && !wb.refreshToken) return true;
    // 距上次刷新过久 → 主动刷新。用 refreshedAt 而非 JWT 的 exp：
    // 刷新时 refreshToken 会滚动更新，以本地刷新时间为准更可靠。
    const ageH = wb.refreshedAt ? (Date.now() - wb.refreshedAt) / 3600000 : Infinity;
    if (!wb.accessToken || ageH >= 20) return true;
    // 仍能解出 exp 时再做一次临期兜底
    const p = decodeJwtPayload(wb.accessToken);
    if (p && p.exp && p.exp * 1000 - Date.now() < 3 * 86400 * 1000) return true;
    return false;
  } catch (_) {
    return true;
  }
}

/**
 * 调 wb-auth.js 续期 WorkBuddy 凭证。
 * 新鲜度以本地 refreshedAt 判断（官方 access token 约 28 天有效），超过 20 小时即主动
 * 刷新一次。参数 force 仅为兼容既有调用点而保留。
 */
function tryRefreshWorkbuddyToken(force) {
  if (!fs.existsSync(AUTH_SCRIPT)) {
    log('[WorkBuddy] 未找到 wb-auth.js，跳过自动刷新');
    return false;
  }
  log('[WorkBuddy] 凭证缺失/临期/已失效，尝试自动刷新...');
  try {
    const authArgs = [AUTH_SCRIPT, 'ensure'];
    const r = spawnSync(process.execPath, authArgs, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 6 * 60 * 1000,
      windowsHide: true, // 刷新过程中同样不弹控制台
    });
    const tail = (s) => (s || '').trim().split('\n').slice(-3).join(' | ');
    if (r.stdout) log('[WorkBuddy][capture] ' + tail(r.stdout));
    if (r.stderr) log('[WorkBuddy][capture-err] ' + tail(r.stderr));
    return r.status === 0;
  } catch (e) {
    log('[WorkBuddy] 自动刷新异常：' + e.message);
    return false;
  }
}

// ── 配置读取（config.json 缺键时用默认值，保证旧配置直接可用） ────────────────

/** 跨天保护窗口分钟数：CHECKIN_CROSS_DAY_GUARD_MINUTES > config.crossDayGuard.minutes > 60 */
function crossDayGuardMinutes(cfg) {
  const env = Number(process.env.CHECKIN_CROSS_DAY_GUARD_MINUTES);
  if (Number.isFinite(env) && env >= 0) return env;
  const g = cfg && cfg.crossDayGuard;
  if (g && Number.isFinite(Number(g.minutes))) return Number(g.minutes);
  return 60;
}

/** 断网重试参数：CHECKIN_NET_WAIT_MS > config.networkRetry.waitMs > 10 分钟 */
function networkRetryConfig(cfg) {
  const r = (cfg && cfg.networkRetry) || {};
  const envWait = Number(process.env.CHECKIN_NET_WAIT_MS);
  return {
    enabled: r.enabled !== false,
    waitMs: Number.isFinite(envWait) && envWait > 0
      ? envWait
      : (Number.isFinite(Number(r.waitMs)) && Number(r.waitMs) > 0 ? Number(r.waitMs) : 10 * 60 * 1000),
    probeIntervalMs: Number.isFinite(Number(r.probeIntervalMs)) && Number(r.probeIntervalMs) > 0
      ? Number(r.probeIntervalMs)
      : 20000,
  };
}

/** 等待联网的可用预算：配置值、看门狗剩余时间、6 分钟重试预留三者取最小 */
function networkWaitBudget(configuredMs, startedAt) {
  const RESERVE_MS = 6 * 60 * 1000; // 给「联网后重试」留余量，别撞上看门狗
  const remaining = WATCHDOG_MS - (Date.now() - startedAt) - RESERVE_MS;
  return Math.max(0, Math.min(configuredMs, remaining));
}

function sideLabel(key) {
  return key === 'workbuddy' ? 'WorkBuddy' : 'Trae';
}

/**
 * 记入「当日已完成」；但命中跨天保护窗口时只写日志、不落盘。
 *
 * 为什么要保护：接口的「今日已签到」是服务端按它自己的时刻翻篇的。本地 0 点刚过时
 * 拿到的很可能还是「昨天」的状态，若直接记为今天完成，后面的时段全部跳过 —— 整整漏签一天。
 * 真实领取成功（非幂等路径）不受影响；幂等返回则留给下一个时段复核，代价只是多查一次。
 */
function markDoneWithCrossDayGuard(cfg, state, key, r) {
  const minutes = crossDayGuardMinutes(cfg);
  if (r.alreadyCheckedIn && net.inCrossDayWindow(minutes)) {
    log(`[跨天保护] ${sideLabel(key)} 返回「今日已签到」，但当前处于跨天保护窗口（00:00 起 ${net.formatDuration(minutes * 60000)}），`
      + '可能是服务端还没跨天（昨天的状态），不记为当日完成，留给后续时段复核');
    return false;
  }
  dailyState.markDone(state, key, r.message);
  return true;
}

/**
 * WorkBuddy 单端签到。
 * @returns {Promise<{ok,networkError,message,credits,streakDays,alreadyCheckedIn,pendingReview}>}
 */
async function runWorkbuddy(cfg, state, ctx) {
  const out = { ok: false, networkError: false, message: '' };
  try {
    if (needRefreshWorkbuddyToken(cfg)) {
      if (ctx && ctx.online === false) {
        // 断网时抓 token 必然失败，还要白等最多 6 分钟（浏览器启动 + 超时）—— 直接跳过
        log('[WorkBuddy] 当前探测不到网络，跳过 token 自动刷新（联网后本轮重试或下个时段会再试）');
      } else {
        tryRefreshWorkbuddyToken(true);
        // 刷新后重新读取 config（token 可能已更新）
        try { Object.assign(cfg, loadConfig()); } catch (_) {}
      }
    }
    const r = await workbuddyCheckin(cfg);
    Object.assign(out, r);
    if (r.ok) {
      log(`[WorkBuddy] 成功：${r.message}${r.preview ? ' ' + r.preview : ''}`);
      if (!markDoneWithCrossDayGuard(cfg, state, 'workbuddy', r)) out.pendingReview = true;
      return out;
    }
    log(`[WorkBuddy] 失败：${r.message}`);
    // 失败且疑似 token 问题 → 再刷新一次并重试
    if (/token|401|403|失效|过期/i.test(r.message)) {
      if (tryRefreshWorkbuddyToken(true)) {
        try { Object.assign(cfg, loadConfig()); } catch (_) {}
        const r2 = await workbuddyCheckin(cfg);
        Object.assign(out, r2);
        if (r2.ok) {
          log(`[WorkBuddy] 刷新 token 后成功：${r2.message}`);
          if (!markDoneWithCrossDayGuard(cfg, state, 'workbuddy', r2)) out.pendingReview = true;
          return out;
        }
        log(`[WorkBuddy] 刷新 token 后仍失败：${r2.message}`);
      }
    }
  } catch (e) {
    out.message = '异常：' + e.message;
    log(`[WorkBuddy] 异常：${e.message}`);
  }
  return out;
}

/** Trae 单端签到；返回值同 runWorkbuddy */
async function runTrae(cfg, state) {
  const out = { ok: false, networkError: false, message: '' };
  try {
    const r = await traeCheckin(cfg.trae || {});
    Object.assign(out, r);
    const src = r.tokenSource
      ? `（token来源:${r.tokenSource}${r.tokenExpDays != null ? `,剩余${r.tokenExpDays.toFixed(1)}天` : ''}）`
      : '';
    if (r.ok) {
      log(`[Trae] 成功：${r.message}${r.credits != null ? ' 获得积分=' + r.credits : ''}${src}`);
      if (!markDoneWithCrossDayGuard(cfg, state, 'trae', r)) out.pendingReview = true;
      return out;
    }
    log(`[Trae] 失败：${r.message}${src}`);
  } catch (e) {
    out.message = '异常：' + e.message;
    log(`[Trae] 异常：${e.message}`);
  }
  return out;
}

/** 收尾通知：成功每天一条汇总；失败/断网超时/漏签风险按档位提醒（详见 lib/notify.js） */
function sendRunNotification(cfg, state, results, flags) {
  if (NO_NOTIFY) return;
  // pendingReview（被跨天保护拦下、其实接口说「已签到」的一端）不算失败：
  // 0 点刚过时若两端都是这种情况，发「签到未完成」告警是误报，只会吓人 —— 现场只写日志。
  const pendingSides = ['workbuddy', 'trae'].filter((k) => !dailyState.isDone(state, k)
    && !(results[k] && results[k].pendingReview));
  const decision = notify.notifyRun({
    cfg,
    state,
    bothDone: flags.wbDone && flags.traeDone,
    pendingSides,
    results,
  }, log);
  if (decision && decision.mark) {
    try { dailyState.markNotified(state, decision.mark.key, decision.mark.value); } catch (_) { /* 落盘失败不影响主流程 */ }
  }
}

async function run() {
  // ⓪ --quiet-skip：联网补签任务专用。两端今日都已完成时直接退出，不写日志、不抢锁
  //    （网络每次重连都会触发一次，不能让日志被「已完成跳过」刷屏）
  if (QUIET_SKIP) {
    try {
      const s = dailyState.loadState();
      if (dailyState.isDone(s, 'workbuddy') && dailyState.isDone(s, 'trae')) return;
    } catch (_) { /* 状态读不到就照常往下走 */ }
  }

  // ① 单实例：上一次未结束时本次直接退出（取代任务层面的 IgnoreNew）
  const lock = acquireLock();
  if (!lock.ok) {
    log(`[跳过] 已有另一个签到进程在运行（pid ${lock.holder.pid}，开始于 ${lock.holder.startedAtLocal}），本轮直接退出`);
    return;
  }
  if (lock.degraded) {
    log('[警告] 单实例锁无法创建（state 目录不可写？），本轮降级放行、不启用互斥保护');
  }

  const cfg = loadConfig();
  const state = dailyState.loadState();
  const retryCfg = networkRetryConfig(cfg);
  const runStartedAt = Date.now();

  const wbDone = dailyState.isDone(state, 'workbuddy');
  const traeDone = dailyState.isDone(state, 'trae');

  // ② 当天两端都已签到 → 本轮不发任何请求，直接退出（只留一行日志）
  if (!FORCE && wbDone && traeDone) {
    log(`今日签到已完成（WorkBuddy ${state.workbuddy.at} / Trae ${state.trae.at}），本轮跳过，不重复签到`);
    return;
  }

  log(`===== 自动签到开始 =====${FORCE ? '（--force：忽略当日已完成标记）' : ''}`);

  // ③ 待办集合：当天已完成的一端直接跳过，只补做未完成的一端
  const results = {};
  const pending = new Set(['workbuddy', 'trae'].filter((k) => FORCE || !dailyState.isDone(state, k)));
  for (const key of ['workbuddy', 'trae']) {
    if (!pending.has(key)) log(`[${sideLabel(key)}] 今日已完成（${state[key].at}），跳过`);
  }

  // ④ 至多两轮：第一轮失败若判定为断网，等网络恢复后再补一轮（预算见 networkWaitBudget）
  const MAX_PASSES = 2;
  for (let pass = 0; pass < MAX_PASSES && pending.size; pass += 1) {
    if (pass > 0) {
      const budget = networkWaitBudget(retryCfg.waitMs, runStartedAt);
      if (budget <= 0) {
        log('[网络] 等待联网的预算不足（看门狗时限临近），本轮结束；联网后计划任务会自动补签');
        break;
      }
      const lastErr = Array.from(pending).map((k) => (results[k] && results[k].message) || '').filter(Boolean).join('；');
      log(`[网络] 检测到断网（${String(lastErr).slice(0, 160)}），等待网络恢复后重试（最多 ${net.formatDuration(budget)}）`);
      const recovered = await net.waitForNetwork({
        timeoutMs: budget,
        intervalMs: retryCfg.probeIntervalMs,
        onProgress: (elapsed, total) => log(`[网络] 仍在等待联网（已等 ${net.formatDuration(elapsed)} / 最多 ${net.formatDuration(total)}）`),
      });
      if (!recovered) {
        log('[网络] 等待联网超时，本轮结束；联网后计划任务会自动补签');
        break;
      }
      log('[网络] 网络已恢复，重试未完成的一端');
    }

    const online = await net.isOnline({ timeoutMs: 3000 });
    if (!online) log('[网络] 探测不到网络（断网中），本轮请求可能直接失败');
    let networkFailure = false;
    for (const key of Array.from(pending)) {
      const r = key === 'workbuddy'
        ? await runWorkbuddy(cfg, state, { online })
        : await runTrae(cfg, state);
      results[key] = r;
      if (dailyState.isDone(state, key)) {
        pending.delete(key);
      } else if (r.networkError) {
        networkFailure = true;
      }
    }
    if (!pending.size) break;
    if (!networkFailure || !retryCfg.enabled) break;
  }

  // ⑤ 收尾：报告当日整体状态；两端都完成则明确提示后续时段会自动跳过
  const wbNow = dailyState.isDone(state, 'workbuddy');
  const traeNow = dailyState.isDone(state, 'trae');
  if (wbNow && traeNow) {
    log('今日两端签到均已完成，后续时段触发将自动跳过');
  } else {
    const pending = [wbNow ? null : 'WorkBuddy', traeNow ? null : 'Trae'].filter(Boolean).join(' + ');
    log(`本轮结束，未完成：${pending}（将在下一个时段重试）`);
  }

  log('===== 自动签到结束 =====');

  // ⑥ 通知（成功汇总 / 失败与漏签告警）；通知失败只写日志，绝不影响上面的结果
  sendRunNotification(cfg, state, results, { wbDone: wbNow, traeDone: traeNow });
}

/** 看门狗 + 锁释放的统一收尾（任务层面已无运行时长上限，这里必须自兜） */
function withWatchdog() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const wd = WATCHDOG_MS >= 60000 ? `${Math.round(WATCHDOG_MS / 60000)} 分钟` : `${WATCHDOG_MS} 毫秒`;
      log(`[看门狗] 运行超过 ${wd} 仍未结束，强制退出（pid ${process.pid}）`);
      releaseLock();
      process.exit(2);
    }, WATCHDOG_MS);
    run().then(
      () => { clearTimeout(timer); resolve(); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * 收尾退出。
 *
 * 为什么不直接 process.exit()：Node 24（内置 fetch/undici）在请求刚结束后立刻强杀进程，
 * 会稳定踩到句柄收尾断言崩溃（Windows 上是
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"，退出码 0xC0000409，
 * 2026-10-02 实测；托管 Node 22.22.2 无此问题）。这里统一走稳妥路径：
 * 退出码交给事件循环自然排空（实测 1 秒内退出），再用一个 unref 的定时器兜底 ——
 * 万一有句柄残留（如 keep-alive 连接）到点强杀，保证「进程一定会结束」这条底线不变。
 */
const HARD_EXIT_DELAY_MS = 3000;
function finish(code) {
  process.exitCode = code;
  const hardExit = setTimeout(() => process.exit(code), HARD_EXIT_DELAY_MS);
  hardExit.unref(); // 它自己不持有事件循环：正常排空时进程立即退出，无需等它
}

withWatchdog()
  .then(() => { releaseLock(); finish(0); })
  .catch((e) => {
    releaseLock();
    log('致命错误：' + (e && e.message ? e.message : e));
    finish(1);
  });
