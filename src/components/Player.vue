<script setup>
/**
 * Player.vue —— 音频播放器
 *
 * 封装 <audio>：播放/暂停、进度、音量、切歌。
 * 在线歌曲通过本地服务中转 (/api/proxy-audio) 以规避第三方 CDN 的
 * CORS 与 Referer 限制，本地歌曲走 /songs 静态服务（支持 Range）。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  song: { type: Object, default: null },
  playlist: { type: Array, default: () => [] }
})

const emit = defineEmits(['ended', 'prev', 'next', 'error'])

const audioEl = ref(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(0.75)
const muted = ref(false)
const loading = ref(false)
const errMsg = ref('')

const progress = computed(() => (duration.value ? (currentTime.value / duration.value) * 100 : 0))
const hasSong = computed(() => !!props.song)

const canPrev = computed(() => {
  if (!props.song) return false
  const i = props.playlist.findIndex((s) => s.id === props.song.id)
  return i > 0
})
const canNext = computed(() => {
  if (!props.song) return false
  const i = props.playlist.findIndex((s) => s.id === props.song.id)
  return i >= 0 && i < props.playlist.length - 1
})

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 计算实际播放地址 */
function resolveSrc(song) {
  if (!song) return ''
  if (song.source === 'local') return song.url
  // 在线歌曲经本地服务中转
  return `/api/proxy-audio?url=${encodeURIComponent(song.url)}`
}

async function play() {
  const el = audioEl.value
  if (!el || !props.song) return
  try {
    await el.play()
    playing.value = true
    errMsg.value = ''
  } catch (e) {
    playing.value = false
    if (e.name === 'NotAllowedError') {
      errMsg.value = '浏览器阻止了自动播放，请再次点击播放'
    } else {
      errMsg.value = '播放失败：' + (e.message || '未知错误')
      emit('error', errMsg.value)
    }
  }
}

function toggle() {
  const el = audioEl.value
  if (!el) return
  if (el.paused) play()
  else {
    el.pause()
    playing.value = false
  }
}

function seek(e) {
  const el = audioEl.value
  if (!el || !duration.value) return
  const rect = e.currentTarget.getBoundingClientRect()
  const ratio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1)
  el.currentTime = ratio * duration.value
}

function setVolume(v) {
  volume.value = v
  muted.value = v === 0
  if (audioEl.value) audioEl.value.volume = v
}

function toggleMute() {
  muted.value = !muted.value
  if (audioEl.value) audioEl.value.muted = muted.value
}

/* ---------- audio 事件 ---------- */
function onLoaded(d) {
  duration.value = audioEl.value?.duration || 0
  loading.value = false
}
function onTimeUpdate() {
  currentTime.value = audioEl.value?.currentTime || 0
}
function onEnded() {
  playing.value = false
  emit('ended')
}
function onCanPlay() {
  loading.value = false
  errMsg.value = ''
}
function onWaiting() {
  loading.value = true
}
function onError() {
  loading.value = false
  playing.value = false
  const code = audioEl.value?.error?.code
  const map = {
    1: '加载被中止',
    2: '网络错误，无法加载音频',
    3: '音频解码失败（格式不支持）',
    4: '音频地址不可用（可能已失效）'
  }
  errMsg.value = '播放失败：' + (map[code] || '未知错误')
  emit('error', errMsg.value)
}

/* ---------- 换歌 ---------- */
watch(
  () => props.song?.id,
  () => {
    const el = audioEl.value
    if (!el) return
    currentTime.value = 0
    duration.value = 0
    errMsg.value = ''
    if (!props.song) {
      el.pause()
      el.removeAttribute('src')
      el.load()
      playing.value = false
      return
    }
    loading.value = true
    el.src = resolveSrc(props.song)
    el.load()
    play()
  }
)

onMounted(() => {
  const el = audioEl.value
  if (el) {
    el.volume = volume.value
    // 减少在线音频的初始缓冲等待
    el.preload = 'auto'
    if (props.song) {
      el.src = resolveSrc(props.song)
      el.load()
    }
  }
})

onBeforeUnmount(() => {
  audioEl.value?.pause()
})

defineExpose({ play, toggle, el: audioEl })
</script>

