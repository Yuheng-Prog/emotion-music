<script setup>
/**
 * AlgoDoc.vue —— 算法说明面板
 *
 * 系统要求「明确情绪识别算法」与「明确歌曲推荐算法」，
 * 本组件把这些内容做成可查阅的文档，包含公式、参数与设计取舍。
 */
import { ref } from 'vue'

defineEmits(['close'])

const tab = ref('emotion')

const tabs = [
  { key: 'emotion', label: '情绪识别算法' },
  { key: 'recommend', label: '歌曲推荐算法' },
  { key: 'arch', label: '系统架构' }
]
</script>

<template>
  <div class="mask" @click.self="$emit('close')">
    <div class="doc">
      <header class="doc-head">
        <div>
          <h2>算法说明</h2>
          <p>本系统所有推理均在浏览器本地完成，不上传任何图像数据</p>
        </div>
        <button class="close" @click="$emit('close')">✕</button>
      </header>

      <nav class="doc-tabs">
        <button
          v-for="t in tabs"
          :key="t.key"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="doc-body">
        <!-- ============ 情绪识别 ============ -->
        <template v-if="tab === 'emotion'">
          <h3>一、整体流程</h3>
          <div class="flow">
            <div class="flow-step">
              <span class="fi">1</span>
              <div>
                <strong>人脸检测</strong>
                <p>TinyFaceDetector（轻量 MobileNet 变体，CNN 回归边界框 + 5 关键点）。输入张量 416×416，得分阈值 0.45。</p>
              </div>
            </div>
            <div class="flow-step">
              <span class="fi">2</span>
              <div>
                <strong>关键点定位</strong>
                <p>FaceLandmark68Net 回归 68 个关键点（iBUG 300-W 标准），用于人脸对齐与几何特征提取。</p>
              </div>
            </div>
            <div class="flow-step">
              <span class="fi">3</span>
              <div>
                <strong>表情分类</strong>
                <p>FaceExpressionNet 小型 CNN 输出 7 类 softmax：neutral / happy / sad / angry / fearful / disgusted / surprised。</p>
              </div>
            </div>
            <div class="flow-step">
              <span class="fi">4</span>
              <div>
                <strong>几何先验修正</strong>
                <p>用 68 关键点计算嘴型、眉眼距离、眼睛开合比（EAR），在 log 概率空间做伪似然加权的二次修正。</p>
              </div>
            </div>
            <div class="flow-step">
              <span class="fi">5</span>
              <div>
                <strong>时序证据融合</strong>
                <p>带遗忘因子的对数证据累加，等效于滑动窗口内的贝叶斯后验更新，抑制单帧抖动。</p>
              </div>
            </div>
            <div class="flow-step">
              <span class="fi">6</span>
              <div>
                <strong>质量门控</strong>
                <p>从人脸尺寸、检测置信、头部姿态、光照对比度四维评估，输出综合置信度。</p>
              </div>
            </div>
          </div>

          <h3>二、几何先验修正</h3>
          <p>纯 CNN 在小脸、侧脸、美颜、逆光时会系统性偏向 neutral 或 happy。68 关键点提供了可解释的 3D 几何先验：</p>
          <div class="formula">
            p'(c) ∝ p(c) · ∏<sub>k</sub> L<sub>k</sub>(c)<sup>w<sub>k</sub></sup>
          </div>
          <ul class="bullets">
            <li>
              <code>L<sub>k</sub>(c)</code>：第 k 个几何特征对类别 c 的支持度，取自面部动作编码系统（FACS）的 AU 组合经验值。
            </li>
            <li>
              <code>w<sub>k</sub></code>：该特征相对参考中位值的强度（0~1）。用指数而非二值开关，避免几何量轻微抖动导致结果跳变。
            </li>
            <li>典型规则：AU6+AU12（脸颊提升 + 嘴角上扬）→ 杜兴式真笑；AU1+AU4+AU15 → 悲伤；AU1+AU2+AU5 → 惊讶/恐惧。</li>
          </ul>

          <h3>三、时序证据融合</h3>
          <div class="formula">
            E<sub>t</sub>(c) = λ · E<sub>t-1</sub>(c) + ln( p<sub>t</sub>(c)<sup>γ</sup> + ε )
          </div>
          <div class="formula">
            p̄(c) = softmax( E<sub>t</sub>(c) )
          </div>
          <ul class="bullets">
            <li><code>λ = 0.82</code>：遗忘因子。越小越灵敏但越抖，越大越平稳但越迟钝。0.82 对应约 5~6 帧的有效记忆窗口。</li>
            <li><code>γ = quality.overall</code>：质量加权，低质量帧（人脸小/逆光/歪头）对证据的贡献自动减弱。</li>
            <li>超过 3 秒无检测视为一次新的会话，清空累积，避免旧情绪污染。</li>
          </ul>

          <h3>四、7 类表情 → 5 大情绪</h3>
          <p>用软映射而非硬 argmax，保留概率信息：</p>
          <div class="mapping-table">
            <div class="mt-row mt-head"><span>输出情绪</span><span>来源</span></div>
            <div class="mt-row"><span>开心 happy</span><span>happy</span></div>
            <div class="mt-row"><span>平静 calm</span><span>neutral + 0.15 × sad</span></div>
            <div class="mt-row"><span>悲伤 sad</span><span>sad + 0.35 × disgusted</span></div>
            <div class="mt-row"><span>愤怒 angry</span><span>angry + 0.30 × disgusted</span></div>
            <div class="mt-row"><span>焦虑 fearful</span><span>fearful + 0.45 × surprised</span></div>
          </div>
          <p class="note">归并后重新归一化，使 5 维概率和为 1。厌恶常与低落共现、惊讶在负效价语境下常是恐惧，这是归并的依据。</p>

          <h3>五、情绪 → VA 坐标</h3>
          <p>为与音乐比较，把 5 维情绪概率投影到 Russell 环形情绪模型的 Valence-Arousal 二维空间：</p>
          <div class="formula">v = Σ<sub>m</sub> p(m)·v<sub>m</sub> , &nbsp; a = Σ<sub>m</sub> p(m)·a<sub>m</sub></div>
          <p class="note">各情绪的 VA 锚点取自 AffectNet 的标注统计均值，例如 happy → (0.81, 0.62)，sad → (−0.65, 0.28)。</p>

          <h3>六、多人脸聚合</h3>
          <div class="formula">
            P(m) = Σ<sub>i</sub> w<sub>i</sub>·p<sub>i</sub>(m) / Σ<sub>i</sub> w<sub>i</sub> , &nbsp;
            w<sub>i</sub> = conf<sub>i</sub> × area<sub>i</sub><sup>0.35</sup>
          </div>
          <ul class="bullets">
            <li>面积项用 0.35 次幂压缩：让特写的人权重更高，但不至于完全压制合影中的其他人。</li>
            <li>同时计算「一致度 agreement」= 整体分布与最可信那张脸分布的重合比例。分歧大时降低置信度，而不是假装确定。</li>
          </ul>
        </template>

        <!-- ============ 推荐算法 ============ -->
        <template v-else-if="tab === 'recommend'">
          <h3>一、核心思路</h3>
          <p>
            把「情绪」和「歌曲」放在同一个二维 VA 空间里比距离。情绪侧由识别结果投影得到，
            歌曲侧来自本地曲库的情绪标注（或在线召回时的情绪锚点）。
          </p>
          <div class="formula">
            Score(s) = 0.46·VA_Sim + 0.24·MoodMatch + 0.14·EnergySim + 0.16·Quality − δ·Diversity
          </div>

          <h3>二、四个打分分量</h3>
          <div class="weight-list">
            <div class="w-item">
              <div class="w-head"><span class="w-name">VA 相似度</span><span class="w-val">46%</span></div>
              <div class="w-bar"><i style="width: 46%; background: #5b5bd6"></i></div>
              <p>用椭球距离而非欧氏距离：唤醒度 A 轴压缩系数 0.72，因为人对节奏快慢的感知比对音色明暗更敏感。</p>
            </div>
            <div class="w-item">
              <div class="w-head"><span class="w-name">情绪标签命中</span><span class="w-val">24%</span></div>
              <div class="w-bar"><i style="width: 24%; background: #8b5cf6"></i></div>
              <p>按 5 维情绪概率对歌曲的情绪标签做加权求和，而不是查表命中即 1 分。主导情绪命中额外加成。</p>
            </div>
            <div class="w-item">
              <div class="w-head"><span class="w-name">能量匹配</span><span class="w-val">14%</span></div>
              <div class="w-bar"><i style="width: 14%; background: #f59e0b"></i></div>
              <p>歌曲能量与目标唤醒度的接近程度，反映「想听多躁的歌」。</p>
            </div>
            <div class="w-item">
              <div class="w-head"><span class="w-name">曲目质量先验</span><span class="w-val">16%</span></div>
              <div class="w-bar"><i style="width: 16%; background: #10b981"></i></div>
              <p>人工标注的质量分，防止冷门低质曲目因情绪恰好匹配而排到第一。</p>
            </div>
          </div>

          <h3>三、三种推荐策略</h3>
          <p>
            单纯「你难过就推悲伤的歌」可能加重负面情绪；单纯「你难过就推儿歌」又会让人觉得不被理解。
            音乐心理学给出两条路径，本系统把选择权交给用户：
          </p>
          <div class="strategy-cards">
            <div class="sc">
              <div class="sc-title">♡ 同频镜像</div>
              <p>目标点 = 当前情绪点。基于 Iso-principle（同频原则）：像镜子一样先与听者情绪同步，音乐才容易被接受。</p>
            </div>
            <div class="sc">
              <div class="sc-title">↗ 情绪修复</div>
              <p>目标点向「偏好情绪」移动一半距离。α=0.55，β=0.5，只走一半是为了避免情绪跳变带来的割裂感。</p>
            </div>
            <div class="sc">
              <div class="sc-title">⇄ 情绪反转</div>
              <p>目标点取 VA 空间的对径位置，用反差感打断负面循环。适合需要「强制切换注意力」的场景。</p>
            </div>
          </div>
          <div class="formula">
            v<sub>target</sub> = v + (v<sub>pref</sub> − v)·α , &nbsp;
            a<sub>target</sub> = a + (a<sub>base</sub> − a)·β
          </div>
          <p class="note">
            愤怒/焦虑时 a<sub>base</sub> = 0.32~0.35（先降唤醒，再谈心情），悲伤时 0.45，开心时 0.62（保持）。
            所以愤怒的人会先听到「稍平静一点的歌」，而不是被直接塞一首儿歌。
          </p>

          <h3>四、多样性重排（简化 MMR）</h3>
          <div class="formula">
            Score<sub>final</sub>(s) = Score(s) − δ · max<sub>s' ∈ Selected</sub> sim(s, s')
          </div>
          <ul class="bullets">
            <li>相似度由 VA 距离（0.6）、同歌手（0.25）、情绪标签杰卡德重合（0.15）加权得到。</li>
            <li><code>δ</code> 随已选数量线性增长，越往后越强调多样性，避免整份歌单同质化。</li>
          </ul>

          <h3>五、在线歌曲的情绪定位（冷启动）</h3>
          <p>
            外部曲库不返回 valence/arousal，无法直接进入 VA 空间比较。本系统用「把情绪作为检索条件注入外部曲库」来解决：
          </p>
          <div class="online-flow">
            <span>情绪识别结果</span> → <span>情绪关键词</span> → <span>在线搜索召回</span> → <span>情绪锚点定位</span> → <span>统一排序</span>
          </div>
          <p class="note">
            例如 sad → 搜索「伤感/抒情慢歌」，召回结果统一锚定到 sad 的典型曲目位置 (−0.52, 0.28)，
            并给较低的质量先验（0.62），使本地精品曲目在同等匹配度下优先。
          </p>

          <h3>六、情绪稳定性门控</h3>
          <p>
            主导情绪需连续 1.2 秒不变且置信度 ≥ 0.42 才触发重新推荐，避免用户在镜头前轻微变动就让整份歌单刷新。
          </p>
        </template>

        <!-- ============ 架构 ============ -->
        <template v-else>
          <h3>一、技术栈</h3>
          <div class="stack-grid">
            <div class="stack-item"><span class="sk">前端框架</span><span class="sv">Vue 3 (Composition API + SFC)</span></div>
            <div class="stack-item"><span class="sk">构建工具</span><span class="sv">Vite 5</span></div>
            <div class="stack-item"><span class="sk">样式</span><span class="sv">原生 CSS3（CSS 变量 / Grid / transition-group）</span></div>
            <div class="stack-item"><span class="sk">情绪推理</span><span class="sv">@vladmandic/face-api (TensorFlow.js)</span></div>
            <div class="stack-item"><span class="sk">本地服务</span><span class="sv">Node.js 零依赖 http 模块</span></div>
            <div class="stack-item"><span class="sk">在线曲库</span><span class="sv">Meting 兼容接口（网易云搜索）</span></div>
          </div>

          <h3>二、数据流</h3>
          <div class="arch-flow">
            <div class="af-box"><b>输入源</b><span>图片 / 视频 / 摄像头 / 拍照</span></div>
            <div class="af-arrow">→</div>
            <div class="af-box"><b>EmotionDetector</b><span>检测→关键点→表情→融合</span></div>
            <div class="af-arrow">→</div>
            <div class="af-box"><b>faceAggregator</b><span>多人脸置信度加权聚合</span></div>
            <div class="af-arrow">→</div>
            <div class="af-box"><b>Recommender</b><span>VA 相似度 + 策略 + MMR</span></div>
            <div class="af-arrow">→</div>
            <div class="af-box"><b>Player</b><span>本地音频 / 在线中转</span></div>
          </div>

          <h3>三、为什么要本地服务</h3>
          <ul class="bullets">
            <li><b>音频 Range 请求</b>：拖动进度条需要 HTTP 206 部分内容响应，静态文件托管必须实现 Range。</li>
            <li><b>绕过 CORS</b>：浏览器直接请求第三方音乐接口会被跨域拦截，由本地服务中转。</li>
            <li><b>绕过防盗链</b>：部分音频 CDN 校验 Referer / UA，服务端转发可正常获取。</li>
            <li><b>统一降级</b>：多个在线源串行尝试，任一失败自动切换，全部失败时退化为纯本地曲库。</li>
          </ul>

          <h3>四、目录结构</h3>
          <pre class="tree">emotion-music/
