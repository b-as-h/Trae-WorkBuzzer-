# 注册「每日自动签到」计划任务
# 以当前用户运行即可（无需管理员：注册的是"仅在用户登录时运行"的任务）。
#
# 会注册两个任务：
#   1) DailyCheckin      —— 每天 5 个触发点（00:01 / 09:00 / 13:00 / 17:00 / 21:00）；
#                           当天任一端签到成功后即写入 state/daily-status.json，
#                           后续时段自动跳过该端，两端都完成则整轮直接退出。
#   2) DailyCheckinOnNet —— 系统事件「网络已连接」（NetworkProfile 事件 10000）触发，
#                           静默模式（--quiet-skip）补跑当天尚未完成的一端。
#                           这是断网兜底的最后一层：错过时段 / 断网等待超时后，一联网就补签。
#
# 无感运行说明：
#   计划任务若直接执行 node.exe（控制台程序），在"仅登录时运行"模式下会弹出命令提示符窗口。
#   因此这里改为执行 run-hidden.vbs —— 它由 wscript.exe（GUI 子系统）承载，
#   内部用 WshShell.Run(cmd, 0, False) 以"隐藏窗口 + 不等待"启动 node，全程无可见窗口。
#
# 注意：本文件必须保存为 UTF-8 with BOM（PowerShell 5.1 读无 BOM 的 UTF-8 脚本会把中文当 ANSI）。
$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TaskName = 'DailyCheckin'
$NetTaskName = 'DailyCheckinOnNet'

$WshHost = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Launcher = Join-Path $ProjectDir 'run-hidden.vbs'
$UseHidden = (Test-Path $WshHost) -and (Test-Path $Launcher)

if ($UseHidden) {
    $action = New-ScheduledTaskAction -Execute $WshHost `
        -Argument ('//B //Nologo "{0}"' -f $Launcher) `
        -WorkingDirectory $ProjectDir
    $netAction = New-ScheduledTaskAction -Execute $WshHost `
        -Argument ('//B //Nologo "{0}" --quiet-skip' -f $Launcher) `
        -WorkingDirectory $ProjectDir
    $ActionDesc = "$WshHost //B //Nologo $Launcher（隐藏窗口，不弹命令提示符）"
} else {
    # 退化路径：没有 wscript 或启动器时直接跑 node（会短暂弹出控制台窗口）
    # 托管 Node 的版本目录在运行时发现，避免硬编码版本号（升级后主路径会失效）
    $ManagedNode = $null
    $NodeVersions = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path $NodeVersions) {
        $ManagedNode = Get-ChildItem $NodeVersions -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'node.exe' } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
    }
    if (-not $ManagedNode) {
        $SystemNode = Join-Path $env:ProgramFiles 'node\node.exe'
        if (Test-Path $SystemNode) { $ManagedNode = $SystemNode }
    }
    if ($ManagedNode) { $NodeExe = $ManagedNode } else { $NodeExe = 'node' }
    $CheckinJs = Join-Path $ProjectDir 'checkin.js'
    $action = New-ScheduledTaskAction -Execute $NodeExe `
        -Argument ('"{0}"' -f $CheckinJs) `
        -WorkingDirectory $ProjectDir
    $netAction = New-ScheduledTaskAction -Execute $NodeExe `
        -Argument ('"{0}" --quiet-skip' -f $CheckinJs) `
        -WorkingDirectory $ProjectDir
    $ActionDesc = "$NodeExe checkin.js（⚠️ 未找到 run-hidden.vbs，会弹出命令提示符窗口）"
}

# 每天触发 5 次，覆盖可能开机的时段；错过某次由 StartWhenAvailable 在下次开机时补跑。
# 注：当天任一端签到成功后即写入 state/daily-status.json，后续时段自动跳过该端，
#     两端都完成则整轮直接退出 —— 所以 5 次触发不会重复走一遍签到流程。
# 0:01 这一档的用意：跨天后尽早签完；若那时电脑在睡眠/关机，醒来后由 StartWhenAvailable 补跑，
# 并且不设 WakeToRun（不把电脑从睡眠中叫醒）。
$TriggerTimes = @('00:01', '09:00', '13:00', '17:00', '21:00')

# 若已存在则先注销再重建，保证为最新配置
foreach ($name in @($TaskName, $NetTaskName)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
}

$triggers = @()
foreach ($tm in $TriggerTimes) { $triggers += New-ScheduledTaskTrigger -Daily -At $tm }

