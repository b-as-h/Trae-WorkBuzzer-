# 架构说明

本文说明 `auto-checkin` 的运行链路、模块职责与关键设计取舍。README 里已有的安装步骤不再重复。

## 运行链路

```text
Windows 计划任务 DailyCheckin（每天 00:01 / 09:00 / 13:00 / 17:00 / 21:00）
Windows 计划任务 DailyCheckinOnNet（系统事件「网络已连接」→ 静默补签 --quiet-skip）
  └─ wscript.exe //B //Nologo run-hidden.vbs      ← GUI 子系统宿主：自身不创建控制台
       └─ node checkin.js                          ← WshShell.Run(cmd, 0, False)：隐藏窗口、不等待
            ├─ acquireLock()          state/run.lock.json      单实例互斥
            ├─ dailyState.loadState() state/daily-status.json  当日签到状态
            ├─ runWorkbuddy(cfg)      lib/workbuddy.js
            │    └─（token 缺失/将过期时）capture-workbuddy-token.js（无头 Playwright）
            ├─ runTrae(cfg)           lib/trae.js
            ├─ 断网时：lib/net.js 等待联网（默认 ≤10 分钟）→ 恢复后重试一轮
            └─ 收尾：写状态 + checkin.log（超过 1 MiB 自动轮转）+ 系统通知（lib/notify.js）
```

任务动作之所以不是直接 `node.exe`，是因为 node 是控制台程序，用 `InteractiveToken` 身份运行必然弹黑窗。`wscript.exe` 是 GUI 子系统宿主，自身不创建控制台，再由它用隐藏窗口拉起 node，屏幕全程无反应。

## 模块职责

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `checkin.js` | 主程序：单实例锁 → 读当日状态 → 逐端跳过/执行 → 写状态与日志 | 唯一入口 |
| `run-hidden.vbs` | 隐藏窗口启动器；启动前校验 `checkin.js` 与 node 是否存在，失败写 `[launcher]` 日志 | **必须保持纯 ASCII**，否则 VBS 按 ANSI 解析会出错；node 路径在运行时自动发现托管版本目录 |
| `lib/trae.js` | 读 Trae 客户端登录态 → 解密 token → 调 claim 接口；内置 `9074` 限流退避重试 | 需要 aha 设备 ID |
| `lib/workbuddy.js` | 多来源取 token → 调官方签到接口；按响应体 `code` 判幂等 | `10001` 被网关包成 HTTP 400 |
| `lib/token-sources.js` | 扫描本机日志采集最新 JWT，并挑出有效期最长的一个 | 不写明文 token |
| `lib/daily-state.js` | 当日签到状态的读写与判定（按本机本地日期，跨天自动重置） | 判定失败不落盘 |
| `lib/net.js` | 网络判定与等待：识别网络类错误、用 HTTP 探针判断是否在线、在预算内轮询等联网 | 探针不看 ping/DNS 缓存 |
| `lib/notify.js` | 通知决策与去重：成功汇总 / 失败与漏签告警 / 夜间静默档位 | 发送失败只写日志 |
| `notify-toast.ps1` | 真正发 Windows Toast（Windows PowerShell 5.1 + WinRT，零依赖） | 由 node 以 windowsHide 拉起，不闪黑框 |
| `capture-workbuddy-token.js` | Playwright 兜底抓取/刷新 WorkBuddy token | 默认无头；`--login` 才可见 |
| `capture-trae-token.js` | Playwright 抓取 Trae 网页会话 token（兜底） | 主力仍是客户端 `storage.json` |
| `register-task.ps1` | 注册/重建计划任务，把动作挂到 `run-hidden.vbs` | 必须保存为 **UTF-8 with BOM** |

## 关键设计决策

### 1. 隐藏运行：任务 → wscript → node

任务层用 `wscript.exe` 包装带来一个副作用：启动器瞬间返回，任务在 0.1 秒内就被标记为「已完成」。于是任务层的两个防护**双双失效**：

- `MultipleInstances=IgnoreNew` 不再阻止叠跑；
- `ExecutionTimeLimit=PT15M` 不再能砍掉卡死的运行。

因此这两件事改由脚本自己兜住：

| 原任务层能力 | 脚本层替代实现 |
| --- | --- |
| `IgnoreNew` | `state/run.lock.json` 单实例锁。持有者进程仍存活且年龄 < `CHECKIN_WATCHDOG_MS` → 本轮直接退出；持有者已死或锁过期 → 自动接管；只释放自己的锁 |
| `ExecutionTimeLimit` | 看门狗定时器：超过 `CHECKIN_WATCHDOG_MS`（默认 20 分钟）→ 写 `[看门狗]` 日志 → 释放锁 → `exit(2)` |

锁文件读取时会剥掉 UTF-8 BOM —— 若被记事本等工具改存带 BOM，`JSON.parse` 会失败、锁会被误判为「不存在」而静默失效。

