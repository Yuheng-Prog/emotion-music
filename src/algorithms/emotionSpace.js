/**
 * ============================================================================
 *  情绪空间定义（纯数据 + 纯函数，零依赖）
 * ============================================================================
 *
 *  本模块刻意不 import face-api，只包含：
 *    · 7 类表情标签与中文名
 *    · VA 空间锚点
 *    · 5 大情绪元数据（文案 / 配色）
 *    · 7 类 → 5 类的软映射
 *
 *  这样做的原因：
 *    1. 可以在 Node 里直接做单元测试（face-api 的浏览器构建依赖 DOM，
 *       在 Node 中无法加载）
 *    2. 推荐引擎只需这些数据，不必为了拿一个常量而拉入 1.4MB 的 TF.js
 */

/* ==========================================================================
 * 常量
 * ========================================================================== */

/** face-api 模型输出的 7 类标签（顺序固定，与模型内部一致） */
export const EXPRESSION_LABELS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised'
]

/** 7 类表情的中文名 */
export const EXPRESSION_CN = {
  neutral: '平静',
  happy: '开心',
  sad: '悲伤',
  angry: '愤怒',
  fearful: '恐惧',
  disgusted: '厌恶',
  surprised: '惊讶'
}

/**
 * 7 类表情在 Valence-Arousal 二维空间中的坐标
 *
 * Valence (效价):  -1 = 极度负面 ←→ +1 = 极度正面
 * Arousal (唤醒度): 0 = 极度平静 ←→ 1 = 极度激动
 *
 * 取值参考 Russell 环形情绪模型 (Circumplex Model) 与 AffectNet 的
 * VA 标注统计均值：
 *   happy     → V +0.81, A 0.62  (正效价高唤醒)
 *   surprised → V +0.20, A 0.85  (唤醒极高，效价中性偏正)
 *   neutral   → V -0.02, A 0.38  (中性)
 *   sad       → V -0.65, A 0.28  (负效价低唤醒)
 *   angry     → V -0.55, A 0.82  (负效价高唤醒)
 *   fearful   → V -0.62, A 0.78  (负效价高唤醒，指向与愤怒不同)
 *   disgusted → V -0.72, A 0.48  (负效价中唤醒)
 */
export const EMOTION_TO_VA = {
  happy: { v: 0.81, a: 0.62 },
  surprised: { v: 0.2, a: 0.85 },
  neutral: { v: -0.02, a: 0.38 },
  sad: { v: -0.65, a: 0.28 },
  angry: { v: -0.55, a: 0.82 },
  fearful: { v: -0.62, a: 0.78 },
  disgusted: { v: -0.72, a: 0.48 }
}

/** 系统使用的 5 大情绪类别（对 7 类做归并，便于音乐推荐） */
export const MOODS = ['happy', 'calm', 'sad', 'angry', 'fearful']

/** 5 大情绪的中文名 / 文案 / 配色 */
export const MOOD_META = {
  happy: {
    cn: '开心',
    en: 'Happy',
    icon: '☀',
    color: '#f59e0b',
    tagline: '嘴角上扬，眼角有光',
    desc: '检测到明显的正效价高唤醒特征：嘴角提升、脸颊隆起、眼周出现笑纹。',
    advice: '此刻适合把好心情放大——明亮的流行、放克、欢快民谣会让快乐持续更久。'
  },
  calm: {
    cn: '平静',
    en: 'Calm',
    icon: '☁',
    color: '#10b981',
    tagline: '呼吸均匀，神情松弛',
    desc: '面部肌肉张力低，无明显情绪激活：眉宇舒展、嘴唇自然闭合、眼睑放松。',
    advice: '平静是专注与休息的好时机——轻盈的 Lo-fi、氛围音乐、钢琴独奏最合适。'
  },
  sad: {
    cn: '悲伤',
    en: 'Sad',
    icon: '☂',
    color: '#3b82f6',
    tagline: '眉眼低垂，嘴角下沉',
    desc: '检测到负效价低唤醒特征：眉毛内侧上扬、嘴角下拉、眼睑轻度下垂。',
    advice: '先接住情绪再慢慢抬升——先用抒情的低能量歌曲共情，后半段转入温暖治愈曲目。'
  },
  angry: {
    cn: '愤怒',
    en: 'Angry',
    icon: '⚡',
    color: '#ef4444',
    tagline: '眉压眼紧，下颌绷紧',
    desc: '检测到负效价高唤醒特征：眉毛内侧下压、眼睛眯起、唇部收紧或咬合。',
    advice: '高唤醒能量需要一个释放通道——摇滚、金属、说唱宣泄之后再平复。'
  },
  fearful: {
    cn: '焦虑',
    en: 'Anxious',
    icon: '◎',
    color: '#8b5cf6',
    tagline: '眼睑张开，眉心上挑',
    desc: '检测到负效价高唤醒但效价尚未极负的特征：眼睛睁大、眉毛整体上扬。',
    advice: '焦虑需要被"安放"——低唤醒的稳定节奏、白噪音、冥想音乐能快速降低生理唤醒。'
  }
}

/* ==========================================================================
 * 纯函数
 * ========================================================================== */

/**
 * 7 类表情概率 → 5 大情绪概率（软映射，保留概率信息而非取 argmax）
 *
 *   happy    ← happy
 *   sad      ← sad + 0.35 × disgusted   (厌恶常与低落共现)
 *   angry    ← angry + 0.30 × disgusted
 *   fearful  ← fearful + 0.45 × surprised (惊讶在负效价语境下常是恐惧)
 *   calm     ← neutral + 0.15 × sad
 *
 * 之后归一化，使 5 个概率和为 1。
 */
export function expressionsToMoods(expr) {
  const raw = {
    happy: expr.happy || 0,
    sad: (expr.sad || 0) + 0.35 * (expr.disgusted || 0),
    angry: (expr.angry || 0) + 0.3 * (expr.disgusted || 0),
    fearful: (expr.fearful || 0) + 0.45 * (expr.surprised || 0),
    calm: (expr.neutral || 0) + 0.15 * (expr.sad || 0)
  }
  const total = MOODS.reduce((s, m) => s + raw[m], 0) || 1
  const out = {}
  MOODS.forEach((m) => {
    out[m] = raw[m] / total
  })
  return out
}

/**
 * 5 大情绪概率 → VA 坐标（加权质心）
 *
 * 5 大情绪拆回 7 类锚点后按概率加权求和：
 *   happy   → happy
 *   calm    → neutral
 *   sad     → sad
 *   angry   → angry
 *   fearful → 0.69×fearful + 0.31×surprised
 */
export function moodsToVA(moods) {
  const EXPAND = {
    happy: { happy: 1 },
    calm: { neutral: 1 },
    sad: { sad: 1 },
    angry: { angry: 1 },
    fearful: { fearful: 0.69, surprised: 0.31 }
  }
  let v = 0
  let a = 0
  let wsum = 0
  for (const m of MOODS) {
    const p = moods?.[m] || 0
    if (p <= 0) continue
    for (const [expr, w] of Object.entries(EXPAND[m])) {
      v += EMOTION_TO_VA[expr].v * p * w
      a += EMOTION_TO_VA[expr].a * p * w
      wsum += p * w
    }
  }
  return wsum ? { v: v / wsum, a: a / wsum } : { v: 0, a: 0.4 }
}

/** 取主导情绪 */
export function dominantMood(moods) {
  let best = MOODS[0]
  for (const m of MOODS) if ((moods[m] || 0) > (moods[best] || 0)) best = m
  return best
}
