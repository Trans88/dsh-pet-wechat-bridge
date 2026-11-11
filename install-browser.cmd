@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.13 或更新版本。
  pause
  exit /b 1
)
node dependency-check.mjs >nul 2>nul
if errorlevel 1 (
  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
  if errorlevel 1 exit /b 1
)
call npm run browser:install
if errorlevel 1 (
  echo 浏览器下载未完成，请检查网络后重试；也可使用已安装的 Edge 或 Chrome。
) else (
  echo Chromium 已安装。请启动宠物，在探索页选择 Chromium 或自动选择。
)
pause
