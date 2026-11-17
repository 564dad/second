/*
 * wood.js — 程序化实木地板纹理生成核心（纯计算，无 DOM 依赖）
 *
 * 设计要点：
 * - 所有图案都在归一化坐标 [0,1) 上定义，分辨率无关；512 / 1024 只是采样率不同。
 * - 每块板的参数由 hash(seed, 行, 列) 推出，同一 seed 任意次生成逐像素一致。
 * - 错缝位移取 k/(R*C)（k 为整数），R 行之后累计位移恰为整数个板长，
 *   因此纹理在 X、Y 两个方向都严格周期为 1 —— 九宫格平铺无缝。
 * - 结疤按板生成，中心位置带安全边距，只影响所属板，绝不会跨板缝。
 * - 板缝是真实的高度凹槽（height map），法线由高度差分得到，缝在法线里是凹的。
 */
(function (global) {
  'use strict';

  // ---------- 确定性随机 ----------

  // 整数格点哈希 -> [0,1)，同一 (x,y,s) 永远得到同一值
  function ihash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  // 值噪声
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = ihash(xi, yi, s), b = ihash(xi + 1, yi, s);
    const c = ihash(xi, yi + 1, s), d = ihash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  // 分形噪声
  function fbm(x, y, s, oct) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * vnoise(x * f, y * f, s + i * 101);
      norm += amp;
      amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // HSL -> RGB，h∈[0,360), s,l∈[0,1]，返回 [r,g,b] 0..255
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    function f(t) {
      t = ((t % 1) + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
  }

  // ---------- 布局 ----------

  // 由用户参数推出确定性的排版（所有尺寸先归一化，保证跨分辨率一致）
  function makeLayout(p) {
    const R = Math.max(1, Math.round(1024 / p.plankW));      // 行数
    const C = Math.max(1, Math.round(1024 / p.plankL));      // 每行板数
    // 错缝：每行偏移 k/(R*C)，R 行累计 k/C = 整数个板长 => 纵向严格平铺
    const k = Math.round(clamp(p.stagger, 0, 1) * R);
    return { R, C, k, rowShift: k / (R * C) };
  }

  // 每块板的固有参数（底色抖动、粗糙度基准、年轮相位、结疤）
  function buildPlanks(p, lay) {
    const s0 = p.seed | 0;
    const planks = new Array(lay.R * lay.C);
    for (let r = 0; r < lay.R; r++) {
      for (let c = 0; c < lay.C; c++) {
        const j1 = ihash(c, r, s0);
        const j2 = ihash(c, r, s0 + 0x9E3779B9);
        const j3 = ihash(c, r, s0 + 0x3C6EF372);
        const j4 = ihash(c, r, s0 + 0x1B873593);
        const j5 = ihash(c, r, s0 + 0x51A7C4E5);

        // 结疤：按概率生成 1~2 个，中心限制在板内安全区，绝不靠近板缝
        const knots = [];
        if (j3 < p.knotProb) {
          const n = 1 + (j4 < 0.35 ? 1 : 0);
          for (let i = 0; i < n; i++) {
            const ks = s0 + 0x6D2B79F5 + i * 0x1F123BB5;
            knots.push({
              ku: 0.14 + 0.72 * ihash(c, r, ks),          // 沿板长，留边距
              kv: 0.32 + 0.36 * ihash(c, r, ks + 7),     // 沿板宽，留边距
              rad: 0.10 + 0.09 * ihash(c, r, ks + 13),    // 影响半径（板宽单位）
              str: 0.6 + 0.7 * ihash(c, r, ks + 29)       // 年轮汇聚强度
            });
          }
        }

        planks[r * lay.C + c] = {
          hue: 27 + (j2 - 0.5) * 16 * p.colorVar,          // 色相抖动（色差）
          lum: 0.40 + (j1 - 0.5) * 0.34 * p.colorVar,      // 明度抖动（色差）
          sat: 0.52 + (j5 - 0.5) * 0.10,
          rough: clamp(0.62 - p.gloss * 0.34 + (j4 - 0.5) * 0.20, 0.08, 0.95), // 每板光泽差异
          ringPhase: j2 * 7.13,                            // 年轮相位，板板不同
          knots
        };
      }
    }
    return planks;
  }

  // ---------- 主生成 ----------

  /**
   * 生成一套贴图。
   * @param size  边长（像素，正方形）
   * @param p     参数：{seed, plankW, plankL, stagger, rings, distort, knotProb, colorVar, gloss, groove}
   * @param onRow 可选进度回调 (doneRows, totalRows)
   * @return {height:Float32Array, albedo:Uint8ClampedArray, normal:Uint8ClampedArray, roughness:Uint8ClampedArray, layout}
   *         三个 RGBA 数组均可直接构造 ImageData。
   */
  function generate(size, p, onRow) {
    const lay = makeLayout(p);
    const planks = buildPlanks(p, lay);
    const n = size * size;
    const height = new Float32Array(n);
    const albedo = new Uint8ClampedArray(n * 4);
    const roughness = new Uint8ClampedArray(n * 4);
    const normal = new Uint8ClampedArray(n * 4);

    const lenPx = size / lay.C;   // 板长（像素）
    const widPx = size / lay.R;   // 板宽（像素）
    const gapHalf = Math.max(0.6, size * 0.002);  // 缝底半宽（平底，像素）
    const bevel = Math.max(1.2, size * 0.004);    // 缝壁倒角宽度（像素）
    const aspect = lenPx / widPx; // 结疤距离按板宽归一，保证结疤是圆的

    for (let y = 0; y < size; y++) {
      const ny = (y + 0.5) / size;
      let r = Math.floor(ny * lay.R); if (r >= lay.R) r = lay.R - 1;
      const v = ny * lay.R - r;                       // 板内横向坐标 0..1
      const shift = r * lay.rowShift;

      for (let x = 0; x < size; x++) {
        const nx = (x + 0.5) / size;
        let lx = nx + shift; lx -= Math.floor(lx);    // 行错缝后的环绕坐标
        let c = Math.floor(lx * lay.C); if (c >= lay.C) c = lay.C - 1;
        const u = lx * lay.C - c;                     // 板内纵向坐标 0..1

        const pd = planks[r * lay.C + c];
        const gseed = (p.seed + (r * lay.C + c) * 1013904223) | 0;

        // 到板边的距离（像素）-> 凹槽截面：平底 + 光滑缝壁
        const du = Math.min(u, 1 - u) * lenPx;
        const dv = Math.min(v, 1 - v) * widPx;
        const d = Math.min(du, dv);
        let hp = d <= gapHalf ? 0 : Math.min(1, (d - gapHalf) / bevel);
        hp = hp * hp * (3 - 2 * hp);

        // 年轮坐标：沿板宽分布 + 扭曲 + 长波起伏
        let t = v * p.rings + pd.ringPhase;
        t += (fbm(u * 2.5 + pd.ringPhase, v * 5, gseed, 3) - 0.5) * p.distort * 3.0;
        t += (vnoise(u * 1.2 + pd.ringPhase * 3, 0.7, gseed + 55) - 0.5) * p.distort * 1.5;

        // 结疤：年轮向疤心汇聚，疤心压暗
        let dark = 0;
        for (let i = 0; i < pd.knots.length; i++) {
          const kn = pd.knots[i];
          const dx = (u - kn.ku) * aspect, dy = v - kn.kv;
          const q = Math.sqrt(dx * dx + dy * dy);
          t += kn.str * 0.22 / (q + 0.10);
          dark += Math.exp(-(q * q) / (2 * kn.rad * kn.rad));
        }
        if (dark > 1) dark = 1;

        // 年轮明暗带 + 细纤维
        const band = Math.abs(Math.sin(Math.PI * t));         // 0 在年轮线上
        const fib = fbm(u * 6, v * 120, gseed + 7, 2);        // 沿板长拉丝的纤维
        const mottle = fbm(u * 3 + 9, v * 3, gseed + 23, 2);  // 大块深浅变化

        let lum = 1 - 0.30 * Math.pow(1 - band, 1.4);
        lum *= 0.94 + 0.12 * (fib - 0.5) * 2;
        lum *= 0.90 + 0.20 * mottle;
        lum *= 1 - 0.55 * dark;

        // 底色
        let rgb = hsl2rgb(pd.hue, pd.sat, clamp(pd.lum * lum, 0.04, 0.75));
        // 缝隙：混入深色填缝 + 凹槽 AO
        const gapMix = Math.pow(1 - hp, 0.7);
        const gapR = 46, gapG = 32, gapB = 22;
        const ao = 0.55 + 0.45 * hp;
        const idx = (y * size + x) * 4;
        albedo[idx]     = (rgb[0] * ao) * (1 - gapMix) + gapR * gapMix;
        albedo[idx + 1] = (rgb[1] * ao) * (1 - gapMix) + gapG * gapMix;
        albedo[idx + 2] = (rgb[2] * ao) * (1 - gapMix) + gapB * gapMix;
        albedo[idx + 3] = 255;

        // 高度：凹槽 + 微弱年轮起伏
        height[y * size + x] = hp * (0.93 + 0.07 * band);

        // 粗糙度：每板基准不同（光泽差异），晚材线略糙，缝里很糙
        let g = pd.rough + 0.10 * (1 - band) + 0.06 * (fib - 0.5);
        g = g * hp + 0.92 * (1 - hp);
        const gb = clamp(g, 0.05, 1) * 255;
        roughness[idx] = gb; roughness[idx + 1] = gb; roughness[idx + 2] = gb;
        roughness[idx + 3] = 255;
      }
      if (onRow) onRow(y + 1, size);
    }

    // 法线：高度场中心差分，边缘环绕采样（保证平铺后法线也连续）
    const strength = 2.5 * p.groove * (size / 512);
    for (let y = 0; y < size; y++) {
      const ym = (y - 1 + size) % size, yp = (y + 1) % size;
      for (let x = 0; x < size; x++) {
        const xm = (x - 1 + size) % size, xp = (x + 1) % size;
        const dx = (height[y * size + xp] - height[y * size + xm]) * 0.5 * strength;
        const dy = (height[yp * size + x] - height[ym * size + x]) * 0.5 * strength;
        const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
        const idx = (y * size + x) * 4;
        normal[idx]     = (-dx * inv * 0.5 + 0.5) * 255;
        normal[idx + 1] = (-dy * inv * 0.5 + 0.5) * 255;
        normal[idx + 2] = (inv * 0.5 + 0.5) * 255;
        normal[idx + 3] = 255;
      }
    }

    return { height, albedo, normal, roughness, layout: lay, size };
  }

  const WoodGen = { generate, makeLayout, ihash, hsl2rgb };
  if (typeof module !== 'undefined' && module.exports) module.exports = WoodGen;
  else global.WoodGen = WoodGen;
})(typeof window !== 'undefined' ? window : globalThis);
