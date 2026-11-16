// 刚体台球物理：固定子步长积分
// 球在水平台面运动，角速度为三维 (wx, wy, wz)，z 轴竖直向上。
import {
  BALL_R, BALL_M, BALL_I,
  MU_SLIDE, ROLL_DECEL, SPIN_DECEL, G,
  REST_BALL, REST_CUSHION, MU_CUSHION, MU_BALL_T,
  STOP_V, STOP_W, STOP_WZ,
  DT_FIXED,
} from './constants.js';
import { checkPocketCapture } from './table.js';

// —— 单颗球的摩擦与积分 ——
function integrateBall(b, dt) {
  if (b.state === 'rest' || b.state === 'sink') return;

  const v = Math.hypot(b.vx, b.vy);

  if (b.state === 'slide') {
    // 接触点相对台呢的滑移速度 u = v + ω × r_contact，r_contact = (0,0,-R)
    // ω×r = (wy*(-R)... 计算：(wy*rz-wz*ry, wz*rx-wx*rz, ...)，rx=ry=0, rz=-R
    // => ux = vx - R*wy ; uy = vy + R*wx
    const ux = b.vx - BALL_R * b.wy;
    const uy = b.vy + BALL_R * b.wx;
    const u = Math.hypot(ux, uy);

    if (u < STOP_V) {
      // 滑移消失 -> 纯滚动：令 ω = (vy/R, -vx/R)
      b.wx = b.vy / BALL_R;
      b.wy = -b.vx / BALL_R;
      b.state = 'roll';
    } else {
      // 动摩擦力 F = -μmg * u_hat
      const a = MU_SLIDE * G;
      const uxN = ux / u;
      const uyN = uy / u;
      const dvx = -a * uxN * dt;
      const dvy = -a * uyN * dt;
      // 摩擦力对球心的力矩 τ = r × F，r=(0,0,-R)
      // τx = -R*Fy... r×F: (ryFz-rzFy, rzFx-rxFz, ...) = (R*Fy, -R*Fx, 0)
      const fx = BALL_M * dvx / dt;
      const fy = BALL_M * dvy / dt;
      const dwx = (BALL_R * fy / BALL_I) * dt;
      const dwy = (-BALL_R * fx / BALL_I) * dt;

      const nx = b.vx + dvx;
      const ny = b.vy + dvy;
      // 若本步内滑移反向，说明在步内跨过纯滚动点，直接钳到滚动状态
      const nux = nx - BALL_R * (b.wy + dwy);
      const nuy = ny + BALL_R * (b.wx + dwx);
      if (ux * nux + uy * nuy <= 0) {
        b.wx = b.vy / BALL_R;
        b.wy = -b.vx / BALL_R;
        b.state = 'roll';
      } else {
        b.vx = nx; b.vy = ny;
        b.wx += dwx; b.wy += dwy;
      }
      // 塞（竖直自转）与滑移无关，受独立滚动摩擦阻力矩衰减
      decaySpin(b, dt);
    }
  }

  if (b.state === 'roll') {
    const vNow = Math.hypot(b.vx, b.vy);
    if (vNow < STOP_V) {
      stopBall(b);
      return;
    }
    const dec = ROLL_DECEL * dt;
    const f = Math.max(0, 1 - dec / vNow);
    b.vx *= f;
    b.vy *= f;
    // 纯滚动约束
    b.wx = b.vy / BALL_R;
    b.wy = -b.vx / BALL_R;
    decaySpin(b, dt);
    if (Math.hypot(b.vx, b.vy) < STOP_V) stopBall(b);
  }

  // 位置积分
  b.x += b.vx * dt;
  b.y += b.vy * dt;
}

function decaySpin(b, dt) {
  if (Math.abs(b.wz) <= STOP_WZ) {
    b.wz = 0;
    return;
  }
  const s = Math.sign(b.wz);
  b.wz -= s * SPIN_DECEL * dt;
  if (s * b.wz < 0) b.wz = 0;
}

function stopBall(b) {
  b.vx = 0; b.vy = 0;
  b.wx = 0; b.wy = 0; b.wz = 0;
  b.state = 'rest';
}

// —— 球-球冲量碰撞（法向弹性 + 切向库仑摩擦）——
function collideBalls(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minD = 2 * BALL_R;
  if (d === 0 || d >= minD) return false;

  const nx = dx / d;
  const ny = dy / d;
  // 位置修正：各退一半
  const overlap = minD - d;
  a.x -= nx * overlap / 2;
  a.y -= ny * overlap / 2;
  b.x += nx * overlap / 2;
  b.y += ny * overlap / 2;

  // 相对接触点速度（含转动）：接触点法向为 n，切向 t = (-ny, nx)
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  // 已在分离且无重叠则无事可做；重叠时即便 vn≤0 也要冲量弹开，避免粘连穿透
  if (vn <= 0 && overlap <= 1e-9) return true;

  const tx = -ny;
  const ty = nx;
  // ω×r 接触点（r=(0,0,±R)）：a 上接触点 r=R*n，b 上 r=-R*n（z=0）
  // ω×r 的平面分量：(-ωz*ry, ωz*rx)
  const rax = BALL_R * nx, ray = BALL_R * ny;
  const rbx = -BALL_R * nx, rby = -BALL_R * ny;
  const cax = -a.wz * ray, cay = a.wz * rax;
  const cbx = -b.wz * rby, cby = b.wz * rbx;
  // 切向相对速度
  const vt = (rvx + cbx - cax) * tx + (rvy + cby - cay) * ty;

  // 法向冲量（等质量恢复系数公式，钳非负避免连续重叠帧反号）
  const jn = Math.max(0, -(1 + REST_BALL) * vn / (2 / BALL_M));
  // 切向冲量（粗糙球，库仑钳制）
  let jt = -vt / (2 / BALL_M + 2 * BALL_R * BALL_R / BALL_I);
  const maxT = MU_BALL_T * jn;
  if (jt > maxT) jt = maxT;
  if (jt < -maxT) jt = -maxT;

  const jnx = jn * nx, jny = jn * ny;
  const jtx = jt * tx, jty = jt * ty;
  a.vx -= (jnx + jtx) / BALL_M;
  a.vy -= (jny + jty) / BALL_M;
  b.vx += (jnx + jtx) / BALL_M;
  b.vy += (jny + jty) / BALL_M;

  // 角冲量 Δω = (r × J) / I，平面 r 与平面冲量的叉积只有 z 分量
  // a 受到 -(Jn+Jt)，作用点 r_a = R n
  const tajx = -(jnx + jtx), tajy = -(jny + jty);
  a.wz += (rax * tajy - ray * tajx) / BALL_I;
  b.wz += (rbx * (jnx + jtx) - rby * (jny + jty)) / BALL_I;

  if (a.state === 'rest') a.state = 'slide';
  if (b.state === 'rest') b.state = 'slide';
  return true;
}

