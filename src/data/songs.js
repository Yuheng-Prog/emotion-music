/**
 * ============================================================================
 *  本地歌曲库 (Local Song Library)
 * ============================================================================
 *
 *  音频来源：SoundHelix (https://www.soundhelix.com) —— 算法生成的免费示例音乐，
 *  作者 Thomas Schürger，可自由用于示例、研究、教学与演示。
 *
 *  【重要说明：元数据是人工标注的】
 *
 *  本系统需要用 (valence, arousal, energy) 三元组来对歌曲做情绪定位。
 *  这里的三元组是基于音乐学特征的人工标注：
 *
 *    valence 效价 -1~1   : 调性(大调偏正/小调偏负)、和声走向、旋律上行/下行
 *    arousal 唤醒 0~1    : 速度(BPM)、节奏密度、音色亮度
 *    energy  能量 0~1    : 动态范围、配器厚度、失真程度
 *
 *  标注方法：先按 BPM 定 arousal 基准 (60BPM→0.2, 140BPM→0.8)，
 *  再按调性与音色微调；energy 与 arousal 高度相关但会在"安静但快速"
 *  (如钢琴小品) 与"慢但厚重"(如重型摇滚) 之间分离。
 *
 *  实际生产系统中应使用 MIR (Music Information Retrieval) 库如
 *  Essentia / librosa 从音频特征自动回归这三项，或用受控众包听感打分。
 *  本文件的数值即为该流程的"人工标注结果"。
 */

const SONG_BASE = './songs/'

/**
 * 每首歌的元数据
 * moods: 该曲目适合的情绪及其权重 0~1
 */
export const LOCAL_SONGS = [
  {
    id: 'local-01',
    title: 'Bright Morning Run',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 01',
    file: 'soundhelix-song-01.mp3',
    valence: 0.72,
    arousal: 0.74,
    energy: 0.78,
    bpm: 128,
    moods: { happy: 0.95, calm: 0.15 },
    rating: 0.86,
    cover: 'sunrise'
  },
  {
    id: 'local-02',
    title: 'Cloudy Corridor',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 02',
    file: 'soundhelix-song-02.mp3',
    valence: -0.18,
    arousal: 0.34,
    energy: 0.36,
    bpm: 84,
    moods: { calm: 0.72, sad: 0.42 },
    rating: 0.78,
    cover: 'mist'
  },
  {
    id: 'local-03',
    title: 'Glass Piano Room',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 03',
    file: 'soundhelix-song-03.mp3',
    valence: 0.12,
    arousal: 0.22,
    energy: 0.2,
    bpm: 68,
    moods: { calm: 0.92, sad: 0.3 },
    rating: 0.88,
    cover: 'glass'
  },
  {
    id: 'local-04',
    title: 'Grey Afternoon',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 04',
    file: 'soundhelix-song-04.mp3',
    valence: -0.58,
    arousal: 0.26,
    energy: 0.28,
    bpm: 72,
    moods: { sad: 0.94, calm: 0.35 },
    rating: 0.82,
    cover: 'rain'
  },
  {
    id: 'local-05',
    title: 'Static Fuse',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 05',
    file: 'soundhelix-song-05.mp3',
    valence: -0.52,
    arousal: 0.86,
    energy: 0.92,
    bpm: 148,
    moods: { angry: 0.93, fearful: 0.4 },
    rating: 0.8,
    cover: 'spark'
  },
  {
    id: 'local-06',
    title: 'Tightrope Walk',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 06',
    file: 'soundhelix-song-06.mp3',
    valence: -0.34,
    arousal: 0.68,
    energy: 0.64,
    bpm: 112,
    moods: { fearful: 0.86, angry: 0.32 },
    rating: 0.79,
    cover: 'rope'
  },
  {
    id: 'local-07',
    title: 'Neon Crossing',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 07',
    file: 'soundhelix-song-07.mp3',
    valence: 0.42,
    arousal: 0.7,
    energy: 0.72,
    bpm: 122,
    moods: { happy: 0.72, calm: 0.3 },
    rating: 0.84,
    cover: 'neon'
  },
  {
    id: 'local-08',
    title: 'Slow Tide',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 08',
    file: 'soundhelix-song-08.mp3',
    valence: 0.28,
    arousal: 0.18,
    energy: 0.16,
    bpm: 62,
    moods: { calm: 0.96, sad: 0.22 },
    rating: 0.9,
    cover: 'tide'
  },
  {
    id: 'local-09',
    title: 'Paper Kite',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 09',
    file: 'soundhelix-song-09.mp3',
    valence: 0.78,
    arousal: 0.52,
    energy: 0.5,
    bpm: 104,
    moods: { happy: 0.88, calm: 0.4 },
    rating: 0.85,
    cover: 'kite'
  },
  {
    id: 'local-10',
    title: 'Deep Current',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 10',
    file: 'soundhelix-song-10.mp3',
    valence: -0.22,
    arousal: 0.58,
    energy: 0.6,
    bpm: 108,
    moods: { sad: 0.52, fearful: 0.5, calm: 0.3 },
    rating: 0.81,
    cover: 'current'
  },
  {
    id: 'local-11',
    title: 'Iron Pulse',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 11',
    file: 'soundhelix-song-11.mp3',
    valence: -0.66,
    arousal: 0.92,
    energy: 0.96,
    bpm: 158,
    moods: { angry: 0.98, fearful: 0.3 },
    rating: 0.77,
    cover: 'iron'
  },
  {
    id: 'local-12',
    title: 'Lighthouse Warm',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 12',
    file: 'soundhelix-song-12.mp3',
    valence: 0.62,
    arousal: 0.36,
    energy: 0.34,
    bpm: 88,
    moods: { happy: 0.7, calm: 0.72 },
    rating: 0.89,
    cover: 'lighthouse'
  },
  {
    id: 'local-13',
    title: 'Fractured Signal',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 13',
    file: 'soundhelix-song-13.mp3',
    valence: -0.72,
    arousal: 0.62,
    energy: 0.7,
    bpm: 116,
    moods: { angry: 0.6, fearful: 0.78 },
    rating: 0.76,
    cover: 'signal'
  },
  {
    id: 'local-14',
    title: 'Long Way Home',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 14',
    file: 'soundhelix-song-14.mp3',
    valence: 0.35,
    arousal: 0.44,
    energy: 0.42,
    bpm: 96,
    moods: { calm: 0.66, happy: 0.55 },
    rating: 0.87,
    cover: 'home'
  },
  {
    id: 'local-15',
    title: 'Quiet Rain Window',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 15',
    file: 'soundhelix-song-15.mp3',
    valence: -0.46,
    arousal: 0.16,
    energy: 0.14,
    bpm: 58,
    moods: { sad: 0.8, calm: 0.6 },
    rating: 0.91,
    cover: 'window'
  },
  {
    id: 'local-16',
    title: 'Sunlit Steps',
    artist: 'SoundHelix',
    album: 'SoundHelix Song 16',
    file: 'soundhelix-song-16.mp3',
    valence: 0.85,
    arousal: 0.66,
    energy: 0.68,
    bpm: 118,
    moods: { happy: 0.97, calm: 0.2 },
    rating: 0.9,
    cover: 'steps'
  }
].map((s) => ({
  ...s,
  source: 'local',
  url: SONG_BASE + s.file
}))

