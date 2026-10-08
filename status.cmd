@echo off
chcp 65001 >nul
title Trae / WorkBuddy Auto Check-in Status
cd /d "%~dp0"
node status.js
