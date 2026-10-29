// 诊断：第一次点演示图的 6 秒到底花在哪
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 等模型就绪
let modelReadyAt = null
for (let i = 0; i < 240; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) {
    modelReadyAt = Math.round(performance.now())
    break
  }
  await sleep(250)
}

const em = window.__em
const t0 = performance.now()

// 手动分阶段计时：取帧 → 检测 → 聚合
const item = [...document.querySelectorAll('.demo-item')][0]
item.click()

const stages = []
// 记录 em.result 出现的时刻
let tResult = null
for (let i = 0; i < 200; i++) {
  await sleep(50)
  if (em?.result) {
    tResult = Math.round(performance.now() - t0)
    break
  }
}

// 手动再跑一次同样的流程，测纯检测耗时
const blob = await (await fetch('/demo-faces/01-happy.png')).blob()
const bmp = await createImageBitmap(blob)
const c = document.createElement('canvas')
const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
c.width = Math.round(bmp.width * s)
c.height = Math.round(bmp.height * s)
c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)

const tA = performance.now()
em.detector.reset()
const r1 = await em.detectAll({ canvas: c, scale: s }, false)
const firstDetectMs = Math.round(performance.now() - tA)

const tB = performance.now()
em.detector.reset()
const r2 = await em.detectAll({ canvas: c, scale: s }, false)
const secondDetectMs = Math.round(performance.now() - tB)

return JSON.stringify({
  modelReadyAt,
  tResult,
  firstDetectMs,
  secondDetectMs,
  firstFaces: r1.length,
  secondFaces: r2.length,
  nav: performance.getEntriesByType('navigation').map((n) => ({
    domContentLoaded: Math.round(n.domContentLoadedEventEnd),
    load: Math.round(n.loadEventEnd)
  })),
  resources: performance
    .getEntriesByType('resource')
    .filter((r) => /model|\.bin|\.json/.test(r.name))
    .map((r) => ({ name: r.name.split('/').pop(), ms: Math.round(r.duration), size: r.transferSize }))
})