├─ src/
│  ├─ algorithms/
│  │  ├─ emotionDetector.js   情绪识别核心（含几何先验/时序融合）
│  │  ├─ faceAggregator.js    多人脸聚合
│  │  └─ recommender.js       推荐引擎（VA 相似度/策略/MMR）
│  ├─ components/
│  │  ├─ InputSource.vue      四种输入源
│  │  ├─ EmotionPanel.vue     情绪可视化
│  │  ├─ SongList.vue         推荐列表
│  │  ├─ Player.vue           音频播放器
│  │  └─ AlgoDoc.vue          本文档
│  ├─ data/songs.js           本地曲库元数据与情绪标注
│  └─ App.vue                 主界面与检测循环
├─ server/index.js            本地服务（静态+音频流+API代理）
├─ scripts/download-assets.js 模型与歌曲下载
└─ public/
   ├─ models/                 face-api 权重（本地推理）
   └─ songs/                  本地音频</pre>

          <h3>五、性能与隐私</h3>
          <ul class="bullets">
            <li>摄像头/视频检测节流至约 4.5 fps（220ms 间隔），避免占满主线程导致画面卡顿。</li>
            <li>模型权重共约 900KB，首次加载后由浏览器缓存，后续秒开。</li>
            <li>所有图像处理都在浏览器本地内存中完成，<b>不发起任何图像上传请求</b>。</li>
          </ul>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(23, 32, 60, 0.34);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
  z-index: 100;
  padding: 24px;
  animation: fadein 0.18s ease;
}

