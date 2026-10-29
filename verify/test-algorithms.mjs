// 算法单元测试（纯逻辑，不依赖浏览器 / TensorFlow）
// 项目源码的 import 省略了 .js（给 Vite 用），Node 需要 loader 补全
import { register } from 'node:module'

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if (specifier.startsWith('.') && !/\\.[a-z]+$/.test(specifier)) {
      return next(specifier + '.js', context)
    }
    throw e
  }
}
`)
)

const { recommendSongs, scoreSong, computeTargetVA, getVAFromEmotion, vaSimilarity, STRATEGIES } =
  await import('../src/algorithms/recommender.js')
const { LOCAL_SONGS, ONLINE_MOOD_ANCHOR } = await import('../src/data/songs.js')
const { expressionsToMoods, moodsToVA, MOODS, dominantMood } = await import(
  '../src/algorithms/emotionSpace.js'
)
const { aggregateFaces } = await import('../src/algorithms/faceAggregator.js')

const out = []
const hr = (t) => out.push('\n' + '─'.repeat(66) + '\n' + t + '\n' + '─'.repeat(66))

/* ============ 1. 7类→5类 映射 ============ */
hr('测试 1：7 类表情 → 5 大情绪（软映射）')
const cases = [
  ['纯开心', { neutral: 0.02, happy: 0.9, sad: 0.01, angry: 0.01, fearful: 0.01, disgusted: 0.01, surprised: 0.04 }],
  ['纯悲伤', { neutral: 0.05, happy: 0.01, sad: 0.85, angry: 0.02, fearful: 0.03, disgusted: 0.03, surprised: 0.01 }],
  ['纯愤怒', { neutral: 0.04, happy: 0.01, sad: 0.02, angry: 0.88, fearful: 0.02, disgusted: 0.02, surprised: 0.01 }],
  ['纯惊讶', { neutral: 0.05, happy: 0.03, sad: 0.01, angry: 0.01, fearful: 0.05, disgusted: 0.01, surprised: 0.84 }],
  ['纯平静', { neutral: 0.9, happy: 0.03, sad: 0.02, angry: 0.01, fearful: 0.01, disgusted: 0.01, surprised: 0.02 }],
  ['厌恶混合', { neutral: 0.05, happy: 0.02, sad: 0.2, angry: 0.25, fearful: 0.03, disgusted: 0.44, surprised: 0.01 }]
]
for (const [name, expr] of cases) {
  const m = expressionsToMoods(expr)
  const sum = MOODS.reduce((s, k) => s + m[k], 0)
  const va = moodsToVA(m)
  out.push(
    `${name.padEnd(8)} → 主导=${dominantMood(m).padEnd(8)} ` +
      `概率[${MOODS.map((k) => k + ':' + m[k].toFixed(2)).join(' ')}] ` +
      `Σ=${sum.toFixed(6)} VA=(${va.v.toFixed(2)},${va.a.toFixed(2)})`
  )
}

/* ============ 2. 策略目标点 ============ */
hr('测试 2：三种策略的目标 VA 点')
const emo = {
  mood: 'sad',
  moods: { happy: 0.05, calm: 0.1, sad: 0.75, angry: 0.05, fearful: 0.05 }
}
const va = getVAFromEmotion(emo)
out.push(`当前情绪(sad) VA = ${JSON.stringify({ v: +va.v.toFixed(3), a: +va.a.toFixed(3) })}`)
for (const k of Object.keys(STRATEGIES)) {
  const t = computeTargetVA('sad', va, k)
  out.push(
    `${STRATEGIES[k].name}: target=(${t.v.toFixed(3)}, ${t.a.toFixed(3)})  ` +
      `与当前情绪 VA 相似度=${(vaSimilarity(va.v, va.a, t.v, t.a) * 100).toFixed(0)}%`
  )
}

/* ============ 3. 单曲打分分量 ============ */
hr('测试 3：单曲打分分量（sad 情绪，同频策略）')
const ctx = {
  targetVA: computeTargetVA('sad', va, 'empathy'),
  mood: 'sad',
  moods: emo.moods,
  strategy: 'empathy'
}
const pool = LOCAL_SONGS
for (const s of pool.slice(0, 6)) {
  const p = scoreSong(s, ctx)
  out.push(
    `  ${s.title.padEnd(20)} VA=${(p.vaSim * 100).toFixed(0).padStart(3)} ` +
      `标签=${(p.moodMatch * 100).toFixed(0).padStart(3)} ` +
      `能量=${(p.energySim * 100).toFixed(0).padStart(3)} ` +
      `质量=${(p.quality * 100).toFixed(0).padStart(3)} → 加权 ${(p.raw * 100).toFixed(1)}`
  )
}

/* ============ 4. 三种策略的排序结果 ============ */
hr('测试 4：完整推荐排序（16 首本地曲库，取前 5）')
const sadEmo = { mood: 'sad', moods: { happy: 0.03, calm: 0.08, sad: 0.82, angry: 0.04, fearful: 0.03 } }
for (const k of Object.keys(STRATEGIES)) {
  const rec = recommendSongs(LOCAL_SONGS, sadEmo, { strategy: k, limit: 5 })
  out.push(`\n【${STRATEGIES[k].name}】`)
  for (const r of rec) {
    out.push(`  ${r.rank}. ${r.title.padEnd(20)} ${String(r.matchPercent).padStart(3)}%  ${r.reasons[0] || ''}`)
  }
}

/* ============ 5. 五种情绪的推荐差异 ============ */
hr('测试 5：五种情绪下「情绪调节」策略的首推曲目')
for (const m of MOODS) {
  const e = { mood: m, moods: Object.fromEntries(MOODS.map((x) => [x, x === m ? 0.85 : 0.0375])) }
  const rec = recommendSongs(LOCAL_SONGS, e, { strategy: 'repair', limit: 3 })
  out.push(
    `${m.padEnd(8)} → ` +
      rec.map((r) => `${r.title}(${r.matchPercent}%)`).join(' , ')
  )
}

/* ============ 6. 多人脸聚合 ============ */
hr('测试 6：多人脸聚合')
const mkFace = (mood, conf, size) => ({
  mood,
  confidence: conf,
  box: { x: 0, y: 0, width: size, height: size },
  moods: Object.fromEntries(MOODS.map((k) => [k, k === mood ? 0.8 : 0.05]))
})
const one = aggregateFaces([mkFace('happy', 0.8, 200)])
out.push(
  `  单人: mood=${one.mood} conf=${(one.confidence * 100).toFixed(0)}% 一致度=${(one.agreement * 100).toFixed(0)}% 混合=${one.mixed}`
)
const two = aggregateFaces([mkFace('happy', 0.7, 220), mkFace('happy', 0.65, 180)])
out.push(
  `  双人同调: mood=${two.mood} conf=${(two.confidence * 100).toFixed(0)}% 一致度=${(two.agreement * 100).toFixed(0)}% 混合=${two.mixed}`
)
const clash = aggregateFaces([mkFace('happy', 0.8, 220), mkFace('sad', 0.75, 200)])
out.push(
  `  双人冲突: mood=${clash.mood} conf=${(clash.confidence * 100).toFixed(0)}% 一致度=${(clash.agreement * 100).toFixed(0)}% 混合=${clash.mixed}`
)

console.log(out.join('\n'))
