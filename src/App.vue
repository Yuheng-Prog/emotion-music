<script setup>
/**
 * App.vue —— 主界面
 *
 * 布局：
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Header: 标题 + 模型状态 + 算法说明入口                      │
 *   ├──────────────────────┬─────────────────────────────────────┤
 *   │ 左：输入源 + 画面     │ 右：情绪面板 + 策略选择 + 推荐列表  │
 *   ├──────────────────────┴─────────────────────────────────────┤
 *   │ 底部播放器                                                  │
 *   └────────────────────────────────────────────────────────────┘
 */
import { ref, computed, onMounted, onBeforeUnmount, shallowRef, nextTick } from 'vue'
import InputSource from './components/InputSource.vue'
import EmotionPanel from './components/EmotionPanel.vue'
import SongList from './components/SongList.vue'
import Player from './components/Player.vue'
import AlgoDoc from './components/AlgoDoc.vue'

import { EmotionDetector, MOOD_META, faceapi } from './algorithms/emotionDetector.js'
import { aggregateFaces, describeMultiFace } from './algorithms/faceAggregator.js'
import { recommendSongs, STRATEGIES, getVAFromEmotion } from './algorithms/recommender.js'
import { LOCAL_SONGS, MOOD_SEARCH_KEYWORDS, ONLINE_MOOD_ANCHOR } from './data/songs.js'

/* ============================================================ 状态 */

const detector = new EmotionDetector()
const detectorRef = shallowRef(detector)

const modelStatus = ref('loading') // loading | ready | error
const modelProgress = ref({ index: 0, total: 3, name: '' })
const modelError = ref('')

const inputMode = ref('image')
const detectorStatus = ref('idle') // idle | detecting | done | error
const detectorError = ref('')

const result = ref(null) // 聚合后的情绪结果
const faceCount = ref(0)
const faceBoxes = ref([]) // 用于覆盖层绘制
const sourceSize = ref({ w: 0, h: 0 })

const strategy = ref('repair')
const recommendations = ref([])
const recLoading = ref(false)

const currentSong = ref(null)
const playing = ref(false)

const onlineSongs = ref([])
const onlineState = ref({ loading: false, ok: null, msg: '' })
/** 当前在线候选池是为哪种情绪召回的（缓存键，用于跳过重复请求） */
const onlineMood = ref('')

const showDoc = ref(false)
const inputRef = ref(null)
const playerRef = ref(null)
const stageEl = ref(null)

/** 自动识别开关（摄像头/视频） */
const autoDetect = ref(true)

/* 检测节流 */
let lastDetectTs = 0
let detectBusy = false
const DETECT_INTERVAL_MS = 220 // 约 4.5 fps，兼顾流畅与 CPU

/* 稳定后的情绪：避免每帧都触发重新推荐 */
let lastRecommendedMood = ''
let lastRecommendedStrategy = ''
let stableTimer = null

/* ============================================================ 模型加载 */

onMounted(async () => {
  try {
    await detector.load((p) => {
      modelProgress.value = p
    })
    modelStatus.value = 'ready'
    // 服务信息
    fetchServiceInfo()
  } catch (e) {
    modelStatus.value = 'error'
    modelError.value = e.message || '模型加载失败'
  }
})

async function fetchServiceInfo() {
  try {
    const r = await fetch('./api/status').then((x) => x.json())
    if (r?.ok) {
      serviceInfo.value = r
    }
  } catch {
    serviceInfo.value = { ok: false, localSongs: 0 }
  }
}

const serviceInfo = ref({ ok: false, localSongs: 0 })

/* ============================================================ 候选池 */

/** 仅本地曲库，用于在线召回返回前的「秒出」首屏推荐 */
const localPool = computed(() => {
  const local = LOCAL_SONGS.slice(0, Math.max(serviceInfo.value.localSongs || 0, 0))
  return local.length ? local : LOCAL_SONGS
})

const candidatePool = computed(() => {
  // 本地歌曲 + 已召回的在线歌曲
  return [...localPool.value, ...onlineSongs.value]
})

/* ============================================================ 检测主循环 */

