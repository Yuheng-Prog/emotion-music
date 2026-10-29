// 尺度敏感性诊断：同一张图在不同缩放/裁剪下的检测情况
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}
const em = window.__em
if (!em) return JSON.stringify([{ error: 'NO_EM' }])
const { faceapi, detector } = em

const NAMES = ['05-anxious.png', '06-surprised.png']
const SIZES = [640, 800, 960, 1024]

const out = []
for (const name of NAMES) {
  const blob = await (await fetch('/demo-faces/' + name)).blob()
  const bmp = await createImageBitmap(blob)
  for (const MAX of SIZES) {
    for (const inputSize of [416, 512, 608]) {
      const c = document.createElement('canvas')
      const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height))
      c.width = Math.round(bmp.width * s)
      c.height = Math.round(bmp.height * s)
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 })
      const t0 = performance.now()
      let n = 0
      let top = 0
      try {
        const r = await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceExpressions()
        n = r.length
        top = r.length ? Math.max(...r.map((x) => x.detection.score)) : 0
      } catch (e) {
        out.push({ name, MAX, inputSize, error: e.message })
        continue
      }
      out.push({
        name,
        MAX,
        inputSize,
        faces: n,
        top: +top.toFixed(2),
        ms: Math.round(performance.now() - t0)
      })
    }
  }
  bmp.close?.()
}
return JSON.stringify(out)
