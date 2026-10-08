'use strict';
/*
 * 账号解析 / 旧配置迁移 —— 多账号支持的地基（零依赖）
 *
 * 背景：v1 的 config.json 里只有一份 trae / workbuddy 凭证，state/daily-status.json
 *       里也只有 trae / workbuddy 两个槽位。v2 要支持「多账号 + 批量签到」，同时
 *       **不能让老用户的 config.json 失效**（迁移必须是自动的、无损的、可解释的）。
 *
 * 数据模型（config.json）：
 *   {
 *     "accounts": [
 *       {
 *         "id": "default" | "acc-1a2b3c4d",   // 稳定 ID，state 与日志按它归属
 *         "name": "主账号",                    // 面板展示名
 *         "enabled": true,                     // 停用后不参与签到（凭证保留）
 *         "trae":      { "enabled": true, "manualToken": "", "deviceId": "", ... },
 *         "workbuddy": { "enabled": true, "accessToken": "", "refreshToken": "", ... }
 *       }
 *     ],
 *     "trae": { ...全局默认值（host/region/重试参数），被每个账号的 trae 块覆盖... },
 *     "workbuddy": { ...旧的单账号凭证槽位，迁移后清空... },
 *     "networkRetry": {...}, "crossDayGuard": {...}, "notify": {...}
 *   }
 *
 * 迁移规则（`materialize`）：
 *   - config.json 里没有非空 accounts 数组时，视为「旧版单账号安装」，
 *     由顶层 trae/workbuddy 合成一个账号，ID 固定为 `default`。
 *     固定 ID 是刻意的：旧版 state/daily-status.json 的扁平结构也映射到 `default`，
 *     这样迁移当天「今天已经签过」的记忆不会丢，不会因为升级而重复签到。
 *   - 迁移后把顶层 workbuddy 清空（凭证只留一份，避免两处不同步）。
 *   - 顶层 trae 保留：它是 host/region/重试参数这类「全局默认值」，不是凭证。
 *
 * 约定：本模块只做「读 → 归一化 → 写」，不发起任何网络请求。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
/** 旧版单账号合成账号的固定 ID（旧 state 也映射到它） */
const LEGACY_ID = 'default';
const SIDES = ['trae', 'workbuddy'];
const SIDE_LABEL = { trae: 'Trae', workbuddy: 'WorkBuddy' };

function newId() {
  return 'acc-' + crypto.randomBytes(4).toString('hex');
}

function readConfig(configPath = CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error('未找到 config.json，请先复制 config.example.json 并填写');
  }
  // 剥掉可能的 UTF-8 BOM：用记事本等工具保存过会带上，否则 JSON.parse 直接抛错
  const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

/** 原子写回 config.json（临时文件 + rename；写失败不破坏原文件） */
function writeConfig(cfg, configPath = CONFIG_PATH) {
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, configPath);
  return cfg;
}

function hasAccounts(cfg) {
  return !!cfg && Array.isArray(cfg.accounts) && cfg.accounts.length > 0;
}

