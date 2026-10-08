# Unregister scheduled tasks ONLY if their action points at THIS directory.
# (On machines with a git-checkout install, tasks point elsewhere and must survive.)
$ErrorActionPreference = 'SilentlyContinue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$names = @('DailyCheckin', 'DailyCheckinOnNet', 'DailyCheckinOnLogon', 'DailyCheckinHourly')
$removed = @()
foreach ($name in $names) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $t) { continue }
  $pointsHere = $false
  foreach ($a in $t.Actions) {
    $arg = [string]$a.Arguments
    $wd = [string]$a.WorkingDirectory
    if (($arg -and $arg.IndexOf($dir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) -or
        ($wd -and $wd.IndexOf($dir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
      $pointsHere = $true
    }
  }
  if ($pointsHere) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    $removed += $name
  }
}
if ($removed.Count) { Write-Output ("unregistered: " + ($removed -join ', ')) }
else { Write-Output "no tasks pointed at $dir - nothing unregistered" }
