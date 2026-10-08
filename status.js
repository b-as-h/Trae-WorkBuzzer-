'use strict';
/*
 * 签到状态查看器 —— 零依赖，只读本地数据；除「按 R 立即签到」与 WorkBuddy 只读状态查询外不发任何请求
 * 显示：多账号今日签到 / 积分统计 / 凭证有效期 / 定时任务 / 最近错误
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const accountsLib = require('./lib/accounts.js');
const dailyState = require('./lib/daily-state.js');

const ROOT  = __dirname;
const LOG   = path.join(ROOT, 'checkin.log');
const CFG   = accountsLib.CONFIG_PATH;

const W = 68;
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const hhmmss = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());

/** 终端显示宽度：CJK 与常见 emoji 占 2 列 */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c === 0xFE0F || c === 0x200D) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115F) || (c >= 0x2300 && c <= 0x23FF) ||
      (c >= 0x2600 && c <= 0x27BF) || (c >= 0x2B00 && c <= 0x2BFF) ||
      (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE6F) ||
      (c >= 0xFF00 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6) || c >= 0x1F000;
    w += wide ? 2 : 1;
  }
  return w;
}
const L = (label, width = 22) => '   ' + label + ' '.repeat(Math.max(1, width - dispWidth(label)));
/** 截断到指定显示宽度（超出补 …） */
function cut(s, width) {
  let out = '', w = 0;
  for (const ch of String(s)) {
    const cw = dispWidth(ch);
    if (w + cw > width - 1) return out + '…';
    out += ch; w += cw;
  }
  return out;
}

function readText(p) { try { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); } catch (_) { return ''; } }
function readJson(p) { try { return JSON.parse(readText(p)); } catch (_) { return null; } }
function decodeJwt(t) {
  try {
    const s = String(t).split('.')[1];
    if (!s) return null;
    return JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) { return null; }
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/** 实时查询某账号的 WorkBuddy 签到状态（只读接口，不领取任何东西） */
async function wbLive(creds) {
  const wb = creds || {};
  if (!wb.accessToken) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + wb.accessToken,
        'X-User-Id': String(wb.uid || ''),
        'X-Domain': String(wb.domain || ''),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: '{}',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => null);
    return j && j.code === 0 && j.data ? j.data : null;
  } catch (_) { clearTimeout(timer); return null; }
}

const daysUntil = (e) => (e ? (e * 1000 - Date.now()) / 86400000 : null);
function fmtExp(e) {
  if (!e) return '未知';
  const d = daysUntil(e);
  const tag = d <= 0 ? '已过期' : (d < 3 ? '即将过期' : '有效');
  return new Date(e * 1000).toLocaleString('zh-CN', { hour12: false }) + '（' + tag + '，剩 ' + d.toFixed(1) + ' 天）';
}

/**
 * 解析日志。多账号日志形如 `[ISO] [账号:名称] [Trae] 成功…`；
 * 单账号（或 v1 老日志）没有账号段，归到第一个账号名下。
 */
function parseLog(accountList) {
  const recs = [], fails = [];
  let runs = 0;
  const byName = new Map((accountList || []).map((a) => [a.name, a.id]));
  const fallback = accountList && accountList.length ? accountList[0].id : 'default';
  for (const l of readText(LOG).split(/\r?\n/)) {
    const m = l.match(/^\[([0-9T:.\-Z]+)\]\s*(.*)$/);
    if (!m) continue;
    const d = new Date(m[1]), body = m[2];
    const day = isNaN(d) ? null : dayKey(d);
    if (/自动签到开始/.test(body)) { runs++; continue; }
    const acctM = body.match(/^\[账号:([^\]]+)\]\s*/);
    const acctId = (acctM && byName.get(acctM[1])) || fallback;
    const rest = acctM ? body.slice(acctM[0].length) : body;
    if (/^\[Trae\]\s*成功/.test(rest)) {
      const c = rest.match(/获得积分=(\d+)/);
      recs.push({ day, platform: 'Trae', accountId: acctId, credits: c ? Number(c[1]) : 0 });
    } else if (/^\[WorkBuddy\]\s*成功/.test(rest)) {
      const c = rest.match(/"credits?"\s*:\s*(\d+)/);
      const s = rest.match(/"streak_days"\s*:\s*(\d+)/);
      recs.push({ day, platform: 'WorkBuddy', accountId: acctId, credits: c ? Number(c[1]) : 0, streak: s ? Number(s[1]) : null });
    } else if (/^\[(Trae|WorkBuddy)\]\s*(失败|异常|跳过)/.test(rest)) {
      // 日志里已经有 [账号:x] 前缀时不再重复拼一次账号名
      fails.push({ ts: isNaN(d) ? '--:--:--' : hhmmss(d), text: (acctM ? body : body).slice(0, 110) });
    }
  }
  return { recs, fails, runs };
}

