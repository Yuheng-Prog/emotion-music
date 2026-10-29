<script setup>
/**
 * SongList.vue —— 推荐列表
 *
 * 展示排名、匹配度、推荐理由、播放状态。
 * 每条可展开查看「四维打分拆解」，体现算法的可解释性。
 */
import { ref } from 'vue'

const props = defineProps({
  songs: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
  playing: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
  strategy: { type: String, default: 'repair' }
})

const emit = defineEmits(['play', 'toggle-detail'])

const expanded = ref(new Set())

function isExpanded(id) {
  return expanded.value.has(id)
}

function toggle(id) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
  emit('toggle-detail', id)
}

const COVER_GRADIENT = {
  sunrise: 'linear-gradient(135deg,#fbbf24,#f97316)',
  mist: 'linear-gradient(135deg,#94a3b8,#64748b)',
  glass: 'linear-gradient(135deg,#a5b4fc,#818cf8)',
  rain: 'linear-gradient(135deg,#60a5fa,#3b82f6)',
  spark: 'linear-gradient(135deg,#f87171,#dc2626)',
  rope: 'linear-gradient(135deg,#c4b5fd,#8b5cf6)',
  neon: 'linear-gradient(135deg,#34d399,#10b981)',
  tide: 'linear-gradient(135deg,#7dd3fc,#0ea5e9)',
  kite: 'linear-gradient(135deg,#fcd34d,#f59e0b)',
  current: 'linear-gradient(135deg,#64748b,#475569)',
  iron: 'linear-gradient(135deg,#78716c,#44403c)',
  lighthouse: 'linear-gradient(135deg,#fda4af,#f43f5e)',
  signal: 'linear-gradient(135deg,#fca5a5,#b91c1c)',
  home: 'linear-gradient(135deg,#86efac,#22c55e)',
  window: 'linear-gradient(135deg,#cbd5e1,#94a3b8)',
  steps: 'linear-gradient(135deg,#fdba74,#fb923c)'
}

