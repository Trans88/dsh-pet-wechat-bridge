# 开发说明

本项目作为独立 Node.js 桥接程序维护，不修改已安装的 dsh-pet。Node.js 至少 22.13.0。

## 环境与运行

```powershell
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
node dependency-check.mjs
npm test
npm run check
npm start
```

`npm run check` 和 `npm start` 首次运行会从 `config.example.json` 创建本机 `config.json`。检查和实际运行要求 dsh/pet 正在本机运行；单元测试和依赖检查不需要 dsh、模型密钥或微信账号。

仓库只提交配置模板。`config.json`、`data/`、`.env*`、`node_modules/` 不进入版本控制。测试中的 `TEST-TOKEN` 和 `TEST-CONTEXT` 是固定假数据。提交问题时提供脱敏错误提示、Node/dsh/pet 版本及复现步骤，不附登录数据目录。

## 日常修改

1. 从 `main` 创建功能分支，例如 `git switch -c feat/image-replies`。
2. 将实现、对应回归测试和文档作为一个可评审的变更。
3. 运行 `npm test`；涉及媒体依赖时也运行 `node dependency-check.mjs`。
4. 在 `CHANGELOG.md` 的 Unreleased 部分记录用户可见变化，再提交 PR。

CI 在 Windows/Linux 的 Node 22.13.0 和 24 上安装锁文件依赖并运行测试。只有推送至 GitHub 后才能确认远端 CI 结果；本地通过不等于四组 CI 都已通过。

## 验证真实链路

自动测试使用模拟接口和本地 HTTP 服务，不能验证微信账号资格、实时协议变化或外部模型质量。修改涉及协议或媒体时，依次验证：文字 → 小 JPG → 短微信语音 → MP3 文件播放。记录使用的 dsh/pet 版本和结果，不将私聊正文写入提交记录。

## 发布与依赖

发布前同步 `package.json`、`package-lock.json` 的版本与更新记录。源码 ZIP 不包含运行依赖；如制作免安装依赖包，只从干净源码安装锁定依赖，再打包，保留依赖许可证，禁止打包本机 `data/` 和 `config.json`。`private: true` 阻止误发布到 npm。

本项目尚未指定对外开源许可证；将仓库改为公开前由维护者选择许可证。公开接口和第三方依赖来源见 README。
