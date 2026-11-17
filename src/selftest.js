// selftest.js — 用真实物理引擎跑验收用例（不依赖渲染，可在浏览器调试面板触发）
import { createGame, update, setFlipper, resetGame, spawnTestBall, PHASE } from './game.js';
import { flipperGeometry } from './table.js';
import { len, sub, closestPointOnSegment } from './vec.js';
import { FIXED_DT } from './game.js';

/** 推进模拟 seconds 秒（逐固定步长，事件累积返回） */
function simulate(state, seconds, onStep) {
  const all = [];
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    const ev = update(state, FIXED_DT);
    all.push(...ev);
    if (onStep) onStep(i, ev);
  }
  return all;
}

function freshState() {
  const s = createGame();
  // 移除发射槽里的锁定球，测试用自己的球
  s.balls = [];
  s.phase = PHASE.PLAY;
  return s;
}

// ---------- 验收 1：3000 px/s 打挡板，5 次零穿透 ----------
function testTunnel() {
  const SHOT = 3000;
  let hits = 0;
  const detail = [];
  for (let run = 0; run < 5; run++) {
    const s = freshState();
    setFlipper(s, 'L', false);
    setFlipper(s, 'R', false);
    const f = s.flippers[0]; // 左挡板
    const g = flipperGeometry({ ...f, angVel: 0 });
    const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
    // 球在挡板正上方，垂直向下 3000 px/s
    const ball = spawnTestBall(s, mid.x, mid.y - 260, 0, SHOT);
    let collided = false;
    let tunneled = false;
    const evs = simulate(s, 0.35, (i) => {
      const gg = flipperGeometry(s.flippers[0]);
      const cp = closestPointOnSegment(ball.pos, gg.a, gg.b);
      const d = len(sub(ball.pos, cp.point));
      // 球心越过挡板所在高度且跑到挡板下方而没有碰撞记录 => 穿透
      if (!collided && ball.pos.y > gg.b.y + 40) {
        tunneled = true;
      }
    });
    if (evs.some((e) => e.type === 'flipperHit')) collided = true;
    if (collided && !tunneled) hits++;
    detail.push(`#${run + 1}: ${collided ? (tunneled ? '穿透!' : '挡下') : '未碰撞?'}`);
  }
  return {
    name: '穿模测试 3000px/s ×5',
    pass: hits === 5,
    text: `挡住 ${hits}/5 次（${detail.join('，')}）`,
  };
}

// ---------- 验收 2：静止 vs 挥动挡板，出射速度差 ≥30% ----------
function testFlipperPower() {
  const SHOT = 1600;
  function measure(pressed) {
    const s = freshState();
    const f = s.flippers[0];
    const g0 = flipperGeometry({ ...f, ang: f.ang, angVel: 0 });
    const mid = { x: (g0.a.x + g0.b.x) / 2, y: (g0.a.y + g0.b.y) / 2 };
    const ball = spawnTestBall(s, mid.x, mid.y - 220, 0, SHOT);
    // 球约 0.137s 后抵达；第 0.115s（第 14 个固定步）按下 -> 碰撞时挡板仍在挥动
    const pressStep = pressed ? 14 : -1;
    let outSpeed = 0;
    let hitOmega = 0;
    const steps = Math.round(0.3 / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      if (i === pressStep) setFlipper(s, 'L', true);
      const ev = update(s, FIXED_DT);
      if (outSpeed === 0 && ev.some((e) => e.type === 'flipperHit')) {
        outSpeed = len(ball.vel);
        hitOmega = Math.abs(f.angVel);
      }
    }
    return { outSpeed, hitOmega };
  }
  const resting = measure(false);
  const swinging = measure(true);
  const diff = (swinging.outSpeed - resting.outSpeed) / resting.outSpeed;
  return {
    name: '挡板发力对比',
    pass: diff >= 0.3 && swinging.hitOmega > 5,
    text: `静止反弹 ${Math.round(resting.outSpeed)}px/s vs 挥动 ${Math.round(swinging.outSpeed)}px/s` +
      `（差 ${(diff * 100).toFixed(1)}%，碰撞时 ω=${swinging.hitOmega.toFixed(1)}rad/s）`,
  };
}

// ---------- 验收 3：同一靶子连击三次，得分递增 ----------
function testCombo() {
  const s = freshState();
  const target = s.targets[7]; // t8（360,824），左侧无墙/无遮挡
  const gained = [];
  const combos = [];
  for (let hit = 0; hit < 3; hit++) {
    s.balls = [];
    spawnTestBall(s, target.pos.x - 120, target.pos.y, 700, 0);
    const evs = simulate(s, 0.4);
    const tev = evs.find((e) => e.type === 'target' && e.obj.id === target.id);
    if (!tev) {
      return { name: '靶子连击递增', pass: false, text: '第 ' + (hit + 1) + ' 次未命中靶子' };
    }
    gained.push(tev.gained);
    combos.push(tev.combo);
  }
  const increasing = gained[1] > gained[0] && gained[2] > gained[1];
  return {
    name: '靶子连击递增',
    pass: increasing && combos.join() === '1,2,3',
    text: `三次得分 ${gained.join(' / ')}，combo 档位 ${combos.join(' / ')}`,
  };
}

// ---------- 验收 4：卡缝自救，不永久抖动 ----------
function testStuck() {
  const s = freshState();
  // 发射槽底部真实凹角（plungerL_low 与 floorR 之间），球零速落入
  const ball = spawnTestBall(s, 674, 968, 0, 0);
  const start = { ...ball.pos };
  const evs = simulate(s, 4.0);
  const nudged = evs.some((e) => e.type === 'unstuck' || e.type === 'unstuckTeleport');
  const finalSpeed = len(ball.vel);
  const moved = len(sub(ball.pos, start));
  // 通过条件：触发了自救，且最终没有停在原点持续抖
  const pass = nudged && (moved > 30 || finalSpeed > 100);
  return {
    name: '卡死自救',
    pass,
    text: `自救事件 ${nudged ? '已触发' : '未触发'}，位移 ${moved.toFixed(0)}px，末速 ${finalSpeed.toFixed(0)}px/s`,
  };
}

const TESTS = {
  tunnel: testTunnel,
  flipper: testFlipperPower,
  combo: testCombo,
  stuck: testStuck,
};

export function runSelfTests(hostState, which, log) {
  const names = which || Object.keys(TESTS);
  const results = [];
  for (const n of names) {
    const fn = TESTS[n];
    if (!fn) continue;
    let r;
    try {
      r = fn();
    } catch (err) {
      r = { name: n, pass: false, text: '异常: ' + (err && err.message) };
      console.error(err);
    }
    results.push(r);
    const line = `${r.pass ? 'PASS' : 'FAIL'} · ${r.name} — ${r.text}`;
    if (log) log(line, r.pass);
    console.log((r.pass ? '%cPASS' : '%cFAIL') + ` ${r.name} — ${r.text}`,
      r.pass ? 'color:#50ffaa' : 'color:#ff7d8d');
  }
  return results;
}
