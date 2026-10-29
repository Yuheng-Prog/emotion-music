/**
 * ============================================================================
 *  情绪识别核心模块 (Emotion Recognition Core)
 * ============================================================================
 *
 *  【算法总览】
 *
 *   输入帧 (HTMLImageElement / HTMLVideoElement / HTMLCanvasElement)
 *        │
 *        ▼
 *   ① 人脸检测  TinyFaceDetector (轻量 MobileNet 变体, CNN 回归 bbox + 5 关键点)
 *        │       输入 tensor 尺寸可配 (默认 416), 得分阈值 0.5
 *        ▼
 *   ② 关键点定位  FaceLandmark68Net (回归 68 个人脸关键点)
 *        │       用于人脸对齐 + 几何特征 (嘴角/眉毛/眼睑) 提取
 *        ▼
 *   ③ 表情分类  FaceExpressionNet (小型 CNN, 7 类 softmax)
 *        │       neutral / happy / sad / angry / fearful / disgusted / surprised
 *        ▼
 *   ④ 概率 → 情绪维度映射 (PAD 简化版的效价-唤醒 Valence-Arousal 二维)
 *        │       见 EMOTION_TO_VA 映射矩阵
 *        ▼
 *   ⑤ 几何特征交叉校验 (Geometry Prior)
 *        │       从 68 关键点计算嘴角上扬、眉眼间距、眼睛开合、唇部开度，
 *        │       对 CNN 输出做伪似然修正，抑制"扑克脸误判为 happy"
 *        ▼
 *   ⑥ 时序证据融合 (Temporal Evidence Accumulation)
 *        │       对数空间累加 + 指数遗忘，等效于滑动窗口内的贝叶斯后验更新
 *        ▼
 *   ⑦ 质量门控 → 输出最终情绪 + 置信度 + 建议
 *
 * ----------------------------------------------------------------------------
 *  【设计取舍说明】
 *
 *  1. 为什么用 7 类表情而不是直接回归 VA？
 *     face-api.js 的 FaceExpressionNet 是在 FER2013 / AffectNet 类数据集上训练的
 *     离散分类器，输出 7 类 softmax 概率。它是"表情"而非"情绪"——但表情是情绪的
 *     外显通道，通过 VA 二维投影可以把离散类别变成连续的情绪空间，再做平滑。
 *
 *  2. 为什么要几何特征交叉校验？
 *     纯 CNN 在小脸、侧脸、美颜滤镜、光照不足时会系统性偏向 neutral 或 happy。
 *     68 关键点提供了 3D 几何先验：真实大笑时嘴角上扬 > 3px 且眼角有褶皱，
 *     而"礼貌性微笑"嘴巴有弧度但眼睛几乎闭合不变。用几何量做伪似然(prior-like)
 *     修正能显著降低误判率，同时不引入额外模型体积。
 *
 *  3. 为什么要时序融合？
 *     单帧 CNN 概率抖动很大 (相邻帧同一表情可能 0.9 → 0.4)。对 log 概率做
 *     带遗忘因子的累加，等价于假设"情绪在短时间窗口内是准平稳随机过程"，
 *     用多帧累积提高信噪比。遗忘因子 λ 让系统能在 1~2 秒内响应情绪真实变化。
 */

import * as faceapi from '@vladmandic/face-api'

/* ==========================================================================
 * 常量来源
 * ==========================================================================
 *
 * 表情标签 / VA 锚点 / 5 大情绪元数据 / 7→5 映射 都定义在 emotionSpace.js
 * 里（零依赖模块，便于在 Node 中做单元测试，也避免推荐引擎为了几个常量
 * 而拉入 1.4MB 的 TensorFlow.js）。这里统一 re-export，保持对外接口不变。
 */

import {
  EXPRESSION_LABELS,
  EXPRESSION_CN,
  EMOTION_TO_VA,
  MOODS,
  MOOD_META,
  expressionsToMoods,
  moodsToVA
} from './emotionSpace.js'

export {
  EXPRESSION_LABELS,
  EXPRESSION_CN,
  EMOTION_TO_VA,
  MOODS,
  MOOD_META,
  expressionsToMoods
}

/* ==========================================================================
 * 工具函数
 * ========================================================================== */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y)

/** softmax 归一化 (输入已是概率时可用来重新归一) */
function normalize(vec) {
  const sum = vec.reduce((a, b) => a + b, 0) || 1
  return vec.map((v) => v / sum)
}

/** 把 7 维概率数组转成 {label: prob} 对象 */
function toExpressionObject(probs) {
  const obj = {}
  EXPRESSION_LABELS.forEach((label, i) => {
    obj[label] = probs[i] ?? 0
  })
  return obj
}

/**
 * 7 类表情概率 → 5 大情绪概率
 *
 * 映射规则 (软映射, 不是硬归类):
 *   happy     ← happy
 *   sad       ← sad + 0.35 * disgusted   (厌恶常与低落共现)
 *   angry     ← angry + 0.30 * disgusted
 *   fearful   ← fearful + 0.45 * surprised  (惊讶在负效价语境下常是恐惧)
 *   calm      ← neutral + 0.15 * (sad)
 *
 * 之后把 5 类归一再归一化。这样保留了 CNN 的概率信息，
 * 而不是简单取 argmax 丢失置信度差异。
 *
 * 注：实现位于 emotionSpace.js（零依赖），此处已 re-export。
 */

/* ==========================================================================
 * 几何特征提取 (68 关键点)
 * ========================================================================== */

