// 诊断：为什么 demo-faces 图片在浏览器里 onerror
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const out = { origin: location.origin, href: location.href, results: [] }

// 1) fetch 能否拿到
try {
  const r = await fetch('/demo-faces/01-happy.png')
  out.fetch = { ok: r.ok, status: r.status, type: r.headers.get('content-type') }
  const b = await r.blob()
  out.fetch.bytes = b.size
} catch (e) {
  out.fetch = { error: e.message }
}

// 2) Image 加载，记录详细错误
await new Promise((res) => {
  const img = new Image()
  img.onload = () => {
    out.image = { ok: true, w: img.naturalWidth, h: img.naturalHeight }
    res()
  }
  img.onerror = () => {
    out.image = { ok: false, src: img.src }
    res()
  }
  img.src = '/demo-faces/01-happy.png'
  setTimeout(() => {
    out.imageTimeout = true
    res()
  }, 15000)
})

// 3) 对照：已知能用的 verify-faces
await new Promise((res) => {
  const img = new Image()
  img.onload = () => {
    out.control = { ok: true, w: img.naturalWidth }
    res()
  }
  img.onerror = () => {
    out.control = { ok: false }
    res()
  }
  img.src = '/verify-faces/cover-14.jpg'
  setTimeout(res, 10000)
})

// 4) 用 createImageBitmap 试试
try {
  const r = await fetch('/demo-faces/01-happy.png')
  const b = await r.blob()
  const bmp = await createImageBitmap(b)
  out.bitmap = { w: bmp.width, h: bmp.height }
} catch (e) {
  out.bitmap = { error: e.message }
}

return JSON.stringify(out)
