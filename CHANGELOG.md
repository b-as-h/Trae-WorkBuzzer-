# 变更日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-10-02

00:01 签到 + 断网补签 + 不打扰式系统通知。

### 新增

- **00:01 每日触发**：`$TriggerTimes` 变为 `00:01 / 09:00 / 13:00 / 17:00 / 21:00` 共 5 档；不设 `WakeToRun`，睡眠/关机期间不唤醒，醒来或联网后由 `StartWhenAvailable` 与联网补签任务补跑。
- **断网兜底（三层）**：① `lib/net.js` 识别网络类错误，在预算内（默认 ≤10 分钟，受看门狗与 6 分钟预留限制）等联网后重试一轮；② 新增计划任务 `DailyCheckinOnNet`，订阅 `Microsoft-Windows-NetworkProfile/Operational` 事件 `10000`（网络已连接），延迟 15 秒以 `--quiet-skip` 补签；③ 原有 5 个时段照常兜底。
- **系统通知（零依赖）**：新增 `notify-toast.ps1`（Windows PowerShell 5.1 + WinRT）与 `lib/notify.js`。成功每天一条汇总（白天静默横幅、夜间只进通知中心）；失败/断网超时/漏签风险用横幅+提示音；通知失败只写日志，不影响签到。新增 `--no-notify` 开关。
- **跨天保护**：0 点刚过时接口返回的「今日已签到」不记为当日完成（默认 60 分钟窗口），避免服务端跨天晚于本地 0 点时整整漏签一天；真实领取成功不受影响。
- **`--quiet-skip`**：两端今日都完成时静默退出（不写日志、不抢锁），供联网补签任务使用。
- 新配置块 `networkRetry` / `crossDayGuard` / `notify`（缺键按默认，旧 config.json 直接可用）；新环境变量 `CHECKIN_NET_WAIT_MS` / `CHECKIN_NET_PROBE_HOSTS` / `CHECKIN_CROSS_DAY_GUARD_MINUTES` / `CHECKIN_LAST_SLOT_AFTER`。

### 修复

- **Node 24 上「fetch 后立刻 process.exit()」崩溃**：Windows 上会稳定触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 `0xC0000409`）。收尾改为先交还事件循环自然排空、再用 unref 定时器（3 秒）兜底强杀；托管 Node 22 与系统 Node 24 均已实测退出码 0。
- **`lib/trae.js` 断网时空转**：请求异常若属网络类，立即返回 `networkError`，不再消耗 9074 的退避重试与 8 分钟总时限。
- **`lib/workbuddy.js`**：两处请求异常补 `networkError` 标记；`code=10001` 补 `alreadyCheckedIn`；成功返回补 `credits` / `streakDays`（供通知文案使用）。

### 文档

- README：徽章 1.2.0；触发方式表格 / 使用教程 / 流程图 / 排障表 / 目录结构 / 数据流同步；新增「断网也不漏签」「系统通知」两节；AI 部署提示词改为 5 档 + 双任务。
- `docs/architecture.md`：模块表新增 `lib/net.js`、`lib/notify.js`、`notify-toast.ps1`；新增「断网兜底（三层）」「系统通知（不打扰式）」两节；运行时产物表补 `state/.notify.json`；已知限制补专注助手与跨天保护说明。
- `CONTRIBUTING.md`：验证清单补断网 / 通知 / 跨天保护三类用例与 Node 24 退出码检查。

### 实测（本机 Windows 11 22631）

- 单元测试 16 项（错误分类 / 时间窗口 / 通知决策与去重）全部通过；全部 js 文件 `node --check` 通过。
- 断网 → 等待 → 恢复 → 自动补签 端到端通过（本地假端点模拟，含 60 秒进度行与恢复后重试成功）。
- 失败告警、同因去重、最后时段重复提醒、`--no-notify`、`--quiet-skip`（已完成=静默 / 未完成=照常跑）均按预期。
- 跨天保护：`CHECKIN_CROSS_DAY_GUARD_MINUTES=1440` 时不落状态、不发误报告警；改回 0 恢复正常。
- 三种通知档位（silent / center / alert）均实测可发送，来源显示「自动签到（Trae / WorkBuddy）」。

