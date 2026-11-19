@echo off
chcp 65001 > nul
title 一键创建桌面快捷方式

:: 获取当前目录路径并存入环境变量，规避特殊字符问题
set "WORK_DIR=%~dp0"
set "VBS_PATH=%~dp0NewRock Workbench.vbs"
set "ICO_PATH=%~dp0public\vbs.ico"

echo ===================================================
echo 正在检查核心文件...

if not exist "%VBS_PATH%" (
    echo [错误] 找不到主程序文件：NewRock Workbench.vbs
    pause
    exit /b
)
if not exist "%ICO_PATH%" (
    echo [错误] 找不到图标文件：public\vbs.ico
    pause
    exit /b
)

echo 正在为您生成桌面快捷方式...

:: 调用 PowerShell，全部通过环境变量取值，绝对安全
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $desktop = [Environment]::GetFolderPath('Desktop'); $s = $ws.CreateShortcut($desktop + '\NewRock AI Workbench.lnk'); $s.TargetPath = $env:VBS_PATH; $s.WorkingDirectory = $env:WORK_DIR; $s.IconLocation = $env:ICO_PATH + ',0'; $s.Save()"

echo ✅ 快捷方式已成功创建到桌面！
echo ===================================================
timeout /t 3 >nul