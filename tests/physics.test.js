// 物理验收测试（无头，node --test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, rackPositions } from '../src/game.js';
import { makeBall, cueStrike } from '../src/balls.js';
import { physicsStep, allStopped } from '../src/physics.js';
import { buildTable, checkPocketCapture } from '../src/table.js';
import {
  BALL_M, BALL_R, DT_FIXED, MAX_CUE_SPEED, PLAY_W, PLAY_H,
} from '../src/constants.js';

function run(balls, table, maxSeconds = 12) {
  let t = 0;
  const maxSteps = Math.round(maxSeconds / DT_FIXED);
  for (let i = 0; i < maxSteps; i++) {
    physicsStep(balls, table);
    t += DT_FIXED;
    if (allStopped(balls)) return { time: t, balls };
  }
  return { time: t, balls, timeout: true };
}

function momentum(balls) {
  let px = 0, py = 0;
  for (const b of balls) {
    if (b.active) { px += b.vx * BALL_M; py += b.vy * BALL_M; }
  }
  return Math.hypot(px, py);
}

// 验收 1：两球正碰，动量误差 ≤ 5%，且无凭空增能
test('正碰动量守恒，误差不超过 5%', () => {
  const table = buildTable();
  const cue = makeBall(0, 0.4, PLAY_H / 2);
  const obj = makeBall(1, 1.2, PLAY_H / 2);
  const balls = [cue, obj];
  cueStrike(cue, 1, 0, 0.8, 0, 0);
  const pBefore = momentum(balls);
  const eBefore = 0.5 * BALL_M * (cue.vx ** 2 + cue.vy ** 2);

  // 精确找到碰撞发生的那个子步，在碰撞后立刻采样（摩擦尚未吃掉动量）
  let prevD = Infinity;
  let collided = false;
  for (let i = 0; i < Math.round(0.3 / DT_FIXED); i++) {
    physicsStep(balls, table);
    const d = Math.hypot(cue.x - obj.x, cue.y - obj.y);
    if (d <= 2 * BALL_R + 1e-9 && prevD > 2 * BALL_R) {
      collided = true;
      break;
    }
    prevD = d;
  }
  assert.ok(collided, '两球应发生接触');
  assert.ok(Math.abs(obj.vx) > 0.1, '目标球应获得明显速度');
  const pAfter = momentum(balls);
  const err = Math.abs(pAfter - pBefore) / pBefore;
  assert.ok(err <= 0.05, `动量误差 ${(err * 100).toFixed(2)}% 超过 5%`);

  const eAfter = 0.5 * BALL_M * balls
    .filter(b => b.active)
    .reduce((s, b) => s + b.vx ** 2 + b.vy ** 2, 0);
  assert.ok(eAfter <= eBefore * 1.001, '碰撞后动能不得增加');
});

// 验收 2：满力 8 秒内停稳，且停稳后不再抖动
test('满力击出 8 秒内停稳，停稳判定不抖', () => {
  const table = buildTable();
  const cue = makeBall(0, PLAY_W * 0.25, PLAY_H * 0.3);
  const balls = [cue];
  cueStrike(cue, 1, 0, 1, 0, 0);
  assert.ok(Math.hypot(cue.vx, cue.vy) > MAX_CUE_SPEED * 0.99);

  const res = run(balls, table, 10);
  assert.ok(!res.timeout, '球在 10 秒模拟窗口内未停稳');
  assert.ok(res.time <= 8, `停稳用时 ${res.time.toFixed(2)}s 超过 8 秒`);

  // 停稳后继续跑 0.5 秒，速度必须保持 0（不抖）
  for (let i = 0; i < Math.round(0.5 / DT_FIXED); i++) physicsStep(balls, table);
  assert.equal(cue.state, 'rest');
  assert.equal(cue.vx, 0);
  assert.equal(cue.vy, 0);
  assert.equal(cue.wz, 0);
});

// 验收 3：左右塞第一次碰库后反射方向明显不同
test('左右塞碰库反射角差异明显', () => {
  function rebound(side) {
    const table = buildTable();
    // 垂直打向下库，留出足够碰库距离，水平位置远离袋口
    const cue = makeBall(0, 0.6, PLAY_H / 2);
    const balls = [cue];
    cueStrike(cue, 0, -1, 0.9, side, 0);
    let prevY = cue.y;
    let hit = false;
    let angle = 0;
    for (let i = 0; i < Math.round(1.5 / DT_FIXED); i++) {
      physicsStep(balls, table);
      // 检测与下库（y=0 线段）的反弹：位置从逼近变为远离
      if (!hit && cue.y - prevY > 0 && cue.y < BALL_R * 3) {
        hit = true;
        angle = Math.atan2(cue.vy, cue.vx);
        break;
      }
      prevY = cue.y;
    }
    assert.ok(hit, `side=${side} 应发生库边反弹`);
    return angle;
  }
  const aLeft = rebound(-0.9);
  const aRight = rebound(0.9);
  const diff = Math.abs(aLeft - aRight) * 180 / Math.PI;
  assert.ok(diff >= 5, `左右塞反射角差异仅 ${diff.toFixed(2)}°，应 ≥ 5°`);
});