/**
 * 取帧用离屏画布。
 *
 * 为什么不把 <video> 直接交给 face-api：
 *   face-api 内部用 tf.browser.fromPixels 读取视频帧，在暂停态 / 刚 seek 完
 *   的时刻，浏览器可能还没把这一帧真正合成到可读表面，读到的是空帧（全黑），
 *   TinyFaceDetector 于是报"未检测到人脸"。图片元素没有这个问题。
 *
 * 统一先 drawImage 到 canvas，再检测 canvas：
 *   · 立即读写，拿到的一定是当前已解码的画面
 *   · canvas 尺寸可控，避免超大分辨率拖慢推理
 *   · 图片 / 视频 / 摄像头三条链路行为一致
 */
let frameCanvas = null
let frameCtx = null

/** 判断画布是不是"空白"（全黑或全白）。用于视频首帧尚未合成时的重试判断。 */
function isBlankCanvas(ctx, w, h, getImageData) {
  try {
    // 只抽样 24x24 个点，足够判断，成本可忽略
    const stepX = Math.max(1, Math.floor(w / 24))
    const stepY = Math.max(1, Math.floor(h / 24))
    let min = 255
    let max = 0
    let n = 0
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const d = getImageData(x, y, 1, 1).data
        const l = (d[0] * 299 + d[1] * 587 + d[2] * 114) / 1000
        if (l < min) min = l
        if (l > max) max = l
        n++
      }
    }
    if (!n) return true
    // 明暗差异过小 → 整幅图基本是纯色，视作空白
    return max - min < 6
  } catch {
    return false // 跨域等原因读不到像素时不做判断，交给检测器
  }
}

function grabFrame(el) {
  const w = el.videoWidth || el.naturalWidth || el.width || 0
  const h = el.videoHeight || el.naturalHeight || el.height || 0
  if (!w || !h) return null

  // 推理侧把长边限制在 960px：超过对 TinyFaceDetector 没有收益，只会更慢
  const MAX_EDGE = 960
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))

  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas')
    frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true })
  }
  if (frameCanvas.width !== cw || frameCanvas.height !== ch) {
    frameCanvas.width = cw
    frameCanvas.height = ch
  }
  frameCtx.drawImage(el, 0, 0, cw, ch)

  const blank = isBlankCanvas(frameCtx, cw, ch, (x, y, ww, hh) =>
    frameCtx.getImageData(x, y, ww, hh)
  )
  return { canvas: frameCanvas, scale, w, h, blank }
}

/** 由 InputSource 发起的一帧请求 */
let blankRetryTimer = null
let blankRetryCount = 0
const BLANK_RETRY_MAX = 12 // 最多重试 12 次（约 1.8 秒）

async function onRequestDetect({ el, force, kind }) {
  if (modelStatus.value !== 'ready') return
  if (!el) return
  if (detectBusy) return

  const now = performance.now()
  const isStatic = kind === 'image'
  const interval = isStatic ? 0 : DETECT_INTERVAL_MS

  if (!force && now - lastDetectTs < interval) return
  lastDetectTs = now

  // 画面的可用尺寸校验
  const w = el.videoWidth || el.naturalWidth || el.width || 0
  const h = el.videoHeight || el.naturalHeight || el.height || 0
  if (!w || !h) return

  detectBusy = true
  detectorStatus.value = 'detecting'

  try {
    const grabbed = grabFrame(el)
    if (!grabbed) {
      detectorStatus.value = 'idle'
      return
    }

    // 视频首帧可能还没合成完，此时取到的是纯色空帧。
    // 不把它当成"没有脸"，而是稍后重试，避免刚加载视频就闪出误报。
    if (grabbed.blank && kind !== 'image') {
      detectBusy = false
      detectorStatus.value = 'idle'
      detectorError.value = '' // 首帧未就绪不算错误
      if (blankRetryCount < BLANK_RETRY_MAX) {
        blankRetryCount++
        clearTimeout(blankRetryTimer)
        blankRetryTimer = setTimeout(() => {
          onRequestDetect({ el, force: true, kind })
        }, 150)
      }
      return
    }
    blankRetryCount = 0

    // 多人脸检测：在稳定帧上调用 detectAllFaces，走同一套模型权重
    // 静态图片只有一帧，不参与时序累积；视频/摄像头则逐帧累积以提高信噪比
    const all = await detectAll(grabbed, !isStatic)
    faceCount.value = all.length

    if (!all.length) {
      result.value = null
      faceBoxes.value = []
      detectorStatus.value = 'idle'
      if (kind === 'camera') detector.reset()
      detectorError.value = '未检测到人脸，请正对镜头并保证光线充足'
      return
    }

    const agg = aggregateFaces(all)
    result.value = { ...agg, va: getVAFromEmotion(agg) }
    faceBoxes.value = all.map((d) => ({ ...d.box }))
    sourceSize.value = { w, h }
    detectorStatus.value = 'done'
    detectorError.value = ''

    // 情绪稳定判定后触发推荐
    scheduleRecommend(agg)
  } catch (e) {
    detectorStatus.value = 'error'
    detectorError.value = e.message || '识别失败'
  } finally {
    detectBusy = false
  }
}

