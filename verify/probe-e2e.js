// 端到端流程验证
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = []

let waited = 0
while (waited < 60000) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
  waited += 500
}
log.push('model=ready @' + waited + 'ms')

// ---- 1. 载入图片 ----
const resp = await fetch('/verify-faces/cover-14.jpg')
const blob = await resp.blob()
const input = document.querySelector('.hidden-input')
const dt = new DataTransfer()
dt.items.add(new File([blob], 'p.jpg', { type: 'image/jpeg' }))
input.files = dt.files
input.dispatchEvent(new Event('change', { bubbles: true }))

const t0 = Date.now()
while (Date.now() - t0 < 25000) {
  await sleep(350)
  if (document.querySelectorAll('.song-item').length > 0) break
}

const snap = () => ({
  mood: document.querySelector('.mood-name')?.textContent?.replace(/\s+/g, ' ').trim() || '',
  conf: document.querySelector('.conf-num')?.textContent || '',
  va: document.querySelector('.head-hint')?.textContent?.trim() || '',
  recs: document.querySelectorAll('.song-item').length,
  firstTitle: document.querySelector('.song-item .title')?.textContent || '',
  firstArtist: document.querySelector('.song-item .artist')?.textContent || '',
  firstScore: document.querySelector('.song-item .score-num')?.textContent || '',
  reasons: [...document.querySelectorAll('.song-item')][0]
    ? [...document.querySelectorAll('.song-item')[0].querySelectorAll('.reason')].map((e) => e.textContent)
    : [],
  strategy: document.querySelector('.strategy-tab.active')?.textContent?.trim() || '',
  onlineState: document.querySelector('.online-state')?.textContent?.trim() || ''
})

log.push(JSON.stringify({ step: '1-载入图片', ...snap() }))

// ---- 2. 切到「情绪调节」策略（若默认不是） ----
const repairTab = [...document.querySelectorAll('.strategy-tab')].find((b) => b.textContent.includes('情绪修复'))
repairTab.click()
await sleep(3000)
log.push(JSON.stringify({ step: '2-情绪修复策略', ...snap() }))

// ---- 3. 切到「同频共鸣」 ----
const empTab = [...document.querySelectorAll('.strategy-tab')].find((b) => b.textContent.includes('同频镜像'))
empTab.click()
await sleep(3000)
log.push(JSON.stringify({ step: '3-同频镜像策略', ...snap() }))

// ---- 4. 切到「情绪反转」 ----
const revTab = [...document.querySelectorAll('.strategy-tab')].find((b) => b.textContent.includes('情绪反转'))
revTab.click()
await sleep(3000)
log.push(JSON.stringify({ step: '4-情绪反转策略', ...snap() }))

// ---- 5. 展开打分拆解 ----
const expandBtn = document.querySelector('.song-item .expand-btn')
if (expandBtn) expandBtn.click()
await sleep(800)
log.push(
  JSON.stringify({
    step: '5-打分拆解',
    chips: [...document.querySelectorAll('.song-item .bd-chip')].map((e) => e.textContent),
    bdReasons: [...document.querySelectorAll('.song-item .bd-reasons li')].map((e) => e.textContent)
  })
)

// ---- 6. 播放第一首 ----
const playBtn = document.querySelector('.song-item .tooggle')
if (playBtn) playBtn.click()
await sleep(4000)
const audio = document.querySelector('audio')
log.push(
  JSON.stringify({
    step: '6-播放',
    hasAudio: !!audio,
    src: (audio?.src || '').replace(location.origin, '').slice(0, 70),
    paused: audio?.paused,
    currentTime: Math.round((audio?.currentTime || 0) * 10) / 10,
    duration: Math.round(audio?.duration || 0),
    readyState: audio?.readyState,
    error: audio?.error ? audio.error.code : null,
    npTitle: document.querySelector('.np-title')?.textContent || '',
    playerErr: document.querySelector('.err-tip')?.textContent || ''
  })
)

// ---- 7. 打开算法说明 ----
document.querySelector('.doc-btn').click()
await sleep(700)
const docTabs = [...document.querySelectorAll('.doc-tabs button')].map((b) => b.textContent.trim())
const docH3 = [...document.querySelectorAll('.doc-body h3')].slice(0, 4).map((e) => e.textContent)
log.push(JSON.stringify({ step: '7-算法说明', docTabs, docH3, formulas: document.querySelectorAll('.formula').length }))
document.querySelector('.close').click()
await sleep(400)

return JSON.stringify(log, null, 1)
