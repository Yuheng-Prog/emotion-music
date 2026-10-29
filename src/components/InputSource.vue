<script setup>
/**
 * InputSource.vue —— 四种输入源统一入口
 *
 *   image  拖拽/选择本地图片
 *   video  打开本地视频文件，边播边识别
 *   camera 实时摄像头，逐帧识别
 *   photo  摄像头拍照，单帧识别
 *
 * 组件只负责「拿到画面」，识别由父组件驱动的循环完成，
 * 这样能把检测频率、时序状态和 UI 解耦。
 */
import { ref, computed, onBeforeUnmount, watch, nextTick } from 'vue'

const props = defineProps({
  /** 当前模式: image | video | camera | photo */
  modelValue: { type: String, default: 'image' },
  /** 是否正在识别（识别时禁用切换） */
  busy: { type: Boolean, default: false },
  /** 当前是否已检测到人脸（用于摄像头状态提示） */
  faceCount: { type: Number, default: 0 }
})

const emit = defineEmits([
  'update:modelValue',
  'image-loaded',
  'video-loaded',
  'camera-ready',
  'camera-error',
  'video-frame-loop',
  'request-detect',
  'clear'
])

const mode = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const IMAGE_ACCEPT = 'image/png,image/jpeg,image/jpg,image/webp,image/bmp'
const VIDEO_ACCEPT = 'video/mp4,video/webm,video/ogg,video/quicktime,.mp4,.webm,.mov,.m4v'

/**
 * 内置演示图。
 *
 * 现场演示时现场拍脸受光线、角度、设备影响很大，
 * 这里预置一组 7 种表情 + 1 张多人合影，覆盖全部五类情绪
 * 以及多人聚合分支，点一下就出结果。
 *
 * expect 只是给用户看的「这张图应该识别成什么」，
 * 不参与任何判定逻辑 —— 识别完全由算法算出来。
 */
const DEMO_FACES = [
  { file: '01-happy.png', label: '开心', hint: 'happy', icon: '☺' },
  { file: '02-calm.png', label: '平静', hint: 'calm', icon: '◡' },
  { file: '03-sad.png', label: '悲伤', hint: 'sad', icon: '☹' },
  { file: '04-angry.png', label: '愤怒', hint: 'angry', icon: '☹' },
  { file: '05-anxious.png', label: '焦虑', hint: 'fearful', icon: '◞' },
  { file: '06-surprised.png', label: '惊讶', hint: 'fearful', icon: '○' },
  { file: '07-disgusted.png', label: '厌恶', hint: 'angry', icon: '◝' },
  { file: '08-group.png', label: '合影', hint: '多人聚合', icon: '☰' }
]

const imageUrl = ref('')
const imageName = ref('')
const videoUrl = ref('')
const videoName = ref('')
const cameraActive = ref(false)
const cameraError = ref('')
const dragOver = ref(false)
const photoFlash = ref(false)
/** public 目录基址，Vite 会注入正确的部署前缀 */
const BASE = import.meta.env.BASE_URL

const imgEl = ref(null)
const videoEl = ref(null)
const camEl = ref(null)
const canvasEl = ref(null)
const fileInput = ref(null)
const videoInput = ref(null)
const currentAccept = ref(IMAGE_ACCEPT)

let cameraStream = null
let videoRafId = null
let videoDetectTimer = null

/* ------------------------------------------------------------ 工具 */

function revoke(url) {
  if (url && url.startsWith('blob:')) URL.revokeObjectURL(url)
}

function pickImage() {
  currentAccept.value = IMAGE_ACCEPT
  nextTick(() => fileInput.value?.click())
}

function pickVideo() {
  currentAccept.value = VIDEO_ACCEPT
  nextTick(() => fileInput.value?.click())
}

/* ------------------------------------------------------------ 图片 */

function handleImageFile(file) {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    cameraError.value = '请选择图片文件（PNG / JPG / WebP）'
    return
  }
  revoke(imageUrl.value)
  demoActive.value = ''
  imageName.value = file.name
  imageUrl.value = URL.createObjectURL(file)
  cameraError.value = ''
  mode.value = 'image'
  stopCamera()
  nextTick(() => {
    if (imgEl.value?.complete) {
      emit('image-loaded', { el: imgEl.value, name: file.name })
    }
  })
}

