// 细粒度诊断：点击后 em.result / detectorStatus 的时间线
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 240; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(250)
}

const em = window.__em
const t0 = performance.now()
const timeline = []

const snap = (tag) => {
  timeline.push({
    tag,
    t: Math.round(performance.now() - t0),
    status: em.status,
    hasResult: !!em.result,
    mood: em.result?.mood ?? null
  })
}

snap('before-click')
const item = [...document.querySelectorAll('.demo-item')][0]
item.click()
snap('after-click')

// 每 100ms 采样，直到出结果
let last = ''
for (let i = 0; i < 120; i++) {
  await sleep(100)
  const sig = `${em.status}|${!!em.result}|${document.querySelectorAll('.song-item').length}`
  if (sig !== last) {
    last = sig
    snap('tick')
  }
  if (em.result) break
}
snap('after-result')

return JSON.stringify({ timeline })