另一个更隐蔽的窗口：`openSync(path, 'wx')` 与写入内容之间，锁文件已存在但内容为空，此时别的进程读锁会解析失败。若不处理就会被当成「损坏锁」删掉对方刚建的锁 → 两个进程同时跑。因此解析不出内容时会先同步等 150 ms 再重读一次，仍为空才判定为损坏锁并接管。

### 2. 当日幂等：签到成功即跳过后续时段

任务每天触发 5 次（外加联网补签事件），但签到只需要成功一次。`state/daily-status.json` 记录当天每一端的状态：

- 任一端成功（含「今日已签到（幂等）」「跳过领取」这类等价成功）→ 立即标记该端完成，**后续时段跳过该端**；
- 两端都完成 → 后续时段**整轮直接退出，零网络请求**，日志只多一行 `今日签到已完成（…），本轮跳过`；
- 只完成一端 → 下一时段**只补跑失败的那一端**；
- **失败不落盘** → 失败端在下一时段自动重试，不会漏签；
- 跨天自动重置（按本机本地日期比较）；
- 排障时需要强制重跑：`node checkin.js --force`。

### 3. token 来源优先级

WorkBuddy：

1. `config.json` 里的 `accessToken`（基线，约 55 天）；
2. 本机日志自动采集（主力，扫描到最新 JWT）；
3. `capture-workbuddy-token.js` 兜底刷新（无头浏览器）。

若剩余有效期不足 3 天，签到前会主动刷新一次（调用 `capture-workbuddy-token.js` 时**必须带 `--force`**：该脚本不带 `--force` 时只要"当前 token 还没过期"就直接退出说无需刷新，会让预刷新变成空转）；若签到失败且错误信息疑似 token 问题（`token` / `401` / `403` / `失效` / `过期`），会再刷新并重试一次。

Trae 的 token 选取同样按 **`exp` 最大者**（客户端 `Trae CN/User/globalStorage/storage.json` 中 `iCubeAuthInfo://icube.cloudide`，解密后约 14 天有效、客户端自动刷新）优先于 `config.trae.manualToken` 与 `trae-token.json` 缓存 —— 但只在 `exp` 相同时才有这个顺序；一般无需人工干预。

### 4. 失败语义

`ok: true` 才计入当日完成，包括以下等价成功：

- WorkBuddy：接口返回 `code: 10001`（今日已签到）；
- Trae：返回「跳过领取」（今日已签）。

其余一律视为失败：只记日志、不写状态，等下一个时段重试。

### 5. 断网兜底（三层）

任务层的 `RunOnlyIfNetworkAvailable` 只在**任务启动前**判定一次：Wi-Fi 连着但上游没网时任务照样启动，请求直接 `ENOTFOUND`，若就此收场就要等到下一个时段。为此加了三层：

1. **运行内等待**：请求异常经 `lib/net.js` 判定为网络类（`ENOTFOUND/EAI_AGAIN/ECONNRESET/ETIMEDOUT/…`，含 `err.cause.code`）→ 本轮不结束，按预算轮询等联网，恢复后重试未完成的一端。预算 = `min(networkRetry.waitMs, CHECKIN_WATCHDOG_MS − 已耗时 − 6 分钟预留)`，保证不撞看门狗。等待期间每满 60 秒记一行进度，其余静默。断网时跳过 WorkBuddy 的浏览器抓 token（否则白等最多 6 分钟）。
2. **联网事件补签**：任务 `DailyCheckinOnNet` 订阅 `Microsoft-Windows-NetworkProfile/Operational` 的 `10000`（网络已连接），`Delay=PT15S` 后以 `--quiet-skip` 启动。两端今日都完成 → 不写日志、不抢锁直接退出（网络一天可能重连很多次，不能刷屏）；有未完成端 → 正常走一遍流程。
3. **后续时段**：00:01 / 09:00 / 13:00 / 17:00 / 21:00 照常触发；关机/睡眠错过的由 `StartWhenAvailable` 在恢复后补跑。

判定在线用的是「对 `www.workbuddy.cn` / `api.trae.cn` 发 `HEAD` 能否拿到 HTTP 响应」（有响应即在线，4xx/5xx 也算），刻意不用 ping（常被防火墙挡）和纯 DNS（缓存会给出假阳性）。

### 6. 系统通知（不打扰式）

后台运行没有窗口，通知是唯一"主动告知"的渠道。规则（`lib/notify.js`）：

| 事件 | 档位 |
| --- | --- |
| 当日首次两端完成（白天） | `silent`：`<audio silent="true"/>`，无声音横幅，约 5 秒自动消失，不抢焦点 |
| 当日首次两端完成（`notify.nightStart`–`nightEnd`，默认 23:00–07:00） | `center`：`ToastNotification.SuppressPopup = true`，只进通知中心 |
| 失败 / 断网等待超时 / token 失效 | `alert`：横幅 + 默认提示音 |
| 漏签风险（`notify.lastSlotAfter` 之后仍未完成） | `alert`，且每轮都提醒（唯一不受"每天一次"去重限制的档） |

