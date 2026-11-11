# Little Pet · 独立 AI 宠物

自己的宠物、人设和记忆。通过本地网页或微信 Bot 私聊，与同一个性格的小伙伴聊天。

**从 v0.3.0 起，正常运行不再需要 dsh、dsh-pet 或任何 dsh 插件。** 后端直接调用你配置的模型服务，聊天记录和长期记忆保存在本机 SQLite 数据库。仓库沿用原来的 `dsh-pet-wechat-bridge` 地址与 Git 历史，项目已经独立。

## 开始使用

需要 **Node.js ≥ 22.13.0**，建议使用 Node 24。Windows、macOS、Linux 均可运行。

```powershell
git clone https://github.com/Trans88/dsh-pet-wechat-bridge.git
cd dsh-pet-wechat-bridge
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm start
```

浏览器打开 **http://127.0.0.1:3210**。Windows 也可以双击 `start.cmd`，首次缺少依赖时会安装锁文件依赖。

1. 进入「设置」，填写聊天服务 **Base URL、模型名、API Key**。保存后立即生效。
2. 可以修改宠物名字、欢迎语、人设；回到「小窝」开始聊天。
3. 进入「连接」→「连接微信」，复用已有登录；首次使用则扫码。机器人运行期间需要保持电脑与本程序开启。

默认预填 DeepSeek 的 `https://api.deepseek.com` 与 `deepseek-flash`，需你自己的有效 API Key。也可以连接提供 Chat Completions 兼容接口的本机模型，例如其 `http://127.0.0.1:端口/v1` 地址。模型可用性、计费和图片能力以实际服务商为准。

网页没有演示回复：未配置模型时会明确提示。测试不会使用你的真实模型或发送微信消息。

## 当前能力

| 功能 | v0.3.0 的行为 |
| --- | --- |
| 宠物界面 | 本地网页、原创蓝色小猫、待机/眨眼/摸头/打盹动画；动画反馈不消耗模型调用 |
| 人设 | 修改名字、欢迎语和性格，下一次模型调用生效 |
| 聊天 | 直接调用 Chat Completions 兼容服务；每个会话防止并发打乱历史 |
| 记忆 | 自动保存聊天历史；长期事实通过「记忆」页面或 `/remember 内容` 显式保存，支持查看和删除 |
| 图片 | 网页上传、微信图片；直接传图片给视觉模型。最近图片可用于后续追问 |
| 语音输入 | 网页录音转文字；微信优先使用自带转写，否则下载/解码并调用独立 STT 服务 |
| 语音输出 | 网页点击「朗读」播放 MP3；微信可附加 MP3 文件，暂不是微信原生语音条 |
| 微信 | 保留已绑定 Bot 的扫码账号私聊，消息去重、媒体处理和重启恢复 |
| QQ | **尚未实现**；计划对接 QQ 官方接口 |
| 桌面悬浮、主动上网 | **尚未实现**；当前界面运行在浏览器里 |

## 从旧版升级

先停止旧桥接进程。在原工程目录更新源码、安装依赖、启动：

```powershell
git pull --ff-only
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm start
```

- 保留本机整个 `data/`，已有的 `account.json` 与 `state.json` 继续用于微信登录、游标和队列。
- 新配置保存为 **`pet.config.json`**，首次启动自动创建；不覆盖旧的 `config.json`，也不读取 dsh 的模型密钥。
- 新数据库为 `data/pet.sqlite`。**旧 dsh-pet 的人设和聊天记忆不会自动迁移**，请在新设置中填写人设，并把希望保留的重要事实加入记忆。
- 独立应用启动后，在网页连接微信。首次安装后需要填一次模型配置。
- 使用不同目录部署时，先停止原程序，再复制 `pet.config.json` 和整个 `data/`；不要同时运行新旧通道。
- 如需临时回到旧宠物，断开独立应用的微信通道，启动旧 dsh/pet，再运行 `npm run legacy:wechat`。它使用旧 `config.json`。

## 图片与语音配置

### 图片

在设置中选择确实支持图片的聊天模型，并勾选图片输入。勾选不能把文字模型变成视觉模型。

如果主模型不支持图片，可以开启「独立图片模型」，单独配置服务地址、模型和密钥。含图片的对话上下文交由这个模型回答，不会把聊天模型的密钥自动发给另一家服务商。

每条消息支持一张图片，最大 8 MiB。大于 700 KiB 的 PNG/JPEG 会缩放压缩，较大的 GIF/WebP 需要先转 JPG。每个会话保留最近 12 张图片，本次模型上下文最多携带 3 张历史图片和当前图片。较旧图片被清理后，需要重新发送原图。

### 语音

在「设置」→「图片与声音」填写独立服务：

| 设置 | 要求 |
| --- | --- |
| STT | 支持 `POST {baseUrl}/audio/transcriptions`，multipart 文件上传，JSON 返回 `text`；需要服务商的模型名和密钥 |
| TTS | 支持 `POST {baseUrl}/audio/speech`，接收 `model`、`voice`、`input`、`response_format: mp3`，返回 `audio/mpeg` |

这些接口是兼容协议适配，并不表示任意服务商都可直接使用。启用前需要核对服务商的协议、模型和音色。DeepSeek 的聊天配置不会自动提供 STT/TTS。

网页录音最长 60 秒；识别结果先填入输入框，由你确认后发送。微信语音没有自带转写时会解码为 16 kHz WAV，按 20 秒分段调用 STT。TTS 单次朗读前 500 字符。

