// physics.js — 手写 2D 弹珠物理：固定步长 + 自适应子步进 + 扫掠连续碰撞（CCD）
// 无任何第三方库。所有碰撞在子步内用 swept 求根，高速球不会穿过挡板/墙。
import {
  vec, add, sub, scale, norm, len, clamp,
  sweptCircleSegment, sweptCircleCircle, reflectVelocity,
  closestPointOnSegment, dot,
} from './vec.js';
import {
  TABLE, WALLS, RAILS, SLINGSHOTS, BUMPERS, TARGETS, DRAINS,
  flipperGeometry, flipperSurfaceVelocity,
} from './table.js';

const MAX_SUBSTEPS = 24;
const STEP_MOVE = TABLE.BALL_R * 0.6; // 每个子步最大位移 = 0.6r，几何上杜绝跨越

export function createBall(x, y) {
  return {
    id: ++ballSeq,
    pos: vec(x, y),
    vel: vec(0, 0),
    r: TABLE.BALL_R,
    spin: 0,                 // 滚动角度（渲染高光用）
    trail: [],               // 残影位置
    cooldown: {},            // 各对象防黏冷却（秒）
    stuckT: 0,               // 低速/原地累计时间
    lastSafe: vec(x, y),
    safeT: 0,
    nudgeCd: 0,
    nudgeCount: 0,
    hist: [],
    histT: 0,
    alive: true,
  };
}
let ballSeq = 0;

/** 一步固定步长物理（dt 建议 1/120）。state 见 game.js。返回本步事件列表。 */
export function stepPhysics(state, dt) {
  const events = [];
  state.stats.lastSubsteps = 0; // 每个固定步重置，调试面板显示当步真实峰值

  // 1) 挡板先积分（角度驱动，记录真实角速度供碰撞耦合）
  for (const f of state.flippers) {
    const prev = f.ang;
    const target = f.pressed ? f.activeAng : f.restAng;
    const diff = target - f.ang;
    const maxMove = f.omega * dt;
    f.ang += clamp(diff, -maxMove, maxMove);
    f.angVel = (f.ang - prev) / dt; // rad/s，碰撞时球要吃这个速度
  }

  // 2) 每个球独立自适应子步进（碰撞后用剩余时间继续推进，直到消费完整个 dt）
  for (const ball of state.balls) {
    if (!ball.alive) continue;
    let remaining = dt;
    let subs = 0;
    const maxIter = MAX_SUBSTEPS * 2;
    while (remaining > 1e-7 && subs < maxIter) {
      const speed = len(ball.vel);
      const tipSpeed = maxFlipperTipSpeed(state);
      const move = Math.max(speed, tipSpeed) * remaining;
      // 每段位移不超过 0.6r：扫掠求根本身连续，这层再保证运动胶囊不跨越
      const n = clamp(Math.ceil(move / STEP_MOVE), 1, MAX_SUBSTEPS);
      const h = remaining / n;
      const consumed = substep(ball, h, state, events);
      remaining -= consumed;
      subs++;
    }
    state.stats.lastSubsteps = Math.max(state.stats.lastSubsteps || 0, subs);
    state.stats.maxSubsteps = Math.max(state.stats.maxSubsteps || 0, subs);
  }

  // 3) 球-球（多球同屏）：扫掠弹性碰撞
  for (let i = 0; i < state.balls.length; i++) {
    for (let j = i + 1; j < state.balls.length; j++) {
      collideBalls(state.balls[i], state.balls[j], dt, events);
    }
  }

  // 4) 排水判定
  for (const ball of state.balls) {
    if (!ball.alive) continue;
    for (const d of DRAINS) {
      if (ball.pos.x > d.x && ball.pos.x < d.x + d.w && ball.pos.y > d.y) {
        ball.alive = false;
        events.push({ type: 'drain', ball });
        break;
      }
    }
    // 出界保险
    if (ball.pos.y > TABLE.H + 80 || ball.pos.x < -120 || ball.pos.x > TABLE.W + 120) {
      ball.alive = false;
      events.push({ type: 'drain', ball });
    }
  }

  return events;
}

