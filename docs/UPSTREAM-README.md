# auto-checkin ![version](https://img.shields.io/badge/version-1.2.0-blue) ![host](https://img.shields.io/badge/Node-%E2%89%A518%20%7C%20Windows%2010%2F11-339933) ![license](https://img.shields.io/badge/license-%E6%9C%AA%E6%8C%87%E5%AE%9A-lightgrey)

> 一句话定位：它把你每天要手动点的 **Trae CN + WorkBuddy** 签到，变成开机后自动跑完的 Windows 计划任务——给天天用这两个工具、又总忘记签到的人用。

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 签到动作 | 打开客户端 → 找到签到入口 → 点一下，两个平台各来一遍 | 什么都不用做，脚本替你点 |
| 触发方式 | 全靠你记得 | Windows 计划任务：每天 00:01 / 09:00 / 13:00 / 17:00 / 21:00，外加「网络恢复」事件触发 |
| 忘记的后果 | 当天签到作废，第二天清零重来 | 5 个时间点 + 断网等待 + 联网自动补签；失败/漏签会弹系统通知 |
| 登录态 | 客户端得一直保持登录 | 脚本自动从本机客户端登录态取 token，客户端会自行续期 |
| 重复领取 | 手点可能点重 | 幂等：当天成功后其余次数直接跳过 |
| 运行依赖 | — | 签到逻辑零 npm 依赖，只用 Node 内置 `crypto` / `fetch` |
| 可观测 | 签没签上全凭印象 | `checkin.log` 记录脱敏片段 + 积分结果 |

## 适合谁 / 不适合谁

- 适合：如果你要在 **Windows 10 / 11** 上每天领 **Trae CN** 与 **WorkBuddy** 的每日积分，希望「设一次就不用管」，不介意它每天跑 5 次以覆盖不同开机时段（当天完成后会自动跳过，不会重复签到）。
- 不适合：如果你用 **macOS / Linux**（`register-task.ps1` 是 Windows 计划任务脚本，需自行改用 `cron`）；或电脑**经常几天不开机**（那签到本身也就没意义了）；或你用的是 **Trae 国际版 / 其他版本**（默认对接 `api.trae.cn`，需自行改 `host`）——建议改用系统自带的 `cron` + 官方接口脚本自行拼装。
- 本项目**不做**：不做外挂、不修改客户端、不伪造数据、不做批量或多账号、不做除 Windows 以外的平台适配。

## 安装

### 前置条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10 / 11 | `register-task.ps1` 依赖 Windows 计划任务 |
| Node.js | **≥ 18** | 签到逻辑用到内置 `fetch`（可直接用 WorkBuddy 自带的托管 Node）。若还要用 Playwright 兜底抓 token，则需 **≥ 20**（`playwright@1.63` 的 `engines` 要求），否则 `npm install` 会报 `EBADENGINE` |
| Trae CN 客户端 | 已安装且**处于登录状态** | 脚本从它的 `storage.json` 解密出 token（**只读**） |
| WorkBuddy 桌面端 | 已安装且**近期登录过** | 可选；缺这一端脚本会自动跳过 |
| PowerShell | 5.1 或更高 | 注册计划任务用 `Register-ScheduledTask`（**不用** `schtasks.exe`） |
| Windows Script Host | 系统自带（Win10/11 默认启用） | `run-hidden.vbs` 隐藏窗口启动器依赖它；缺失时注册脚本会回退成直接跑 `node.exe`（会弹控制台窗口） |

### 该选哪种方式

| 方式 | 适用场景 | 代价 |
| --- | --- | --- |
| AI 提示词一键部署 | 只想用，不想看步骤 | 需要一个能读写本机文件、能执行命令的本机 Agent |
| `git clone` + 手动命令 | 想自己控制每一步 / 要改源码、提 PR | 需 Node 环境 + 会敲命令 |
| Download ZIP | 离线环境 / 想锁版本 | 不自动更新，升级要重新下载 |

> 本项目**不是宿主插件**，没有 `link:` 一类的安装机制；要调试源码，clone 下来直接 `node checkin.js` 跑即可。

<details><summary>方式一：AI 一键部署（推荐，完整步骤）</summary>

**前提只有一个**：你用的 AI 能读写本机文件、能执行命令（WorkBuddy 桌面端、Trae CN、Cursor、Claude Code、Codex 等本机 Agent 都行）。纯网页版聊天机器人没有这些能力，只能给你念步骤。

**用法**：把下面**整段**复制发给 AI，然后等它汇报结果即可。它自己会检查环境、下载项目、跑通签到、注册计划任务并验证。

