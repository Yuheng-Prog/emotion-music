/**
 * ============================================================================
 *  本地服务 (Zero-dependency Node HTTP Server)
 * ============================================================================
 *
 *  职责：
 *    1. 静态托管 dist/ (Vue 构建产物) + public/ 下的 models、songs
 *    2. 本地歌曲音频流，支持 HTTP Range 请求 (断点/拖动进度条必需)
 *    3. 在线歌曲 API 代理 —— 浏览器直接请求第三方音乐接口会被 CORS 拦截，
 *       且第三方返回的音频 CDN 也有防盗链限制。通过本地服务中转可以：
 *         · 绕过 CORS
 *         · 统一超时与降级逻辑
 *         · 隐藏第三方接口细节
 *
 *  启动: node server/index.js  (默认 http://127.0.0.1:8787)
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const PUBLIC = path.join(ROOT, 'public')
const PORT = Number(process.env.PORT) || 8787
const HOST = process.env.HOST || '127.0.0.1'

/* ---------------------------------------------------------------- MIME */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json'
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

/* ---------------------------------------------------------------- 工具 */
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 带超时的 fetch，失败返回 null（不抛错，便于降级） */
async function safeFetch(url, timeoutMs = 6000, asText = false) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        Referer: 'https://music.163.com/'
      }
    })
    if (!r.ok) return null
    return asText ? await r.text() : await r.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 静态文件服务，支持 Range
 * @param {string} baseDir 允许访问的根目录（防目录穿越）
 */
function serveStatic(req, res, baseDir, relPath) {
  // 规范化并防止 ../ 穿越
  const safeRel = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '')
  const filePath = path.join(baseDir, safeRel)

  if (!filePath.startsWith(baseDir)) {
    return sendText(res, 403, 'Forbidden')
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendText(res, 404, 'Not Found: ' + relPath)
    }
    const mime = mimeOf(filePath)
    const range = req.headers.range
    const isMedia = mime.startsWith('audio/')

    if (range && isMedia) {
      // 解析 Range: bytes=start-end
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1
      if (isNaN(start) || start < 0) start = 0
      if (isNaN(end) || end >= stat.size) end = stat.size - 1
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` })
        return res.end()
      }
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      })
      fs.createReadStream(filePath, { start, end }).pipe(res)
      return
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'Accept-Ranges': isMedia ? 'bytes' : 'none',
      'Cache-Control': isMedia ? 'public, max-age=3600' : 'no-cache'
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

/* ==================================================================
 *  在线歌曲 API 适配层
 * ==================================================================
 *
 *  使用两个公开的 Meting 兼容接口（网易云音乐搜索 / 播放直链）：
 *    接口 A: https://api.i-meto.com/meting/api?server=netease&type=search&id=关键词
 *    接口 B: https://api.injahow.cn/meting/?server=netease&type=search&id=关键词
 *
 *  两者返回结构一致：[{ title, author, url, pic, lrc }]
 *  其中 url 指向 type=url 的直链接口，浏览器 <audio> 可直接播放。
 *
 *  设计要点：
 *    · 两个源串行尝试，任一成功即返回（主备降级）
 *    · 对结果做去重与字段归一
 *    · 屏蔽纯音/伴奏等低质量结果
 */

const ES_SOURCES = [
  (kw) => `https://api.i-meto.com/meting/api?server=netease&type=search&id=${encodeURIComponent(kw)}`,
  (kw) => `https://api.injahow.cn/meting/?server=netease&type=search&id=${encodeURIComponent(kw)}`
]

/** 过滤掉明显不适合的结果 */
function filterResults(list) {
  const badWords = ['伴奏', '纯音乐版', 'inst.', 'Instrumental', 'DJ版', '铃声', '夜店']
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item || !item.url || !item.title) continue
    const title = String(item.title)
    if (badWords.some((w) => title.toLowerCase().includes(w.toLowerCase()))) continue
    const key = title + '|' + (item.author || '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      title,
      artist: item.author || '未知歌手',
      url: item.url,
      cover: item.pic || '',
      lrc: item.lrc || ''
    })
  }
  return out
}

async function searchOnline(keyword) {
  for (let i = 0; i < ES_SOURCES.length; i++) {
    const url = ES_SOURCES[i](keyword)
    const data = await safeFetch(url, 7000)
    if (Array.isArray(data) && data.length) {
      const cleaned = filterResults(data)
      if (cleaned.length) {
        return { ok: true, source: `provider-${i + 1}`, results: cleaned, keyword }
      }
    }
    if (i < ES_SOURCES.length - 1) await sleep(150)
  }
  return { ok: false, source: null, results: [], keyword, error: '在线曲库暂时不可用' }
}