function maxFlipperTipSpeed(state) {
  let m = 0;
  for (const f of state.flippers) m = Math.max(m, Math.abs(f.angVel || 0) * f.len);
  return m;
}

function substep(ball, h, state, events) {
  // 重力积分（ready 阶段球锁在发射槽，不加重力）
  if (!ball.locked) {
    ball.vel.y += TABLE.GRAVITY * h;
  }
  // 限速
  const sp0 = len(ball.vel);
  if (sp0 > TABLE.MAX_SPEED) ball.vel = scale(ball.vel, TABLE.MAX_SPEED / sp0);

  const c0 = { ...ball.pos };
  const v = ball.vel;

  // 收集本子步所有候选碰撞，取最早 t
  const hits = [];

  for (const w of WALLS) {
    const r = sweptCircleSegment(c0, ball.r, v, h, w.a, w.b);
    if (r.hit) hits.push({ kind: 'wall', obj: w, ...r });
  }
  for (const rl of RAILS) {
    const r = sweptCircleSegment(c0, ball.r, v, h, rl.a, rl.b);
    if (r.hit) hits.push({ kind: 'rail', obj: rl, ...r });
  }
  for (const s of SLINGSHOTS) {
    const r = sweptCircleSegment(c0, ball.r, v, h, s.a, s.b);
    if (r.hit) hits.push({ kind: 'sling', obj: s, ...r });
  }
  for (const f of state.flippers) {
    const g = flipperGeometry(f);
    const r = sweptCircleSegment(c0, ball.r, v, h, g.a, g.b, g.va, g.vb);
    if (r.hit) hits.push({ kind: 'flipper', obj: f, ...r });
  }
  for (const bm of BUMPERS) {
    const r = sweptCircleCircle(c0, ball.r, v, h, bm.pos, bm.r);
    if (r.hit) hits.push({ kind: 'bumper', obj: bm, ...r });
  }
  for (const tg of TARGETS) {
    const r = sweptCircleCircle(c0, ball.r, v, h, tg.pos, tg.r);
    if (r.hit) hits.push({ kind: 'target', obj: tg, ...r });
  }

  let consumed = h;
  if (hits.length === 0) {
    ball.pos = add(c0, scale(v, h));
  } else {
    hits.sort((p, q) => p.t - q.t);
    const hit = hits[0];
    // 前进到碰撞时刻（留一丢丢余量防嵌入），剩余时间留给下一次迭代
    const advance = Math.max(0, hit.t - 1e-5);
    ball.pos = add(c0, scale(v, advance));
    resolveHit(ball, hit, state, events);
    // 零步长保护：位置修正已分离，强制推进防死循环；取 h 的 8% 保证每帧子步有上界
    consumed = Math.max(advance, h * 0.08);
  }

  // 冷却计时
  for (const k of Object.keys(ball.cooldown)) {
    ball.cooldown[k] -= h;
    if (ball.cooldown[k] <= 0) delete ball.cooldown[k];
  }

  // 滚动视觉量
  ball.spin += (len(ball.vel) * h) / ball.r;

  // 残影
  ball.trail.push({ x: ball.pos.x, y: ball.pos.y });
  if (ball.trail.length > 10) ball.trail.shift();

  // 卡死检测与自救
  stuckRecovery(ball, h, events);
  return consumed;
}