/**
 * 检测画面中的所有脸（支持多人场景）。
 *
 * 输入是 grabFrame() 产出的一帧快照，而不是原始 video/image 元素。
 * 因为快照可能被等比缩小过（长边 ≤ 960），检测出的框和关键点都处在
 * 缩放坐标系里，需要除以 scale 还原回画面原始坐标系，否则覆盖层框会错位。
 *
 * detectAllFaces 与 detectSingleFace 共用同一套模型权重，
 * 逐条结果再交给 detector.postProcess() 复用几何先验/质量/时序逻辑。
 *
 * @param {object} snap grabFrame() 的快照 { canvas, scale }
 * @param {boolean} trackTemporal 是否参与时序累积。
 *        图片/拍照这类静态输入必须传 false：
 *        它们只有一帧，累积器不但没有增益，还会在多张图之间串味，
 *        导致概率被叠加到 one-hot 极值、置信度算成 NaN。
 */
async function detectAll({ canvas, scale }, trackTemporal = true) {
  // 多尺度检测 + TTA 投票：TinyFaceDetector 在不同 inputSize 下框比例不同，
  // 会让表情 CNN 得出相反结论，所以必须两个尺度都跑再合并。
  const raw = await detector.detectMultiScale(canvas, { all: true })

  if (!raw.length) return []

  // 统一按原图尺度换算：pxScale 让质量评估能用「真实像素宽度」判断人脸大小，
  // 「亮度采样」也能从原始画面（而非缩放后的 canvas）取色。
  // 几何特征（嘴角曲率、眉毛间距等）都是比值，不受缩放影响，所以
  // 内部用缩放坐标算 geo 与用原图坐标算完全等价，只需把对外暴露的
  // box / landmarks 还原成原图坐标，UI 才能正确画框。
  const inv = 1 / scale

  return raw
    .map((r) => {
      // 缩放到长边 960px 的副本上检测，但质量评估/亮度采样要按原图尺度来，
      // 否则人脸像素宽度会被低估 (60px 以下全部触发「人脸偏小」告警)。
      const processed = detector.postProcess(
        {
          detection: r.detection,
          landmarks: r.landmarks,
          expressions: r.expressions
        },
        canvas,
        trackTemporal,
        undefined,
        inv
      )
      if (!processed) return null
      // 多尺度认同度：被几个尺度同时检出（1 或 2）。
      // 只有 1 个尺度认同时，说明这张脸处在检测边界，UI 可提示复核。
      processed.hits = r.hits || 1
      if (scale !== 1) {
        processed.box = {
          x: r.detection.box.x * inv,
          y: r.detection.box.y * inv,
          width: r.detection.box.width * inv,
          height: r.detection.box.height * inv
        }
        processed.landmarks = processed.landmarks.map((p) => ({ x: p.x * inv, y: p.y * inv }))
      }
      return processed
    })
    .filter(Boolean)
}

/* ============================================================ 推荐调度 */

/**
 * 情绪稳定判定：
 *   主导情绪连续 1.2 秒不变，且置信度达标，才重新推荐。
 *   避免用户在镜头前轻微变动就导致歌单频繁刷新。
 */
