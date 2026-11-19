@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title NewRock AI Workbench
cd /d "%~dp0.."

REM ============================================================
REM NewRock AI Workbench · Windows 启动脚本
REM
REM 若 node 不在系统 PATH，请把下面这行改成绝对路径，例如：
REM   set NODE_EXE=C:\Program Files\nodejs\node.exe
REM ============================================================
set NODE_EXE=node
set PORT=3100
set LOG_DIR=%~dp0..\logs

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo [1/3] 检查 Node.js ...
"%NODE_EXE%" -v >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 node，请安装 Node.js 或修改 NODE_EXE 路径。
  pause
  exit /b 1
)
for /f "delims=" %%v in ('"%NODE_EXE%" -v') do echo     Node %%v

echo [2/3] 检查端口 %PORT% ...
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [提示] 端口 %PORT% 已被占用，server.js 会自动尝试释放后重启。
)

if not exist "node_modules" (
  echo [提示] 未检测到 node_modules，正在安装依赖 ...
  call npm install
  if errorlevel 1 ( echo [错误] npm install 失败 & pause & exit /b 1 )
)

echo [3/3] 启动服务 ...
start "" http://127.0.0.1:%PORT%
"%NODE_EXE%" server.js
set EXITCODE=%errorlevel%

echo.
echo 服务已退出，退出码 %EXITCODE%。
pause
exit /b %EXITCODE%