## [1.1.2] - 2026-09-29

第四轮审查（逐行复核 + 与远端仓库/文档三方比对）的修复。

### 修复

- **单实例锁仍有一个极短竞态窗口**：`fs.openSync(LOCK_PATH, 'wx')` 与随后写入内容之间，文件已存在但内容为空；此时若另一进程读锁，`JSON.parse` 失败会被当成"锁文件损坏"而**删掉对方刚创建的锁**，结果两个进程同时跑。现在解析不出内容时先同步等待 150 ms 再重读一次，跨过这个窗口（`Atomics.wait`，不需要异步改造）。
- **Trae 的积分字段漏了单数形式**：`lib/trae.js` 取积分时只看 `data.credits / reward / amount`，而 2026-09-29 实测 WorkBuddy 侧返回的是单数 `data.credit`。现把 `credit` 一并纳入候选，否则日志里只会显示「Trae 签到成功」而看不到积分。
- **死代码**：`lib/trae.js` 的 `findJwt` 与 `resolveToken`、`lib/workbuddy.js` 的 `maskToken` 全项目零调用（仅被导出），已删除；`lib/trae.js` 导出名 `__mask` 改为正常的 `maskToken`（同样零外部引用，只是命名不一致）。

### 文档

- **README 的版本徽章停留在 `1.0.0`**（实际已 1.1.1）→ 已同步为 `1.1.2`。
- **README 顶部的 `docs/before-after.gif` 是死链**：本地与远端仓库都没有这个文件（远端仓库连 `docs/` 目录都还没有），会显示成破图。已移除该行 —— 紧随其后的「改造前 / 改造后」对照表已覆盖同样信息。
- **README 写错了要改的变量名**：说「编辑 `register-task.ps1` 里的 `$triggers` 数组」，而真正的触发时间数组是 `$TriggerTimes`（`$triggers` 只是循环里临时拼的 `New-ScheduledTaskTrigger` 集合）。照原文改是**改不动时间**的，已修正。
- README 手动指定托管 Node 时硬编码了 `22.22.2-3`，与本轮「运行时自动发现版本目录」的改动矛盾，已改为 `<版本>` 占位。
- `CONTRIBUTING.md` 把 Node 18+ 的原因写成「需要 `fs.rmSync`」——该 API 全项目零使用；实际原因是内置 `fetch` 与 `AbortController`，已更正。
- **补上 Playwright 的 Node 版本要求**：`package-lock.json` 里 `playwright@1.63.0` 的 `engines` 是 **Node ≥ 20**，而 README / CONTRIBUTING 只写了 ≥ 18 —— Node 18 环境执行 `npm install` 会报 `EBADENGINE`。已注明「签到逻辑 ≥ 18；Playwright 兜底抓 token 需 ≥ 20」。

### 实测

- 跨天重置路径（此前唯一未验证的路径）：把 `state/daily-status.json` 的 `date` 改回昨天 → 本轮走真实签到流程（两端幂等返回成功）→ 状态文件被重写为当天。✅
- 锁的其余路径复测：损坏锁接管 / 存活持有者拦截 / 持有者已死接管 / 看门狗强杀，全部通过。
- 7 个 js 文件 `node --check` 通过；`package.json` / `package-lock.json` 版本一致。

## [1.1.1] - 2026-09-29

第三轮逐行审查（模块间配合 + 文档精度 + 代码卫生）的修复。

### 修复

