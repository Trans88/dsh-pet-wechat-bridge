@echo off
chcp 65001 >nul
cd /d "%~dp0"
node dependency-check.mjs >nul 2>nul
if errorlevel 1 (
  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node bridge.mjs login
pause
