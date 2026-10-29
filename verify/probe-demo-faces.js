// 演示人脸图识别验收（v4）：直连 face-api，额外输出几何量原始比例用于标定阈值
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const LIST = [
  '01-happy.png',
  '02-calm.png',
  '03-sad.png',
  '04-angry.png',
  '05-anxious.png',
  '06-surprised.png',
  '07-disgusted.png',
  '08-group.png'
]
const EXPECT = {
  '01-happy.png': 'happy',
  '02-calm.png': 'calm',
  '03-sad.png': 'sad',
  '04-angry.png': 'angry',
  '05-anxious.png': 'fearful',
  '06-surprised.png': 'fearful',
  '07-disgusted.png': 'sad',
  '08-group.png': ''
}

for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

window.__emDebug = []
const em = window.__em
if (!em) return JSON.stringify([{ error: 'NO_EM_DEBUG_HOOK' }])

const { faceapi, detector } = em

const results = []

for (const name of LIST) {
  const entry = { name, expect: EXPECT[name] }
  try {
    const resp = await fetch('/demo-faces/' + name)
    if (!resp.ok) {
      entry.error = 'FETCH_' + resp.status
      results.push(entry)
      continue
    }
    const blob = await resp.blob()
    entry.bytes = blob.size
    const bmp = await createImageBitmap(blob)
    entry.size = [bmp.width, bmp.height]

    const c = document.createElement('canvas')
    const MAX = 960
    const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height))
    c.width = Math.round(bmp.width * s)
    c.height = Math.round(bmp.height * s)
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0, c.width, c.height)

    // 亮度统计，帮助判断是否过暗
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
    entry.luma = Math.round(sum / (d.length / 4))

    const t0 = performance.now()
    detector.reset()
    const res = await em.detectAll({ canvas: c, scale: s }, false)
    entry.ms = Math.round(performance.now() - t0)
    entry.faces = res.length

    entry.detail = res.map((r) => ({
      mood: r.mood,
      conf: r.confidence,
      det: r.detectionScore,
      px: Math.round((r.box?.width || 0) * s),
      quality: r.quality && {
        size: +r.quality.sizeScore.toFixed(2),
        det: +r.quality.detScore.toFixed(2),
        pose: +r.quality.poseScore.toFixed(2),
        light: +r.quality.lightScore.toFixed(2),
        overall: +r.quality.overall.toFixed(2)
      },
      moods: Object.fromEntries(Object.entries(r.moods || {}).map(([k, v]) => [k, +v.toFixed(2)])),
      raw: Object.fromEntries(Object.entries(r.rawExpressions || {}).map(([k, v]) => [k, +v.toFixed(2)])),
      geo: r.geometry && {
        browUp: +r.geometry.browRaise.toFixed(2),
        browDown: +r.geometry.browInnerDown.toFixed(2),
        browUpIn: +r.geometry.browInnerUp.toFixed(2),
        mouthOpen: +r.geometry.mouthOpen.toFixed(2),
        smile: +r.geometry.smileCurvature.toFixed(2),
        eyeWide: +r.geometry.eyeWide.toFixed(2),
        squint: +r.geometry.eyeSquint.toFixed(2)
      },
      expr: Object.fromEntries(Object.entries(r.expressions || {}).map(([k, v]) => [k, +v.toFixed(2)]))
    }))
    bmp.close?.()
  } catch (e) {
    entry.error = e.name + ': ' + e.message
  }
  results.push(entry)
}

// ---- 几何量原始比例标定 ----
// 目的：确认 browRaise / mouthOpen 的归一化尺度是否合理。
// 输出未 clamp 的原始比值，便于反推阈值。
const rawGeo = []
for (const name of ['01-happy.png', '02-calm.png', '06-surprised.png', '03-sad.png', '04-angry.png', '05-anxious.png']) {
  try {
    const blob = await (await fetch('/demo-faces/' + name)).blob()
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = 960
    c.height = 960
    c.getContext('2d').drawImage(bmp, 0, 0, 960, 960)
    const r = await faceapi
      .detectSingleFace(c, detector.detectorOptions())
      .withFaceLandmarks()
      .withFaceExpressions()
    if (!r) {
      rawGeo.push({ name, faces: 0 })
      bmp.close?.()
      continue
    }
    const p = r.landmarks.positions
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    const faceWidth = dist(p[0], p[16])
    const faceHeight = dist(p[27], p[8])
    const hw = faceWidth / 2
    const noseTop = p[27]
    const browH = ((p[21].y + p[22].y) / 2 - noseTop.y) / hw
    const mouthGap = (p[66].y - p[62].y + (p[57].y - p[51].y)) / 2
    rawGeo.push({
      name,
      wpx: Math.round(faceWidth),
      fH_over_fW: +(faceHeight / faceWidth).toFixed(2),
      browToNose_over_hw: +browH.toFixed(3),
      mouthGap_over_faceH: +(mouthGap / faceHeight).toFixed(4),
      mouthGap_over_faceW: +(mouthGap / faceWidth).toFixed(4)
    })
    bmp.close?.()
  } catch (e) {
    rawGeo.push({ name, error: e.message })
  }
}

return JSON.stringify({ results, rawGeo, dbg: window.__emDebug })