微信语音回复模式：`voice` 仅对语音输入附加 MP3、`always` 每次附加 MP3、`off` 只发文字。未启用 TTS 时可设为 `off`。文字发送成功后，即使音频生成失败也不会重复发送文字。

## 记忆与数据

- 网页、每个微信绑定账号分别拥有独立历史和长期记忆，不默认认定为同一个人。更换机器人或微信账号会使用新的会话空间。
- 聊天记录最多保留每会话 500 条，模型读取最近最多 24 条；长期记忆最多 100 条，每条 1000 字符。第一版不做自动事实提取或无限上下文。
- 「记忆」中删除一条事实不会删除原聊天中的对应文字。如希望后续聊天不再引用，请同时清空相应会话的聊天记录。
- 清空聊天会删除会话正文、图片与缓存回复；保留去重 ID，防止已处理的微信消息重复生成。
- 网页可查看微信记录和管理其记忆；微信记录页为只读，不会从网页代发微信消息。
- 关闭程序后备份整个 `data/` 和 `pet.config.json`；SQLite 运行中可能有 `-wal` / `-shm` 文件，不要仅复制正在写入的主数据库文件。

`pet.config.json` 包含模型密钥，`data/account.json` 包含微信登录凭证；数据库包含聊天和图片。这些本机数据不提交 Git，不要上传或分享。

可以用环境变量提供密钥，优先于配置文件：`PET_API_KEY`、`PET_VISION_API_KEY`、`PET_STT_API_KEY`、`PET_TTS_API_KEY`。程序不会自动读取 `.env` 文件。网页不会返回已保存的密钥；密码框留空保持原值。更换服务域名且没有填写新密钥时，会清除原服务的文件密钥，环境变量仍需你自行调整。

当前服务只监听 `127.0.0.1`，使用本次启动令牌、Host/Origin 校验保护接口。修改端口可编辑 `pet.config.json` 的 `port` 并重启；不提供公网/局域网部署开关。

## 命令

```powershell
npm start                  # 启动独立网页与宠物核心
npm run check              # 检查本机配置，不调用模型
npm run wechat             # 在独立应用已运行时，单独启动微信通道
npm run login              # 在独立应用已运行时，重新扫码；先停止微信通道
npm run legacy:wechat      # 显式使用旧 dsh-pet 桥接模式
npm test                   # 自动化测试，不连接真实模型和微信
```

网页版「重新扫码」完成后，再点击「连接微信」。二维码若未打开，点击「显示 / 刷新二维码」，或查看终端打开的 `data/login-qr.png`。要求数字验证码时，在启动程序的终端输入。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 没有 API Key 不能聊天 | 进入设置填写；原 dsh 中的模型配置不会自动导入 |
| 模型 401/403 | 检查密钥、余额/权限和服务商地址 |
| 模型 404 | 检查 Base URL 是否需要 `/v1`，以及模型名；不要把 `/chat/completions` 填进 Base URL |
| 模型 429 | 服务限流或配额不足，检查服务商后台 |
| 图片无法理解 | 使用视觉模型，并正确配置图片能力或独立图片模型 |
| 语音失败 | 检查 STT/TTS 是否开启、接口是否兼容、模型和音色是否正确 |
| 微信凭证失效 -14 | 断开微信通道，重新扫码，成功后再连接 |
| 独立宠物尚未启动 | 先启动 `npm start`，再运行微信命令 |
| 3210 端口被占用 | 关闭另一份应用，或修改新配置的 `port` |
| 页面无样式、设置无反应，控制台 app.js/style.css 返回 403 或 MIME 错误 | 更新到 v0.3.1 或以上，停止旧进程后重新 npm start，再按 Ctrl+F5 刷新 |
| 页面授权过期 | 后端重启会更换令牌，刷新网页即可 |
| `node:sqlite` 不存在 | 升级到 Node.js 22.13 或以上；某些 Node 22 版本会打印 SQLite 实验性提示 |
| npm 下载 502 | 使用上述 npm 官方 registry 命令，不修改全局代理配置 |
| 回复发送超时 | 可能已送达，不盲目重发；需要时重新提问 |

## 开发与验证

架构见 [docs/architecture.md](docs/architecture.md)，开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

49 项自动测试覆盖原微信桥接、媒体编解码，以及独立模型请求、图片追问、记忆隔离、消息幂等、配置密钥保护、本地 HTTP 鉴权与语音兼容接口。前端通过 DOM 与真实本地 HTTP 接口的集成测试，但当前测试环境的浏览器无法连接开发服务，尚未完成实际浏览器视觉验收。真实模型回复质量、服务商语音兼容性和真实微信端到端仍需配置账号后验证。

公开协议与参考：

- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek 图片输入](https://api-docs.deepseek.com/guides/vision/)
- [Node.js SQLite](https://nodejs.org/download/release/v22.13.1/docs/api/sqlite.html)
- [Tencent/openclaw-weixin 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)
- [原 pet v0.4.7 OpenAPI，仅用于 legacy 模式](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.7/openapi.yaml)

本项目独立编写，不是腾讯或 DeepSeek 发布的官方宠物程序。原版 pet 源码与素材未复制进项目。第三方依赖的许可证随 npm 包提供；本项目尚未选择对外开源许可证，公开仓库本身不授予额外使用许可。
