'use strict';
/*
 * WorkBuddy token 多来源采集器
 *
 * 背景：WorkBuddy/CodeBuddy 桌面端在运行过程中，会把当前有效的 accessToken(JWT)
 * 写入若干本地日志文件。客户端自身会续期 token，续期后新的 token 也会落到日志里。
 * 因此我们可以在每次签到前扫描这些日志，取"有效期最长"的那个 JWT 使用，
 * 从而实现接近无人值守的自动续期（无需手动重抓）。
 *
 * 采集来源（按优先级即"取 exp 最大者"，与来源无关）：
 *   1) %USERPROFILE%\.workbuddy\logs            （WorkBuddy 客户端日志，iss=www.workbuddy.cn）
 *   2) %LOCALAPPDATA%\CodeBuddyExtension\Logs   （CodeBuddy IDE 日志，iss=www.codebuddy.cn，同一账号可用）
 *   3) %APPDATA%\CodeBuddyExtension\Logs        （同上，备选位置）
 *
 * 安全：只读本地日志文件，不修改、不上传。
 */
const fs = require('fs');
const path = require('path');

// 宽松匹配 JWT（三段 base64url），前缀固定为 JOSE 头 eyJhbGciOi...
const JWT_RE = /eyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function b64urlDecode(s) {
  s += '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodePayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    return null;
  }
}

function candidateRoots() {
  const roots = [];
  const up = process.env.USERPROFILE || process.env.HOME || '';
  if (up) roots.push(path.join(up, '.workbuddy', 'logs'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Logs'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'CodeBuddyExtension', 'Logs'));
  return roots.filter((r) => { try { return fs.existsSync(r) && fs.statSync(r).isDirectory(); } catch (_) { return false; } });
}

function walkFiles(root, maxFiles, maxAgeMs) {
  const out = [];
  const now = Date.now();
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 跳过明显无关的大目录
        if (/node_modules|Cache|GPUCache|Crashpad/i.test(e.name)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (!/\.(log|txt|json|jsonl)$/i.test(e.name)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size === 0 || st.size > 25 * 1024 * 1024) continue;
          if (maxAgeMs && (now - st.mtimeMs) > maxAgeMs) continue;
          out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size });
        } catch (_) {}
      }
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

/**
 * 采集本机日志中的 JWT，返回按 exp 倒序的候选列表。
 * @param {object} opts { maxFiles, maxAgeDays }
 * @returns {Array<{token, exp, iat, iss, sub, source, file, mtimeMs}>}
 */
function harvestTokens(opts = {}) {
  const maxFiles = opts.maxFiles || 600;
  const maxAgeMs = (opts.maxAgeDays || 45) * 86400 * 1000;
  const seen = new Map(); // token -> record
  for (const root of candidateRoots()) {
    const files = walkFiles(root, maxFiles, maxAgeMs);
    for (const f of files) {
      let buf;
      try { buf = fs.readFileSync(f.file); } catch (_) { continue; }
      let m;
      JWT_RE.lastIndex = 0;
      while ((m = JWT_RE.exec(buf.toString('latin1'))) !== null) {
        const token = m[0];
        if (seen.has(token)) continue;
        const p = decodePayload(token);
        if (!p || !p.exp) continue;
        seen.set(token, {
          token,
          exp: p.exp,
          iat: p.iat || 0,
          iss: p.iss || '',
          sub: p.sub || '',
          source: 'log',
          file: f.file,
          mtimeMs: f.mtimeMs,
        });
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => b.exp - a.exp);
}

/**
 * 汇总所有来源，返回"当前最佳"token。
 * @param {string} configToken config.workbuddy.accessToken（可能为空）
 * @returns {{token, exp, iat, iss, sub, source, file?, mtimeMs?}|null}
 */
function pickBestToken(configToken) {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [];
  if (configToken && typeof configToken === 'string') {
    const p = decodePayload(configToken.trim());
    if (p && p.exp) {
      candidates.push({ token: configToken.trim(), exp: p.exp, iat: p.iat || 0, iss: p.iss || '', sub: p.sub || '', source: 'config' });
    }
  }
  try {
    for (const h of harvestTokens()) candidates.push(h);
  } catch (_) {}
  // 只保留未过期（留 60 秒余量）的，取 exp 最大者
  const valid = candidates.filter((c) => c.exp * 1000 > Date.now() + 60 * 1000);
  const pool = valid.length ? valid : candidates;
  pool.sort((a, b) => b.exp - a.exp);
  return pool[0] || null;
}

module.exports = { harvestTokens, pickBestToken, decodePayload };