```text
你是负责帮我在 Windows 电脑上部署一个开源项目的 AI 助手。请直接动手把部署做完，不要只给我步骤、不要让我自己敲命令。每一步都必须真实执行并验证；禁止编造执行结果，某步没做就写明"未执行"并说明原因。

【目标】
把 GitHub 项目 xinshang777/auto-checkin 部署到我这台 Windows 电脑上，实现"每天自动完成 Trae CN 与 WorkBuddy 的每日签到"，并注册为登录后自动运行的计划任务。

【第一步：环境体检，逐项确认】
1. 操作系统是否为 Windows 10/11（命令：右键"此电脑"属性，或 PowerShell 里执行 [System.Environment]::OSVersion.Version）。
2. 是否有 Node.js 18 或更高：
   - 优先检查托管 Node 是否存在：%USERPROFILE%\.workbuddy\binaries\node\versions\ 目录下找 node.exe，有就记下完整路径，后续都用它；
   - 没有就检查系统 node：node -v；
   - 两者都没有，帮我安装 Node.js LTS（winget install OpenJS.NodeJS.LTS，或从 https://nodejs.org 下载安装包），装完重新确认。
3. 我是否装了 Trae CN 客户端并处于登录状态（签到靠读取它的本机登录态取 token）。
4. 我是否装了 WorkBuddy 桌面端并近期登录过（可选，没有这一端会自动跳过）。
把以上 4 项的检查结果先告诉我。若 Trae CN 没装或没登录，明确提醒我"请打开 Trae CN 客户端登录一次"，然后继续完成其余步骤，不要因此停下。

【第二步：下载项目】
默认装到 %USERPROFILE%\auto-checkin：
  git clone https://github.com/xinshang777/auto-checkin.git
如果 git 不可用，就下载仓库 ZIP（https://github.com/xinshang777/auto-checkin/archive/refs/heads/main.zip）并解压到同一位置。
提示：如果目标路径含中文或空格，后续所有命令都要用引号把路径包起来。

【第三步：安装依赖 —— 默认跳过】
本项目纯签到部分是零 npm 依赖的。不要执行 npm install，也不要下载 Playwright 浏览器，除非后面确实需要抓 token 而失败。这样能省下几分钟和几百 MB。

【第四步：准备配置】
把 config.example.json 复制一份为 config.json。
两个平台的 token 字段保持留空即可，脚本会自动从本机客户端登录态里取。
安全要求：config.json 里会存 token，不要把它写到任何仓库、日志或聊天记录里，也不要回显它的完整内容。

【第五步：先手动跑一次，确认真的能签到】
用第二步选定的 node.exe 执行 checkin.js（例如：%USERPROFILE%\.workbuddy\binaries\node\versions\ 下的 node.exe checkin.js，或直接用 node checkin.js）。
判定成功：输出里出现下面任意一句即算成功——
  "WorkBuddy 签到成功" 或 "WorkBuddy 今日已签到（幂等）" 或 "Trae 签到成功"
失败时按下面处理，不要直接放弃：
  - 提示"未找到 WorkBuddy token"：让我打开 WorkBuddy 桌面端登录一次，然后重跑。
  - 提示"未找到 Trae token"：让我打开 Trae CN 客户端登录一次，然后重跑。
  - Trae 提示 9074：先重跑一次，本脚本自带退避重试；若一直 9074，检查日志里的 x-device-id 警告。

【第六步：注册计划任务（每天 00:01 / 09:00 / 13:00 / 17:00 / 21:00 自动运行 + 网络恢复后自动补签，隐藏窗口无感运行）】
在 PowerShell 里执行项目目录下的注册脚本：
  powershell -ExecutionPolicy Bypass -File .\register-task.ps1
注意三点：
  1. 必须用 PowerShell 的 Register-ScheduledTask 机制完成注册；有些电脑把 schtasks.exe 禁用了，不要调用 schtasks.exe。
  2. 如果报"语法错误"，说明 register-task.ps1 在传输过程中丢了 BOM——请把它按 UTF-8 with BOM 重新保存，再执行一次。
  3. 注册脚本会把任务动作设为 wscript.exe 执行同目录下的 run-hidden.vbs（隐藏窗口启动 node），这样到点运行时不会弹出任何命令提示符窗口。注册脚本会建两个任务：DailyCheckin（每天 5 个时间点）与 DailyCheckinOnNet（系统报告"网络已连接"时静默补签，断网兜底）。用 Get-ScheduledTask -TaskName DailyCheckin 确认动作里出现 run-hidden.vbs 和 Hidden=True。

【第七步：手动触发一次，确认任务真能跑起来】
  Start-ScheduledTask -TaskName DailyCheckin
这一步屏幕不会有任何反应（隐藏窗口后台运行），属正常现象。等待 20 到 60 秒，然后读项目目录下 checkin.log 的最后 30 行，确认这次触发留下了成功记录。
再核对任务注册情况：
  Get-ScheduledTask -TaskName DailyCheckin
应看到 5 个每日触发器（00:01 / 09:00 / 13:00 / 17:00 / 21:00），状态为 Ready；再用 Get-ScheduledTask -TaskName DailyCheckinOnNet 确认它有 1 个事件触发器（订阅里含 Microsoft-Windows-NetworkProfile/Operational 与 EventID=10000）；同时用 Get-ScheduledTaskInfo -TaskName DailyCheckin 看 LastTaskResult（0 = 正常）。
另外说明：注册脚本会注销同名旧任务再重建，所以不会出现两个同名任务。

【必须遵守】
- 全程真实执行，把每步的真实命令输出贴出来；不要脑补结果。
- 任何输出里不要打印完整 token（最多显示前 6 位）。
- 不要修改 checkin.js 和 lib/ 目录下的签到逻辑，本次只做部署。
- 不要删除或改动项目目录以外的任何文件。
- 某步失败：先自行排查（重试、看 checkin.log、按上面提示处理），仍失败就停下来，告诉我具体报错、已经试过什么、当前卡在哪一步。

【最后按这个格式汇报】
1. 项目路径：
2. 使用的 Node 路径与版本：
3. 手动运行结果：成功 / 失败，附关键日志行
4. 计划任务：任务名、5 个触发时间、当前状态、LastTaskResult（0 为正常），以及执行命令是否为 `wscript.exe …run-hidden.vbs`（隐藏窗口）；再报一下 DailyCheckinOnNet 是否存在（联网补签任务）
5. checkin.log 最近一次运行结果；若显示"本轮跳过"，说明当天已签完，属正常
6. 还需要我做的事（例如"请打开 Trae CN 客户端登录一次"）
7. 后续如何自查：PowerShell 执行 Get-ScheduledTask -TaskName DailyCheckin 看状态，看 checkin.log 看结果（后台运行没有窗口提示，日志是唯一痕迹）
```

> 如果 AI 能直接联网读仓库，你也可以只说一句：**"按 https://github.com/xinshang777/auto-checkin 的 README 里那段 AI 部署提示词，帮我把这个项目部署好。"**

</details>

<details><summary>方式二：git clone + 手动部署（改源码 / 提 PR 走这条）</summary>