function scheduleRecommend(agg) {
  if (agg.confidence < detector.config.confidenceThreshold) return
  if (!autoDetect.value) return

  const key = agg.mood
  if (key === lastRecommendedMood && strategy.value === lastRecommendedStrategy) {
    // 情绪未变，但若歌单为空（首次）仍推荐
    if (recommendations.value.length) return
  }

  clearTimeout(stableTimer)
  stableTimer = setTimeout(() => {
    if (!result.value) return
    if (result.value.confidence < detector.config.confidenceThreshold) return
    lastRecommendedMood = result.value.mood
    lastRecommendedStrategy = strategy.value
    doRecommend()
  }, 1200)
}

/** 执行推荐 */
async function doRecommend() {
  const emo = result.value
  if (!emo) return
  recLoading.value = true

  // 在线召回：按情绪关键词搜索。
  // 若同情绪的在线结果已够用，则跳过网络请求，避免切换策略时重新拉取
  // 造成「先清空列表再等待」的闪烁。
  const needOnline = onlineSongs.value.length < 6 || onlineMood.value !== emo.mood

  // 第一次推荐（本地曲库还不够撑满 12 条）时，先用现有曲库立刻出一版，
  // 让用户马上看到结果，再等在线召回结果回来重排。
  //
  // 为什么要这样拆：在线搜索实测单次 1.5~7.3s（fearful 最慢 7.3s），
  // 而检测本身只要 145ms。若同步等待，用户点一张演示图要干等 6 秒，
  // 体验上是「卡死」。检测结果与本地推荐本就可以先落地。
  const hasLocalPool = localPool.value.length > 0
  if (needOnline && hasLocalPool) {
    const firstPass = recommendSongs(localPool.value, emo, {
      strategy: strategy.value,
      limit: 12
    })
    recommendations.value = firstPass
    recLoading.value = false
  }

  try {
    if (needOnline) {
      await fetchOnlineForMood(emo.mood)
    }

    // 在线结果回来后（或本来就有缓存）用完整候选池重排
    const pool = candidatePool.value
    const list = recommendSongs(pool, emo, {
      strategy: strategy.value,
      limit: 12
    })
    recommendations.value = list
  } finally {
    recLoading.value = false
  }
}

/** 按情绪从在线曲库召回 */
async function fetchOnlineForMood(mood) {
  const keywords = MOOD_SEARCH_KEYWORDS[mood] || []
  if (!keywords.length) return
  onlineState.value = { loading: true, ok: null, msg: '正在从在线曲库召回…' }
  const collected = []
  const seen = new Set()

  // 取 2 个关键词，避免请求过多
  for (const kw of keywords.slice(0, 2)) {
    try {
      const res = await fetch(`./api/search?q=${encodeURIComponent(kw)}`).then((r) => r.json())
      if (!res?.ok || !res.results?.length) continue
      for (const item of res.results.slice(0, 6)) {
        const id = 'online:' + item.title + '|' + item.artist
        if (seen.has(id)) continue
        seen.add(id)
        const anchor = ONLINE_MOOD_ANCHOR[mood]
        collected.push({
          id,
          title: item.title,
          artist: item.artist,
          album: '',
          source: 'online',
          url: item.url,
          cover: item.cover,
          valence: anchor.v,
          arousal: anchor.a,
          energy: anchor.a,
          moods: { [mood]: 0.85 },
          rating: 0.62, // 在线曲目无先验质量分，给中性略低值
          keyword: kw
        })
      }
    } catch {
      // 忽略单个关键词失败
    }
  }

  if (collected.length) {
    onlineSongs.value = collected
    onlineMood.value = mood
    onlineState.value = { loading: false, ok: true, msg: `在线召回 ${collected.length} 首` }
  } else {
    onlineState.value = { loading: false, ok: false, msg: '在线曲库不可用，仅使用本地曲库' }
    onlineSongs.value = []
    onlineMood.value = ''
  }
}

/** 手动切换策略 */
function setStrategy(key) {
  strategy.value = key
  if (result.value) {
    lastRecommendedStrategy = key
    doRecommend()
  }
}

/** 手动重新推荐 */
function reroll() {
  if (!result.value) return
  doRecommend()
}

/* ============================================================ 播放 */

