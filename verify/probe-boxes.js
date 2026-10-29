// 诊断：04-angry 在两个 inputSize 下的检测框位置与 IoU
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}
const em = window.__em
if (!em) return JSON.stringify({ error: 'NO_EM' })
const { faceapi } = em

const name = '04-angry.png'
const blob = await (await fetch('/demo-faces/' + name)).blob()
const bmp = await createImageBitmap(blob)
const c = document.createElement('canvas')
const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
c.width = Math.round(bmp.width * s)
c.height = Math.round(bmp.height * s)
c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)

const boxes = {}
for (const inputSize of [416, 512]) {
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 })
  const r = await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceExpressions()
  boxes[inputSize] = r.map((x) => ({
    x: Math.round(x.detection.box.x),
    y: Math.round(x.detection.box.y),
    w: Math.round(x.detection.box.width),
    h: Math.round(x.detection.box.height),
    det: +x.detection.score.toFixed(2),
    expr: Object.fromEntries(Object.entries(x.expressions).map(([k, v]) => [k, +v.toFixed(2)]))
  }))
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  const union = a.w * a.h + b.w * b.h - inter
  return +(inter / union).toFixed(3)
}

const pairs = []
for (const a of boxes[416]) for (const b of boxes[512]) pairs.push({ a: [a.x, a.y, a.w, a.h], b: [b.x, b.y, b.w, b.h], iou: iou(a, b) })

return JSON.stringify({ canvas: [c.width, c.height], boxes, pairs })
