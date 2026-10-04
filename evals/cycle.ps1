# One iteration on Windows: rebuild the changed packages, restart the local eval API, wait for it, run a suite.
#   powershell -File evals/cycle.ps1 [-Suite dev] [-Only F]
# Needs Postgres (:5432) and Redis (:6379) running (see evals/serve-local.mjs).
param([string]$Suite = 'dev', [string]$Only = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Stop the previous eval API (the launcher and everything under it).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'serve-local\.mjs' } |
  ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }
Start-Sleep -Seconds 2

& pnpm --filter '@ai-concierge/domain' --filter '@ai-concierge/ai' build
if ($LASTEXITCODE -ne 0) { throw 'build failed' }

$log = Join-Path $env:TEMP 'evalapi.log'
Start-Process -FilePath node -ArgumentList 'evals/serve-local.mjs' -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError (Join-Path $env:TEMP 'evalapi.err') | Out-Null
$up = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  try { if ((Invoke-WebRequest http://127.0.0.1:4100/health -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200) { $up = $true; break } } catch {}
}
if (-not $up) { Get-Content (Join-Path $env:TEMP 'evalapi.err') -Tail 20; throw 'eval API did not start' }

$runArgs = @('evals/run.mjs', '--suite', $Suite)
if ($Only) { $runArgs += @('--only', $Only) }
& node @runArgs
