// 诊断 face-api 模型加载：列出页面所有资源请求与尺寸
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(2000)
const res = performance.getEntriesByType('resource')
  .filter((e) => /model|models/.test(e.name) || /weights/.test(e.name))
  .map((e) => ({
    url: e.name.split('/').slice(-1)[0],
    bytes: e.transferSize || e.encodedBodySize,
    ms: Math.round(e.duration),
    status: e.responseStatus
  }))
const el = document.querySelector('.model-status')
return JSON.stringify({
  status: el?.textContent?.trim(),
  resources: res,
  totalResources: performance.getEntriesByType('resource').length
})