function resolveHit(ball, hit, state, events) {
  const n = hit.normal; // 指向球
  const impact = Math.abs(dot(ball.vel, n));
  const cdKey = hit.kind + ':' + hit.obj.id;

  switch (hit.kind) {
    case 'wall': {
      ball.vel = reflectVelocity(ball.vel, n, hit.obj.e, vec(), 0.02);
      positionalCorrection(ball, n, ball.r, hit);
      // 仅在有一定力度时上报，避免贴墙滚动刷屏音效
      if (impact > 120) events.push({ type: 'wall', impact, ball });
      break;
    }
    case 'rail': {
      // 导轨：低恢复 + 小摩擦，球被顺出去
      ball.vel = reflectVelocity(ball.vel, n, 0.18, vec(), 0.06);
      positionalCorrection(ball, n, ball.r, hit);
      events.push({ type: 'rail', impact, ball });
      break;
    }
    case 'sling': {
      ball.vel = reflectVelocity(ball.vel, n, 0.35, vec(), 0.03);
      if (!ball.cooldown[cdKey]) {
        // 弹弓给一个沿法向的固定小踢力
        ball.vel = add(ball.vel, scale(n, hit.obj.kick));
        ball.cooldown[cdKey] = 0.18;
        events.push({ type: 'sling', obj: hit.obj, impact: hit.obj.kick, ball });
      }
      positionalCorrection(ball, n, ball.r, hit);
      break;
    }
    case 'flipper': {
      const f = hit.obj;
      const g = flipperGeometry(f);
      const cp = closestPointOnSegment(ball.pos, g.a, g.b).point;
      const surfV = flipperSurfaceVelocity(f, cp);
      // 关键：相对速度反射，表面线速度（含 ω）直接耦合给球
      ball.vel = reflectVelocity(ball.vel, n, 0.55, surfV, 0.0);
      positionalCorrection(ball, n, ball.r, hit);
      events.push({ type: 'flipperHit', obj: f, impact: Math.max(impact, len(surfV)), ball });
      ball.cooldown[cdKey] = 0.05;
      break;
    }
    case 'bumper': {
      const bm = hit.obj;
      if (!ball.cooldown[cdKey]) {
        // 固定冲量：强制法向出射速度，绝不黏着抖动
        const base = reflectVelocity(ball.vel, n, 0.4, vec(), 0.0);
        const vn = dot(base, n);
        ball.vel = add(base, scale(n, Math.max(0, bm.kick - vn)));
        ball.cooldown[cdKey] = 0.14;
        bm.flash = 0.16;
        events.push({ type: 'bumper', obj: bm, impact: bm.kick, ball });
      } else {
        ball.vel = reflectVelocity(ball.vel, n, 0.4, vec(), 0.0);
      }
      positionalCorrection(ball, n, ball.r, hit);
      break;
    }
    case 'target': {
      const tg = hit.obj;
      if (!ball.cooldown[cdKey]) {
        ball.vel = reflectVelocity(ball.vel, n, 0.62, vec(), 0.0);
        ball.cooldown[cdKey] = 0.28;
        tg.flash = 0.22;
        events.push({ type: 'target', obj: tg, impact, ball });
      } else {
        ball.vel = reflectVelocity(ball.vel, n, 0.5, vec(), 0.0);
      }
      positionalCorrection(ball, n, ball.r, hit);
      break;
    }
  }
}

/** 位置修正：把球从重叠里沿法向推到刚好接触，消除嵌入式抖动 */
function positionalCorrection(ball, n, r, hit) {
  if (hit.t > 1e-6) return; // 行进中碰撞本就不重叠
  // 仅对 t≈0 的残留重叠做修正
  const g = hit.obj;
  let nearest;
  if (hit.kind === 'bumper' || hit.kind === 'target') {
    nearest = g.pos;
    const d = sub(ball.pos, nearest);
    const want = r + g.r;
    const l = len(d) || 1;
    ball.pos = add(nearest, scale(d, want / l));
  } else {
    const { point } = closestPointOnSegment(ball.pos, g.a, g.b);
    const d = sub(ball.pos, point);
    const want = r + (g.r || 0);
    const l = len(d);
    if (l < want) ball.pos = add(point, scale(l > 1e-9 ? scale(d, 1 / l) : n, want));
  }
}

