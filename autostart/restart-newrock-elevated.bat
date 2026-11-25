@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在请求管理员权限，请在 UAC 窗口点击“是”...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0restart-newrock.ps1' -Verb RunAs"
if errorlevel 1 (
  echo.
  echo 提权失败或被取消。请右键本文件选择“以管理员身份运行”，
  echo 或打开管理员 PowerShell 手动执行：
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-newrock.ps1"
  pause
)