- **「3 天预刷新」空转**：`checkin.js` 判断 WorkBuddy token 剩余不足 3 天（或签到报 401）时会调用 `capture-workbuddy-token.js` 刷新，但**没有带 `--force`**；而该脚本不带 `--force` 时只要「当前 token 还没过期」就直接 `exit 0` 说无需刷新。于是预刷新从未真正发生，只有在 token 彻底过期后才刷新。现改为两处调用都带 `--force`。
- **单实例锁的竞态与"半截文件"失效**：`acquireLock` 原为「读 → 判断 → 写入」三步，两个进程同时启动时可能都拿到锁；且直接 `writeFileSync`，写一半崩溃会留下解析不了的 JSON，被当成"没有锁"而静默失效。现改为 `fs.openSync(LOCK_PATH, 'wx')` 原子抢占（已存在即失败），持有者已死/锁过期/锁文件损坏时清理后重试一次；锁目录不可写时降级放行并写 `[警告]` 日志，不再阻塞签到。
- **`.gitignore` 漏掉 `config.json.tmp`**：抓取脚本原子写 config 的中间文件含明文 token，写入中途崩溃会残留，而 `config.json` 是精确名匹配、盖不住它。已补 `config.json.tmp` 与 `*.json.tmp`。
- **`run-hidden.vbs` / `register-task.ps1` 硬编码托管 Node 版本目录**（`22.22.2-3`）：托管 runtime 升级后启动器会静默落到另一个 node。现改为运行时发现 `%USERPROFILE%\.workbuddy\binaries\node\versions` 下名字最大的版本目录，再依次回退到 `C:\Program Files\node\node.exe` 与 PATH。
- **README 的 token 优先级描述与代码不符**：原文写成固定顺序（`客户端登录态 > manualToken > trae-token.json`），实际三来源是**按 `exp` 取最大者**，同分才按来源优先级决胜。README 与 `docs/architecture.md` 已按实际行为改写。
- **死代码 / 误导字段清理**：`lib/token-sources.js` 移除未使用的 `decodeCache` 与无效语句 `if (found) continue;`；`lib/trae.js` 的 claim 成功返回值去掉恒为 `false` 的 `alreadyCheckedIn`（能走到该分支说明此刻尚未签到）。

### 文档

- README 与 `docs/architecture.md` 的环境变量表补 `WB_ENDPOINT`（`lib/workbuddy.js` 一直支持，只是没记录）。
- `docs/architecture.md`：运行时产物表补 `config.json.tmp`；说明 `capture.log` 不轮转的原因；已知限制补 node 自动发现。
- `CONTRIBUTING.md`：验证清单新增「改过 `run-hidden.vbs` 必须先做 VBS 语法自检（`cscript //B //Nologo run-hidden.vbs` 退出码须为 0）」；目录约定补 VBScript 保留字陷阱。

### 备注

- 本轮修复过程中曾引入一次回归：启动器里用 `sub` 当循环变量名（VBScript 保留字）导致整个脚本解析失败，现象为**任务结果码 `1`、日志一行不写**。已修正并复测（`LastTaskResult=0` + 日志新增行）。该陷阱已写入 `CONTRIBUTING.md`。

## [1.1.0] - 2026-09-29

「无感运行 + 当日幂等」改造，以及随后一轮安全审查的连带修复。

### 新增

- **隐藏窗口后台运行**：新增 `run-hidden.vbs` 启动器，计划任务动作由 `node.exe` 改为 `wscript.exe //B //Nologo run-hidden.vbs`，由它以 `WshShell.Run(cmd, 0, False)` 隐藏且不等待地拉起 node。原先用 `InteractiveToken` 直接跑 node（控制台程序）必然弹黑窗的问题消除。
- **当日幂等跳过**：新增 `lib/daily-state.js` 与 `state/daily-status.json`（按本机本地日期，跨天自动重置）。任一端成功后，后续时段跳过该端；两端都完成则整轮直接退出、不发任何请求。
- **单实例锁**：`state/run.lock.json`。因为启动器瞬间返回会让任务层的 `MultipleInstances=IgnoreNew` 失效，互斥改由脚本自兜。
- **看门狗**：`CHECKIN_WATCHDOG_MS`（默认 20 分钟）超时强制退出并留痕，替代同样失效的任务层 `ExecutionTimeLimit=PT15M`。
- **启动器失败留痕**：启动前校验 `checkin.js` 与 node 路径，失败写 `[launcher] FAILED to start node`。`wscript.exe` 退出码恒为 0，没有这行日志时「任务显示成功但什么都没跑」将无法察觉。
- **日志轮转**：`CHECKIN_LOG_MAX_BYTES`（默认 1 MiB）触发，当前日志存档为 `checkin.log.N`（取第一个未占用序号，不覆盖、不删除既有文件）。
- `node checkin.js --force`：排障时忽略当日已完成标记，强制完整重跑。
- 文档：新增 `docs/architecture.md`、`CONTRIBUTING.md`、本变更日志与 Issue 模板。

