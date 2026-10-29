/**
 * ============================================================================
 *  歌曲推荐算法 (Music Recommendation Engine)
 * ============================================================================
 *
 *  【核心思想】
 *
 *  把「情绪」和「歌曲」放到同一个二维空间里比距离。
 *
 *   情绪侧：EmotionDetector.moodsToVA() 把 5 大情绪概率投影成 (v, a)
 *   歌曲侧：每首歌自带标注的 (valence, arousal, energy) 三元组
 *
 *  推荐打分由 4 个分量加权组成：
 *
 *    Score(s) = w1 · VA_Sim(s)          ┐ 情绪空间相似度 (主项)
 *             + w2 · MoodMatch(s)       │ 离散情绪标签命中
 *             + w3 · StrategyFit(s)     │ 推荐策略契合 (共情/调节)
 *             + w4 · QualityPrior(s)    │ 先验质量分
 *             - w5 · DiversityPenalty   ┘ 多样性惩罚
 *
 * ----------------------------------------------------------------------------
 *  【1. VA 相似度】
 *
 *    VA_Sim(s) = 1 - dist(va_emotion, va_song) / sqrt(2·2²)
 *
 *    其中 dist 用「椭球距离」而不是欧氏距离，因为唤醒度 (A) 的可感知
 *    差异比效价 (V) 更敏感：
 *
 *      dist = sqrt( ((ΔV)/1.0)² + ((ΔA)/0.72)² ) / sqrt(2)
 *
 *    归一化到 [0,1] 后取 1-dist。
 *
 * ----------------------------------------------------------------------------
 *  【2. 推荐策略 (Strategy) —— 本系统的关键设计】
 *
 *    单纯"你难过就推悲伤的歌"会让用户更难过。音乐心理学研究表明：
 *      - 「共情/同频」(Iso-principle) 先接住情绪，降低抗拒
 *      - 「情绪调节」(Mood repair) 再逐步引导到目标状态
 *
 *    所以本系统提供三种策略，用户可切换：
 *
 *    ┌──────────┬─────────────────────────────────────────────┐
 *    │ 同频镜像 │ 推荐与当前情绪 VA 距离最近的歌 (Iso-principle) │
 *    │ 情绪修复 │ 偏向"比当前稍好一点"的目标点 (渐进抬升)       │
 *    │ 情绪反转 │ 推荐与当前情绪相反的歌 (转移注意力)           │
 *    └──────────┴─────────────────────────────────────────────┘
 *
 *    情绪调节的目标点计算 (Mood Repair Target)：
 *
 *      v_target = v + (v_preferred - v) · α
 *      a_target = a + (a_target_base - a) · β
 *
 *      v_preferred = 0.55 (略偏正效价，不是极端快乐)
 *      a_target_base 按情绪决定：
 *        angry/fearful → 0.35 (先降唤醒，再谈心情)
 *        sad           → 0.45
 *        calm          → 0.45
 *        happy         → 0.62 (保持)
 *      α = 0.55, β = 0.5   —— 只走一半，避免"跳变"
 *
 *    这样愤怒的人会先听到"稍平静一点的歌"，而不是直接被塞一首儿歌。
 *
 * ----------------------------------------------------------------------------
 *  【3. 多样性惩罚 (MMR-like)】
 *
 *    用最大边际相关性 (Maximal Marginal Relevance) 的简化版：
 *    逐首挑选时，对已选歌曲做相似度惩罚，避免推荐列表全是同质曲目。
 *
 *      Score_final(s) = Score(s) - δ · max_{s' ∈ Selected} sim(s, s')
 *
 *    sim 用「演唱者 + 情绪标签 + VA 距离」的加权相似度。
 *    δ 随已选数量线性增长，越往后越强调多样性。
 */

import { MOODS, moodsToVA } from './emotionSpace.js'

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

/* ==========================================================================
 * 策略定义
 * ========================================================================== */

