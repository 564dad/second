// vec.js — 2D 向量与几何工具（纯函数，无 DOM 依赖，可在无头环境直接跑测试）

export const TAU = Math.PI * 2;

export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const len = (a) => Math.hypot(a.x, a.y);
export const lenSq = (a) => a.x * a.x + a.y * a.y;
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const distSq = (a, b) => {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const norm = (a) => {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
};
export const perp = (a) => ({ x: -a.y, y: a.x }); // 逆时针 90°
export const rotate = (a, ang) => ({
  x: a.x * Math.cos(ang) - a.y * Math.sin(ang),
  y: a.x * Math.sin(ang) + a.y * Math.cos(ang),
});
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const angleLerp = (a, b, t) => a + (b - a) * t;

/** 点到线段最近点，返回 { point, t }，t 为线段参数 [0,1] */
export function closestPointOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 < 1e-12) return { point: { ...a }, t: 0 };
  const t = clamp(dot(sub(p, a), ab) / l2, 0, 1);
  return { point: { x: a.x + ab.x * t, y: a.y + ab.y * t }, t };
}

/**
 * 扫掠圆 vs 线段（胶囊，半径 r）求最早碰撞时刻。
 * 圆从 c0 以速度 v 在 [0, dt] 内运动；线段 ab 可带自身运动（端点速度 va/vb）。
 * 返回 { hit, t, normal, point }，normal 指向球一侧（单位向量）。
 *
 * 正确性前提（由 physics.js 的子步划分保证）：本子步内球与线段的相对位移
 * 小于胶囊直径 2r，因此不可能“进入又穿出”。于是只需检测末端是否重叠，
 * 重叠则在 [0,dt] 二分求最早进入时刻 —— 高速下连续、无穿透，且每对象仅
 * 十几次距离评估（旧版 24 采样 + 28 次二分的 1/4 成本）。
 */
export function sweptCircleSegment(c0, r, v, dt, a0, b0, va = vec(), vb = vec()) {
  const a1 = add(a0, scale(va, dt));
  const b1 = add(b0, scale(vb, dt));

  const gapAt = (tt) => {
    const k = tt / dt;
    const a = { x: lerp(a0.x, a1.x, k), y: lerp(a0.y, a1.y, k) };
    const b = { x: lerp(b0.x, b1.x, k), y: lerp(b0.y, b1.y, k) };
    const c = add(c0, scale(v, tt));
    const { point } = closestPointOnSegment(c, a, b);
    const d = sub(c, point);
    return { gap: len(d) - r, d, point, c };
  };

  const g0 = gapAt(0);
  if (g0.gap <= 0) {
    // 已重叠（上一步残留），法向沿当前分离方向
    const n = len(g0.d) > 1e-9 ? norm(g0.d) : norm(sub(c0, a0));
    return { hit: true, t: 0, normal: n, point: g0.point };
  }
  const gE = gapAt(dt);
  if (gE.gap > 0) return { hit: false };

  // 二分求最早进入时刻（14 次 -> 精度 dt/16384）
  let lo = 0, hi = dt;
  for (let k = 0; k < 14; k++) {
    const mid = (lo + hi) * 0.5;
    if (gapAt(mid).gap <= 0) hi = mid; else lo = mid;
  }
  const t = hi;
  const info = gapAt(t);
  const normal = len(info.d) > 1e-9 ? norm(info.d) : norm(sub(info.c, info.point));
  return { hit: true, t, normal, point: info.point };
}

/** 扫掠圆 vs 静态圆（圆心 o，半径 ro），球半径 r，返回最早碰撞 */
export function sweptCircleCircle(c0, r, v, dt, o, ro) {
  const R = r + ro;
  // |c0 + v t - o|^2 = R^2
  const rel = sub(c0, o);
  const a = lenSq(v);
  if (a < 1e-12) {
    const d = len(rel);
    if (d <= R) {
      const n = d > 1e-9 ? norm(rel) : { x: 0, y: -1 };
      return { hit: true, t: 0, normal: n };
    }
    return { hit: false };
  }
  const b = 2 * dot(rel, v);
  const cc = lenSq(rel) - R * R;
  const disc = b * b - 4 * a * cc;
  if (disc < 0) return { hit: false };
  const sq = Math.sqrt(disc);
  const t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  let t = -1;
  if (t1 >= 0 && t1 <= dt) t = t1;
  else if (t2 >= 0 && t2 <= dt && cc <= 0) t = 0; // 已在内部
  if (t < 0) return { hit: false };
  const n = norm(add(rel, scale(v, t)));
  return { hit: true, t, normal: n };
}

/** 弹性反射：入射速度 v，单位法向 n（指向球），恢复系数 e，表面速度 sv，摩擦 f */
export function reflectVelocity(v, n, e, sv = vec(), friction = 0) {
  const vn = dot(v, n);
  const svn = dot(sv, n);
  const rel = sub(v, sv);
  const relN = dot(rel, n);
  if (relN >= 0 && vn > svn) return v; // 正在分离
  const tangent = perp(n);
  const vt = dot(rel, tangent);
  const newRelN = -e * relN;
  const newRelT = vt * (1 - friction);
  return add(sv, add(scale(n, newRelN), scale(tangent, newRelT)));
}