function onImgLoad() {
  emit('image-loaded', { el: imgEl.value, name: imageName.value })
}

/**
 * 选用内置演示图。
 *
 * 走和本地选图完全相同的路径（imageUrl + mode='image' + image-loaded），
 * 这样演示图与真实上传图在后续识别流程上没有任何差异，
 * 不会出现「演示能用、自己传图不行」这种只测了特殊路径的假象。
 */
const demoActive = ref('')
function pickDemo(item) {
  revoke(imageUrl.value)
  stopCamera()
  mode.value = 'image'
  demoActive.value = item.file
  imageName.value = `演示图 · ${item.label}`
  // public 目录下的静态资源，直接用绝对路径，无需 objectURL
  imageUrl.value = `${import.meta.env.BASE_URL}demo-faces/${item.file}`
  cameraError.value = ''
  nextTick(() => {
    if (imgEl.value?.complete) {
      emit('image-loaded', { el: imgEl.value, name: imageName.value, demo: item.file })
    }
  })
}

/* ------------------------------------------------------------ 视频文件 */

/**
 * 等视频首帧可读后触发一次识别。
 *
 * 为什么不只靠事件：`v.load()` 是同步发起的，loadeddata 可能在我们
 * 拿到 ref 之前就已经派发完，只挂 @loadeddata 会漏掉这一次。
 * 因此用轮询 readyState >= HAVE_CURRENT_DATA 作兜底，
 * 两种方式都到位、靠一个标记防重复。
 */
let firstFrameTimer = null
function waitFirstFrameAndDetect() {
  clearTimeout(firstFrameTimer)
  const t0 = Date.now()
  const tick = () => {
    const v = videoEl.value
    if (!v) return
    if (v.readyState >= 2 && v.videoWidth > 0) {
      // 再等一帧，确保画面已真正合成
      requestAnimationFrame(() => requestVideoDetect(true))
      return
    }
    if (Date.now() - t0 > 8000) return // 超时放弃，用户仍可点「识别当前帧」
    firstFrameTimer = setTimeout(tick, 120)
  }
  firstFrameTimer = setTimeout(tick, 60)
}

function handleVideoFile(file) {
  if (!file) return
  const okType = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogg)$/i.test(file.name)
  if (!okType) {
    cameraError.value = '请选择视频文件（MP4 / WebM / MOV）'
    return
  }
  revoke(videoUrl.value)
  videoName.value = file.name
  videoUrl.value = URL.createObjectURL(file)
  cameraError.value = ''
  mode.value = 'video'
  stopCamera()
  stopVideoLoop()
  nextTick(() => {
    const v = videoEl.value
    if (!v) return
    v.load()
    // 视频加载后停在首帧，自动识别这一帧，用户无需先点播放
    waitFirstFrameAndDetect()
  })
}

function onVideoMeta() {
  const v = videoEl.value
  if (!v) return
  emit('video-loaded', { el: v, name: videoName.value, duration: v.duration })
  // 自动识别由 waitFirstFrameAndDetect() 负责（事件可能被错过，用轮询更稳）
}

/**
 * 视频已解出可播放的当前帧（loadeddata）。
 *
 * 作为 waitFirstFrameAndDetect() 的提前触发途径之一：
 * 若事件正好在挂载后派发，就能立刻识别，无需等轮询的下一拍。
 * 重复触发由父组件的 detectBusy 去重，不会重复推理。
 */
function onVideoData() {
  const v = videoEl.value
  if (!v) return
  // 播放中就不必额外触发，video-frame-loop 会持续识别
  if (!v.paused) return
  requestAnimationFrame(() => {
    requestVideoDetect(true)
  })
}

function onVideoPlay() {
  startVideoLoop()
}

function onVideoPause() {
  stopVideoLoop()
}

function onVideoSeek() {
  // 拖动进度条后立即识别一帧
  requestVideoDetect(true)
}

