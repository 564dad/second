// 带种子的二维周期 Perlin 噪声。
// 周期性靠“晶格坐标对周期取模”实现：period 为整数时，
// noise(x, y) === noise(x + period, y)，因此整张图集可以无缝首尾相接。

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRADIENTS = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

// 五次缓和曲线，保证一阶连续，放大后看不到格子
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class Noise2D {
  constructor(seed) {
    const rand = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  gradient(ix, iy) {
    return GRADIENTS[this.perm[(this.perm[ix & 255] + iy) & 255] & 7];
  }

  // 周期 Perlin 噪声，x/y 以晶格为单位，period 为整数晶格周期
  pnoise(x, y, period) {
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);
    const wrap = (v) => ((Math.floor(v) % period) + period) % period;
    const x0 = wrap(x);
    const y0 = wrap(y);
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;

    const u = fade(fx);
    const v = fade(fy);

    const g00 = this.gradient(x0, y0);
    const g10 = this.gradient(x1, y0);
    const g01 = this.gradient(x0, y1);
    const g11 = this.gradient(x1, y1);

    const n00 = g00[0] * fx + g00[1] * fy;
    const n10 = g10[0] * (fx - 1) + g10[1] * fy;
    const n01 = g01[0] * fx + g01[1] * (fy - 1);
    const n11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);

    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v); // 约 [-0.7, 0.7]
  }

  // 分形叠加。每倍频程频率翻倍、周期也翻倍，整体保持 period 周期。
  fbm(x, y, octaves, period) {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let freq = 1;
    let per = period;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.pnoise(x * freq, y * freq, per);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
      per *= 2;
    }
    return sum / norm;
  }
}
