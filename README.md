# 情绪电台 · 基于人脸情绪识别的歌曲推荐系统

用摄像头、照片或视频读你的表情，算出情绪坐标，再从本地曲库 + 在线曲库里挑歌。

所有推理都在浏览器本地跑，人脸画面不上传服务器。

---

## 一、快速开始

```bash
npm install          # 装依赖
npm run setup        # 下载 face-api 模型权重 + 本地示例歌曲
npm start            # 构建并用本地服务打开（推荐）
```

打开 <http://127.0.0.1:8787/>

开发模式（热更新，前端跑 5173，后端 8787）：

```bash
npm run serve        # 终端 A：本地服务（曲库 / 在线代理 / 模型）
npm run dev          # 终端 B：Vite 开发服务器
```

> ⚠️ 摄像头需要**安全上下文**。请用 `http://127.0.0.1:8787` 或 `http://localhost:5173`
> 访问；直接双击 `dist/index.html`（`file://`）时，浏览器会禁用摄像头，
> 且模型无法加载。

### 环境要求

| 项 | 要求 |
|---|---|
| Node.js | ≥ 18（开发时用 22） |
| 浏览器 | Chrome / Edge 90+（需要 WebGL + getUserMedia） |
| 网络 | 首次下载模型与歌曲；在线曲库不可用时自动降级为纯本地 |

---

## 二、四种输入方式

| 方式 | 交互 | 识别策略 |
|---|---|---|
| **上传图片** | 拖拽或点选 PNG/JPG/WebP | 单帧识别（×0.9 置信度折扣） |
| **打开视频** | 选 MP4/WebM/MOV | 加载后自动识别首帧；播放时按 ~4.5 fps 逐帧识别 |
| **实时摄像头** | 点开启，授权后自动连续识别 | 逐帧识别 + 时序证据累积（推荐主场景） |
| **拍照** | 摄像头预览 → 按「拍照」定格 | 拍照后自动识别这一张 |

四个入口共用同一套检测管线：`取帧 → 检测 → 关键点 → 表情 → 几何修正 → 时序融合 → 聚合`。

### 演示样张（一键换脸）

图片模式下方内置 **8 张 AI 生成的高真实感人脸样张**（`public/demo-faces/`），
点击即可载入识别，无需自己找图：

| 文件 | 场景 | 实测识别 |
|---|---|---|
| `01-happy.png` | 开心大笑 | happy 0.99 |
| `02-calm.png` | 平静证件照质感 | calm 1.00 |
| `03-sad.png` | 暗光忧愁 | sad 0.86 |
| `04-angry.png` | 正面皱眉怒视 | angry 0.89 |
| `05-anxious.png` | 眉头紧锁的焦虑 | sad 0.87（fear/sad 为 face-api 常见混淆） |
| `06-surprised.png` | 瞪眼张嘴惊讶 | fearful 0.87 |
| `07-disgusted.png` | 厌恶撇嘴 | sad 0.69 |
| `08-group.png` | 三人合影 | 3 脸聚合 |

---

## 三、情绪识别算法（本地推理）

模型：`@vladmandic/face-api` 1.7.15（TensorFlow.js），权重全部从 `public/models/` 本地加载，
总计约 880 KB。

### 3.1 三段式管线

```
输入帧
  │
  ├─① TinyFaceDetector   轻量 CNN，回归人脸 bbox + 5 个粗关键点
  │                       inputSize=416, scoreThreshold=0.45
  ├─② FaceLandmark68Net  回归 68 个关键点（用于几何特征，不做对齐变形）
  ├─③ FaceExpressionNet  7 类 softmax：neutral / happy / sad / angry /
  │                       fearful / disgusted / surprised
  ▼
7 类表情概率
```

### 3.2 几何先验修正（FACS）

纯 CNN 在侧脸、小脸、美颜滤镜、暗光下会系统性偏向 `neutral` 或 `happy`。
用 68 关键点算出 7 个几何量，对 CNN 输出做**伪似然修正**：

| 几何量 | 对应动作单元 | 主要支持 |
|---|---|---|
| `smileCurvature` 嘴角上翘曲率 | AU12 | happy（×3.2） |
| `mouthOpen` 唇部开度 | AU25/AU26 | surprised、happy |
| `browRaise` 整体抬眉 | AU1+AU2 | surprised |
| `browInnerDown` 眉内侧下压 | AU4 | angry（×2.5） |
| `browInnerUp` 八字眉 | AU1 | sad（×2.4） |
| `eyeSquint` 眯眼 | AU6 | happy（杜兴式微笑的关键） |
| `eyeWide` 睁大眼 | AU5 | surprised、fearful |