@keyframes fadein {
  from {
    opacity: 0;
  }
}

.doc {
  width: min(860px, 100%);
  max-height: 88vh;
  background: var(--surface);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(23, 32, 60, 0.24);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: pop 0.22s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes pop {
  from {
    transform: scale(0.97) translateY(8px);
    opacity: 0;
  }
}

.doc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 20px 24px 14px;
}

.doc-head h2 {
  font-size: 17px;
  font-weight: 700;
}

.doc-head p {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 3px;
}

.close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 14px;
  transition: all 0.15s;
}

.close:hover {
  background: var(--bg-soft);
  color: var(--text);
}

.doc-tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}

.doc-tabs button {
  padding: 9px 14px;
  font-size: 13px;
  color: var(--text-2);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: all 0.15s;
}

.doc-tabs button:hover {
  color: var(--text);
}

.doc-tabs button.active {
  color: var(--brand);
  border-bottom-color: var(--brand);
  font-weight: 600;
}

.doc-body {
  padding: 20px 26px 28px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-2);
}

.doc-body h3 {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
  margin: 22px 0 9px;
  padding-left: 9px;
  border-left: 3px solid var(--brand);
}

.doc-body h3:first-child {
  margin-top: 0;
}

/* ---------- 流程 ---------- */
.flow {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.flow-step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 9px 12px;
}

