// 验收：点演示图后「秒出」首屏 + 在线结果异步补齐
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const em = window.__em
const items = [...document.querySelectorAll('.demo-item')]
const out = []

// 依次点 开心 / 焦虑（fearful 在线最慢 7.3s）/ 合影
for (const idx of [0, 4, 7]) {
  const item = items[idx]
  const label = item.querySelector('.demo-label')?.textContent?.trim()
  const t0 = performance.now()
  item.click()

  // 等到结果对象出现
  let tResult = null
  for (let i = 0; i < 200; i++) {
    await sleep(50)
    if (em?.result) {
      tResult = Math.round(performance.now() - t0)
      break
    }
  }

  // 等到第一版推荐列表出现
  let tFirst = null
  let firstN = 0
  for (let i = 0; i < 400; i++) {
    await sleep(50)
    const n = document.querySelectorAll('.song-item').length
    if (n > 0) {
      tFirst = Math.round(performance.now() - t0)
      firstN = n
      break
    }
  }

  // 等到在线召回结束（列表条数或来源变化）
  let tFull = null
  let fullN = 0
  let onlineBadge = ''
  for (let i = 0; i < 400; i++) {
    await sleep(100)
    const n = document.querySelectorAll('.song-item').length
    const txt = document.body.innerText
    const settled = !txt.includes('正在从在线曲库召回')
    if (settled && n > 0 && performance.now() - t0 > (tFirst || 0) + 200) {
      tFull = Math.round(performance.now() - t0)
      fullN = n
      const m = txt.match(/(\d+)\s*在线/)
      onlineBadge = m ? m[1] : '0'
      break
    }
  }

  out.push({
    label,
    mood: em?.result?.mood ?? null,
    conf: em?.result?.confidence ? +em.result.confidence.toFixed(3) : null,
    faces: em?.result?.faces?.length ?? null,
    tResult,
    tFirstRec: tFirst,
    firstCount: firstN,
    tFull,
    fullCount: fullN,
    onlineCount: onlineBadge
  })
}

return JSON.stringify(out)
