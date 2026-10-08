# 贡献指南

本项目是一个自用的小工具：每天定时把 Trae 与 WorkBuddy 的签到跑掉，并且要求全程无感、不重复签。改动请以「无人值守场景下不出错」为第一优先级。

## 环境要求

| 依赖 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 18+（签到）/ 20+（Playwright 兜底） | 签到逻辑需要内置 `fetch` 与全局 `AbortController`（用于请求超时中断）；`playwright@1.63` 要求 Node ≥ 20，装了它才能跑 `capture-*.js` |
| PowerShell | 5.1+ | 注册计划任务用 `Register-ScheduledTask`，**不要**用 `schtasks.exe`（部分机器被策略禁用） |
| Windows | 10/11 | 依赖计划任务与 `wscript.exe` |

依赖安装：

```bash
npm install --ignore-scripts
npm run install-browser   # 仅在需要 Playwright 兜底抓 token 时
```

## 目录约定

- `checkin.js` —— 唯一入口，只做「编排 + 状态 + 日志」，不塞具体接口细节；
- `lib/*.js` —— 每个平台一个模块，导出单一的 `xxxCheckin(cfg)`，返回 `{ ok, message, ... }`，**不抛异常当控制流**；
- `run-hidden.vbs` —— **必须保持纯 ASCII**。VBS 被按 ANSI 解析，写入中文会变成乱码甚至语法错误。失败提示也必须用英文（`[launcher] FAILED to start node`）。**另注意变量名不能用 VBScript 保留字**（`sub` / `function` / `next` / `set` 等）：`Dim sub` 这种写法会让整个脚本解析失败，表现为任务结果码变成 `1`、日志一行都不写 —— 是最难察觉的静默故障；
- `register-task.ps1` —— **必须保存为 UTF-8 with BOM**。PowerShell 5.1 读取无 BOM 的 UTF-8 脚本时中文会变乱码并报语法错误。多数编辑器会在保存时丢 BOM，改完请复核头三字节是否为 `ef bb bf`。
- `notify-toast.ps1` —— 与 `register-task.ps1` 同样**必须保存为 UTF-8 with BOM**（含中文文案，PS 5.1 按 ANSI 解析会乱码）。它由 node 以 `windowsHide` 拉起，**绝不能**改成 `MsgBox` / `msg.exe` 这类会抢焦点的弹窗。

## 改签到接口前必读

动 `lib/trae.js`、`lib/workbuddy.js`、`lib/token-sources.js` 之前，先看这三个文件里的注释 —— 它们记录了对接官方实现时实测出来的结论，包含两个最容易踩的坑：

1. **Trae 的 `x-device-id` 必须用 aha 设备 ID**（`storage.json` 里 `iCubeAuthInfo://icube-dc:<数字ID>` 的键名），**不是** `telemetry.devDeviceId`。用错会表现为 `9074`「当前参与用户太多」，极易误判成高峰限流。
2. **WorkBuddy 的 `10001` 被网关包成了 HTTP 400**，所以判定「今日已签到」必须读响应体里的 `code`，不能只看 HTTP 状态码。

另外：Trae 的 claim 请求体必须是 `{"req_source":1}`，不能发空 body，并且需要带 `X-User-Region`、`x-app-version` 等请求头。

## 改动的验证清单

任何改动（尤其是主流程和启动链路）都请至少在本地跑通下面几条路径，并附上真实输出：

| 场景 | 期望 |
| --- | --- |
| `node checkin.js` | 当天已完成 → 只输出一行跳过；未完成 → 正常签到并落状态 |
| `node checkin.js --force` | 忽略当日标记，完整重跑两端 |
| 有活动锁时再跑一次 | 输出 `[跳过] 已有另一个签到进程在运行`，且**不误删别人的锁** |
| `CHECKIN_WATCHDOG_MS=300 node checkin.js --force` | 中途被看门狗强杀，`exit=2`，日志有 `[看门狗]` 行，锁已释放 |
| `Start-ScheduledTask -TaskName DailyCheckin` | `LastTaskResult=0` **且** `checkin.log` 有新行（两者缺一都不算通过） |
| 改过 `run-hidden.vbs` 时 | 先做语法自检：`cscript //B //Nologo run-hidden.vbs` 退出码必须为 **0**（VBS 语法错时为 `1`，且不会启动 node）；再走上面的 `Start-ScheduledTask` 复测 |
| 语法自检 | `node --check checkin.js`、`node --check lib/*.js` 通过 |
| 注册脚本 | PowerShell AST 解析无错，头三字节为 `ef bb bf` |
| 断网等待 | `CHECKIN_NET_WAIT_MS=20000 CHECKIN_NET_PROBE_HOSTS=offline.invalid WB_ENDPOINT=https://offline.invalid node checkin.js --force` → 日志出现 `[网络] 检测到断网…` 与 `[网络] 等待联网超时…`，exit 0，且当天状态不被本轮失败写成"已完成" |
| 联网恢复 | 让探针先不可达再恢复（或断网→恢复）→ 日志出现 `[网络] 网络已恢复，重试未完成的一端` 并完成签到 |
| 通知档位 | 依次调用 `notify-toast.ps1`（silent / center / alert 三种 payload）→ exit 0；`checkin.log` 出现 `[通知] 已发送（档位）…` |
| 通知去重 | 同一失败原因重复跑第二次 → 不再出现新的 `[通知] 已发送` 行；`CHECKIN_LAST_SLOT_AFTER=00:00` 时"漏签风险"档会再次提醒 |
| 跨天保护 | `CHECKIN_CROSS_DAY_GUARD_MINUTES=1440 node checkin.js --force` → 出现 `[跨天保护]` 行，state 的 `at` 不被刷新，且不发通知；改回 0 恢复正常 |
| 静默跳过 | 两端今日已完成时 `node checkin.js --quiet-skip` → `checkin.log` 行数不变、exit 0、无通知；未完成时应照常跑完整流程 |
| 退出码（Node 24） | Windows + Node 24 下任意路径退出码必须为 0；若出现 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，说明收尾又被改成立刻 `process.exit()` |

注意：`wscript.exe` 的退出码恒为 0，所以**只看任务结果码无法证明脚本真的跑起来了** —— 必须同时确认日志有新行。

## 提交规范

- 一个提交只做一件事，提交信息用「模块: 动作」的形式，例如 `checkin: 修正看门狗超时文案`；
- 不要提交 `config.json`、`trae-token.json`、`state/`、`*.log`、`.wb-browser-profile/` —— `.gitignore` 已覆盖，请勿用 `-f` 强行加入；
- 新增运行时产物时，记得同步更新 `.gitignore` 与 `docs/architecture.md` 的「运行时产物」表；
- 涉及行为变更的，同步更新 `CHANGELOG.md` 与 `README.md`。

## 报告问题

请使用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md)，其中最重要的三项是：

1. `checkin.log` 的相关片段（**先脱敏**，日志本身不含明文 token，但请勿附加 config）；
2. `Get-ScheduledTaskInfo -TaskName DailyCheckin` 的输出（`LastRunTime` / `LastTaskResult`）；
3. 复现步骤，以及是否伴随手动结束进程、关机、注销等外部中断。