去重标记写进 `state/daily-status.json` 的 `notify` 字段（`successAt` / `failureKey`），跨天随状态一起重置。通知发送失败只写一行 `[通知] 发送失败：…`，绝不影响签到结果；发送成功也留一行 `[通知] 已发送（档位）…` 便于排查"为什么没收到"。

实现上由 `notify-toast.ps1` 走 Windows PowerShell 5.1 的 WinRT 接口（`Windows.UI.Notifications`），**不需要 npm 依赖、不需要 BurntToast**；node 以 `spawnSync + windowsHide` 调用，超时 15 秒。通知来源用注册脚本写入的 `HKCU\SOFTWARE\Classes\AppUserModelId\AutoCheckin.Daily`（显示为「自动签到（Trae / WorkBuddy）」），该键不存在时退回 PowerShell 自带的 AUMID。

## 运行时产物

以下文件由脚本运行时产生，均已加入 `.gitignore`，不参与版本控制：

| 路径 | 说明 |
| --- | --- |
| `state/daily-status.json` | 当日签到状态 |
| `state/run.lock.json` | 单实例锁（正常结束时自动删除） |
| `state/.notify.json` | 通知载荷临时文件（写完即发，发完即删；写入失败或进程被杀时可能残留，无副作用） |
| `checkin.log` | 运行日志（写控制台失败不影响落盘） |
| `checkin.log.N` | 轮转存档（超过 `CHECKIN_LOG_MAX_BYTES`，默认 1 MiB 时生成） |
| `config.json.tmp` | 抓取脚本原子写 config 的中间文件（写完即改名，正常不残留；**含明文 token**，已 gitignore） |
| `capture.log` | 兜底抓取脚本的日志 |
| `_wb_capture_state.json` | 抓取状态缓存 |
| `.wb-browser-profile/` | Playwright 持久化 profile（含登录态，**不要分享**） |
| `config.json` / `trae-token.json` | 含 token，**不要分享** |

## 可调环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `CHECKIN_WATCHDOG_MS` | `1200000`（20 分钟） | 单轮运行上限，超时强制退出 |
| `CHECKIN_LOG_MAX_BYTES` | `1048576`（1 MiB） | 日志轮转阈值 |
| `WB_ENDPOINT` | `https://www.workbuddy.cn` | WorkBuddy 签到端点覆盖（默认端点变更或需指向 `copilot.tencent.com` 时用） |
| `CHECKIN_NET_WAIT_MS` | `600000`（10 分钟） | 断网时等待联网的上限（覆盖 `networkRetry.waitMs`） |
| `CHECKIN_NET_PROBE_HOSTS` | `https://www.workbuddy.cn,https://api.trae.cn` | 网络探针主机（逗号分隔）；可指向不存在的域名模拟断网 |
| `CHECKIN_CROSS_DAY_GUARD_MINUTES` | `60` | 跨天保护窗口分钟数（`0` = 关闭） |
| `CHECKIN_LAST_SLOT_AFTER` | `21:00` | 漏签风险告警的起点（`00:00` = 强制触发，测试用） |

## 自查判据

无人值守场景下，判断「任务是否真的跑过」不能只看任务结果码 —— `wscript.exe` 的退出码**恒为 0**，脚本没起来时任务照样显示成功。可靠判据是：

> `LastTaskResult = 0` **并且** `checkin.log` 出现了新行，才算真跑过。

若日志停留在 `===== 自动签到开始 =====` 而没有结束行，说明该次进程被外部终止（例如注销/关机），任务结果码会是 `3221225786`（`0xC000013A`）。这种情况不会污染当日状态，下一时段会自动补跑。

## 已知限制

- 计划任务使用「仅在用户登录时运行」，因此电脑关机或注销期间不会触发；休眠也不会自动唤醒（未开启 `WakeToRun`）。错过的时间点由 `StartWhenAvailable` 在恢复后补跑。
- 通知会被系统策略压制：开启「专注助手 / 勿扰」或全屏运行时，横幅自动退到通知中心（这是刻意的"不打扰"，但也可能当下看不到）。
- 0 点刚过时，服务端可能还没翻篇：此时返回的「今日已签到」不记为当日完成（跨天保护，默认 60 分钟窗口），留待下一个时段复核——代价是多查一次接口，换来"不会整整漏签一天"。
- 签到接口为客户端私有接口，若官方调整字段或校验，需要同步修改 `lib/trae.js` / `lib/workbuddy.js`。
- `run-hidden.vbs` 按「托管 Node 版本目录（名字最大者）→ `C:\Program Files\node` → PATH」顺序解析 node，托管 runtime 升级后无需改脚本。
- `checkin.log` 采用简单的大小轮转（保留全部历史档案），没有按时间清理策略；按每天 1~3 行的实际量级，无需更复杂的方案。
- `capture.log`（抓取脚本日志）不做轮转：只有在 token 需要刷新时才会写，量级可忽略。