/**
 * 视频帧循环：
 *   requestVideoFrameCallback 优先（与浏览器渲染同步、最省资源），
 *   不支持时退回 requestAnimationFrame。
 *   每帧都调用回调由父组件决定是否真正做检测（节流）。
 */
function startVideoLoop() {
  stopVideoLoop()
  const v = videoEl.value
  if (!v) return
  const step = () => {
    if (v.paused || v.ended) return
    emit('video-frame-loop', v)
    if ('requestVideoFrameCallback' in v) {
      videoRafId = v.requestVideoFrameCallback(step)
    } else {
      videoRafId = requestAnimationFrame(step)
    }
  }
  emit('video-frame-loop', v)
  if ('requestVideoFrameCallback' in v) {
    videoRafId = v.requestVideoFrameCallback(step)
  } else {
    videoRafId = requestAnimationFrame(step)
  }
}

function stopVideoLoop() {
  const v = videoEl.value
  if (videoRafId != null) {
    if (v && 'cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(videoRafId)
    cancelAnimationFrame(videoRafId)
    videoRafId = null
  }
}

function requestVideoDetect(force = false) {
  const v = videoEl.value
  if (!v || v.readyState < 2) return
  emit('request-detect', { el: v, force, kind: 'video' })
}

/* ------------------------------------------------------------ 摄像头 */

async function startCamera() {
  cameraError.value = ''
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError.value =
      '当前环境不支持摄像头访问。请使用 http://localhost 或 https 打开页面（浏览器要求安全上下文）。'
    emit('camera-error', cameraError.value)
    return
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: false
    })
    const el = camEl.value
    if (!el) return
    el.srcObject = cameraStream
    await el.play()
    cameraActive.value = true
    emit('camera-ready', { el })
  } catch (e) {
    cameraActive.value = false
    const map = {
      NotAllowedError: '摄像头权限被拒绝。请在浏览器地址栏左侧的权限设置中允许摄像头访问。',
      NotFoundError: '未找到摄像头设备。',
      NotReadableError: '摄像头被其他程序占用（如会议软件），请关闭后重试。',
      OverconstrainedError: '摄像头不支持请求的分辨率。'
    }
    cameraError.value = map[e.name] || `无法访问摄像头：${e.message}`
    emit('camera-error', cameraError.value)
  }
}

function stopCamera() {
  stopCameraLoop()
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop())
    cameraStream = null
  }
  cameraActive.value = false
  if (camEl.value) camEl.value.srcObject = null
}

/* ------------------------------------------------------------ 摄像头逐帧循环 */

let camRafId = null

function startCameraLoop() {
  stopCameraLoop()
  emit('request-detect', { el: camEl.value, kind: 'camera', force: true })
  const loop = () => {
    if (!cameraActive.value) return
    emit('request-detect', { el: camEl.value, kind: 'camera' })
    camRafId = requestAnimationFrame(loop)
  }
  camRafId = requestAnimationFrame(loop)
}

function stopCameraLoop() {
  if (camRafId != null) {
    cancelAnimationFrame(camRafId)
    camRafId = null
  }
}

/* ------------------------------------------------------------ 拍照 */

async function takePhoto() {
  const c = canvasEl.value
  const el = camEl.value
  if (!c || !el || !cameraActive.value) return
  const w = el.videoWidth
  const h = el.videoHeight
  if (!w || !h) return
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  // 镜像翻转，与预览一致（前置摄像头自拍习惯）
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(el, 0, 0, w, h)
  ctx.restore()

  photoFlash.value = true
  setTimeout(() => (photoFlash.value = false), 220)

  const dataUrl = c.toDataURL('image/jpeg', 0.92)
  revoke(imageUrl.value)
  imageUrl.value = dataUrl
  imageName.value = `拍照 ${new Date().toLocaleTimeString('zh-CN')}`
  mode.value = 'photo'
  stopCamera()
  nextTick(() => {
    emit('image-loaded', { el: imgEl.value, name: imageName.value, fromPhoto: true })
  })
}

/* ------------------------------------------------------------ 模式切换 */

/**
 * 重拍：清掉上一张照片并重新打开摄像头预览。
 *
 * 拍照模式下模板优先显示已拍的照片，若直接 startCamera()，
 * 摄像头虽然在跑但被静态图挡住，用户看不到预览。
 * 所以先把 imageUrl 清空，让模板回到「摄像头预览」分支。
 */
