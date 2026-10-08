# 架构说明

本文说明本项目的运行链路、模块职责与关键设计取舍。README 里已有的安装步骤不再重复。

## 运行链路

```text
Windows 计划任务，共 4 个，全部挂到同一个入口：
  DailyCheckin        每天 N 个时段（面板可改，默认 00:01 / 09:00 / 13:00 / 17:00 / 21:00）
  DailyCheckinOnNet   系统事件「网络已连接」(10000) → --quiet-skip 静默补签
  DailyCheckinOnLogon 用户登录后 30 秒 → --quiet-skip 静默补签（面板可开关）
  DailyCheckinHourly  每 N 小时（默认 1）→ --quiet-skip 静默重试（面板可开关）
    └─ wscript.exe //B //Nologo run-hidden.vbs   ← GUI 子系统宿主：自身不创建控制台
         └─ node checkin.js                       ← WshShell.Run(cmd, 0, False)：隐藏窗口、不等待
              ├─ lib/accounts.js       解析 config.accounts（无 accounts → 合成 ID=default 的单账号）
              ├─ buildTasks()          任务 = 启用账号 × 参与端；--accounts/--account 可只跑一部分
              ├─ --quiet-skip 且目标「账号 × 端」全完成 → 立刻 return（不抢锁、不写日志、不发请求）
              ├─ acquireLock()          state/run.lock.json      单实例互斥
              ├─ dailyState.loadState() state/daily-status.json  当日签到状态（按账号分槽）
              ├─ 逐任务执行（任务之间按 batch.intervalMs 间隔，默认 1500 ms）：
              │    ├─ WorkBuddy             lib/workbuddy.js
              │    │    └─（凭证缺失/临期/401）node wb-auth.js ensure --account <id>（纯 HTTP，无浏览器）
              │    └─ Trae                  lib/trae.js
              │         └─ 多账号解析到同一登录态 → 跳过并写明原因（不重复刷接口）
              ├─ 断网时：lib/net.js 等待联网（默认 ≤10 分钟）→ 恢复后重试未完成的项
              └─ 收尾：写状态 + checkin.log（超过 1 MiB 自动轮转）+ 系统通知（lib/notify.js）

面板侧（与签到链路解耦，不参与签到）：
  ui.cmd → probe.ps1（就绪探测）→ run-panel.vbs → node server.js → ui/index.html
  server.js 只监听 127.0.0.1:8795；通过 PowerShell 读写计划任务，通过 wb-auth.js 发起授权
  账号管理走 POST /api/accounts；批量签到以 POST /api/checkin { accounts:[…] } 同步调 checkin.js
```

任务动作之所以不是直接 `node.exe`，是因为 node 是控制台程序，用 `InteractiveToken` 身份运行必然弹黑窗。`wscript.exe` 是 GUI 子系统宿主，自身不创建控制台，再由它用隐藏窗口拉起 node，屏幕全程无反应。

## 模块职责

| 文件 | 职责 | 备注 |
| --- | --- | --- |
| `checkin.js` | 主程序：单实例锁 → 读当日状态 → 按「启用账号 × 参与端」生成任务 → 逐项跳过/执行 → 写状态与日志 | 唯一入口；账号之间按 `batch.intervalMs` 节流 |
| `lib/accounts.js` | 账号模型与旧配置迁移：`accounts` 归一化、合成 `default`、任务键、凭证读写 | **零依赖、不发网络请求**；写回原子替换 |
| `run-hidden.vbs` | 隐藏窗口启动器；启动前校验 `checkin.js` 与 node 是否存在，失败写 `[launcher]` 日志 | **必须保持纯 ASCII**，否则 VBS 按 ANSI 解析会出错；node 路径在运行时自动发现托管版本目录 |
| `lib/trae.js` | 解析 Trae token（本机客户端 / 账号级 `manualToken`）→ 调 claim 接口；内置 `9074` 退避重试 | `deviceId` 必须是该 token 绑定的 aha 设备 ID |
| `lib/workbuddy.js` | 多来源取 token → 调官方签到接口；按响应体 `code` 判幂等 | `10001` 被网关包成 HTTP 400 |
| `lib/daily-state.js` | 当日签到状态的读写与判定：`accounts[账号ID][端]`，按本机本地日期跨天重置 | 只有 `ok === true` 算完成；旧扁平结构读取时映射到 `default` |
| `lib/net.js` | 网络判定与等待：识别网络类错误、用 HTTP 探针判断是否在线、在预算内轮询等联网 | 探针不看 ping/DNS 缓存 |
| `lib/notify.js` | 通知决策与去重：成功汇总 / 失败与漏签告警 / 夜间静默档位 | 发送失败只写日志 |
| `notify-toast.ps1` | 真正发 Windows Toast（Windows PowerShell 5.1 + WinRT，零依赖） | 由 node 以 windowsHide 拉起，不闪黑框 |
| `wb-auth.js` | WorkBuddy 官方插件 OAuth 授权流：`login` / `refresh` / `ensure` / `status`，全部支持 `--account <账号ID｜名称>` | **零依赖**，只用内置 `fetch`；授权按账号进行；`ensure` 不带 `--account` 时刷新所有启用 WorkBuddy 的账号 |
| `server.js` | 面板后端：状态汇总、账号增删改、批量签到、时段/自启/重试开关、按账号的授权代理 | 仅监听 `127.0.0.1:8795`；接口不返回明文凭证；WorkBuddy 实时查询按账号缓存 60 秒 |
| `status.js` | 命令行状态查看（面板的 CLI 版本）：按账号列今日签到、实时 WorkBuddy 状态、凭证、日志累计与按账号积分 | 零依赖 |
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

