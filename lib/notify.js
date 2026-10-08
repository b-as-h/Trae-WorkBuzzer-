'use strict';
/*
 * 系统通知（Windows Toast）—— 让「签到成功了 / 没签上」这件事不再只躺在日志里。
 *
 * 设计原则（2026-10-02 与用户逐条敲定，多账号后依然成立）：
 *   - 不打扰：成功走「静默横幅」（无声音、约 5 秒自动消失、不抢焦点）或
 *     「只进通知中心」（夜里，SuppressPopup，屏幕上一个卡片都不弹）；
 *     只有需要用户处理的事（失败 / 断网等待超时 / 漏签风险）才用「横幅 + 提示音」。
 *   - 不重复：成功每天只发一条（当日首次全部完成时）；同一失败原因每天只发一条；
 *     唯独「漏签风险」档（notify.lastSlotAfter 之后仍未完成）每轮都提醒 —— 这是最后兜底。
 *   - 不阻塞：通知失败只写一行 [通知] 日志，绝不影响签到主流程，也绝不弹控制台窗口
 *     （powershell.exe 以 windowsHide 拉起，无黑框、无模态框）。
 *   - 多账号不啰嗦：一条通知里按「账号 × 端」列要点，超过 3 项就折叠成「等 N 项」，
 *     免得单个弹窗被塞成一篇流水账（Windows 通知横幅本来也放不下）。
 *
 * 真正的弹窗动作在 notify-toast.ps1 里（Windows PowerShell 5.1 的 WinRT 接口，零依赖）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { taskKey, SIDE_LABEL } = require('./accounts.js');

const ROOT = path.join(__dirname, '..');
const PAYLOAD_PATH = path.join(ROOT, 'state', '.notify.json');
const TOAST_SCRIPT = path.join(ROOT, 'notify-toast.ps1');
const WINDOWS_POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const TOAST_TIMEOUT_MS = 15000;
/** 通知正文上限：横幅放不下太长的文字，超出就折叠 */
const BODY_MAX = 190;

/** 解析 "HH:MM" → 当日分钟数；解析失败用 fallback */
function parseClock(value, fallbackMinutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return fallbackMinutes;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallbackMinutes;
  return h * 60 + mi;
}

/** 当前时刻是否落在 [startHm, endHm) 里；跨午夜（如 23:00–07:00）自动处理 */
function inClockWindow(now, startHm, endHm) {
  if (startHm === endHm) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return startHm < endHm ? (cur >= startHm && cur < endHm) : (cur >= startHm || cur < endHm);
}

/** 失败类别：断网 / token / 接口异常 —— 用于去重键和告警文案 */
function classifyFailure(result) {
  if (result && result.networkError) return { cls: 'network', label: '断网未完成' };
  const msg = (result && result.message) || '';
  if (/token|401|403|失效|过期/i.test(msg)) return { cls: 'token', label: 'token 失效需重新授权' };
  return { cls: 'api', label: '接口/其他异常' };
}

/** 任务显示名：多账号时带上账号名 */
function taskName(task, multi) {
  return (multi ? task.name + '·' : '') + (SIDE_LABEL[task.side] || task.side);
}

/** 单任务一句话（成功用），尽量给出积分/连续天数这类让人有感觉的信息 */
function taskSummary(task, result, multi) {
  const name = taskName(task, multi);
  if (!result) return name + '未执行';
  if (!result.ok) return name + '未完成';
  if (result.sharedToken) return name + '跳过（与其它账号共用同一 Trae 登录态）';
  const bits = [result.alreadyCheckedIn ? '已签到' : '签到成功'];
  if (result.credits != null) bits.push('积分 ' + result.credits);
  if (result.streakDays != null) bits.push('连续 ' + result.streakDays + ' 天');
  return name + ' ' + bits.join(' · ');
}

/** v1 兼容导出：按「端」的一句话 */
function sideSummary(side, result) {
  return taskSummary({ id: '', name: '', side }, result, false);
}

/** 把要点列表折成一条不会撑爆横幅的正文 */
function joinCapped(items) {
  const list = items.filter(Boolean);
  if (!list.length) return '';
  const head = list.slice(0, 3);
  let text = head.join('　');
  if (list.length > head.length) text += `　等 ${list.length} 项`;
  if (text.length > BODY_MAX) text = text.slice(0, BODY_MAX - 1) + '…';
  return text;
}

/**
 * 决定这一轮要不要发通知、发什么。
 * @param {object} p { cfg, state, now, tasks, results, pending, multi }
 *   tasks   本轮全部任务 [{id,name,side}]
 *   results 任务结果表，键 = taskKey(task)
 *   pending 未完成的任务数组
 * @returns {null|{kind,mode,title,body,tag,mark}}
 */