async function reshoot() {
  revoke(imageUrl.value)
  imageUrl.value = ''
  imageName.value = ''
  await startCamera()
  if (cameraActive.value) startCameraLoop()
}

async function setMode(m) {
  if (props.busy && (m === 'camera' || m === 'photo')) return
  cameraError.value = ''

  if (m === 'camera' || m === 'photo') {
    mode.value = m
    if (!cameraActive.value) await startCamera()
    if (cameraActive.value && m === 'camera') startCameraLoop()
    else stopCameraLoop()
  } else if (m === 'image') {
    stopCamera()
    mode.value = 'image'
    if (!imageUrl.value) pickImage()
  } else if (m === 'video') {
    stopCamera()
    mode.value = 'video'
    if (!videoUrl.value) pickVideo()
  }
}

function clearAll() {
  revoke(imageUrl.value)
  revoke(videoUrl.value)
  imageUrl.value = ''
  imageName.value = ''
  videoUrl.value = ''
  videoName.value = ''
  startCameraStopIfActive()
  emit('clear')
}

function startCameraStopIfActive() {
  stopCamera()
}

/* ------------------------------------------------------------ 统一文件选择回调 */

function onFileInputChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogg)$/i.test(file.name)) {
    handleVideoFile(file)
  } else {
    handleImageFile(file)
  }
  e.target.value = ''
}

/* ------------------------------------------------------------ 拖拽 */

function onDrop(e) {
  e.preventDefault()
  dragOver.value = false
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  if (file.type.startsWith('video/')) handleVideoFile(file)
  else if (file.type.startsWith('image/')) handleImageFile(file)
  else {
    // 有些系统对 webp/bmp 的 MIME 识别不准，按扩展名兜底
    if (/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) handleImageFile(file)
    else cameraError.value = '不支持的文件类型'
  }
}

/* ------------------------------------------------------------ 生命周期 */

watch(
  () => props.modelValue,
  (m) => {
    if (m !== 'camera' && m !== 'photo') stopCameraLoop()
    if (m !== 'video') stopVideoLoop()
  }
)

onBeforeUnmount(() => {
  stopCamera()
  stopVideoLoop()
  clearTimeout(firstFrameTimer)
  revoke(imageUrl.value)
  revoke(videoUrl.value)
})

/* 给父组件用的方法 */
defineExpose({
  setMode,
  takePhoto,
  startCameraLoop,
  stopCameraLoop,
  requestVideoDetect,
  videoEl,
  camEl
})
</script>

