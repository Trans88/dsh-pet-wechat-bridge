# 桃铃狐专属 Live2D 源文件

v0.15.2，2026-11-13。原有桃铃狐角色参考位于 `web/assets/taolinghu-hd.png`；本目录以该角色外观重新制作可拆分立绘并绑定。原画使用 ImageGen 生成组件，Node 脚本仅做裁切、等比缩放、位置组合与 PSD 编码，没有将官方 Haru 模型换贴图。

本次对照原有高清图集的待机形象，收窄脸颊与侧发下沿、缩小虹膜宽度，再通过模型网格增大眼睛开口，使眼型更圆；尾根移到髋部下方遮挡区域，同步尾巴旋转原点。摸头动作完全闭眼后恢复待机；闭眼时隐藏眼白和虹膜、保留睫毛，避免金色细线残留。`source/approved-static.png` 保留为 v0.15.1 的旧参考，本次以 `web/assets/taolinghu-hd.png` 待机形象为准。刘海轮廓、虹膜纹理和靴型仍与原插画存在局部差异。组装坐标使用同一画布，源图裁切保留原始宽高比。

## 内容

| 文件 | 用途 |
| --- | --- |
| `source/` | 生成的参考图、旧静态修正稿，以及头部、身体和面部 RGBA 组件图集 |
| `source/approved-static.png` | 1024 × 1536 的 v0.15.1 旧参考稿，不参与组装和运行 |
| `layers/`、`layers.json` | 33 个原画部件和来源裁切范围 / 放置坐标 |
| `Taolinghu.psd` | 1254 × 1254、RGB、8 位、33 图层的分层原画 |
| `assembled.png` | 源图层组装预览，未包含模型网格眼型调整，不代表最终眼睛姿态 |
| `qa/v0.15.2-comparison.png` | 原生模型渲染与原高清形象的视觉对照 |
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
PSD2Live --input art/taolinghu-live2d/Taolinghu.psd --output /path/to/base-export --atlas 4096 --mesh-spacing 48 --head-strength 0.5 --body-strength 0.45 --no-see-through --lang en
```

基础模型之后进行了双臂、双耳、尾巴绑定和双臂绘制顺序调整；仅重跑上面命令不会得到最终模型。`tools/taolinghu/rig-edits.json` 和 `arm-refinement.json` 保存了对应的 canvas_rotation、parameter_create、keyform_apply 编辑请求。原点使用 1254 像素画布坐标；正负参数端点和中性关键帧均已保存。最简单的继续方式是在 PSD2Live v3.6.7 打开 `Taolinghu.psd2live`，修改后导出，保留 model3 中的纹理路径。

在基础模型上依次应用 `rig-edits.json`、`arm-refinement.json`、`face-refinement.json`、`eye-shape-refinement.json`。`face-refinement.json` 让下眼线、眼白和虹膜随各自眼睑渐隐，保留睫毛的闭合轮廓，并隐藏与动态嘴唇重叠的固定嘴线；缺少这一步会在闭眼、张嘴时出现残线。

`eye-shape-refinement.json` 对所有已有几何关键帧统一调整眼型：眼睛开口沿 Y 轴放大 1.35 倍，虹膜沿 Y 轴放大 1.17 倍。每个请求只能应用一次，重复应用会叠加变形；已保存的最终工程包含这些修改，无须再次应用。该步骤修改模型网格，不改纹理、UV 或新增动画参数；虹膜源图保留较小宽度及等比裁切。`assembled.png` 不包含这一步的眼型，最终姿态见 `qa/v0.15.2-comparison.png`。

基础模型与最终工程统一使用单张 4096 图集；不能混用不同轮次的模型和贴图。将当前原生工程另存为同一导出目录下的 `Taolinghu.psd2live`，再导出模型，执行：

```sh
node tools/taolinghu/build-runtime.mjs /path/to/final-export
node --test test/live2d.test.mjs
```

该脚本复制 moc3 / 贴图 / 物理 / 显示信息 / cmo3 / psd2live，生成互动曲线与表情，并补上 EyeBlink 和 LipSync 参数组。摸头曲线在 0.6–2.4 秒将双眼开合参数保持为 0，结束后恢复 Idle。若更改文件名，须同步 `pet/live2d-assets.mjs` 的精确白名单。运行时资源没有超过每文件 8 MiB 限制。源码工程不在 HTTP 静态资源白名单中，也不进入桌面安装包。

## 来源与验证边界

原画组件由本任务生成，角色依据仓库已有桃铃狐参考；模型、旋转控制和互动曲线为本任务新制作。生成记录见 `prompts.md`。模型编译器由上述 PSD2Live 发布包提供，工程归属不等同于编译器许可证；本仓库本身仍未指定开源许可证。Cubism Core / Framework 保持原有官方文件和授权说明，见 `web/vendor/live2d/NOTICE.txt`。

已用项目实际 Cubism Core 5.1.0 检查眼部显隐及动作曲线，并目视检查原生模型的睁眼、闭眼、单眼眨眼和尾巴两端极限姿态；视觉对照见 `qa/v0.15.2-comparison.png`。最终本地测试共 274 项，268 项通过、6 项跳过、0 项失败。Chromium 与 Windows 打包程序有对应自动验收脚本，最终平台结论以本次 CI 结果为准。

## 紧凑头型修正（待用户审美验收）

基于 v0.15.2 最终工程，依次应用 `no-lowerlid-refinement.json`、`compact-head-refinement.json`，只应用一次；本工程已包含修改。额外的下眼睑墨线在全部开合关键帧均为零透明度。HeadContainer 的 27 个转头/倾斜关键帧以局部底部中心为基点，X 乘 0.98、Y 乘 0.88，使脸和发型更紧凑；旋转绑定耳朵跟随附着点，保留自身形状，因此不是整个含耳轮廓精确缩短 12%。身体、尾根、原画和纹理均不改。源 PSD/assembled.png 保留原始画稿，最终外观以已变形模型为准。

`qa/compact-head-poses.png` 为原生渲染，A 待机、B 全闭眼、C/D 转头、E 单眼眨、F 半闭眼。几何检查未发现新翻转或退化。导出器报告与源 PSD 的位置差异，这是上述有意的模型变形；不能将该提示误称为与原 PSD 逐像素一致。官方 Cubism Editor 和用户 Windows 桌面外观仍未单独验收。

### 眼形与领口补正

`eye-collar-refinement.json` 在紧凑头型版上应用一次：收回鼻侧眼白尖角，两侧眼白/上睫毛对称旋转 5°，虹膜保持竖直并微调遮罩余量。闭眼眼白不做局部缩边，避免极薄网格退化；保留既有闭眼透明度。原有披肩立领和扣饰上移 22 个画布单位，并置于脸/颈图层之前，恢复原素材被盖住的领口。未新增围巾或重绘原画。六姿态见 `qa/eye-collar-poses.png`；最终审美待用户确认。
