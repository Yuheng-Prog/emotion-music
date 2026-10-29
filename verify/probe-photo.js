// 拍照模式验证：摄像头开启 → 拍照 → 检查是否生成静态画面并触发识别
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const out = {}

// 切到拍照模式
const tabs = [...document.querySelectorAll('.mode-tab')]
out.tabs = tabs.map((t) => t.textContent.trim())
tabs.find((t) => t.textContent.includes('拍照')).click()
await sleep(1200)

// 拍照模式也需要先开启摄像头
const startBtn = [...document.querySelectorAll('button')].find((b) =>
  b.textContent.includes('开启摄像头')
)
out.hasStartBtn = !!startBtn
if (startBtn) {
  startBtn.click()
  await sleep(4000)
}

const camVideo = document.querySelector('video')
out.camReady = camVideo ? { readyState: camVideo.readyState, w: camVideo.videoWidth, h: camVideo.videoHeight, playing: !camVideo.paused } : null

// 找拍照按钮
const btns = [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
out.buttons = btns.filter((b) => b && b.length < 12)
const shotBtn = [...document.querySelectorAll('button')].find(
  (b) => b.textContent.includes('拍照') && !b.classList.contains('mode-tab')
)
out.hasShotBtn = !!shotBtn

if (shotBtn) {
  shotBtn.click()
  await sleep(2500)
}

// 拍照后应出现 img（静态截图）
out.afterImage = !!document.querySelector('.stage img')
out.stageBadge = document.querySelector('.stage-badge')?.textContent || ''
out.status = window.__em?.status
out.error = window.__em?.error
out.faces = document.querySelectorAll('.face-box').length
out.hasMood = !!document.querySelector('.mood-name')
out.mood = document.querySelector('.mood-name')?.textContent?.trim() || ''

return JSON.stringify(out)