/**
 * 在线歌曲的「情绪预估」
 *
 * 在线曲库（网易云搜索接口）不返回 valence/arousal，无法直接定位到 VA 空间。
 * 本系统用两个信号做在线歌曲的情绪定位：
 *
 *   1) 曲名/歌手的情绪关键词词典匹配 → 得到初始 VA 猜测
 *   2) 推荐请求时按「目标情绪」构造搜索关键词
 *      （如 sad → 搜索 "伤感 慢歌"），再用关键词先验定位
 *
 * 这是"冷启动"问题的工程解法：把情绪作为检索条件注入外部曲库，
 * 让外部 API 充当"语义召回"，本地负责"情绪排序"。
 */
export const MOOD_SEARCH_KEYWORDS = {
  happy: ['快乐', '欢快', '阳光 快乐', '治愈 开心', 'uplifting'],
  calm: ['轻音乐', '钢琴 安静', 'lo-fi', '氛围 音乐', 'chill'],
  sad: ['伤感', '抒情 慢歌', '治愈 伤感', '悲伤 钢琴', 'sad song'],
  angry: ['摇滚 宣泄', '说唱 力量', '摇滚 燃', '重低音', 'rock energy'],
  fearful: ['冥想 放松', '白噪音 助眠', '舒缓 减压', 'ambient calm', 'anxiety relief']
}

/**
 * 在线歌曲的情绪先验锚点：
 * 按搜索关键词所属情绪，给召回结果一个 VA 位置。
 * 数值取该情绪在 VA 空间中的"典型歌曲位置"（略低于情绪中心点，
 * 因为音乐的情绪表达通常比人的表情更克制）。
 */
export const ONLINE_MOOD_ANCHOR = {
  happy: { v: 0.62, a: 0.66 },
  calm: { v: 0.18, a: 0.26 },
  sad: { v: -0.52, a: 0.28 },
  angry: { v: -0.45, a: 0.82 },
  fearful: { v: -0.3, a: 0.3 }
}
