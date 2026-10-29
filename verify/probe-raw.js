// 诊断：单张图在多个 inputSize 下的 CNN 原始表情输出
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}
const em = window.__em
if (!em) return JSON.stringify([{ error: 'NO_EM' }])
const { faceapi } = em

const NAMES = ['04-angry.png', '05-anxious.png', '03-sad.png', '07-disgusted.png']
const out = []
for (const name of NAMES) {
  const blob = await (await fetch('/demo-faces/' + name)).blob()
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  const s = Math.min(1, 960 / Math.max(bmp.width, bmp.height))
  c.width = Math.round(bmp.width * s)
  c.height = Math.round(bmp.height * s)
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
  for (const inputSize of [416, 512]) {
    for (const thr of [0.3]) {
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: thr })
      const r = await faceapi.detectAllFaces(c, opts).withFaceLandmarks().withFaceExpressions()
      out.push({
        name,
        inputSize,
        faces: r.map((x) => ({
          det: +x.detection.score.toFixed(2),
          box: [Math.round(x.detection.box.width), Math.round(x.detection.box.height)],
          expr: Object.fromEntries(
            Object.entries(x.expressions).map(([k, v]) => [k, +v.toFixed(3)])
          )
        }))
      })
    }
  }
  bmp.close?.()
}
return JSON.stringify(out)