.fi {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 11px;
  font-weight: 700;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  margin-top: 2px;
}

.flow-step strong {
  font-size: 12.5px;
  color: var(--text);
  display: block;
}

.flow-step p {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  margin-top: 2px;
}

/* ---------- 公式 ---------- */
.formula {
  background: #f7f8fc;
  border: 1px solid var(--border);
  border-left: 3px solid var(--brand);
  border-radius: 8px;
  padding: 11px 14px;
  font-family: var(--mono);
  font-size: 12.5px;
  color: #2d3550;
  margin: 10px 0;
  overflow-x: auto;
  line-height: 1.9;
}

/* ---------- 列表 ---------- */
.bullets {
  margin: 8px 0;
  padding-left: 19px;
}

.bullets li {
  margin-bottom: 5px;
  font-size: 12.4px;
  line-height: 1.75;
}

code {
  font-family: var(--mono);
  font-size: 11.8px;
  background: var(--brand-soft);
  color: var(--brand-deep);
  padding: 1px 5px;
  border-radius: 4px;
}

.note {
  font-size: 12.2px;
  color: var(--text-3);
  background: var(--surface-2);
  border-radius: 8px;
  padding: 9px 12px;
  margin: 9px 0;
  line-height: 1.75;
  border: 1px solid var(--border);
}

