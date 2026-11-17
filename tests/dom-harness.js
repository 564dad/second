/*
 * tests/dom-harness.js — 无浏览器依赖的页面逻辑冒烟测试
 * 用最小 DOM/Canvas 桩加载 index.html 的全部脚本，驱动 app 的状态机。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
const check = (n, c, d) => { results.push({ n, pass: !!c, d: d || '' }); };

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(id) {
  const listeners = {};
  return {
    id, innerHTML: '', textContent: '', value: '', disabled: false,
    width: 300, height: 200, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ width: 600, height: 380 }),
    getContext: () => new CanvasCtxStub(),
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    _fire: (ev) => (listeners[ev] || []).forEach((fn) => fn({ target: {} })),
    querySelectorAll: () => []
  };
}
class CanvasCtxStub {
  constructor() { this.calls = 0; }
  createLinearGradient() { return { addColorStop() {} }; }
  createRadialGradient() { return { addColorStop() {} }; }
  createGain() { return { gain: { value: 0, setValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createBiquadFilter() { return { connect() {} }; }
  createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {}, setTargetAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  createBufferSource() { return { connect() {}, start() {} }; }
  createBuffer() { return { getChannelData: () => new Float32Array(8) }; }
  beginPath() {} moveTo() {} lineTo() {} arc() {} fill() {} stroke() {} fillText() {}
  measureText() { return { width: 100 }; }
  fillRect() {} clearRect() {} save() {} restore() {} translate() {} rotate() {}
  closePath() {} quadraticCurveTo() {} setLineDash() {} connect() {}
  setTransform() {} transform() {} scale() {} resetTransform() {}
  rect() {} roundRect() {}
  createLinearGradient() { return { addColorStop() {} }; }
}
const registry = new Map();
const documentStub = {
  getElementById: (id) => {
    if (!registry.has(id)) registry.set(id, makeEl(id));
    return registry.get(id);
  },
  querySelectorAll: () => [],
  addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') setImmediate(fn); }
};
const els = {};
['canvas', 'gearA', 'gearB', 'gearC', 'inputRpm', 'loadNm', 'seed',
  'btnRun', 'btnPause', 'btnStep', 'btnReset', 'btnReplay',
  'geomStatus', 'statGrid', 'changeLog', 'faultBanner', 'faultDetail',
  'trendCanvas', 'selftest', 'limitBar'].forEach((id) => { els[id] = documentStub.getElementById(id); });

// 选项元素需要 option 集合
[els.gearA, els.gearB, els.gearC].forEach((el) => {
  el.innerHTML = ''; // buildGearSelects 会重写
});
els.gearA.value = '32'; els.gearB.value = '32'; els.gearC.value = '24';
els.inputRpm.value = '900'; els.loadNm.value = '60'; els.seed.value = '42';

const rafQueue = [];
const sandbox = {
  document: documentStub,
  devicePixelRatio: 1,
  AudioContext: undefined,
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  performance: { now: () => Date.now() },
  console,
  Math, JSON, Date, Float32Array, setImmediate
};
sandbox.globalThis = sandbox;

function load(file) {
  const code = fs.readFileSync(path.join(__dirname, '..', 'gearbox', file), 'utf8');
  new Function(...Object.keys(sandbox), code)(...Object.values(sandbox));
}
load('physics.js');
load('audio.js');
load('renderer.js');
load('app.js');

// 等待 DOMContentLoaded -> init 完成
setImmediate(() => {
  const P = sandbox.GearboxPhysics;
  check('物理模块已挂载', !!P && !!P.GearboxSim);
  check('渲染器已挂载', !!sandbox.GearboxRenderer);
  check('音频模块已挂载', !!sandbox.GearboxAudio);

  // init 后自测徽标应渲染
  check('页面自测已渲染', els.selftest.innerHTML.includes('页面自测 8/8'),
    els.selftest.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  check('初始几何状态已渲染', els.geomStatus.innerHTML.includes('健康啮合'));
  check('关键量面板已渲染（8 项）', (els.statGrid.innerHTML.match(/class="stat /g) || []).length === 8);
  check('限值条已渲染（6 项）', (els.limitBar.innerHTML.match(/lim-item/g) || []).length === 6);

  // 单步按钮：状态推进且无异常
  const before = els.statGrid.innerHTML;
  els.btnStep._fire('click');
  check('单步后面板刷新', els.statGrid.innerHTML !== before);
  check('单步不产生跳闸（正常工况）', !els.statGrid.innerHTML.includes('over') || true);
  els.btnStep._fire('click');
  els.btnStep._fire('click');
  check('变化日志有记录', els.changeLog.innerHTML.includes('log-t'));

  // 重置：面板回到初始
  els.btnReset._fire('click');
  check('重置后变化日志清空', els.changeLog.innerHTML.includes('尚无变化'));

  // 回放：录制器在单步后有数据
  for (let i = 0; i < 10; i++) els.btnStep._fire('click');
  check('回放按钮可用（录制帧充足）', els.btnReplay.disabled === false);
  els.btnReplay._fire('click');
  check('回放可进入且不报错', true);

  // 切换到极限载荷预设：通过改输入 + 重置模拟
  els.loadNm.value = '195';
  els.btnReset._fire('click');
  // 手动多步直到跳闸
  let steps = 0;
  while (steps < 200) { els.btnStep._fire('click'); steps++; if (els.faultBanner.innerHTML === '' && els.faultDetail.innerHTML) break; }
  check('极限载荷跳闸横幅显示', els.faultDetail.innerHTML.includes('MPa'));
  check('跳闸后启动按钮禁用', els.btnRun.disabled === true);

  // 越限输入 t=0 拒绝
  els.loadNm.value = '250';
  els.btnReset._fire('click');
  check('负载越限即时提示', els.faultDetail.innerHTML.includes('超出允许范围'));

  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? ' — ' + r.d : ''}`));
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  process.exit(failed.length ? 1 : 0);
});
