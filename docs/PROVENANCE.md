# 来源说明

本仓库是 [xinshang777/auto-checkin](https://github.com/xinshang777/auto-checkin) 的衍生作品。

## 来自上游的部分

- 签到主流程 `checkin.js` 与各平台模块 `lib/trae.js` / `lib/workbuddy.js`
- 计划任务设计与 `register-task.ps1` / `run-hidden.vbs` / `notify-toast.ps1`
- 当日状态幂等机制 `lib/daily-state.js`、断网等待 `lib/net.js`、通知编排 `lib/notify.js`
- 架构文档 `docs/architecture.md` 的初版

## 本仓库新增或重写的部分

- `wb-auth.js` —— WorkBuddy 官方插件 OAuth 授权流（上游的本机取 token 方案在当前
  WorkBuddy 版本上已完全失效，详见该文件头部说明）
- `server.js` + `ui/` —— 本地 Web 面板
- `status.js` / `status.cmd` —— 命令行状态查看
- `ui.cmd` / `run-panel.vbs` / `probe.ps1` —— 面板启动链路
- `DailyCheckinHourly` 计划任务 —— 未签到时按间隔重试
- 对上游代码的若干缺陷修复，逐条列在 README 的「相对上游的改动」一节

## 已移除的上游文件

以下文件在本仓库中已删除，原因见 README：

| 文件 | 移除原因 |
| --- | --- |
| `capture-workbuddy-token.js` | 依赖「网页端存在明文 JWT」，在当前 WorkBuddy 版本上已失效；功能由 `wb-auth.js` 取代 |
| `capture-trae-token.js` | 一次性兜底工具，实际未用；移除后项目不再依赖 Playwright |
| `lib/token-sources.js` | 仅被上述失效路径使用；本机日志中不存在可采集的明文 JWT |
| `CHANGELOG.md` / `CONTRIBUTING.md` / `.github/` | 记录的是上游历史与协作规范，与本仓库不符 |

## 其他参考

WorkBuddy OAuth 授权流的端点与流程参考了
[cxqc168-wq/Trae-workbuddyAssistant](https://github.com/cxqc168-wq/Trae-workbuddyAssistant)（MIT）
的 Rust 实现，本仓库以零依赖 Node 重新实现。

## 许可状况

**上游 `xinshang777/auto-checkin` 未声明开源许可证**（等同于保留所有权利）。

因此本仓库的 [MIT LICENSE](../LICENSE) 只覆盖本仓库自身新增与修改的部分，**不能也不应该
为上游代码重新授权**。如需再分发，请先与上游作者确认。