// 验收 4：贴库滚动球不穿出库边
test('贴库球不会穿透库边（含慢放级检查）', () => {
  const table = buildTable();
  // 贴着下库平行滚动，起止都在直线库边段内，避开两端袋口漏斗
  const cue = makeBall(0, 0.5, BALL_R + 0.002);
  const balls = [cue];
  cueStrike(cue, 1, 0, 0.6, 0, 0);
  const maxSteps = Math.round(1.2 / DT_FIXED);
  // 只检查下库的直线段（非袋角）
  const straight = table.segments.filter(s => !s.jaw && Math.abs(s.ay) < 1e-9 && Math.abs(s.by) < 1e-9);
  for (let i = 0; i < maxSteps; i++) {
    physicsStep(balls, table);
    let minClear = Infinity;
    for (const s of straight) {
      const ex = s.bx - s.ax, ey = s.by - s.ay;
      const l2 = ex * ex + ey * ey;
      let t = ((cue.x - s.ax) * ex + (cue.y - s.ay) * ey) / l2;
      t = Math.max(0, Math.min(1, t));
      const cx = s.ax + t * ex, cy = s.ay + t * ey;
      minClear = Math.min(minClear, Math.hypot(cue.x - cx, cue.y - cy));
    }
    assert.ok(minClear >= BALL_R - 1e-5,
      `第 ${i} 步穿模：净距 ${minClear.toFixed(5)} < ${BALL_R.toFixed(5)}`);
    assert.ok(cue.y >= -BALL_R && cue.y <= PLAY_H + BALL_R, 'y 越界');
  }
});

// 验收 5：16 球满载单帧物理预算（60fps 帧时间 16.7ms）
test('16 球满载步进性能在帧预算内', () => {
  const game = createGame();
  const cue = game.balls.find(b => b.num === 0);
  cueStrike(cue, 1, 0, 1, 0.3, 0.1);
  // 取开球后最忙的一帧：连跑 5 个子步计时（一帧最多 5 步 @300Hz）
  // 预热
  for (let i = 0; i < 10; i++) physicsStep(game.balls, game.table);
  const t0 = process.hrtime.bigint();
  const rounds = 200;
  for (let i = 0; i < rounds; i++) physicsStep(game.balls, game.table);
  const us = Number(process.hrtime.bigint() - t0) / 1000 / rounds;
  // 单步预算：16.7ms / 5 步 ≈ 3.3ms，留足余量取 2ms
  assert.ok(us < 2000, `单物理步耗时 ${us.toFixed(1)}µs，超出预算`);
});

// 附加：袋口几何——擦袋角可进，远距离不吸
test('袋口捕获：擦袋角落入，台面内球不被误吸', () => {
  const table = buildTable();
  // 台面中部的球不应被任何袋口捕获
  const mid = makeBall(1, PLAY_W / 2, PLAY_H / 2);
  assert.equal(checkPocketCapture(table, mid), null);
  // 开球点附近也安全
  const safe = makeBall(1, PLAY_W * 0.25, PLAY_H / 2);
  assert.equal(checkPocketCapture(table, safe), null);
  // 滚到角袋袋心位置应被捕获
  const inPocket = makeBall(1, BALL_R * 0.8, BALL_R * 0.8);
  assert.ok(checkPocketCapture(table, inPocket) !== null);
});

// 附加：擦袋角的球不穿模、不被误吞（大角度打向角袋区域应被袋角弹回台面）
test('擦袋角：大角度来球被弹回且不穿透', () => {
  const table = buildTable();
  const cue = makeBall(0, 0.25, 0.25);
  const balls = [cue];
  // 几乎平行于下库、朝左下角袋方向，球应被袋角/库边挡下而不是穿出 (0,0)
  cueStrike(cue, -0.99, -0.14, 0.8, 0, 0);
  for (let i = 0; i < Math.round(3 / DT_FIXED); i++) {
    physicsStep(balls, table);
    assert.ok(cue.x >= -BALL_R && cue.y >= -BALL_R,
      `第 ${i} 步穿出角袋边界 (${cue.x.toFixed(3)},${cue.y.toFixed(3)})`);
    if (cue.state === 'rest' || cue.state === 'sink') break;
  }
  assert.ok(cue.state === 'rest' || cue.state === 'sink');
});

// 附加：满球摆台无初始重叠
test('摆球无重叠', () => {
  const positions = rackPositions();
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const d = Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
      assert.ok(d >= 2 * BALL_R, `球 ${positions[i].num} 与 ${positions[j].num} 重叠`);
    }
  }
});