<template>
  <div class="player" :class="{ empty: !hasSong }">
    <audio
      ref="audioEl"
      preload="auto"
      @loadedmetadata="onLoaded"
      @timeupdate="onTimeUpdate"
      @ended="onEnded"
      @canplay="onCanPlay"
      @waiting="onWaiting"
      @play="playing = true"
      @pause="playing = false"
      @error="onError"
    ></audio>

    <!-- 歌曲信息 -->
    <div class="now-playing">
      <div v-if="hasSong" class="np-cover">
        <div v-if="song.cover && song.cover.startsWith('http')" class="cov-img" :style="{ backgroundImage: `url(${song.cover})` }"></div>
        <div v-else class="cov-icon">{{ playing ? '♪' : '▷' }}</div>
      </div>
      <div v-else class="np-cover placeholder">♪</div>
      <div class="np-meta">
        <div class="np-title">{{ hasSong ? song.title : '未在播放' }}</div>
        <div class="np-sub">
          <template v-if="hasSong">{{ song.artist }}</template>
          <template v-else>从右侧列表选择一首</template>
        </div>
      </div>
    </div>

    <!-- 播放控制 -->
    <div class="controls">
      <button class="ctrl" :disabled="!canPrev" @click="emit('prev')" title="上一首">◀◀</button>
      <button class="ctrl play-btn" :disabled="!hasSong" @click="toggle" :title="playing ? '暂停' : '播放'">
        <span v-if="loading" class="loader"></span>
        <span v-else>{{ playing ? '❙❙' : '▶' }}</span>
      </button>
      <button class="ctrl" :disabled="!canNext" @click="emit('next')" title="下一首">▶▶</button>
    </div>

    <!-- 进度 -->
    <div class="progress-area">
      <span class="time mono">{{ fmt(currentTime) }}</span>
      <div class="track" @click="seek">
        <div class="track-bg"></div>
        <div class="track-fill" :style="{ width: progress + '%' }"></div>
        <div class="track-dot" :style="{ left: progress + '%' }"></div>
      </div>
      <span class="time mono">{{ fmt(duration) }}</span>
    </div>

    <!-- 音量 -->
    <div class="volume-area">
      <button class="vol-btn" @click="toggleMute" :title="muted ? '取消静音' : '静音'">
        {{ muted || volume === 0 ? '🔇' : '🔊' }}
      </button>
      <input
        class="vol-slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="muted ? 0 : volume"
        @input="setVolume(Number($event.target.value))"
      />
    </div>

    <transition name="fade">
      <div v-if="errMsg" class="err-tip">{{ errMsg }}</div>
    </transition>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 11px 18px;
  background: var(--surface);
  border-top: 1px solid var(--border);
  position: relative;
}

.player.empty {
  opacity: 0.72;
}

.now-playing {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  width: 210px;
  flex-shrink: 0;
}

.np-cover {
  width: 40px;
  height: 40px;
  border-radius: 9px;
  overflow: hidden;
  flex-shrink: 0;
  background: linear-gradient(135deg, #c7d2fe, #a5b4fc);
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-sm);
}

.np-cover.placeholder {
  background: var(--bg-soft);
  color: var(--text-3);
  font-size: 16px;
}

.cov-img {
  width: 100%;
  height: 100%;
  background-size: cover;
  background-position: center;
}

.cov-icon {
  font-size: 16px;
  color: #fff;
}

.np-meta {
  min-width: 0;
}

.np-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.np-sub {
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 控制 ---------- */
.controls {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.ctrl {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--text-2);
  transition: all 0.15s;
}

.ctrl:hover:not(:disabled) {
  background: var(--bg-soft);
  color: var(--text);
}

.ctrl:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.play-btn {
  width: 38px;
  height: 38px;
  background: var(--brand);
  color: #fff;
  font-size: 12px;
  letter-spacing: -1px;
  box-shadow: 0 2px 8px rgba(91, 91, 214, 0.3);
}

.play-btn:hover:not(:disabled) {
  background: var(--brand-deep);
  color: #fff;
  transform: scale(1.04);
}

.loader {
  width: 13px;
  height: 13px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 进度 ---------- */
.progress-area {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 100px;
}

.time {
  font-size: 10.5px;
  color: var(--text-3);
  width: 32px;
  text-align: center;
  flex-shrink: 0;
}

.track {
  flex: 1;
  height: 16px;
  position: relative;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.track-bg {
  width: 100%;
  height: 4px;
  background: var(--bg-soft);
  border-radius: 2px;
}

.track-fill {
  position: absolute;
  left: 0;
  height: 4px;
  background: var(--brand);
  border-radius: 2px;
  transition: width 0.1s linear;
}

.track-dot {
  position: absolute;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
  transform: translateX(-50%);
  box-shadow: 0 0 0 3px rgba(91, 91, 214, 0.18);
  transition: left 0.1s linear;
  pointer-events: none;
}

/* ---------- 音量 ---------- */
.volume-area {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  width: 108px;
}

.vol-btn {
  font-size: 13px;
  opacity: 0.7;
  transition: opacity 0.15s;
}

.vol-btn:hover {
  opacity: 1;
}

.vol-slider {
  width: 74px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg-soft);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}

.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
  cursor: pointer;
}

.err-tip {
  position: absolute;
  top: -34px;
  left: 50%;
  transform: translateX(-50%);
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #b91c1c;
  font-size: 11.5px;
  padding: 5px 12px;
  border-radius: 8px;
  white-space: nowrap;
  box-shadow: var(--shadow);
}

@media (max-width: 900px) {
  .volume-area {
    display: none;
  }
  .now-playing {
    width: 150px;
  }
}
</style>
