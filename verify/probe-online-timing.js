// 诊断：在线曲库召回耗时
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const out = []

// 1) 直接打在线搜歌接口，看耗时
const moods = ['happy', 'sad', 'angry', 'fearful', 'calm']
for (const m of moods) {
  const t0 = performance.now()
  try {
    const resp = await fetch(`./api/search?q=${m}`, { signal: AbortSignal.timeout(15000) })
    const txt = await resp.text()
    let n = -1
    try {
      const j = JSON.parse(txt)
      n = (j.songs || j.data || j).length
    } catch {
      n = -2
    }
    out.push({ mood: m, status: resp.status, ms: Math.round(performance.now() - t0), n })
  } catch (e) {
    out.push({ mood: m, error: e.name + ': ' + e.message, ms: Math.round(performance.now() - t0) })
  }
}

return JSON.stringify(out)
