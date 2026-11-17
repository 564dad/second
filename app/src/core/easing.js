// 缓动函数与关键帧插值。纯函数。
export const EASINGS = {
  linear: (t) => t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export function applyEasing(name, t) {
  const fn = EASINGS[name] || EASINGS.easeOutCubic;
  return fn(Math.min(1, Math.max(0, t)));
}

const INTERP_PROPS = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fontSize'];

// 关键帧序列插值。keyframes: [{t, props:{...}, easing}]
export function interpolateKeyframes(keyframes, t) {
  if (!keyframes || keyframes.length === 0) return null;
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  if (t <= kfs[0].t) return { ...kfs[0].props };
  if (t >= kfs[kfs.length - 1].t) return { ...kfs[kfs.length - 1].props };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t || 1;
      const local = applyEasing(b.easing || a.easing || 'easeOutCubic', (t - a.t) / span);
      const out = {};
      for (const p of INTERP_PROPS) {
        const va = a.props[p];
        const vb = b.props[p];
        if (va === undefined && vb === undefined) continue;
        if (va === undefined) out[p] = vb;
        else if (vb === undefined) out[p] = va;
        else out[p] = va + (vb - va) * local;
      }
      return out;
    }
  }
  return null;
}

// 入场动画预设：返回局部进度 p∈[0,1] 下的附加状态
// 结果：{ offsetX, offsetY, scale, opacityFactor, visibleChars }
export function entranceState(entrance, localP, element, doc) {
  const base = { offsetX: 0, offsetY: 0, scale: 1, opacityFactor: 1, visibleChars: null };
  if (!entrance || entrance.type === 'none' || localP >= 1) return base;
  if (localP <= 0) {
    const start = { ...base, opacityFactor: 0 };
    if (entrance.type === 'slideUp') start.offsetY = doc.canvas.height * 0.12;
    if (entrance.type === 'slideLeft') start.offsetX = doc.canvas.width * 0.1;
    if (entrance.type === 'zoom') start.scale = 0.8;
    if (entrance.type === 'typewriter') { start.opacityFactor = 1; start.visibleChars = 0; }
    return start;
  }
  const p = applyEasing(entrance.easing || 'easeOutCubic', localP);
  switch (entrance.type) {
    case 'fade':
      return { ...base, opacityFactor: p };
    case 'slideUp':
      return { ...base, opacityFactor: p, offsetY: (1 - p) * doc.canvas.height * 0.12 };
    case 'slideLeft':
      return { ...base, opacityFactor: p, offsetX: (1 - p) * doc.canvas.width * 0.1 };
    case 'zoom':
      return { ...base, opacityFactor: p, scale: 0.8 + 0.2 * p };
    case 'typewriter': {
      const len = (element.text?.content || '').length;
      return { ...base, visibleChars: Math.max(0, Math.round(p * len)) };
    }
    default:
      return base;
  }
}