function playSong(song) {
  if (currentSong.value?.id === song.id) {
    // 同一首：切换播放/暂停
    playerRef.value?.toggle()
    return
  }
  currentSong.value = song
  nextTick(() => {
    playerRef.value?.play()
  })
}

function onEnded() {
  const idx = recommendations.value.findIndex((s) => s.id === currentSong.value?.id)
  if (idx >= 0 && idx < recommendations.value.length - 1) {
    playSong(recommendations.value[idx + 1])
  }
}

function onPrev() {
  const idx = recommendations.value.findIndex((s) => s.id === currentSong.value?.id)
  if (idx > 0) playSong(recommendations.value[idx - 1])
}

function onNext() {
  const idx = recommendations.value.findIndex((s) => s.id === currentSong.value?.id)
  if (idx >= 0 && idx < recommendations.value.length - 1) playSong(recommendations.value[idx + 1])
}

function onPlayerStateChange() {
  playing.value = !playerRef.value?.el?.paused
}

/* 监听当前歌曲播放状态（用轮询简化，代价可忽略） */
let pollTimer = null
onMounted(() => {
  pollTimer = setInterval(() => {
    playing.value = !!(playerRef.value?.el && !playerRef.value.el.paused)
  }, 400)

  // 调试出口：把核心检测链路挂到 window 上，
  // 便于在浏览器控制台排查「为什么这张图/这帧视频没识别出人脸」。
  // 只暴露函数引用与只读状态，不改变任何业务行为。
  window.__em = {
    faceapi,
    detector,
    grabFrame,
    detectAll,
    onRequestDetect,
    get result() {
      return result.value
    },
    get status() {
      return detectorStatus.value
    },
    get error() {
      return detectorError.value
    }
  }
})
onBeforeUnmount(() => {
  clearInterval(pollTimer)
  clearTimeout(stableTimer)
  clearTimeout(blankRetryTimer)
})

/* ============================================================ 输入源事件 */

function onImageLoaded({ el }) {
  lastDetectTs = 0
  detector.reset()
  onRequestDetect({ el, kind: 'image', force: true })
}

function onVideoLoaded() {
  detector.reset()
  result.value = null
  faceBoxes.value = []
}

function onVideoFrame(el) {
  if (!autoDetect.value) return
  onRequestDetect({ el, kind: 'video' })
}

function onCameraReady({ el }) {
  detector.reset()
  faceCount.value = 0
  result.value = null
  faceBoxes.value = []
  lastDetectTs = 0
  onRequestDetect({ el, kind: 'camera', force: true })
}

function onCameraError(msg) {
  detectorError.value = msg
}

function onClear() {
  result.value = null
  faceBoxes.value = []
  faceCount.value = 0
  recommendations.value = []
  onlineSongs.value = []
  onlineMood.value = ''
  detector.reset()
  lastRecommendedMood = ''
  detectorStatus.value = 'idle'
  detectorError.value = ''
}

/* ============================================================ 覆盖层坐标换算 */

/** 把图像的原始像素坐标映射到 stage 显示区域 */
const overlayStyle = computed(() => {
  const { w, h } = sourceSize.value
  if (!w || !h || !faceBoxes.value.length) return null
  return { w, h }
})

function boxStyle(box) {
  const { w, h } = sourceSize.value
  if (!w || !h) return {}
  return {
    left: (box.x / w) * 100 + '%',
    top: (box.y / h) * 100 + '%',
    width: (box.width / w) * 100 + '%',
    height: (box.height / h) * 100 + '%',
    borderColor: result.value ? MOOD_META[result.value.mood].color : '#5b5bd6'
  }
}

/* ============================================================ 展示辅助 */

const moodMeta = computed(() => (result.value ? MOOD_META[result.value.mood] : null))
const multiInfo = computed(() => (result.value ? describeMultiFace(result.value) : ''))
const strategyList = Object.values(STRATEGIES)
const currentStrategy = computed(() => STRATEGIES[strategy.value])

const localCount = computed(() => serviceInfo.value.localSongs || 0)
const poolDesc = computed(() => {
  const l = candidatePool.value.filter((s) => s.source === 'local').length
  const o = candidatePool.value.filter((s) => s.source === 'online').length
  return `${l} 本地 + ${o} 在线`
})
</script>

