@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24，再重新打开。
  pause
  exit /b 1
)
node dependency-check.mjs >nul 2>nul
if errorlevel 1 goto install
if not exist "node_modules\electron\package.json" goto install
goto launch
:install
call npm ci --include=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
if errorlevel 1 (
  echo 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)
:launch
call npm run desktop
if errorlevel 1 pause
