@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.13 或更新版本，再重新打开此文件。
  echo https://nodejs.org/zh-cn/download
  pause
  exit /b 1
)
node dependency-check.mjs >nul 2>nul
if errorlevel 1 (
  echo 二维码依赖缺失或不完整，正在通过 npm 官方源重新安装……
  call npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
  if errorlevel 1 (
    echo 依赖安装失败。请重新下载包含 node_modules 的完整修正版，解压后运行。
    pause
    exit /b 1
  )
)
node app.mjs start
pause
