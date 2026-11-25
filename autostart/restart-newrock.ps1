# NewRock AI Workbench 重启脚本（V1.63+）
# 用法：右键“使用 PowerShell 运行”，或在【管理员】PowerShell 中执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\prompt-studio\autostart\restart-newrock.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host '[X] 需要管理员权限：请右键以管理员身份运行 PowerShell 后重试。' -ForegroundColor Red
  exit 1
}

$port = 3100
if (Test-Path (Join-Path $root '.env')) {
  $match = Select-String -Path (Join-Path $root '.env') -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
}

Write-Host "[1/3] 停止端口 $port 上的旧进程..."
$listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listeners) {
  $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($processId in $pids) {
    try { Stop-Process -Id $processId -Force -ErrorAction Stop; Write-Host "      已停止 PID=$processId" }
    catch { Write-Host "      停止 PID=$processId 失败：$($_.Exception.Message)" -ForegroundColor Yellow }
  }
} else {
  Write-Host '      端口当前无监听进程'
}
Start-Sleep -Seconds 2

Write-Host '[2/3] 启动服务（后台，日志写入 logs\service.log）...'
Start-Process -FilePath (Join-Path $root 'autostart\start-newrock-silent.bat') -WindowStyle Hidden

Write-Host '[3/3] 等待健康检查...'
$ok = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
    if ($health.status -eq 'ok') {
      Write-Host ("[OK] 服务已启动：version=" + $health.version + " / mode=" + $health.mode + " / port=" + $health.port) -ForegroundColor Green
      $ok = $true
      break
    }
  } catch { }
}
if (-not $ok) {
  Write-Host '[X] 健康检查未通过，请查看 logs\service.log 与 logs\service.err.log' -ForegroundColor Red
  exit 1
}
Write-Host '提示：浏览器 Ctrl+F5 强刷后再打开「系统管理 → 项目只读授权」。'
