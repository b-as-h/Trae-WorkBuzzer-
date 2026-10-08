@echo off
chcp 65001 >nul
title Trae / WorkBuddy Check-in Panel
cd /d "%~dp0"

set "LOG=%~dp0panel-start.log"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"

rem First-run bootstrap: create config.json from the example if absent.
if not exist "%~dp0config.json" if exist "%~dp0config.example.json" copy /y "%~dp0config.example.json" "%~dp0config.json" >nul

rem Prefer the bundled portable runtime shipped with the installer.
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"

rem Quick check: already serving? Then just open the browser.
%PS% "%~dp0probe.ps1" -Attempts 1 >nul 2>&1
if not errorlevel 1 goto open

rem Cold start. NOTE: never wrap this in cmd's "start" - start parses //B as its own
rem switch and fails, so wscript would never run (that was the original bug).
echo [%TIME%] cold start > "%LOG%"
wscript.exe //B //Nologo "%~dp0run-panel.vbs" >> "%LOG%" 2>&1
echo wscript_exit=%errorlevel% >> "%LOG%"

%PS% "%~dp0probe.ps1" -Attempts 30 >nul 2>&1
if not errorlevel 1 goto open

rem Fallback: run node server directly (may flash a console window once).
echo [%TIME%] fallback: direct node >> "%LOG%"
start "" /min cmd /c ""%NODE%" "%~dp0server.js" >> "%LOG%" 2>&1"
%PS% "%~dp0probe.ps1" -Attempts 20 >nul 2>&1
if not errorlevel 1 goto open

echo.
echo   Panel did not start in time. Diagnostics:
echo.
type "%LOG%"
echo.
pause
exit /b 1

:open
start "" "http://127.0.0.1:8795/"
exit /b 0
