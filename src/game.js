// game.js — 游戏状态机与规则（纯逻辑，不碰 DOM；渲染/输入在 main.js 装配）
import { vec, clamp } from './vec.js';
import {
  PLUNGER, FLIPPERS, TARGETS, BUMPERS, COMBO_WINDOW,
} from './table.js';
import { createBall, stepPhysics } from './physics.js';

export const PHASE = {
  READY: 'ready',       // 球锁在发射槽，等待蓄力
  PLAY: 'play',         // 台面运行
  GAMEOVER: 'gameover',
};

const START_LIVES = 3;
const FIXED_DT = 1 / 120;

export function createGame() {
  const state = {
    phase: PHASE.READY,
    score: 0,
    high: loadHigh(),
    lives: START_LIVES,
    balls: [],
    flippers: FLIPPERS.map((f) => ({
      ...f,
      ang: f.restAng,
      angVel: 0,
      pressed: false,
    })),
    targets: TARGETS.map((t) => ({ ...t, lit: false, flash: 0, hits: 0 })),
    combo: { targetId: null, count: 0, t: 0 },
    mbArmed: true,      // multiball 每局可触发一次，触发后重新装填
    mbPending: 0,       // 待发射的第二球计时
    charge: 0,          // 蓄力 0..1
    charging: false,
    events: [],
    time: 0,
    stats: { maxSubsteps: 0, steps: 0, lastSubsteps: 0 },
  };
  lockNewBall(state);
  return state;
}

function loadHigh() {
  try {
    return parseInt(localStorage.getItem('neonzone.high') || '0', 10) || 0;
  } catch { return 0; }
}
function saveHigh(v) {
  try { localStorage.setItem('neonzone.high', String(v)); } catch { /* 无头环境忽略 */ }
}

function lockNewBall(state) {
  const ball = createBall((PLUNGER.x0 + PLUNGER.x1) / 2, PLUNGER.restY);
  ball.locked = true;
  ball.vel = vec(0, 0);
  state.balls.push(ball);
  state.phase = PHASE.READY;
  state.charge = 0;
  state.charging = false;
  return ball;
}

export function setFlipper(state, side, pressed) {
  const f = state.flippers.find((x) => x.id === side);
  if (f) f.pressed = pressed;
}

export function startCharge(state) {
  if (state.phase !== PHASE.READY) return;
  state.charging = true;
}

export function releaseLaunch(state) {
  if (state.phase !== PHASE.READY || !state.charging) return;
  const ball = state.balls.find((b) => b.locked);
  if (!ball) { state.charging = false; return; }
  const power = PLUNGER.minLaunch +
    (PLUNGER.maxLaunch - PLUNGER.minLaunch) * state.charge;
  ball.locked = false;
  ball.vel = vec(0, -power);
  ball.trail = [];
  state.charging = false;
  state.charge = 0;
  state.phase = PHASE.PLAY;
  state.events.push({ type: 'launch', power });
}

/** 每帧推进；frameDt 为真实帧间隔，内部固定步长累加 */
export function update(state, frameDt) {
  frameDt = Math.min(frameDt, 0.05); // 卡顿保护
  state.time += frameDt;

  // 蓄力
  if (state.charging && state.phase === PHASE.READY) {
    state.charge = clamp(state.charge + frameDt / PLUNGER.chargeTime, 0, 1);
  }

  // 连击窗口
  if (state.combo.count > 0) {
    state.combo.t -= frameDt;
    if (state.combo.t <= 0) {
      state.combo.count = 0;
      state.combo.targetId = null;
    }
  }

  // 闪光衰减（靶子/弹力柱镜像）
  for (const t of state.targets) if (t.flash > 0) t.flash -= frameDt;
  for (const b of BUMPERS) if (b.flash > 0) b.flash -= frameDt;

  // multiball 待发球
  if (state.mbPending > 0) {
    state.mbPending -= frameDt;
    if (state.mbPending <= 0) {
      const b = lockNewBall(state);
      // 自动满力发射
      b.locked = false;
      b.vel = vec(0, -PLUNGER.maxLaunch * 0.92);
      state.phase = PHASE.PLAY;
      state.events.push({ type: 'multiball' });
    }
  }

  // 固定步长
  state._acc = (state._acc || 0) + frameDt;
  let loops = 0;
  while (state._acc >= FIXED_DT && loops++ < 12) {
    const ev = stepPhysics(state, FIXED_DT);
    // 物理引擎写的是 table 单例上的 flash，同步到状态镜像供渲染层统一读
    for (const t of state.targets) {
      const src = TARGETS.find((x) => x.id === t.id);
      if (src && src.flash > t.flash) t.flash = src.flash;
    }
    handleEvents(state, ev);
    state._acc -= FIXED_DT;
    state.stats.steps++;
  }
  tickRearm(state);

  // 球全没了（multiball 待发球时不算掉命——第二球马上要进发射槽）
  if (state.phase === PHASE.PLAY && state.balls.every((b) => !b.alive) &&
      state.mbPending <= 0) {
    state.balls = [];
    state.lives -= 1;
    if (state.lives <= 0) {
      state.phase = PHASE.GAMEOVER;
      if (state.score > state.high) {
        state.high = state.score;
        saveHigh(state.high);
      }
      state.events.push({ type: 'gameover' });
    } else {
      lockNewBall(state);
      state.events.push({ type: 'nextLife', lives: state.lives });
    }
  }

  // 清理死球引用（保留 alive 的）
  state.balls = state.balls.filter((b) => b.alive);
  return state.events.splice(0);
}

function handleEvents(state, events) {
  for (const ev of events) {
    state.events.push(ev);
    switch (ev.type) {
      case 'bumper':
        addScore(state, ev.obj.score);
        break;
      case 'target': {
        const t = state.targets.find((x) => x.id === ev.obj.id);
        if (!t) break;
        t.lit = true;
        t.hits++;
        // 同一靶子连击：窗口内每次递增
        let gained;
        if (state.combo.targetId === t.id) {
          state.combo.count += 1;
        } else {
          state.combo.targetId = t.id;
          state.combo.count = 1;
        }
        state.combo.t = COMBO_WINDOW;
        gained = t.score * state.combo.count; // 1x, 2x, 3x ...
        addScore(state, gained);
        ev.combo = state.combo.count;
        ev.gained = gained;
        // multiball 组全部点亮 -> 第二球
        if (state.mbArmed && t.group === 'mb') {
          const group = state.targets.filter((x) => x.group === 'mb');
          if (group.every((x) => x.lit)) {
            state.mbArmed = false;
            state.mbPending = 0.9;
            for (const x of group) x.lit = false; // 重置，允许后续再次装填
            ev.multiball = true;
          }
        }
        break;
      }
      case 'drain':
        break;
      default:
        break;
    }
  }
}

function addScore(state, n) {
  state.score += n;
}

export function resetGame(state) {
  const fresh = createGame();
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  state._acc = 0;
}

// 重新装填 multiball（当球数回到 1 时允许再次触发）
export function tickRearm(state) {
  if (!state.mbArmed && state.balls.filter((b) => b.alive).length <= 1) {
    state.mbArmed = true;
  }
}

// 供调试/测试：直接放一个球到指定位置并给速度
export function spawnTestBall(state, x, y, vx, vy) {
  const b = createBall(x, y);
  b.locked = false;
  b.vel = vec(vx, vy);
  state.balls.push(b);
  if (state.phase === PHASE.READY) state.phase = PHASE.PLAY;
  return b;
}

export { FIXED_DT, START_LIVES, lockNewBall };
