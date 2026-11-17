// 通用工具：ID、克隆、数值。纯函数，无 DOM 依赖。
export function uid(prefix = 'el') {
  const n = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return `${prefix}_${Date.now().toString(36)}_${n}`;
}

export function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function round(v, d = 2) {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

export function deg2rad(d) {
  return (d * Math.PI) / 180;
}

// 点绕中心旋转
export function rotatePoint(px, py, cx, cy, deg) {
  const r = deg2rad(deg);
  const s = Math.sin(r);
  const c = Math.cos(r);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

// 矩形（含旋转）的轴对齐外接框
export function boundingBox(rect) {
  const { x, y, width: w, height: h, rotation = 0 } = rect;
  if (!rotation) return { x, y, width: w, height: h };
  const cx = x + w / 2;
  const cy = y + h / 2;
  const pts = [
    rotatePoint(x, y, cx, cy, rotation),
    rotatePoint(x + w, y, cx, cy, rotation),
    rotatePoint(x + w, y + h, cx, cy, rotation),
    rotatePoint(x, y + h, cx, cy, rotation),
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

export function inflateRect(r, pad) {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

export function rectContainsPoint(r, px, py, tolerance = 0) {
  return px >= r.x - tolerance && px <= r.x + r.width + tolerance &&
         py >= r.y - tolerance && py <= r.y + r.height + tolerance;
}

// 矩形是否完全在外框内（允许 tolerance 像素溢出，0 为严格）
export function rectInside(inner, outer, tolerance = 0) {
  return inner.x >= outer.x - tolerance &&
         inner.y >= outer.y - tolerance &&
         inner.x + inner.width <= outer.x + outer.width + tolerance &&
         inner.y + inner.height <= outer.y + outer.height + tolerance;
}

// cover / contain 适配
export function fitRect(srcW, srcH, boxW, boxH, mode = 'contain') {
  const scale = mode === 'cover'
    ? Math.max(boxW / srcW, boxH / srcH)
    : mode === 'fill'
      ? 1
      : Math.min(boxW / srcW, boxH / srcH);
  const w = mode === 'fill' ? boxW : srcW * scale;
  const h = mode === 'fill' ? boxH : srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, width: w, height: h };
}