### 2. 当日幂等：以「账号 × 端」为单位

任务每天触发 5 次（外加联网补签事件），但每一项签到只需要成功一次。`state/daily-status.json` 按账号分槽记录当天每一端的状态（`accounts[账号ID][端]`）：

- 任一「账号 × 端」成功（含「今日已签到（幂等）」「跳过领取」这类等价成功）→ 立即标记该项完成，**后续时段跳过该项**，其它账号/端不受影响；
- 某账号的两端都完成 → 后续时段**该账号整块跳过**；
- 所有目标账号的所有端都完成 → 后续时段**整轮直接退出，零网络请求**，日志只多一行 `今日 N 项签到任务均已完成（M 个账号），本轮跳过`；
- 只完成一部分 → 下一时段**只补跑未完成的项**；
- **失败不落盘**（读取时也会被清掉）→ 失败项在下一时段自动重试，不会漏签；
- 跨天自动重置（按本机本地日期比较）；
- 排障时需要强制重跑：`node checkin.js --force`。

### 3. 凭证来源

**凭证按账号存放**，都在 `config.json` 的 `accounts[]` 里；顶层 `workbuddy` 只是 v1 的遗留槽位，迁移后为空（`lib/accounts.js` 搬运凭证时会清空它）。

WorkBuddy 只有**一个**来源：该账号的 `workbuddy.accessToken` / `refreshToken` / `uid` / `domain`，由 `wb-auth.js` 写入。上游曾尝试在本机自动取 token，三条路径在当前版本上均已证实无效，相关代码已移除：

1. 离线解密 `workbuddy-desktop.info` —— 该字段是 `$wbEncrypted` 加密对象，解密依赖客户端内部构造的 AAD；
2. 读明文 info 文件 —— 文件存在，但字段是加密的；
3. 扫客户端日志找 JWT —— 网页端已改用 Keycloak，日志中没有明文 JWT。

续期策略（**按账号**）：本地记录 `refreshedAt`，超过 **20 小时**即调 `wb-auth.js ensure --account <id>` 主动刷新一次（官方 access token 约 28 天有效，20 小时只是保守阈值，避免临期才动）；若签到失败且错误信息疑似凭证问题（`token` / `401` / `403` / `失效` / `过期`），会再刷新并重试一次。刷新时 `refreshToken` 会滚动更新，一并落盘。`ensure` 不带 `--account` 时遍历所有启用 WorkBuddy 的账号。

Trae 的凭证分两层：