function block(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** 就地归一化一个账号对象（补 id/name/enabled/trae/workbuddy），返回同一引用 */
function normalizeAccount(a, i) {
  const o = block(a);
  if (!o.id || typeof o.id !== 'string') o.id = newId();
  if (!o.name || typeof o.name !== 'string') o.name = '账号 ' + (i + 1);
  if (typeof o.enabled !== 'boolean') o.enabled = true;
  o.trae = block(o.trae);
  o.workbuddy = block(o.workbuddy);
  return o;
}

/** 旧版单账号安装合成的账号（不写入 cfg，除非调用 materialize） */
function legacyAccount(cfg) {
  return {
    id: LEGACY_ID,
    name: '默认账号',
    enabled: true,
    legacy: true,
    trae: {},
    workbuddy: block(cfg && cfg.workbuddy),
  };
}

/**
 * 解析出当前生效的账号列表。config.json 没有 accounts 时返回合成的单账号，
 * 老安装因此无需任何改动即可继续工作。
 * @returns {Array<{id,name,enabled,trae,workbuddy}>}
 */
function resolveAccounts(cfg) {
  if (hasAccounts(cfg)) return cfg.accounts.map((a, i) => normalizeAccount(a, i));
  return [legacyAccount(cfg)];
}

/**
 * 把合成账号真正写进 cfg.accounts（供需要落盘的调用方使用）。
 * @returns {{cfg, accounts, migrated:boolean}}
 */
function materialize(cfg) {
  if (hasAccounts(cfg)) return { cfg, accounts: resolveAccounts(cfg), migrated: false };
  const wb = block(cfg.workbuddy);
  const acct = normalizeAccount({
    id: LEGACY_ID,
    name: '默认账号',
    enabled: true,
    trae: {},
    workbuddy: wb,
  }, 0);
  cfg.accounts = [acct];
  // 凭证只保留一份：迁移后顶层 workbuddy 清空（顶层 trae 是全局默认值，保留）
  if (Object.keys(wb).length) cfg.workbuddy = {};
  return { cfg, accounts: cfg.accounts, migrated: true };
}

/** 读取配置 + 解析账号；legacy=true 表示尚未迁移（调用方若要落盘需先 materialize） */
function loadConfig(configPath = CONFIG_PATH) {
  const cfg = readConfig(configPath);
  return { cfg, accounts: resolveAccounts(cfg), legacy: !hasAccounts(cfg), configPath };
}

/**
 * 该账号某一端是否参与签到。
 * 缺省视为「参与」（老账号的 trae/workbuddy 块里没有 enabled 字段）；
 * 新增账号默认只开 WorkBuddy，Trae 需要显式配上 token 才打开（见 addAccount）。
 */
function sideEnabled(acct, side) {
  const b = block(acct && acct[side]);
  return b.enabled !== false;
}

/**
 * 合并「全局 trae 默认值 + 账号级覆盖」，得到可直接喂给 lib/trae.js 的配置。
 *
 * 两条多账号安全规则（单账号 v1 不受影响）：
 *   1) 账号自己填了 manualToken → 标记 manualOnly：该账号只认自己的 token，
 *      不再与本机客户端 / trae-token.json 择优混用。否则可能拿另一个账号的
 *      登录态去签到（择优看 exp，本机客户端的 token 往往更长，会把手工 token 挤掉）。
 *   2) 顶层的 manualToken / tokenFile 是 v1 单账号（default）的遗留配置，
 *      只允许 default 继承；其它账号继承到就是「用错账号」，直接剥离。
 */
function effectiveTrae(cfg, acct) {
  const own = block(acct && acct.trae);
  const merged = Object.assign({}, block(cfg && cfg.trae), own);
  const ownManual = String(own.manualToken || '').trim();
  if (ownManual) {
    merged.manualToken = ownManual;
    merged.manualOnly = true;
  } else if (acct && acct.id !== LEGACY_ID) {
    delete merged.manualToken;
    delete merged.tokenFile;
  }
  return merged;
}

/** 账号级 WorkBuddy 凭证（迁移后全局槽位为空，凭证只存在于账号里） */
function effectiveWorkbuddy(cfg, acct) {
  const own = block(acct && acct.workbuddy);
  if (Object.keys(own).length) return own;
  // 极端情况：配置里写了 accounts 但凭证还留在顶层（手工编辑），单账号时兜底认它
  if (cfg && Array.isArray(cfg.accounts) && cfg.accounts.length === 1) return block(cfg.workbuddy);
  return own;
}

/** 组装某个账号在某一端的运行配置：{ trae, workbuddy } */
function entryConfig(cfg, acct) {
  return { trae: effectiveTrae(cfg, acct), workbuddy: effectiveWorkbuddy(cfg, acct) };
}

/** 按 id 或名称（不区分大小写）找账号 */
function findAccount(cfg, idOrName) {
  const key = String(idOrName == null ? '' : idOrName).trim();
  if (!key) return null;
  const list = resolveAccounts(cfg);
  return list.find((a) => a.id === key)
    || list.find((a) => a.name === key)
    || list.find((a) => a.name.toLowerCase() === key.toLowerCase())
    || null;
}

/** 新增账号：默认只启用 WorkBuddy（Trae 需要单独的 token + 设备 ID，见 setTraeCreds） */
function addAccount(cfg, name) {
  materialize(cfg);
  const list = cfg.accounts;
  const acct = normalizeAccount({
    id: newId(),
    name: String(name || '').trim() || ('账号 ' + (list.length + 1)),
    enabled: true,
    trae: { enabled: false },
    workbuddy: { enabled: true },
  }, list.length);
  list.push(acct);
  return acct;
}

function removeAccount(cfg, id) {
  materialize(cfg);
  const i = cfg.accounts.findIndex((a) => a.id === id);
  if (i < 0) return false;
  cfg.accounts.splice(i, 1);
  return true;
}

function updateAccount(cfg, id, patch) {
  materialize(cfg);
  const acct = cfg.accounts.find((a) => a.id === id);
  if (!acct) return null;
  if (patch && typeof patch.name === 'string' && patch.name.trim()) acct.name = patch.name.trim().slice(0, 40);
  if (patch && typeof patch.enabled === 'boolean') acct.enabled = patch.enabled;
  for (const side of SIDES) {
    if (patch && typeof patch[side] === 'boolean') {
      acct[side] = block(acct[side]);
      acct[side].enabled = patch[side];
    }
  }
  return acct;
}

/** 写入/清除某账号的 Trae 手工凭证；写入 token 时自动打开该端的参与开关 */
function setTraeCreds(cfg, id, token, deviceId) {
  materialize(cfg);
  const acct = cfg.accounts.find((a) => a.id === id);
  if (!acct) return null;
  acct.trae = block(acct.trae);
  const t = String(token == null ? '' : token).trim();
  const d = String(deviceId == null ? '' : deviceId).trim();
  acct.trae.manualToken = t;
  acct.trae.deviceId = d;
  if (t) acct.trae.enabled = true;
  else acct.trae.enabled = false;
  return acct;
}

/** 写入某账号的 WorkBuddy 令牌（由 wb-auth.js / 面板授权流调用） */
function setWorkbuddyCreds(cfg, id, creds) {
  materialize(cfg);
  const acct = cfg.accounts.find((a) => a.id === id);
  if (!acct) return null;
  acct.workbuddy = Object.assign(block(acct.workbuddy), creds || {});
  if (acct.workbuddy.accessToken || acct.workbuddy.refreshToken) acct.workbuddy.enabled = true;
  return acct;
}

/** 任务表（结果表）的键：一个「账号 × 端」就是一个任务 */
function taskKey(t) {
  return String(t && t.id) + '\u0000' + String(t && t.side);
}

/** 面板/CLI 展示用的脱敏摘要 */
function maskToken(t) {
  const s = String(t || '');
  if (!s) return '';
  return s.length <= 12 ? s.slice(0, 4) + '…' : s.slice(0, 6) + '…' + s.slice(-4);
}

module.exports = {
  ROOT,
  CONFIG_PATH,
  LEGACY_ID,
  SIDES,
  SIDE_LABEL,
  newId,
  readConfig,
  writeConfig,
  loadConfig,
  hasAccounts,
  materialize,
  resolveAccounts,
  normalizeAccount,
  sideEnabled,
  effectiveTrae,
  effectiveWorkbuddy,
  entryConfig,
  findAccount,
  addAccount,
  removeAccount,
  updateAccount,
  setTraeCreds,
  setWorkbuddyCreds,
  taskKey,
  maskToken,
};