export const STRATEGIES = {
  empathy: {
    key: 'empathy',
    name: '同频镜像',
    icon: '♡',
    desc: '像镜子一样映出你当下的情绪，推荐与你最接近的歌，让情绪被理解、被接住。',
    detail: '基于 Iso-principle（同频原则）：先与听者情绪同步（镜像），音乐才更容易被接受。'
  },
  repair: {
    key: 'repair',
    name: '情绪修复',
    icon: '↗',
    desc: '从当前情绪出发，向"更好一点"的方向渐进修复。',
    detail: '目标点只移动一半距离，避免情绪跳变带来的割裂感。'
  },
  reverse: {
    key: 'reverse',
    name: '情绪反转',
    icon: '⇄',
    desc: '推荐与你当前情绪相反的歌，用反差感转移注意力。',
    detail: '把目标点放到 VA 空间的对径位置，适合需要"打断"负面循环时使用。'
  }
}

/** 情绪调节策略下的目标参数 */
const REPAIR_TARGET = {
  happy: { vPref: 0.6, aBase: 0.62 },
  calm: { vPref: 0.55, aBase: 0.45 },
  sad: { vPref: 0.5, aBase: 0.45 },
  angry: { vPref: 0.4, aBase: 0.35 },
  fearful: { vPref: 0.45, aBase: 0.32 }
}

/* ==========================================================================
 * 核心几何工具
 * ========================================================================== */

/**
 * VA 空间椭球距离 (已归一化到 0~1)
 * A 轴压缩系数 0.72 表示唤醒度的差异被放大（更敏感）
 */
export function vaDistance(v1, a1, v2, a2) {
  const dv = (v1 - v2) / 1.0
  const da = (a1 - a2) / 0.72
  return Math.sqrt(dv * dv + da * da) / Math.SQRT2
}

/** VA 相似度 [0,1] */
export function vaSimilarity(v1, a1, v2, a2) {
  return clamp(1 - vaDistance(v1, a1, v2, a2), 0, 1)
}

/** 根据策略算出「目标 VA 点」 */
export function computeTargetVA(mood, va, strategyKey) {
  const { v, a } = va
  if (strategyKey === 'empathy') {
    return { v, a, label: '你的情绪坐标' }
  }
  if (strategyKey === 'reverse') {
    // 对径点：效价翻转，唤醒度也做镜像压缩
    return {
      v: clamp(-v * 0.85 + 0.1, -1, 1),
      a: clamp(1 - a * 0.8, 0.15, 0.95),
      label: '情绪对径点'
    }
  }
  // repair
  const cfg = REPAIR_TARGET[mood] || REPAIR_TARGET.calm
  return {
    v: clamp(v + (cfg.vPref - v) * 0.55, -1, 1),
    a: clamp(a + (cfg.aBase - a) * 0.5, 0.05, 1),
    label: '情绪调节目标'
  }
}

/* ==========================================================================
 * 打分
 * ========================================================================== */

const WEIGHTS = {
  va: 0.46,
  mood: 0.24,
  energy: 0.14,
  quality: 0.16
}

/**
 * 单首歌对给定情绪/策略的原始得分 (不含多样性惩罚)
 *
 * @param {object} song  歌曲元数据
 * @param {object} ctx   { targetVA, mood, moods, strategy }
 */
export function scoreSong(song, ctx) {
  const { targetVA, mood } = ctx
  const t = targetVA

  // ---- 分量 1: VA 相似度 ----
  const vaSim = vaSimilarity(t.v, t.a, song.valence, song.arousal)

  // ---- 分量 2: 离散情绪标签命中 ----
  //   song.moods 是「情绪 → 适配权重」的对象，例如 { sad: 0.94, calm: 0.35 }
  //
  //   命中分 = Σ_m  P_emotion(m) × W_song(m)
  //   即：用户越偏向某情绪，该曲在对应情绪标签上的权重贡献越大。
  //   若主导情绪被该曲明确标注，则至少给到 W_song(mood) × 0.9 的下限，
  //   避免「用户 95% 悲伤，曲目 0.94 悲伤」却因为其他情绪分摊而得分偏低。
  let moodMatch = 0
  const hasMoodMap = song.moods && typeof song.moods === 'object' && !Array.isArray(song.moods)
  if (hasMoodMap && Object.keys(song.moods).length) {
    for (const [m, w] of Object.entries(song.moods)) {
      moodMatch += (ctx.moods?.[m] || 0) * (w || 0)
    }
    if (song.moods[mood]) moodMatch = Math.max(moodMatch, song.moods[mood] * 0.9)
  } else if (song.mood) {
    // 兼容旧的单标签写法
    moodMatch = song.mood === mood ? 1 : 0
  }
  moodMatch = clamp(moodMatch, 0, 1)

  // ---- 分量 3: 能量匹配 ----
  //   目标能量由目标唤醒度推出：能量 ≈ 唤醒度
  const energySim = clamp(1 - Math.abs((song.energy ?? song.arousal) - t.a) / 1.0, 0, 1)

  // ---- 分量 4: 先验质量分 ----
  const quality = clamp(song.rating ?? 0.6, 0, 1)

  const raw =
    WEIGHTS.va * vaSim +
    WEIGHTS.mood * moodMatch +
    WEIGHTS.energy * energySim +
    WEIGHTS.quality * quality

  return {
    raw,
    vaSim,
    moodMatch,
    energySim,
    quality
  }
}

