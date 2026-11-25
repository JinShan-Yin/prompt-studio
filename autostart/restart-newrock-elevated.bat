@echo off
cd /d "%~dp0.."
echo Requesting administrator privileges. Please click "Yes" on the UAC prompt...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0restart-newrock.ps1' -Verb RunAs"
if errorlevel 1 (
  echo.
  echo Elevation was cancelled or failed.
  echo Right-click this file and choose "Run as administrator",
  echo or run in an elevated PowerShell:
  echo   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-newrock.ps1"
  pause
)
