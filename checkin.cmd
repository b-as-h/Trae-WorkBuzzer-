@echo off
chcp 65001 >nul
title Trae / WorkBuddy Auto Check-in
cd /d "%~dp0"
if not exist "%~dp0config.json" if exist "%~dp0config.example.json" copy /y "%~dp0config.example.json" "%~dp0config.json" >nul
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
"%NODE%" checkin.js %*
echo.
pause
