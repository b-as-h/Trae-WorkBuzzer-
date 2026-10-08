# Stop the panel server ONLY if it is running from THIS directory.
# (So uninstalling a test/portable copy never kills the production panel.)
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
try {
  $info = Invoke-RestMethod 'http://127.0.0.1:8795/api/ping' -TimeoutSec 2
  if ($info -and $info.pid) {
    $proc = Get-Process -Id $info.pid -ErrorAction Stop
    if ($proc.Path -and $proc.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)) {
      Stop-Process -Id $info.pid -Force
      Write-Output "stopped panel pid=$($info.pid) ($($proc.Path))"
    } else {
      Write-Output "panel pid=$($info.pid) belongs to $($proc.Path) - left running"
    }
  }
} catch { }
