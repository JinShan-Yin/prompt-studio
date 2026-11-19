@echo off
chcp 65001 > nul
title NewRock AI Workbench - Service
cd /d "%~dp0"
node server.js