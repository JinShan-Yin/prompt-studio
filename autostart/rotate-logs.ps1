# NewRock AI Workbench - rotate logs/service.log before the service starts.
# Windows locks the log file while node is writing, so rotation must run first.
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $root 'logs'
$logFile = Join-Path $logsDir 'service.log'
if (-not (Test-Path -LiteralPath $logFile)) { exit 0 }
$item = Get-Item -LiteralPath $logFile
if ($item.Length -lt 10MB) { exit 0 }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$archive = Join-Path $logsDir ("service-" + $stamp + ".log")
Move-Item -LiteralPath $logFile -Destination $archive -Force
Get-ChildItem -Path $logsDir -Filter 'service-*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 5 |
  Remove-Item -Force
exit 0
