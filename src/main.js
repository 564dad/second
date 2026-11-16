import { createGame, remainingBalls, settleShot } from './game.js';
import { cueStrike } from './balls.js';
import { physicsStep, allStopped, anySinking } from './physics.js';
import { Renderer } from './renderer.js';
import { initUI } from './ui.js';
import { DT_FIXED, MAX_STEPS_PER_FRAME, MAX_CUE_SPEED } from './constants.js';

const canvas = document.getElementById('table');
const renderer = new Renderer(canvas);
let game = createGame();
const ui = initUI(handleUIEvent);

const aim = { ax: 1, ay: 0, angle: 0 };
const cueAnim = { power: 0, strikeOffset: 0 };
const input = { charging: false, spaceHeld: false };
let debugOn = false;
let accumulator = 0;
let lastT = performance.now();
let fpsAcc = 0, fpsCount = 0, fpsShown = 60;
let frameSteps = 0, stepUs = 0;
let settleCooldown = 0;
function handleUIEvent(type, value) {
  if (type === 'restart') restart();
  if (type === 'debug') debugOn = value;
}

function restart() {
  game = createGame();
  accumulator = 0;
  settleCooldown = 0;
  input.charging = false;
  cueAnim.power = 0;
  cueAnim.strikeOffset = 0;
}

// —— 瞄准 ——
function updateAimFromPointer(e) {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = renderer.toWorld(e.clientX - rect.left, e.clientY - rect.top);
  const cue = game.balls.find(b => b.num === 0);
  const dx = wx - cue.x, dy = wy - cue.y;
  const l = Math.hypot(dx, dy);
  if (l > 1e-4) {
    aim.ax = dx / l;
    aim.ay = dy / l;
    aim.angle = Math.atan2(dy, dx);
  }
}

canvas.addEventListener('pointermove', updateAimFromPointer);
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0 || game.phase !== 'aiming') return;
  updateAimFromPointer(e);
  input.charging = true;
  game.phase = 'charging';
});
window.addEventListener('pointerup', e => {
  if (e.button !== 0) return;
  releaseShot();
});

window.addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (!input.spaceHeld && game.phase === 'aiming') {
      input.spaceHeld = true;
      input.charging = true;
      game.phase = 'charging';
    }
  }
  if (e.code === 'KeyR') restart();
  if (e.code === 'KeyD') {
    debugOn = !debugOn;
    ui.el.debug.classList.toggle('hidden', !debugOn);
  }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    aim.angle += e.code === 'ArrowLeft' ? -0.02 : 0.02;
    aim.ax = Math.cos(aim.angle);
    aim.ay = Math.sin(aim.angle);
  }
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    input.spaceHeld = false;
    releaseShot();
  }
});

function releaseShot() {
  if (!input.charging) return;
  input.charging = false;
  if (game.phase !== 'charging') return;
  game.phase = 'cueing';
  game.cueTimer = 0;
  game.shots++;
}

// —— 出杆时序：后拉 -> 前捅 -> 击球 ——
function updateCueAction(dt) {
  if (game.phase === 'charging') {
    // 蓄力 1 秒满
    cueAnim.power = Math.min(1, cueAnim.power + dt / 1.0);
    cueAnim.strikeOffset = 0;
    ui.setPower(cueAnim.power);
  } else if (game.phase === 'cueing') {
    game.cueTimer += dt;
    const t = game.cueTimer / 0.14;           // 140ms 前捅
    cueAnim.strikeOffset = Math.min(1, t) * (0.05 + cueAnim.power * 0.22);
    if (game.cueTimer >= 0.14) {
      const cue = game.balls.find(b => b.num === 0);
      cueStrike(cue, aim.ax, aim.ay, cueAnim.power, ui.state.side, ui.state.top);
      game.phase = 'simulating';
      game.foul = '';
      cueAnim.strikeOffset = 0;
      cueAnim.power = 0;
      ui.setPower(0);
    }
  }
}

