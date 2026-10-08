# notify-toast.ps1 —— 发送一条 Windows Toast 通知（零依赖，走 Windows PowerShell 5.1 的 WinRT 接口）
#
# 由 lib/notify.js 以 windowsHide 方式拉起，绝不弹出控制台窗口、不抢焦点、不阻塞签到主流程。
# 载荷是一个 UTF-8 的 JSON 文件（state/.notify.json），字段：
#   title  通知标题
#   body   通知正文
#   mode   silent = 静默横幅（无声音，约 5 秒自动消失，仍留在通知中心）
#          center = 只进通知中心（SuppressPopup，屏幕上一个卡片都不弹）
#          alert  = 横幅 + 提示音（失败 / 漏签风险这类需要用户处理的事）
#   tag    通知标签（同 tag 的通知会相互替换，避免堆一屏）
#
# 本文件必须保存为 UTF-8 with BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本会按 ANSI
# 解析，中文全部变乱码（run-hidden.vbs 的注释里记录过同类坑）。
param(
    [Parameter(Mandatory = $true)][string]$PayloadPath
)

$ErrorActionPreference = 'Stop'

function Write-Err([string]$msg) {
    try { [Console]::Error.WriteLine('[notify-toast] ' + $msg) } catch { }
}

function ConvertTo-XmlText([string]$s) {
    if ($null -eq $s) { return '' }
    return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

if (-not (Test-Path -LiteralPath $PayloadPath)) {
    Write-Err ('payload not found: ' + $PayloadPath)
    exit 2
}

$payload = $null
try {
    $raw = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8
    $payload = $raw | ConvertFrom-Json
} catch {
    Write-Err ('payload parse failed: ' + $_.Exception.Message)
    exit 3
}

$title = [string]$payload.title
$body = [string]$payload.body
$mode = [string]$payload.mode
$tag = [string]$payload.tag
if ([string]::IsNullOrWhiteSpace($title)) { $title = '自动签到' }
if ([string]::IsNullOrWhiteSpace($tag)) { $tag = 'checkin' }
if ($tag.Length -gt 16) { $tag = $tag.Substring(0, 16) }  # WinRT 的 Tag 上限 16 字符

$silent = ($mode -ne 'alert')
$suppressPopup = ($mode -eq 'center')

# 应用标识：优先用 register-task.ps1 注册的自定义 AUMID（通知来源显示「自动签到（Trae / WorkBuddy）」）；
# 没注册成功就退回到 Windows PowerShell 自己的 AUMID —— 它一定存在，只是来源会显示成 PowerShell。
$customAppId = 'AutoCheckin.Daily'
$fallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$appId = $fallbackAppId
try {
    if (Test-Path 'HKCU:\SOFTWARE\Classes\AppUserModelId\AutoCheckin.Daily') { $appId = $customAppId }
} catch { }

$audio = if ($silent) { '<audio silent="true"/>' } else { '<audio src="ms-winsoundevent:Notification.Default"/>' }
$xmlText = '<toast><visual><binding template="ToastGeneric"><text>' + (ConvertTo-XmlText $title) + '</text><text>' +
    (ConvertTo-XmlText $body) + '</text></binding></visual>' + $audio + '</toast>'

try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml($xmlText)
    $toast = New-Object Windows.UI.Notifications.ToastNotification -ArgumentList $xml
    $toast.Tag = $tag
    $toast.Group = 'auto-checkin'
    if ($suppressPopup) { $toast.SuppressPopup = $true }
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
    Write-Err ('show failed: ' + $_.Exception.Message)
    exit 4
}

exit 0