### 变更

- `register-task.ps1`：动作改挂隐藏启动器，任务加 `-Hidden`；说明「必须保存为 UTF-8 with BOM」。
- README 重写运行链路图、排障条目与目录结构；修正一处错误描述（改造后任务层 `IgnoreNew` 不再防叠跑）。
- `package.json`：新增 `checkin` / `checkin:force` 脚本。

### 修复

- **配置文件读取未剥 UTF-8 BOM**：用记事本编辑保存过 `config.json` / `state/daily-status.json` 后 `JSON.parse` 会失败 —— 表现为「手动填了 token 反而跑不起来」，或当日状态被判为空导致**已签到的时段重复执行**。三处读取点（`checkin.js`、`capture-workbuddy-token.js`、`lib/daily-state.js`）已统一剥离 BOM；此前只有 `checkin.js` 的读锁逻辑做了该防护。
- **`config.example.json` 把字段说明写成了字段值**（`accessToken` 等是一整段中文），照抄即用会塞入非法值 → 全部改为合法空值，说明文字统一保留在 README 配置表。
- **`package-lock.json` 版本号未随 `package.json` 同步**（`1.0.0` vs `1.1.0`）→ 已同步为 `1.1.0`。
- **移除配置中的死字段 `logFile`**：代码零引用。日志路径固定为项目目录下的 `checkin.log`（启动器的失败留痕也要写同一文件，做成可配置会导致两处不一致），README 中对应条目已删除并注明原因。
- **文档补齐**：README 环境变量表补 `CHECKIN_LOG_MAX_BYTES`、配置表补 `trae.region`；日志与状态文件的查看命令补 `-Encoding UTF8`（PowerShell 5.1 的 `Get-Content` 默认按 ANSI 读，中文会显示成乱码，容易被误判为程序故障）。
- 锁文件读取剥除 UTF-8 BOM —— 若被记事本等工具改存带 BOM，`JSON.parse` 会失败导致锁静默失效。
- `readLock` / `releaseLock` 只释放自己持有的锁，避免误删后来者的锁。
- 移除 `dependencies` 中未被任何代码引用的 `asar`（逆向抓 `app.asar` 时期的遗留，已被 `capture-*.js` 取代）。

### 备注

- `wscript.exe` 退出码恒为 0，因此**任务结果码 0 且日志有新行**才算真的跑过，这是唯一的可靠判据。
- 日志停留在 `===== 自动签到开始 =====` 而无结束行，表示该次进程被外部终止（任务结果码 `3221225786` / `0xC000013A`）。失败不写当日状态，下一时段会自动补跑。

## [1.0.0] - 2026-09-28

首个可用版本。

### 新增

- WorkBuddy 与 Trae 双平台自动签到（`lib/workbuddy.js`、`lib/trae.js`），两端独立容错。
- token 多来源采集（`lib/token-sources.js`）：`config.json` 基线 + 本机日志自动采集，必要时用 Playwright 无头兜底刷新（`capture-workbuddy-token.js`、`capture-trae-token.js`）。
- Trae `9074` 限流退避重试（最多 10 次 / 8 分钟）。
- Windows 计划任务 `DailyCheckin`，每天 09:00 / 13:00 / 17:00 / 21:00 四个触发点，注册脚本 `register-task.ps1`。
- 运行日志 `checkin.log`（只记脱敏片段与结果，不写明文 token）。