function psJson(cmd) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 25000, windowsHide: true }).trim();
    return out ? JSON.parse(out) : null;
  } catch (_) { return undefined; }
}
const asArr = (x) => (x == null ? [] : (Array.isArray(x) ? x : [x]));
function parseDate(v) {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+)/);
  const d = m ? new Date(Number(m[1])) : new Date(v);
  return isNaN(d) ? null : d;
}
function taskInfo() {
  // State 必须显式转字符串，否则 ConvertTo-Json 会把它序列化成数字枚举；
  // Get-ScheduledTaskInfo 不接受数组形式的 -TaskName，需从管道传入。
  const t = psJson("$x = Get-ScheduledTask -TaskName DailyCheckin,DailyCheckinOnNet -ErrorAction SilentlyContinue; if ($x) { $x | Select-Object TaskName,@{n='State';e={[string]$_.State}} | ConvertTo-Json -Compress } else { '[]' }");
  if (t === undefined) return null;
  const list = asArr(t);
  if (!list.length) return [];
  const i = psJson("$x = Get-ScheduledTask -TaskName DailyCheckin,DailyCheckinOnNet -ErrorAction SilentlyContinue; if ($x) { $x | Get-ScheduledTaskInfo | Select-Object TaskName,NextRunTime,LastRunTime,LastTaskResult | ConvertTo-Json -Compress } else { '[]' }");
  const byName = {};
  for (const x of asArr(i)) byName[x.TaskName] = x;
  return list.map((x) => ({
    name: x.TaskName,
    state: String(x.State),
    next: parseDate(byName[x.TaskName] && byName[x.TaskName].NextRunTime),
  }));
}

