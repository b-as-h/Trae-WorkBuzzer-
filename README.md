# Trae / WorkBuddy 签到助手

> Windows 上为 **Trae CN** 与 **WorkBuddy** 自动领取每日免费积分，并附带一个本地 Web 面板。

![签到面板](docs/images/panel.png)

---

## 这是什么

每天都要在 Trae CN 和 WorkBuddy 上各点一次「签到」才能领到免费积分，忘了就断签。这个工具把这件事变成后台自动完成：

- **零运行时依赖** —— 全部代码只用 Node 内置模块（`crypto` / `fetch` / `http`），**不需要 `npm install`**
- **不碰你的密码** —— 只读本机客户端的登录态，或走官方授权流
- **不伪造设备** —— 没有 MITM 代理、不装根证书、不改注册表、不伪造 `x-device-id`
- **幂等** —— 当天签到成功后，后续所有触发都会静默跳过，不会重复领取

## 功能

| 功能 | 说明 |
| --- | --- |
| 自动签到 | Trae CN + WorkBuddy 每日签到领积分 |
| 本地面板 | 今日状态 / 累计积分 / 定时时段 / 开机自启 / 未签到时重试 / 凭证有效期 / 日志 |
| 四层兜底 | 定时时段 → 断网补签 → 开机补签 → 每小时重试 |
| 系统通知 | 成功每日一条汇总；失败与漏签必定提醒 |

---

## 快速开始

### 环境要求

- Windows 10 / 11
- **Node.js ≥ 18**
- 已安装并登录 **Trae CN 客户端**
- 一个 WorkBuddy 账号

> 没有 `npm install` 这一步 —— 项目零依赖。

### 1. 部署

```powershell
git clone https://github.com/b-as-h/Trae-WorkBuzzer-.git
cd Trae-WorkBuzzer-
Copy-Item config.example.json config.json
node checkin.js        # 先手动跑一次，确认 Trae 端能签到
```

Trae 端的凭证会自动从本机 Trae CN 客户端读取，**无需任何配置**。

### 2. WorkBuddy 授权（一次性）

```powershell
node wb-auth.js login
```

终端会打印一个链接，在浏览器里用你的 WorkBuddy 账号确认授权即可。拿到的是官方 Keycloak JWT（约 28 天有效），之后由 `refreshToken` 自动滚动续期，**不需要再手动操作**。

### 3. 注册计划任务

```powershell
powershell -ExecutionPolicy Bypass -File .\register-task.ps1
```

### 4. 打开面板

双击 `ui.cmd`，或直接访问 <http://127.0.0.1:8795/>

面板只监听 `127.0.0.1`，不对外暴露；接口也不会返回明文凭证。

---

## 计划任务

| 任务名 | 触发 | 作用 | 面板可控 |
| --- | --- | --- | --- |
| `DailyCheckin` | 你设定的时段 | 主定时签到 | 时段可改 |
| `DailyCheckinOnNet` | 网络恢复（事件 10000） | 断网补签 | — |
| `DailyCheckinOnLogon` | 登录后 30 秒 | 开机补签 | ✅ |
| `DailyCheckinHourly` | 每 N 小时 | 兜底重试 | ✅ |

四个任务都带 `StartWhenAvailable`：错过的时段会在下次开机时补跑。

重试任务以 `--quiet-skip` 运行 —— 当天两端都已完成时，`checkin.js` 会在抢锁与写日志之前直接返回，因此它可以全天候常驻：**当日已完成则零日志、零网络请求**。

---

## 目录结构