<template>
  <div class="app">
    <!-- ================= Header ================= -->
    <header class="header">
      <div class="brand">
        <div class="logo">
          <span class="logo-mark">♪</span>
        </div>
        <div class="brand-text">
          <h1>情绪电台</h1>
          <p>基于人脸情绪识别的歌曲推荐系统</p>
        </div>
      </div>

      <div class="header-right">
        <!-- 模型状态 -->
        <div class="model-status" :class="modelStatus">
          <span class="ms-dot"></span>
          <template v-if="modelStatus === 'loading'">
            加载模型 {{ modelProgress.index }}/{{ modelProgress.total }}
          </template>
          <template v-else-if="modelStatus === 'ready'">本地模型就绪</template>
          <template v-else>模型加载失败</template>
        </div>
        <button class="doc-btn" @click="showDoc = true">
          <span>算法说明</span>
        </button>
      </div>
    </header>

    <!-- ================= 主体 ================= -->
    <main class="main">
      <!-- ---------- 左栏：输入 ---------- -->
      <section class="col-left">
        <div class="panel card">
          <div class="panel-head">
            <h2>人脸输入</h2>
            <label class="auto-switch" v-if="inputMode === 'camera' || inputMode === 'video'">
              <input type="checkbox" v-model="autoDetect" />
              <span class="sw"></span>
              <span class="sw-label">自动识别</span>
            </label>
          </div>

          <div class="stage-wrap" ref="stageEl">
            <InputSource
              ref="inputRef"
              v-model="inputMode"
              :busy="detectorStatus === 'detecting'"
              :face-count="faceCount"
              @image-loaded="onImageLoaded"
              @video-loaded="onVideoLoaded"
              @video-frame-loop="onVideoFrame"
              @camera-ready="onCameraReady"
              @camera-error="onCameraError"
              @request-detect="onRequestDetect"
              @clear="onClear"
            >
              <template #overlay>
                <div v-if="faceBoxes.length" class="overlay-layer">
                  <div v-for="(b, i) in faceBoxes" :key="i" class="face-box" :style="boxStyle(b)">
                    <span class="face-tag" v-if="i === 0 && result">
                      {{ MOOD_META[result.mood].cn }}
                      {{ (result.confidence * 100).toFixed(0) }}%
                    </span>
                  </div>
                </div>
              </template>
            </InputSource>
          </div>

          <!-- 状态条 -->
          <div class="stage-status">
            <template v-if="modelStatus === 'loading'">
              <span class="st-dot loading"></span>
              正在加载情绪识别模型（{{ modelProgress.name }}）
            </template>
            <template v-else-if="detectorStatus === 'detecting'">
              <span class="st-dot loading"></span>
              识别中…
            </template>
            <template v-else-if="detectorError">
              <span class="st-dot warn"></span>
              {{ detectorError }}
            </template>
            <template v-else-if="result">
              <span class="st-dot ok"></span>
              {{ multiInfo }}
            </template>
            <template v-else>
              <span class="st-dot idle"></span>
              等待输入
            </template>
          </div>
        </div>

        <!-- 情绪建议 -->
        <transition name="fade">
          <div v-if="result" class="advice-card card" :style="{ '--c': moodMeta.color }">
            <div class="advice-head">
              <span class="advice-icon">{{ moodMeta.icon }}</span>
              <span class="advice-title">给「{{ moodMeta.cn }}」的你</span>
            </div>
            <p class="advice-text">{{ moodMeta.advice }}</p>
            <div v-if="result.mixed" class="mixed-note">
              画面中多人情绪存在差异，已按置信度与脸部面积加权取综合结果。
            </div>
          </div>
        </transition>
      </section>

      <!-- ---------- 中栏：情绪 ---------- -->
      <section class="col-mid">
        <div class="panel card mood-card">
          <div class="panel-head">
            <h2>情绪识别结果</h2>
            <span v-if="result" class="head-hint mono">
              V {{ result.va.v.toFixed(2) }} / A {{ result.va.a.toFixed(2) }}
            </span>
          </div>
          <EmotionPanel
            :result="result"
            :status="modelStatus === 'error' ? 'error' : modelStatus === 'loading' ? 'loading' : detectorStatus"
            :error="modelError || detectorError"
            :face-count="faceCount"
          />
        </div>
      </section>

      <!-- ---------- 右栏：推荐 ---------- -->
      <section class="col-right">
        <div class="panel card rec-panel">
          <div class="panel-head">
            <h2>为你推荐</h2>
            <div class="pool-info">
              <span class="pool-chip">{{ poolDesc }}</span>
              <button class="reroll" @click="reroll" :disabled="!result || recLoading" title="重新推荐">
                ↻
              </button>
            </div>
          </div>

          <!-- 策略选择 -->
          <div class="strategy-tabs">
            <button
              v-for="s in strategyList"
              :key="s.key"
              class="strategy-tab"
              :class="{ active: strategy === s.key }"
              @click="setStrategy(s.key)"
              :disabled="!result"
            >
              <span class="s-icon">{{ s.icon }}</span>
              <span class="s-name">{{ s.name }}</span>
            </button>
          </div>
          <p class="strategy-desc">{{ currentStrategy.desc }}</p>

          <div v-if="onlineState.msg" class="online-state" :class="onlineState.ok === false ? 'fail' : onlineState.ok ? 'ok' : ''">
            <span v-if="onlineState.loading" class="mini-spin"></span>
            {{ onlineState.msg }}
          </div>

          <SongList
            :songs="recommendations"
            :current-id="currentSong?.id || ''"
            :playing="playing"
            :loading="recLoading"
            :strategy="strategy"
            @play="playSong"
          />
        </div>
      </section>
    </main>

    <!-- ================= 播放器 ================= -->
    <Player
      ref="playerRef"
      :song="currentSong"
      :playlist="recommendations"
      @ended="onEnded"
      @prev="onPrev"
      @next="onNext"
    />

    <!-- ================= 算法说明弹层 ================= -->
    <AlgoDoc v-if="showDoc" @close="showDoc = false" />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* ---------- Header ---------- */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
}

.logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  display: grid;
  place-items: center;
  box-shadow: 0 3px 10px rgba(99, 102, 241, 0.32);
}

.logo-mark {
  color: #fff;
  font-size: 18px;
  font-weight: 700;
}

.brand-text h1 {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.4px;
  line-height: 1.25;
}

.brand-text p {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.3;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.model-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 5px 11px;
  border-radius: 20px;
}

.ms-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}

.model-status.loading .ms-dot {
  background: #f59e0b;
  animation: blink 1.1s infinite;
}

.model-status.ready .ms-dot {
  background: #10b981;
}

.model-status.error .ms-dot {
  background: #ef4444;
}

@keyframes blink {
  50% {
    opacity: 0.3;
  }
}

.doc-btn {
  font-size: 12.5px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  background: var(--surface);
  transition: all 0.15s;
}

.doc-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
}

/* ---------- 主体布局 ---------- */
/**
 * 三栏布局：输入(可伸缩) | 情绪(约 306px) | 推荐(约 380px)
 * 用 grid 固定两侧、让左栏吸收剩余宽度，保证歌单有足够横向空间显示标题与理由。
 */
.main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(360px, 1fr) 306px 380px;
  gap: 12px;
  padding: 12px 18px 8px;
  overflow: hidden;
}

.col-left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.col-mid {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.col-right {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

.mood-card {
  flex-shrink: 0;
}

.panel {
  padding: 13px 15px;
  flex-shrink: 0;
}

/**
 * 推荐面板占满右栏高度。
 * 内部结构：标题 / 策略切换 / 状态 → 列表（flex:1 可滚动）
 * 这样无论窗口多高，歌单都能完整显示且不被压扁。
 */
.rec-panel {
  flex: 1;
  min-height: 260px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 11px;
}

.panel-head h2 {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  letter-spacing: 0.2px;
}

.head-hint {
  font-size: 10.5px;
  color: var(--text-3);
}

/* ---------- 自动识别开关 ---------- */
.auto-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.auto-switch input {
  display: none;
}

.sw {
  width: 28px;
  height: 16px;
  border-radius: 9px;
  background: var(--border-strong);
  position: relative;
  transition: background 0.2s;
}

.sw::after {
  content: '';
  position: absolute;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  top: 2px;
  left: 2px;
  transition: transform 0.2s;
  box-shadow: var(--shadow-sm);
}

.auto-switch input:checked + .sw {
  background: var(--brand);
}

.auto-switch input:checked + .sw::after {
  transform: translateX(12px);
}

.sw-label {
  font-size: 11.5px;
  color: var(--text-2);
}

/* ---------- 画面区 ---------- */
.stage-wrap {
  position: relative;
}

.overlay-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 4;
  overflow: hidden;
  border-radius: var(--radius);
}

.face-box {
  position: absolute;
  border: 2px solid var(--brand);
  border-radius: 6px;
  transition: all 0.2s ease-out;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5) inset;
}