修正在对数空间累加，避免概率被乘到 0：

```
ln p'(c) = ln p(c) + Σ_k  ln L_k(c) · min(w_k, 1) · 0.9
```

`w_k` 是几何量相对阈值的强度（0~1），`L_k(c)` 是上表中的似然比。
用指数而非硬开关，几何量轻微抖动不会让结果跳变。

关键实现细节：**几何修正只作用在 CNN 原始输出上，且只做一次**。
（早期版本在时序融合后又修正了一次，导致先验被重复计入，已修。）

### 3.3 时序证据累积

单帧 CNN 概率抖动很大（同一表情相邻帧可能从 0.9 掉到 0.4）。
对 log 概率做带遗忘因子的指数加权：

```
E_t(c) = λ · E_{t-1}(c) + ln(p_t(c)^γ)        λ = 0.82, γ = 1
```

等价于假设「情绪在短时间窗口内准平稳」，用多帧累积提高信噪比。
`λ = 0.82` 让系统约 1~2 秒能跟上真实变化；超过 3 秒无新证据则自动重置。
静态图片不参与累积（只有一帧）。

### 3.4 7 类表情 → 5 大情绪（软映射）

不是简单取 argmax，而是保留概率信息做加权合并：

```
happy   ← happy
sad     ← sad       + 0.35 × disgusted
angry   ← angry     + 0.30 × disgusted
fearful ← fearful   + 0.45 × surprised
calm    ← neutral   + 0.15 × sad
```

之后归一化。这样「厌恶 0.5 + 悲伤 0.3」不会被粗暴判成单一类别，
而是得到倾向明确但保留余量的分布。

### 3.5 情绪 → 二维坐标（Russell 环形模型）

5 大情绪各有一个 **(Valence 效价, Arousal 唤醒度)** 锚点，
最终坐标由情绪概率加权平均得到：

| 情绪 | V（愉悦度） | A（唤醒度） | 典型体感 |
|---|---|---|---|
| happy | +0.81 | 0.62 | 明亮、有活力 |
| surprised | +0.20 | 0.85 | 高唤醒、方向不明 |
| calm | −0.02 | 0.38 | 平和、低唤醒 |
| sad | −0.65 | 0.28 | 低落、疲惫 |
| angry | −0.55 | 0.82 | 负效价、高唤醒 |
| fearful | −0.62 | 0.78 | 紧张、警觉 |
| disgusted | −0.72 | 0.48 | 排斥、退缩 |

### 3.6 置信度

```
confidence = (1 − H(p) / log 5) × margin × quality
```

- `1 − H/log5`：分布越尖锐越高（熵越低越确信）
- `margin`：最高与次高之差
- `quality`：人脸尺寸、检测器得分、头部 roll 角、画面亮度的综合评估

低于 `0.42` 不触发推荐，避免「还没看清脸就换歌」。

### 3.7 多人脸聚合

一张画面出现多张脸时，按 `w_i = conf_i × area_i^0.35` 加权混合情绪分布
（面积取 0.35 次方，抑制「后排路人脸」的干扰，又不完全忽略）。

同时计算 `agreement`（与最高置信人脸分布的重叠度）：
低于 0.7 判为 `mixed`，界面上提示「画面中多人情绪不一致」，
此时推荐偏向更中庸的曲目。

---

## 四、歌曲推荐算法

### 4.1 歌曲表示

每首歌在同一个 VA 空间里有坐标，另有若干标签：

```js
{
  valence: -0.55, arousal: 0.30,   // 情绪坐标
  energy: 0.25, bpm: 72,           // 能量与速度
  moods: { sad: 0.94, calm: 0.45 },// 多标签情绪权重
  rating: 0.88                     // 质量先验
}
```

本地 8 首是手写标注（SoundHelix 算法生成曲，无公开 MIR 数据，
标注为人耳主观打分，已在 `src/data/songs.js` 注明）。
在线曲目按情绪锚点冷启动。

### 4.2 VA 距离（椭圆度量）

唤醒度的感知比效价更敏感（同样 0.2 的差距，节奏变快比变亮更明显），
因此把 A 轴压缩：

```
d = √( ΔV² + (ΔA / 0.72)² ) / √2        →  相似度 = 1 − d
```

### 4.3 三种推荐策略

目标点 `T` 由策略决定，策略的本质是「往哪个方向推」：

