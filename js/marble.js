// 大理石纹理核心：域扭曲（domain warping）。
// 一层低频 fBm 扰动去扭曲高频脉络的相位，脉络本身用正弦色带生成。
//
// 无缝原理：所有噪声都是“周期噪声”，周期 = 整张 2×2 图集；
// 脉络的线性相位项 kx*u + ky*v 取整数 kx/ky，使 sin 在图集边界同样闭合。
// 因此四块板是同一连续场上的四个不同区域：
//   - 拼缝处场是连续的 → 横缝竖缝都接得上；
//   - 区域不同 → 四块互不相同；
//   - 图集整体首尾闭合 → 图集自身也能无限平铺。

import { Noise2D } from './noise.js';

const WARP_PERIOD = 4;    // 低频扭曲场在整张图集内的晶格数（大尺度流动）
const DETAIL_PERIOD = 24; // 表面细微起伏
const LUM_PERIOD = 8;     // 底色明暗云斑

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 生成整张 2×2 图集的三张贴图。
 * @param {object} params
 *   seed        随机种子（整数）
 *   density     脉络密度：图集内脉络条数（整数 1..16）
 *   angle       脉络走向（弧度）
 *   warp        扭曲强度 0..3（连续，拖动无跳变）
 *   bandWidth   色带宽度 0.05..1（越大脉越宽）
 *   baseColor   底色 '#rrggbb'
 *   veinColor   脉色 '#rrggbb'
 *   normalStrength 法线强度 0..5
 * @param {number} tileSize 单块板的像素尺寸（图集为 2 倍）
 * @param {function} onProgress 0..1 进度回调
 * @param {function} shouldAbort 返回 true 时中断（用于参数已过期）
 * @returns {Promise<{size:number, albedo:Uint8ClampedArray, normal:Uint8ClampedArray, roughness:Uint8ClampedArray}>}
 */
