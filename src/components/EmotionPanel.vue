<script setup>
/**
 * EmotionPanel.vue —— 情绪结果展示
 *
 *  1. 主导情绪大卡片 + 置信度环
 *  2. 5 大情绪概率条
 *  3. 7 类表情原始概率条（可展开，体现"算法透明"）
 *  4. 几何特征与质量诊断（可展开）
 */
import { computed, ref } from 'vue'
import { EXPRESSION_LABELS, EXPRESSION_CN, MOODS, MOOD_META } from '../algorithms/emotionDetector.js'

const props = defineProps({
  result: { type: Object, default: null },
  status: { type: String, default: 'idle' }, // idle | loading | detecting | done | error
  error: { type: String, default: '' },
  faceCount: { type: Number, default: 0 }
})

const showDetail = ref(false)

const meta = computed(() => (props.result ? MOOD_META[props.result.mood] : null))

const confPercent = computed(() =>
  props.result ? Math.round(props.result.confidence * 100) : 0
)

/** 置信度环周长 */
const R = 42
const CIRC = 2 * Math.PI * R
const dashOffset = computed(() => CIRC * (1 - confPercent.value / 100))

const moodBars = computed(() => {
  if (!props.result) return []
  return MOODS.map((m) => ({
    key: m,
    name: MOOD_META[m].cn,
    color: MOOD_META[m].color,
    value: props.result.moods[m] || 0,
    isTop: m === props.result.mood
  })).sort((a, b) => b.value - a.value)
})

const exprBars = computed(() => {
  if (!props.result) return []
  return EXPRESSION_LABELS.map((k) => ({
    key: k,
    name: EXPRESSION_CN[k],
    en: k,
    raw: props.result.rawExpressions?.[k] || 0,
    fused: props.result.expressions?.[k] || 0
  })).sort((a, b) => b.fused - a.fused)
})

const geo = computed(() => props.result?.geometry || null)

const geoItems = computed(() => {
  if (!geo.value) return []
  const g = geo.value
  return [
    { k: '嘴角上扬度', v: g.smileCurvature, fmt: (x) => (x * 100).toFixed(0) + '%' },
    { k: '唇部开度', v: g.mouthOpen, fmt: (x) => (x * 100).toFixed(0) + '%' },
    { k: '眉毛抬升', v: g.browRaise, fmt: (x) => (x * 100).toFixed(0) + '%' },
    { k: '眉内下压', v: g.browInnerDown, fmt: (x) => (x * 100).toFixed(0) + '%' },
    { k: '眉内上扬', v: g.browInnerUp, fmt: (x) => (x * 100).toFixed(0) + '%' },
    { k: '眼睛开合比', v: Math.min(g.ear / 0.45, 1), fmt: () => g.ear.toFixed(3) }
  ]
})

const qualityLabel = computed(() => {
  const o = props.result?.quality?.overall || 0
  if (o >= 0.8) return { text: '优秀', cls: 'good' }
  if (o >= 0.6) return { text: '良好', cls: 'ok' }
  if (o >= 0.4) return { text: '一般', cls: 'warn' }
  return { text: '较差', cls: 'bad' }
})
</script>

