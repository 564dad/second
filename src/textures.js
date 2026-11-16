// 程序化纹理：台呢布纹、库边木纹、球面高光。零图片素材。
import { BALL_R, BALL_COLORS } from './constants.js';

// 可复现的伪随机（让每次刷新纹理一致）
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 台呢：经纬线 + 短纤维噪点 + 中心略亮的使用痕迹 ——
export function makeClothTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rand = mulberry32(42);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 两组正弦模拟经纬编织
      const warp = Math.sin(x * 0.9) * 5 + Math.sin(x * 0.23) * 3;
      const weft = Math.sin(y * 1.05) * 5 + Math.sin(y * 0.19) * 3;
      const fiber = (rand() - 0.5) * 14;
      // 对角线方向的轻微擀呢方向感
      const nap = Math.sin((x + y) * 0.04) * 4;
      const v = warp + weft + fiber + nap;
      img.data[i] = Math.max(0, Math.min(255, 18 + v * 0.5));
      img.data[i + 1] = Math.max(0, Math.min(255, 92 + v));
      img.data[i + 2] = Math.max(0, Math.min(255, 62 + v * 0.7));
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 少量更长的纤维丝
  ctx.globalAlpha = 0.10;
  ctx.strokeStyle = '#9fd9b0';
  for (let k = 0; k < 260; k++) {
    const x = rand() * size, y = rand() * size;
    const ang = (rand() - 0.5) * 0.6;
    const l = 8 + rand() * 26;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * l, y + Math.sin(ang) * l);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return c;
}

// —— 木纹：底色渐变 + 纵向木纹波纹 + 木节 ——
export function makeWoodTexture(w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const rand = mulberry32(7);

  const base = ctx.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, '#6b3f22');
  base.addColorStop(0.5, '#57301a');
  base.addColorStop(1, '#43240f');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // 木纹线：多条叠加正弦
  for (let k = 0; k < 34; k++) {
    const y0 = (k / 34) * h + rand() * 8;
    const amp = 2 + rand() * 5;
    const f1 = 0.012 + rand() * 0.02;
    const f2 = 0.05 + rand() * 0.04;
    const phase = rand() * Math.PI * 2;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(38,18,7,0.35)' : 'rgba(150,96,52,0.22)';
    ctx.lineWidth = 0.8 + rand() * 1.6;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 6) {
      const y = y0 + Math.sin(x * f1 + phase) * amp + Math.sin(x * f2 + phase * 2) * amp * 0.4;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // 木节
  for (let k = 0; k < 4; k++) {
    const kx = rand() * w, ky = rand() * h;
    const rr = 8 + rand() * 14;
    for (let ring = 5; ring > 0; ring--) {
      ctx.strokeStyle = `rgba(40,20,8,${0.12 + ring * 0.05})`;
      ctx.beginPath();
      ctx.ellipse(kx, ky, rr * ring * 0.42, rr * ring * 0.22, rand() * 0.8, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // 漆面光泽
  const gloss = ctx.createLinearGradient(0, 0, 0, h);
  gloss.addColorStop(0, 'rgba(255,230,190,0.16)');
  gloss.addColorStop(0.35, 'rgba(255,230,190,0.03)');
  gloss.addColorStop(1, 'rgba(0,0,0,0.18)');
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, w, h);
  return c;
}

// —— 球精灵：径向渐变球体 + 高光 + 号码/条纹 ——
function drawBallBase(ctx, r, color, stripe) {
  // 底色（条纹球先铺白）
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  if (stripe) {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.75, '#e8e8e3');
    g.addColorStop(1, '#b9b9b2');
  } else {
    g.addColorStop(0, shade(color, 0.55));
    g.addColorStop(0.55, color);
    g.addColorStop(1, shade(color, -0.45));
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // 条纹球的色带
  if (stripe) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    const band = ctx.createLinearGradient(0, -r * 0.55, 0, r * 0.55);
    band.addColorStop(0, shade(color, -0.2));
    band.addColorStop(0.5, color);
    band.addColorStop(1, shade(color, -0.25));
    ctx.fillStyle = band;
    ctx.fillRect(-r, -r * 0.5, r * 2, r);
    ctx.restore();
  }
}

function drawNumberDisc(ctx, r, num) {
  const dr = r * 0.42;
  const g = ctx.createRadialGradient(-dr * 0.2, -dr * 0.25, dr * 0.1, 0, 0, dr);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(1, '#d9d9d2');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, dr, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1a1a1a';
  ctx.font = `bold ${Math.round(dr * 1.15)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 0, dr * 0.08);
}

function drawHighlights(ctx, r) {
  // 主高光（左上柔光）
  const h = ctx.createRadialGradient(-r * 0.38, -r * 0.45, 0, -r * 0.38, -r * 0.45, r * 0.75);
  h.addColorStop(0, 'rgba(255,255,255,0.55)');
  h.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = h;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  // 小而锐的灯点
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.ellipse(-r * 0.42, -r * 0.5, r * 0.13, r * 0.09, -0.5, 0, Math.PI * 2);
  ctx.fill();
  // 边缘压暗，增强球感
  const edge = ctx.createRadialGradient(0, 0, r * 0.62, 0, 0, r);
  edge.addColorStop(0, 'rgba(0,0,0,0)');
  edge.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = edge;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
}

export function makeBallSprite(num, pxRadius = 64) {
  const r = pxRadius;
  const c = document.createElement('canvas');
  c.width = c.height = r * 2 + 4;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);

  if (num === 0) {
    // 母球：暖白 + 一个小红点（方便看见转动）
    drawBallBase(ctx, r, '#f4f1e8', false);
    ctx.fillStyle = 'rgba(190,40,36,0.85)';
    ctx.beginPath();
    ctx.arc(r * 0.42, -r * 0.18, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
    drawHighlights(ctx, r);
    return c;
  }
  const stripe = num > 8;
  drawBallBase(ctx, r, BALL_COLORS[num], stripe);
  drawNumberDisc(ctx, r, num);
  drawHighlights(ctx, r);
  return c;
}

// 接触阴影（柔边椭圆）
export function makeShadowSprite(pxRadius = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = pxRadius * 2 + 8;
  const ctx = c.getContext('2d');
  const r = pxRadius;
  const g = ctx.createRadialGradient(0, 0, r * 0.2, 0, 0, r);
  g.addColorStop(0, 'rgba(0,0,0,0.42)');
  g.addColorStop(0.7, 'rgba(0,0,0,0.18)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(c.width / 2, c.height / 2, r * 1.05, r * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt;
  } else {
    r *= 1 + amt; g *= 1 + amt; b *= 1 + amt;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export const BALL_METERS_RADIUS = BALL_R;