```
.
├── checkin.js              签到主程序（零依赖）
├── wb-auth.js              WorkBuddy 官方插件授权流（login / refresh / ensure / status）
├── server.js               面板后端（node:http，仅 127.0.0.1:8795）
├── status.js / status.cmd  命令行状态查看（面板的 CLI 版本）
├── ui/
│   └── index.html          面板前端（单文件，原生 JS）
├── ui.cmd                  面板入口：已在运行则直接开浏览器，否则隐藏启动
├── run-panel.vbs           面板隐藏窗口启动器
├── run-hidden.vbs          签到任务隐藏窗口启动器
├── probe.ps1               面板就绪探测（原生 TCP，毫秒级）
├── register-task.ps1       注册 Windows 计划任务
├── notify-toast.ps1        系统通知
├── lib/
│   ├── trae.js             Trae 凭证解密与签到
│   ├── workbuddy.js        WorkBuddy 签到
│   ├── daily-state.js      当日状态（幂等跳过）
│   ├── net.js              断网等待与探测
│   └── notify.js           通知编排
├── assets/checkin.ico      图标
└── docs/
    ├── PROVENANCE.md       来源与许可说明
    ├── architecture.md     架构说明
    └── images/panel.png    面板截图
```

运行时产物（全部已在 `.gitignore` 中排除）：

```
config.json                  凭证（accessToken / refreshToken，等价于密码）
state/daily-status.json      当日签到状态
state/credits-history.json   积分历史
state/panel.json             面板设置
.wb-browser-profile/         WorkBuddy 浏览器登录态
checkin.log / wb-auth.log    日志
```

---

## 面板 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 面板页面 |
| GET | `/api/ping` | 存活探测（轻量，毫秒级） |
| GET | `/api/status` | 汇总状态（签到 / 积分 / 凭证 / 定时 / 自启 / 重试） |
| POST | `/api/checkin` | 立即签到一次 |
| GET | `/api/log` | 日志尾部 |
| POST | `/api/schedule` | 设置每日触发时段 |
| POST | `/api/autostart` | 开机自动补签 开/关 |
| POST | `/api/hourly` | 未签到时按间隔重试 开/关 + 间隔 |
| POST | `/api/wb-login/start` | 发起 WorkBuddy 授权，返回授权链接 |
| GET | `/api/wb-login/poll` | 轮询授权结果 |

---

## 凭证是怎么拿到的

### Trae CN

直接解密客户端 `storage.json` 里的 `iCubeAuthInfo`（`"tc"` 格式：AES-128-CBC + SHA-512 密钥派生 + HMAC 校验）。**全程只读**，不修改客户端任何文件。

token 约 **14 天**过期，由桌面客户端自行续期。

> ⚠️ **不要主动调用续期接口。** 续期会轮换 `refreshToken`，抢跑会导致你在 Trae CN 客户端上被迫重新登录。状态页提示「即将过期」时，打开一次客户端即可。

### WorkBuddy

走**官方插件授权流**（OAuth 设备授权），四个端点：

```
POST /v2/plugin/auth/state?platform=workbuddy   ->  state + authUrl
GET  /v2/plugin/auth/token?state=<state>        ->  accessToken / refreshToken / domain
GET  /v2/plugin/login/account?state=<state>     ->  账号资料（uid）
POST /v2/plugin/auth/token/refresh              ->  X-Refresh-Token 换新令牌
```

签到接口：

```
POST https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status
POST https://www.workbuddy.cn/v2/billing/meter/daily-checkin
Headers: Authorization: Bearer <token> / X-User-Id: <uid> / X-Domain: <domain>
```

**为什么不能用本机登录态？** 实测当前版本三条路全部走不通：

1. `workbuddy-desktop.info` 里的 `accessToken` 是 `$wbEncrypted` 加密对象，解密需要客户端内部构造的 AAD，无法稳定复现
2. 网页端已改用 Keycloak，`localStorage` / cookie 中**不存在**明文 JWT
3. 桌面客户端日志**不记录 token 明文**

所以上游「扫日志找 JWT」与「读明文 info 文件」两条路径在当前版本上必然失败。本仓库改用官方授权流。

---

## 本仓库相对上游的改动

