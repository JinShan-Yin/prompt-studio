# NewRock AI Workbench 重启脚本（V1.63+）
# 用法（管理员）：powershell -NoProfile -ExecutionPolicy Bypass -File D:\prompt-studio\autostart\restart-newrock.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$logDir = Join-Path $root 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$logPath = Join-Path $logDir 'restart-elevated.log'
try { Start-Transcript -Path $logPath -Append | Out-Null } catch { }
$exitCode = 0
try {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  Write-Host ('[info] admin=' + $isAdmin + ' root=' + $root)
  if (-not $isAdmin) {
    Write-Host '[X] 需要管理员权限，请以管理员身份运行 PowerShell 后重试。' -ForegroundColor Red
    $exitCode = 1
  } else {
    $port = 3100
    $envFile = Join-Path $root '.env'
    if (Test-Path $envFile) {
      $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
      if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
    }
    Write-Host ('[1/3] 停止端口 ' + $port + ' 上的旧进程...')
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($listeners) {
      $pids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
      foreach ($processId in $pids) {
        try {
          Stop-Process -Id $processId -Force -ErrorAction Stop
          Write-Host ('      已停止 PID=' + $processId)
        } catch {
          Write-Host ('      Stop-Process 失败：' + $_.Exception.Message + '，尝试 taskkill...') -ForegroundColor Yellow
          & taskkill.exe /PID $processId /F /T 2>&1 | ForEach-Object { Write-Host ('      ' + $_) }
        }
      }
    } else {
      Write-Host '      端口当前无监听进程'
    }
    Start-Sleep -Seconds 2

    Write-Host '[2/3] 启动服务（后台，日志写入 logs\service.log）...'
    $bat = Join-Path $root 'autostart\start-newrock-silent.bat'
    Start-Process -FilePath $bat -WindowStyle Hidden
    Start-Sleep -Seconds 2

    Write-Host '[3/3] 等待健康检查...'
    $ok = $false
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $health = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/api/health') -TimeoutSec 2
        if ($health.status -eq 'ok') {
          Write-Host ('[OK] 服务已启动：version=' + $health.version + ' / mode=' + $health.mode + ' / port=' + $health.port) -ForegroundColor Green
          $ok = $true
          break
        }
      } catch { }
    }
    if (-not $ok) {
      Write-Host '[X] 健康检查未通过，请查看 logs\service.log 与 logs\restart-elevated.log' -ForegroundColor Red
      $exitCode = 1
    } else {
      Write-Host '提示：浏览器 Ctrl+F5 强刷后再打开「系统管理 → 项目只读授权」。'
    }
  }
} catch {
  Write-Host ('[X] 重启失败：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host $_.ScriptStackTrace
  $exitCode = 1
} finally {
  try { Stop-Transcript | Out-Null } catch { }
}
exit $exitCode
