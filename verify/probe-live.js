// 页面内直接 fetch 模型文件诊断
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = { fetches: [] }
for (const p of ['./models/tiny_face_detector_model-weights_manifest.json', './models/tiny_face_detector_model.bin']) {
  const t0 = performance.now()
  try {
    const r = await fetch(p)
    const b = await r.arrayBuffer()
    out.fetches.push({ p, status: r.status, bytes: b.byteLength, ms: Math.round(performance.now() - t0) })
  } catch (e) {
    out.fetches.push({ p, err: e.message, ms: Math.round(performance.now() - t0) })
  }
}
// 再看模型加载状态
const el = document.querySelector('.model-status')
out.status = el ? el.textContent.trim() : null
out.statusClass = el ? el.className : null
return JSON.stringify(out)
