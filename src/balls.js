// 球对象与出杆冲量
import {
  BALL_R, BALL_M, BALL_I, MAX_CUE_SPEED,
} from './constants.js';

let nextId = 1;

export function makeBall(num, x, y) {
  return {
    id: nextId++,
    num,                 // 0 = 母球
    x, y,
    vx: 0, vy: 0,
    wx: 0, wy: 0, wz: 0, // 角速度 rad/s，z 为竖直轴（塞）
    state: 'rest',       // rest | slide | roll | sink | pocketed
    sinkT: 0,
    pocket: null,
    active: true,        // false = 落袋完成
  };
}

// 出杆：dirX/dirY 为击球方向单位向量
// side ∈ [-1,1]：右塞(+)/左塞(-)，击球点水平偏移，单位为球半径
// top  ∈ [-1,1]：低杆(-)/高杆(+)，击球点竖直(z 向)偏移
// power ∈ [0,1]
export function cueStrike(ball, dirX, dirY, power, side, top) {
  if (!ball.active || ball.state === 'sink') return;
  const speed = MAX_CUE_SPEED * power;
  const J = BALL_M * speed;

  ball.vx = dirX * speed;
  ball.vy = dirY * speed;

  // 击球点 r = R*(side*t) + z方向 R*top，t = (-dirY, dirX) 为指向方向左侧的横向单位向量
  const tx = -dirY;
  const ty = dirX;
  const rx = BALL_R * side * tx;
  const ry = BALL_R * side * ty;
  const rz = BALL_R * top;
  const jx = J * dirX;
  const jy = J * dirY;

  // ω = (r × Jv) / I，三维叉积，Jv 的 z 分量为 0
  ball.wx = (ry * 0 - rz * jy) / BALL_I;
  ball.wy = (rz * jx - rx * 0) / BALL_I;
  ball.wz = (rx * jy - ry * jx) / BALL_I;

  ball.state = 'slide';
}
