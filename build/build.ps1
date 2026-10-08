[CmdletBinding()]
param(
  [string]$NodeExe = "",
  [string]$Version = "",
  [switch]$SkipCompile
)
# Stage the app + bundled Node runtime, then compile the installer with ISCC.
# Output: build\dist\TraeCheckin-Setup-vX.Y.Z.exe
$ErrorActionPreference = 'Stop'
$buildDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $buildDir
$stage = Join-Path $buildDir 'app'
$dist = Join-Path $buildDir 'dist'

# -Encoding UTF8 is mandatory on PS 5.1: without it the Chinese description is
# decoded as ANSI and ConvertFrom-Json fails.
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version }
if (-not $NodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe -or -not (Test-Path $NodeExe)) { throw "node.exe not found (pass -NodeExe)" }
Write-Host "[build] version=$Version  node=$NodeExe"

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Force -Path $dist | Out-Null }
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null

$files = @(
  'checkin.js', 'server.js', 'status.js', 'wb-auth.js', 'get-trae-creds.js',
  'register-task.ps1', 'notify-toast.ps1', 'probe.ps1',
  'stop-panel.ps1', 'uninstall-tasks.ps1',
  'ui.cmd', 'status.cmd', 'checkin.cmd', 'get-trae-creds.cmd',
  'run-hidden.vbs', 'run-panel.vbs',
  'config.example.json', 'package.json', 'LICENSE', 'README.md'
)
$missing = @()
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { $missing += $f; continue }
  Copy-Item $src (Join-Path $stage $f) -Force
}
if ($missing.Count) { throw "missing files: $($missing -join ', ')" }

foreach ($d in @('lib', 'ui', 'assets', 'docs')) {
  $src = Join-Path $root $d
  if (-not (Test-Path $src)) { throw "missing dir: $d" }
  Copy-Item $src $stage -Recurse -Force
}

# Never ship runtime artifacts / credentials.
foreach ($bad in @('config.json', 'state', 'checkin.log', 'wb-auth.log', 'panel-start.log', '.wb-browser-profile')) {
  $p = Join-Path $stage $bad
  if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "[build] excluded runtime artifact: $bad" }
}

Copy-Item $NodeExe (Join-Path $stage 'runtime\node.exe') -Force
$rv = & (Join-Path $stage 'runtime\node.exe') -v
if ($LASTEXITCODE -ne 0 -or -not $rv) { throw "bundled node.exe failed to run" }
Write-Host "[build] bundled runtime: node $rv"

if (-not $SkipCompile) {
  $pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $local = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  # winget installs Inno per-user into LOCALAPPDATA\Programs when not elevated
  $iscc = @(
    (Join-Path $pf86 'Inno Setup 6\ISCC.exe'),
    (Join-Path $pf 'Inno Setup 6\ISCC.exe'),
    (Join-Path $local 'Programs\Inno Setup 6\ISCC.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $iscc) { throw "ISCC.exe not found - install Inno Setup 6 first" }

  $iss = Join-Path $root 'installer\Setup.iss'
  Write-Host "[build] compiling $iss"
  & $iscc "/DAppVersion=$Version" "/DSourceDir=$stage" "/DOutputDir=$dist" $iss
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit $LASTEXITCODE" }

  $setup = Get-ChildItem $dist -Filter 'TraeCheckin-Setup-v*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $setup) { throw "installer not produced" }
  Write-Host "[build] OK: $($setup.FullName)  ($([math]::Round($setup.Length/1MB,1)) MB)"
} else {
  Write-Host "[build] staged only (SkipCompile): $stage"
}
