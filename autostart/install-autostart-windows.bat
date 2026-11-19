@echo off
setlocal
title NewRock Autostart Manager

set TASK_NAME=NewRockAIWorkbench
set START_BAT=%~dp0start-newrock.bat
set SILENT_VBS=%~dp0start-newrock-silent.vbs

REM ---- Administrator rights check ----
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Administrator rights required. Right-click this file and choose Run as administrator.
  pause
  exit /b 1
)

REM Command-line compatibility: "uninstall" goes straight to removal
if /i "%~1"=="uninstall" goto UNINSTALL

:MENU
cls
echo ============================================
echo   NewRock Autostart - Please choose
echo ============================================
echo.
echo    [1] Install autostart
echo    [2] Uninstall autostart
echo    [3] Exit
echo.
echo --------------------------------------------
set "CHOICE="
set /p CHOICE=Enter option [1/2/3]:
if "%CHOICE%"=="1" goto INSTALL
if "%CHOICE%"=="2" goto UNINSTALL
if "%CHOICE%"=="3" exit /b 0
echo.
echo [INFO] Invalid option, please try again.
pause
goto MENU

:INSTALL
cls
echo ============================================
echo  Install NewRock autostart (Task Scheduler)
echo ============================================
schtasks /query /tn "%TASK_NAME%" >nul 2>&1
if not errorlevel 1 (
  echo [INFO] Existing task found, removing old one ...
  schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
)
schtasks /create /tn "%TASK_NAME%" /tr "wscript.exe \"%SILENT_VBS%\"" /sc onlogon /rl highest /f
if errorlevel 1 (
  echo [ERROR] Failed to create task.
  pause
  goto MENU
)
echo.
echo [OK] Installed. NewRock will start silently at logon with no console window.
echo      Log file: logs\service.log (inside the project folder)
echo.
pause
goto MENU

:UNINSTALL
cls
echo Removing task NewRockAIWorkbench ...
schtasks /delete /tn "%TASK_NAME%" /f
if errorlevel 1 ( echo [INFO] Task not found or removal failed. ) else ( echo [OK] Autostart removed. )
taskkill /f /im node.exe >nul 2>&1
echo [INFO] Attempted to stop all node processes. If you have other node services, restart them.
echo.
pause
goto MENU
