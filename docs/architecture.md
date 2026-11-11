# 独立宠物架构

v0.4.0 的默认运行路径没有 dsh 依赖。

## 模块

| 模块 | 职责 |
| --- | --- |
| `app.mjs` | 应用入口、本地 HTTP 服务生命周期、微信子进程启停 |
| `pet/config.mjs` | 独立配置、校验、环境变量密钥、返回网页时脱敏 |
| `pet/core.mjs` | 人设、会话隔离、上下文组装、显式长期记忆、请求去重 |
| `pet/model.mjs` | Chat Completions、multipart STT、MP3 TTS 兼容协议 |
| `pet/store.mjs` | SQLite 历史、图片、记忆与请求结果；事务提交 |
| `pet/server.mjs` | 网页静态资源和带鉴权的本地 API |
| `pet/http-client.mjs` | 微信到本地核心的适配；绑定身份派生会话键 |
| `web/` | 不依赖构建工具或 CDN 的网页、原创 SVG 宠物、设置和记忆管理 |
| `bridge.mjs` | 微信扫码、实例锁、长轮询与消息队列；默认连接独立核心 |
| `lib.mjs` | 微信协议、持久化队列与旧版 pet 客户端 |
| `media.mjs` | 微信媒体解密、图片压缩、SILK 解码、语音上传 |

## 消息流

网页直接调用本地 `/api/chat`。微信消息经 `bridge.mjs` 与 `LocalPet` 转为同一接口的请求，由 `PetCore` 加入本会话的人设、长期记忆和近期历史，再请求模型。成功后用 SQLite 事务写入用户消息、回复与去重记录。生成失败不写入半个对话。

微信桥接的已有收件箱保持原格式。消息 ID 同时传给核心，避免核心成功、桥接未收到响应时重复消耗模型。无法确认已发送的微信消息仍沿用保守策略，不自动重发。

## 会话与记忆

- 网页使用 `web:owner`。
- 微信使用 `wechat:sha256([botId,userId])`，避免账号切换混用记忆。
- `qq:direct:*` 和 `qq:group:*` 仅预留会话命名约束，尚无 QQ 适配器。
- 各会话共享宠物人设，各自保存聊天与长期记忆；没有隐式跨渠道身份合并。
- 同会话同时只能生成一次，第二个请求返回 409。已有微信队列仍串行处理。
- 长期记忆通过页面或 `/remember` 添加；不自动把模型猜测变成事实。
- 每会话保留 500 条消息和 12 张最近图片，模型读取最近 24 条消息及最多 3 张历史图片。

## 配置与密钥

新配置位于 `pet.config.json`，旧 `config.json` 只在 `--legacy` 模式读取。配置先校验再原子写入；保存失败不会替换内存配置。API 返回 `hasKey`，不返回密钥内容。环境变量优先于文件。

聊天、视觉、STT、TTS 的密钥分别配置，不跨服务继承。变更服务 origin 时，不会把原文件密钥静默发给新服务；环境变量由操作者自行维护。

## HTTP 边界

服务只监听 IPv4 loopback。所有请求的 Host 必须匹配当前端口的 `localhost` / `127.0.0.1`。公开 JS、CSS 使用精确文件白名单；含令牌的首页与不含用户数据的 `/api/health` 继续校验 Origin/Fetch Metadata，拒绝外站来源和仅同站请求；Origin 为 null 时须同时明确标记 same-origin。

其他接口一律要求 `Authorization: Bearer <本次启动的 32 字节随机令牌>`，使用常量时间比较。已经持有正确令牌的请求不再被 Origin/Fetch Metadata 二次否决，兼容来源头缺失、null 或被改写的环境。接口不使用 Cookie、URL 查询参数或来源头作为授权凭据；不返回 CORS 允许头，浏览器跨域预检无法通过，普通跨站请求也无法携带正确令牌。网页 fetch 限制为 same-origin 并省略 Cookie。微信子进程从本机 `data/pet-runtime.json` 读取令牌；重启后旧令牌失效。不要在后续改动中开放 CORS 或引入隐式 Cookie 鉴权而不重新评估这一边界。

这一区分遵循显式随机令牌与自定义请求头的鉴权方式，来源校验用于保护未持有令牌的首页加载。参考 [OWASP 的令牌与 AJAX/API 请求头说明](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#transmitting-csrf-tokens-in-synchronized-patterns)。

静态路由只有 `/`、`/app.js`、`/style.css`、`/assets/taolinghu.png`，不能请求任意磁盘文件；静态文件按 Buffer 返回，避免 PNG 经 UTF-8 解码损坏；`/favicon.ico` 返回空的 204。首页内嵌本次启动令牌，仍按私有路由校验来源。响应禁止缓存，CSP 禁止第三方脚本、iframe 和外部连接；用户和模型文字以 textContent 渲染。请求体限制 12 MiB，模型响应、媒体下载均有超时和大小限制。

兼容模型可使用公网 HTTPS 或本机 HTTP；不跟随重定向发送凭证。原微信/CDN 的目的域名校验不变。

## 宠物外观

`pet.appearance` 仅接受 `taolinghu` 和 `blue-cat`，缺省为桃铃狐；读取旧配置不写回文件，不改变已有名字和人设。原图是随项目提供的 8 × 11 动画图集；网页以 192 × 208 单格视窗、百分比偏移与逐帧时长播放，不请求 ChatGPT。帧表和原始文件散列见 `web/assets/README.md`。

状态优先级为思考、休息、摸头、待机。切换状态会取消上一帧定时器，后台标签页、非小窝页面与减少动态效果停止定时播放；页面退出清理定时器。图片加载失败只临时回退 SVG 蓝猫，不改保存的选择。

## 生命周期

应用在成功监听后才写运行令牌。端口冲突不会覆盖已有服务的令牌。退出时取消活动请求、终止微信子进程、关闭 HTTP/数据库并删除运行文件。微信不会在程序启动时自行连接，需网页按钮或显式 CLI 命令。

## 后续

QQ 官方机器人适配、桌面悬浮壳、确认后的跨渠道身份绑定、旧 pet 记忆导入，以及有明确权限范围的工具调用和主动行为。当前默认不执行模型生成的命令或自主上网。