// —— 主循环：固定物理步 + 插值无关的直接渲染 ——
function frame(now) {
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.1) dt = 0.1;

  // FPS
  fpsAcc += dt; fpsCount++;
  if (fpsAcc >= 0.5) {
    fpsShown = Math.round(fpsCount / fpsAcc);
    fpsAcc = 0; fpsCount = 0;
  }

  updateCueAction(dt);

  if (game.phase === 'simulating') {
    accumulator += dt;
    frameSteps = 0;
    const t0 = performance.now();
    let steps = 0;
    while (accumulator >= DT_FIXED && steps < MAX_STEPS_PER_FRAME) {
      const pocketed = physicsStep(game.balls, game.table);
      for (const b of pocketed) game.shotPocketed.push(b);
      accumulator -= DT_FIXED;
      steps++;
    }
    stepUs = performance.now() - t0;
    frameSteps = steps;
    if (steps >= MAX_STEPS_PER_FRAME) accumulator = 0;

    if (allStopped(game.balls)) {
      settleCooldown += dt;
      // 等落袋动画播完再结算
      if (settleCooldown > 0.25 && !anySinking(game.balls)) {
        settleShot(game);
        settleCooldown = 0;
      }
    } else {
      settleCooldown = 0;
    }
  }

  renderer.draw(game, aim, cueAnim);
  ui.update({
    remaining: remainingBalls(game.balls),
    shots: game.shots,
    foul: game.foul,
    message: game.message,
  });
  if (debugOn) drawDebug(frameSteps);
  requestAnimationFrame(frame);
}

function drawDebug(stepCount) {
  const cue = game.balls.find(b => b.num === 0);
  const lines = [
    `FPS: ${fpsShown}`,
    `物理子步/帧: ${stepCount} (步长 ${(DT_FIXED * 1000).toFixed(2)}ms)`,
    `步进耗时: ${stepUs.toFixed(2)}ms`,
    `阶段: ${game.phase}`,
    `母球 v: ${Math.hypot(cue.vx, cue.vy).toFixed(3)} m/s`,
    `母球 ω: (${cue.wx.toFixed(2)}, ${cue.wy.toFixed(2)}, ${cue.wz.toFixed(2)}) rad/s`,
    `状态: ${cue.state}`,
    `塞: side=${ui.state.side.toFixed(2)} top=${ui.state.top.toFixed(2)}`,
    '',
    '球号  速度m/s  状态',
  ];
  for (const b of game.balls) {
    if (!b.active) continue;
    lines.push(`  ${b.num === 0 ? 'C' : String(b.num).padStart(2, ' ')}   ${Math.hypot(b.vx, b.vy).toFixed(3)}   ${b.state}`);
  }
  // 动量统计
  let px = 0, py = 0;
  for (const b of game.balls) {
    if (b.active) { px += b.vx; py += b.vy; }
  }
  lines.push('', `台面总动量/球质量: (${px.toFixed(3)}, ${py.toFixed(3)})`);
  lines.push(`满力初速基准: ${MAX_CUE_SPEED} m/s`);
  ui.setDebug(lines);
}

window.addEventListener('resize', () => renderer.resize());
// 调试/自动化钩子
window.__pool = {
  get game() { return game; },
  get aim() { return aim; },
  cueStrike: (power, side, top, ang = aim.angle) => {
    const cue = game.balls.find(b => b.num === 0);
    cueStrike(cue, Math.cos(ang), Math.sin(ang), power, side, top);
    game.phase = 'simulating';
    game.shots++;
  },
  // 逐固定物理步推进，返回第一次库边反弹后的速度（自动化精确采样用）
  runUntilCushionRebound(maxSteps = 1200) {
    const cue = game.balls.find(b => b.num === 0);
    let prevVy = cue.vy;
    for (let i = 0; i < maxSteps; i++) {
      physicsStep(game.balls, game.table);
      // 下库反弹：vy 由负转正
      if (prevVy < 0 && cue.vy > 0 && cue.y < 0.25) {
        return { vx: cue.vx, vy: cue.vy, steps: i };
      }
      prevVy = cue.vy;
    }
    return null;
  },
  restart,
};
requestAnimationFrame(() => {
  renderer.resize();
  requestAnimationFrame(frame);
});
