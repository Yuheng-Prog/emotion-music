// 诊断：点选演示图后，推荐面板到底渲染了什么
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 120; i++) {
  const el = document.querySelector('.model-status')
  if (el && el.className.includes('ready')) break
  await sleep(500)
}

const items = [...document.querySelectorAll('.demo-item')]
items[0].click()
await sleep(3000)

const pick = (sel) => {
  const el = document.querySelector(sel)
  return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : null
}

return JSON.stringify({
  bodyTop: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400),
  songListCount: document.querySelectorAll('.song-list').length,
  songItemCount: document.querySelectorAll('.song-item').length,
  listLoading: pick('.list-loading'),
  listEmpty: pick('.list-empty'),
  em: (() => {
    const r = window.__em?.result
    if (!r) return null
    return {
      keys: Object.keys(r),
      mood: r.mood,
      recs: Array.isArray(r.recommendations) ? r.recommendations.length : undefined
    }
  })()
})
