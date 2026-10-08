@echo off
chcp 65001 >nul
title Trae credential extractor (get-trae-creds)
rem Always run from this script's own folder so `node get-trae-creds.js`
rem works no matter where it was launched from (double-click, cmd, Explorer).
cd /d "%~dp0"

node get-trae-creds.js %*

echo.
pause