/**
 * face-api 68 关键点索引约定 (iBUG 300-W 标准):
 *   0-16  下颌轮廓 (17 点, 从右耳到左耳)
 *   17-21 右眉 (5 点)
 *   22-26 左眉 (5 点)
 *   27-35 鼻梁+鼻翼 (9 点)
 *   36-41 右眼 (6 点, 顺时针)
 *   42-47 左眼 (6 点)
 *   48-59 外唇 (12 点, 顺时针)
 *   60-67 内唇 (8 点)
 *
 * 注意: face-api 输出的坐标是相对于传入元素的像素坐标。
 * 下面所有几何量都做了"以脸宽归一化"，因此与图像分辨率无关。
 */
export function computeGeometry(landmarks) {
  const pts = landmarks.positions
  const P = (i) => pts[i]

  // ---- 基准尺度：两耳/下颌最宽处的水平距离，作为脸宽 ----
  const faceWidth = Math.max(dist(P(0), P(16)), 1e-6)
  // 几何量统一用「半脸宽」归一化：脸宽是横向尺寸，纵向量除以半脸宽
  // 得到的比值与脸型无关 (长脸/圆脸同一表情得到相近数值)。
  const halfWidth = faceWidth / 2
  // ---- 脸高：眉心到下巴 ----
  const faceHeight = dist(P(27), P(8)) || faceWidth

  // --- 嘴部 ---
  const mouthLeft = P(48)
  const mouthRight = P(54)
  const mouthCenterY = (mouthLeft.y + mouthRight.y) / 2
  // 嘴角相对"唇中部"的上扬量：正值=上扬(笑)
  const lipTopMid = P(51)
  const lipBottomMid = P(57)
  const lipMidY = (lipTopMid.y + lipBottomMid.y) / 2
  const smileRaw = (mouthCenterY - lipMidY) / faceWidth
  // 映射到 0~1：0=嘴角明显下垂, 1=明显上扬
  const smileCurvature = clamp(0.5 + smileRaw * 6, 0, 1)

  // 唇开度：内唇上下缘的垂直间距 (AU25/AU26)，用半脸宽归一化。
  // 标定实测 (960px 长边)：闭嘴约 0.14，自然说话约 0.18，大笑 0.28~0.40。
  // 因此把 0.14 视为基线，0.36 视为完全张开。
  const mouthGap = (P(66).y - P(62).y + (P(57).y - P(51).y)) / 2
  const MOUTH_GAP_CLOSED = 0.14
  const mouthOpen = clamp((mouthGap / halfWidth - MOUTH_GAP_CLOSED) * 4.5, 0, 1)

  // 嘴宽 / 脸宽 (大笑时变宽)
  const mouthWidthRatio = dist(mouthLeft, mouthRight) / faceWidth

  // --- 眉毛 ---
  const browInnerR = P(21) // 右眉内侧
  const browInnerL = P(22) // 左眉内侧
  const browOuterR = P(17)
  const browOuterL = P(26)
  const eyeTopR = P(37)
  const eyeTopL = P(44)
  // 眉-眼间距 (归一化)
  const browEyeGap = (Math.abs(browInnerR.y - eyeTopR.y) + Math.abs(browInnerL.y - eyeTopL.y)) / 2 / faceWidth
  // 眉高：眉心到两内眼角连线的垂直距离，用「半脸宽」归一化。
  // 之所以用内眼角当参照而不是鼻梁 27：27 距眉太近 (-0.25~-0.40 hw)，
  // 常数偏移极大，导致开口区里全是抬眉、抬起量级被掩盖。
  // 内眼角到眉心是纯纵向距离，受脸宽个体差异影响小，中性时约 0.30 hw。
  const eyeInnerY = (P(39).y + P(42).y) / 2
  const browToEye = (eyeInnerY - (browInnerR.y + browInnerL.y) / 2) / halfWidth
  const BROW_TO_EYE_MED = 0.3 // 中性放松状态的中位值
  const browRaise = clamp((browToEye - BROW_TO_EYE_MED) * 6, 0, 1)
  const browDrop = clamp((BROW_TO_EYE_MED - browToEye) * 6, 0, 1)

  // 眉毛内侧相对外侧的高度差：内侧更低 = 下压(愤怒/专注)
  const innerHigherR = (browOuterR.y - browInnerR.y) / faceWidth
  const innerHigherL = (browOuterL.y - browInnerL.y) / faceWidth
  const innerBrowAvg = (innerHigherR + innerHigherL) / 2
  // innerBrowAvg > 0 表示外侧比内侧低, 即内侧上扬 → 悲伤
  const browInnerUp = clamp(innerBrowAvg * 10, 0, 1)
  const browInnerDown = clamp(-innerBrowAvg * 10, 0, 1)

  // --- 眼睛 ---
  const eyeOpenR = Math.abs(P(41).y - P(37).y) / faceWidth
  const eyeOpenL = Math.abs(P(46).y - P(44).y) / faceWidth
  const eyeOpenAvg = (eyeOpenR + eyeOpenL) / 2
  // 眼宽
  const eyeWidth = (dist(P(36), P(39)) + dist(P(42), P(45))) / 2 / faceWidth
  // 眼睛开合比 (EAR, Eye Aspect Ratio)
  const ear = eyeOpenAvg / Math.max(eyeWidth, 1e-6)
  const eyeSquint = clamp(1 - (ear - 0.12) * 4, 0, 1)
  const eyeWide = clamp((ear - 0.28) * 4, 0, 1)

  // --- 头部姿态 (用关键点做粗略估计, 仅用于质量门控) ---
  const eyeCenterR = { x: (P(36).x + P(39).x) / 2, y: (P(36).y + P(39).y) / 2 }
  const eyeCenterL = { x: (P(42).x + P(45).x) / 2, y: (P(42).y + P(45).y) / 2 }
  const roll = Math.atan2(eyeCenterL.y - eyeCenterR.y, eyeCenterL.x - eyeCenterR.x)
  const rollDeg = Math.abs((roll * 180) / Math.PI)

  return {
    faceWidth,
    faceHeight,
    smileCurvature,
    mouthOpen,
    mouthWidthRatio,
    browRaise,
    browDrop,
    browInnerUp,
    browInnerDown,
    browEyeGap,
    ear,
    eyeSquint,
    eyeWide,
    rollDeg
  }
}

