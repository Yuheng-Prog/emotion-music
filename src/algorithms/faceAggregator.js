/**
 * ============================================================================
 *  多人脸聚合模块 —— 从一张图中多张脸得到"整体情绪"
 * ============================================================================
 *
 *  场景：一张合影 / 视频里有多个人。系统需要给出一个用于推荐的最终情绪。
 *
 *  算法：置信度加权的概率混合 (Confidence-weighted Probability Mixture)
 *
 *    P(m) = Σ_i  w_i · p_i(m)   /   Σ_i w_i
 *
 *    w_i = confidence_i × area_i^0.35
 *
 *  - 面积项 ^0.35 的目的是让"离镜头更近的人"权重稍高，但用幂次压缩，
 *    避免一个特写人脸完全压制背景里的人（合影时后排的人也应被计入）。
 *  - 最终置信度取：
 *      conf = max_i(confidence_i) × agreement
 *    其中 agreement = Σ_m min(P(m), p_top(m)) / Σ_m p_top(m)
 *    即"整体分布与最可信那张脸分布的重合度"，用来惩罚"两个人情绪完全不同"
 *    的情况——分歧大时置信度降低，而不是假装确定。
 */

import { MOODS } from './emotionSpace.js'

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))

/**
 * @param {Array<DetectionResult>} detections 各张脸的检测结果
 * @returns {object|null} 聚合后的结果
 */
export function aggregateFaces(detections) {
  const valid = detections.filter(Boolean)
  if (!valid.length) return null

  const weights = valid.map((d) => {
    const area = d.box ? d.box.width * d.box.height : 1
    return Math.max(d.confidence, 0.01) * Math.pow(area, 0.35)
  })
  const wsum = weights.reduce((a, b) => a + b, 0) || 1

  const moods = {}
  for (const m of MOODS) {
    moods[m] = valid.reduce((acc, d, i) => acc + weights[i] * (d.moods[m] || 0), 0) / wsum
  }

  let bestMood = MOODS[0]
  for (const m of MOODS) if (moods[m] > moods[bestMood]) bestMood = m

  // 找最可信的那张脸作为"主脸"，用其分布计算一致性
  let topIdx = 0
  valid.forEach((d, i) => {
    if (d.confidence > valid[topIdx].confidence) topIdx = i
  })
  const top = valid[topIdx]

  let overlap = 0
  let topSum = 0
  for (const m of MOODS) {
    overlap += Math.min(moods[m], top.moods[m])
    topSum += top.moods[m]
  }
  const agreement = clamp(overlap / (topSum || 1), 0, 1)

  // 主导情绪是否与主脸一致
  const sameMood = top.mood === bestMood

  const confidence = clamp(top.confidence * (0.6 + 0.4 * agreement) * (sameMood ? 1 : 0.75), 0, 1)

  return {
    moods,
    mood: bestMood,
    confidence,
    faceCount: valid.length,
    agreement,
    dominantFaceIndex: topIdx,
    faces: valid,
    // 一致度低于 0.7 即视为"分歧"：两个人情绪完全相反时 agreement≈0.5，
    // 阈值放在 0.7 能覆盖"一人皱眉一人微笑"这类真实冲突场景
    mixed: valid.length > 1 && agreement < 0.7
  }
}

/** 描述多人场景的一句话 */
export function describeMultiFace(agg) {
  if (!agg) return ''
  if (agg.faceCount === 1) return '检测到 1 张人脸'
  const ok = agg.agreement >= 0.85 ? '情绪高度一致' : agg.agreement >= 0.7 ? '情绪大体一致' : '情绪分歧明显'
  return `检测到 ${agg.faceCount} 张人脸 · ${ok} (一致度 ${(agg.agreement * 100).toFixed(0)}%)`
}