<template>
  <div class="emotion-panel">
    <!-- 空态 / 加载态 -->
    <div v-if="!result" class="placeholder">
      <template v-if="status === 'loading'">
        <div class="spinner"></div>
        <p class="ph-title">正在加载情绪识别模型…</p>
        <p class="ph-sub">本地推理，无需联网</p>
      </template>
      <template v-else-if="status === 'error'">
        <div class="ph-icon err">!</div>
        <p class="ph-title">识别出错</p>
        <p class="ph-sub">{{ error }}</p>
      </template>
      <template v-else>
        <div class="ph-icon">◐</div>
        <p class="ph-title">等待识别</p>
        <p class="ph-sub">载入人脸后自动分析情绪</p>
      </template>
    </div>

    <template v-else>
      <!-- 主导情绪 -->
      <div class="mood-hero" :style="{ '--mood-color': meta.color }">
        <div class="hero-left">
          <div class="mood-icon">{{ meta.icon }}</div>
          <div>
            <div class="mood-name">
              {{ meta.cn }}
              <span class="mood-en">{{ meta.en }}</span>
            </div>
            <div class="mood-tagline">{{ meta.tagline }}</div>
          </div>
        </div>

        <div class="conf-ring">
          <svg viewBox="0 0 100 100" width="94" height="94">
            <circle cx="50" cy="50" :r="R" fill="none" stroke="#eef0f6" stroke-width="8" />
            <circle
              cx="50"
              cy="50"
              :r="R"
              fill="none"
              :stroke="meta.color"
              stroke-width="8"
              stroke-linecap="round"
              :stroke-dasharray="CIRC"
              :stroke-dashoffset="dashOffset"
              transform="rotate(-90 50 50)"
              class="ring-progress"
            />
          </svg>
          <div class="conf-text">
            <span class="conf-num">{{ confPercent }}</span>
            <span class="conf-unit">%</span>
            <span class="conf-label">置信度</span>
          </div>
        </div>
      </div>

      <p class="mood-desc">{{ meta.desc }}</p>

      <!-- 质量警告 -->
      <div v-if="result.quality?.warnings?.length" class="warnings">
        <span v-for="w in result.quality.warnings" :key="w" class="warn-chip">⚠ {{ w }}</span>
      </div>

      <!-- 5 大情绪概率 -->
      <div class="section">
        <div class="section-head">
          <h4>情绪分布</h4>
          <span class="hint">5 维归一概率</span>
        </div>
        <div class="bars">
          <div v-for="b in moodBars" :key="b.key" class="bar-row" :class="{ top: b.isTop }">
            <span class="bar-label">{{ b.name }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{ width: Math.max(b.value * 100, 1.5) + '%', background: b.color }"
              ></div>
            </div>
            <span class="bar-value mono">{{ (b.value * 100).toFixed(1) }}</span>
          </div>
        </div>
      </div>

      <!-- 详情开关 -->
      <button class="detail-toggle" @click="showDetail = !showDetail">
        <span>{{ showDetail ? '收起' : '展开' }}算法细节</span>
        <span class="chev" :class="{ open: showDetail }">▾</span>
      </button>

      <transition name="fade">
        <div v-if="showDetail" class="detail-box">
          <!-- 7 类原始表情 -->
          <div class="section">
            <div class="section-head">
              <h4>7 类表情（CNN 输出 vs 融合后）</h4>
            </div>
            <div class="bars compact">
              <div v-for="e in exprBars" :key="e.key" class="bar-row">
                <span class="bar-label mono">{{ e.en }}</span>
                <div class="bar-track dual">
                  <div class="bar-fill raw" :style="{ width: Math.max(e.raw * 100, 1) + '%' }"></div>
                  <div class="bar-fill" :style="{ width: Math.max(e.fused * 100, 1) + '%' }"></div>
                </div>
                <span class="bar-value mono">{{ (e.fused * 100).toFixed(0) }}</span>
              </div>
            </div>
            <div class="legend">
              <span><i class="lg-raw"></i>CNN 原始</span>
              <span><i class="lg-fused"></i>几何修正+时序融合</span>
            </div>
          </div>

          <!-- 几何特征 -->
          <div class="section">
            <div class="section-head">
              <h4>几何特征（68 关键点）</h4>
            </div>
            <div class="geo-grid">
              <div v-for="g in geoItems" :key="g.k" class="geo-item">
                <span class="geo-k">{{ g.k }}</span>
                <span class="geo-v mono">{{ g.fmt(g.v) }}</span>
              </div>
            </div>
          </div>

          <!-- 质量诊断 -->
          <div class="section">
            <div class="section-head">
              <h4>质量诊断</h4>
              <span class="q-badge" :class="qualityLabel.cls">{{ qualityLabel.text }}</span>
            </div>
            <div class="geo-grid">
              <div class="geo-item">
                <span class="geo-k">人脸宽度</span>
                <span class="geo-v mono">{{ result.quality?.facePx }} px</span>
              </div>
              <div class="geo-item">
                <span class="geo-k">检测置信</span>
                <span class="geo-v mono">{{ ((result.quality?.detScore || 0) * 100).toFixed(0) }}%</span>
              </div>
              <div class="geo-item">
                <span class="geo-k">姿态评分</span>
                <span class="geo-v mono">{{ ((result.quality?.poseScore || 0) * 100).toFixed(0) }}%</span>
              </div>
              <div class="geo-item">
                <span class="geo-k">光照评分</span>
                <span class="geo-v mono">{{ ((result.quality?.lightScore || 0) * 100).toFixed(0) }}%</span>
              </div>
              <div class="geo-item">
                <span class="geo-k">融合帧数</span>
                <span class="geo-v mono">{{ result.frameCount }}</span>
              </div>
              <div class="geo-item">
                <span class="geo-k">人脸数量</span>
                <span class="geo-v mono">{{ faceCount }}</span>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </template>
  </div>
</template>

<style scoped>
.emotion-panel {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

/* ---------- 占位 ---------- */
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 54px 20px;
  text-align: center;
}

.ph-icon {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--bg-soft);
  color: var(--text-3);
  display: grid;
  place-items: center;
  font-size: 20px;
  margin-bottom: 4px;
}

