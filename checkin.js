'use strict';
/*
 * 自动签到主程序：按账号依次执行 WorkBuddy 与 Trae 签到，结果写入日志。
 *
 * 用法：
 *   node checkin.js                        # 全部启用账号；当天都已完成 → 整轮直接跳过
 *   node checkin.js --accounts id1,id2     # 只跑指定账号（面板「批量签到」用；也接受账号名）
 *   node checkin.js --account id1          # 只跑一个账号（可重复写多次）
 *   node checkin.js --force                # 忽略「当日已完成」标记，强制重跑（排障用）
 *   node checkin.js --quiet-skip           # 目标账号今日都完成时静默退出（不写日志、不抢锁）
 *   node checkin.js --no-notify            # 本轮不发系统通知（排障用）
 *
 * 计划任务每天调用本文件 5 次（00:01 / 09:00 / 13:00 / 17:00 / 21:00），
 * 实际由 run-hidden.vbs 以隐藏窗口拉起，不会弹出命令提示符。
 * 另有 DailyCheckinOnNet：系统报告「网络已连接」时立即补跑一次（断网兜底的最后一层）。
 *
 * 设计要点：
 *   - 无感运行：wscript 隐藏窗口启动 node，全程无可见窗口、无交互
 *   - 多账号：账号列表来自 config.json 的 accounts（旧版单账号配置会被自动视为一个
 *     ID 为 default 的账号，详见 lib/accounts.js）。任务粒度是「账号 × 端」，
 *     每个任务独立幂等、独立容错；某个账号失败不会影响其它账号
 *   - 当日幂等：任一端签到成功即写入 state/daily-status.json 的当天记录，
 *     后续时段的触发会跳过该端；所有任务都完成则整轮直接退出（只留一行日志），
 *     不再每个时段重复走一遍签到流程；跨天自动重置
 *   - WorkBuddy：凭证临期时自动调用 wb-auth.js 续期（纯 HTTP，无需浏览器）
 *   - Trae：默认从本机客户端 storage.json 提取 token（约 14 天有效、客户端自动刷新），
 *     多账号可在账号里单独配置 manualToken + deviceId；内置 9074 限流重试 + 总时限；
 *     已签到则直接跳过。多个账号若解析到同一个 Trae 登录态，会跳过重复签到并说明原因
 *   - 批量节流：账号之间默认间隔 batch.intervalMs（默认 1.5 秒），避免瞬间并发触发平台风控
 *   - 断网兜底：请求失败若判定为「网络不可用」，本轮会在预算内等网络恢复再重试；
 *     等不到就交给联网事件任务与下一个时段，绝不把「断网」当成「签到失败」草草收场
 *   - 跨天保护：0 点刚过时接口返回的「今日已签到」可能还是昨天的状态，不记为当日完成
 *   - 系统通知：成功每天一条汇总（不打扰档位），失败/漏签风险必提醒
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { traeCheckin, resolveTokenInfo } = require('./lib/trae.js');
const { taskKey } = require('./lib/accounts.js');
const { workbuddyCheckin, decodeJwtPayload } = require('./lib/workbuddy.js');
const dailyState = require('./lib/daily-state.js');
const accounts = require('./lib/accounts.js');
const net = require('./lib/net.js');
const notify = require('./lib/notify.js');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const LOG_PATH = path.join(ROOT, 'checkin.log');
// WorkBuddy 凭证由 wb-auth.js（官方插件 OAuth 授权流）获取与续期，详见其头部说明。
const AUTH_SCRIPT = path.join(ROOT, 'wb-auth.js');
const SIDES = ['workbuddy', 'trae'];

const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const QUIET_SKIP = ARGS.includes('--quiet-skip');
const NO_NOTIFY = ARGS.includes('--no-notify');

/** 解析 --accounts a,b / --account a（可重复）→ Set；未指定返回 null（= 全部启用账号） */
function parseTargets() {
  const out = new Set();
  const add = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => out.add(s));
  for (let i = 0; i < ARGS.length; i += 1) {
    const a = ARGS[i];
    if (a === '--accounts' || a === '--account') add(ARGS[i + 1]);
    else if (a.startsWith('--accounts=')) add(a.slice('--accounts='.length));
    else if (a.startsWith('--account=')) add(a.slice('--account='.length));
  }
  return out.size ? out : null;
}

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
function needRefreshWorkbuddyToken(wbCreds) {
  try {
    const wb = wbCreds || {};
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
 * 调 wb-auth.js 为某个账号续期 WorkBuddy 凭证。
 * 新鲜度以本地 refreshedAt 判断（官方 access token 约 28 天有效），超过 20 小时即主动
 * 刷新一次。刷新成功后调用方需要重新读取 config.json（token 已更新）。
 */
function tryRefreshWorkbuddyToken(accountId, tag) {
  if (!fs.existsSync(AUTH_SCRIPT)) {
    log(`${tag}[WorkBuddy] 未找到 wb-auth.js，跳过自动刷新`);
    return false;
  }
  log(`${tag}[WorkBuddy] 凭证缺失/临期/已失效，尝试自动刷新...`);
  try {
    const r = spawnSync(process.execPath, [AUTH_SCRIPT, 'ensure', '--account', accountId], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 6 * 60 * 1000,
      windowsHide: true, // 刷新过程中同样不弹控制台
    });
    const tail = (s) => (s || '').trim().split('\n').slice(-3).join(' | ');
    if (r.stdout) log(`${tag}[WorkBuddy][capture] ` + tail(r.stdout));
    if (r.stderr) log(`${tag}[WorkBuddy][capture-err] ` + tail(r.stderr));
    return r.status === 0;
  } catch (e) {
    log(`${tag}[WorkBuddy] 自动刷新异常：` + e.message);
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

/** 批量签到节流：账号/任务之间的最小间隔，CHECKIN_BATCH_INTERVAL_MS > config.batch.intervalMs > 1500 */
function batchIntervalMs(cfg) {
  const env = Number(process.env.CHECKIN_BATCH_INTERVAL_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  const b = (cfg && cfg.batch) || {};
  const v = Number(b.intervalMs);
  return Number.isFinite(v) && v >= 0 ? v : 1500;
}

/** 等待联网的可用预算：配置值、看门狗剩余时间、6 分钟重试预留三者取最小 */
function networkWaitBudget(configuredMs, startedAt) {
  const RESERVE_MS = 6 * 60 * 1000; // 给「联网后重试」留余量，别撞上看门狗
  const remaining = WATCHDOG_MS - (Date.now() - startedAt) - RESERVE_MS;
  return Math.max(0, Math.min(configuredMs, remaining));
}

function sideLabel(side) {
  return side === 'workbuddy' ? 'WorkBuddy' : 'Trae';
}

/**
 * 记入「当日已完成」；但命中跨天保护窗口时只写日志、不落盘。
 *
 * 为什么要保护：接口的「今日已签到」是服务端按它自己的时刻翻篇的。本地 0 点刚过时
 * 拿到的很可能还是「昨天」的状态，若直接记为今天完成，后面的时段全部跳过 —— 整整漏签一天。
 * 真实领取成功（非幂等路径）不受影响；幂等返回则留给下一个时段复核，代价只是多查一次。
 */
function markDoneWithCrossDayGuard(cfg, state, task, r) {
  const minutes = crossDayGuardMinutes(cfg);
  if (r.alreadyCheckedIn && net.inCrossDayWindow(minutes)) {
    log(`[跨天保护] ${taskLabel(task)} 返回「今日已签到」，但当前处于跨天保护窗口（00:00 起 ${net.formatDuration(minutes * 60000)}），`
      + '可能是服务端还没跨天（昨天的状态），不记为当日完成，留给后续时段复核');
    return false;
  }
  dailyState.markDone(state, task.id, task.side, r.message, task.name);
  return true;
}

/** 日志前缀：只有多个账号时才带账号名，单账号日志保持 v1 原样（便于旧日志/脚本对照） */
function makeTagger(accountList) {
  const multi = accountList.length > 1;
  return (task) => (multi ? `[账号:${task.name}] ` : '');
}

function taskLabel(task, multi) {
  return (multi ? `${task.name}·` : '') + sideLabel(task.side);
}

/**
 * WorkBuddy 单账号签到。
 * @returns {Promise<{ok,networkError,message,credits,streakDays,alreadyCheckedIn,pendingReview}>}
 */
async function runWorkbuddyTask(ctx, task, state, online) {
  const out = { ok: false, networkError: false, message: '' };
  const tag = ctx.tagger(task);
  try {
    let acct = accounts.findAccount(ctx.cfg, task.id);
    if (!acct) return Object.assign(out, { message: '账号已不存在（可能刚被删除）' });
    let wb = accounts.effectiveWorkbuddy(ctx.cfg, acct);
    if (needRefreshWorkbuddyToken(wb)) {
      if (online === false) {
        // 断网时抓 token 必然失败，还要白等最多 6 分钟 —— 直接跳过
        log(`${tag}[WorkBuddy] 当前探测不到网络，跳过凭证自动刷新（联网后本轮重试或下个时段会再试）`);
      } else if (tryRefreshWorkbuddyToken(task.id, tag)) {
        ctx.reload(); // 刷新后重新读取 config（token 可能已更新）
        acct = accounts.findAccount(ctx.cfg, task.id);
        wb = accounts.effectiveWorkbuddy(ctx.cfg, acct);
      }
    }
    const r = await workbuddyCheckin({ workbuddy: wb });
    Object.assign(out, r);
    if (r.ok) {
      log(`${tag}[WorkBuddy] 成功：${r.message}${r.preview ? ' ' + r.preview : ''}`);
      if (!markDoneWithCrossDayGuard(ctx.cfg, state, task, r)) out.pendingReview = true;
      return out;
    }
    log(`${tag}[WorkBuddy] 失败：${r.message}`);
    // 失败且疑似 token 问题 → 再刷新一次并重试
    if (/token|401|403|失效|过期/i.test(r.message)) {
      if (tryRefreshWorkbuddyToken(task.id, tag)) {
        ctx.reload();
        const acct2 = accounts.findAccount(ctx.cfg, task.id);
        const r2 = await workbuddyCheckin({ workbuddy: accounts.effectiveWorkbuddy(ctx.cfg, acct2) });
        Object.assign(out, r2);
        if (r2.ok) {
          log(`${tag}[WorkBuddy] 刷新 token 后成功：${r2.message}`);
          if (!markDoneWithCrossDayGuard(ctx.cfg, state, task, r2)) out.pendingReview = true;
          return out;
        }
        log(`${tag}[WorkBuddy] 刷新 token 后仍失败：${r2.message}`);
      }
    }
  } catch (e) {
    out.message = '异常：' + e.message;
    log(`${tag}[WorkBuddy] 异常：${e.message}`);
  }
  return out;
}

/** Trae 单账号签到；返回值同 runWorkbuddyTask */
async function runTraeTask(ctx, task, state) {
  const out = { ok: false, networkError: false, message: '' };
  const tag = ctx.tagger(task);
  try {
    const acct = accounts.findAccount(ctx.cfg, task.id);
    if (!acct) return Object.assign(out, { message: '账号已不存在（可能刚被删除）' });
    const traeCfg = accounts.effectiveTrae(ctx.cfg, acct);

    // 多账号常见坑：几个账号都回落到「本机客户端登录态」，其实是同一个 Trae 账号。
    // 对同一个 token 重复签到既无意义又像刷接口，这里直接跳过并说明原因。
    // 只在**成功之后**才登记 token（见下），避免一个账号失败后其它账号被误判为「已共用」。
    const ti = resolveTokenInfo(traeCfg);
    if (ti && ti.token) {
      const hash = crypto.createHash('sha1').update(String(ti.token)).digest('hex').slice(0, 12);
      const owner = ctx.traeTokens.get(hash);
      if (owner) {
        const msg = `与账号「${owner}」共用同一 Trae 登录态，跳过重复签到`;
        log(`${tag}[Trae] ${msg}`);
        dailyState.markDone(state, task.id, task.side, msg, task.name);
        return Object.assign(out, { ok: true, sharedToken: true, message: msg });
      }
      out.tokenHash = hash;
    }

    const r = await traeCheckin(traeCfg);
    Object.assign(out, r);
    const src = r.tokenSource
      ? `（token来源:${r.tokenSource}${r.tokenExpDays != null ? `,剩余${r.tokenExpDays.toFixed(1)}天` : ''}）`
      : '';
    if (r.ok) {
      if (out.tokenHash) ctx.traeTokens.set(out.tokenHash, task.name);
      log(`${tag}[Trae] 成功：${r.message}${r.credits != null ? ' 获得积分=' + r.credits : ''}${src}`);
      if (!markDoneWithCrossDayGuard(ctx.cfg, state, task, r)) out.pendingReview = true;
      return out;
    }
    log(`${tag}[Trae] 失败：${r.message}${src}`);
  } catch (e) {
    out.message = '异常：' + e.message;
    log(`${tag}[Trae] 异常：${e.message}`);
  }
  return out;
}

/** 收尾通知：成功每天一条汇总；失败/断网超时/漏签风险按档位提醒（详见 lib/notify.js） */
function sendRunNotification(cfg, state, results, flags) {
  if (NO_NOTIFY) return;
  const decision = notify.notifyRun({
    cfg,
    state,
    tasks: flags.tasks,
    results,
    pending: flags.pending,
    multi: flags.multi,
  }, log);
  if (decision && decision.mark) {
    try { dailyState.markNotified(state, decision.mark.key, decision.mark.value); } catch (_) { /* 落盘失败不影响主流程 */ }
  }
}

/** 组装本轮任务列表：账号（启用）× 端（启用），可选按 --accounts 过滤 */
function buildTasks(list, onlyIds) {
  const tasks = [];
  for (const acct of list) {
    if (acct.enabled === false) continue;
    if (onlyIds && !onlyIds.has(acct.id) && !onlyIds.has(acct.name)) continue;
    for (const side of SIDES) {
      if (!accounts.sideEnabled(acct, side)) continue;
      tasks.push({ id: acct.id, name: acct.name, side });
    }
  }
  return tasks;
}

async function run() {
  const onlyIds = parseTargets();
  let loaded;
  try {
    loaded = accounts.loadConfig();
  } catch (e) {
    log('致命错误：' + e.message);
    return;
  }
  const list = loaded.accounts;
  const tasks = buildTasks(list, onlyIds);

  if (onlyIds) {
    const missing = [...onlyIds].filter((k) => !list.some((a) => a.id === k || a.name === k));
    if (missing.length) log(`[账号] 未找到指定账号：${missing.join(', ')}（已忽略）`);
  }
  if (!tasks.length) {
    log('没有需要签到的任务（账号被停用、该端被关闭，或 --accounts 指定的账号不存在），本轮结束');
    return;
  }

  const state = dailyState.loadState();
  // 本轮涉及几个账号（--accounts 只跑一部分时，横幅报的是这一部分，而不是全部账号）
  const scopeCount = new Set(tasks.map((t) => t.id)).size;
  const tagger = makeTagger(list);

  // ⓪ --quiet-skip：联网补签任务专用。目标账号今日都已完成时直接退出，不写日志、不抢锁
  //    （网络每次重连都会触发一次，不能让日志被「已完成跳过」刷屏）
  if (QUIET_SKIP && !FORCE) {
    const allDone = tasks.every((t) => dailyState.isDone(state, t.id, t.side));
    if (allDone) return;
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

  let cfg = loaded.cfg;
  if (loaded.legacy) {
    log('[账号] 检测到旧版单账号配置：本次按 ID=default 的单个账号执行（面板首次管理账号时会自动迁移为 accounts 结构）');
  }

  // 上下文：账号在运行中可能被面板改动，每次任务前都重新解析配置
  const ctx = {
    cfg,
    tagger,
    multi: list.length > 1,
    traeTokens: new Map(),
    reload() {
      try {
        ctx.cfg = accounts.loadConfig().cfg;
      } catch (e) {
        log('[账号] 重新读取 config.json 失败（继续使用上一次的配置）：' + e.message);
      }
    },
  };

  const retryCfg = networkRetryConfig(cfg);
  const batchWait = batchIntervalMs(cfg);
  const runStartedAt = Date.now();

  // ② 待办集合：已完成的「账号 × 端」直接跳过，只补做未完成的
  const pending = new Map(); // key: taskKey(task)
  const skipped = [];
  for (const t of tasks) {
    if (!FORCE && dailyState.isDone(state, t.id, t.side)) skipped.push(t);
    else pending.set(taskKey(t), t);
  }
  if (!pending.size) {
    log(`今日 ${tasks.length} 项签到任务均已完成（${scopeCount} 个账号），本轮跳过，不重复签到`);
    return;
  }

  log(`===== 自动签到开始（${scopeCount} 个账号 / 待办 ${pending.size} 项 / 共 ${tasks.length} 项）=====${FORCE ? '（--force：忽略当日已完成标记）' : ''}`);
  // 已完成的项在横幅之后再逐条说明，日志读起来才是「先开始、后明细」
  for (const t of skipped) {
    const slot = dailyState.accountSlot(state, t.id);
    log(`${tagger(t)}[${sideLabel(t.side)}] 今日已完成（${slot[t.side].at}），跳过`);
  }

  // ③ 至多两轮：第一轮失败若判定为断网，等网络恢复后再补一轮（预算见 networkWaitBudget）
  const results = {};
  const MAX_PASSES = 2;
  for (let pass = 0; pass < MAX_PASSES && pending.size; pass += 1) {
    if (pass > 0) {
      const budget = networkWaitBudget(retryCfg.waitMs, runStartedAt);
      if (budget <= 0) {
        log('[网络] 等待联网的预算不足（看门狗时限临近），本轮结束；联网后计划任务会自动补签');
        break;
      }
      const lastErr = Array.from(pending.values())
        .map((t) => (results[taskKey(t)] && results[taskKey(t)].message) || '')
        .filter(Boolean).join('；');
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
      log('[网络] 网络已恢复，重试未完成的任务');
    }

    const online = await net.isOnline({ timeoutMs: 3000 });
    if (!online) log('[网络] 探测不到网络（断网中），本轮请求可能直接失败');
    let networkFailure = false;
    for (const key of Array.from(pending.keys())) {
      const task = pending.get(key);
      if (!accounts.findAccount(ctx.cfg, task.id)) {
        log(`${tagger(task)}[跳过] 账号已不存在（可能刚被删除）`);
        pending.delete(key);
        continue;
      }
      const r = task.side === 'workbuddy'
        ? await runWorkbuddyTask(ctx, task, state, online)
        : await runTraeTask(ctx, task, state);
      results[key] = r;
      if (dailyState.isDone(state, task.id, task.side)) {
        pending.delete(key);
      } else if (r.networkError) {
        networkFailure = true;
      }
      // 批量节流：账号之间拉开间隔，避免瞬间并发把「多账号」暴露成风控特征
      if (pending.size && batchWait > 0) await new Promise((s) => setTimeout(s, batchWait));
    }
    if (!pending.size) break;
    if (!networkFailure || !retryCfg.enabled) break;
  }

  // ④ 收尾：报告当日整体状态；全部完成则明确提示后续时段会自动跳过
  const pendingList = Array.from(pending.values());
  const doneCount = tasks.length - pendingList.length;
  for (const acct of list) {
    if (acct.enabled === false) continue;
    const parts = SIDES
      .filter((side) => accounts.sideEnabled(acct, side) && tasks.some((t) => t.id === acct.id && t.side === side))
      .map((side) => sideLabel(side) + (dailyState.isDone(state, acct.id, side) ? '✓' : '✗'));
    if (parts.length) log(`[账号:${acct.name}] 今日：${parts.join('  ')}`);
  }
  if (!pendingList.length) {
    log(`今日 ${tasks.length} 项签到任务全部完成（${scopeCount} 个账号），后续时段触发将自动跳过`);
  } else {
    log(`本轮结束，未完成 ${pendingList.length}/${tasks.length} 项：${pendingList.map((t) => taskLabel(t, ctx.multi)).join('、')}（将在下一个时段重试）`);
  }
  log('===== 自动签到结束 =====');

  // ⑤ 通知（成功汇总 / 失败与漏签告警）；通知失败只写日志，绝不影响上面的结果
  sendRunNotification(ctx.cfg, state, results, {
    tasks,
    pending: pendingList,
    multi: ctx.multi,
    doneCount,
  });
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
