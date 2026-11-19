@echo off
setlocal
cd /d "%~dp0.."
set NODE_EXE=node
set PORT=3100

if not exist "logs" mkdir logs

if not exist "node_modules" (
  call npm install >> "logs\service.log" 2>&1
)

REM Run the server in the background; all output goes to the log file
"%NODE_EXE%" server.js >> "logs\service.log" 2>&1
