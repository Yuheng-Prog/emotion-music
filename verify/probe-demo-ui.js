// UI 验收：演示样张选择器是否能点选并驱动识别 + 推荐
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const steps = []

// 1) 演示条是否渲染
const strip = document.querySelector('.demo-strip')
const items = [...document.querySelectorAll('.demo-item')]
steps.push({ step: 'strip-rendered', ok: !!strip, items: items.length })

if (!items.length) return JSON.stringify({ steps })

// 2) 依次点击三张有代表性的演示图，检查识别结果与推荐是否更新
const targets = [0, 3, 7] // 开心 / 愤怒 / 合影
for (const idx of targets) {
  const item = items[idx]
  const label = item.querySelector('.demo-label')?.textContent?.trim()
  item.click()

  // 等识别完成：状态从「识别中」回到就绪且有结果
  let done = false
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    const em = window.__em
    if (em && em.result) {
      done = true
      break
    }
  }

  // 推荐链路：识别完成 → 1.2s 稳定判定 → 本地秒出 → 在线召回补齐。
  // 一张图的最坏等待约 1.2s + 在线召回 7s，这里轮询 12s 兜底
  let recCards = []
  for (let i = 0; i < 48; i++) {
    await sleep(250)
    recCards = document.querySelectorAll('.song-item')
    if (recCards.length >= 12) break
  }
  const em = window.__em
  const r = em?.result
  steps.push({
    step: 'pick-' + idx,
    label,
    done,
    mood: r?.mood ?? r?.aggregate?.mood ?? null,
    confidence: r?.confidence ? +r.confidence.toFixed(3) : null,
    faces: r?.faces?.length ?? r?.all?.length ?? null,
    activeClass: item.className.includes('active'),
    recCards: recCards.length,
    badgeText: document.querySelector('.stage-badge')?.textContent?.trim() || ''
  })
}

return JSON.stringify({ steps })