<template>
  <div class="input-source">
    <!-- 模式切换 -->
    <div class="mode-tabs">
      <button
        v-for="m in [
          { k: 'image', label: '图片', icon: '▣' },
          { k: 'video', label: '视频', icon: '▶' },
          { k: 'camera', label: '摄像头', icon: '◉' },
          { k: 'photo', label: '拍照', icon: '◐' }
        ]"
        :key="m.k"
        class="mode-tab"
        :class="{ active: mode === m.k }"
        @click="setMode(m.k)"
      >
        <span class="tab-icon">{{ m.icon }}</span>
        <span>{{ m.label }}</span>
      </button>
    </div>

    <!-- 画面区 -->
    <div
      class="stage"
      :class="{ 'drag-over': dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop="onDrop"
    >
      <!-- 图片模式 -->
      <template v-if="mode === 'image'">
        <div v-if="!imageUrl" class="empty-stage" @click="pickImage">
          <div class="empty-icon">▣</div>
          <p class="empty-title">拖拽图片到这里，或点击选择</p>
          <p class="empty-sub">
            支持 PNG / JPG / WebP，建议使用正面清晰的单人照
            <br />
            也可以直接点下面的演示图快速体验
          </p>
        </div>
        <img v-else ref="imgEl" :src="imageUrl" class="frame-img" @load="onImgLoad" alt="待识别图片" />
        <div v-if="imageName" class="stage-badge">{{ imageName }}</div>
        <transition name="fade">
          <div v-if="photoFlash" class="flash"></div>
        </transition>
      </template>

      <!-- 拍照模式：已拍到照片 → 展示静态照；否则 → 实时预览 + 拍照 -->
      <template v-else-if="mode === 'photo' && imageUrl">
        <img ref="imgEl" :src="imageUrl" class="frame-img" @load="onImgLoad" alt="拍摄的照片" />
        <div v-if="imageName" class="stage-badge">{{ imageName }}</div>
        <transition name="fade">
          <div v-if="photoFlash" class="flash"></div>
        </transition>
      </template>

      <!-- 视频 -->
      <template v-else-if="mode === 'video'">
        <div v-if="!videoUrl" class="empty-stage" @click="pickVideo">
          <div class="empty-icon">▶</div>
          <p class="empty-title">选择本地视频文件</p>
          <p class="empty-sub">支持 MP4 / WebM / MOV，播放时会逐帧识别情绪</p>
        </div>
        <video
          v-else
          ref="videoEl"
          :src="videoUrl"
          class="frame-img"
          controls
          playsinline
          @loadedmetadata="onVideoMeta"
          @loadeddata="onVideoData"
          @play="onVideoPlay"
          @pause="onVideoPause"
          @seeked="onVideoSeek"
          @ended="stopVideoLoop"
        ></video>
        <div v-if="videoName" class="stage-badge">{{ videoName }}</div>
      </template>

      <!-- 摄像头 -->
      <template v-else>
        <video ref="camEl" class="frame-img mirrored" autoplay playsinline muted></video>
        <div v-if="!cameraActive" class="empty-stage overlay" @click="startCamera">
          <div class="empty-icon">◉</div>
          <p class="empty-title">{{ cameraError || '点击开启摄像头' }}</p>
          <p v-if="!cameraError" class="empty-sub">画面仅在本地处理，不会上传任何数据</p>
        </div>
        <div v-else class="cam-status" :class="{ ok: faceCount > 0 }">
          <span class="dot"></span>
          {{ faceCount > 0 ? `已锁定 ${faceCount} 张人脸` : '正在寻找人脸…' }}
        </div>
      </template>

      <!-- 检测框覆盖层（由父组件通过 slot 注入） -->
      <slot name="overlay"></slot>
    </div>

    <canvas ref="canvasEl" class="hidden-canvas"></canvas>

    <!-- 演示图选择条：仅在图片模式下出现，点一下即识别 -->
    <div v-if="mode === 'image'" class="demo-strip">
      <div class="demo-head">
        <span class="demo-title">演示样张</span>
        <span class="demo-note">点选即识别，覆盖五类情绪与多人合影</span>
      </div>
      <div class="demo-list">
        <button
          v-for="d in DEMO_FACES"
          :key="d.file"
          class="demo-item"
          :class="{ active: demoActive === d.file }"
          :title="`${d.label}（算法判定目标：${d.hint}）`"
          @click="pickDemo(d)"
        >
          <img :src="`${BASE}demo-faces/${d.file}`" :alt="d.label" loading="lazy" />
          <span class="demo-label">{{ d.label }}</span>
        </button>
      </div>
    </div>

    <!-- 底部操作 -->
    <div class="source-actions">
      <template v-if="mode === 'image'">
        <button class="btn" @click="pickImage">更换图片</button>
      </template>
      <template v-else-if="mode === 'video'">
        <button class="btn" @click="pickVideo">更换视频</button>
        <button class="btn" @click="requestVideoDetect(true)">识别当前帧</button>
      </template>
      <template v-else>
        <button v-if="!cameraActive" class="btn primary" @click="reshoot">开启摄像头</button>
        <template v-else>
          <button v-if="mode === 'camera'" class="btn primary" @click="takePhoto">
            拍照并识别
          </button>
          <button v-else class="btn primary" @click="takePhoto">拍照</button>
        </template>
      </template>
      <button class="btn ghost" @click="clearAll">清空</button>
    </div>

    <!-- 隐藏的文件输入 -->
    <input
      ref="fileInput"
      type="file"
      class="hidden-input"
      :accept="currentAccept"
      @change="onFileInputChange"
    />
  </div>
</template>

