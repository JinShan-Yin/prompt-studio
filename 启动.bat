@echo off
chcp 65001 >nul
title Prompt Studio V3.0
cd /d "%~dp0"
echo ========================================
echo   Prompt Studio V3.0  ^|  纯 Node.js 应用
echo ========================================
echo [1/2] 启动服务: node server.js (端口 3000)
start "" /b cmd /c "timeout /t 2 >nul & start "" " http://127.0.0.1:3000" 2>nul
node server.js
echo.
echo 服务已退出。按任意键关闭窗口...
pause >nul