/* ==================================================================
 *  路由
 * ================================================================== */

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj

  // ---- 健康检查 / 服务信息 ----
  if (pathname === '/api/status') {
    const songDir = path.join(PUBLIC, 'songs')
    let localCount = 0
    try {
      localCount = fs.readdirSync(songDir).filter((f) => f.endsWith('.mp3')).length
    } catch {}
    const modelDir = path.join(PUBLIC, 'models')
    let modelReady = false
    try {
      modelReady = ['tiny_face_detector_model.bin', 'face_landmark_68_model.bin', 'face_expression_model.bin'].every(
        (f) => fs.existsSync(path.join(modelDir, f))
      )
    } catch {}
    return sendJSON(res, 200, {
      ok: true,
      localSongs: localCount,
      modelReady,
      online: true
    })
  }

  // ---- 在线歌曲搜索 ----
  if (pathname === '/api/search') {
    const q = (searchParams.get('q') || '').trim()
    if (!q) return sendJSON(res, 400, { ok: false, error: '缺少搜索关键词 q' })
    const result = await searchOnline(q)
    return sendJSON(res, 200, result)
  }

  // ---- 在线音频流中转 (解决音频 CDN 的 CORS / Referer 限制) ----
  if (pathname === '/api/proxy-audio') {
    const target = searchParams.get('url')
    if (!target) return sendText(res, 400, 'missing url')
    try {
      const u = new URL(target)
      if (!/^https?:$/.test(u.protocol)) return sendText(res, 400, 'bad protocol')
    } catch {
      return sendText(res, 400, 'bad url')
    }
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      Referer: 'https://music.163.com/'
    }
    if (req.headers.range) headers.Range = req.headers.range
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const upstream = await fetch(target, { headers, signal: ctrl.signal, redirect: 'follow' })
      const passHeaders = {
        'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes'
      }
      const len = upstream.headers.get('content-length')
      const cr = upstream.headers.get('content-range')
      if (len) passHeaders['Content-Length'] = len
      if (cr) passHeaders['Content-Range'] = cr
      res.writeHead(upstream.status, passHeaders)
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    } catch (e) {
      sendText(res, 502, 'proxy failed: ' + e.message)
    } finally {
      clearTimeout(timer)
    }
    return
  }

  return sendJSON(res, 404, { ok: false, error: 'unknown api' })
}

const server = http.createServer(async (req, res) => {
  let urlObj
  try {
    urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const { pathname } = urlObj
  const decoded = decodeURIComponent(pathname)

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Range',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
    })
    return res.end()
  }

  if (decoded.startsWith('/api/')) {
    try {
      return await handleApi(req, res, urlObj)
    } catch (e) {
      return sendJSON(res, 500, { ok: false, error: e.message })
    }
  }

  // public 下的模型与歌曲
  if (decoded.startsWith('/models/')) {
    return serveStatic(req, res, path.join(PUBLIC, 'models'), decoded.slice('/models/'.length))
  }
  if (decoded.startsWith('/songs/')) {
    return serveStatic(req, res, path.join(PUBLIC, 'songs'), decoded.slice('/songs/'.length))
  }
  // 验证用样本图（仅本地开发调试）
  if (decoded.startsWith('/verify-faces/')) {
    return serveStatic(req, res, path.join(PUBLIC, 'verify-faces'), decoded.slice('/verify-faces/'.length))
  }

  // 构建产物
  if (fs.existsSync(DIST)) {
    const rel = decoded === '/' ? 'index.html' : decoded.slice(1)
    const target = path.join(DIST, rel)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      return serveStatic(req, res, DIST, rel)
    }
    // SPA 回退
    return serveStatic(req, res, DIST, 'index.html')
  }

  return sendText(
    res,
    404,
    '前端尚未构建。请先执行:\n  npm run build\n然后重新启动服务。'
  )
})

server.listen(PORT, HOST, () => {
  const songDir = path.join(PUBLIC, 'songs')
  let n = 0
  try {
    n = fs.readdirSync(songDir).filter((f) => f.endsWith('.mp3')).length
  } catch {}
  console.log('')
  console.log('  ╭──────────────────────────────────────────────╮')
  console.log('  │   情绪电台 · 歌曲推荐系统已启动               │')
  console.log('  ╰──────────────────────────────────────────────╯')
  console.log(`  访问地址:  http://${HOST}:${PORT}`)
  console.log(`  本地歌曲:  ${n} 首`)
  console.log(`  前端构建:  ${fs.existsSync(DIST) ? '已就绪' : '未构建 (npm run build)'}`)
  console.log('')
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。可换端口启动:  set PORT=9000 && node server/index.js\n`)
    process.exit(1)
  }
  throw e
})