/**
 * 合并多尺度检测结果。
 *
 * 输入是「每个尺度一个人脸数组」，输出是去重合并后的人脸数组。
 * 匹配规则：两个框的 IoU > 0.4 就认为是同一张脸。
 * 合并时：
 *   · detection / landmarks 取 IoU 簇里检测得分最高的那条（保留最佳坐标）
 *   · expressions 取簇内各观测的几何平均（这是 TTA 的核心 —— 投票而非挑选）
 *   · hits 记录被多少个尺度认同
 *
 * 只用几何平均而不做置信度加权，是因为不同 scale 的 detection.score
 * 不可比（同一张脸 416 下 0.73、512 下 0.72，但结论可能相反），
 * 用 score 加权反而会放大偏差。
 */
function mergeMultiScale(perScale) {
  const clusters = []
  for (const faces of perScale) {
    for (const f of faces) {
      const box = f.detection.box
      let hit = null
      for (const c of clusters) {
        // 阈�� 0.25：不同 inputSize 给出的框尺寸能差 20%（实测 731x607 → 590x536），
        // IoU 只有 0.35 左右。用 0.4 会把同一张脸拆成两条。
        // 相邻两张真实人脸 IoU 通常 < 0.15，所以 0.25 不会误合并。
        if (iou(c.box, box) > 0.25) {
          hit = c
          break
        }
      }
      if (hit) {
        hit.items.push(f)
        hit.hits++
      } else {
        clusters.push({ box, items: [f], hits: 1 })
      }
    }
  }

  return clusters.map((c) => {
    // 选出检测得分最高的一条作为「主导观测」：坐标以它为准
    const best = c.items.reduce((a, b) =>
      (b.detection.score || 0) > (a.detection.score || 0) ? b : a
    )
    const primary = toExpressionObject(
      EXPRESSION_LABELS.map((l) => best.expressions[l] ?? 0)
    )

    // 其余尺度按「几何一致性」加权，而不是按检测分加权。
    //
    // 为什么不能用检测分：两个尺度对同一张脸的判断可能截然相反
    // （04-angry 实测 416 判 angry 0.81，512 判 sad 0.78），
    // 而检测分 0.73 vs 0.72 几乎没有区分度 —— 靠它选基准等于抛硬币。
    //
    // 真正有信息量的是关键点几何：同一张脸在不同尺度下，
    // 哪个尺度给出的 68 点更符合表情的 FACS 特征（嘴角上扬、
    // 眉内侧下压、唇部开度），哪个尺度的框就更贴合五官。
    // 用 computeGeometry 对每个观测打分，按几何吻合度分配权重。
    if (c.items.length === 1) {
      return {
        detection: best.detection,
        landmarks: best.landmarks,
        expressions: primary,
        hits: c.hits
      }
    }

    // 每个观测的几何吻合度：先算该观测自己的几何量，再看它与
    // 该观测 CNN 预测的表情是否自洽（CNN 与几何互相印证 = 可信）
    const scored = c.items.map((it) => {
      const geo = computeGeometry(it.landmarks)
      const e = toExpressionObject(EXPRESSION_LABELS.map((l) => it.expressions[l] ?? 0))
      return { it, geo, e, agree: geometryAgreement(e, geo) }
    })

    const total = scored.reduce((s, x) => s + x.agree, 0)
    // 加权 log 平均：几何自洽度越高，权重越大
    let expressions = primary
    if (total > 0) {
      const acc = {}
      for (const l of EXPRESSION_LABELS) acc[l] = 0
      for (const s of scored) {
        const w = s.agree / total
        for (const l of EXPRESSION_LABELS) {
          acc[l] += Math.log(Math.max(s.e[l], 1e-6)) * w
        }
      }
      const vals = EXPRESSION_LABELS.map((l) => acc[l])
      const maxV = Math.max(...vals)
      const exps = vals.map((v) => Math.exp(v - maxV))
      const sum = exps.reduce((a, b) => a + b, 0)
      expressions = EXPRESSION_LABELS.reduce((o, l, i) => ((o[l] = exps[i] / sum), o), {})
    }

    return {
      detection: best.detection,
      landmarks: best.landmarks,
      // postProcess 会自己读 result.expressions，
      // 这里已经把融合结果写进去，几何先验修正作用在融合后的概率上
      expressions,
      hits: c.hits
    }
  })
}

/**
 * 几何自洽度：CNN 预测的分布与几何特征是否互相印证。
 *
 * 做法：拿该观测的关键点几何量，走一遍同样的 GEOMETRY_PRIORS 修正，
 * 看修正前后分布的形状变化有多大。
 *   · 几何与 CNN 一致 → 修正幅度小（互相印证，不需要纠偏）
 *   · 几何与 CNN 冲突 → 修正幅度大（说明两者对不上，可信度低）
 *
 * 返回值越大表示「CNN 与几何越一致」，用于多尺度加权。
 */
