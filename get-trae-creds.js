'use strict';
/*
 * get-trae-creds.js —— 从任意 storage.json 提取 Trae 凭证（token + 设备 ID）
 *
 * 用途：多账号场景下，把第二个 Trae 账号的凭证填进面板「Trae 凭证」表单。
 *
 * 背景：Trae 没有可自动化的官方授权流（不像 WorkBuddy 的插件 OAuth），凭证只存在于
 *       Trae CN 客户端的 storage.json 里：
 *         · token     = iCubeAuthInfo://icube.cloudide 解密后的 Cloud-IDE JWT（约 14 天）
 *         · 设备 ID   = iCubeAuthInfo://icube-dc:<数字> 的数字部分（aha 设备 ID）
 *       这两项必须来自**同一份** storage.json（同一账号），否则接口持续返回 9074。
 *
 * 用法：
 *   node get-trae-creds.js                # 本机 Trae CN 客户端的登录态
 *   node get-trae-creds.js <storage.json> # 另一个账号的 storage.json（在那台机器上跑，
 *                                          #   或把文件拷到本机后指向它）
 *   node get-trae-creds.js --mask         # 只打印 token 指纹，不打印 token 本体（可进日志）
 *
 * 输出的 token 与设备 ID 直接粘贴到面板「账号管理 → 该账号 → Trae 凭证 → 保存」，
 * 保存后会自动打开该账号的「参与 Trae」开关。
 *
 * ⚠ 不要为了拿别的账号的凭证，把本机客户端换登成那个账号 ——
 *   本机客户端的登录态是「默认账号」的凭证来源，换登会把它顶掉。
 * ⚠ Cloud-IDE JWT 只有客户端登录时才会自动续期；约 14 天后需要重新提取一次。
 * ⚠ 只从**你指定的这一份**文件里取值：文件里解不出 token 就直接报错退出，
 *   绝不回落到本机登录态（那正是「拿错账号凭证」的事故源头）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decryptStorageValue, findStoragePath, findAhaDeviceId, jwtExp } = require('./lib/trae.js');

const ARGS = process.argv.slice(2);
const MASK = ARGS.includes('--mask');
const FILE = ARGS.find((a) => !a.startsWith('--'));

function die(msg, code) {
  console.error(msg);
  process.exit(code || 1);
}

function resolvePath() {
  if (FILE) {
    const p = path.resolve(FILE);
    if (!fs.existsSync(p)) die('找不到文件：' + p, 2);
    return p;
  }
  const p = findStoragePath({});
  if (!p) die('未找到本机 Trae CN 客户端的 storage.json（客户端未安装或未登录？）\n'
    + '  也可以在登录了目标账号的机器上运行本脚本，或把那份 storage.json 拷过来后指定路径。', 2);
  return p;
}

const p = resolvePath();

// 1) 读整份文件：设备 ID 与 token 都从它取（同源，缺一不可）
let storage = null;
try {
  storage = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  die('storage.json 解析失败：' + e.message, 2);
}
const deviceId = findAhaDeviceId(storage);
const hasClient = Object.keys(storage).some((k) => k.startsWith('iCubeAuthInfo'));

// 2) token：解密 iCubeAuthInfo://icube.cloudide（复用 lib/trae.js 的解密实现）
//    刻意不走 extractCloudIdeToken —— 它在指定文件解不出时会继续尝试本机客户端路径，
//    那会让「指向文件A、拿到文件B的凭证」静默发生，是本工具必须杜绝的错误。
let token = '';
for (const k of Object.keys(storage)) {
  if (!k.startsWith('iCubeAuthInfo://icube.cloudide')) continue;
  try {
    const raw = storage[k];
    let obj = null;
    if (typeof raw === 'string' && raw.trim().startsWith('{')) obj = JSON.parse(raw);   // 明文
    else if (typeof raw === 'string') obj = JSON.parse(decryptStorageValue(raw));        // 加密态解密
    if (obj && typeof obj.token === 'string' && obj.token) { token = obj.token; break; }
  } catch (_) { /* 该键解不开就试下一个候选键 */ }
}
if (!token) {
  die(hasClient
    ? '该文件里没有可解出的 iCubeAuthInfo://icube.cloudide —— 它多半不是（或不是最新的）登录态文件。'
      + '\n  指定文件解不出 token 时本工具不会回落到本机登录态（防止拿错账号凭证）。'
    : '该文件中没有 iCubeAuthInfo 相关键 —— 这多半不是 Trae 的 storage.json。', 1);
}
const exp = jwtExp(token);
const expDays = exp ? (exp * 1000 - Date.now()) / 86400000 : null;
const fp = crypto.createHash('sha1').update(token).digest('hex').slice(0, 12);

const out = [];
out.push('');
out.push('  Trae 凭证提取结果');
out.push('  ' + '='.repeat(60));
out.push('  storage.json : ' + p);
out.push('  设备 ID      : ' + (deviceId || '(未找到 icube-dc 键)'));
out.push('  token 过期   : ' + (exp ? new Date(exp * 1000).toLocaleString('zh-CN', { hour12: false })
  + '（剩 ' + (expDays != null ? expDays.toFixed(1) : '?') + ' 天）' : '(未知)'));
out.push('  token 指纹   : ' + fp);
out.push('  ' + '-'.repeat(60));
out.push('  token        : ' + (MASK ? '（已用 --mask 隐藏；去掉 --mask 查看本体）' : token));
out.push('  ' + '='.repeat(60));
if (!deviceId) {
  out.push('  ⚠ 该文件没有设备 ID，只填 token 会因 x-device-id 不匹配被 9074 拦下；');
  out.push('    请在登录了同一账号的客户端里找 iCubeAuthInfo://icube-dc:<数字> 的数字部分。');
}
if (expDays != null && expDays < 3) {
  out.push('  ⚠ token 剩余不足 3 天，建议重新登录该账号的客户端后再提取一次。');
}
out.push('');
out.push('  下一步：面板「账号管理」→ 该账号行 →「Trae 凭证」→');
out.push('          粘贴 token 与上面的设备 ID → 保存（自动开启参与 Trae）。');
out.push('');
console.log(out.join('\n'));
