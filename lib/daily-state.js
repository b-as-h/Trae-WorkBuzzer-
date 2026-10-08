'use strict';
/*
 * 当日签到状态记录 —— 让「当天签到成功后，后面的时段自动停止签到」变为可能。
 *
 * 状态文件：state/daily-status.json
 *   {
 *     "date": "2026-10-08",                    // 本机本地日期，跨天自动重置
 *     "accounts": {
 *       "default": {                           // 账号 ID（见 lib/accounts.js）
 *         "name": "默认账号",                   // 便于人工核对（可选）
 *         "workbuddy": { "ok": true, "at": "...", "message": "..." } | null,
 *         "trae":      { "ok": true, "at": "...", "message": "..." } | null
 *       }
 *     },
 *     "notify": { "successAt": "...", "failureKey": "..." },
 *     "updatedAt": "..."
 *   }
 *
 * 约定：
 *   - 只有 ok === true 才会被认作「今日已完成」并参与跳过判断；
 *     失败不落盘（或落盘也会在读取时被清掉），这样失败的那一端仍会在下一时段重试。
 *   - 旧版（v1 单账号）的扁平结构 { date, workbuddy, trae } 会被自动映射到
 *     ID 为 `default` 的账号上 —— 与 lib/accounts.js 迁移旧配置时用的固定 ID 一致，
 *     因此升级当天「今天已经签过」的记忆不会丢，不会重复签到。
 */
const fs = require('fs');
const path = require('path');
const { LEGACY_ID } = require('./accounts.js');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_PATH = path.join(STATE_DIR, 'daily-status.json');

/** 本机本地日期 YYYY-MM-DD（不用 UTC，避免晚上 8 点后被算成第二天） */
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState() {
  return { date: todayKey(), accounts: {}, notify: {}, updatedAt: new Date().toISOString() };
}

/** 清掉失败记录（只认 ok === true），并补齐 accounts 容器 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) raw.accounts = {};
  // v1 扁平结构 → default 账号
  if (raw.workbuddy || raw.trae) {
    const slot = raw.accounts[LEGACY_ID] || {};
    if (raw.workbuddy) slot.workbuddy = raw.workbuddy;
    if (raw.trae) slot.trae = raw.trae;
    raw.accounts[LEGACY_ID] = slot;
    delete raw.workbuddy;
    delete raw.trae;
  }
  for (const id of Object.keys(raw.accounts)) {
    const slot = raw.accounts[id];
    if (!slot || typeof slot !== 'object') { delete raw.accounts[id]; continue; }
    for (const side of ['workbuddy', 'trae']) {
      if (slot[side] && slot[side].ok !== true) slot[side] = null;
    }
  }
  if (!raw.notify || typeof raw.notify !== 'object') raw.notify = {};
  return raw;
}

/** 读取当日状态；文件缺失、损坏或日期不是今天 → 返回空白状态（即跨天自动重置） */
function loadState() {
  let raw = null;
  // 剥掉可能的 UTF-8 BOM（记事本另存会加）：否则 JSON.parse 失败会被当成
  // 「今天还没签到」，导致已经签过的时段被重复执行
  try {
    const text = fs.readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, '');
    raw = sanitize(JSON.parse(text));
  } catch (_) { /* 缺失/损坏按空白处理 */ }
  if (!raw || raw.date !== todayKey()) return emptyState();
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

/** 取某账号的当日槽位（不存在返回 null） */
function accountSlot(state, accountId) {
  return (state && state.accounts && state.accounts[accountId]) || null;
}

function isDone(state, accountId, side) {
  const slot = accountSlot(state, accountId);
  return !!(slot && slot[side] && slot[side].ok === true);
}

/** 把某账号的某一端标记为「今日已完成」并立即落盘 */
function markDone(state, accountId, side, message, name) {
  if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
  const slot = state.accounts[accountId] || (state.accounts[accountId] = {});
  if (name) slot.name = String(name).slice(0, 40);
  slot[side] = { ok: true, at: new Date().toISOString(), message: String(message || '').slice(0, 240) };
  saveState(state);
  return slot[side];
}

/** 账号被删除时清掉它的当日状态（避免面板/日志里出现幽灵账号） */
function dropAccount(state, accountId) {
  if (state && state.accounts && state.accounts[accountId]) {
    delete state.accounts[accountId];
    saveState(state);
  }
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

module.exports = {
  STATE_PATH,
  todayKey,
  loadState,
  saveState,
  isDone,
  markDone,
  accountSlot,
  dropAccount,
  getNotified,
  markNotified,
  emptyState,
  sanitize,
};
