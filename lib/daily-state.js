'use strict';
/*
 * 当日签到状态记录 —— 让「当天签到成功后，后面的时段自动停止签到」变为可能。
 *
 * 状态文件：state/daily-status.json
 *   {
 *     "date": "2026-09-29",                       // 本机本地日期，跨天自动重置
 *     "workbuddy": { "ok": true, "at": "...", "message": "..." } | null,
 *     "trae":      { "ok": true, "at": "...", "message": "..." } | null,
 *     "updatedAt": "..."
 *   }
 *
 * 约定：只有 ok === true 才会被认作「今日已完成」并参与跳过判断；
 *       失败不落盘（或落盘也会在读取时被清掉），这样失败的那一端仍会在下一时段重试。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_PATH = path.join(STATE_DIR, 'daily-status.json');

/** 本机本地日期 YYYY-MM-DD（不用 UTC，避免晚上 8 点后被算成第二天） */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState() {
  return { date: todayKey(), workbuddy: null, trae: null, notify: {}, updatedAt: new Date().toISOString() };
}

/** 读取当日状态；文件缺失、损坏或日期不是今天 → 返回空白状态（即跨天自动重置） */
function loadState() {
  let raw = null;
  // 剥掉可能的 UTF-8 BOM（记事本另存会加）：否则 JSON.parse 失败会被当成
  // 「今天还没签到」，导致已经签过的时段被重复执行
  try {
    const text = fs.readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    raw = JSON.parse(text);
  } catch (_) { /* 缺失/损坏按空白处理 */ }
  if (!raw || typeof raw !== 'object' || raw.date !== todayKey()) return emptyState();
  if (raw.workbuddy && raw.workbuddy.ok !== true) raw.workbuddy = null;
  if (raw.trae && raw.trae.ok !== true) raw.trae = null;
  return raw;
}

/** 原子写入当日状态 */
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    state.date = todayKey();
    state.updatedAt = new Date().toISOString();
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
  } catch (_) { /* 状态写失败不影响签到主流程 */ }
}

function isDone(state, key) {
  return !!(state && state[key] && state[key].ok === true);
}

/** 读取当日的通知去重标记（notify.successAt / notify.failureKey） */
function getNotified(state, key) {
  return state && state.notify ? (state.notify[key] || null) : null;
}

/** 写入通知去重标记并立即落盘：成功每天只报一条、同一失败原因每天只报一条 */
function markNotified(state, key, value) {
  if (!state.notify || typeof state.notify !== 'object') state.notify = {};
  state.notify[key] = value;
  saveState(state);
}

/** 把某一端标记为「今日已完成」并立即落盘 */
function markDone(state, key, message) {
  state[key] = { ok: true, at: new Date().toISOString(), message: String(message || '').slice(0, 240) };
  saveState(state);
}

module.exports = { STATE_PATH, todayKey, loadState, saveState, isDone, markDone, getNotified, markNotified, emptyState };