```bash
git clone https://github.com/xinshang777/auto-checkin.git
cd auto-checkin
cp config.example.json config.json      # token 字段留空即可
node checkin.js                         # 先手动跑一次，看到"签到成功"再往下
powershell -ExecutionPolicy Bypass -File .\register-task.ps1
```

- 项目目录**可以整体移动**到任意位置，移动后重跑一次注册脚本即可（任务里记录的是绝对路径）。
- 想用 WorkBuddy 自带托管 Node（版本目录名以你机器上的为准）：`"%USERPROFILE%\.workbuddy\binaries\node\versions\<版本>\node.exe" checkin.js`。
- 改签到时间：编辑 `register-task.ps1` 里的 `$TriggerTimes` 数组后重跑注册脚本（联网补签任务不在这份时间表里，它由系统"网络已连接"事件触发）。
- 要改签到逻辑，看 `checkin.js`（主流程）与 `lib/trae.js`、`lib/workbuddy.js`、`lib/token-sources.js`。

</details>

<details><summary>方式三：Download ZIP（离线 / 锁版本）</summary>

1. 打开仓库页面 → **Code → Download ZIP**，解压到任意目录；
2. `cp config.example.json config.json`，token 字段留空；
3. 用 Node ≥ 18 跑 `node checkin.js`，确认输出成功；
4. PowerShell 执行 `powershell -ExecutionPolicy Bypass -File .\register-task.ps1`。

⚠️ 两点注意：ZIP 解压后的 `register-task.ps1` 必须保持 **UTF-8 with BOM**，否则 PowerShell 5.1 按 GBK 解析会报语法错误；此方式不会自动更新，升级要重新下载。

</details>

### 重启说明

| 场景 | 是否需要重启 |
| --- | --- |
| 刚部署完、注册了计划任务 | 不需要重启电脑，任务即刻生效 |
| 改了 `config.json` | 不需要，下次触发即生效 |
| 改了 `checkin.js` / `lib/*` | 不需要 |
| 改了 `register-task.ps1` 的时间数组 | 不需要重启，但要**重跑一次注册脚本** |
| 刚登录 Trae CN / WorkBuddy 客户端 | 不需要，token 每次运行时现取 |
| 电脑注销 / 关机 | 计划任务不会跑；下次开机登录后靠 `StartWhenAvailable` 补跑 |
| 断网 / 路由器没网 | 不需要；等网络恢复后靠 `DailyCheckinOnNet` 立即补签，且运行时自带等待重试 |

### 三十秒验证成功

在项目目录打开 PowerShell，执行 `node checkin.js` → 看到 `WorkBuddy 签到成功` 或 `WorkBuddy 今日已签到（幂等）` 或 `Trae 签到成功` = **装好了**。

## 使用教程

1. **确认任务已注册** —— `Get-ScheduledTask -TaskName DailyCheckin`，应看到 5 个每日触发器（00:01 / 09:00 / 13:00 / 17:00 / 21:00），状态 `Ready`；执行命令应为 `wscript.exe //B //Nologo "…\run-hidden.vbs"`。再看 `Get-ScheduledTask -TaskName DailyCheckinOnNet`：网络恢复时它会静默补签。
2. **立即试跑一次** —— `Start-ScheduledTask -TaskName DailyCheckin`，或在「任务计划程序」里找到 `DailyCheckin` 右键 → 运行。**屏幕不会有任何反应**（这是正常的：隐藏窗口后台运行）。
3. **看结果** —— 日志是唯一痕迹：
   - Git Bash / WSL：`tail -n 30 checkin.log`
   - PowerShell：`Get-Content .\checkin.log -Tail 30 -Encoding UTF8`

   ⚠️ PowerShell 5.1 的 `Get-Content` 不加 `-Encoding UTF8` 会把日志里的中文读成乱码，别误以为程序坏了。日志只记脱敏片段与积分结果，不写明文 token。
4. **不用管了** —— 之后每天到点自动在后台跑。**当天任一端签到成功后，后面的时间点会自动跳过**：两端都完成时整轮直接退出，不再重复走一遍签到流程（跨天自动重置）。结果会以系统通知呈现：成功每天一条汇总（不打扰），失败/漏签风险会明确提醒。
5. **想强制重跑** —— `node checkin.js --force`，忽略「当日已完成」标记。

```mermaid
flowchart TD
    A["计划任务 DailyCheckin<br/>00:01 / 09 / 13 / 17 / 21 点<br/>Hidden = 隐藏"] --> B["run-hidden.vbs<br/>wscript 隐藏窗口启动"]
    N["计划任务 DailyCheckinOnNet<br/>系统事件：网络已连接<br/>（--quiet-skip 静默模式）"] --> B
    B --> C["checkin.js<br/>（无可见窗口、无交互）"]
    C --> D{"今天两端都已<br/>签到完成？"}
    D -->|"是"| E["直接退出<br/>只留一行日志、不发任何请求"]
    D -->|"否"| F["只跑尚未完成的那一端"]
    F --> G["取 token → 调签到接口"]
    G --> H{"成功？"}
    H -->|"是"| I["写 state/daily-status.json<br/>后续时段自动跳过该端"]
    H -->|"否（断网）"| W["等网络恢复（默认最多 10 分钟）<br/>恢复后立即重试；等不到就交给<br/>联网补签任务与下个时段"]
    H -->|"否"| J["退避重试<br/>最多 10 次 / 8 分钟<br/>下一时段继续补"]
    I --> K["写 checkin.log"]
    W --> K
    J --> K
    K --> T["系统通知：成功汇总 / 失败与漏签告警"]
```

**配置项**

配置写在项目目录的 `config.json`（从 `config.example.json` 复制而来）。字段与默认值如下：