Fork 自 [xinshang777/auto-checkin](https://github.com/xinshang777/auto-checkin)（来源与许可详见 [docs/PROVENANCE.md](docs/PROVENANCE.md)）。

### 修复

以下 5 项均为**当前版本实测复现的硬伤**，不修就跑不起来：

| # | 位置 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | WorkBuddy 凭证链路 | 上游依赖「本机存在明文 JWT」，而三条路全断（见上一节） | 新增 `wb-auth.js`：官方插件 OAuth 授权流 + 自动续期 |
| 2 | `checkin.js` | 签到前的刷新调用的是已失效的抓取脚本 | 改调 `wb-auth.js ensure`，并以实际结果判断成败 |
| 3 | `ui.cmd` | 用 `start /min wscript.exe //B …` 启动：cmd 的 `start` 会把 `//B` 当成自己的开关而报错，**wscript 从未被启动** | 直接调用 `wscript.exe` |
| 4 | `server.js` | 用 `ps(...).includes('ok')` 判断成败：PowerShell 报错后 `; 'ok'` 仍会执行，**永远返回成功**（导致开机自启静默失败） | 改为注册后回读计划任务实际状态 |
| 5 | `server.js` | `-AtLogOn` 不指定 `-User` 时作用于「所有用户」，注册被拒（Access denied） | 显式绑定当前用户 |

### 新增

| 内容 | 说明 |
| --- | --- |
| `wb-auth.js` | WorkBuddy 官方插件 OAuth 授权流 |
| `server.js` + `ui/` | 本地 Web 面板 |
| `status.js` / `status.cmd` | 命令行状态查看 |
| `ui.cmd` / `run-panel.vbs` / `probe.ps1` | 面板启动链路 |
| `DailyCheckinHourly` | 未签到时按间隔重试 |

### 已移除的旧方案

上游的 `capture-workbuddy-token.js` 曾用「浏览器登录一次并抓明文 JWT」的方式取 WorkBuddy 凭证。它在本仓库中**已整体删除**，原因是该思路在当前 WorkBuddy 版本上不成立；删除前它还有 4 个独立缺陷（一并记录，供参考）：

1. 把解不出 JSON 的「伪 JWT」也判为有效 token —— 会抓到腾讯的 `KC_STATE_CHECKER` cookie，**没登录就报成功**，并写入一个用不了的凭证
2. 有头登录模式下每 3 秒 `page.reload()` —— 扫码 / 验证码流程被反复打断，实际上无法完成登录
3. 登录等待窗口只有 5 分钟
4. 强制下载约 150MB 的 Chromium

同时移除的还有：`capture-trae-token.js`（一次性兜底工具，实际未用）、`lib/token-sources.js`（仅被上述失效路径使用）、`CHANGELOG.md` / `CONTRIBUTING.md` / `.github/`（记录的是上游历史与协作规范）。

**移除的直接收益：项目不再依赖 Playwright，Node 版本要求从 ≥20 降到 ≥18，仓库里没有一行死代码。**

---

## 风险与合规

- 自动签到**可能违反平台服务条款**，存在账号被限制或积分被收回的风险，请自行评估。
- 本工具只应管理**你本人合法持有的账号**，且设计为低频（每天一次 + 失败重试）。请勿用于多账号批量、账号池或任何绕过平台风控的用途。
- `config.json` 与 `.wb-browser-profile/` 等价于你的登录密码，**不要提交、不要分享、不要放进云盘**。本仓库的 `.gitignore` 已排除它们。
- 仅供学习交流，作者不对任何账号损失负责。

## 致谢与许可

- 签到核心逻辑与计划任务设计来自 [xinshang777/auto-checkin](https://github.com/xinshang777/auto-checkin)（上游**未声明开源许可证**）。
- WorkBuddy OAuth 授权流参考了 [cxqc168-wq/Trae-workbuddyAssistant](https://github.com/cxqc168-wq/Trae-workbuddyAssistant)（MIT）的 Rust 实现。
- 本项目自身的改动以 MIT 许可发布，详见 [LICENSE](LICENSE)；来源与许可边界见 [docs/PROVENANCE.md](docs/PROVENANCE.md)。
