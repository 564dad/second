/* 验收脚本：node test/verify.js
 * 1) 同一 seed 连生成三次，三张图逐像素一致
 * 2) 板缝在高度图里是凹槽，法线图里能看到倾斜法线（凹沟而非黑线）
 * 3) 结疤不跨板缝：缝底像素不受结疤压暗影响
 * 4) 九宫格平铺无缝：接缝处梯度不超过内部梯度
 */
const WoodGen = require('../wood.js');

const P = {
  seed: 20260101, plankW: 128, plankL: 512, stagger: 0.5,
  rings: 6, distort: 0.4, knotProb: 1.0,   // 结疤概率拉满，压力测试
  colorVar: 0.5, gloss: 0.5, groove: 0.7
};

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  — ' + detail : ''));
  if (!ok) failures++;
}

// ---- 1) 确定性 ----
const runs = [0, 1, 2].map(() => WoodGen.generate(512, P));
for (const map of ['albedo', 'normal', 'roughness']) {
  const same01 = runs[0][map].every((v, i) => v === runs[1][map][i]);
  const same02 = runs[0][map].every((v, i) => v === runs[2][map][i]);
  check(`确定性：${map} 三次生成逐像素一致`, same01 && same02);
}

// ---- 2) 凹槽与法线 ----
const g = runs[0];
let minH = 1, maxH = 0;
for (let i = 0; i < g.height.length; i++) {
  if (g.height[i] < minH) minH = g.height[i];
  if (g.height[i] > maxH) maxH = g.height[i];
}
check('板缝是凹槽：高度图最低处 ≈ 0', minH < 0.05, `min=${minH.toFixed(3)} max=${maxH.toFixed(3)}`);

// 法线图中缝壁处应明显偏离平坦法线 (128,128,255)
let tilted = 0;
for (let i = 0; i < g.normal.length; i += 4) {
  const nx = g.normal[i], ny = g.normal[i + 1];
  if (Math.abs(nx - 128) > 12 || Math.abs(ny - 128) > 12) tilted++;
}
check('法线图可见凹沟（存在明显倾斜的法线）', tilted > 500, `倾斜像素 ${tilted} 个`);

// 缝底像素的法线 z 分量应恢复接近平坦（是"沟"，不是"台阶"）
// 同时缝两侧法线方向相反：沿水平缝找一对
let groovePairs = 0;
const S = 512;
for (let y = 2; y < S - 2 && groovePairs < 1; y++) {
  for (let x = 2; x < S - 2; x++) {
    const h = g.height[y * S + x];
    if (h < 0.05) { // 缝底
      const nl = g.normal[(y * S + x - 2) * 4];     // 左侧壁 nx
      const nr = g.normal[(y * S + x + 2) * 4];     // 右侧壁 nx
      if (Math.abs(nl - nr) > 10) groovePairs++;
    }
  }
}
check('凹槽两侧法线方向相反（沟的截面）', groovePairs > 0, `样本 ${groovePairs} 处`);

// ---- 3) 结疤不跨板缝 ----
// 像素检查：缝底（height≈0）处底色必须严格等于填缝色，不受结疤压暗影响
let gapPixels = 0, gapPure = 0;
for (let i = 0; i < S * S; i++) {
  if (g.height[i] < 0.01) {
    gapPixels++;
    const r = g.albedo[i * 4], gg = g.albedo[i * 4 + 1], b = g.albedo[i * 4 + 2];
    if (r === 46 && gg === 32 && b === 22) gapPure++;
  }
}
check('缝底像素不受结疤/木纹影响（纯填缝色）', gapPixels > 0 && gapPure === gapPixels,
  `${gapPure}/${gapPixels}`);

// ---- 4) 平铺无缝 ----
// 接缝处（右|左、下|上）的高度梯度不应超过任何内部相邻像素梯度
function maxGrad(arr, size) {
  let interior = 0, seam = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = arr[y * size + x];
      const hr = arr[y * size + (x + 1) % size];
      const hd = arr[((y + 1) % size) * size + x];
      const gx = Math.abs(hr - h), gy = Math.abs(hd - h);
      if (x === size - 1) { if (gx > seam) seam = gx; }
      else if (gx > interior) interior = gx;
      if (y === size - 1) { if (gy > seam) seam = gy; }
      else if (gy > interior) interior = gy;
    }
  }
  return { interior, seam };
}
const gg2 = maxGrad(g.height, S);
check('平铺无缝：接缝梯度 ≤ 内部梯度', gg2.seam <= gg2.interior + 1e-6,
  `seam=${gg2.seam.toFixed(4)} interior=${gg2.interior.toFixed(4)}`);

// 法线图同样检查（RGB 三通道）
const nrm = new Float32Array(S * S);
for (let i = 0; i < S * S; i++) {
  nrm[i] = (g.normal[i * 4] - 128) ** 2 + (g.normal[i * 4 + 1] - 128) ** 2;
}
const gn = maxGrad(nrm, S);
check('法线图平铺连续', gn.seam <= gn.interior + 1e-3,
  `seam=${gn.seam.toFixed(1)} interior=${gn.interior.toFixed(1)}`);

// ---- 5) 跨分辨率布局一致（512 与 1024 同 seed 同排版）----
const g1024 = WoodGen.generate(1024, P);
check('512/1024 排版一致（行数、列数、错缝）',
  g.layout.R === g1024.layout.R && g.layout.C === g1024.layout.C && g.layout.k === g1024.layout.k,
  `512: ${g.layout.R}×${g.layout.C} k=${g.layout.k}；1024: ${g1024.layout.R}×${g1024.layout.C} k=${g1024.layout.k}`);

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项未通过 ❌`);
process.exit(failures === 0 ? 0 : 1);
