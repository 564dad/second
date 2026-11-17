/*
 * physics.js — 磁悬浮小球穿环仿真物理核心
 * 浏览器与 Node 共用同一份代码，保证交互仿真与离线验证结果一致。
 *
 * 确定性设计：
 *  - 固定步长 DT，半隐式欧拉，所有随机数来自带种子的 mulberry32；
 *  - 连续运行 = 对 step() 的重复调用，暂停后单步与连续运行状态完全一致；
 *  - reset 用固定种子重建状态，多次重置初始条件不漂移。
 */
'use strict';

const DT = 1 / 240; // 固定积分步长 (s)

const P = {
  m: 0.05,            // 小球质量 (kg)
  g: 9.81,            // 重力加速度
  kCoil: 0.072,       // 线圈升力系数  F = kCoil * I^2 * w(y)
  kLat: 0.018,        // 线圈横向回中系数
  coilS: 1.0,         // 线圈作用空间宽度 (m)
  coilY: [8.4, 6.4, 4.4, 2.4], // 四组线圈高度 (m)
  tauI: 0.7,          // 电流响应一阶滞后时间常数 (s) —— 系统延迟
  alphaT: 0.57,       // 线圈升温系数 dT/dt = alphaT*I^2 - betaT*(T-Tamb)
  betaT: 0.15,
  Tamb: 25,           // 环境温度 (°C)
  // ---- 安全上下限：超出即冻结并显示触发点 ----
  Tmax: 120,          // 线圈温度上限 (°C)
  vmax: 6.0,          // 速度上限 (m/s)
  Fmax: 3.0,          // 磁压(线圈合力)上限 (N)
  xWall: 2.6,         // 井道侧壁 (失稳判据)
  yMax: 9.8,          // 顶部失稳判据
  ballR: 0.12,
  rings: [            // 三个圆环：高度 / 中心x偏移 / 半隙宽
    { y: 7.4, x: 0.00, w: 0.60 },
    { y: 5.4, x: 0.30, w: 0.55 },
    { y: 3.4, x: -0.25, w: 0.55 },
  ],
  baseY: 0.5,         // 底座上表面
  baseHalf: 0.9,      // 底座半宽
  vLand: 1.0,         // 安全落座速度上限 (m/s)
  distTau: 0.6,       // 外部扰动(OU过程)时间常数
  startY: 9.2,
  tMax: 90,           // 超时判据 (s)
};

