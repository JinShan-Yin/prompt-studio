@echo off
setlocal
cd /d "%~dp0.."
set NODE_EXE=node

if not exist "logs" mkdir logs

REM Rotate service.log before starting node (Windows locks the open file)
if exist "logs\service.log" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0rotate-logs.ps1" >nul 2>&1

if not exist "node_modules" (
  call npm install >> "logs\service.log" 2>&1
)

REM Run the server in the background; all output goes to the log file
"%NODE_EXE%" server.js >> "logs\service.log" 2>&1