.face-tag {
  position: absolute;
  top: -20px;
  left: -2px;
  font-size: 10.5px;
  font-weight: 600;
  color: #fff;
  background: inherit;
  padding: 1px 7px;
  border-radius: 5px;
  white-space: nowrap;
  background: rgba(26, 31, 46, 0.8);
}

.stage-status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-2);
  margin-top: 9px;
  min-height: 17px;
}

.st-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.st-dot.ok {
  background: #10b981;
}
.st-dot.warn {
  background: #f59e0b;
}
.st-dot.idle {
  background: #cbd2e2;
}
.st-dot.loading {
  background: var(--brand);
  animation: blink 1s infinite;
}

/* ---------- 建议卡 ---------- */
.advice-card {
  padding: 13px 16px;
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--c) 8%, white),
    color-mix(in srgb, var(--c) 2%, white)
  );
  border-color: color-mix(in srgb, var(--c) 20%, transparent);
  flex-shrink: 0;
}

.advice-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 5px;
}

.advice-icon {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--c);
  color: #fff;
  display: grid;
  place-items: center;
  font-size: 11px;
}

.advice-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.advice-text {
  font-size: 12.2px;
  line-height: 1.72;
  color: var(--text-2);
}

.mixed-note {
  margin-top: 7px;
  font-size: 11px;
  color: #92400e;
  background: #fef3c7;
  border: 1px solid #fde68a;
  padding: 4px 9px;
  border-radius: 6px;
  line-height: 1.6;
}

/* ---------- 推荐面板 ---------- */
.pool-info {
  display: flex;
  align-items: center;
  gap: 7px;
}

.pool-chip {
  font-size: 10.5px;
  color: var(--text-3);
  background: var(--bg-soft);
  padding: 2px 8px;
  border-radius: 5px;
}

.reroll {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 13px;
  border: 1px solid var(--border);
  transition: all 0.15s;
}

.reroll:hover:not(:disabled) {
  color: var(--brand);
  border-color: var(--brand);
  transform: rotate(90deg);
}

.reroll:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.strategy-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  background: var(--bg-soft);
  padding: 4px;
  border-radius: 10px;
}

.strategy-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 4px;
  border-radius: 7px;
  font-size: 12px;
  color: var(--text-2);
  transition: all 0.17s;
}

.strategy-tab:hover:not(:disabled) {
  color: var(--text);
}

.strategy-tab.active {
  background: var(--surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.strategy-tab:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.s-icon {
  font-size: 12px;
  line-height: 1;
}

.strategy-desc {
  font-size: 11.3px;
  color: var(--text-3);
  line-height: 1.6;
  padding: 0 2px;
}

.online-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
  padding: 3px 2px;
}

.online-state.ok {
  color: #059669;
}

.online-state.fail {
  color: #d97706;
}

.mini-spin {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 响应式 ---------- */
@media (max-width: 1360px) {
  .main {
    grid-template-columns: minmax(300px, 1fr) 290px 350px;
    gap: 10px;
    padding: 10px 12px 6px;
  }
}

@media (max-width: 1180px) {
  .main {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    overflow-y: auto;
  }
  .col-left {
    grid-column: 1 / -1;
  }
  .col-mid,
  .col-right {
    overflow: visible;
  }
  .song-list {
    max-height: 420px;
  }
}

@media (max-width: 820px) {
  .app {
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }
  .main {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  .col-left {
    grid-column: auto;
  }
  .rec-panel {
    min-height: 0;
  }
}
</style>
