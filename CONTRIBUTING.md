# 开发说明

Little Pet 是独立 Node.js 应用。默认运行与测试都不需要 dsh；只有显式 legacy 模式调用旧 pet。Node.js ≥ 22.13.0，使用内置 SQLite，不需要编译数据库原生扩展。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
node dependency-check.mjs
npm test
npm run check
npm start
```

## 开发流程

1. 从 `main` 创建功能分支。
2. 保持通道适配与宠物核心分离。聊天、图片、语音都不得要求默认运行的用户安装 dsh。
3. 覆盖会话隔离、失败恢复、敏感配置和消息协议等实质行为；测试仅使用假数据和本机模拟接口。
4. 修改后运行 `npm test`。UI 修改还需检查浏览器操作与窄屏布局；若环境无法访问测试服务，应明确记录未验证部分。
5. 更新 CHANGELOG、使用说明和架构，提交 PR。

CI 在 Windows/Linux 的 Node 22.13.0、24 上安装锁定依赖并运行检查。远端状态以 GitHub Actions 为准。

## 数据

禁止提交 `pet.config.json`、旧 `config.json`、`data/`、`.env*`、`node_modules/`、包含凭证的日志。`pet.config.example.json` 是无密钥模板，实际默认值在 `pet/config.mjs`。变更默认配置时同步模板。

SQLite 使用 WAL，备份前停止程序。数据库操作使用参数绑定。群聊或新渠道不能共享现有私聊的 scope；跨渠道身份绑定必须由主人明确建立。

## 本地网页

前端为 `web/index.html`、`web/style.css`、`web/app.js`，没有打包流程。服务默认地址为 http://127.0.0.1:3210。不要把 Node 进程代理到公网来演示带有真实配置的实例。

聊天和媒体接口可注入 fetcher，方便模拟模型、STT、TTS。演示或测试生成的回复不能被描述为实际模型或微信已经验证成功。

## 兼容性与发布

旧微信账号、状态文件继续使用。新增独立配置，不能覆盖旧配置或静默迁移密钥。`npm run legacy:wechat` 仅保留回退途径；两种微信通道不能同时运行。

发布时同步 package 与锁文件版本。源码包只包含 Git 跟踪文件；运行依赖包需从干净源码安装，并保留许可证，不能夹带本机配置和数据。本项目尚未指定开源许可证。
