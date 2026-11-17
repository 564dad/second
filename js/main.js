import { generateAtlases } from './marble.js';

const $ = (id) => document.getElementById(id);

const controls = {
  seed: $('seed'),
  density: $('density'),
  angle: $('angle'),
  warp: $('warp'),
  bandWidth: $('bandWidth'),
  normalStrength: $('normalStrength'),
  baseColor: $('baseColor'),
  veinColor: $('veinColor'),
  tileSize: $('tileSize'),
};

const PREVIEW_TILE = 256; // 预览用低分辨率，保证拖杆流畅
let generation = 0;       // 递增令牌：参数一变，旧任务自动放弃
let previewQueued = false;

function readParams() {
  return {
    seed: Number(controls.seed.value) || 0,
    density: Number(controls.density.value),
    angle: (Number(controls.angle.value) * Math.PI) / 180,
    warp: Number(controls.warp.value),
    bandWidth: Number(controls.bandWidth.value),
    normalStrength: Number(controls.normalStrength.value),
    baseColor: controls.baseColor.value,
    veinColor: controls.veinColor.value,
  };
}

function updateLabels() {
  $('densityVal').textContent = `${controls.density.value} 条`;
  $('angleVal').textContent = `${controls.angle.value}°`;
  $('warpVal').textContent = Number(controls.warp.value).toFixed(2);
  $('bandWidthVal').textContent = Number(controls.bandWidth.value).toFixed(2);
  $('normalStrengthVal').textContent = Number(controls.normalStrength.value).toFixed(1);
}

function setProgress(p) {
  const wrap = $('progressWrap');
  if (p === null) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  $('progressBar').style.width = `${Math.round(p * 100)}%`;
}

function drawAtlas(canvas, data, size) {
  const tmp = document.createElement('canvas');
  tmp.width = size;
  tmp.height = size;
  tmp.getContext('2d').putImageData(new ImageData(data, size, size), 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

async function runPreview() {
  const myGen = ++generation;
  const params = readParams();
  const result = await generateAtlases(
    params,
    PREVIEW_TILE,
    null,
    () => myGen !== generation // 参数已变 → 中断
  );
  if (!result || myGen !== generation) return; // 过期结果直接丢弃
  drawAtlas($('previewAlbedo'), result.albedo, result.size);
  drawAtlas($('previewNormal'), result.normal, result.size);
  drawAtlas($('previewRough'), result.roughness, result.size);
}

function schedulePreview() {
  updateLabels();
  generation++; // 立即使进行中的任务失效
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(() => {
    previewQueued = false;
    runPreview();
  });
}

// ---- 导出 ----

let downloadUrls = [];

function clearDownloads() {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  $('downloads').textContent = '';
}

function addDownload(canvas, filename, label) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      downloadUrls.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      const img = document.createElement('img');
      img.src = url;
      img.alt = label;
      a.appendChild(img);
      a.appendChild(document.createTextNode(label));
      $('downloads').appendChild(a);
      resolve();
    }, 'image/png');
  });
}

function atlasToCanvas(data, size) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  c.getContext('2d').putImageData(new ImageData(data, size, size), 0, 0);
  return c;
}

function sliceTile(atlasCanvas, tileSize, tx, ty) {
  const c = document.createElement('canvas');
  c.width = tileSize;
  c.height = tileSize;
  c.getContext('2d').drawImage(
    atlasCanvas,
    tx * tileSize, ty * tileSize, tileSize, tileSize,
    0, 0, tileSize, tileSize
  );
  return c;
}

async function exportAll() {
  const btn = $('exportBtn');
  btn.disabled = true;
  clearDownloads();
  setProgress(0);

  const myGen = ++generation; // 导出期间预览让路
  const params = readParams();
  const tileSize = Number(controls.tileSize.value);
  const seed = params.seed;

  try {
    const result = await generateAtlases(params, tileSize, setProgress, null);
    if (!result) return;

    const maps = [
      ['albedo', '底色', result.albedo],
      ['normal', '法线', result.normal],
      ['roughness', '粗糙度', result.roughness],
    ];
    const positions = [
      ['A1', 0, 0], ['A2', 1, 0],
      ['B1', 0, 1], ['B2', 1, 1],
    ];

    for (const [key, cnName, data] of maps) {
      const atlasCanvas = atlasToCanvas(data, result.size);
      // 2×2 图集
      await addDownload(
        atlasCanvas,
        `marble_${seed}_atlas2x2_${key}.png`,
        `图集 · ${cnName}`
      );
      // 四块单板的贴图三件套
      for (const [pos, tx, ty] of positions) {
        const tile = sliceTile(atlasCanvas, tileSize, tx, ty);
        await addDownload(
          tile,
          `marble_${seed}_${pos}_${key}.png`,
          `${pos} · ${cnName}`
        );
      }
    }
  } finally {
    setProgress(null);
    btn.disabled = false;
    schedulePreview(); // 恢复预览
  }
}

// ---- 事件 ----

for (const el of document.querySelectorAll('#controls input, #controls select')) {
  el.addEventListener('input', schedulePreview);
}

$('randomSeed').addEventListener('click', () => {
  controls.seed.value = Math.floor(Math.random() * 1e9);
  schedulePreview();
});

$('exportBtn').addEventListener('click', exportAll);

schedulePreview();
