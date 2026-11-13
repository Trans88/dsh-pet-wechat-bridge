# 桃铃狐专属 Live2D 源文件

v0.15.1，2026-11-13。原有桃铃狐角色参考位于 `web/assets/taolinghu-hd.png`；本目录以该角色外观重新制作可拆分立绘并绑定。原画使用 ImageGen 生成组件，Node 脚本仅做裁切、等比缩放、位置组合与 PSD 编码，没有将官方 Haru 模型换贴图。

本次按确认的静态修正稿 `source/approved-static.png` 调整脸型、刘海与五官位置，并收窄躯干、调整双腿间距。修正稿为外观参考，未直接用作模型纹理；现有组件的刘海轮廓、虹膜和靴型仍有局部差异。组装坐标使用同一画布，各图层保留来源裁切的宽高比，避免 v0.15.0 独立指定宽高引起的拉宽和压扁。

## 内容

| 文件 | 用途 |
| --- | --- |
| `source/` | 生成的参考图、静态修正稿，以及头部、身体和面部 RGBA 组件图集 |
| `source/approved-static.png` | 1024 × 1536 的静态修正参考，仅用于视觉对照，不参与组装和运行 |
| `layers/`、`layers.json` | 33 个原画部件和来源裁切范围 / 放置坐标 |
| `Taolinghu.psd` | 1254 × 1254、RGB、8 位、33 图层的分层原画 |
| `assembled.png` | 中性表情组装预览，非运行时动画素材 |
| `Taolinghu.psd2live` | PSD2Live 原生可编辑模型工程 |
| `Taolinghu.cmo3` | 导出模型工程；尚未在官方 Cubism Editor 单独验收 |
| `../../web/assets/live2d/Taolinghu/` | 真正的 moc3、4096 贴图、physics3、model3、cdi3、7 段 motion3、8 份 exp3 |
| `../../tools/taolinghu/` | 原画组装、参数修改记录、运行资源生成脚本 |

动作表现以正面为主。独立旋转控制双臂、双耳和尾巴，头脸及呼吸使用网格变形；没有肘膝关节、步行、全侧身或独立手指绑定。图集中的同名左右部件命名按角色左右，不能按观看者左右解释。头发和眼睛使用模型物理设置。

## 重建

原画工具依赖与应用运行依赖分开锁定：

```sh
npm ci --prefix tools/taolinghu --ignore-scripts --no-audit --no-fund
node tools/taolinghu/build-art.mjs
```

`layers.json` 记录每层来源裁切范围与最终位置。`test/live2d.test.mjs` 检查来源范围、实际 PNG 尺寸、等比缩放和画布边界；仅有这些检查通过不能替代组装预览及动作姿态的目视验收。

建模工具为 [PSD2Live v3.6.7](https://github.com/tsunehimatoi/psd2live/releases/tag/v3.6.7)，Linux x64 发布包 SHA-256：`ac788290387ca5b373d445f9f879185de3b4102373487b389e3adab0e433b686`。工具本身不随应用分发，也不是运行依赖。第一次生成基础模型时使用：

```sh
PSD2Live --input art/taolinghu-live2d/Taolinghu.psd --output /path/to/base-export --atlas 2048 --mesh-spacing 48 --head-strength 0.5 --body-strength 0.45 --no-see-through --lang en
```

基础模型之后进行了双臂、双耳、尾巴绑定和双臂绘制顺序调整；仅重跑上面命令不会得到最终模型。`tools/taolinghu/rig-edits.json` 和 `arm-refinement.json` 保存了对应的 canvas_rotation、parameter_create、keyform_apply 编辑请求。原点使用 1254 像素画布坐标；正负参数端点和中性关键帧均已保存。最简单的继续方式是在 PSD2Live v3.6.7 打开 `Taolinghu.psd2live`，修改后导出，保留 model3 中的纹理路径。

在基础模型上依次应用 `rig-edits.json`、`arm-refinement.json`、`face-refinement.json`。最后一份记录让下眼线随各自眼睑渐隐，并隐藏与动态嘴唇重叠的固定嘴线；缺少这一步会在闭眼、张嘴时出现残线。

最终工程导出时由工具使用单张 4096 图集；不能把 2048 初始导出和 4096 最终模型的文件混用。将当前原生工程另存为同一导出目录下的 `Taolinghu.psd2live`，再导出模型，执行：

```sh
node tools/taolinghu/build-runtime.mjs /path/to/final-export
node --test test/live2d.test.mjs
```

该脚本复制 moc3 / 贴图 / 物理 / 显示信息 / cmo3 / psd2live，生成互动曲线与表情，并补上 EyeBlink 和 LipSync 参数组。若更改文件名，须同步 `pet/live2d-assets.mjs` 的精确白名单。运行时资源没有超过每文件 8 MiB 限制。源码工程不在 HTTP 静态资源白名单中，也不进入桌面安装包。

## 来源与验证边界

原画组件由本任务生成，角色依据仓库已有桃铃狐参考；模型、旋转控制和互动曲线为本任务新制作。生成记录见 `prompts.md`。模型编译器由上述 PSD2Live 发布包提供，工程归属不等同于编译器许可证；本仓库本身仍未指定开源许可证。Cubism Core / Framework 保持原有官方文件和授权说明，见 `web/vendor/live2d/NOTICE.txt`。

已验证 `.moc3` 能由项目实际 Cubism Core 5.1.0 加载，眼睑、嘴巴、呼吸、双臂、双耳、尾巴均驱动真实顶点；所有动作在完整时间区间运行无非有限顶点，并检查抱抱 / 挥手 / 喂食确实改变手臂。编辑器渲染图已检查中性、闭眼张嘴、收拢双臂和挥手姿态。Chromium 与 Windows 打包程序有对应自动验收脚本；在未取得 CI 结果前，不将这些平台脚本视为已通过。