.ph-icon.err {
  background: #fee2e2;
  color: #dc2626;
  font-weight: 700;
}

.ph-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
}

.ph-sub {
  font-size: 12.5px;
  color: var(--text-3);
  max-width: 300px;
  line-height: 1.7;
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 8px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- 主导情绪 ---------- */
.mood-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 16px 18px;
  border-radius: var(--radius);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--mood-color) 10%, white),
    color-mix(in srgb, var(--mood-color) 3%, white)
  );
  border: 1px solid color-mix(in srgb, var(--mood-color) 22%, transparent);
}

.hero-left {
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
}

.mood-icon {
  width: 46px;
  height: 46px;
  border-radius: 13px;
  display: grid;
  place-items: center;
  font-size: 22px;
  background: var(--mood-color);
  color: #fff;
  flex-shrink: 0;
  box-shadow: 0 4px 12px color-mix(in srgb, var(--mood-color) 35%, transparent);
}

.mood-name {
  font-size: 21px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: 0.3px;
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.mood-en {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-3);
  letter-spacing: 1.2px;
  text-transform: uppercase;
}

.mood-tagline {
  font-size: 12.5px;
  color: var(--text-2);
  margin-top: 1px;
}

.conf-ring {
  position: relative;
  flex-shrink: 0;
  width: 94px;
  height: 94px;
}

.ring-progress {
  transition: stroke-dashoffset 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}

.conf-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.conf-num {
  font-size: 23px;
  font-weight: 700;
  font-family: var(--mono);
  color: var(--text);
}

.conf-unit {
  font-size: 10px;
  color: var(--text-3);
  margin-top: -14px;
  margin-left: 20px;
}

.conf-label {
  font-size: 9.5px;
  color: var(--text-3);
  margin-top: 4px;
  letter-spacing: 0.5px;
}

.mood-desc {
  font-size: 12.8px;
  line-height: 1.75;
  color: var(--text-2);
  padding: 0 2px;
}

.warnings {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.warn-chip {
  font-size: 11.5px;
  color: #b45309;
  background: #fef3c7;
  border: 1px solid #fde68a;
  padding: 3px 9px;
  border-radius: 7px;
}

/* ---------- 分节 ---------- */
.section {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.section-head h4 {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  letter-spacing: 0.3px;
}

.hint {
  font-size: 11px;
  color: var(--text-3);
}

/* ---------- 进度条 ---------- */
.bars {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.bar-row {
  display: grid;
  grid-template-columns: 42px 1fr 38px;
  align-items: center;
  gap: 9px;
}

.bar-row.top .bar-label {
  color: var(--text);
  font-weight: 600;
}

.bar-label {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}

.bar-track {
  height: 7px;
  background: var(--bg-soft);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}

.bar-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--brand);
  transition: width 0.45s cubic-bezier(0.4, 0, 0.2, 1);
  position: absolute;
  top: 0;
  left: 0;
}

.bar-fill.raw {
  background: #c7cbe0;
}

.bar-value {
  font-size: 11.5px;
  color: var(--text-3);
  text-align: right;
}

.bars.compact .bar-row {
  grid-template-columns: 74px 1fr 30px;
}

.bars.compact .bar-track {
  height: 6px;
}

.legend {
  display: flex;
  gap: 14px;
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.legend i {
  width: 9px;
  height: 6px;
  border-radius: 2px;
  display: inline-block;
}

.lg-raw {
  background: #c7cbe0;
}

.lg-fused {
  background: var(--brand);
}

/* ---------- 详情 ---------- */
.detail-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px;
  font-size: 12px;
  color: var(--text-3);
  border-top: 1px dashed var(--border);
  transition: color 0.15s;
}

.detail-toggle:hover {
  color: var(--brand);
}

.chev {
  transition: transform 0.2s;
  font-size: 10px;
}

.chev.open {
  transform: rotate(180deg);
}

.detail-box {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 2px;
}

.geo-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
}

.geo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
}

.geo-k {
  font-size: 11.5px;
  color: var(--text-2);
}

.geo-v {
  font-size: 11.5px;
  color: var(--text);
  font-weight: 600;
}

.q-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  font-weight: 600;
}

.q-badge.good {
  background: #d1fae5;
  color: #065f46;
}
.q-badge.ok {
  background: #dbeafe;
  color: #1e40af;
}
.q-badge.warn {
  background: #fef3c7;
  color: #92400e;
}
.q-badge.bad {
  background: #fee2e2;
  color: #991b1b;
}
</style>
