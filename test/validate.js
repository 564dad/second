'use strict';
// Node 离线验证：与浏览器共用 physics.js 的同一份物理实现
const phys = require('../physics.js');

const out = phys.validateAll((line) => console.log(line));

console.log('\n--- 工况详情 ---');
for (const [name, s] of Object.entries(out.scenarios)) {
  console.log(`[${name}] status=${s.status} t=${phys.fmt(s.t, 2)}s score=${s.score} ` +
    `pos=(${phys.fmt(s.x, 3)}, ${phys.fmt(s.y, 3)}) v=(${phys.fmt(s.vx, 3)}, ${phys.fmt(s.vy, 3)}) ` +
    `T=${phys.fmt(s.T, 1)}°C events=${s.events.map(e => e.type).join(',')}`);
  if (s.trip) console.log('  触发记录: ' + phys.tripLine(s));
}

process.exit(out.allPass ? 0 : 1);
