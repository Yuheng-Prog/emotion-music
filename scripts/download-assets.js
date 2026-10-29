/**
 * 资源下载脚本 —— 情绪识别模型权重 + 本地歌曲库
 *
 * 用法:
 *   node scripts/download-assets.js              # 下载缺失资源
 *   node scripts/download-assets.js --force      # 全部重新下载
 *   node scripts/download-assets.js --models     # 只下模型
 *   node scripts/download-assets.js --songs      # 只下歌曲
 *   node scripts/download-assets.js --count 8    # 指定歌曲数量
 *
 * 说明:
 *  - 模型来自 @vladmandic/face-api 官方发布包 (MIT License) → public/models
 *  - 歌曲来自 SoundHelix 免费示例曲 (https://www.soundhelix.com) → public/songs
 *
 * 该站点对「单连接」限速约 25~35 KB/s，但允许多连接并发且不限总带宽。
 * 因此下载器采用「小分块 + 高并发 + 跨文件并行」策略：
 *   · 每首歌切成 512KB 小块，全局最多 12 个并发连接
 *   · 同时处理多首歌，避免单首歌的慢连接拖住全局
 *   · 每块失败自动重试，支持断点续传（.partstate 记录已完成块）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import https from 'node:https'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const MODEL_DIR = path.join(ROOT, 'public', 'models')
const SONG_DIR = path.join(ROOT, 'public', 'songs')

const ARGS = process.argv.slice(2)
const FORCE = ARGS.includes('--force')
const ONLY_MODELS = ARGS.includes('--models')
const ONLY_SONGS = ARGS.includes('--songs')
const COUNT_IDX = ARGS.indexOf('--count')
const SONG_COUNT = COUNT_IDX >= 0 ? Number(ARGS[COUNT_IDX + 1]) || 16 : 16

const MODEL_BASE = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/'
const MODEL_FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_expression_model-weights_manifest.json',
  'face_expression_model.bin'
]

const SONG_HOST = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-'
/**
 * 下载策略参数
 *
 * 实测该站点：单连接约 30~60 KB/s，多连接能叠加，但连接数过多会被限流
 * （表现为连接被 RST / 长时间无数据）。因此采用：
 *   · 每首歌切成 512KB 块，块内串行、块间少量并发
 *   · 同时处理 3 首歌，总连接数控制在 ~8 以内
 */
const CHUNK_SIZE = 512 * 1024
const CHUNK_CONCURRENCY = 3
const MAX_CONNECTIONS = 8
const MAX_SONGS_CONCURRENT = 3

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

/* ------------------------------------------------------------------ 并发信号量 */

class Semaphore {
  constructor(max) {
    this.max = max
    this.active = 0
    this.queue = []
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++
      return
    }
    await new Promise((r) => this.queue.push(r))
    this.active++
  }
  release() {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

const connPool = new Semaphore(MAX_CONNECTIONS)

/* ------------------------------------------------------------------ HTTP */

function request(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume()
        const next = new URL(res.headers.location, url).toString()
        return resolve(request(next, headers, redirects + 1))
      }
      resolve(res)
    })
    req.on('error', reject)
    req.setTimeout(60000, () => req.destroy(new Error('timeout')))
  })
}

async function downloadWhole(url, dest) {
  const res = await request(url)
  if (res.statusCode !== 200) {
    res.resume()
    throw new Error(`HTTP ${res.statusCode}`)
  }
  const tmp = dest + '.part'
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp)
    res.pipe(out)
    out.on('finish', resolve)
    out.on('error', reject)
    res.on('error', reject)
  })
  fs.renameSync(tmp, dest)
  return fs.statSync(dest).size
}