/** 两首歌之间的相似度 (用于多样性惩罚) */
function songSimilarity(a, b) {
  let sim = 0
  // VA 接近度
  sim += 0.6 * vaSimilarity(a.valence, a.arousal, b.valence, b.arousal)
  // 同歌手
  if (a.artist && b.artist && a.artist === b.artist) sim += 0.25
  // 情绪标签重合
  const am = Object.keys(a.moods || { mood: 1 })
  const bm = Object.keys(b.moods || { mood: 1 })
  const overlap = am.filter((k) => bm.includes(k)).length
  const union = new Set([...am, ...bm]).size || 1
  sim += 0.15 * (overlap / union)
  return clamp(sim, 0, 1)
}

/**
 * 主推荐函数
 *
 * @param {Array} pool        候选歌曲池 (本地 + 在线)
 * @param {object} emotion    情绪结果 { mood, moods, confidence, ... }
 * @param {object} options    { strategy, limit, excludeIds, seed }
 * @returns {Array} 排序后的推荐列表，每项含 score + reasons
 */
export function recommendSongs(pool, emotion, options = {}) {
  const {
    strategy = 'repair',
    limit = 10,
    excludeIds = [],
    allowLocalOnly = false
  } = options

  if (!pool || !pool.length) return []

  const va = getVAFromEmotion(emotion)
  const targetVA = computeTargetVA(emotion.mood, va, strategy)
  const ctx = {
    targetVA,
    /** 用户当前情绪坐标（区别于策略目标点 targetVA） */
    va,
    mood: emotion.mood,
    moods: emotion.moods,
    strategy
  }

  const excluded = new Set(excludeIds)

  // ---- 第一轮：计算原始分 ----
  const scored = pool
    .filter((s) => !excluded.has(s.id))
    .map((song) => {
      const parts = scoreSong(song, ctx)
      return { ...song, _parts: parts, _score: parts.raw }
    })

  if (!scored.length) return []

  // ---- 第二轮：MMR 多样性重排 ----
  const selected = []
  const rest = [...scored]
  const deltaBase = 0.34

  while (selected.length < limit && rest.length) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < rest.length; i++) {
      const cand = rest[i]
      const delta = deltaBase * (selected.length / Math.max(limit - 1, 1))
      const maxSim = selected.length
        ? Math.max(...selected.map((s) => songSimilarity(cand, s)))
        : 0
      const adjusted = cand._score - delta * maxSim
      if (adjusted > bestScore) {
        bestScore = adjusted
        bestIdx = i
      }
    }
    const [picked] = rest.splice(bestIdx, 1)
    picked._finalScore = bestScore
    selected.push(picked)
  }

  // ---- 第三轮：生成推荐理由 ----
  return selected.map((s, i) => {
    const reasons = buildReasons(s, ctx, strategy, i)
    return {
      ...s,
      score: s._finalScore,
      matchPercent: Math.round(clamp(s._finalScore, 0, 1) * 100),
      reasons,
      rank: i + 1
    }
  })
}

/** 从情绪结果取 VA 坐标 */
export function getVAFromEmotion(emotion) {
  if (!emotion) return { v: 0, a: 0.4 }
  if (emotion.va) return emotion.va
  return moodsToVA(emotion.moods || {})
}

