@echo off
chcp 65001 >nul
echo Closing NewRock AI Workbench...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3100 " ^| findstr LISTENING') do (
    taskkill /F /PID %%a
)
timeout /t 2 >nul