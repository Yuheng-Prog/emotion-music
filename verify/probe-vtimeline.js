// 最终定位：视频自动识别为什么没生效
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const out = {}

// 合成视频
const img = new Image()
await new Promise((res) => {
  img.onload = res
  img.src = '/verify-faces/cover-14.jpg'
})
const cv = document.createElement('canvas')
cv.width = 640
cv.height = 480
cv.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;z-index:9999;opacity:.01;'
document.body.appendChild(cv)
const g = cv.getContext('2d', { willReadFrequently: true })
const draw = () => {
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 640, 480)
  g.drawImage(img, 0, 0, 640, 480)
}
draw()
const stream = cv.captureStream(0)
const track = stream.getVideoTracks()[0]
const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
const chunks = []
rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
rec.start()
for (let i = 0; i < 40; i++) {
  draw()
  track.requestFrame()
  await sleep(40)
}
await new Promise((r) => {
  rec.onstop = r
  rec.stop()
})
const blob = new Blob(chunks, { type: 'video/webm' })
cv.remove()

// 切到视频模式
;[...document.querySelectorAll('.mode-tab')].find((t) => t.textContent.includes('视频')).click()
await sleep(400)

// 注入
const vin = [...document.querySelectorAll('input[type=file]')].find((i) =>
  (i.accept || '').includes('video')
)
const dt = new DataTransfer()
dt.items.add(new File([blob], 'g.webm', { type: 'video/webm' }))
vin.files = dt.files
vin.dispatchEvent(new Event('change', { bubbles: true }))

// 每 300ms 采样一次应用状态，看自动链路有没有跑
const timeline = []
for (let i = 0; i < 25; i++) {
  await sleep(300)
  const v = document.querySelector('.source-video') || document.querySelector('video')
  const em = window.__em
  const line = {
    t: ((i + 1) * 0.3).toFixed(1),
    rs: v?.readyState,
    vw: v?.videoWidth,
    status: em?.status,
    mood: em?.result?.mood || '',
    err: (em?.error || '').slice(0, 20)
  }
  const prev = timeline[timeline.length - 1]
  if (
    !prev ||
    prev.rs !== line.rs ||
    prev.status !== line.status ||
    prev.mood !== line.mood ||
    prev.err !== line.err
  ) {
    timeline.push(line)
  }
}
out.timeline = timeline

// 最后手工触发，确认链路可用
const v = document.querySelector('.source-video') || document.querySelector('video')
const em = window.__em
if (v && em) {
  await em.onRequestDetect({ el: v, kind: 'video', force: true })
  out.manual = {
    status: em.status,
    mood: em.result?.mood,
    conf: em.result ? +em.result.confidence.toFixed(3) : null,
    err: em.error
  }
  // 检查人脸框
  out.faces = document.querySelectorAll('.face-box').length
  out.recs = document.querySelectorAll('.song-item').length
}

return JSON.stringify(out)
