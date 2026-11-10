# dsh-pet 微信桥接工程

保留你已经安装的 **PC2005-cloud/dsh-pet**，把微信 Bot 会话中的文字、图片和微信语音交给这只宠物回复。

版本基线：v0.2.0；Node.js ≥ 22.13.0；对接原版 pet v0.4.7。开发与架构说明见 [CONTRIBUTING.md](CONTRIBUTING.md)、[docs/architecture.md](docs/architecture.md)，变更见 [CHANGELOG.md](CHANGELOG.md)。

## 从 Git 源码开始

克隆仓库或解压源码后，在项目目录运行：

```powershell
npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
npm test
npm run check
npm start
```

先启动原有的 `dsh web`，再执行 `check` / `start`。首次运行自动从 `config.example.json` 创建 `config.json`；已有配置不会覆盖。自定义端口或宠物 ID 时修改本机 `config.json`，不要改模板。

Git 源码不含 `node_modules`，第一次需要安装依赖。此前提供的 **2026-11-10 图片语音运行包**则已附带二维码、图片压缩和 SILK 音频编解码依赖，完整解压后无须从 npm 下载，也不需要安装 FFmpeg。微信收发、模型调用和 pet 的在线语音合成仍需联网。dsh 的语音识别运行环境/模型需在 dsh 内另行准备。

这是按公开接口制作的独立实验性桥接程序，不是 dsh-pet 作者或腾讯发布的插件。已有文字版获得用户实机可用反馈；**本次新增的图片、语音功能只进行了本地与模拟接口测试，仍需在你的微信上验证**。遇到不兼容时请保留终端错误提示，不要分享登录凭证。

## 从已能聊天的旧版升级

1. 按 Ctrl+C 停止旧桥接窗口，保持 dsh 运行。
2. 把新 ZIP 完整解压到一个新文件夹，包含 `node_modules`。
3. 在你自己的电脑上，把旧文件夹里的 **`config.json` 和整个 `data` 文件夹**复制到新文件夹。这样保留端口、宠物选择、绑定凭证和消息去重记录。不要上传这些凭证。
4. 只启动新文件夹里的 `start.cmd`。不要同时运行新旧两个窗口。
5. 旧 `config.json` 没有 `replyAudio` 也能运行，默认只对收到的语音消息附加 MP3 回复。

## 图片与语音需要的设置

| 功能 | 操作与前提 |
| --- | --- |
| 发图片让 pet 看 | 在宠物设置中选择支持图片输入的聊天模型，并确保 dsh 的模型配置已勾选 **Image/图片**。DeepSeek 官方当前文档明确支持图片的模型是 `deepseek-flash`；具体模型名以你的服务商为准，不能只给文字模型勾选 Image。 |
| 微信语音转文字 | 优先使用微信消息自带的转写；没有转写时，桥接下载并解码微信 SILK 音频，交给 pet 的 `/voice/hear`。需要在 dsh 的内置插件/插件管理里启用 **语音输入（SenseVoice）**，并按提示准备识别运行环境和模型。可以先用 dsh 网页的麦克风按钮测试是否能转成文字。 |
| pet 用声音回复 | 复用 pet 的 `/voice/speak`，先发文字，再发送 **`pet-reply.mp3` 音频文件**。先确认宠物本地朗读功能可用；这版发送的是 MP3 文件，不是微信原生的按住说话语音条。 |

语音输入插件的官方包名为 `@deepseek-ai/dsh-experimental-voice-input-bundle`，用于在插件列表中识别；不要直接把包名当成未经核对的安装命令。

建议验证顺序：先发一张较小的 JPG；再发 3–5 秒微信语音；最后确认收到的 MP3 能播放。缺少识别服务时会明确提示，不会把未识别的音频内容猜成文字。

目前一次消息处理一张图片或一段语音。图片单文件下载上限 8 MiB；为适配 pet 的 1 MiB 请求体上限，大于 700 KiB 的 JPG/PNG 会在本机缩放并压成 JPEG（会损失部分细节，可裁剪重点区域后发）。GIF/WebP 大于 700 KiB 时需你先转 JPG。请通过微信“图片”入口发送，按“文件”发的附件暂不解析。只发图片会触发自动描述；后续需要重新查看原图细节时，请再次发送图片，pet 的历史上下文不自动重放原始图片。

语音以中文识别为默认提示，支持微信常见 SILK 格式；没有转写文字时，最多处理约 60 秒，分成不超过 20 秒的片段识别，拼接处可能影响识别准确性。MP3 音频文件输入、视频、群聊和给 pet 新增图片生成能力不在本版范围内。

## 能做什么