// —— 球-库边碰撞 ——
function collideSegments(b, segments) {
  for (const s of segments) {
    // 点到线段最近点
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const l2 = ex * ex + ey * ey;
    let t = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / l2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = s.ax + t * ex;
    const cy = s.ay + t * ey;
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy);
    if (d >= BALL_R || d === 0) continue;

    // 已进入袋口开口的球不再被袋角弹回，交给捕获逻辑吞入
    if (s.jaw) {
      const pd = Math.hypot(b.x - s.pocket.x, b.y - s.pocket.y);
      if (pd < BALL_R * 2.1) continue;
    }

    // 几何法线取线段内法线；袋角漏斗的法线朝袋心（台面外），
    // 碰撞响应按几何法线，位置修正则始终把球推回台面一侧
    let nx = s.nx, ny = s.ny;
    if (dx * nx + dy * ny < 0) { nx = -nx; ny = -ny; }

    // 位置推出：沿「球心->最近点」方向把球送回可运动区域
    const pen = BALL_R - d;
    const pushX = dx / d, pushY = dy / d;
    b.x += pushX * pen;
    b.y += pushY * pen;

    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) continue; // 已在远离

    const tx = -ny, ty = nx;
    // 库边接触点在球侧面：r = R*n（水平面内）
    // 接触点速度 = v + ω×r，r=(R nx, R ny, 0)
    // ω×r 平面分量 = (-ωz*ry, ωz*rx)
    const ccx = -b.wz * BALL_R * ny;
    const ccy = b.wz * BALL_R * nx;
    const vt = (b.vx + ccx) * tx + (b.vy + ccy) * ty;

    // 法向冲量
    const jn = -(1 + REST_CUSHION) * vn * BALL_M;
    // 切向冲量：侧面接触点 r=R n 与切向 t 垂直，r×Jt 只有 z 分量，
    // 有效质量倒数 = 1/m + R²/I
    const invTang = 1 / BALL_M + BALL_R * BALL_R / BALL_I;
    let jt = -vt / invTang;
    const maxT = MU_CUSHION * jn;
    if (jt > maxT) jt = maxT;
    if (jt < -maxT) jt = -maxT;

    const jnx = jn * nx, jny = jn * ny;
    const jtx = jt * tx, jty = jt * ty;
    b.vx += (jnx + jtx) / BALL_M;
    b.vy += (jny + jty) / BALL_M;

    // 角冲量 Δω = (r × J) / I，r=(R nx, R ny, 0)，只有 z 分量
    b.wz += (BALL_R * nx * jty - BALL_R * ny * jtx) / BALL_I;

    if (b.state === 'rest') b.state = 'slide';
    else if (b.state === 'roll') b.state = 'slide'; // 碰库破坏纯滚动约束
  }
}

// 一个固定子步。返回本步入袋的球列表。
export function physicsStep(balls, table, dt = DT_FIXED) {
  const pocketed = [];

  // 1. 摩擦 + 位置积分
  for (const b of balls) {
    if (!b.active || b.state === 'sink') continue;
    integrateBall(b, dt);
  }

  // 2. 球-球碰撞（球数少，O(n²) 足够）
  const live = balls.filter(b => b.active && b.state !== 'sink');
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      collideBalls(live[i], live[j]);
    }
  }

  // 3. 库边
  for (const b of live) collideSegments(b, table.segments);

  // 4. 袋口捕获
  for (const b of live) {
    const p = checkPocketCapture(table, b);
    if (p) {
      b.state = 'sink';
      b.sinkT = 0;
      b.pocket = p;
      b.vx *= 0.2;
      b.vy *= 0.2;
      b.wx = 0; b.wy = 0; b.wz = 0;
      pocketed.push(b);
    }
  }

  // 5. 落袋动画推进
  for (const b of balls) {
    if (b.state === 'sink') {
      b.sinkT += dt;
      // 向袋心漂移
      b.x += (b.pocket.x - b.x) * Math.min(1, dt * 18);
      b.y += (b.pocket.y - b.y) * Math.min(1, dt * 18);
      if (b.sinkT > 0.18) {
        b.active = false;
        b.state = 'pocketed';   // 动画完成，等待对局层结算
        b.vx = 0; b.vy = 0;
      }
    }
  }

  return pocketed;
}

export function allStopped(balls) {
  return balls.every(b => !b.active || b.state === 'rest' || b.state === 'pocketed');
}

export function anySinking(balls) {
  return balls.some(b => b.state === 'sink');
}