<style scoped>
.input-source {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ---------- 模式切换 ---------- */
.mode-tabs {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  background: var(--bg-soft);
  padding: 5px;
  border-radius: 12px;
}

.mode-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 9px 6px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-2);
  transition: all 0.18s ease;
  white-space: nowrap;
}

.mode-tab:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.7);
}

.mode-tab.active {
  background: var(--surface);
  color: var(--brand);
  box-shadow: var(--shadow-sm);
  font-weight: 600;
}

.tab-icon {
  font-size: 13px;
  line-height: 1;
}

/* ---------- 画面区 ---------- */
.stage {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  background: #f1f3f8;
  border: 1.5px dashed var(--border-strong);
  min-height: 340px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.stage.drag-over {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.empty-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 24px;
  width: 100%;
  height: 100%;
  min-height: 340px;
  cursor: pointer;
  text-align: center;
}

.empty-stage.overlay {
  position: absolute;
  inset: 0;
  background: rgba(246, 247, 251, 0.92);
  z-index: 3;
}

.empty-icon {
  font-size: 32px;
  color: var(--text-3);
  opacity: 0.7;
  margin-bottom: 2px;
}

.empty-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text-2);
}

.empty-sub {
  font-size: 12.5px;
  color: var(--text-3);
  max-width: 320px;
  line-height: 1.65;
}

.frame-img {
  width: 100%;
  height: auto;
  max-height: 460px;
  object-fit: contain;
  display: block;
  background: #1a1f2e;
}

video.frame-img {
  max-height: 460px;
}

.mirrored {
  transform: scaleX(-1);
}

.stage-badge {
  position: absolute;
  left: 10px;
  bottom: 10px;
  background: rgba(26, 31, 46, 0.72);
  color: #fff;
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 20px;
  backdrop-filter: blur(6px);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  z-index: 2;
}

.cam-status {
  position: absolute;
  top: 10px;
  left: 10px;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(26, 31, 46, 0.7);
  color: #fff;
  font-size: 11.5px;
  padding: 4px 11px;
  border-radius: 20px;
  backdrop-filter: blur(6px);
  z-index: 2;
}

.cam-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7);
  animation: pulse 1.6s infinite;
}

.cam-status.ok .dot {
  background: #10b981;
  box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.5);
  }
  70% {
    box-shadow: 0 0 0 7px rgba(255, 255, 255, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
  }
}

.flash {
  position: absolute;
  inset: 0;
  background: #fff;
  z-index: 5;
  pointer-events: none;
}

/* ---------- 操作按钮 ---------- */
.source-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.btn {
  padding: 8px 16px;
  border-radius: 9px;
  font-size: 13.5px;
  font-weight: 500;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  transition: all 0.16s ease;
}

.btn:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
  box-shadow: 0 2px 8px rgba(91, 91, 214, 0.28);
}

.btn.primary:hover {
  background: var(--brand-deep);
  color: #fff;
}

.btn.ghost {
  margin-left: auto;
  background: transparent;
  border-color: transparent;
  color: var(--text-3);
}

.btn.ghost:hover {
  color: var(--text-2);
  background: var(--bg-soft);
}

.hidden-input,
.hidden-canvas {
  display: none;
}

/* ---------- 演示样张 ---------- */
.demo-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
  border-radius: 12px;
  background: var(--bg-soft);
}

.demo-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.demo-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}

.demo-note {
  font-size: 11.5px;
  color: var(--text-3);
}

.demo-list {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 6px;
}

.demo-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 9px;
  border: 1.5px solid transparent;
  background: var(--surface);
  transition: all 0.16s ease;
  cursor: pointer;
  overflow: hidden;
}

.demo-item img {
  width: 100%;
  aspect-ratio: 1 / 1;
  object-fit: cover;
  border-radius: 6px;
  display: block;
}

.demo-item .demo-label {
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.2;
  white-space: nowrap;
}

.demo-item:hover {
  border-color: var(--brand);
  transform: translateY(-1px);
}

.demo-item.active {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.demo-item.active .demo-label {
  color: var(--brand);
  font-weight: 600;
}

@media (max-width: 720px) {
  .demo-list {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