| 名称 | 类型 | 默认值 | 是否必填 | 作用 |
| --- | --- | --- | --- | --- |
| `trae.host` | string | `https://api.trae.cn` | 否 | 签到接口域名；换用其他版本时改这里 |
| `trae.region` | string | `CN` | 否 | 请求头 `X-User-Region` 的取值 |
| `trae.storageJson` | string | `""` | 否 | 手动指定客户端 `storage.json` 路径；留空自动探测 |
| `trae.cloudideStorage` | string | `""` | 否 | 手动指定登录态存储路径；留空自动探测 |
| `trae.manualToken` | string | `""` | 否 | 手动兜底 token，一般留空（自动取） |
| `trae.tokenFile` | string | `trae-token.json` | 否 | 抓取到的 token 缓存文件 |
| `trae.maxRetry` | number | `10` | 否 | Trae 限流时的最大重试次数 |
| `trae.minWait` / `trae.maxWait` | number | `15000` / `30000` | 否 | 退避等待区间（毫秒） |
| `trae.deadlineMs` | number | `480000` | 否 | 单次运行的重试总时限（8 分钟） |
| `workbuddy.accessToken` | string | `""` | 否 | 基线兜底 token，一般留空（自动扫本机日志采集） |
| `workbuddy.uid` | string | `""` | 否 | 留空：自动从 JWT 的 `sub` 解析 |
| `workbuddy.domain` | string | `""` | 否 | 留空：默认 `www.workbuddy.cn` |
| `workbuddy.atRestSecretKey` | string | `""` | 否 | 留空：离线解密用的静态主密钥（一般不需要） |
| `networkRetry.enabled` | boolean | `true` | 否 | 断网时是否在运行内等待联网再重试 |
| `networkRetry.waitMs` | number | `600000` | 否 | 等待联网的上限（10 分钟；实际还受看门狗剩余时间与 6 分钟预留限制） |
| `networkRetry.probeIntervalMs` | number | `20000` | 否 | 等待期间探测网络的间隔 |
| `crossDayGuard.enabled` | boolean | `true` | 否 | 是否启用「跨天保护」（0 点刚过时接口报"已签到"不记为今日完成） |
| `crossDayGuard.minutes` | number | `60` | 否 | 跨天保护窗口长度（分钟） |
| `notify.enabled` | boolean | `true` | 否 | 是否发系统通知 |
| `notify.nightStart` / `notify.nightEnd` | string | `23:00` / `07:00` | 否 | 夜间时段：成功汇总只进通知中心、不弹横幅 |
| `notify.lastSlotAfter` | string | `21:00` | 否 | 这个时间之后若仍未完成，每轮都发「漏签风险」告警 |

**上表所有字段都可以不填。** 只要两端客户端处于登录状态，脚本每次都能自己拿到 token。

> 日志路径固定为项目目录下的 `checkin.log`（超限自动轮转为 `checkin.log.N`），**不支持配置**——启动器 `run-hidden.vbs` 在 node 起不来时也要往同一个文件写错误，做成可配置会让两处不一致。

**环境变量（可选，不进 config.json）**

| 名称 | 默认值 | 作用 |
| --- | --- | --- |
| `CHECKIN_WATCHDOG_MS` | `1200000`（20 分钟） | 单次运行的时长上限；超时强制退出并写 `[看门狗]` 日志。排障时可用小值快速验证 |
| `CHECKIN_LOG_MAX_BYTES` | `1048576`（1 MiB） | 日志轮转阈值；`checkin.log` 超过它即存档为 `checkin.log.N`。排障时可设小值验证轮转 |
| `WB_ENDPOINT` | `https://www.workbuddy.cn` | WorkBuddy 签到接口端点覆盖（`lib/workbuddy.js` 读取；默认端点变更或需指向 `copilot.tencent.com` 时用） |
| `CHECKIN_NET_WAIT_MS` | `600000`（10 分钟） | 断网时等待联网的上限（覆盖 `networkRetry.waitMs`；排障时可设小值快速验证） |
| `CHECKIN_NET_PROBE_HOSTS` | `https://www.workbuddy.cn,https://api.trae.cn` | 网络探针主机（逗号分隔）；排障时可指向不存在的域名模拟断网 |
| `CHECKIN_CROSS_DAY_GUARD_MINUTES` | `60` | 跨天保护窗口分钟数（`0` = 关闭） |
| `CHECKIN_LAST_SLOT_AFTER` | `21:00` | 漏签风险告警的起点（排障时可设 `00:00` 强制触发） |

## 无感运行与当日跳过

这两个行为是本项目「装完就不用管」的关键，默认配置即生效，无需额外设置。

### 1. 后台隐藏运行，不弹命令提示符

计划任务以「仅在用户登录时运行」（`LogonType=Interactive`）执行时，如果直接跑 `node.exe` 这类控制台程序，Windows 会**弹出命令提示符窗口**。本项目加了一层隐藏启动器解决它：

```text
计划任务 → wscript.exe //B //Nologo run-hidden.vbs →（隐藏窗口）node checkin.js
```

- `wscript.exe` 是 GUI 子系统宿主，自身不创建控制台窗口；
- `run-hidden.vbs` 用 `WshShell.Run(cmd, 0, False)` 启动 node —— `0` = 隐藏窗口，`False` = 不等待，启动器立即退出，node 在后台跑完；
- 计划任务本身也标了 `Hidden`（不出现在任务计划程序的常规视图里）；
- 启动器会自动挑选 Node：托管 Node（`%USERPROFILE%\.workbuddy\binaries\…`）→ `C:\Program Files\node\node.exe` → PATH 里的 `node`；
- 顺带说明：token 兜底抓取 `capture-workbuddy-token.js` 默认就是**无头浏览器**（只有加 `--login` 才可见），所以自动刷新 token 时也不会闪窗口；
- 启动失败会留痕：`run-hidden.vbs` 在启动前会校验 `checkin.js` 是否存在，失败时往 `checkin.log` 写一行 `[launcher] FAILED to start node: …`（wscript 自身总是返回 0，不留痕就会变成"任务成功但什么都没跑"的静默失败）。