function decideNotification(p) {
  const cfg = p.cfg || {};
  const ncfg = cfg.notify || {};
  if (ncfg.enabled === false) return null;

  const now = p.now || new Date();
  const nightStart = parseClock(ncfg.nightStart, 23 * 60);
  const nightEnd = parseClock(ncfg.nightEnd, 7 * 60);
  // 漏签风险档的起点：CHECKIN_LAST_SLOT_AFTER（测试可用 00:00 强制走该档）> config.notify.lastSlotAfter > 21:00
  const lastSlotAfter = parseClock(process.env.CHECKIN_LAST_SLOT_AFTER || ncfg.lastSlotAfter, 21 * 60);
  const notified = (p.state && p.state.notify) || {};
  const results = p.results || {};
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  const pending = Array.isArray(p.pending) ? p.pending : [];
  const multi = !!p.multi;
  const resultOf = (t) => results[taskKey(t)];

  if (!pending.length && tasks.length) {
    if (notified.successAt) return null; // 今天已经报过成功
    const accountCount = new Set(tasks.map((t) => t.id)).size;
    const sides = [...new Set(tasks.map((t) => t.side))]
      .map((s) => SIDE_LABEL[s] || s)
      // 顺序固定为 Trae + WorkBuddy（与 v1 的标题文案一致），不随账号配置变化
      .sort((a, b) => (a === 'Trae' ? 0 : 1) - (b === 'Trae' ? 0 : 1));
    return {
      kind: 'success',
      tag: 'checkin-success',
      mode: inClockWindow(now, nightStart, nightEnd) ? 'center' : 'silent',
      title: accountCount === 1
        ? `今日签到完成（${sides.join(' + ')}）`
        : `今日签到完成（${accountCount} 个账号 / ${tasks.length} 项）`,
      body: joinCapped(tasks.map((t) => taskSummary(t, resultOf(t), multi))),
      mark: { key: 'successAt', value: new Date().toISOString() },
    };
  }

  if (!pending.length) return null;
  const classes = pending.map((t) => t.id + ':' + t.side + ':' + classifyFailure(resultOf(t)).cls).sort();
  const failureKey = classes.join(',');
  const failureText = pending
    .map((t) => taskName(t, multi) + ' ' + classifyFailure(resultOf(t)).label)
    .join('；');
  const cur = now.getHours() * 60 + now.getMinutes();
  const isLastSlot = cur >= lastSlotAfter; // 当天最后一个时段之后 → 漏签风险，必须提醒
  if (!isLastSlot && notified.failureKey === failureKey) return null; // 同一原因今天已提醒过
  const label = pending.length <= 3
    ? pending.map((t) => taskName(t, multi)).join(' + ')
    : `${pending.length} 项`;
  return {
    kind: 'alert',
    tag: 'checkin-alert',
    mode: 'alert',
    title: (isLastSlot ? '⚠ 签到可能漏签：' : '签到未完成：') + label,
    body: joinCapped([failureText, '后续时段会自动重试；网络恢复后也会立即补签。']),
    mark: { key: 'failureKey', value: failureKey },
  };
}

/** 真正把通知发出去：写载荷 → 调 notify-toast.ps1（隐藏窗口）→ 删载荷 */
function sendToast(payload, log) {
  const say = (line) => { try { if (log) log(line); } catch (_) { /* ignore */ } };
  if (!fs.existsSync(TOAST_SCRIPT)) {
    say('[通知] 未找到 notify-toast.ps1，跳过通知');
    return false;
  }
  if (!fs.existsSync(WINDOWS_POWERSHELL)) {
    say('[通知] 未找到 Windows PowerShell，跳过通知');
    return false;
  }
  try {
    fs.mkdirSync(path.dirname(PAYLOAD_PATH), { recursive: true });
    fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    say('[通知] 写入通知载荷失败：' + e.message);
    return false;
  }
  try {
    const r = spawnSync(WINDOWS_POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', TOAST_SCRIPT, '-PayloadPath', PAYLOAD_PATH,
    ], { windowsHide: true, timeout: TOAST_TIMEOUT_MS, encoding: 'utf8' });
    if (r.status === 0) return true;
    const err = ((r.stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' | '))
      || (r.error && r.error.message) || ('exit ' + r.status);
    say('[通知] 发送失败：' + err);
    return false;
  } finally {
    try { fs.unlinkSync(PAYLOAD_PATH); } catch (_) { /* ignore */ }
  }
}

/** 决策 + 发送；返回决策对象（供 checkin.js 落 state 去重标记）。发送失败不影响返回值。 */
function notifyRun(params, log) {
  let decision = null;
  try {
    decision = decideNotification(params);
  } catch (e) {
    try { log('[通知] 决策异常：' + e.message); } catch (_) { /* ignore */ }
    return null;
  }
  if (!decision) return null;
  const ok = sendToast({
    title: decision.title, body: decision.body, mode: decision.mode, tag: decision.tag,
  }, log);
  if (!ok) return null;
  // 成功也留一行痕：后台无窗口运行，日志是唯一可核对的现场（也能回答「为什么没收到通知」）
  try { log('[通知] 已发送（' + decision.mode + '）：' + decision.title); } catch (_) { /* ignore */ }
  return decision;
}

module.exports = {
  PAYLOAD_PATH,
  TOAST_SCRIPT,
  parseClock,
  inClockWindow,
  classifyFailure,
  sideSummary,
  taskSummary,
  taskName,
  decideNotification,
  sendToast,
  notifyRun,
};