function geometryAgreement(expr, geo) {
  try {
    const adjusted = applyGeometryPrior(expr, geo)
    // 用 JS 散度衡量修正前后的分布差异（对称化后取反）
    let d = 0
    for (const l of EXPRESSION_LABELS) {
      const p = Math.max(expr[l], 1e-9)
      const q = Math.max(adjusted[l], 1e-9)
      d += (p - q) * Math.log(p / q)
    }
    // d ∈ [0, ~2]，越小越一致 → 转成 0.2~1 的正权重
    return 1 / (1 + 2 * Math.max(d, 0))
  } catch {
    return 0.5
  }
}

/**
 * 两个矩形框的 IoU。
 *
 * face-api 的 Box 在不同版本里暴露的尺寸字段不一致：
 *   · 1.7.x 的 detectAllFaces 返回 { x, y, width, height, area, ... }
 *   · 部分路径（如 Box.assertIsRect 包装后）暴露 { x, y, w, h }
 * 直接用 .width 会拿到 undefined，算出 NaN，导致 IoU 比较永远为 false、
 * 同一张脸被拆成两条。所以这里做一次归一化读取。
 */
function boxDim(b) {
  const w = b.width ?? b.w ?? 0
  const h = b.height ?? b.h ?? 0
  return { x: b.x, y: b.y, w, h }
}

