// 诊断：单张演示图识别到底花了多久 / 卡在哪
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const em = window.__em
const log = []

const item = [...document.querySelectorAll('.demo-item')][0]
const t0 = performance.now()
item.click()

// 每 200ms 记一次状态
for (let i = 0; i < 100; i++) {
  await sleep(200)
  const t = Math.round(performance.now() - t0)
  const statusText = document.querySelector('.status-line, .detect-status')?.textContent?.trim() || ''
  const busy = !!document.querySelector('.stage-badge') && document.body.innerText.includes('识别中')
  if (i % 5 === 0 || em?.result) {
    log.push({ t, hasResult: !!em?.result, busy, statusText })
  }
  if (em?.result) break
}

// 直接手动跑一次 detectAll 计时
const blob = await (await fetch('/demo-faces/01-happy.png')).blob()
const bmp = await createImageBitmap(blob)
const c = document.createElement('canvas')
const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
c.width = Math.round(bmp.width * s)
c.height = Math.round(bmp.height * s)
c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)

const tA = performance.now()
em.detector.reset()
const res = await em.detectAll({ canvas: c, scale: s }, false)
const directMs = Math.round(performance.now() - tA)

return JSON.stringify({
  log,
  totalWait: Math.round(performance.now() - t0),
  direct: { ms: directMs, faces: res.length, mood: res[0]?.mood, conf: res[0]?.confidence },
  finalResult: em?.result ? { mood: em.result.mood, hasRecs: !!em.result.recommendations } : null
})