结果：到点在后台静默跑完，**屏幕不会有任何反应**。想确认它跑过，只能看 `checkin.log`。

**代价与补偿（重要）**：隐藏启动器是「立即返回」的，任务会在 0.1 秒内显示为已完成，所以任务层面的
`MultipleInstances=IgnoreNew`（互斥）与 `ExecutionTimeLimit=PT15M`（运行上限）**都不再生效**。
这两项能力改由 `checkin.js` 自己兜住，避免静默退化：

| 原先由任务层提供 | 现在的替代实现 |
| --- | --- |
| `IgnoreNew` 防止叠跑 | `state/run.lock.json` 单实例锁：锁持有者进程仍在且未超时 → 本轮直接退出并留一行日志；持有者已死或锁已过期 → 自动接管；锁只会被持有者自己释放，不会误删他人锁 |
| `PT15M` 运行时长上限 | 内置看门狗：超过 `CHECKIN_WATCHDOG_MS`（默认 20 分钟，可用环境变量覆盖）即 `process.exit(2)` 并写一行 `[看门狗] …` 日志，同时释放锁 |

### 2. 当日签到成功后就跳过后续时段

每个时段都重跑一遍没有意义（还会重复请求接口），所以加了当日状态标记：

- 状态文件：`state/daily-status.json`（运行时产物，已在 `.gitignore` 中），按**本机本地日期**记录每一端是否已完成；
- 任一端签到成功（「签到成功」或「今日已签到（幂等）」这类等价成功都算）→ 该端立即标记完成，**后续时段的触发跳过它**；
- 两端都完成 → 后续时段**整轮直接退出**，不发任何网络请求，只在日志留一行：
  `今日签到已完成（WorkBuddy … / Trae …），本轮跳过，不重复签到`；
- 只完成一端 → 下一时段**只补跑未完成的那一端**，不会让已完成的那端重复签；
- 失败不落盘 → 失败的那一端下一时段照常重试；
- 跨天自动重置，第二天 00:01 重新开始（0 点刚过若接口仍报"今日已签到"，会走跨天保护、不记为完成，留给下一时段复核）；
- 想忽略标记强制重跑：`node checkin.js --force`。

> 常见误解：看到 13:00 / 17:00 / 21:00 在日志里没有签到记录，会以为「任务没跑」。实际是**故意的**——当天早上已经签完了，后面几次就是跳过。

### 3. 断网也不漏签（三层兜底）

| 层 | 机制 | 触发时机 |
| --- | --- | --- |
| ① 运行内等待 | 请求失败被判定为「网络不可用」时本轮不结束：每 20 秒探测一次（默认最多等 10 分钟，且受看门狗剩余时间与 6 分钟预留限制），网络一恢复立即重试未完成的一端 | 请求报 `ENOTFOUND` / 超时等 |
| ② 联网补签任务 | 计划任务 `DailyCheckinOnNet`：系统报告「网络已连接」（NetworkProfile 事件 10000）后延迟 15 秒，以 `--quiet-skip` 静默模式补跑；当天已签完则不留任何日志 | 每次网络恢复 |
| ③ 后续时段 | 00:01 / 09:00 / 13:00 / 17:00 / 21:00 照常触发；关机/睡眠错过由 `StartWhenAvailable` 补跑 | 每个时段 |

> `--quiet-skip`：两端今日都完成时直接退出，不写日志、不抢锁 —— 网络一天可能重连很多次，不能让它把日志刷屏。

### 4. 系统通知（不打扰式）

| 事件 | 何时发 | 打扰级别 |
| --- | --- | --- |
| 当日首次两端完成（白天） | 完成的当下 | **静默横幅**：无声音、约 5 秒自动消失、不抢焦点，通知中心留痕 |
| 当日首次两端完成（23:00–07:00，含 00:01 那轮） | 完成的当下 | **只进通知中心**（`SuppressPopup`）：屏幕不弹卡片、不发声 |
| 失败 / 断网等待超时 / token 失效 | 本轮结束 | **横幅 + 提示音**（需要你处理的事） |
| 漏签风险（`notify.lastSlotAfter` 之后仍未完成） | 每轮 | **横幅 + 提示音** |
| 等待联网中、跨天保护触发、已完成跳过、`--quiet-skip` | — | 不发通知，只写日志 |

- 成功每天只发一条；同一失败原因每天只发一条（漏签风险档除外，那是最后兜底）。
- 通知由 `notify-toast.ps1` 通过 Windows PowerShell 5.1 的 WinRT 接口发送，**零 npm 依赖**；powershell 以隐藏窗口（windowsHide）拉起，**不闪黑框、不抢焦点、无模态窗**。
- 通知来源显示为「自动签到（Trae / WorkBuddy）」；该标识注册失败时自动退回 PowerShell 来源，不影响功能。
- 开着专注助手/勿扰时，横幅会被系统自动压到通知中心，不会强行打扰。
- 想关掉：`config.json` 里 `notify.enabled=false`，或临时加 `--no-notify`。
- 每发一次都会在日志留一行 `[通知] 已发送（档位）：标题`，用来回答「为什么没收到」。

## 常见问题 / 排障

**A｜每个时间点都会签到吗？后面的时段怎么没有记录？**

- **不是**，这正是设计目标：**当天任一端签到成功后，后续时段就不再重复签到**。
- 两端都完成时，后续触发会直接退出，日志里只有一行 `今日签到已完成（…），本轮跳过，不重复签到`。
- 只有一端成功时，下一时段只补跑失败的那一端。
- 想强制重跑一次：`node checkin.js --force`（或把 `state/daily-status.json` 删掉，效果相同）。

**B｜到点后屏幕毫无反应，是不是没跑？**