async function report() {
  const out = [];
  const now = new Date(), today = dayKey(now);
  let cfg = {};
  try { cfg = accountsLib.readConfig(CFG); } catch (_) {}
  const list = accountsLib.resolveAccounts(cfg);
  const multi = list.length > 1;
  const { recs, fails, runs } = parseLog(list);
  const st = dailyState.loadState();

  out.push('');
  out.push('  Trae / WorkBuddy 自动签到 · 状态总览' + (multi ? '（' + list.length + ' 个账号）' : ''));
  out.push('  ' + now.toLocaleString('zh-CN', { hour12: false }));
  out.push('  ' + '='.repeat(W));

  out.push('  【今日签到】');
  const sides = ['trae', 'workbuddy'];
  const nameW = Math.min(24, Math.max(10, ...list.map((a) => dispWidth(a.name) + 1)));
  for (const acct of list) {
    const parts = [];
    for (const side of sides) {
      const label = side === 'trae' ? 'Trae' : 'WB';
      if (!accountsLib.sideEnabled(acct, side)) { parts.push(label + ' 未参与'); continue; }
      const slot = dailyState.accountSlot(st, acct.id);
      const done = dailyState.isDone(st, acct.id, side);
      parts.push(label + (done ? ' ✅ ' + (slot && slot[side] && slot[side].at ? hhmmss(new Date(slot[side].at)) : '') : ' ⏳ 未完成'));
    }
    const tag = acct.enabled === false ? '（已停用）' : '';
    out.push('   ' + cut(acct.name + tag, nameW).padEnd(nameW) + parts.join('   '));
  }
  if (list.length === 1 && !accountsLib.sideEnabled(list[0], 'workbuddy')) out.push(L('说明') + '该账号未开启 WorkBuddy 端');

  // ── 积分 ──
  const byDay = {};
  const byAccount = {};
  for (const r of recs) {
    if (!r.day || !r.credits) continue;
    const day = (byDay[r.day] = byDay[r.day] || { Trae: 0, WorkBuddy: 0 });
    day[r.platform] = Math.max(day[r.platform], r.credits);
    const acc = (byAccount[r.accountId] = byAccount[r.accountId] || { Trae: 0, WorkBuddy: 0 });
    acc[r.platform] += r.credits;
  }
  const days = Object.keys(byDay).sort();
  const totalOf = (d) => byDay[d].Trae + byDay[d].WorkBuddy;
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const last7 = sum(days.filter((d) => (now - new Date(d + 'T00:00:00')) / 86400000 < 7).map(totalOf));

  out.push('');
  out.push('  【积分 / 签到情况】');
  const lives = await Promise.all(list.map((a) => wbLive(accountsLib.effectiveWorkbuddy(cfg, a))));
  for (let i = 0; i < list.length; i += 1) {
    const acct = list[i], live = lives[i];
    if (!accountsLib.sideEnabled(acct, 'workbuddy')) continue;
    if (live) {
      const dc = live.daily_credit != null ? live.daily_credit : '—';
      const tc = live.today_credit != null ? live.today_credit : '—';
      out.push('   ' + cut(acct.name, nameW).padEnd(nameW)
        + (live.today_checked_in ? 'WB 已领 +' + tc : 'WB 未领') + '   日额度 ' + dc
        + '   连签 ' + (live.streak_days != null ? live.streak_days : '—') + ' 天');
    } else if (!accountsLib.effectiveWorkbuddy(cfg, acct).accessToken) {
      out.push('   ' + cut(acct.name, nameW).padEnd(nameW) + 'WB 未授权（尚未绑定 WorkBuddy 账号）');
    } else {
      out.push('   ' + cut(acct.name, nameW).padEnd(nameW) + 'WB 实时查询失败（离线数据见下方日志累计）');
    }
  }
  out.push(L('日志累计') + sum(days.map(totalOf)) + ' 积分（' + days.length + ' 天；近 7 天 ' + last7 + '）');
  if (multi) {
    for (const acct of list) {
      const c = byAccount[acct.id];
      if (!c) continue;
      out.push(L('  ' + cut(acct.name, 20), 24) + 'Trae +' + c.Trae + '  WB +' + c.WorkBuddy + '  合计 ' + (c.Trae + c.WorkBuddy));
    }
  }

  if (days.length) {
    out.push('');
    out.push('  【最近记录】');
    for (const d of days.slice(-6).reverse()) {
      const b = byDay[d], p = [];
      if (b.Trae) p.push('Trae +' + b.Trae);
      if (b.WorkBuddy) p.push('WorkBuddy +' + b.WorkBuddy);
      out.push(L(d, 14) + (p.join('  ') || '—') + '    合计 ' + totalOf(d));
    }
  }

  // ── 凭证 ──
  out.push('');
  out.push('  【登录凭证】');
  for (const acct of list) {
    out.push('   ' + cut(acct.name, nameW).padEnd(nameW) + (acct.enabled === false ? '（已停用）' : ''));
    if (accountsLib.sideEnabled(acct, 'trae')) {
      try {
        const ti = require('./lib/trae.js').resolveTokenInfo(accountsLib.effectiveTrae(cfg, acct));
        if (ti && ti.exp) {
          out.push('      ' + 'Trae      '.padEnd(12) + fmtExp(ti.exp) + '   [' + ti.source + ']');
          if (daysUntil(ti.exp) <= 3) out.push('      ' + ' '.repeat(12) + '⚠ 打开一次 Trae CN 客户端即可自动续期');
        } else {
          out.push('      ' + 'Trae      '.padEnd(12) + '未找到（请登录 Trae CN 客户端，或在该账号填写 token + 设备 ID）');
        }
      } catch (e) { out.push('      ' + 'Trae      '.padEnd(12) + '读取失败：' + e.message.slice(0, 40)); }
    } else {
      out.push('      ' + 'Trae      '.padEnd(12) + '未参与签到');
    }
    const wb = accountsLib.effectiveWorkbuddy(cfg, acct);
    if (!accountsLib.sideEnabled(acct, 'workbuddy')) {
      out.push('      ' + 'WorkBuddy '.padEnd(12) + '未参与签到');
    } else if (wb.accessToken) {
      const p = decodeJwt(wb.accessToken);
      out.push('      ' + 'WorkBuddy '.padEnd(12) + (p && p.exp ? fmtExp(p.exp) : '有效') + '   uid ' + (wb.uid || '未知'));
    } else {
      out.push('      ' + 'WorkBuddy '.padEnd(12) + '未授权 —— 面板「账号管理」里点授权，或 node wb-auth.js login --account ' + acct.id);
    }
  }

  out.push('');
  out.push('  【定时任务】');
  const tasks = taskInfo();
  if (tasks === null) out.push(L('状态') + '查询失败');
  else if (!tasks.length) out.push(L('状态') + '尚未注册 —— 运行 register-task.ps1');
  else for (const t of tasks) {
    out.push(L(t.name === 'DailyCheckin' ? '每日签到' : '联网补签') + '[' + t.state + ']  下次 ' +
      (t.next ? t.next.toLocaleString('zh-CN', { hour12: false }) : '—'));
  }

  out.push('');
  out.push('  【最近错误 / 告警】');
  if (!fails.length) out.push('   无');
  else {
    for (const f of fails.slice(-5)) out.push('   ' + f.ts + '  ' + f.text);
    if (fails.length > 5) out.push('   … 另有 ' + (fails.length - 5) + ' 条，详见 checkin.log');
  }

  out.push('');
  out.push('  【运行信息】');
  out.push(L('项目目录') + ROOT);
  out.push(L('账号数') + list.length + (multi ? '（面板「账号管理」可增删）' : '（旧版单账号配置，ID=' + list[0].id + '）'));
  out.push(L('累计执行轮次') + runs + ' 次');
  out.push(L('日志') + 'checkin.log（' + (readText(LOG).length / 1024).toFixed(1) + ' KB）');
  out.push('  ' + '='.repeat(W));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

function waitKey() {
  return new Promise((res) => {
    const s = process.stdin;
    s.setRawMode(true); s.resume(); s.setEncoding('utf8');
    const onData = (k) => { s.setRawMode(false); s.pause(); s.removeListener('data', onData); res(k); };
    s.on('data', onData);
  });
}

async function interactive() {
  for (;;) {
    process.stdout.write('   [R] 立即签到一次（全部启用账号）      [N] 退出   ');
    const k = (await waitKey()).toLowerCase();
    process.stdout.write('\n');
    if (k === '\u0003' || k === 'n' || k === 'q') break;
    if (k !== 'r') continue;
    console.log('\n   正在签到，请稍候（按账号顺序执行，最长约 20 分钟）...\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'checkin.js')], { stdio: 'inherit', cwd: ROOT });
    console.log('\n   本次执行结束（退出码 ' + r.status + '）。按任意键刷新状态...');
    await waitKey();
    console.log('\n'.repeat(2));
    await report();
  }
}

// CommonJS 里没有顶层 await，必须包一层 async IIFE
(async () => {
  await report();
  if (process.stdin.isTTY && !process.argv.includes('--once')) {
    try { await interactive(); } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 60)); // 让 stdout 落盘，避免退出时截断
  process.exit(0);
})();
