@echo off
chcp 65001 >nul
title Prompt Studio V3.0
cd /d "%~dp0"
echo ========================================
echo   Prompt Studio V3.0  ^|  Pure Node.js App
echo ========================================
echo [1/2] Starting server: node server.js (port 3000)
start "" /b cmd /c "timeout /t 2 >nul & start http://127.0.0.1:3000"
node server.js
echo.
echo Server stopped. Press any key to close...
pause >nul