export async function generateAtlases(params, tileSize, onProgress, shouldAbort) {
  const W = tileSize * 2;
  const N = W * W;
  const height = new Float32Array(N);
  const veinMask = new Float32Array(N);
  const albedo = new Uint8ClampedArray(N * 4);
  const roughness = new Uint8ClampedArray(N * 4);
  const normal = new Uint8ClampedArray(N * 4);

  const noise = new Noise2D(params.seed);
  const base = hexToRgb(params.baseColor);
  const vein = hexToRgb(params.veinColor);

  // 脉络相位：kx/ky 取整数保证图集边界闭合；密度即图集内的脉络条数
  let kx = Math.round(params.density * Math.cos(params.angle));
  let ky = Math.round(params.density * Math.sin(params.angle));
  if (kx === 0 && ky === 0) kx = 1;
  // 第二层细脉：走向错开、更密更细，模拟大理石的次级纹理
  const angle2 = params.angle + 0.9;
  let k2x = Math.round(params.density * 1.8 * Math.cos(angle2));
  let k2y = Math.round(params.density * 1.8 * Math.sin(angle2));
  if (k2x === 0 && k2y === 0) k2x = 1;

  // 色带半宽（t 单位），并保证过渡带至少覆盖约 1.2 个像素：
  // 脉络边缘在任何分辨率下都是解析平滑的，放大 300% 也看不到锯齿
  const warp = params.warp;
  const warpGrad = warp * 6;
  const ft = (Math.abs(kx) + Math.abs(ky) + warpGrad) / W; // t 的像素足迹
  const ft2 = (Math.abs(k2x) + Math.abs(k2y) + warpGrad) / W;
  const hw = Math.max(params.bandWidth * 0.16, ft * 1.2);
  const hw2 = Math.max(params.bandWidth * 0.07, ft2 * 1.2);

  const yieldEvery = 64; // 每 64 行让出一次主线程
  for (let y = 0; y < W; y++) {
    if (shouldAbort && shouldAbort()) return null;
    const v = y / W;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const i = y * W + x;

      // 第一层：低频扰动场（两个分量，用相位错开的同一场，省一次采样）
      const wx = noise.fbm(u * WARP_PERIOD, v * WARP_PERIOD, 3, WARP_PERIOD);
      const wy = noise.fbm(u * WARP_PERIOD + 5.2, v * WARP_PERIOD + 1.3, 3, WARP_PERIOD);

      // 第二层：被扭曲的高频脉络。
      // 用“到脉络中心的距离”生成剖面，配合像素足迹下限做解析抗锯齿
      const t = kx * u + ky * v + warp * (wx * 1.1 + wy * 0.7);
      const dist = Math.abs(t - Math.round(t)); // 0 = 脉络中心
      let prof = 1 - dist / hw;
      if (prof < 0) prof = 0;
      const m = prof * prof * prof * (prof * (prof * 6 - 15) + 10); // smootherstep

      // 次级细脉（权重较低，扭曲略强）
      const t2 = k2x * u + k2y * v + warp * (wy * 1.4 - wx * 0.8);
      const dist2 = Math.abs(t2 - Math.round(t2));
      let prof2 = 1 - dist2 / hw2;
      if (prof2 < 0) prof2 = 0;
      const m2 = prof2 * prof2 * (3 - 2 * prof2) * 0.55;

      const mComb = 1 - (1 - m) * (1 - m2); // 两层脉络并集
      veinMask[i] = mComb;

      // 表面细节与底色云斑
      const detail = noise.fbm(u * DETAIL_PERIOD, v * DETAIL_PERIOD, 3, DETAIL_PERIOD);
      const lum = noise.fbm(u * LUM_PERIOD + 9.1, v * LUM_PERIOD + 3.7, 2, LUM_PERIOD);

      // 高度场：脉络处下凹，叠加细微起伏（供法线用）
      height[i] = -mComb * 0.65 + detail * 0.3;

      // 底色
      const mix = mComb > 1 ? 1 : mComb;
      const lumMod = 1 + lum * 0.09;
      const o = i * 4;
      albedo[o] = (base[0] + (vein[0] - base[0]) * mix) * lumMod;
      albedo[o + 1] = (base[1] + (vein[1] - base[1]) * mix) * lumMod;
      albedo[o + 2] = (base[2] + (vein[2] - base[2]) * mix) * lumMod;
      albedo[o + 3] = 255;

      // 粗糙度：脉比底材略糙，加低频变化
      const r = 0.38 + 0.2 * mComb + detail * 0.1;
      const g = Math.max(0, Math.min(1, r)) * 255;
      roughness[o] = g;
      roughness[o + 1] = g;
      roughness[o + 2] = g;
      roughness[o + 3] = 255;
    }
    if (onProgress) onProgress((y + 1) / W * 0.7); // 高度/底色阶段占 70%
    if (y % yieldEvery === yieldEvery - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // 法线：对整张图集的高度场做中心差分，采样跨缝回绕，
  // 所以四块板边缘的法线与邻板严格连续，不会留下缝。
  const strength = params.normalStrength;
  for (let y = 0; y < W; y++) {
    if (shouldAbort && shouldAbort()) return null;
    const yUp = ((y - 1 + W) % W) * W;
    const yDn = ((y + 1) % W) * W;
    const yRow = y * W;
    for (let x = 0; x < W; x++) {
      const xl = (x - 1 + W) % W;
      const xr = (x + 1) % W;
      const dx = (height[yRow + xr] - height[yRow + xl]) * strength;
      const dy = (height[yDn + x] - height[yUp + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (yRow + x) * 4;
      normal[o] = (-dx * inv * 0.5 + 0.5) * 255;
      normal[o + 1] = (-dy * inv * 0.5 + 0.5) * 255;
      normal[o + 2] = (inv * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
    if (onProgress) onProgress(0.7 + (y + 1) / W * 0.3);
    if (y % yieldEvery === yieldEvery - 1) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return { size: W, albedo, normal, roughness };
}
