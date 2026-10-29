// 诊断：face-api 的 Box 对象到底有哪些字段
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}
const em = window.__em
if (!em) return JSON.stringify({ error: 'NO_EM' })
const { faceapi } = em

const blob = await (await fetch('/demo-faces/04-angry.png')).blob()
const bmp = await createImageBitmap(blob)
const c = document.createElement('canvas')
const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
c.width = Math.round(bmp.width * s)
c.height = Math.round(bmp.height * s)
c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)

const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 })
const r = await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceExpressions()
const box = r[0].detection.box

// 枚举自有的可枚举属性 + 原型上的 getter
const own = Object.keys(box)
const proto = []
let p = Object.getPrototypeOf(box)
while (p && p !== Object.prototype) {
  proto.push(...Object.getOwnPropertyNames(p).filter((k) => !proto.includes(k)))
  p = Object.getPrototypeOf(p)
}

return JSON.stringify({
  own,
  proto,
  values: {
    width: box.width,
    height: box.height,
    w: box.w,
    h: box.h,
    area: box.area,
    top: box.top,
    left: box.left,
    right: box.right,
    bottom: box.bottom
  },
  raw: JSON.parse(JSON.stringify(box))
})
