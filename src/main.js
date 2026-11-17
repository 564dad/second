// main.js — 装配层：画布、输入、主循环、HUD、音效/粒子事件、调试面板、自测
import { createGame, update, setFlipper, startCharge, releaseLaunch, resetGame, spawnTestBall, PHASE, FIXED_DT } from './game.js';
import { TABLE, PLUNGER, BUMPERS } from './table.js';
import { createProjection } from './projection.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { len } from './vec.js';
import { runSelfTests } from './selftest.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const elScore = document.getElementById('score');
const elHigh = document.getElementById('high');
const elBalls = document.getElementById('balls');
const elCharge = document.getElementById('charge-bar');
const elOverlay = document.getElementById('overlay');
const elOverlayTitle = document.getElementById('overlay-title');
const elOverlayScore = document.getElementById('overlay-score');
const elOverlayBest = document.getElementById('overlay-best');
const elOverlayHint = document.getElementById('overlay-hint');
const elDebug = document.getElementById('debug');
const elDbgBody = document.getElementById('dbg-body');

let viewW = 0, viewH = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  canvas.width = Math.floor(viewW * dpr);
  canvas.height = Math.floor(viewH * dpr);
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  proj = createProjection(viewW, viewH);
  renderer = createRenderer(ctx, proj);
}
let proj = createProjection(window.innerWidth, window.innerHeight);
let renderer = createRenderer(ctx, proj);
window.addEventListener('resize', resize);
resize();

const audio = createAudio();
const state = createGame();
const particles = [];

// ---------- 粒子 ----------
function burst(x, y, color, n = 10, speed = 220) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    particles.push({
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      life: 0.45 + Math.random() * 0.3,
      maxLife: 0.75,
      size: 1.5 + Math.random() * 2.2,
      color,
    });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vy += 500 * dt;
    p.vx *= 0.985;
  }
}

// ---------- 输入 ----------
const keys = {};
window.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Space', 'KeyA', 'KeyD', 'KeyR', 'KeyD2'].includes(e.code)) e.preventDefault();
  if (keys[e.code]) return; // 锁连发
  keys[e.code] = true;
  audio.resume();

  if (e.code === 'ArrowLeft' || e.code === 'KeyA') setFlipper(state, 'L', true);
  if (e.code === 'ArrowRight' || e.code === 'KeyD') setFlipper(state, 'R', true);
  if (e.code === 'Space') {
    if (state.phase === PHASE.GAMEOVER) { resetGame(state); return; }
    startCharge(state);
  }
  if (e.code === 'KeyR') resetGame(state);
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') setFlipper(state, 'L', false);
  if (e.code === 'ArrowRight' || e.code === 'KeyD') setFlipper(state, 'R', false);
  if (e.code === 'Space') {
    const power = state.charge;
    releaseLaunch(state);
    if (state.phase === PHASE.PLAY) audio.launch(power);
  }
});

// ---------- 调试面板 ----------
let debugOn = false;
function toggleDebug() {
  debugOn = !debugOn;
  elDebug.classList.toggle('hidden', !debugOn);
}
// 调试面板：P 键切换（D 键保留给右挡板 A/D 方案，避免冲突）
window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP') toggleDebug();
});

function buildDebugPanel() {
  elDbgBody.innerHTML = `
    <div id="dbg-stats"></div>
    <div style="margin-top:6px">
      <button id="btn-tunnel">穿模×5</button>
      <button id="btn-flipper">挡板发力</button>
      <button id="btn-combo">连击递增</button>
      <button id="btn-stuck">卡死自救</button>
      <button id="btn-all">全部自测</button>
    </div>
    <div class="dbg-log" id="dbg-log"></div>`;
  const log = (msg, ok) => {
    const el = document.getElementById('dbg-log');
    const line = document.createElement('div');
    line.className = ok === undefined ? '' : ok ? 'dbg-pass' : 'dbg-fail';
    line.textContent = msg;
    el.prepend(line);
  };
  document.getElementById('btn-tunnel').onclick = () => runSelfTests(state, ['tunnel'], log);
  document.getElementById('btn-flipper').onclick = () => runSelfTests(state, ['flipper'], log);
  document.getElementById('btn-combo').onclick = () => runSelfTests(state, ['combo'], log);
  document.getElementById('btn-stuck').onclick = () => runSelfTests(state, ['stuck'], log);
  document.getElementById('btn-all').onclick = () => runSelfTests(state, null, log);
}
buildDebugPanel();