const SEED = 20261117;

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller，不缓存，保证调用序列确定
function gauss(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function freshState(overrides) {
  const s = {
    t: 0, x: 0, y: P.startY, vx: 0, vy: 0,
    I: 0,               // 实际电流（滞后于目标电流）
    T: P.Tamb,          // 线圈温度
    etaX: 0, etaY: 0,   // 扰动力 (OU 过程)
    Itarget: 2.4, damp: 0.30, disturb: 0.15, // 用户可调：目标电流 / 阻尼 / 扰动强度
    ringIdx: 0, passed: 0, score: 0, hits: 0,
    status: 'ready',    // ready|running|paused|tripped|success|fail|timeout
    trip: null,
    rng: makeRng(SEED),
    lastF: null,
    trace: [],          // 每步记录，用于回放（回放只读记录，不会跳变）
    events: [],         // 关键事件：穿环/碰撞/触发/落座
  };
  if (overrides) Object.assign(s, overrides);
  return s;
}

// 受力分解：重力 / 线圈 / 阻尼 / 扰动，返回各分量与合力
function computeForces(s) {
  const g = { x: 0, y: -P.m * P.g };
  const c = { x: 0, y: 0 };
  let coilMag = 0;
  for (const cy of P.coilY) {
    const dy = (s.y - cy) / P.coilS;
    const w = 1 / (1 + dy * dy);
    const f = P.kCoil * s.I * s.I * w;
    c.y += f;
    coilMag += f;
    c.x += -P.kLat * s.I * s.I * s.x * w; // 横向回中
  }
  const d = { x: -s.damp * s.vx, y: -s.damp * s.vy };
  const e = { x: s.etaX, y: s.etaY };
  return {
    g, c, d, e, coilMag,
    tx: g.x + c.x + d.x + e.x,
    ty: g.y + c.y + d.y + e.y,
  };
}

function recordTrip(s, reason) {
  const speed = Math.hypot(s.vx, s.vy);
  s.status = 'tripped';
  s.trip = {
    reason, t: s.t, x: s.x, y: s.y, vx: s.vx, vy: s.vy,
    speed, T: s.T, F: s.lastF ? s.lastF.coilMag : 0,
  };
  s.events.push(Object.assign({ type: 'trip', i: s.trace.length }, s.trip));
}

// 单步推进 —— 连续运行、暂停后单步都调用这同一个函数
function step(s, dt) {
  if (s.status !== 'running' && s.status !== 'ready') return;
  s.status = 'running';

  // 1) 电流一阶滞后（系统延迟）
  s.I += (s.Itarget - s.I) * (dt / P.tauI);
  // 2) 线圈热模型
  s.T += (P.alphaT * s.I * s.I - P.betaT * (s.T - P.Tamb)) * dt;
  // 3) 外部扰动：Ornstein-Uhlenbeck 过程（种子随机，确定可复现）
  const sq = Math.sqrt(dt);
  s.etaX += (-s.etaX / P.distTau) * dt + s.disturb * sq * gauss(s.rng);
  s.etaY += (-s.etaY / P.distTau) * dt + s.disturb * 0.4 * sq * gauss(s.rng);
  // 4) 受力与积分（半隐式欧拉）
  const F = computeForces(s);
  s.lastF = F;
  s.vx += (F.tx / P.m) * dt;
  s.vy += (F.ty / P.m) * dt;
  const px = s.x, py = s.y;
  s.x += s.vx * dt;
  s.y += s.vy * dt;

  // 载荷堵转约束（极限载荷工况：机构卡滞，位置被外部约束固定）
  if (s.holdY != null) {
    s.x = 0; s.y = s.holdY; s.vx = 0; s.vy = 0;
  }

  // 5) 穿环判定（按顺序穿越下一个环平面）
  if (s.ringIdx < P.rings.length) {
    const r = P.rings[s.ringIdx];
    if ((py - r.y) * (s.y - r.y) <= 0 && py !== s.y) {
      const f = (r.y - py) / (s.y - py);
      const xc = px + (s.x - px) * f;
      const clean = Math.abs(xc - r.x) <= r.w - P.ballR;
      if (clean) {
        s.score += 100;
      } else {
        s.score -= 30; s.hits++;
        s.vx = -s.vx * 0.3; s.vy *= 0.85; // 碰环边：损失动量并扣分
      }
      s.events.push({ type: clean ? 'pass' : 'hit', idx: s.ringIdx, t: s.t, x: xc, y: r.y, i: s.trace.length });
      s.ringIdx++; s.passed++;
    }
  }

  // 6) 落座判定
  const restY = P.baseY + P.ballR;
  if (s.y <= restY) {
    s.y = restY;
    const ok = Math.abs(s.vy) <= P.vLand && Math.abs(s.x) <= P.baseHalf && s.passed === P.rings.length;
    if (ok) s.score += 150;
    s.events.push({ type: ok ? 'success' : 'fail', t: s.t, x: s.x, y: s.y, vy: s.vy, i: s.trace.length });
    s.status = ok ? 'success' : 'fail';
    s.vx = 0; s.vy = 0;
  }

  // 7) 安全上下限：超出即冻结，记录触发点状态（位置/速度/温度/磁压）
  if (s.status === 'running') {
    const speed = Math.hypot(s.vx, s.vy);
    if (s.T > P.Tmax) recordTrip(s, '温度超限 T>' + P.Tmax + '°C');
    else if (speed > P.vmax) recordTrip(s, '速度超限 |v|>' + P.vmax + 'm/s');
    else if (F.coilMag > P.Fmax) recordTrip(s, '磁压超限 F>' + P.Fmax + 'N');
    else if (Math.abs(s.x) > P.xWall - P.ballR) recordTrip(s, '失稳：撞击侧壁');
    else if (s.y > P.yMax) recordTrip(s, '失稳：飞出顶部');
    else if (s.t > P.tMax) { s.status = 'timeout'; s.events.push({ type: 'timeout', t: s.t, i: s.trace.length }); }
  }

  s.t += dt;
  s.trace.push({ t: s.t, x: s.x, y: s.y, vx: s.vx, vy: s.vy, I: s.I, T: s.T, score: s.score });
}

// 以固定参数无渲染运行一个工况（验证用，与界面共用同一 step）
function runScenario(overrides, ctrl, maxT) {
  const s = freshState(overrides);
  s.status = 'running';
  const lim = maxT || P.tMax;
  let guard = Math.ceil(lim / DT) + 10;
  while ((s.status === 'running' || s.status === 'ready') && s.t < lim && guard-- > 0) {
    if (ctrl) ctrl(s);
    step(s, DT);
  }
  return s;
}

// 正常工况的脚本化控制（确定性 PD：跟踪期望下降速度）
function normalCtrl(s) {
  const vDes = s.y < 1.6 ? -0.30 : -0.55;
  s.Itarget = Math.min(6, Math.max(0, 2.45 - 1.3 * (s.vy - vDes)));
}

function diffState(a, b) {
  const keys = ['t', 'x', 'y', 'vx', 'vy', 'I', 'T', 'score'];
  let d = 0;
  for (const k of keys) d = Math.max(d, Math.abs(a[k] - b[k]));
  return d;
}

function fmt(v, n) { return Number(v).toFixed(n === undefined ? 4 : n); }

function tripLine(s) {
  if (!s.trip) return '未触发';
  const r = s.trip;
  return `${r.reason} @ t=${fmt(r.t, 2)}s 位置=(${fmt(r.x, 3)}, ${fmt(r.y, 3)})m ` +
    `速度=(${fmt(r.vx, 3)}, ${fmt(r.vy, 3)})m/s |v|=${fmt(r.speed, 3)} ` +
    `T=${fmt(r.T, 1)}°C 磁压F=${fmt(r.F, 3)}N`;
}

// 完整验证：正常 / 极限载荷 / 失稳 + 重复一致性 + 暂停单步一致 + 重置不漂移 + 回放无跳变
function validateAll(log) {
  const results = [];
  const ok = (name, cond, detail) => {
    results.push({ name, pass: !!cond });
    log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  // 1) 正常工况
  const n1 = runScenario({ Itarget: 2.45, damp: 0.30, disturb: 0.15 }, normalCtrl);
  ok('正常工况：三段穿环并安全落座',
    n1.status === 'success' && n1.passed === 3,
    `状态=${n1.status} 穿环=${n1.passed}/3 碰环=${n1.hits} 得分=${n1.score} 用时=${fmt(n1.t, 1)}s 落速=${fmt(Math.abs(n1.events.filter(e => e.type === 'success')[0] ? n1.events.filter(e => e.type === 'success')[0].vy : NaN), 3)}m/s`);

  // 2) 极限载荷：满载堵转（位置被卡滞约束）+ 满电流 → 线圈过热触发
  const ex = runScenario({ Itarget: 6.0, damp: 0.30, disturb: 0.15, holdY: 9.2 });
  ok('极限载荷：安全限触发并冻结', ex.status === 'tripped' && /温度|磁压/.test(ex.trip ? ex.trip.reason : ''), tripLine(ex));

  // 3) 失稳：低阻尼 + 强扰动 + 过电流
  const un = runScenario({ Itarget: 3.4, damp: 0.02, disturb: 1.8 });
  ok('失稳工况：触发失稳/速度保护', un.status === 'tripped', tripLine(un));

  // 4) 同参数重复运行一致性
  const n2 = runScenario({ Itarget: 2.45, damp: 0.30, disturb: 0.15 }, normalCtrl);
  ok('同参数重复运行结果一致', diffState(n1, n2) === 0,
    `两次运行末态最大偏差=${diffState(n1, n2)}`);

  // 5) 暂停/单步与连续运行一致：600 步连续 vs 300 步 + "暂停" + 300 次单步
  const a = runScenario({ Itarget: 2.45, damp: 0.30, disturb: 0.15 }, normalCtrl, 600 * DT);
  const b = (() => {
    const s = freshState({ Itarget: 2.45, damp: 0.30, disturb: 0.15 });
    s.status = 'running';
    for (let i = 0; i < 300; i++) { normalCtrl(s); step(s, DT); }
    s.status = 'paused';            // 暂停：不改变任何物理量
    for (let i = 0; i < 300; i++) { s.status = 'running'; normalCtrl(s); step(s, DT); }
    return s;
  })();
  ok('暂停/单步与连续运行物理状态相同', diffState(a, b) === 0,
    `连续 vs 暂停+单步 末态最大偏差=${diffState(a, b)}`);

  // 6) 多次重置初始条件不漂移
  const inits = [];
  for (let i = 0; i < 5; i++) {
    const s = freshState({ Itarget: 2.45, damp: 0.30, disturb: 0.15 });
    inits.push(JSON.stringify([s.x, s.y, s.vx, s.vy, s.I, s.T, s.etaX, s.etaY, s.score]));
  }
  ok('多次重置初始条件无漂移', inits.every(v => v === inits[0]),
    `5 次重置初始状态${inits.every(v => v === inits[0]) ? '完全相同' : '存在差异'}`);

  // 7) 回放无跳变：相邻记录位移不超过物理上界
  let maxJump = 0;
  for (let i = 1; i < n1.trace.length; i++) {
    const dx = n1.trace[i].x - n1.trace[i - 1].x;
    const dy = n1.trace[i].y - n1.trace[i - 1].y;
    maxJump = Math.max(maxJump, Math.hypot(dx, dy));
  }
  const bound = P.vmax * DT * 1.5;
  ok('回放关键状态无跳变', maxJump <= bound,
    `相邻记录最大位移=${fmt(maxJump, 5)}m (上界 ${fmt(bound, 5)}m)`);

  const passed = results.filter(r => r.pass).length;
  log(`—— 验证汇总：${passed}/${results.length} 项通过 ——`);
  return { results, allPass: passed === results.length, scenarios: { normal: n1, extreme: ex, unstable: un } };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DT, P, SEED, makeRng, gauss, freshState, computeForces, step, runScenario, normalCtrl, diffState, validateAll, tripLine, fmt };
}