| 策略 | 目标点 | 心理学依据 | 适用 |
|---|---|---|---|
| **同频镜像** `empathy` | `T = 当前 VA` | Iso-principle，先与听众同频（镜像情绪）再引导 | 想被理解、需要陪伴 |
| **情绪修复** `repair` | 朝「更好一点」走一半 | Mood repair，一次跨度太大会抗拒 | 想被带动但不想突兀 |
| **情绪反转** `reverse` | 相对于中性点的镜像 | 注意力转移，切断反刍思维 | 陷在情绪里想跳出来 |

「情绪修复」的目标点按情绪分别设定（例如 `sad` 只抬到 `V ≈ +0.05`，
而不是直接拉到 `happy` 的 `+0.81`）——**半步策略**比一步到位更容易被接受。

### 4.4 打分

```
score = 0.46 × VA相似度
      + 0.24 × 标签命中
      + 0.14 × 能量匹配
      + 0.16 × 质量先验
```

- **标签命中**：`Σ_c moods[c] × moodProb[c]`，即歌曲的多标签与当前情绪分布的契合度
- **能量匹配**：`1 − |song.energy − target.arousal|`
- **质量先验**：`rating`

权重偏向 VA 相似度，因为它是最直接的「听感接近」度量；
标签命中次之（它捕捉 VA 无法表达的语义，比如「这首歌是悲伤而不是愤怒」）。

### 4.5 MMR 多样性重排

纯按分数排序会得到 8 首几乎一样的歌。用 **Maximal Marginal Relevance** 迭代选歌：

```
adjusted = score(c) − δ × max_{s ∈ 已选} similarity(c, s)      δ = 0.34
```

每轮挑 adjusted 最高的加入结果。`similarity` 是两首歌在 VA 与能量空间的距离。
`δ = 0.34` 意味着「宁可牺牲 34% 的相关性，也要避免重复」，
最终歌单覆盖同一情绪下的不同质感。

### 4.6 推荐理由

每条理由都对应打分里真实参与的一项，不是装饰文案：

- 同频策略 → 「情绪坐标高度吻合 (VA 相似度 92%)」
- 修复策略 → 「精准落在情绪过渡目标区间 (匹配 84%)」
- 反转策略 → 「与当前情绪走向相反 (目标匹配 79%)」

> 这里刻意区分了「与目标点接近」和「与当前情绪接近」：
> 反转策略下目标点是镜像的，说成「情绪接近」会与「形成反差」自相矛盾。

---

## 五、曲库与在线 API

### 5.1 本地曲库

`public/songs/` 下 8 首 SoundHelix 免费算法生成曲（约 65 MB），
元数据在 `src/data/songs.js`。可离线播放。

### 5.2 在线曲库

前端不直接请求第三方音乐接口——那样会被 CORS 拦住，且平台有防盗链。
本地 Node 服务做代理：

```
GET /api/search?q=关键词             → 聚合 2 个 meting 兼容源，去重后返回
GET /api/proxy-audio?url=<音频直链>   → 转发 Range 头，返回 206 Partial Content
```

- 搜索结果过滤掉伴奏版、纯音乐版、DJ 版、铃声
- 代理转发 `Range` / `User-Agent` / `Referer`，保证 `<audio>` 能拖动进度条
- 某个源失败自动尝试下一个；全部失败则前端只用本地曲库，不报错

在线曲目没有 VA 标注，用**情绪锚点冷启动**：按召回关键词对应的情绪给定坐标，
质量分给中性略低的 0.62，让本地已标注曲目在同等条件下优先。

---

## 六、目录结构

```
emotion-music/
├── index.html
├── vite.config.js               # base:'./'，开发代理到 8787
├── scripts/
│   └── download-assets.js       # 模型 + 歌曲下载器（分块并发 + 断点续传）
├── server/
│   └── index.js                 # 零依赖本地服务：静态托管 + 在线曲库代理
├── public/
│   ├── models/                  # face-api 权重（本地加载）
│   ├── songs/                   # 本地曲库
│   └── verify-faces/            # 验证用样本图
└── src/
    ├── App.vue                  # 主壳：检测循环、推荐调度、布局
    ├── algorithms/
    │   ├── emotionSpace.js      # 零依赖：常量与 7→5 映射（供 Node 单测）
    │   ├── emotionDetector.js   # 检测 + 几何先验 + 时序融合 + 质量评估
    │   ├── faceAggregator.js    # 多人脸加权聚合
    │   └── recommender.js       # VA 距离 + 三策略 + 打分 + MMR
    ├── components/
    │   ├── InputSource.vue      # 四种输入方式
    │   ├── EmotionPanel.vue     # 情绪结果卡（置信度环 + 五类条形图）
    │   ├── SongList.vue         # 歌单 + 打分拆解
    │   ├── Player.vue           # 播放器
    │   └── AlgoDoc.vue          # 页内算法说明（右上角「算法说明」）
    └── data/songs.js            # 本地曲库元数据
```