- 是正常的：任务是**隐藏窗口后台运行**，不弹命令提示符、也无任何提示。
- 唯一的痕迹是日志：`tail -n 30 checkin.log`（PowerShell 用 `Get-Content .\checkin.log -Tail 30 -Encoding UTF8`；**不加 `-Encoding UTF8` 中文会显示成乱码，属读取方式问题而非日志损坏**）；任务级状态用 `Get-ScheduledTaskInfo -TaskName DailyCheckin` 看 `LastRunTime` / `LastTaskResult`（`0` = 正常）。
- 若 `LastTaskResult` 是 `3221225786`（`0xC000013A`），说明这次进程是被外部终止的（例如注销/关机/被手动结束），不是脚本逻辑错误；下一时段会自动补跑未被标记完成的那一端。
- **特别注意**：`LastTaskResult=0` 只说明**启动器**正常退出，并不等于 node 真的跑了（wscript 启动后立刻返回）。所以判据要组合看：`LastTaskResult=0` **并且** `checkin.log` 里有本次的新记录，才算真的跑过。若任务显示跑过、但日志一行都没新增，说明启动器没生效（例如 Windows Script Host 被组策略禁用）。

**C｜日志里出现 `[launcher] FAILED to start node` 或 `[看门狗]` 是什么意思？**

- `[launcher] FAILED to start node: …` —— 隐藏启动器没能把 node 拉起来（node 路径不对、`checkin.js` 被移动/改名等）。这一行由 `run-hidden.vbs` 写入（英文），因为 wscript 自身退出码永远是 0，不写日志就会变成静默失败。
- `[看门狗] 运行超过 N 分钟仍未结束，强制退出（pid …）` —— 本次运行超过了运行时长上限（默认 20 分钟）被强制结束。因为任务层已无法限制运行时长，这是唯一的兜底；出现后请查 `checkin.log` 前几行确认卡在哪一步（大概率是 Trae 频繁 9074）。
- `[跳过] 已有另一个签到进程在运行（pid …）` —— 上一次还没跑完，本次触发被单实例锁挡下，属正常保护。

**1｜Trae 返回 `9074 当前参与用户太多，请稍后再试`**

- **原因**：两种可能。① 真实高峰限流——脚本已内置退避重试（最多 10 次 / 8 分钟），通常自己会好；② **`x-device-id` 用错了**——早期脚本误用 `telemetry.devDeviceId`，而客户端实际用的是 `storage.json` 里键名 `iCubeAuthInfo://icube-dc:<数字ID>` 中的 **aha 设备 ID**。
- **处理**：脚本自 2026-09-29 起已自动提取 aha ID，并在缺失时直接打印警告。若仍持续 9074，先确认 `x-device-id` 是否等于 `storage.json` 中 `iCubeAuthInfo://icube-dc:<id>` 的数字 ID，再重跑。注意 `status` 接口不校验设备 ID、只有 `claim` 校验，所以典型现象是「查询一切正常，领取永远失败」。

**2｜`未找到 Trae token` / `未找到 WorkBuddy token`**

