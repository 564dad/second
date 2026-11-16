/*
 * app.js — UI、状态、渲染、导出。
 * 渲染管线（预览与导出共用，同一套代码）：
 *   源图 → 旋转（90° 步进 + 微调）→ 像素滤镜（Pipeline.applyFilter）→ 按选区裁切缩放
 */
(function () {
  'use strict';

  var P = window.Pipeline;
  var EXPORT_WIDTHS = [320, 640, 1280];
  var LS_KEY = 'poster-tool-state-v1';
  var UNDO_LIMIT = 50;
  var MIN_SEL = 10; // 选区最小边长（图像像素）

  // ---------- 样图 ----------

  var images = [];
  for (var i = 0; i < Samples.count; i++) {
    var sz = Samples.sizeAt(i);
    images.push({
      id: 'poster-' + (i + 1),
      index: i,
      src: Samples.draw(i),
      sw: sz.w,
      sh: sz.h
    });
  }

  // ---------- 状态 ----------

  function defaultState(img) {
    return {
      sel: { cx: img.sw / 2, cy: img.sh / 2, w: img.sw * 0.8, h: img.sh * 0.8 },
      ratio: 'free',
      rotSteps: 0,
      fine: 0,
      filters: { bri: 0, con: 0, sat: 0, tmp: 0 },
      zoom: 1,
      confirmed: false
    };
  }

  var states = {};       // id -> state
  var histories = {};    // id -> { undo: [], redo: [] }
  var currentId = images[0].id;

  function theta(st) { return st.rotSteps * 90 + st.fine; }
  function imgById(id) {
    for (var i = 0; i < images.length; i++) if (images[i].id === id) return images[i];
    return images[0];
  }
  function cur() { return states[currentId]; }
  function curImg() { return imgById(currentId); }
  function rotSize(img, st) { return P.rotatedSize(img.sw, img.sh, theta(st)); }

  function sanitize(img, st) {
    st.filters = st.filters || { bri: 0, con: 0, sat: 0, tmp: 0 };
    ['bri', 'con', 'sat', 'tmp'].forEach(function (k) {
      st.filters[k] = P.clamp(Number(st.filters[k]) || 0, -100, 100);
    });
    st.rotSteps = ((Math.round(st.rotSteps) || 0) % 4 + 4) % 4;
    st.fine = P.clamp(Number(st.fine) || 0, -15, 15);
    if (!P.RATIOS.hasOwnProperty(st.ratio)) st.ratio = 'free';
    st.zoom = P.clamp(Number(st.zoom) || 1, 0.25, 10);
    var r = rotSize(img, st);
    if (!st.sel || !isFinite(st.sel.cx)) st.sel = { cx: r.w / 2, cy: r.h / 2, w: r.w * 0.8, h: r.h * 0.8 };
    st.sel = P.clampSel(st.sel, r.w, r.h);
    st.confirmed = !!st.confirmed;
    return st;
  }

  function loadState() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* 损坏则忽略 */ }
    images.forEach(function (img) {
      var st = raw && raw.images && raw.images[img.id];
      states[img.id] = sanitize(img, st || defaultState(img));
      histories[img.id] = { undo: [], redo: [] };
    });
    if (raw && raw.currentId && states[raw.currentId]) currentId = raw.currentId;
  }

  var saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ currentId: currentId, images: states }));
      } catch (e) { /* 存储满等情况忽略 */ }
    }, 200);
  }

  // ---------- 撤销 ----------

  function snapshot(st) {
    return JSON.stringify({
      sel: st.sel, ratio: st.ratio, rotSteps: st.rotSteps,
      fine: st.fine, filters: st.filters, zoom: st.zoom
    });
  }

  function pushUndo() {
    var h = histories[currentId];
    h.undo.push(snapshot(cur()));
    if (h.undo.length > UNDO_LIMIT) h.undo.shift();
    h.redo.length = 0;
  }

  function applySnap(st, snap) {
    var o = JSON.parse(snap);
    st.sel = o.sel; st.ratio = o.ratio; st.rotSteps = o.rotSteps;
    st.fine = o.fine; st.filters = o.filters; st.zoom = o.zoom;
  }

  function undo() {
    var h = histories[currentId];
    if (!h.undo.length) return;
    h.redo.push(snapshot(cur()));
    applySnap(cur(), h.undo.pop());
    invalidateCache();
    refreshAll();
  }

  function redo() {
    var h = histories[currentId];
    if (!h.redo.length) return;
    h.undo.push(snapshot(cur()));
    applySnap(cur(), h.redo.pop());
    invalidateCache();
    refreshAll();
  }

  // ---------- 渲染缓存 ----------
  // 每张图缓存两个全尺寸离屏 canvas：旋转后未调色 / 旋转+调色。
  // 主视图、三档预览、导出全部从这两个缓存 drawImage，保证结果一致。

  var cache = {}; // id -> { rotKey, rotCanvas, filtKey, filtCanvas }

  function rotatedRawCanvas(img, st) {
    var c = cache[img.id] || (cache[img.id] = {});
    var key = st.rotSteps + '|' + st.fine;
    if (c.rotKey === key && c.rotCanvas) return c.rotCanvas;
    var r = rotSize(img, st);
    var cv = document.createElement('canvas');
    cv.width = r.w; cv.height = r.h;
    var ctx = cv.getContext('2d');
    ctx.translate(r.w / 2, r.h / 2);
    ctx.rotate(theta(st) * Math.PI / 180);
    ctx.drawImage(img.src, -img.sw / 2, -img.sh / 2);
    c.rotKey = key; c.rotCanvas = cv;
    c.filtKey = null; // 旋转变了，滤镜缓存一并失效
    return cv;
  }

  function filteredCanvas(img, st) {
    var raw = rotatedRawCanvas(img, st);
    var c = cache[img.id];
    var f = st.filters;
    var key = c.rotKey + '|' + f.bri + ',' + f.con + ',' + f.sat + ',' + f.tmp;
    if (c.filtKey === key && c.filtCanvas) return c.filtCanvas;
    var cv = document.createElement('canvas');
    cv.width = raw.width; cv.height = raw.height;
    var ctx = cv.getContext('2d');
    ctx.drawImage(raw, 0, 0);
    var idata = ctx.getImageData(0, 0, cv.width, cv.height);
    P.applyFilter(idata, f);
    ctx.putImageData(idata, 0, 0);
    c.filtKey = key; c.filtCanvas = cv;
    return cv;
  }

  function invalidateCache() { /* key 机制已保证正确性，这里仅留接口 */ }

  // 从「旋转+调色」后的全尺寸图上按选区裁出并缩放到目标宽度。
  // 主视图之外的所有输出（预览、导出）都走这一个函数。
  function renderCrop(img, st, targetW) {
    var r = rotSize(img, st);
    var rect = P.selToRect(st.sel, r.w, r.h);
    var outH = Math.max(1, Math.round(targetW * rect.h / rect.w));
    var cv = document.createElement('canvas');
    cv.width = targetW; cv.height = outH;
    var ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(filteredCanvas(img, st), rect.x, rect.y, rect.w, rect.h, 0, 0, targetW, outH);
    return cv;
  }

  // ---------- DOM ----------

  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage');
  var mainCanvas = $('main-canvas');
  var mainCtx = mainCanvas.getContext('2d');
  var pvCanvases = { 320: $('pv-320'), 640: $('pv-640'), 1280: $('pv-1280') };

  var showOriginal = false; // 按住空格看原图
  var fitScale = 1;

  function displayScale() { return fitScale * cur().zoom; }

  var lastLayoutKey = '';
  var mainDpr = 1;
  function layoutMainCanvas() {
    var st = cur(), img = curImg();
    var r = rotSize(img, st);
    var availW = Math.max(100, stage.clientWidth - 40);
    var availH = Math.max(100, stage.clientHeight - 40);
    fitScale = Math.min(availW / r.w, availH / r.h);
    var k = displayScale();
    var dpr = window.devicePixelRatio || 1;
    var cssW = Math.max(1, Math.round(r.w * k));
    var cssH = Math.max(1, Math.round(r.h * k));
    // 背存上限 8192，超出则降 dpr，避免超大 canvas 分配失败
    while ((cssW * dpr > 8192 || cssH * dpr > 8192) && dpr > 0.25) dpr /= 2;
    mainDpr = dpr;
    var key = cssW + 'x' + cssH + '@' + dpr;
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    mainCanvas.style.width = cssW + 'px';
    mainCanvas.style.height = cssH + 'px';
    mainCanvas.width = Math.round(cssW * dpr);
    mainCanvas.height = Math.round(cssH * dpr);
  }

  // ---------- 主视图 ----------

  var HANDLE = 5; // 手柄半径（CSS px）

  function selRectCss(st, r) {
    var k = displayScale();
    return {
      x: (st.sel.cx - st.sel.w / 2) * k,
      y: (st.sel.cy - st.sel.h / 2) * k,
      w: st.sel.w * k,
      h: st.sel.h * k
    };
  }

  function handlePositions(rc) {
    return {
      nw: [rc.x, rc.y], n: [rc.x + rc.w / 2, rc.y], ne: [rc.x + rc.w, rc.y],
      e: [rc.x + rc.w, rc.y + rc.h / 2],
      se: [rc.x + rc.w, rc.y + rc.h], s: [rc.x + rc.w / 2, rc.y + rc.h],
      sw: [rc.x, rc.y + rc.h], w: [rc.x, rc.y + rc.h / 2]
    };
  }

  function renderMain() {
    var st = cur(), img = curImg();
    var r = rotSize(img, st);
    var dpr = mainDpr;
    var k = displayScale();
    mainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var cssW = mainCanvas.width / dpr, cssH = mainCanvas.height / dpr;
    var src = showOriginal ? rotatedRawCanvas(img, st) : filteredCanvas(img, st);
    mainCtx.imageSmoothingEnabled = true;
    mainCtx.imageSmoothingQuality = 'high';
    mainCtx.clearRect(0, 0, cssW, cssH);
    mainCtx.drawImage(src, 0, 0, cssW, cssH);

    // 选区外压暗，选区内保持原亮
    var rc = selRectCss(st, r);
    mainCtx.fillStyle = 'rgba(0,0,0,0.55)';
    mainCtx.fillRect(0, 0, cssW, cssH);
    mainCtx.drawImage(src, rc.x / k, rc.y / k, rc.w / k, rc.h / k, rc.x, rc.y, rc.w, rc.h);

    // 边框
    mainCtx.strokeStyle = '#4f8cff';
    mainCtx.lineWidth = 1.5;
    mainCtx.strokeRect(rc.x, rc.y, rc.w, rc.h);

    // 手柄
    var hs = handlePositions(rc);
    mainCtx.fillStyle = '#ffffff';
    mainCtx.strokeStyle = '#4f8cff';
    for (var key in hs) {
      var p = hs[key];
      mainCtx.beginPath();
      mainCtx.rect(p[0] - HANDLE, p[1] - HANDLE, HANDLE * 2, HANDLE * 2);
      mainCtx.fill();
      mainCtx.stroke();
    }

    // 尺寸标注
    var rect = P.selToRect(st.sel, r.w, r.h);
    var label = rect.w + ' × ' + rect.h;
    mainCtx.font = '12px ui-monospace, monospace';
    var tw = mainCtx.measureText(label).width;
    var lx = P.clamp(rc.x, 2, cssW - tw - 12);
    var ly = rc.y > 22 ? rc.y - 8 : rc.y + rc.h + 18;
    mainCtx.fillStyle = 'rgba(0,0,0,0.7)';
    mainCtx.fillRect(lx - 4, ly - 14, tw + 10, 18);
    mainCtx.fillStyle = '#fff';
    mainCtx.fillText(label, lx, ly);

    if (showOriginal) {
      mainCtx.fillStyle = 'rgba(0,0,0,0.7)';
      mainCtx.fillRect(cssW - 76, 8, 68, 22);
      mainCtx.fillStyle = '#ffd166';
      mainCtx.fillText('原图预览', cssW - 70, 23);
    }
  }

  // ---------- 预览 ----------

  function renderPreviews() {
    var st = cur(), img = curImg();
    EXPORT_WIDTHS.forEach(function (W) {
      var out = renderCrop(img, st, W);
      var cv = pvCanvases[W];
      cv.width = out.width; cv.height = out.height;
      cv.getContext('2d').drawImage(out, 0, 0);
      $('pv-label-' + W).textContent = W + ' × ' + out.height;
    });
  }

  // ---------- 刷新调度（rAF，拖拽期间每帧最多渲染一次） ----------

  var dirty = true;
  function refresh() { dirty = true; }
  function refreshAll() {
    syncToolbar();
    syncSidebar();
    renderList();
    save();
    refresh();
  }

  function frame() {
    if (dirty) {
      dirty = false;
      layoutMainCanvas();
      renderMain();
      renderPreviews();
    }
    requestAnimationFrame(frame);
  }

  // ---------- 图片列表 ----------

  var listEl = $('imglist');

  function renderList() {
    listEl.innerHTML = '';
    images.forEach(function (img) {
      var st = states[img.id];
      var item = document.createElement('div');
      item.className = 'img-item' + (img.id === currentId ? ' active' : '') + (st.confirmed ? ' confirmed' : '');
      var c = document.createElement('canvas');
      c.width = 148; c.height = Math.round(148 * img.sh / img.sw);
      c.getContext('2d').drawImage(img.src, 0, 0, c.width, c.height);
      item.appendChild(c);
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<span>#' + (img.index + 1) + '</span><span>' + img.sw + '×' + img.sh + '</span>';
      item.appendChild(meta);
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '✓ 已确认';
      item.appendChild(badge);
      item.addEventListener('click', function () {
        if (currentId === img.id) return;
        currentId = img.id;
        refreshAll();
      });
      listEl.appendChild(item);
    });
  }

  // ---------- 工具栏 / 侧栏同步 ----------

  var RATIO_NAMES = ['free', '16:9', '4:3', '1:1', '3:4', '9:16'];
  var RATIO_LABELS = { free: '自由', '16:9': '16:9', '4:3': '4:3', '1:1': '1:1', '3:4': '3:4', '9:16': '9:16' };
  var ratioBtns = {};

  (function buildRatioBtns() {
    var box = $('ratio-btns');
    RATIO_NAMES.forEach(function (name) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = RATIO_LABELS[name];
      b.addEventListener('click', function () { setRatio(name); });
      box.appendChild(b);
      ratioBtns[name] = b;
    });
  })();

  var PRESET_DEFS = [
    ['original', '原图'], ['film', '胶片'], ['mono', '黑白'], ['contrast', '高对比']
  ];
  var presetBtns = {};

  (function buildPresetBtns() {
    var box = $('preset-btns');
    PRESET_DEFS.forEach(function (pd) {
      var b = document.createElement('button');
      b.className = 'btn';
      b.textContent = pd[1];
      b.addEventListener('click', function () {
        pushUndo();
        cur().filters = Object.assign({}, P.PRESETS[pd[0]]);
        refreshAll();
      });
      box.appendChild(b);
      presetBtns[pd[0]] = b;
    });
  })();

  function syncToolbar() {
    var st = cur();
    RATIO_NAMES.forEach(function (n) { ratioBtns[n].classList.toggle('active', st.ratio === n); });
    $('fine-slider').value = st.fine;
    $('angle-readout').textContent = (Math.round(theta(st) * 10) / 10) + '°';
    $('zoom-readout').textContent = Math.round(st.zoom * 100) + '%';
  }

  function syncSidebar() {
    var st = cur(), f = st.filters;
    $('sl-bri').value = f.bri; $('v-bri').textContent = f.bri;
    $('sl-con').value = f.con; $('v-con').textContent = f.con;
    $('sl-sat').value = f.sat; $('v-sat').textContent = f.sat;
    $('sl-tmp').value = f.tmp; $('v-tmp').textContent = f.tmp;
    PRESET_DEFS.forEach(function (pd) {
      var p = P.PRESETS[pd[0]];
      presetBtns[pd[0]].classList.toggle('active',
        f.bri === p.bri && f.con === p.con && f.sat === p.sat && f.tmp === p.tmp);
    });
    var cb = $('btn-confirm');
    cb.textContent = st.confirmed ? '✓ 已确认（点击取消）' : '标记为已确认';
    var n = images.filter(function (im) { return states[im.id].confirmed; }).length;
    $('btn-export').textContent = '导出已确认 (' + n + ')';
  }

  // ---------- 状态变更操作 ----------

  function setRatio(name) {
    var st = cur(), img = curImg();
    if (st.ratio === name) return;
    pushUndo();
    var r = rotSize(img, st);
    st.ratio = name;
    st.sel = P.applyRatio(st.sel, P.RATIOS[name], r.w, r.h);
    refreshAll();
  }

  // 旋转变化：选区跟着内容走（经源图坐标映射），锁比例时保持比例。
  // base 可选：手势期间从手势起点的选区重算，避免浮点漂移。
  function setRotation(steps, fine, base) {
    var st = cur(), img = curImg();
    var from = base || { sel: st.sel, rotSteps: st.rotSteps, fine: st.fine };
    var oldTheta = from.rotSteps * 90 + from.fine;
    var newTheta = steps * 90 + fine;
    var oldR = P.rotatedSize(img.sw, img.sh, oldTheta);
    var newR = P.rotatedSize(img.sw, img.sh, newTheta);
    st.sel = P.remapSelOnRotation(from.sel, oldR, newR, img.sw, img.sh, oldTheta, newTheta, P.RATIOS[st.ratio]);
    st.rotSteps = steps; st.fine = fine;
  }

  // ---------- 主画布交互 ----------

  var drag = null; // { mode, startX, startY, origSel, anchor }

  function canvasPos(e) {
    var b = mainCanvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  function hitHandle(pos, rc) {
    var hs = handlePositions(rc);
    for (var key in hs) {
      var p = hs[key];
      if (Math.abs(pos.x - p[0]) <= HANDLE + 3 && Math.abs(pos.y - p[1]) <= HANDLE + 3) return key;
    }
    return null;
  }

  var CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  mainCanvas.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    var st = cur();
    var r = rotSize(curImg(), st);
    var k = displayScale();
    var pos = canvasPos(e);
    var rc = selRectCss(st, r);
    var undoTop = histories[currentId].undo.length; // 快照前的栈深，用于 pointerup 时弹掉空手势
    pushUndo();
    var handle = hitHandle(pos, rc);
    if (handle) {
      drag = { mode: handle, origSel: Object.assign({}, st.sel), undoTop: undoTop };
    } else if (pos.x >= rc.x && pos.x <= rc.x + rc.w && pos.y >= rc.y && pos.y <= rc.y + rc.h) {
      drag = { mode: 'move', origSel: Object.assign({}, st.sel), undoTop: undoTop };
    } else {
      drag = { mode: 'new', anchor: { x: pos.x / k, y: pos.y / k }, undoTop: undoTop };
    }
    drag.startX = pos.x; drag.startY = pos.y;
    mainCanvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  // 角/边拖拽：ratio 锁定时按比例约束
  function resizeSel(mode, orig, dx, dy, ratio, r) {
    var x0 = orig.cx - orig.w / 2, y0 = orig.cy - orig.h / 2;
    var x1 = orig.cx + orig.w / 2, y1 = orig.cy + orig.h / 2;
    var cx = orig.cx, cy = orig.cy;

    function corner(fx, fy, px, py) {
      var w = Math.abs(px - fx), h = Math.abs(py - fy);
      if (ratio) {
        // 取主导方向，另一维按比例推
        if (w / ratio >= h) h = w / ratio; else w = h * ratio;
      }
      w = Math.max(w, MIN_SEL); h = Math.max(h, MIN_SEL);
      var nx0 = px >= fx ? fx : fx - w;
      var ny0 = py >= fy ? fy : fy - h;
      return { cx: nx0 + w / 2, cy: ny0 + h / 2, w: w, h: h };
    }
    function edge(fixed, isH, p) {
      // isH: 拖左右边（改宽）；否则改高。锁比例时另一维绕中心缩放。
      var w = orig.w, h = orig.h;
      if (isH) {
        w = Math.max(Math.abs(p - fixed), MIN_SEL);
        if (ratio) h = w / ratio;
      } else {
        h = Math.max(Math.abs(p - fixed), MIN_SEL);
        if (ratio) w = h * ratio;
      }
      var ncx = cx, ncy = cy;
      if (isH) ncx = (p >= fixed ? fixed + w / 2 : fixed - w / 2);
      else ncy = (p >= fixed ? fixed + h / 2 : fixed - h / 2);
      return { cx: ncx, cy: ncy, w: w, h: h };
    }

    switch (mode) {
      case 'nw': return corner(x1, y1, x0 + dx, y0 + dy);
      case 'ne': return corner(x0, y1, x1 + dx, y0 + dy);
      case 'sw': return corner(x1, y0, x0 + dx, y1 + dy);
      case 'se': return corner(x0, y0, x1 + dx, y1 + dy);
      case 'n': return edge(y1, false, y0 + dy);
      case 's': return edge(y0, false, y1 + dy);
      case 'w': return edge(x1, true, x0 + dx);
      case 'e': return edge(x0, true, x1 + dx);
    }
    return orig;
  }

  mainCanvas.addEventListener('pointermove', function (e) {
    var st = cur();
    var r = rotSize(curImg(), st);
    var k = displayScale();
    var pos = canvasPos(e);

    if (!drag) {
      // 悬停光标
      var rc0 = selRectCss(st, r);
      var h = hitHandle(pos, rc0);
      if (h) mainCanvas.style.cursor = CURSORS[h];
      else if (pos.x >= rc0.x && pos.x <= rc0.x + rc0.w && pos.y >= rc0.y && pos.y <= rc0.y + rc0.h) mainCanvas.style.cursor = 'move';
      else mainCanvas.style.cursor = 'crosshair';
      return;
    }

    var dx = (pos.x - drag.startX) / k;
    var dy = (pos.y - drag.startY) / k;
    var ratio = P.RATIOS[st.ratio];

    if (drag.mode === 'move') {
      st.sel = P.clampSel({
        cx: drag.origSel.cx + dx, cy: drag.origSel.cy + dy,
        w: drag.origSel.w, h: drag.origSel.h
      }, r.w, r.h);
    } else if (drag.mode === 'new') {
      var ax = drag.anchor.x, ay = drag.anchor.y;
      var px = pos.x / k, py = pos.y / k;
      var w = Math.abs(px - ax), h = Math.abs(py - ay);
      if (ratio) {
        if (w / ratio >= h) h = w / ratio; else w = h * ratio;
      }
      w = Math.max(w, MIN_SEL); h = Math.max(h, MIN_SEL);
      var nx = px >= ax ? ax : ax - w;
      var ny = py >= ay ? ay : ay - h;
      st.sel = P.clampSel({ cx: nx + w / 2, cy: ny + h / 2, w: w, h: h }, r.w, r.h);
    } else {
      st.sel = P.clampSel(resizeSel(drag.mode, drag.origSel, dx, dy, ratio, r), r.w, r.h);
    }
    refresh();
  });

  function endDrag() {
    if (!drag) return;
    // 没产生实际修改则把刚才的快照弹掉，避免空撤销步
    var h = histories[currentId];
    if (h.undo.length === drag.undoTop + 1 && h.undo[h.undo.length - 1] === snapshot(cur())) {
      h.undo.pop();
    }
    drag = null;
    refreshAll();
  }
  mainCanvas.addEventListener('pointerup', endDrag);
  mainCanvas.addEventListener('pointercancel', endDrag);

  mainCanvas.addEventListener('dblclick', function () {
    var st = cur();
    var r = rotSize(curImg(), st);
    pushUndo();
    st.sel = P.clampSel({ cx: r.w / 2, cy: r.h / 2, w: st.sel.w, h: st.sel.h }, r.w, r.h);
    refreshAll();
  });

  // 滚轮缩放
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var st = cur();
    st.zoom = P.clamp(st.zoom * Math.pow(1.1, -e.deltaY / 100), 0.25, 10);
    syncToolbar();
    save();
    refresh();
  }, { passive: false });

  // ---------- 工具栏事件 ----------

  $('btn-rot90').addEventListener('click', function () {
    var st = cur();
    pushUndo();
    setRotation((st.rotSteps + 1) % 4, st.fine);
    refreshAll();
  });

  var fineGesture = null; // 微调滑杆手势起点
  $('fine-slider').addEventListener('input', function () {
    var st = cur();
    if (!fineGesture) {
      pushUndo();
      fineGesture = { sel: Object.assign({}, st.sel), rotSteps: st.rotSteps, fine: st.fine };
    }
    setRotation(st.rotSteps, parseFloat(this.value), fineGesture);
    syncToolbar();
    refresh();
  });
  $('fine-slider').addEventListener('change', function () {
    fineGesture = null;
    refreshAll();
  });
  $('fine-slider').addEventListener('dblclick', function () {
    var st = cur();
    pushUndo();
    setRotation(st.rotSteps, 0);
    refreshAll();
  });

  $('btn-zoom-in').addEventListener('click', function () {
    var st = cur(); pushUndo();
    st.zoom = P.clamp(st.zoom * 1.25, 0.25, 10); refreshAll();
  });
  $('btn-zoom-out').addEventListener('click', function () {
    var st = cur(); pushUndo();
    st.zoom = P.clamp(st.zoom / 1.25, 0.25, 10); refreshAll();
  });
  $('btn-zoom-fit').addEventListener('click', function () {
    var st = cur(); pushUndo();
    st.zoom = 1; refreshAll();
  });

  // ---------- 调色滑杆 ----------

  var FILTER_KEYS = { 'sl-bri': 'bri', 'sl-con': 'con', 'sl-sat': 'sat', 'sl-tmp': 'tmp' };
  var filterGesture = false;

  Object.keys(FILTER_KEYS).forEach(function (id) {
    var el = $(id);
    var key = FILTER_KEYS[id];
    el.addEventListener('input', function () {
      if (!filterGesture) { pushUndo(); filterGesture = true; }
      cur().filters[key] = parseInt(el.value, 10);
      syncSidebar();
      refresh();
    });
    el.addEventListener('change', function () {
      filterGesture = false;
      refreshAll();
    });
  });

  // ---------- 确认 / 导出 / 重置 ----------

  $('btn-confirm').addEventListener('click', function () {
    cur().confirmed = !cur().confirmed;
    refreshAll();
  });

  $('btn-reset-all').addEventListener('click', function () {
    if (!window.confirm('确定要重置全部图片的裁切、旋转、调色参数吗？此操作不可撤销。')) return;
    images.forEach(function (img) {
      states[img.id] = defaultState(img);
      histories[img.id] = { undo: [], redo: [] };
    });
    try { localStorage.removeItem(LS_KEY); } catch (e) { }
    refreshAll();
  });

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function canvasToBlob(cv) {
    return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
  }

  var exporting = false;
  async function exportConfirmed() {
    if (exporting) return;
    var list = images.filter(function (im) { return states[im.id].confirmed; });
    if (!list.length) {
      window.alert('还没有已确认的图片。请先在右侧把要导出的图「标记为已确认」。');
      return;
    }
    exporting = true;
    $('btn-export').disabled = true;
    try {
      var manifest = { generatedAt: new Date().toISOString(), items: [] };
      for (var i = 0; i < list.length; i++) {
        var img = list[i];
        var st = states[img.id];
        var r = rotSize(img, st);
        var rect = P.selToRect(st.sel, r.w, r.h);
        var files = [];
        for (var j = 0; j < EXPORT_WIDTHS.length; j++) {
          var W = EXPORT_WIDTHS[j];
          var out = renderCrop(img, st, W);
          var name = 'poster-' + pad2(img.index + 1) + '-' + W + 'x' + out.height + '.png';
          downloadBlob(await canvasToBlob(out), name);
          files.push({ name: name, width: out.width, height: out.height });
          await new Promise(function (res) { setTimeout(res, 150); }); // 避免浏览器合并下载
        }
        manifest.items.push({
          id: img.id,
          index: img.index + 1,
          source: { width: img.sw, height: img.sh },
          rotation: { steps: st.rotSteps, fine: st.fine, totalDeg: theta(st) },
          ratio: st.ratio,
          selection: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, space: 'rotated' },
          filters: Object.assign({}, st.filters),
          files: files
        });
      }
      downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), 'manifest.json');
    } finally {
      exporting = false;
      $('btn-export').disabled = false;
    }
  }
  $('btn-export').addEventListener('click', exportConfirmed);

  // ---------- 键盘 ----------

  var lastArrowPush = 0;

  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    var inControl = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      var k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); return; }
    }
    if (inControl) return;

    if (e.code === 'Space') {
      if (!e.repeat) { showOriginal = true; refresh(); }
      e.preventDefault();
      return;
    }

    var moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    var mv = moves[e.key];
    if (mv) {
      e.preventDefault();
      var st = cur();
      var r = rotSize(curImg(), st);
      var step = e.shiftKey ? 10 : 1;
      var now = Date.now();
      if (now - lastArrowPush > 600) pushUndo(); // 连续按方向键合并为一步撤销
      lastArrowPush = now;
      st.sel = P.clampSel({
        cx: st.sel.cx + mv[0] * step, cy: st.sel.cy + mv[1] * step,
        w: st.sel.w, h: st.sel.h
      }, r.w, r.h);
      save();
      refresh();
    }
  });

  window.addEventListener('keyup', function (e) {
    if (e.code === 'Space') { showOriginal = false; refresh(); }
  });

  // 按钮点击后失焦，避免空格/方向键被按钮焦点吃掉
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('button') : null;
    if (b) b.blur();
  });

  // ---------- 启动 ----------

  window.addEventListener('resize', refresh);
  if (window.ResizeObserver) new ResizeObserver(refresh).observe(stage);

  loadState();
  refreshAll();
  requestAnimationFrame(frame);

  // 暴露给自动化验收脚本（不影响正常使用）
  window.__app = {
    images: images,
    states: states,
    get currentId() { return currentId; },
    set currentId(v) { currentId = v; refreshAll(); },
    rotSize: rotSize,
    renderCrop: renderCrop,
    exportConfirmed: exportConfirmed,
    refreshAll: refreshAll,
    Pipeline: P
  };
})();