/**
 * 生成可读的推荐理由
 *
 * 注意：vaSim 衡量的是「歌曲坐标 → 策略目标坐标」的接近程度，
 * 它**不是**「歌曲坐标 → 用户当前情绪」的接近程度。
 * 在同频策略下两者恰好等价，但在反转策略下目标点是对称的，
 * 说成"情绪接近"会与"形成反差"自相矛盾，所以措辞必须按策略区分。
 */
function buildReasons(song, ctx, strategyKey, index) {
  const reasons = []
  const { targetVA, mood, va } = ctx

  const vaSim = song._parts.vaSim
  const energySim = song._parts.energySim

  // 歌曲相对用户当前情绪的效价差距（>0 表示更明亮）
  const dvUser = song.valence - (va?.v ?? 0)

  if (strategyKey === 'reverse') {
    // 反转：越接近"镜像目标点"越是好选择
    if (vaSim > 0.82) reasons.push(`与当前情绪形成强镜像 (目标匹配 ${(vaSim * 100).toFixed(0)}%)`)
    else if (vaSim > 0.65) reasons.push(`与当前情绪走向相反 (目标匹配 ${(vaSim * 100).toFixed(0)}%)`)
  } else if (strategyKey === 'repair') {
    if (vaSim > 0.82) reasons.push(`精准落在情绪过渡目标区间 (匹配 ${(vaSim * 100).toFixed(0)}%)`)
    else if (vaSim > 0.65) reasons.push(`接近情绪过渡目标 (匹配 ${(vaSim * 100).toFixed(0)}%)`)
  } else {
    // 同频：目标点就是用户当前坐标，可以说"情绪接近"
    if (vaSim > 0.82) reasons.push(`情绪坐标高度吻合 (VA 相似度 ${(vaSim * 100).toFixed(0)}%)`)
    else if (vaSim > 0.65) reasons.push(`情绪接近 (VA 相似度 ${(vaSim * 100).toFixed(0)}%)`)
  }

  if (strategyKey === 'empathy') {
    reasons.push(`同频镜像：与你的「${moodName(mood)}」状态共振`)
  } else if (strategyKey === 'repair') {
    const dv = song.valence - targetVA.v
    if (Math.abs(dv) < 0.25) reasons.push('处于情绪过渡的中间地带，听感不突兀')
    else if (dv > 0) reasons.push('效价略高于当前状态，温和抬升心情')
  } else {
    // 反转：明确点出"比当前更明亮 / 更沉静"，让用户理解选曲逻辑
    if (dvUser > 0.2) reasons.push('比当前状态明亮许多，帮助注意力转移')
    else if (dvUser < -0.2) reasons.push('与当前情绪形成反差，帮助注意力转移')
    else reasons.push('换了情绪象限，但强度相近，切换不刺耳')
  }

  if (energySim > 0.85) reasons.push('节奏能量与目标唤醒度匹配')
  if (song.rating >= 0.85) reasons.push('曲目质量评分较高')
  if (index === 0) reasons.push('综合评分第一')

  if (song.source === 'online') reasons.push('来自在线曲库')
  else if (song.source === 'local') reasons.push('本地曲库，可离线播放')

  return reasons.slice(0, 4)
}

function moodName(m) {
  return { happy: '开心', calm: '平静', sad: '悲伤', angry: '愤怒', fearful: '焦虑' }[m] || m
}

/* ==========================================================================
 * 推荐结果的可解释性：给每个分量返回归一化后的贡献占比
 * 用于 UI 展示"为什么推这首歌"
 * ========================================================================== */
export function explainScore(song) {
  if (!song._parts) return []
  const p = song._parts
  const items = [
    { label: '情绪坐标', value: WEIGHTS.va * p.vaSim, ratio: p.vaSim, weight: WEIGHTS.va },
    { label: '情绪标签', value: WEIGHTS.mood * p.moodMatch, ratio: p.moodMatch, weight: WEIGHTS.mood },
    { label: '节奏能量', value: WEIGHTS.energy * p.energySim, ratio: p.energySim, weight: WEIGHTS.energy },
    { label: '曲目质量', value: WEIGHTS.quality * p.quality, ratio: p.quality, weight: WEIGHTS.quality }
  ]
  const total = items.reduce((s, i) => s + i.value, 0) || 1
  return items.map((i) => ({ ...i, percent: Math.round((i.value / total) * 100) }))
}