// ---------- 事件 -> 音效/粒子 ----------
function handleGameEvents(events) {
  for (const ev of events) {
    switch (ev.type) {
      case 'bumper':
        audio.hit(0.85, 'bumper');
        burst(ev.obj.pos.x, ev.obj.pos.y, '#ff3b6b', 12, 260);
        break;
      case 'target':
        audio.target(Math.min(1, ev.impact / 1500), ev.combo);
        burst(ev.obj.pos.x, ev.obj.pos.y, ev.obj.color === 'amber' ? '#ffb347' : '#27e6ff', 8, 180);
        break;
      case 'flipperHit':
        audio.hit(Math.min(1, ev.impact / 2200), 'flipper');
        break;
      case 'ballBall':
        audio.hit(Math.min(1, ev.impact / 2000), 'wall');
        break;
      case 'wall':
        audio.hit(Math.min(1, ev.impact / 1800), 'wall');
        break;
      case 'rail':
        audio.rail(Math.min(1, ev.impact / 1500));
        break;
      case 'sling':
        audio.hit(0.5, 'wall');
        burst(ev.obj.a.x, ev.obj.a.y, '#ff3fd8', 6, 140);
        break;
      case 'drain':
        audio.drain();
        break;
      case 'gameover':
        audio.gameover();
        showOverlay();
        break;
      case 'multiball':
        audio.multiball();
        break;
      case 'unstuck':
      case 'unstuckTeleport':
        burst(ev.ball.pos.x, ev.ball.pos.y, '#50ffaa', 8, 160);
        break;
      default:
        break;
    }
  }
}

function showOverlay() {
  elOverlay.classList.remove('hidden');
  elOverlayTitle.textContent = 'GAME OVER';
  elOverlayScore.textContent = 'SCORE ' + state.score;
  elOverlayBest.textContent = 'BEST ' + state.high;
  elOverlayHint.textContent = 'PRESS R TO RESTART';
}
function hideOverlay() { elOverlay.classList.add('hidden'); }

// ---------- HUD ----------
function syncHud() {
  elScore.textContent = state.score;
  elHigh.textContent = state.high;
  const total = 3;
  const alive = state.lives;
  elBalls.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('div');
    dot.className = 'ball-dot' + (i >= alive ? ' dead' : '');
    elBalls.appendChild(dot);
  }
  elCharge.style.width = Math.round(state.charge * 100) + '%';
  if (state.phase !== PHASE.GAMEOVER) hideOverlay();
}

// ---------- 调试统计 ----------
let fpsAcc = 0, fpsFrames = 0, fpsShown = 0, frameMax = 0;
function updateDebugStats(dt) {
  if (!debugOn) return;
  fpsAcc += dt; fpsFrames++;
  frameMax = Math.max(frameMax, dt * 1000);
  if (fpsAcc >= 0.5) {
    fpsShown = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0; fpsFrames = 0;
  }
  const b = state.balls[0];
  const speed = b ? Math.round(len(b.vel)) : 0;
  const pos = b ? `${Math.round(b.pos.x)},${Math.round(b.pos.y)}` : '-';
  const lw = state.flippers[0].angVel.toFixed(1);
  const rw = state.flippers[1].angVel.toFixed(1);
  const combo = state.combo.count;
  document.getElementById('dbg-stats').innerHTML =
    `phase: ${state.phase}<br>` +
    `balls: ${state.balls.length}<br>` +
    `ball speed: ${speed} px/s<br>` +
    `ball pos: ${pos}<br>` +
    `Lω=${lw} Rω=${rw}<br>` +
    `combo: ${combo} · substep: ${FIXED_DT.toFixed(4)}s<br>` +
    `max substeps/frame: ${state.stats.lastSubsteps}<br>` +
    `fps: ${fpsShown} · frame max: ${frameMax.toFixed(1)}ms<br>` +
    `score: ${state.score} · lives: ${state.lives}<br>` +
    `<span style="color:#7fe6ac">[P] 面板 · 方向键挡板 · 空格发射</span>`;
}

// ---------- 主循环 ----------
let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const events = update(state, dt);
  handleGameEvents(events);
  updateParticles(dt);
  renderer.render(state, particles, viewW, viewH);
  syncHud();
  updateDebugStats(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 暴露给自测/控制台
window.__pinball = { state, resetGame, spawnTestBall, runSelfTests, BUMPERS, TABLE, PLUNGER };