- **默认（本机客户端）**：从 `Trae CN/User/globalStorage/storage.json` 解密 `iCubeAuthInfo://icube.cloudide`（约 14 天有效、客户端自动刷新），设备 ID 取同文件中 `iCubeAuthInfo://icube-dc:<数字>` 的 aha 设备 ID。多个来源按 **`exp` 最大者**择优，`exp` 相同时按 `manualToken` > 本机客户端 > `trae-token.json`。
- **账号级手工配置**：账号的 `manualToken` + `deviceId`。此时**不依赖本机 `storage.json`**，因此第二个 Trae 账号不必登录到本机客户端也能签到；显式 `deviceId` 优先级最高。账号自己填了 `manualToken` 会带上 `manualOnly` 标记：`resolveTokenInfo` **只认这个 token**，不再让本机客户端 / `trae-token.json` 参与 exp 择优 —— 否则本机客户端的长 token 会挤掉它，用另一个账号签到。两项必须属于同一个 Trae 账号，否则接口会以 `9074` 伪装成「高峰期」——详见「[多账号模型与不变量](#多账号模型与不变量)」。

### 4. 失败语义

`ok: true` 才计入当日完成，包括以下等价成功：

- WorkBuddy：接口返回 `code: 10001`（今日已签到）；
- Trae：返回「跳过领取」（今日已签）。

Trae 多账号解析到同一个登录态时，第二个账号记为「跳过（与账号「x」共用同一 Trae 登录态）」并按完成处理 —— 它确实不需要再签一次。

其余一律视为失败：只记日志、不写状态，等下一个时段重试。粒度同样是「账号 × 端」：某个账号失败不会影响其它账号，各自独立重试。

### 5. 断网兜底（三层）

任务层的 `RunOnlyIfNetworkAvailable` 只在**任务启动前**判定一次：Wi-Fi 连着但上游没网时任务照样启动，请求直接 `ENOTFOUND`，若就此收场就要等到下一个时段。为此加了三层：

1. **运行内等待**：请求异常经 `lib/net.js` 判定为网络类（`ENOTFOUND/EAI_AGAIN/ECONNRESET/ETIMEDOUT/…`，含 `err.cause.code`）→ 本轮不结束，按预算轮询等联网，恢复后重试未完成的项。预算 = `min(networkRetry.waitMs, CHECKIN_WATCHDOG_MS − 已耗时 − 6 分钟预留)`，保证不撞看门狗。等待期间每满 60 秒记一行进度，其余静默。断网时跳过 WorkBuddy 的凭证刷新（否则白等最多 6 分钟）。
2. **联网事件补签**：任务 `DailyCheckinOnNet` 订阅 `Microsoft-Windows-NetworkProfile/Operational` 的 `10000`（网络已连接），`Delay=PT15S` 后以 `--quiet-skip` 启动。所有目标账号的所有端今日都完成 → 不写日志、不抢锁直接退出（网络一天可能重连很多次，不能刷屏）；有未完成项 → 正常走一遍流程，且只补未完成的项。
3. **后续时段**：面板设定的各时段照常触发；关机/睡眠错过的由 `StartWhenAvailable` 在恢复后补跑。
4. **登录补签**：`DailyCheckinOnLogon` 在用户登录 30 秒后补签。
5. **间隔重试**：`DailyCheckinHourly` 每 N 小时重试，直到当天的所有「账号 × 端」完成 —— 这是"电脑整段时间没开机"的最后一道兜底。

判定在线用的是「对 `www.workbuddy.cn` / `api.trae.cn` 发 `HEAD` 能否拿到 HTTP 响应」（有响应即在线，4xx/5xx 也算），刻意不用 ping（常被防火墙挡）和纯 DNS（缓存会给出假阳性）。

### 6. 系统通知（不打扰式）

后台运行没有窗口，通知是唯一"主动告知"的渠道。规则（`lib/notify.js`）：

| 事件 | 档位 |
| --- | --- |
| 当日首次全部任务完成（白天） | `silent`：`<audio silent="true"/>`，无声音横幅，约 5 秒自动消失，不抢焦点 |
| 当日首次全部任务完成（`notify.nightStart`–`nightEnd`，默认 23:00–07:00） | `center`：`ToastNotification.SuppressPopup = true`，只进通知中心 |
| 失败 / 断网等待超时 / token 失效 | `alert`：横幅 + 默认提示音 |
| 漏签风险（`notify.lastSlotAfter` 之后仍未完成） | `alert`，且每轮都提醒（唯一不受"每天一次"去重限制的档） |

多账号时成功通知的标题为「今日签到完成（N 个账号 / M 项）」，正文按「账号·端」列要点、超过 3 项折叠为「等 N 项」；单账号仍是 v1 的「今日签到完成（Trae + WorkBuddy）」。去重标记写进 `state/daily-status.json` 的 `notify` 字段（`successAt` / `failureKey`），跨天随状态一起重置；失败键由「账号:端:失败类别」排序拼接，因此某个账号的失败不会掩盖另一个账号的失败。通知发送失败只写一行 `[通知] 发送失败：…`，绝不影响签到结果；发送成功也留一行 `[通知] 已发送（档位）…` 便于排查"为什么没收到"。

实现上由 `notify-toast.ps1` 走 Windows PowerShell 5.1 的 WinRT 接口（`Windows.UI.Notifications`），**不需要 npm 依赖、不需要 BurntToast**；node 以 `spawnSync + windowsHide` 调用，超时 15 秒。通知来源用注册脚本写入的 `HKCU\SOFTWARE\Classes\AppUserModelId\AutoCheckin.Daily`（显示为「自动签到（Trae / WorkBuddy）」），该键不存在时退回 PowerShell 自带的 AUMID。

## 多账号模型与不变量

### 数据模型

`config.json` 的 `accounts[]` 每项形如 `{ id, name, enabled, trae{…}, workbuddy{…} }`；顶层 `trae` 是全局默认值，顶层 `workbuddy` 是 v1 遗留槽位（迁移后为空）。凭证**只存在于账号内**，所有写回由 `lib/accounts.js` 统一走「读 → 归一化 → 原子替换（临时文件 + rename）」，不会写出半截 JSON。

### 任务模型

- **任务键 = 账号 ID + 端**（`accounts.taskKey`）。当日幂等（`state/daily-status.json`）、通知去重键、日志的 `[账号:…]` 归属、积分历史的 `byAccount`，全部以它为单位。
- 一轮签到 = 按账号顺序把待办展开成任务列表（`buildTasks()`），账号之间按 `batch.intervalMs` 串行间隔。

### 不变量

| # | 不变量 | 违反后果 / 现有防线 |
| --- | --- | --- |
| 1 | 账号 `id` 全局唯一、创建后稳定 | state / 日志 / 通知键全按 id 归属；`name` 只是展示，改名不影响历史 |
| 2 | 凭证只存一份（在 `accounts[]` 内） | 迁移时清空顶层 `workbuddy`，杜绝两处不同步；手工删 `accounts` = 丢登录态（README 有醒目警告） |
| 3 | 旧配置与旧 state 一律映射到 `default` | 升级当天不重复签到；`default` 这个 ID 是刻意固定的，不可再生成 |
| 4 | 显式凭证不与本机登录态混用 | 账号级 `manualToken` → `manualOnly`，`resolveTokenInfo` 不再拿本机客户端 / `trae-token.json` 参与 exp 择优；v1 的全局 `manualToken` / `tokenFile` 只有 `default` 能继承 |
| 5 | `manualToken` 与 `deviceId` 必须属于同一账号 | 不匹配时接口持续返回 `9074`（伪装成「高峰期」）；「填了 token、device-id 回落到本机客户端」的组合重试 3 次即报错，不空耗 8 分钟总时限 |
| 6 | 同一登录态一天只签一次 | 按 `sha1(token)` 前缀登记；第二个解析到同一 token 的账号跳过，日志写明「与账号「x」共用同一 Trae 登录态」 |
| 7 | 批量签到不瞬时并发 | 任务严格串行 + 账号间隔（默认 1500 ms），避免把「多账号」暴露成风控特征 |
| 8 | 通知每天一条、同因一条 | 成功 `successAt` / 失败 `账号:端:失败类别`；漏签档（末时段后）刻意每轮都提醒 |

### 易踩的坑

- **「没填 token」与「填了 token」是两回事**：`manualOnly` 防的是「填了 token 还被本机客户端挤掉」；新账号若没填 token 就打开「参与 Trae」，仍会回落到本机客户端登录态 —— 这时靠不变量 6 兜底（同 token 去重）并在日志可见。新账号默认 Trae 端是关的，就是为了先堵住这条。
- **停用 vs 关端 vs 删除**是三层语义：停用（`enabled: false`）保留凭证只退出签到；关掉某一端只影响该端；删除连凭证与当日状态一起清，面板会二次确认。
- **新增/删除账号会让当天失败提醒重新计一次**（失败键含账号与端）：刻意如此，避免新账号的失败被旧键掩盖。
- **多账号别关节流**：把 `batch.intervalMs` 调到 0 只会让请求更像脚本，收益是几秒、风险是风控。

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
| `state/credits-history.json` | 积分历史（面板「累计积分」的数据源） |
| `state/panel.json` | 面板设置（如重试间隔） |
| `wb-auth.log` | WorkBuddy 授权与续期的日志 |
| `panel-start.log` | 面板启动诊断（仅在启动失败时写入） |
| `.wb-browser-profile/` | WorkBuddy Web 授权用到的浏览器 profile（**含会话，不要分享**） |
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
| `CHECKIN_BATCH_INTERVAL_MS` | `1500` | 批量签到时相邻两个任务的最小间隔（覆盖 `config.batch.intervalMs`；`0` = 不间隔） |

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
- 面板服务常驻后台（约 30MB 内存）。它不参与签到链路，关掉也不影响签到；下次双击 `ui.cmd` 会重新拉起。