/** 下载一个字节区间，带重试（指数退避） */
async function fetchRange(url, start, end, retries = 5) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    await connPool.acquire()
    try {
      const res = await request(url, { Range: `bytes=${start}-${end}` })
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode}`)
      }
      const bufs = []
      await new Promise((resolve, reject) => {
        res.on('data', (c) => bufs.push(c))
        res.on('end', resolve)
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('aborted')))
      })
      const buf = Buffer.concat(bufs)
      const expect = end - start + 1
      if (buf.length !== expect) throw new Error(`short read ${buf.length}/${expect}`)
      return buf
    } catch (e) {
      lastErr = e
      if (attempt === retries) break
      // 指数退避：被限流时给服务端喘息时间
      await new Promise((r) => setTimeout(r, 800 * Math.pow(1.7, attempt)))
    } finally {
      connPool.release()
    }
  }
  throw lastErr
}

/** 探测文件总大小 */
async function probeSize(url) {
  const res = await request(url, { Range: 'bytes=0-0' })
  res.resume()
  const cr = res.headers['content-range']
  const m = cr && /\/(\d+)$/.exec(cr)
  if (m) return Number(m[1])
  const len = Number(res.headers['content-length'] || 0)
  return len > 1 ? len : 0
}

/**
 * 分块并行下载单个文件
 * state 文件记录已完成块，支持中断续传
 */
async function downloadChunked(url, dest) {
  const total = await probeSize(url)
  if (!total) {
    const size = await downloadWhole(url, dest)
    return { size }
  }

  const stateFile = dest + '.state.json'
  const partFiles = []
  const totalChunks = Math.ceil(total / CHUNK_SIZE)

  let state = { total, done: [] }
  if (!FORCE && fs.existsSync(stateFile)) {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (s.total === total) state = s
    } catch {}
  }
  const doneSet = new Set(state.done)

  // 为每个未完成块建立任务
  const tasks = []
  for (let i = 0; i < totalChunks; i++) {
    if (doneSet.has(i)) continue
    const start = i * CHUNK_SIZE
    const end = Math.min(start + CHUNK_SIZE - 1, total - 1)
    tasks.push({ i, start, end })
  }

  const partFor = (i) => `${dest}.part${i}`
  const lastChunk = totalChunks - 1
  const lastSize = total - lastChunk * CHUNK_SIZE
  const partSizeOf = (i) => (i === totalChunks - 1 ? lastSize : CHUNK_SIZE)

  // 已完成块必须确认 part 文件存在且大小正确
  const needRedo = []
  for (const i of Array.from(doneSet)) {
    const pf = partFor(i)
    if (!fs.existsSync(pf) || fs.statSync(pf).size !== partSizeOf(i)) needRedo.push(i)
  }
  for (const i of needRedo) {
    doneSet.delete(i)
    const start = i * CHUNK_SIZE
    tasks.push({ i, start, end: Math.min(start + CHUNK_SIZE - 1, total - 1) })
  }

  // 分块并发下载（块间并发受 CHUNK_CONCURRENCY 限制，配合全局连接池）
  const taskQueue = [...tasks]
  async function worker() {
    for (;;) {
      const t = taskQueue.shift()
      if (!t) return
      const buf = await fetchRange(url, t.start, t.end)
      fs.writeFileSync(partFor(t.i), buf)
      doneSet.add(t.i)
      fs.writeFileSync(stateFile, JSON.stringify({ total, done: Array.from(doneSet) }))
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(CHUNK_CONCURRENCY, tasks.length); w++) workers.push(worker())
  await Promise.all(workers)

  // 按序拼接
  const out = fs.openSync(dest + '.tmp', 'w')
  for (let i = 0; i < totalChunks; i++) {
    fs.writeSync(out, fs.readFileSync(partFor(i)))
  }
  fs.closeSync(out)

  const finalSize = fs.statSync(dest + '.tmp').size
  if (finalSize !== total) throw new Error(`size mismatch ${finalSize}/${total}`)

  fs.renameSync(dest + '.tmp', dest)
  // 清理分块临时文件
  for (let i = 0; i < totalChunks; i++) {
    try {
      fs.unlinkSync(partFor(i))
    } catch {}
  }
  try {
    fs.unlinkSync(stateFile)
  } catch {}

  return { size: total }
}

/* ------------------------------------------------------------------ 流程 */

function mkdirp(d) {
  fs.mkdirSync(d, { recursive: true })
}

function sizeOk(p, min = 1024) {
  return fs.existsSync(p) && fs.statSync(p).size > min
}

const results = { ok: 0, skip: 0, fail: [] }

async function downloadSong(i) {
  const name = `soundhelix-song-${String(i).padStart(2, '0')}.mp3`
  const dest = path.join(SONG_DIR, name)
  if (!FORCE && sizeOk(dest, 500 * 1024)) {
    console.log(`  · ${name}  已存在，跳过`)
    results.skip++
    return
  }
  const t0 = Date.now()
  try {
    const { size } = await downloadChunked(`${SONG_HOST}${i}.mp3`, dest)
    const kb = Math.round(size / 1024)
    console.log(`  ✓ ${name}  ${kb} KB  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    results.ok++
  } catch (e) {
    console.log(`  ✗ ${name}  失败: ${e.message}`)
    results.fail.push(name)
  }
}

async function main() {
  mkdirp(MODEL_DIR)
  mkdirp(SONG_DIR)

  console.log('\n=== 情绪电台 · 资源准备 ===\n')

  if (!ONLY_SONGS) {
    console.log('[1] 情绪识别模型 (face-api.js, 共约 900KB)')
    for (const f of MODEL_FILES) {
      const dest = path.join(MODEL_DIR, f)
      if (!FORCE && sizeOk(dest, 200)) {
        console.log(`  · ${f}  已存在，跳过`)
        continue
      }
      try {
        const size = await downloadWhole(MODEL_BASE + f, dest)
        console.log(`  ✓ ${f}  ${Math.round(size / 1024)} KB`)
      } catch (e) {
        console.log(`  ✗ ${f}  失败: ${e.message}`)
      }
    }
    console.log('')
  }

  if (!ONLY_MODELS) {
    console.log(`[2] 本地歌曲库 (SoundHelix ${SONG_COUNT} 首, 分块并发下载)`)
    // 分批并发处理歌曲
    // 注意：用固定大小的小批次，而不是「总数/并发数」的大批次，
    // 这样单首下载慢（~60s）时也能及时看到每批完成，避免长时间无输出。
    for (let s = 1; s <= SONG_COUNT; s += MAX_SONGS_CONCURRENT) {
      const batch = []
      for (let i = s; i < s + MAX_SONGS_CONCURRENT && i <= SONG_COUNT; i++) batch.push(i)
      await Promise.all(batch.map(downloadSong))
    }
    console.log('')
  }

  // 清理残留
  for (const dir of [MODEL_DIR, SONG_DIR]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(part\d*|state\.json|tmp)$/.test(f)) {
          try {
            fs.unlinkSync(path.join(dir, f))
          } catch {}
        }
      }
    } catch {}
  }

  if (results.fail.length) {
    console.log(`⚠ ${results.fail.length} 个文件下载失败：${results.fail.join(', ')}`)
    console.log('  可重新执行 node scripts/download-assets.js 增量补齐\n')
    process.exitCode = 1
  } else {
    console.log(`✓ 资源准备完成 (跳过 ${results.skip})`)
    console.log('  下一步:  npm run build   然后  npm run serve\n')
  }
}

main()