function iou(rawA, rawB) {
  const a = boxDim(rawA)
  const b = boxDim(rawB)
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/* ==========================================================================
 * 几何先验修正
 * ========================================================================== */

/**
 * 几何特征 → 7 类表情的似然比表 (Likelihood Ratio Table)
 *
 * 数值含义：support[f][c] 表示"当特征 f 强烈出现时，类别 c 的概率应被放大
 * 多少倍"。1.0 = 不影响，>1 = 支持，<1 = 抑制。
 *
 * 依据 FACS (Facial Action Coding System) 的经典表情配置：
 *
 *   smileCurvature  嘴角上翘曲率        AU12 (Lip Corner Puller)
 *     · happy 大笑时嘴角显著上扬 — 最强正向证据
 *     · sad   嘴角下垂 — 抑制
 *     · angry 嘴角紧绷内收 — 抑制
 *
 *   mouthOpen       唇部开度            AU25/AU26
 *     · surprised 张口是核心特征 (AU26)
 *     · happy     大笑也会张口 (AU27)
 *     · neutral   静息状态唇部闭合 — 抑制
 *
 *   browRaise       整体眉毛抬升        AU1+AU2
 *     · surprised 眉毛整体高抬是标配
 *     · happy     大笑时眉毛轻微上抬
 *
 *   browInnerDown   眉内侧下压          AU4 (Brow Lowerer) — "皱眉"
 *     · angry      AU4 是愤怒最核心编码
 *     · sad/fearful AU4 常与 AU1 伴随出现
 *     · happy      抑制
 *
 *   browInnerUp     眉内侧上抬 (八字眉)  AU1 (Inner Brow Raiser)
 *     · sad        AU1 是悲伤的标志性动作，很少单独出现在其他表情
 *     · fearful    AU1+AU2+AU4 是恐惧四联征之一
 *
 *   eyeSquint       眼睑收紧 (眯眼)      AU6 (Cheek Raiser) 伴随 AU7
 *     · happy      杜兴式微笑 (Duchenne smile) 的关键——真笑会眯眼
 *     · surprised  抑制（惊讶是睁大眼）
 *
 *   eyeWide         睁大眼 (巩膜外露)    AU5 (Upper Lid Raiser)
 *     · surprised  AU5 是惊讶的核心
 *     · fearful    同上，恐惧的瞪眼
 *
 * 设计说明：所有抑制项都不设到 0.3 以下。原因是几何量受姿态、遮挡影响大，
 * 过强的抑制会让侧脸/戴眼镜的人永远识别不出对应表情。这里只做"温和否决"，
 * 真正的判别仍然交给 CNN，几何先验负责纠偏 (见 applyGeometryPrior 的注释)。
 */
export const GEOMETRY_PRIORS = {
  // AU12 嘴角上扬 —— happy 最强支持
  smileCurvature: {
    happy: 3.2,
    surprised: 1.1,
    neutral: 0.55,
    sad: 0.42,
    angry: 0.48,
    fearful: 0.75,
    disgusted: 0.6
  },

  // AU25/AU26 张口
  mouthOpen: {
    surprised: 2.6,
    happy: 1.6,
    fearful: 1.35,
    angry: 1.2,
    neutral: 0.6,
    sad: 0.8,
    disgusted: 0.9
  },

  // AU1+AU2 整体抬眉
  browRaise: {
    surprised: 2.8,
    happy: 1.25,
    fearful: 1.5,
    sad: 0.85,
    neutral: 0.75,
    angry: 0.7,
    disgusted: 0.8
  },

  // 眉毛整体压低（AU4 的对称形态，也见于专注/不悦）—— 与 browRaise 互斥
  browDrop: {
    angry: 2.2,
    disgusted: 1.35,
    sad: 1.1,
    neutral: 0.85,
    fearful: 0.9,
    happy: 0.7,
    surprised: 0.45
  },

  // AU4 眉内侧下压 (皱眉)
  browInnerDown: {
    angry: 2.5,
    sad: 1.35,
    fearful: 1.3,
    disgusted: 1.2,
    neutral: 0.9,
    happy: 0.5,
    surprised: 0.55
  },

  // AU1 眉内侧上抬 (八字眉) —— 悲伤的标志
  browInnerUp: {
    sad: 2.4,
    fearful: 1.55,
    surprised: 1.2,
    neutral: 0.85,
    happy: 0.75,
    angry: 0.5,
    disgusted: 0.65
  },

  // AU6 眯眼 —— 杜兴式微笑的关键
  eyeSquint: {
    happy: 2.2,
    angry: 1.25,
    disgusted: 1.2,
    sad: 1.05,
    neutral: 0.85,
    surprised: 0.45,
    fearful: 0.5
  },

  // AU5 睁大眼
  eyeWide: {
    surprised: 2.3,
    fearful: 2.0,
    angry: 1.1,
    happy: 1.05,
    neutral: 0.7,
    sad: 0.7,
    disgusted: 0.75
  }
}

/**
 * 用几何特征对 7 类表情概率做伪似然修正。
 *
 * 数学形式：p'(c) ∝ p(c) * ∏_k L_k(c) ^ w_k
 *   L_k(c) 来自 GEOMETRY_PRIORS 表中第 k 个特征对类别 c 的支持度，
 *   w_k 是该特征相对阈值的"强度" (0~1)，越强修正越大。
 *
 * 用 gamma 指数而不是简单乘，是为了让修正"渐进"而不是二元开关，
 * 避免几何特征轻微抖动导致结果跳变。
 */
export function applyGeometryPrior(expr, geo) {
  // 各几何量相对其参考中位值的强度 (0~1)
  const strengths = {
    smileCurvature: clamp((geo.smileCurvature - 0.5) * 2.5, 0, 1), // >0.5 才触发
    mouthOpen: clamp(geo.mouthOpen * 1.2, 0, 1),
    browRaise: geo.browRaise,
    browDrop: geo.browDrop,
    browInnerDown: geo.browInnerDown,
    browInnerUp: geo.browInnerUp,
    eyeSquint: geo.eyeSquint,
    eyeWide: geo.eyeWide
  }

  const adjusted = {}
  for (const label of EXPRESSION_LABELS) {
    let logProb = Math.log(Math.max(expr[label], 1e-6))
    for (const [feat, table] of Object.entries(GEOMETRY_PRIORS)) {
      const support = table[label]
      if (support === undefined) continue
      const w = strengths[feat] || 0
      if (w <= 0.02) continue
      // log 空间累加：support>1 提升, <1 抑制。权重上限 1.0 防止几何量主导
      logProb += Math.log(support) * Math.min(w, 1) * 0.9
    }
    adjusted[label] = Math.exp(logProb)
  }

  // 归一化：几何先验是伪似然，乘完后已不再是一组和为 1 的概率
  const vals = EXPRESSION_LABELS.map((l) => adjusted[l])
  return toExpressionObject(normalize(vals))
}

/**
 * 多帧 soft-vote（不带时序衰减）。
 *
 * 静态图/单次快照只要被判定「输入没在变化」，就应把同一张脸的
 * N 次检测当作 N 个独立观测做概率平均，而不是走 accumulate() 的
 * 对数证据累加 —— 后者会把本就饱和的 one-hot 概率越推越极端。
 *
 * 用几何平均（对数域平均后 softmax）而不是算术平均：
 * 算术平均会让 [1,0,0] 与 [0,1,0] 变成 [0.5,0.5,0]，凭空造出
 * 一个「既开心又难过」的中间态；几何平均则会保留分歧、维持低置信度。
 */
export function meanExpressions(list) {
  if (!list.length) return null
  if (list.length === 1) return list[0]
  const out = {}
  for (const label of EXPRESSION_LABELS) {
    let s = 0
    for (const e of list) s += Math.log(Math.max(e[label], 1e-6))
    out[label] = s / list.length
  }
  // log 域 → softmax 回到概率单纯形
  const vals = EXPRESSION_LABELS.map((l) => out[l])
  const maxV = Math.max(...vals)
  return toExpressionObject(normalize(vals.map((v) => Math.exp(v - maxV))))
}

/* ==========================================================================
 * 主检测器类
 * ========================================================================== */

export class EmotionDetector {
  constructor() {
    this.ready = false
    this.loading = false
    this.modelPath = './models'
    // 时序证据累加器：log 空间概率的指数加权和
    this.evidence = null
    this.frameCount = 0
    this.lastTs = 0
    // 静态图多次检测的 soft-vote 缓冲（最多保留最近 8 次）
    this.staticVotes = []
    this.staticVoteLimit = 8
    // 配置
    this.config = {
      /**
       * 检测多尺度。
       *
       * TinyFaceDetector 不是尺度不变的：把同一张图喂进不同 inputSize，
       * 它输出的��宽高比会变（实测「愤怒」这张 416 下是 731x607，
       * 512 下变成 590x536）。而表情 CNN 对脸框比例极度敏感，
       * 同一个愤怒表情在 416 下判 angry 0.81、在 512 下判 sad 0.78。
       *
       * 所以 inputSize 不是单纯的「速度旋钮」，它直接影响分类结果。
       * 单尺度必然偏向某类表情，于是这里跑两个尺度，由调用方对
       * 两次结果做几何平均投票 —— 相当于用检测框的轻微差异
       * 做一次测试时增强（TTA）。
       *
       * 416 优势：速度 2x，对常规表情（sad/happy/neutral）更稳。
       * 512 优势：能检出 416 漏掉的极端大特写（惊讶/张大口）。
       */
      inputSizes: [416, 512],
      /**
       * 检测得分阈值。
       * 0.3 而非 0.45：极端表情（惊讶/恐惧）会让脸部比例相对训练
       * 分布偏移，得分天然偏低（实测 0.44~0.48）。阈值过高会把这些
       * 恰恰是最需要识别的样本拒之门外。误检风险由后续的
       * 「质量评估 + 置信度折扣」兜底。
       */
      scoreThreshold: 0.3,
      /** 人脸最小像素宽度 (低于此值置信度打折) */
      minFacePx: 90,
      /** 时序遗忘因子：每帧证据乘以该系数, 越小响应越快但越抖 */
      forgetFactor: 0.82,
      /** 几何先验混合强度 0~1 */
      geometryWeight: 0.85,
      /** 触发推荐所需最低置信度 */
      confidenceThreshold: 0.42
    }
  }

  /** 加载模型权重 (本地 public/models 目录) */
  async load(onProgress) {
    if (this.ready || this.loading) return this.ready
    this.loading = true
    const steps = [
      ['人脸检测模型 (TinyFaceDetector)', () => faceapi.nets.tinyFaceDetector.loadFromUri(this.modelPath)],
      ['关键点模型 (68 landmarks)', () => faceapi.nets.faceLandmark68Net.loadFromUri(this.modelPath)],
      ['表情分类模型 (Expression CNN)', () => faceapi.nets.faceExpressionNet.loadFromUri(this.modelPath)]
    ]
    for (let i = 0; i < steps.length; i++) {
      const [name, fn] = steps[i]
      onProgress?.({ index: i, total: steps.length, name, phase: 'loading' })
      await fn()
    }
    this.ready = true
    this.loading = false
    onProgress?.({ index: steps.length, total: steps.length, name: '完成', phase: 'done' })
    return true
  }

  /** 重置时序证据 */
  reset() {
    this.evidence = null
    this.frameCount = 0
    this.staticVotes = []
  }

  /**
   * 静态输入的 soft-vote：把这次的单帧观测压入缓冲，
   * 返回缓冲内所有观测的几何平均。
   *
   * 解决两个问题：
   *  1) 静态图（图片/拍照）同一帧被检测 N 次时，走 accumulate 会让
   *     对数证据线性叠加、概率迅速饱和成 one-hot，置信度失真。
   *  2) 即使单次检测，几何先验修正过的概率本身可能过尖，
   *     几何平均后能回到更合理的分布。
   *
   * 缓冲设上限，因为静态图反复检测时旧的观测不应永久占权重。
   */
  voteStatic(expr) {
    this.staticVotes.push(expr)
    if (this.staticVotes.length > this.staticVoteLimit) this.staticVotes.shift()
    this.frameCount = this.staticVotes.length
    return meanExpressions(this.staticVotes)
  }

  /**
   * 多尺度人脸检测（TTA）。
   *
   * 依次用 config.inputSizes 里的每个分辨率检测，再把各尺度得到的
   * 人脸按位置做贪心匹配（IoU > 0.4 视为同一张脸），同一张脸的
   * 观测合并为一条。
   *
   * 为什么必须这么做：见 config.inputSizes 的注释 ——
   * 不同 inputSize 会给出比例不同的脸框，进而让表情 CNN 得出
   * 完全不同的结论。单尺度必然对某类表情有偏。
   *
   * @returns {Promise<Array<{detection, landmarks, expressions, hits}>>}
   *   hits 表示这条人脸被多少个尺度同时检出，用于判断可靠性。
   */
  async detectMultiScale(input, { all = false } = {}) {
    const perScale = []
    const debug = []
    for (const size of this.config.inputSizes) {
      const opts = this.detectorOptions(size)
      try {
        const res = all
          ? await faceapi.detectAllFaces(input, opts).withFaceLandmarks().withFaceExpressions()
          : await faceapi
              .detectSingleFace(input, opts)
              .withFaceLandmarks()
              .withFaceExpressions()
              .then((r) => (r ? [r] : []))
        perScale.push(res || [])
        debug.push({ size, n: (res || []).length })
      } catch (e) {
        // 某个尺度失败不应拖垮整个检测，跳过即可
        perScale.push([])
        debug.push({ size, n: 0, error: e.message })
      }
    }
    const merged = mergeMultiScale(perScale)

    // 多尺度共识过滤：阈值降到 0.3 之后，单个尺度偶发低分误检变多
    // （实测 04-angry 在 416 下多出一个假框，得分刚好压线）。
    // 只要有任意一张脸被 ≥2 个尺度认同，就认为「确实有人脸」，
    // 此时把仅被 1 个尺度认同的框视为噪声丢弃。
    // 反过来，若所有框都只有 1 票（例如 06-surprised 只有 512 能检出），
    // 说明这张脸本身就处在检测边界，保留它而不是清空结果。
    const maxHits = merged.reduce((m, x) => Math.max(m, x.hits), 0)
    const kept = maxHits >= 2 ? merged.filter((x) => x.hits >= 2) : merged

    if (typeof window !== 'undefined' && window.__emDebug) {
      window.__emDebug.push({
        debug,
        merged: merged.length,
        kept: kept.length,
        hits: kept.map((m) => m.hits)
      })
    }
    return kept
  }

  /**
   * 对单帧图像做完整检测（单人脸场景）。
   *
   * @param {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement} input
   * @param {object} opts { trackTemporal:boolean }
   * @returns {Promise<DetectionResult|null>}
   */
  async detect(input, opts = {}) {
    if (!this.ready) throw new Error('模型尚未加载')

    const merged = await this.detectMultiScale(input, { all: false })
    if (!merged.length) return null
    // 取被最多尺度认同、且检测框最大的那一张
    merged.sort((a, b) => b.hits - a.hits || boxDim(b.detection.box).w - boxDim(a.detection.box).w)
    const result = merged[0]
    return this.postProcess(result, input, opts.trackTemporal !== false, opts.timestamp)
  }

  /** TinyFaceDetector 配置 */
  detectorOptions(inputSize = this.config.inputSizes[0]) {
    return new faceapi.TinyFaceDetectorOptions({
      inputSize,
      scoreThreshold: this.config.scoreThreshold
    })
  }

  /**
   * 后处理：把 face-api 的原始结果转成系统统一的情绪结构。
   *
   * 多人脸场景下由 App 用 detectAllFaces 拿到 result 数组，
   * 再逐条调用本方法，从而复用「几何先验 + 质量评估 + 时序融合」逻辑。
   *
   * @param {object} result face-api 的 WithFaceExpressions<WithFaceLandmarks<...>>
   * @param {*} input 原始输入元素（用于质量评估中的亮度采样）
   * @param {boolean} trackTemporal 是否参与时序累积
   * @param {number} timestamp 可选时间戳
   * @param {number} pxScale 检测坐标系 → 原始画面的缩放比。
   *        调用方若把画面缩小后再送进检测器（例如长边限制到 960px），
   *        需要传 1/scale 让质量评估按真实像素尺寸判断人脸够不够大。
   *        默认 1 表示检测坐标系就是原始坐标系。
   */
  postProcess(result, input, trackTemporal = true, timestamp, pxScale = 1) {
    const box = result.detection.box
    // ① CNN 原始 7 类输出
    const rawExpr = toExpressionObject(EXPRESSION_LABELS.map((l) => result.expressions[l] ?? 0))
    const geo = computeGeometry(result.landmarks)

    // ② 几何先验修正 —— 只在 CNN 原始输出上做一次，避免先验被重复计入
    const singleFrameExpr = applyGeometryPrior(rawExpr, geo)

    // ---- 质量评估 ----
    const quality = this.assessQuality({
      box,
      geo,
      input,
      detectionScore: result.detection.score,
      pxScale
    })

    // ③ 时序融合：把单帧修正后的概率作为「观测」送入累加器
    // trackTemporal 有两种模式：
    //   true  → 走 accumulate()，对数证据指数衰减，用于视频/摄像头的连续帧
    //   false → 走 meanExpressions()，等权几何平均，用于静态图的多次重复检测
    let fusedExpr = singleFrameExpr
    if (trackTemporal) {
      fusedExpr = this.accumulate(singleFrameExpr, quality, timestamp)
    } else {
      fusedExpr = this.voteStatic(singleFrameExpr)
    }

    // ④ 映射到 5 大情绪 + 置信度
    const moods = expressionsToMoods(fusedExpr)
    let bestMood = MOODS[0]
    for (const m of MOODS) if (moods[m] > moods[bestMood]) bestMood = m

    const confidence = this.computeConfidence(moods, bestMood, quality)

    return {
      box,
      detectionScore: result.detection.score,
      landmarks: result.landmarks.positions.map((p) => ({ x: p.x, y: p.y })),
      expressions: fusedExpr, // 7 类 (时序融合后)
      singleFrameExpressions: singleFrameExpr, // 7 类 (仅几何修正)
      rawExpressions: rawExpr, // 7 类 (CNN 原始)
      moods, // 5 类归一概率
      mood: bestMood, // 主导情绪
      confidence, // 0~1 综合置信度
      geometry: geo,
      quality,
      frameCount: this.frameCount
    }
  }

  /**
   * 单帧检测 (不做时序融合)，用于静态图片/拍照场景。
   * 静态图没有时序信息，直接用几何修正后的单帧结果，
   * 并对置信度做一次「单帧折扣」(乘以 0.9) 以反映证据量不足。
   */
  async detectStatic(input) {
    const r = await this.detect(input, { trackTemporal: false })
    if (r) {
      r.confidence = r.confidence * 0.9
      r.frameCount = 1
    }
    return r
  }

  /**
   * 质量评估：从分辨率、人脸尺寸、清晰度、姿态四个维度打分。
   * 任何维度不足都会拉低最终置信度，而不是直接拒绝识别。
   */
  assessQuality({ box, geo, input, detectionScore, pxScale = 1 }) {
    // 1) 人脸尺寸 (像素宽度) —— 低于 minFacePx 时特征提取不可靠
    //    box 位于检测坐标系，pxScale 换算回原始画面像素
    const facePx = box.width * pxScale
    const sizeScore = clamp((facePx - this.config.minFacePx * 0.5) / (this.config.minFacePx * 1.2), 0, 1)

    // 2) 检测器自身置信度
    const detScore = clamp((detectionScore - 0.4) / 0.5, 0, 1)

    // 3) 姿态：roll 过大说明头歪，关键点几何量会失真
    const poseScore = clamp(1 - (geo.rollDeg - 8) / 25, 0, 1)

    // 4) 亮度估计 (仅对可读像素的输入有效)
    let lightScore = 1
    try {
      const w = input.videoWidth || input.naturalWidth || input.width
      const h = input.videoHeight || input.naturalHeight || input.height
      if (w && h) {
        // 采样框同时做两件事：① 换算回输入坐标系 ② 向内收 15%。
        // 收边是因为 TinyFaceDetector 的框通常比真实人脸大一圈，
        // 直接采会把背景/头发算进亮度，导致「明亮背景 + 偏暗人脸」被判成过曝。
        const fw = box.width * pxScale
        const fh = box.height * pxScale
        const sx = box.x * pxScale + fw * 0.15
        const sy = box.y * pxScale + fh * 0.15
        const sw = Math.max(1, fw * 0.7)
        const sh = Math.max(1, fh * 0.7)

        const c = document.createElement('canvas')
        const s = 48
        c.width = s
        c.height = s
        const ctx = c.getContext('2d', { willReadFrequently: true })
        // 只采样人脸中心区域
        ctx.drawImage(input, sx, sy, sw, sh, 0, 0, s, s)
        const data = ctx.getImageData(0, 0, s, s).data
        let sum = 0
        let sumSq = 0
        const n = s * s
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          sum += lum
          sumSq += lum * lum
        }
        const mean = sum / n
        const variance = Math.max(sumSq / n - mean * mean, 0)
        // 亮度适中 (60~190) 得分高
        const brightScore = mean < 60 ? mean / 60 : mean > 195 ? clamp((255 - mean) / 60, 0, 1) : 1
        // 对比度过低 (纯色/过曝) 也扣分
        const contrastScore = clamp(Math.sqrt(variance) / 28, 0.35, 1)
        lightScore = brightScore * 0.7 + contrastScore * 0.3
      }
    } catch {
      lightScore = 0.8
    }

    const overall = clamp(
      0.3 * sizeScore + 0.25 * detScore + 0.2 * poseScore + 0.25 * clamp(lightScore, 0, 1),
      0,
      1
    )

    const warnings = []
    if (facePx < this.config.minFacePx) warnings.push('人脸偏小，请靠近镜头')
    if (geo.rollDeg > 22) warnings.push('头部倾斜较大，建议正对镜头')
    if (lightScore < 0.55) warnings.push('光线不足或过曝，建议调整光源')
    if (detScore < 0.5) warnings.push('人脸检测置信度偏低')

    return {
      facePx: Math.round(facePx),
      sizeScore,
      detScore,
      poseScore,
      lightScore: clamp(lightScore, 0, 1),
      overall,
      warnings
    }
  }

  /**
   * 时序证据累积 (核心平滑算法)
   *
   * 设第 t 帧的表情概率为 p_t(c)，定义对数证据：
   *
   *   E_t(c) = λ · E_{t-1}(c) + ln( p_t(c) ^ γ + ε )
   *
   *   其中 λ = forgetFactor (遗忘因子)，γ = quality.overall (质量加权，
   *   低质量帧对证据的贡献自动变小)。
   *
   * 最终融合概率：
   *
   *   p̄(c) = softmax( E_t(c) )
   *
   * 这等价于「带遗忘的贝叶斯后验更新」：先验来自历史帧，
   * 似然来自当前帧，λ 控制历史信息的衰减速度。
   */
  accumulate(expr, quality, timestamp) {
    const gamma = clamp(quality.overall, 0.05, 1)
    const lambda = this.config.forgetFactor

    if (!this.evidence) {
      this.evidence = {}
      for (const l of EXPRESSION_LABELS) this.evidence[l] = Math.log(Math.max(expr[l], 1e-6)) * gamma
      this.frameCount = 1
      this.lastTs = timestamp || performance.now()
      return expr
    }

    // 如果距上一帧超过 3 秒，视为中断，重新开始累积
    const now = timestamp || performance.now()
    if (now - this.lastTs > 3000) {
      this.reset()
      return this.accumulate(expr, quality, now)
    }

    for (const l of EXPRESSION_LABELS) {
      const obs = Math.log(Math.max(expr[l], 1e-6)) * gamma
      this.evidence[l] = lambda * this.evidence[l] + obs
    }
    this.frameCount++
    this.lastTs = now

    // softmax 还原成概率
    const vals = EXPRESSION_LABELS.map((l) => this.evidence[l])
    const maxV = Math.max(...vals)
    const exps = vals.map((v) => Math.exp(v - maxV))
    const sum = exps.reduce((a, b) => a + b, 0)
    const out = {}
    EXPRESSION_LABELS.forEach((l, i) => {
      out[l] = exps[i] / sum
    })
    return out
  }

  /**
   * 综合置信度
   *
   *   置信度 = 概率集中度 ^ 0.5 × 质量因子 ^ 0.5
   *
   * 概率集中度用「补熵」度量：分布越尖锐 (越确定) 越高。
   *   H = -Σ p ln p ,  Hmax = ln(5)
   *   sharpness = 1 - H / Hmax
   *
   * 再叠加质量因子，避免"模型很确定但图很糊"这类虚假高置信。
   */
  computeConfidence(moods, bestMood, quality) {
    let H = 0
    for (const m of MOODS) {
      const p = clamp(moods[m], 1e-9, 1)
      H -= p * Math.log(p)
    }
    const Hmax = Math.log(MOODS.length)
    const sharpness = clamp(1 - H / Hmax, 0, 1)
    // 主导类别超出均匀分布 (0.2) 的幅度
    const margin = clamp((moods[bestMood] - 0.2) / 0.8, 0, 1)

    const conf = Math.pow(sharpness, 0.45) * 0.55 + Math.pow(margin, 0.6) * 0.45
    return clamp(conf * (0.45 + 0.55 * quality.overall), 0, 1)
  }

  /**
   * 把 5 大情绪概率投影到 VA 二维坐标（加权质心）。
   * 实现委托给 emotionSpace.js，保留此静态方法以兼容既有调用。
   */
  static moodsToVA(moods) {
    return moodsToVA(moods)
  }
}

export { faceapi }
