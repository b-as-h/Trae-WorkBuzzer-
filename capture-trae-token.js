'use strict';
/*
 * Trae Cloud-IDE-Token 自动抓取（一次性）
 * 用法：node capture-trae-token.js
 * 行为：打开浏览器 → 你在页面登录 Trae → 程序自动从 localStorage 提取 Cloud-IDE-Token → 写入 trae-token.json
 * 依赖：playwright（npm install playwright && npx playwright install chromium）
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const KEY = 'Cloud-IDE-Token';
const CANDIDATE_ORIGINS = ['https://www.trae.cn', 'https://trae.cn', 'https://api.trae.cn'];

async function main() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    console.error('未找到 playwright，请先执行：');
    console.error('  npm install playwright');
    console.error('  npx playwright install chromium');
    process.exit(2);
  }
  const { chromium } = playwright;

  console.log('即将打开浏览器，请在页面中登录你的 Trae 账号。');
  console.log('登录成功后程序会自动检测并保存 Cloud-IDE-Token（最多等待 5 分钟）。');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(CANDIDATE_ORIGINS[0], { waitUntil: 'domcontentloaded' }).catch(() => {});

  const tryRead = async (p) => {
    try { return await p.evaluate((k) => localStorage.getItem(k), KEY); } catch (_) { return null; }
  };
  const scanOpenPages = async () => {
    for (const p of context.pages()) {
      const v = await tryRead(p);
      if (v) return { v, url: p.url() };
    }
    return null;
  };

  let found = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    found = await scanOpenPages();
    if (found) break;
    for (const o of CANDIDATE_ORIGINS) {
      try {
        const tp = await context.newPage();
        await tp.goto(o, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        const v = await tryRead(tp);
        await tp.close();
        if (v) { found = { v, url: o }; break; }
      } catch (_) {}
    }
    if (found) break;
    await new Promise(r => setTimeout(r, 3000));
  }

  if (!found) {
    console.log('超时未检测到 Cloud-IDE-Token。请确认已成功登录，或改用 README「一」里的手动复制方式。');
    await browser.close();
    process.exit(1);
  }

  const tokenFile = path.join(__dirname, 'trae-token.json');
  fs.writeFileSync(tokenFile, JSON.stringify({ token: found.v }, null, 2));
  console.log('已保存 token 到：', tokenFile);
  console.log('来源页面：', found.url);
  console.log('接下来可运行  node checkin.js  测试，或执行  register-task.ps1  注册每日签到任务。');
  await browser.close();
}

main().catch(e => { console.error('抓取失败：', e.message); process.exit(1); });
