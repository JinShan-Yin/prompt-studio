@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 安装/卸载 NewRock 开机自启

set TASK_NAME=NewRockAIWorkbench
set START_BAT=%~dp0start-newrock.bat

net session >nul 2>&1
if errorlevel 1 (
  echo [错误] 需要管理员权限。请右键本文件，选择"以管理员身份运行"。
  pause
  exit /b 1
)

if /i "%~1"=="uninstall" goto UNINSTALL

:INSTALL
echo ============================================
echo  安装 NewRock 开机自启（任务计划程序）
echo ============================================
schtasks /query /tn "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
  echo [提示] 已存在同名任务，先删除旧任务 ...
  schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
)
schtasks /create /tn "%TASK_NAME%" /tr "\"%START_BAT%\"" /sc onlogon /rl highest /f
if errorlevel 1 (
  echo [错误] 创建任务失败。
  pause
  exit /b 1
)
echo.
echo [成功] 已安装。下次登录 Windows 时自动启动 NewRock AI Workbench。
echo         也可手动运行：schtasks /run /tn "%TASK_NAME%"
echo         卸载自启：  右键以管理员运行本文件，然后执行 install-autostart-windows.bat uninstall
pause
exit /b 0

:UNINSTALL
echo 正在卸载任务 "%TASK_NAME%" ...
schtasks /delete /tn "%TASK_NAME%" /f
if errorlevel 1 ( echo [提示] 任务不存在或删除失败。 ) else ( echo [成功] 已取消开机自启。 )
taskkill /f /im node.exe >nul 2>&1
echo [提示] 已尝试结束所有 node 进程（如有其它 node 服务请自行恢复）。
pause
exit /b 0