$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

# 当前用户、登录后才运行（便于读取本机客户端登录态）
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal | Out-Null

# ── 联网补签任务（断网兜底） ────────────────────────────────────────────────
# 事件订阅：Microsoft-Windows-NetworkProfile/Operational 的 10000（网络已连接）。
# 它在「系统确认能上网」时触发；Delay PT15S 给 DHCP/DNS 一点就绪时间。
$NetSubscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[(EventID=10000)]]</Select></Query></QueryList>'
$netTaskOk = $false
$netTaskNote = ''

$logAvailable = $true
try {
    Get-WinEvent -ListLog 'Microsoft-Windows-NetworkProfile/Operational' -ErrorAction Stop | Out-Null
} catch {
    $logAvailable = $false
    $netTaskNote = '本机没有 Microsoft-Windows-NetworkProfile/Operational 日志，跳过联网补签任务'
}

if ($logAvailable) {
    try {
        $eventTrigger = New-CimInstance -CimClass (Get-CimClass -Namespace root/Microsoft/Windows/TaskScheduler -ClassName MSFT_TaskEventTrigger) -ClientOnly
        $eventTrigger.Enabled = $true
        $eventTrigger.Subscription = $NetSubscription
        $eventTrigger.Delay = 'PT15S'
        Register-ScheduledTask -TaskName $NetTaskName -Action $netAction -Trigger $eventTrigger -Settings $settings -Principal $principal | Out-Null
        $netTaskOk = $true
    } catch {
        # 回退路径：CIM 触发器注册失败（个别系统对混合触发器挑剔）时改用任务 XML
        Write-Warning "事件触发器注册失败，改用 XML 方式重试：$($_.Exception.Message)"
        try {
            $userId = "$env:USERDOMAIN\$env:USERNAME"
            $xmlCommand = $netAction.Execute
            $xmlArgs = $netAction.Arguments
            $xmlDir = $netAction.WorkingDirectory
            $esc = { param($s) ([string]$s).Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;') }
            $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>网络恢复后补签（断网兜底）</Description>
  </RegistrationInfo>
  <Triggers>
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>$(& $esc $NetSubscription)</Subscription>
      <Delay>PT15S</Delay>
    </EventTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(& $esc $userId)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc $xmlCommand)</Command>
      <Arguments>$(& $esc $xmlArgs)</Arguments>
      <WorkingDirectory>$(& $esc $xmlDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
            Register-ScheduledTask -TaskName $NetTaskName -Xml $taskXml | Out-Null
            $netTaskOk = $true
        } catch {
            $netTaskNote = "联网补签任务注册失败（不影响到点签到）：$($_.Exception.Message)"
        }
    }
}

# ── 通知来源标识 ────────────────────────────────────────────────────────────
# 让 Windows 通知里显示「自动签到（Trae / WorkBuddy）」而不是「Windows PowerShell」。
# 注册失败不影响签到：notify-toast.ps1 会退回使用 PowerShell 自己的 AUMID。
$AppId = 'AutoCheckin.Daily'
try {
    $appKey = "HKCU:\SOFTWARE\Classes\AppUserModelId\$AppId"
    if (-not (Test-Path $appKey)) { New-Item -Path $appKey -Force | Out-Null }
    New-ItemProperty -Path $appKey -Name 'DisplayName' -Value '自动签到（Trae / WorkBuddy）' -PropertyType String -Force | Out-Null
} catch {
    Write-Warning "通知来源标识注册失败（通知会显示为 Windows PowerShell）：$($_.Exception.Message)"
}

Write-Host "已注册计划任务 '$TaskName'：每天 $($TriggerTimes -join ' / ') 共 $($TriggerTimes.Count) 次"
Write-Host "执行命令：$ActionDesc"
if ($netTaskOk) {
    Write-Host "已注册计划任务 '$NetTaskName'：网络恢复（事件 10000）后补签，静默模式 --quiet-skip"
} elseif ($netTaskNote) {
    Write-Warning $netTaskNote
}
Write-Host "查看：Get-ScheduledTask -TaskName $TaskName ｜ Get-ScheduledTask -TaskName $NetTaskName ｜ 手动试跑：Start-ScheduledTask -TaskName $TaskName"
Write-Host "日志：$ProjectDir\checkin.log（后台无窗口运行，日志是唯一痕迹）"
