/* app.js — 界面逻辑：参数、预览、导出 */
(function () {
  'use strict';

  const PREVIEW_SIZE = 512;      // 页面内预览分辨率
  const EXPORT_SIZES = [512, 1024];
  const MAPS = ['albedo', 'normal', 'roughness'];
  const MAP_NAMES = { albedo: '底色', normal: '法线', roughness: '粗糙度' };

  const $ = id => document.getElementById(id);
  const PARAM_IDS = ['plankW', 'plankL', 'stagger', 'rings', 'distort',
                     'knotProb', 'colorVar', 'gloss', 'groove'];

  let currentMap = 'albedo';
  let result = null;             // 当前预览分辨率的生成结果
  let zoomed = false;
  let generating = false;

  function readParams() {
    const p = { seed: (parseInt($('seed').value, 10) || 0) | 0 };
    for (const id of PARAM_IDS) p[id] = parseFloat($(id).value);
    return p;
  }

  function fmt(id, v) {
    if (id === 'plankW' || id === 'plankL') return v + ' px';
    return (+v).toFixed(2).replace(/0$/, '');
  }

  function refreshOutputs() {
    for (const id of PARAM_IDS) $('o-' + id).textContent = fmt(id, $(id).value);
    // 错缝比例会被吸附到 1/行数 的整数倍，提示实际生效值
    const p = readParams();
    const lay = WoodGen.makeLayout(p);
    const eff = lay.R ? (lay.k / lay.R) : 0;
    $('o-stagger').textContent = p.stagger.toFixed(2) + ' → ' + eff.toFixed(3)
      + `（${lay.R} 行 × ${lay.C} 列）`;
  }

  function setStatus(msg, busy) {
    const el = $('status');
    el.textContent = msg;
    el.classList.toggle('busy', !!busy);
  }

  // 分块渲染，避免 1024 时卡死界面
  function generateAsync(size, p) {
    return new Promise((resolve, reject) => {
      const acc = {};
      let lastYield = 0;
      try {
        const res = WoodGen.generate(size, p, (done, total) => {
          acc.done = done; acc.total = total;
        });
        resolve(res);
      } catch (e) { reject(e); }
    });
  }

  async function regenerate() {
    if (generating) return;
    generating = true;
    setStatus('生成中…', true);
    // 让状态先绘制出来
    await new Promise(r => setTimeout(r, 16));
    const t0 = performance.now();
    try {
      result = await generateAsync(PREVIEW_SIZE, readParams());
      drawAll();
      setStatus(`完成，${PREVIEW_SIZE}×${PREVIEW_SIZE}，耗时 ${(performance.now() - t0).toFixed(0)} ms`);
    } catch (e) {
      setStatus('生成失败：' + e.message, false);
      console.error(e);
    }
    generating = false;
  }

  function putTo(canvas, rgba, size) {
    canvas.width = canvas.height = size;
    canvas.getContext('2d').putImageData(new ImageData(rgba, size, size), 0, 0);
  }

  // 把当前结果画到缩略图和九宫格
  function drawAll() {
    if (!result) return;
    const size = result.size;
    // 缩略图
    document.querySelectorAll('.thumbs figure').forEach(fig => {
      const map = fig.dataset.map;
      const cv = fig.querySelector('canvas');
      putTo(cv, result[map], size);
    });
    drawTileView();
  }

  function drawTileView() {
    if (!result) return;
    const size = result.size;
    const src = document.createElement('canvas');
    putTo(src, result[currentMap], size);

    const view = $('tileView');
    const tile = 256;
    view.width = view.height = tile * 3;
    const ctx = view.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let ty = 0; ty < 3; ty++)
      for (let tx = 0; tx < 3; tx++)
        ctx.drawImage(src, tx * tile, ty * tile, tile, tile);
    // 保持 CSS 尺寸与画布一致（100%），200% 由 zoom 控制
    view.style.width = view.style.height = (zoomed ? tile * 6 : tile * 3) + 'px';
  }

  // ---------- 导出 ----------

  function download(canvas, name) {
    return new Promise(resolve => {
      canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); resolve(); }, 400);
      }, 'image/png');
    });
  }

  async function exportAll() {
    if (generating) return;
    generating = true;
    const p = readParams();
    const canvas = document.createElement('canvas');
    for (const size of EXPORT_SIZES) {
      setStatus(`导出中：生成 ${size}×${size}…`, true);
      await new Promise(r => setTimeout(r, 16));
      const res = WoodGen.generate(size, p);
      for (const map of MAPS) {
        putTo(canvas, res[map], size);
        await download(canvas, `wood_${map}_${size}_seed${p.seed}.png`);
        setStatus(`导出中：wood_${map}_${size}_seed${p.seed}.png`, true);
      }
    }
    setStatus('导出完成：3 张 × 2 种尺寸');
    generating = false;
  }

  // ---------- 事件 ----------

  let debounce = 0;
  function scheduleRegen() {
    refreshOutputs();
    clearTimeout(debounce);
    debounce = setTimeout(regenerate, 250);
  }

  for (const id of PARAM_IDS) $(id).addEventListener('input', scheduleRegen);
  $('seed').addEventListener('input', scheduleRegen);
  $('dice').addEventListener('click', () => {
    $('seed').value = Math.floor(Math.random() * 2 ** 31);
    scheduleRegen();
  });
  $('regen').addEventListener('click', regenerate);
  $('export').addEventListener('click', exportAll);

  document.querySelectorAll('.thumbs figure').forEach(fig => {
    fig.addEventListener('click', () => {
      document.querySelectorAll('.thumbs figure').forEach(f => f.classList.remove('active'));
      fig.classList.add('active');
      currentMap = fig.dataset.map;
      $('mapName').textContent = MAP_NAMES[currentMap];
      drawTileView();
    });
  });

  $('zoom').addEventListener('click', () => {
    zoomed = !zoomed;
    $('zoom').textContent = zoomed ? '恢复 100%' : '放大 200%';
    drawTileView();
  });

  refreshOutputs();
  regenerate();
})();