function coverStyle(song) {
  if (song.cover && song.cover.startsWith('http')) {
    return { backgroundImage: `url(${song.cover})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  return { background: COVER_GRADIENT[song.cover] || 'linear-gradient(135deg,#c7d2fe,#818cf8)' }
}

function scoreColor(v) {
  if (v >= 85) return '#10b981'
  if (v >= 70) return '#5b5bd6'
  if (v >= 55) return '#f59e0b'
  return '#94a3b8'
}

/** 播放器传给 UI 的展示用来源标识 */
function sourceLabel(s) {
  return s.source === 'online' ? '在线' : '本地'
}
</script>

<template>
  <div class="song-list">
    <div v-if="loading" class="list-loading">
      <div class="spinner-sm"></div>
      <span>正在按情绪重新编排歌单…</span>
    </div>

    <div v-else-if="!songs.length" class="list-empty">
      <span>等待情绪结果</span>
    </div>

    <transition-group v-else name="list" tag="div" class="list-body">
      <div
        v-for="song in songs"
        :key="song.id"
        class="song-item"
        :class="{ active: song.id === currentId }"
      >
        <div class="song-main" @click="emit('play', song)">
          <div class="rank" :style="{ color: song.rank <= 3 ? '#5b5bd6' : '#b3bcd2' }">
            {{ String(song.rank).padStart(2, '0') }}
          </div>

          <div class="cover" :style="coverStyle(song)">
            <transition name="fade">
              <span v-if="song.id === currentId && playing" class="eq">
                <i></i><i></i><i></i>
              </span>
            </transition>
          </div>

          <div class="meta">
            <div class="title-row">
              <span class="title">{{ song.title }}</span>
              <span class="src" :class="song.source">{{ sourceLabel(song) }}</span>
            </div>
            <div class="artist">{{ song.artist }}</div>
            <div class="reasons">
              <span v-for="(r, i) in song.reasons.slice(0, 2)" :key="i" class="reason">{{ r }}</span>
            </div>
          </div>

          <div class="score">
            <span class="score-num" :style="{ color: scoreColor(song.matchPercent) }">
              {{ song.matchPercent }}
            </span>
            <span class="score-unit">%</span>
          </div>
        </div>

        <div class="song-foot">
          <button class="expand-btn" @click="toggle(song.id)">
            {{ isExpanded(song.id) ? '收起' : '打分拆解' }}
            <span class="chev" :class="{ open: isExpanded(song.id) }">▾</span>
          </button>
          <button class="tooggle" v-if="song.id !== currentId" @click="emit('play', song)">播放</button>
          <button v-else class="tooggle primary" @click="emit('play', song)">
            {{ playing ? '暂停' : '继续' }}
          </button>
        </div>

        <transition name="fade">
          <div v-if="isExpanded(song.id)" class="breakdown">
            <div class="bd-row">
              <span class="bd-k">效价 V</span>
              <div class="bd-track">
                <div class="bd-center"></div>
                <div
                  class="bd-fill"
                  :style="{
                    left: song.valence >= 0 ? '50%' : (50 + song.valence * 50) + '%',
                    width: Math.abs(song.valence) * 50 + '%',
                    background: song.valence >= 0 ? '#10b981' : '#3b82f6'
                  }"
                ></div>
              </div>
              <span class="bd-v mono">{{ song.valence.toFixed(2) }}</span>
            </div>
            <div class="bd-row">
              <span class="bd-k">唤醒 A</span>
              <div class="bd-track">
                <div
                  class="bd-fill left0"
                  :style="{ width: song.arousal * 100 + '%', background: '#f59e0b' }"
                ></div>
              </div>
              <span class="bd-v mono">{{ song.arousal.toFixed(2) }}</span>
            </div>
            <div class="bd-chips">
              <span class="bd-chip">VA 相似 {{ ((song._parts?.vaSim || 0) * 100).toFixed(0) }}%</span>
              <span class="bd-chip">标签命中 {{ ((song._parts?.moodMatch || 0) * 100).toFixed(0) }}%</span>
              <span class="bd-chip">能量匹配 {{ ((song._parts?.energySim || 0) * 100).toFixed(0) }}%</span>
              <span v-if="song.bpm" class="bd-chip">BPM {{ song.bpm }}</span>
            </div>
            <ul class="bd-reasons">
              <li v-for="(r, i) in song.reasons" :key="i">{{ r }}</li>
            </ul>
          </div>
        </transition>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.song-list {
  flex: 1;
  min-height: 150px;
  overflow-y: auto;
  padding-right: 2px;
}

.list-loading,
.list-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 44px 10px;
  font-size: 12.5px;
  color: var(--text-3);
}

.spinner-sm {
  width: 15px;
  height: 15px;
  border: 2px solid var(--border);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.list-body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.song-item {
  border-radius: 11px;
  border: 1px solid transparent;
  transition: background 0.16s ease, border-color 0.16s ease;
}

.song-item:hover {
  background: var(--surface-2);
}

.song-item.active {
  background: var(--brand-soft);
  border-color: color-mix(in srgb, var(--brand) 22%, transparent);
}

.song-main {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 9px 4px;
  cursor: pointer;
}

.rank {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  width: 20px;
  flex-shrink: 0;
  text-align: center;
}

.cover {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
  position: relative;
}

.eq {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 15px;
}

.eq i {
  width: 3px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 2px;
  animation: eqb 0.85s ease-in-out infinite;
}

.eq i:nth-child(1) {
  height: 60%;
  animation-delay: 0s;
}
.eq i:nth-child(2) {
  height: 100%;
  animation-delay: 0.25s;
}
.eq i:nth-child(3) {
  height: 45%;
  animation-delay: 0.5s;
}

@keyframes eqb {
  0%,
  100% {
    transform: scaleY(0.45);
  }
  50% {
    transform: scaleY(1);
  }
}

.meta {
  flex: 1;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.src {
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 4px;
  flex-shrink: 0;
  font-weight: 500;
}

.src.local {
  background: #dbeafe;
  color: #1d4ed8;
}

.src.online {
  background: #fce7f3;
  color: #be185d;
}

.artist {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.reasons {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 3px;
}

.reason {
  font-size: 10px;
  color: var(--text-2);
  background: var(--bg-soft);
  padding: 1px 6px;
  border-radius: 4px;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.score {
  display: flex;
  align-items: baseline;
  flex-shrink: 0;
  min-width: 38px;
  justify-content: flex-end;
}

.score-num {
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 700;
  line-height: 1;
}

.score-unit {
  font-size: 9px;
  color: var(--text-3);
  margin-left: 1px;
}

.song-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px 6px 34px;
}

.expand-btn {
  font-size: 10.5px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 3px;
}

.expand-btn:hover {
  color: var(--brand);
}

.chev {
  font-size: 8px;
  transition: transform 0.2s;
}

.chev.open {
  transform: rotate(180deg);
}

.tooggle {
  margin-left: auto;
  font-size: 11px;
  padding: 3px 11px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-2);
  background: var(--surface);
  transition: all 0.15s;
}

.tooggle:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.tooggle.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}

/* ---------- 拆解 ---------- */
.breakdown {
  padding: 2px 10px 9px 34px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bd-row {
  display: grid;
  grid-template-columns: 44px 1fr 40px;
  align-items: center;
  gap: 8px;
}

.bd-k {
  font-size: 10.5px;
  color: var(--text-3);
}

.bd-track {
  height: 6px;
  background: #eef0f6;
  border-radius: 3px;
  position: relative;
  overflow: hidden;
}

.bd-center {
  position: absolute;
  left: 50%;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #cbd2e2;
}

.bd-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 3px;
}

.bd-fill.left0 {
  left: 0;
}

.bd-v {
  font-size: 10.5px;
  color: var(--text-2);
  text-align: right;
}

.bd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.bd-chip {
  font-size: 10px;
  color: var(--brand-deep);
  background: var(--brand-soft);
  padding: 1px 6px;
  border-radius: 4px;
}

.bd-reasons {
  margin: 3px 0 0;
  padding-left: 14px;
  font-size: 10.5px;
  color: var(--text-2);
  line-height: 1.7;
}
</style>