- **原因**：客户端没登录，或本机没有可用的 token 缓存/日志。
- **处理**：打开对应的客户端**登录一次**，然后重跑。仍不行再用[使用教程](#使用教程)的手动兜底：Trae 从浏览器 `Local Storage` 的 `Cloud-IDE-Token` 复制；WorkBuddy 从 `Authorization: Bearer eyJhbGci...` 复制 `Bearer ` 之后的部分，填进 `config.json` 的 `workbuddy.accessToken`。

**3｜`register-task.ps1` 报语法错误**

- **原因**：文件含中文，被以非 BOM 编码保存后，Windows PowerShell 5.1 按 GBK 解析导致乱码报错。
- **处理**：把 `register-task.ps1` 按 **UTF-8 with BOM** 重新保存，再执行一次即可。

<details><summary>完整排障表</summary>

| 现象 | 处理 |
| --- | --- |
| **Trae：`9074`** | 真实限流（已自动退避重试）或 `x-device-id` 与 token 不匹配。脚本已自动取 aha 设备 ID；仍持续则按上面第 1 条排查。 |
| **Trae：`9004`** | token / device-id 不正确 → 确认 Trae CN 客户端处于登录状态，或用 `manualToken` 兜底。 |
| **Trae：`未找到 Trae token`** | 客户端未登录且无缓存 → 打开客户端登录一次，或手动提供 token。 |
| **WorkBuddy：`未找到 WorkBuddy token`** | config 与日志都采不到有效 token → 确保桌面端近期登录过，或运行 `node capture-workbuddy-token.js --login`。 |
| **WorkBuddy：`token 已过期`** | 通常是长期未用桌面端，日志里也是旧 token → 运行 `node capture-workbuddy-token.js --login`，或手动复制 Bearer token。 |
| **计划任务不触发** | 确认「仅在用户登录时运行」且电脑未关机/注销（休眠不会自动唤醒，`WakeToRun` 未开启）；用「运行」手动验证。 |
| **到点屏幕无反应** | 正常：隐藏窗口后台运行。查 `checkin.log` 与 `Get-ScheduledTaskInfo -TaskName DailyCheckin`（`LastTaskResult=0` 为正常）。 |
| **后续时段日志里没有签到记录** | 正常：当天已签完会自动跳过。要强制重跑用 `node checkin.js --force`。 |
| **`LastTaskResult=3221225786`（`0xC000013A`）** | 该次 node 进程被外部终止（注销 / 关机 / 被手动结束），属环境问题而非脚本错误；日志会停在 `===== 自动签到开始 =====`。下一时段会自动补跑未标记完成的那一端。 |
| **任务计划程序里找不到 `DailyCheckin`** | 任务已标记 `Hidden`，勾选「显示隐藏的任务」即可；或直接用 `Get-ScheduledTask -TaskName DailyCheckin` 查看。 |
| **断网 / 路由器没网** | 运行内会自动等联网（默认最多 10 分钟）再重试；等不到就交给 `DailyCheckinOnNet`（联网事件）与下一个时段。日志里会看到 `[网络] 检测到断网…` / `[网络] 等待联网超时…`。 |
| **没收到系统通知** | 先看 `checkin.log` 有没有 `[通知] 已发送…`：有 → 被专注助手/系统通知设置挡了（设置 → 系统 → 通知）；没有 → 本轮按规则不该发（成功今天已发过 / 同一失败原因已提醒过 / 是 `--quiet-skip` 静默跳过）。 |
| **0 点刚过显示"已签到"但今天没签成** | 跨天保护生效：此时接口返回的可能是昨天的状态，脚本不会记为今日完成，下个时段会自动复核。日志里有 `[跨天保护]` 行。 |
| **想要回「弹窗口可见」的调试模式** | 直接把任务的执行命令改回 `node.exe …\checkin.js` 即可（会看到控制台窗口，但一切照常工作）。 |
| **`capture-workbuddy-token.js` 无头抓取失败** | 实测：浏览器 profile 无有效登录态时，无头跑 90 秒仍返回 `no-usable-token`。需先执行一次 `--login` 在可见浏览器里登录。只要平时开着桌面端，日志采集就能持续续期，不必依赖这条兜底。 |
| **Trae 积分没到账但日志显示成功** | 以客户端内实际余额为准；接口返回 `code=0`（或 `10001` 今日已签到，视为成功）即脚本无责。 |

</details>

## 兼容性与已知限制

- **宿主最低版本**：Node.js **≥ 18**（依赖内置 `fetch`；如需 Playwright 兜底抓 token 则需 **≥ 20**）；Windows 10 / 11；PowerShell 5.1 或更高。
- **平台差异**：macOS / Linux 未适配，需自行把计划任务换成 `cron`；Trae 国际版等默认 `host` 不匹配，需自行修改。
- **冲突**：同名计划任务 `DailyCheckin` 会被 `register-task.ps1` **先注销再重建**（不会出现两个任务）；与 Trae / WorkBuddy 客户端本身无冲突；脚本对 `storage.json` 只读，不改动客户端任何文件。
- **通知可能被系统压制**：开启「专注助手 / 勿扰」或全屏运行时，横幅会被 Windows 自动压到通知中心——这是刻意的「不打扰」，但也意味着当下可能看不到，事后可在通知中心查阅。
- **00:01 不唤醒电脑**：任务不设 `WakeToRun`，睡眠/关机期间不会把机器叫醒；醒来或联网后由 `StartWhenAvailable` 与联网补签任务补跑。

## 升级、卸载与数据

- **配置存放位置**：全部在项目目录内——`config.json`（含 token，⚠️ 勿分享）、`trae-token.json`（token 缓存）、`checkin.log`（运行日志）、`state/daily-status.json`（当日签到状态，删掉无副作用，效果等于强制重跑一次）。仓库的 `.gitignore` 已排除这些文件。
- **升级**：`git pull` 后重跑一次 `register-task.ps1` 即可（任务里的路径不变时其实也不必重跑）。旧版本若把任务直接指向 `node.exe`，需要重跑一次注册脚本才会切到隐藏启动器。
- **干净卸载**：
  ```powershell
  Unregister-ScheduledTask -TaskName DailyCheckin -Confirm:$false
  Unregister-ScheduledTask -TaskName DailyCheckinOnNet -Confirm:$false
  ```
  然后删除项目目录即可；脚本不在注册表、系统目录等处留任何残留。
- **回滚**：`git checkout <上一个 tag / commit>` 后重跑注册脚本；配置与日志不受影响。

## 隐私

- **数据是否出本机**：不出。除了发给官方签到接口的必要请求，不上传任何内容到第三方。
- **是否联网**：是，但只连两个域名——`api.trae.cn`（Trae）与 `www.workbuddy.cn`（WorkBuddy）。
- **系统通知**：只在本机弹 Windows 自带 Toast（由系统渲染），不经过任何第三方推送服务、不上传任何内容。
- **是否读取账号**：读取**本机客户端的登录态文件**（Trae 的 `storage.json` 只读解密、WorkBuddy 的本地日志扫描），这是它自动拿到 token 的唯一途径；**不修改**这些文件，**不**上传到任何地方。
- **日志**：只记录脱敏片段与积分结果，**不写明文 token**。
- 使用「AI 一键部署」提示词时，请只发给**你信任的本机 Agent**；提示词已要求 AI 不回显完整 token，但部署后建议自己花 10 秒确认 `config.json` 没被提交到仓库（`git status` 应看不到它）。

## 实现原理（贡献者向）

<details><summary>挂钩点 · 数据流 · 接口表 · 目录结构</summary>

**挂钩点（无侵入）**

本项目的「挂钩」不是代码注入，而是**信息采集**，共三处，全部只读：

| 挂钩点 | 读取内容 | 用途 |
| --- | --- | --- |
| Trae `storage.json` 的 `iCubeAuthInfo://icube.cloudide` | AES-128-CBC + SHA-512 派生的加密登录态（"tc" 格式） | 解出 Trae token（约 14 天有效，客户端自动刷新） |
| Trae `storage.json` 的**键名** `iCubeAuthInfo://icube-dc:<id>` | aha 设备 ID | 作为 `x-device-id`，缺失会导致 9074 |
| WorkBuddy 桌面端日志 | 落盘的 JWT（`%USERPROFILE%\.workbuddy\logs`、`%LOCALAPPDATA%\CodeBuddyExtension\Logs`） | 取有效期最长的 token（约 55 天） |

**token 选取策略（两端都是「多来源 + 挑最优」）**

共同规则：**按 JWT 的 `exp` 取有效期最长者**。来源之间的「优先级」只在两个候选 `exp` 相同时用作决胜，不存在"某个来源永远压过另一个"。

- **Trae**（`lib/trae.js` 的 `resolveTokenInfo`）：客户端登录态（≈13.8 天，客户端自动刷新）/ `config.trae.manualToken` / `trae-token.json` 缓存 三者中取 `exp` 最大者；`exp` 相同时 `manualToken` > 客户端登录态 > 缓存文件。
- **WorkBuddy**（`lib/workbuddy.js` 的 `resolveCredentials`）：`config.workbuddy.accessToken` 与本机客户端日志采集（`lib/token-sources.js`）合并后取 `exp` 最大者；两者都拿不到有效 token 时，才由 `capture-workbuddy-token.js` 走浏览器兜底（内部以 `--force` 强制重抓）。

> 实测对比：客户端登录态 token ≈ **13.8 天**，远长于网页会话 token 的 **~8 小时**——这就是「从客户端读」能撑起无人值守的原因。

**数据流**

```
计划任务（Hidden）→ wscript.exe //B //Nologo run-hidden.vbs →（隐藏窗口）checkin.js
  ├─ 抢 state/run.lock.json 单实例锁（抢不到 → 直接退出；取代任务层 IgnoreNew）
  ├─ 启动看门狗（默认 20 分钟；取代任务层 ExecutionTimeLimit）
  ├─ 读 state/daily-status.json：当天已完成的端直接跳过（两端都完成则整轮退出）
  ├─ lib/token-sources.js 采集 token（多来源，挑有效期最长）
  ├─ lib/workbuddy.js     → POST /v2/billing/meter/daily-checkin
  └─ lib/trae.js          → claim 接口（配 x-device-id = aha ID）
        ↑ 失败 9074 时退避重试（最多 10 次 / 8 分钟）
  → 任一端成功即写 state/daily-status.json（后续时段自动跳过该端）
  → 失败若是断网：等网络恢复（默认最多 10 分钟）后重试一轮（lib/net.js）★
  → 收尾按档位发系统通知（lib/notify.js → notify-toast.ps1）★
  → 释放锁 → 写 checkin.log
```

**无窗口是怎么做到的**：`WshShell.Run(cmd, 0, False)` 的第二参 `0` 即 `SW_HIDE`，第三参 `False` 表示不等子进程退出；配合 `wscript.exe`（GUI 子系统，本身不创建控制台）即可实现「拉起来就没影」。这也是任务里执行的是 `wscript.exe` 而不是 `node.exe` 的原因。

**接口表**

| 用途 | 接口 | 鉴权 |
| --- | --- | --- |
| WorkBuddy 状态查询 | `POST https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status` | `Authorization: Bearer <token>` + `X-User-Id: <uid>` |
| WorkBuddy 执行签到 | `POST https://www.workbuddy.cn/v2/billing/meter/daily-checkin` | 同上 |
| Trae 签到 | `api.trae.cn` claim 接口 | `Authorization: Cloud-IDE-JWT <token>`、`x-device-id`、`X-User-Region`（默认 `CN`）、`x-app-version`、`x-device-type`、`x-device-brand`、`x-os-version`；请求体 `{"req_source": 1}`（**不能发空 body**） |

**幂等判定**：`daily-checkin` 返回 `code=0` 为成功；`code=10001`（今日已签到）**一律视为成功**。注意网关会把 `10001` 包成 **HTTP 400**，所以必须按**响应体的 `code`** 判断，不能看 HTTP 状态码。

**目录结构**

```text
auto-checkin/
├── checkin.js                  # 主程序：读当日状态 → 跳过已完成端 → 依次跑 WorkBuddy、Trae → 写状态与日志
├── notify-toast.ps1            # 发送 Windows 系统通知（零依赖，WinRT；被 lib/notify.js 调用）
├── run-hidden.vbs              # 隐藏窗口启动器（计划任务真正执行的就是它）
├── capture-trae-token.js       # Playwright 抓取 Trae 网页会话 token（兜底）
├── capture-workbuddy-token.js  # Playwright 抓取/刷新 WorkBuddy token（最后手段，默认无头）
├── config.json                 # 你的配置（含 token，⚠️ 不要分享）
├── config.example.json         # 配置模板
├── lib/
│   ├── trae.js                 # Trae：读客户端登录态 + 解密 + 调签到接口
│   ├── workbuddy.js            # WorkBuddy：多来源取 token + 调官方签到接口
│   ├── net.js                  # 网络判定与等待：断网时等联网再重试
│   ├── notify.js               # 通知决策：成功汇总 / 失败与漏签告警（去重、夜间静默）
│   ├── daily-state.js          # 当日签到状态：决定后续时段是否跳过
│   └── token-sources.js        # token 采集器：扫描本机日志取最新 JWT
├── register-task.ps1           # 注册 Windows 计划任务（把任务挂到 run-hidden.vbs）
├── state/
│   ├── daily-status.json       # 当日签到状态（运行时产物，已 gitignore）
│   └── run.lock.json           # 单实例锁（运行时产物，正常结束时自动删除）
├── docs/architecture.md        # 架构说明：运行链路、设计取舍、自查判据
├── CONTRIBUTING.md             # 贡献指南：环境、约定、改动验证清单
├── CHANGELOG.md                # 变更日志
├── .github/ISSUE_TEMPLATE/     # Bug 报告模板
└── checkin.log                 # 运行日志（超过 1 MiB 自动轮转为 checkin.log.N）
```

</details>

详见 [`docs/architecture.md`](docs/architecture.md)（运行链路、模块职责、关键设计取舍、自查判据与已知限制）

## 贡献与反馈

[CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [Issue 模板](.github/ISSUE_TEMPLATE/bug_report.md)

改签到接口或计费口径前，请先看 `lib/trae.js`、`lib/workbuddy.js`、`lib/token-sources.js` 里的注释——它们记录了对接官方实现时的实测结论（含两个最容易踩的坑：`x-device-id` 必须用 aha 设备 ID、`10001` 被网关包成 HTTP 400）。

## 许可证

未指定 License —— 仓库当前没有 `LICENSE` 文件，作者保留所有权利；如需使用请自行评估。
