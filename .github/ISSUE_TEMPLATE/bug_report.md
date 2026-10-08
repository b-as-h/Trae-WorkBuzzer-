---
name: Bug 报告
about: 签到没跑、跑出错，或行为不符合预期
title: '[Bug] '
labels: bug
---

<!-- 提交前请先脱敏：不要粘贴 config.json 或任何 token。日志本身不含明文 token。 -->

## 现象

<!-- 一句话说清哪里不对，例如「今天 00:01 没有签到记录」「断网恢复后没有自动补签」「没收到系统通知」 -->

## 自查信息（必填）

**1. 计划任务状态**

```text
$ Get-ScheduledTaskInfo -TaskName DailyCheckin | Select-Object LastRunTime, LastTaskResult, NextRunTime

# 粘贴输出
```

**2. 日志片段**

```text
$ Get-Content .\checkin.log -Tail 20 -Encoding UTF8

# 粘贴输出（尤其是「自动签到开始 / 结束」「[网络]」「[跨天保护]」「[通知]」「[看门狗]」「[launcher]」「[跳过]」「[日志轮转]」这些行）
```

**3. 当日状态**

```text
$ Get-Content .\state\daily-status.json -Encoding UTF8

# 粘贴输出
```

## 关键判据自查

- [ ] `LastTaskResult` 是否为 `0`？（是 `3221225786` / `0xC000013A` 表示进程被外部终止，例如关机、注销、手动结束）
- [ ] 日志里**是否出现了新行**？（`wscript.exe` 退出码恒为 0，只看结果码无法证明脚本跑起来了）
- [ ] 日志停在 `===== 自动签到开始 =====` 而没有结束行？
- [ ] 是否手动执行过 `node checkin.js` / `--force`？结果如何？
- [ ] 断网期间是否出现过 `[网络] 检测到断网…` / `[网络] 等待联网超时…`？
- [ ] 通知问题请附上 `[通知]` 相关日志行，并说明系统「专注助手 / 勿扰」是否开启。

## 复现步骤

1.
2.
3.

## 环境

- Windows 版本：
- Node 版本（`node -v`）：
- 涉及平台：<!-- WorkBuddy / Trae / 两者 -->
- 本轮是否伴随关机、注销、休眠唤醒、手动结束进程：

## 期望行为

<!-- 你认为应该发生什么 -->