/* ---------- 映射表 ---------- */
.mapping-table {
  border: 1px solid var(--border);
  border-radius: 9px;
  overflow: hidden;
  margin: 9px 0;
}

.mt-row {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  padding: 6px 12px;
  font-size: 12.2px;
  border-bottom: 1px solid var(--border);
}

.mt-row:last-child {
  border-bottom: none;
}

.mt-head {
  background: var(--surface-2);
  font-weight: 600;
  color: var(--text);
  font-size: 11.5px;
}

.mt-row span:last-child {
  font-family: var(--mono);
  font-size: 11.8px;
  color: var(--text-2);
}

/* ---------- 权重 ---------- */
.weight-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  margin: 10px 0;
}

.w-item {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 9px 12px;
}

.w-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.w-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.w-val {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 700;
  color: var(--brand);
}

.w-bar {
  height: 4px;
  background: #e8ebf4;
  border-radius: 2px;
  margin: 6px 0 5px;
  overflow: hidden;
}

.w-bar i {
  display: block;
  height: 100%;
  border-radius: 2px;
}

.w-item p {
  font-size: 11.8px;
  line-height: 1.65;
  color: var(--text-2);
}

/* ---------- 策略卡 ---------- */
.strategy-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 10px 0;
}

.sc {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 10px 11px;
}

.sc-title {
  font-size: 12.2px;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 4px;
}

.sc p {
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-2);
}

/* ---------- 在线流程 ---------- */
.online-flow {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.online-flow span {
  font-size: 11.5px;
  background: var(--brand-soft);
  color: var(--brand-deep);
  padding: 4px 10px;
  border-radius: 6px;
  font-weight: 500;
}

.online-flow span:nth-child(even) {
  background: transparent;
  color: var(--text-3);
  padding: 0;
  font-weight: 400;
}

/* ---------- 技术栈 ---------- */
.stack-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin: 9px 0;
}

.stack-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 11px;
}

.sk {
  font-size: 10.5px;
  color: var(--text-3);
}

.sv {
  font-size: 12px;
  color: var(--text);
  font-weight: 500;
}

/* ---------- 架构流 ---------- */
.arch-flow {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 12px 0;
  flex-wrap: wrap;
}

.af-box {
  flex: 1;
  min-width: 96px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 8px 10px;
  text-align: center;
}

.af-box b {
  display: block;
  font-size: 11.8px;
  color: var(--text);
  font-family: var(--mono);
}

.af-box span {
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.4;
  display: block;
  margin-top: 2px;
}

.af-arrow {
  color: var(--text-3);
  font-size: 13px;
  flex-shrink: 0;
}

/* ---------- 目录树 ---------- */
.tree {
  background: #f7f8fc;
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 11.5px;
  line-height: 1.7;
  color: #37405c;
  overflow-x: auto;
  margin: 10px 0;
}
</style>
