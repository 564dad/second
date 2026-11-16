// 对局状态：摆球、犯规、母球复位、回合
import { makeBall } from './balls.js';
import { buildTable } from './table.js';
import { PLAY_W, PLAY_H, BALL_R } from './constants.js';

const HEAD_X = PLAY_W * 0.25;           // 开球线
const RACK_APEX_X = PLAY_W * 0.72;      // 三角框顶点
const RACK_CY = PLAY_H / 2;

// 固定但花色分布合理的摆球顺序（8 在中心）
const RACK_ORDER = [1, 9, 2, 10, 8, 11, 3, 12, 14, 4, 13, 6, 7, 15, 5];

export function rackPositions() {
  const positions = [];
  const gap = 2 * BALL_R + 0.00015;     // 微间隙，避免初始重叠抖动
  const dy = gap * Math.sqrt(3) / 2;
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    for (let k = 0; k <= row; k++) {
      const x = RACK_APEX_X + row * dy;
      const y = RACK_CY + (k - row / 2) * gap;
      positions.push({ num: RACK_ORDER[idx++], x, y });
    }
  }
  return positions;
}

export function createGame() {
  const table = buildTable();
  const balls = [];
  balls.push(makeBall(0, HEAD_X, PLAY_H / 2));
  for (const p of rackPositions()) balls.push(makeBall(p.num, p.x, p.y));
  return {
    table,
    balls,
    phase: 'aiming',      // aiming | charging | cueing | simulating
    cueTimer: 0,
    shotPocketed: [],     // 本杆已落袋的球（含动画中的）
    foul: '',
    lastShotFoul: false,
    shots: 0,
    message: '移动鼠标瞄准，按住左键蓄力，松开出杆',
  };
}

export function remainingBalls(balls) {
  return balls.filter(b => b.num !== 0 && b.active).length;
}

// 母球复位到开球点；被占则沿开球线向后平移
export function respotCue(game) {
  const cue = game.balls.find(b => b.num === 0);
  const blockers = game.balls.filter(b => b.num !== 0 && b.active);
  let x = HEAD_X;
  let y = PLAY_H / 2;
  outer:
  for (let attempt = 0; attempt < 40; attempt++) {
    const cand = attempt < 20
      ? { x, y: PLAY_H / 2 + (attempt % 2 === 0 ? 1 : -1) * Math.ceil(attempt / 2) * BALL_R * 2.05 }
      : { x: HEAD_X - attempt * BALL_R * 1.05, y: PLAY_H / 2 };
    for (const b of blockers) {
      if (Math.hypot(b.x - cand.x, b.y - cand.y) < BALL_R * 2.02) continue outer;
    }
    x = cand.x; y = cand.y;
    break;
  }
  cue.x = x; cue.y = y;
  cue.vx = cue.vy = 0;
  cue.wx = cue.wy = cue.wz = 0;
  cue.state = 'rest';
  cue.active = true;
  cue.sinkT = 0;
  cue.pocket = null;
}

// 一杆结束时结算
export function settleShot(game) {
  const pocketed = game.shotPocketed;
  const cuePocketed = pocketed.some(b => b.num === 0);
  const eight = game.balls.find(b => b.num === 8);

  // 8 号球过早落袋：摆回顶点位置（不判负，休闲规则）
  if (!eight.active) {
    const pos = { x: RACK_APEX_X, y: RACK_CY };
    const blockers = game.balls.filter(b => b !== eight && b.active);
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = attempt * 0.06;
      const cand = {
        x: pos.x - Math.sin(a) * BALL_R * 2.1,
        y: pos.y + (attempt % 2 === 0 ? 1 : -1) * Math.ceil(attempt / 2) * BALL_R * 2.1,
      };
      if (blockers.every(b => Math.hypot(b.x - cand.x, b.y - cand.y) > BALL_R * 2.02)) {
        eight.x = cand.x; eight.y = cand.y;
        break;
      }
    }
    eight.vx = eight.vy = eight.wx = eight.wy = eight.wz = 0;
    eight.state = 'rest';
    eight.active = true;
    eight.sinkT = 0;
    eight.pocket = null;
  }

  let foul = '';
  if (cuePocketed) foul = '犯规：母球落袋，已放回开球点';
  game.lastShotFoul = !!foul;
  game.foul = foul;
  game.shotPocketed = [];

  if (cuePocketed) respotCue(game);

  if (!eight.active) {
    game.phase = 'gameover';
    game.message = cuePocketed ? '8 号球与母球同落——本局结束' : '8 号球落袋——本局结束';
    return;
  }
  game.phase = 'aiming';
}