---

## 七、实现要点与坑

### 7.1 为什么取帧要先画到 canvas

`<video>` 在暂停态或刚 seek 完时，浏览器可能还没把这一帧合成到可读表面，
`tf.browser.fromPixels` 读到的是空帧，检测器于是报「没有人脸」。
统一 `drawImage` 到离屏 canvas 再检测，三条链路（图片 / 视频 / 摄像头）行为一致，
还能顺便把长边限制到 960px 控制推理耗时。

### 7.2 视频首帧要等

`loadedmetadata` 时画面还是空白；`seeked` 在 `currentTime` 本来就是 0 时
Chrome 可能根本不派发。所以用 `readyState >= 2` 轮询兜底，
并在取到纯色空帧时自动重试（最多 12 次 × 150 ms）。

### 7.3 播放进度需要 Range 支持

`<audio>` 拖动进度条依赖 206 响应。本地静态服务对 `audio/*` 实现了 Range，
在线音频则把 `Range` 头透传给上游。

### 7.4 在线召回要缓存

切换推荐策略时不该重新搜歌——否则会「先清空列表再等待」。
按情绪记住上次召回结果，同情绪下直接复用。

---

## 八、已知限制

1. **本地曲库的 VA 标注是人工主观值**，不是 MIR 算法算出来的。
   16 首里实际下载了 8 首音频，其余元数据保留在 `songs.js` 中（服务会按实际文件数截断）。
2. **在线曲目是冷启动**，按情绪锚点估算坐标，不如已标注曲目准确。
3. **表情 ≠ 情绪**。静息脸容易被判成 `calm`（这是合理但保守的默认），
   真正的情绪识别需要更长的时间窗口和更多上下文。
4. 强光、重度美颜、大面积遮挡下，几何先验会退化，此时基本退回纯 CNN 判断。

---

## 九、部署到 GitHub Pages

项目为纯静态应用（模型权重、歌曲、样张全部在 `public/` 下随构建进入 `dist/`），
可以直接托管在 GitHub Pages：

```bash
npm install
npm run build          # 产出 dist/，base 已配置为相对路径 './'
```

部署方式（本仓库采用的）：把 `dist/` 的内容推到 `gh-pages` 分支，
仓库 Settings → Pages → 选择 `gh-pages` 分支即可。

线上地址：<https://yuheng-prog.github.io/emotion-music/>

无后端时的行为（自动降级，无需任何配置）：

- `/api/status` 404 → `serviceInfo.ok = false`，本地曲库按 `songs.js` 全量使用
- `/api/search` 404 → 在线召回失败，界面提示「在线曲库不可用，仅使用本地曲库」，
  推荐基于本地 8 首正常出结果
- 模型权重、歌曲、演示样张全部走相对路径（`./models`、`./songs/`、`./demo-faces/`），
  在仓库子路径（`/emotion-music/`）下也能正常加载
- 摄像头：`https://` 是安全上下文，可以直接授权使用；图片/视频/演示样张功能不受影响

> 国内网络访问 github.io 首次加载模型权重（约 880 KB）可能需要 1~2 分钟，
> 浏览器会缓存，之后刷新很快。

---

## 十、验证方法

项目里保留了自动化验证脚本（`verify/`），用 Chrome DevTools Protocol 驱动真实浏览器：

```bash
node verify/cdp-run.cjs verify/probe-e2e.js verify/out.json --shot verify/shot.png
```

- `probe-e2e.js` — 载入图片 → 三种策略切换 → 播放 → 打开算法说明
- `probe-vtimeline.js` — 合成含人脸的 webm，验证视频模式自动识别
- `probe-photo.js` — 拍照模式（摄像头 + 定格）
- `probe-demo-faces.js` — 8 张演示样张识别验收
- `probe-demo-ui.js` — 演示样张选择器 UI 验收
- `test-algorithms.mjs` — 算法纯函数单测（无需浏览器）

用 `CDP_URL` 环境变量可把探针指向线上站点：

```bash
CDP_URL=https://yuheng-prog.github.io/emotion-music/ node verify/cdp-run.cjs verify/probe-live.js out.json
```

`cdp-run.cjs` 不依赖 puppeteer，自带最小 WebSocket 客户端。

---

## 十一、许可

- face-api.js 模型权重：MIT（`@vladmandic/face-api`）
- SoundHelix 示例曲：SoundHelix 免费示例音乐
- 在线曲库：通过公开 meting 兼容接口访问，仅供学习演示，请勿用于商业分发
