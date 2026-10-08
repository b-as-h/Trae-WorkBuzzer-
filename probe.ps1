param([int]$Attempts = 30)
# Fast readiness probe: raw TCP connect to the panel port.
# (Invoke-WebRequest costs 2-3s per process just loading its module - far too slow
#  to call in a loop from a launcher.)
$ok = $false
for ($i = 0; $i -lt $Attempts; $i++) {
  $c = $null
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect('127.0.0.1', 8795, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(600) -and $c.Connected) { $ok = $true }
  } catch {
  } finally {
    if ($c) { $c.Close() }
  }
  if ($ok) { break }
  Start-Sleep -Milliseconds 300
}
if ($ok) { exit 0 } else { exit 1 }