- 在你自己的微信里，通过扫码绑定的 **ClawBot/Bot 会话**给宠物发文字、图片或微信语音。
- 调用原版宠物的 `/dsh-pet-7340/chat?pet=…&surface=any` 接口，因此使用其人设、聊天模型和宠物聊天记忆；不是另开一个普通 dsh Agent 会话。
- 桥接程序不需要再填 DeepSeek API Key。模型仍由 dsh/pet 配置。
- 只处理扫码账号的私聊。不会自动回复其他好友，不处理群聊、朋友圈、文件附件或视频。本版也不转发宠物自己选择的配图/表情包。
- 不需要公网 IP、域名或端口映射。电脑需保持开机，dsh 和本程序都要运行。

## Windows 首次使用

1. 将整个 ZIP **解压到独立文件夹**，例如 `D:\tools\dsh-pet-wechat-bridge`。不要放进 pet 插件目录，也不要直接在压缩包里运行。
2. 确认已安装 [Node.js](https://nodejs.org/zh-cn/download)，版本至少 22.13；推荐 24 LTS。可在终端执行 `node -v` 检查。
3. 在原来的终端运行 `dsh web` 并保持窗口开启。打开 `http://127.0.0.1:3080/`，先与宠物本地聊一句，确认能回复。如果用 DeepSeek，在宠物聊天模型设置里选择你已经配置的 DeepSeek 模型。
4. 双击解压目录里的 **`start.cmd`**。修正版已附带二维码依赖，会先检查依赖完整性，再检查本地宠物接口。
5. 程序会打开一张二维码图片，用**你自己的手机微信扫一扫**，按手机提示完成绑定。如果手机要求数字验证码，在桥接窗口输入。二维码过期会自动换码，最多三次。
6. 窗口出现「桥接已运行」后，在微信刚绑定的 **ClawBot/Bot 会话**发一句「你好，我叫什么？」测试。回复来自原有宠物。

若二维码图片未自动打开，在解压文件夹的 `data` 目录打开 `login-qr.png`。登录结束后该图片会自动清理。

以后保持 `dsh web` 运行，再双击 `start.cmd` 即可复用本机凭证。按 Ctrl+C 停止桥接。

## 端口不同，或者养了多只宠物

用记事本编辑同目录的 `config.json`：

```json
{
  "dshUrl": "http://127.0.0.1:3080",
  "petId": "",
  "petTimeoutMs": 180000,
  "replyAudio": "voice"
}
```

- `dshUrl`：填你能打开 dsh 网页的本机地址。默认端口 3080；如果实际为 3000，就改成 3000。此程序只接受本机地址。
- `petId`：只有一只宠物时留空，程序自动选择。有多只时会列出 ID，填入你要连接的那只，例如 `"main"`，然后重新运行。ID 不一定等于宠物显示名。
- `petTimeoutMs`：等待宠物回复的时间，默认 180 秒，最高 600 秒。
- `replyAudio`：`"voice"`（默认）仅对语音消息附加 MP3；`"always"` 每次回复都附加 MP3；`"off"` 关闭语音回复，但仍接收图片和语音。改完重启桥接。单段合成上限 500 个 UTF-16 字符，长回复只朗读开头，文字回复会附说明。

双击 `check.cmd` 可只检查本地接口，不登录微信、不发消息、不消耗一次模型调用。

## 终端用法

在解压目录打开终端：

```powershell
node bridge.mjs check
node bridge.mjs start
```

macOS/Linux 也可用上述命令。首次启动未登录时自动生成本地二维码；没有桌面的环境需自行打开 `data/login-qr.png` 扫码。

如果继续使用旧版压缩包，或手动删除过依赖，在本包文件夹的 CMD 中执行以下命令即可重新安装。命令中的源只对这次安装生效：

```bat
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/
```

需要重新扫码：先停止旧桥接窗口，再运行 `relogin.cmd`，或 `node bridge.mjs login`。重新登录会替换本包的绑定凭证并重置本包的消息游标/待处理队列，不更改宠物配置和聊天记忆。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| `node` 不是内部或外部命令 | 安装 Node.js 后重新打开终端/双击脚本。 |
| `npmmirror` 下载返回 502 | 使用包含依赖的修正版并完整解压；也可运行上面的 `npm ci --registry=…` 命令，本次改用 npm 官方源。 |
| 官方源安装也失败 | 使用已附带依赖的完整修正版；确认没有漏解压 `node_modules`。脚本不自动修改系统代理、证书或全局 npm 配置。 |
| 本地检查提示网络连接失败 | 确认 dsh 正在运行，`config.json` 端口与浏览器一致；先访问 `/dsh-pet-7340/config` 看能否返回 JSON。 |
| 本地检查返回 HTTP 404 | 确认原版 dsh-pet 已启用、地址/端口正确；重启 dsh。 |
| 本地检查返回 HTTP 403 | 是该 pet 接口被拒绝。先处理 dsh 的本地访问/鉴权问题；不要用放开所有权限或公网暴露来绕过。设置页的 `/api/permissionPresets/catalog` 403 是另一个接口，不能据此直接判定 pet 接口也被拒绝。 |
| 提示填写 `petId` | 将窗口列出的目标宠物 ID 填入 `config.json`。 |
| 扫码后微信提示不可用或无资格 | 以微信页面提示为准；本程序不能开通或绕过账号限制。 |
| `binded_redirect` / 已绑定其他客户端 | 检查微信端 Bot 的绑定状态，避免同一 Bot 被另一个 OpenClaw/dsh 微信客户端同时轮询，再重新登录。 |
| 微信凭证失效 `-14` | 停止桥接窗口，运行 `relogin.cmd`，重新扫码后再运行 `start.cmd`。 |
| 有微信消息但 pet 无文字回复 | 先确认宠物本地聊天正常、模型可用。查看桥接窗口；单条文字或转写结果不要超过 2000 个字符。群聊、视频和文件附件会忽略。 |
| 看图返回 `bad-request` / `generate-error` | 确认是 dsh-pet v0.4.7 的图片接口，宠物聊天模型支持图片，dsh 模型配置勾选 Image；先试一张小 JPG。 |
| 提示 dsh 未启用语音识别服务 | 在 dsh 内启用语音输入/SenseVoice 并完成模型准备；或者暂时将语音转成文字发送。 |
| 文字有回复，MP3 失败 | 检查 pet 本地朗读是否可用、语音合成网络是否正常；语音合成或微信媒体上传失败时，文字回复会保留并附提示。 |
| 只有动作，没有文字 | pet API 可能只生成了动作，本程序会回复一条说明。 |
| 发送超时，提示未自动重发 | 请求可能已到达微信，为避免重复消息，本程序不盲目重发。检查微信，需要时重新提问。 |
| 程序意外关闭后某条消息没回复 | 生成/发送中的结果无法确认时，本包重启后会跳过该条并打印提示。其他已持久化的待处理消息会继续；需要时重新提问。 |

## 数据与范围

- `data/account.json` 保存 Bot token，属于登录凭证。`data/state.json` 可能暂存待处理消息、媒体下载引用/密钥和回复上下文。不要把 `data` 文件夹发给别人或上传 Git。
- 二维码由本地依赖生成，不提交给第三方在线二维码服务。
- 文字/图片会经微信、你电脑上的 pet 及其配置的模型服务处理；语音会使用微信自带转写或 dsh 配置的识别器，合成回复使用 pet 配置的合成服务。宠物聊天历史仍由 pet 保存。本程序在发送完成后清理自己的待处理正文，并保留最近 5000 条消息 ID 用于去重。媒体字节在内存处理；宠物自身可能保存图片附件和语音缓存。
- pet 本地接口不应暴露到公网。本包不会开监听端口，不会修改 dsh 权限和插件兼容性豁免。
- 超长回复只转发前约 6000 个 Unicode 字符，末尾附说明；完整宠物回复仍可在本地聊天记录中查看。
- 本包不负责把 pet 的随机碎碎念主动推到微信，也不提供自主上网、QQ、朋友圈或定时任务。

## 验证与源码依据

已通过 33 项本地/模拟测试，运行 `npm test` 可复现。覆盖 HTTP/业务错误、消息 ID 精度、扫码请求头、凭证目的地址、私聊账号过滤、消息去重、游标与收件箱持久化、失败不重复发送、多宠物选择、`surface=any` 和本地 HTTP 模拟整条文字链路。测试不会连接真实微信或发送真实消息。

媒体测试还覆盖 CDN 地址限制、两种 AES 密钥编码、图片解密/压缩/请求体大小、真实 SILK 编解码、语音分段 WAV 格式、识别服务缺失、MP3 业务错误、媒体加密上传、文字先发送及重启时不重复发送文字。

接口核对日期：2026-11-10。

- [PC2005-cloud/dsh-pet v0.4.7 OpenAPI](https://github.com/PC2005-cloud/dsh-pet/blob/v0.4.7/openapi.yaml)
- [Tencent/openclaw-weixin 协议说明](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)
- [腾讯客户端 API 实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts)，核对时文件 SHA `9b64d238e97abc06ace18ceb9bcd0b97188690e6`
- [腾讯包版本](https://github.com/Tencent/openclaw-weixin/blob/main/package.json)，核对时为 `3.0.0-beta-0`
- [DeepSeek 图片输入文档](https://api-docs.deepseek.com/guides/vision/)
- [dsh 模型图片能力设置](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md)
- [dsh 语音输入/SenseVoice](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/voice-input.zh.md)

本程序根据上述公开协议独立编写，不包含原版 pet 或 OpenClaw 插件源码。随包附带锁文件固定的 `qrcode@1.5.4`、`silk-wasm@3.7.1`、`jpeg-js@0.4.4` 及传递依赖（JavaScript/WebAssembly），许可证随依赖保留。安装包不含任何真实登录凭证。