function collideBalls(b1, b2, dt, events) {
  if (!b1.alive || !b2.alive) return;
  const vRel = sub(b1.vel, b2.vel);
  const hit = sweptCircleCircle(b1.pos, b1.r, vRel, dt, b2.pos, b2.r);
  if (!hit.hit) return;
  const n = hit.normal; // b1 -> 外侧
  // 等质量弹性碰撞：交换法向分量
  const rel = sub(b1.vel, b2.vel);
  const vn = dot(rel, n);
  if (vn <= 0) {
    const imp = scale(n, vn);
    b1.vel = sub(b1.vel, imp);
    b2.vel = add(b2.vel, imp);
    // 分离
    const overlap = b1.r + b2.r - len(sub(b1.pos, b2.pos));
    if (overlap > 0) {
      b1.pos = add(b1.pos, scale(n, overlap * 0.5));
      b2.pos = sub(b2.pos, scale(n, overlap * 0.5));
    }
    events.push({ type: 'ballBall', impact: Math.abs(vn) });
  }
}

/** 卡死自救：用位移窗口判定——原地高速抖动也算卡死（不只看瞬时速度） */
function stuckRecovery(ball, h, events) {
  if (ball.locked) { ball.stuckT = 0; return; }

  if (!ball.hist) { ball.hist = []; ball.histT = 0; }
  ball.hist.push({ x: ball.pos.x, y: ball.pos.y });
  ball.histT += h;
  while (ball.histT > 1.2 && ball.hist.length > 1) {
    ball.hist.shift();
    ball.histT -= h;
  }
  const anchor = ball.hist[0];
  const wandering = len(sub(ball.pos, anchor)) > 18;

  if (wandering) {
    ball.safeT += h;
    if (len(ball.vel) > 120 && ball.safeT > 0.25) {
      ball.lastSafe = { ...ball.pos };
      ball.safeT = 0;
    }
    // 已进入自救流程后不再让徘徊清零计时器，保证升级传送能触发
    if (!ball.nudgeCount) ball.stuckT = Math.max(0, ball.stuckT - h * 2);
  } else {
    ball.stuckT += h;
  }
  if (ball.nudgeCd) ball.nudgeCd -= h;

  // 两级自救：先冲量；两次轻推仍未脱困 -> 传送回安全点（保证不永久抖）
  if (ball.nudgeCount >= 2) {
    ball.pos = { ...ball.lastSafe };
    ball.vel = vec(0, -180);
    ball.stuckT = 0;
    ball.nudgeCd = 1;
    ball.nudgeCount = 0;
    ball.hist = [];
    ball.histT = 0;
    events.push({ type: 'unstuckTeleport', ball });
    return;
  }
  if (ball.stuckT > 1.4 && !ball.nudgeCd) {
    // 优先找天然自由方向；凹角里全被堵住时直接给向上强冲量
    const dirs = [
      vec(0, -1), vec(-0.7, -0.7), vec(0.7, -0.7), vec(-1, 0), vec(1, 0),
    ];
    let nudged = false;
    for (const d of dirs) {
      const dn = norm(d);
      if (isFree(ball, add(ball.pos, scale(dn, ball.r * 2.2)))) {
        ball.vel = add(ball.vel, scale(dn, 280));
        nudged = true;
        break;
      }
    }
    if (!nudged) ball.vel = add(ball.vel, vec(0, -520));
    ball.stuckT = 0;
    ball.nudgeCd = 1;
    ball.nudgeCount = (ball.nudgeCount || 0) + 1;
    events.push({ type: 'unstuck', ball });
  }
}

function isFree(ball, p) {
  for (const w of WALLS) {
    const { point } = closestPointOnSegment(p, w.a, w.b);
    if (len(sub(p, point)) < ball.r + (w.r || 0) + 1) return false;
  }
  for (const bm of BUMPERS) {
    if (len(sub(p, bm.pos)) < ball.r + bm.r + 1) return false;
  }
  return true;
}
