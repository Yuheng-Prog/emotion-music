// 清理调试过程中产生的一次性脚本与中间结果，保留正式的验证脚本与证据
const fs = require('fs');
const path = require('path');

const dir = __dirname;

// 保留：最终交付的验证脚本 + 证据
const keep = new Set([
  'cdp-run.cjs', // 零依赖 CDP 驱动器
  'probe-e2e.js', // 端到端主流程
  'probe-vtimeline.js', // 视频模式自动识别
  'probe-photo.js', // 拍照模式
  'test-algorithms.mjs', // 算法单测
  'algo-test2.txt', // 算法单测最新输出
  'e2e3-summary.txt', // 端到端结果摘要
  'e2e4.png', // 端到端截图
  'vtimeline2.png', // 视频模式截图
  'photo3.png', // 拍照模式截图
  'README.md',
  'faces' // 样本图目录
]);

const removed = [];
const kept = [];
for (const name of fs.readdirSync(dir)) {
  if (name === 'cleanup.cjs' || name === 'cleanup.log') continue;
  if (keep.has(name)) {
    kept.push(name);
    continue;
  }
  const full = path.join(dir, name);
  try {
    fs.rmSync(full, { recursive: true, force: true });
    removed.push(name);
  } catch (e) {
    removed.push('FAILED:' + name);
  }
}
fs.writeFileSync(
  path.join(dir, 'cleanup.log'),
  'KEPT:\n' + kept.join('\n') + '\n\nREMOVED:\n' + removed.join('\n'),
  'utf8'
);
console.log('done');
