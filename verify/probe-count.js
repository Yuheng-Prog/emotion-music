// 诊断：04-angry 在 416 / 512 下各检出几张脸
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}
const em = window.__em
if (!em) return JSON.stringify({ error: 'NO_EM' })
const { faceapi } = em

const out = {}
for (const name of ['04-angry.png', '05-anxious.png', '07-disgusted.png']) {
  const blob = await (await fetch('/demo-faces/' + name)).blob()
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
  c.width = Math.round(bmp.width * s)
  c.height = Math.round(bmp.height * s)
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)

  out[name] = {}
  for (const inputSize of [416, 512]) {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 })
    const r = await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceExpressions()
    out[name][inputSize] = r.map((x) => ({
      box: [Math.round(x.detection.box.x), Math.round(x.detection.box.y), Math.round(x.detection.box.width), Math.round(x.detection.box.height)],
      det: +x.detection.score.toFixed(2),
      expr: Object.fromEntries(
        Object.entries(x.expressions)
          .filter(([, v]) => v > 0.05)
          .map(([k, v]) => [k, +v.toFixed(2)])
      )
    }))
  }
  bmp.close?.()
}
return JSON.stringify(out)
