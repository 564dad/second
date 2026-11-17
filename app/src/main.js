// 主控制器：状态、撤销栈、UI 绑定、导出校验、自动保存。
import { createDefaultCase, createEdgeCase, migrateDocument } from './core/document.js';
import { History } from './core/history.js';
import { instantiateTemplate, carryText, reflowForResize } from './core/templates.js';
import { computeScene } from './core/render-scene.js';
import { validateDocument, autoRepair } from './core/safe-area.js';
import { measureSummary, autofitFontSize, MIN_FONT_SIZE } from './core/text.js';
import { serializeProject, parseProject, serializeTemplate, serializeFrame, documentFromTemplate } from './core/serialize.js';
import { buildSVG } from './core/svg.js';
import { CanvasRenderer } from './browser/canvas-renderer.js';
import { Overlay } from './browser/overlay.js';
import { Metronome } from './browser/audio.js';
import { registerFont, restoreFonts, addImage } from './browser/assets.js';
import { storage, download, downloadDataURL } from './browser/storage.js';
import { initToast, toast, showModal, issuesHTML } from './browser/dialogs.js';
import { deepClone } from './core/util.js';

class App {
  constructor() {
    this.doc = createDefaultCase();
    this.history = new History(this.doc);
    this.selectedId = null;
    this.time = this.doc.duration; // 当前预览时间（秒），默认终态
    this.zoom = 1;
    this.playing = false;
    this.rafId = null;
    this.playStart = 0;
    this.autoSave = false;
    this.metro = new Metronome();
    this.metroEnabled = false;
    this.measureFn = null;
    this._snapshot = null;
  }

  init() {
    initToast(document.getElementById('toast-wrap'));
    const canvas = document.getElementById('canvas');
    const measure = document.createElement('canvas');
    this.renderer = new CanvasRenderer(canvas, measure);
    this.measureFn = (font, text) => this.renderer.measure(font, text);
    this.canvasEl = canvas;

    this.overlay = new Overlay(canvas, document.getElementById('overlay'), {
      getDoc: () => this.doc,
      getTime: () => this.time,
      getZoom: () => this.zoom,
      getSelectedId: () => this.selectedId,
      select: (id) => this.select(id),
      preview: () => this.render(),
      commit: () => this.commit(),
    });

    this.#bindTopbar();
    this.#bindStage();
    this.#bindPanels();
    this.#bindKeyboard();
    this.#bindMetronome();

    this.history.onChange = (canUndo, canRedo) => this.#updateHistoryButtons(canUndo, canRedo);
    this.select(this.doc.elements[2]?.id || this.doc.elements[0]?.id);
    this.#applyCanvasSize();
    this.render();
    this.#refreshElementList();
    this.#updateHistoryButtons(false, false);

    // 启动时尝试恢复自动保存
    const saved = storage.load();
    if (saved?.doc) {
      toast('检测到上次的自动保存工程，可点「重新载入」或手动恢复', 'warn', null, '自动保存');
    }
  }

  // ---------- 渲染 ----------
  render() {
    const scene = computeScene(this.doc, this.time, this.measureFn);
    this.renderer.render(this.doc, scene, {
      dpr: 1,
      showSafe: document.getElementById('show-safe').checked,
      showGrid: document.getElementById('show-grid').checked,
      selectionId: this.selectedId,
    });
    this.overlay.update(this.doc, this.time, this.selectedId);
    this.#updateStatus();
    this.#syncPanelValues();
  }

  #updateStatus(extra = '') {
    const issues = validateDocument(this.doc, this.time, (el) => measureSummary(el, this.doc, this.measureFn, this.time));
    const errs = issues.filter((i) => i.level === 'error').length;
    const warns = issues.filter((i) => i.level === 'warn').length;
    const bar = document.getElementById('statusbar');
    bar.innerHTML = extra
      ? extra
      : `画布 ${this.doc.canvas.width}×${this.doc.canvas.height} · 元素 ${this.doc.elements.length} · ` +
        `<span class="${errs ? 'err' : warns ? 'warn' : 'ok'}">校验：${errs ? `${errs} 错误 / ` : ''}${warns} 警告${!errs && !warns ? '，全部通过' : ''}</span> · t=${this.time.toFixed(2)}s`;
    return issues;
  }

  // ---------- 撤销 ----------
  beginEdit() {
    this._snapshot = deepClone(this.doc);
  }
  commit(message = '编辑') {
    if (this._snapshot) {
      this.history.push(this.doc);
      this._snapshot = null;
    } else {
      this.history.push(this.doc);
    }
    this.#afterChange(message);
  }
  undo() {
    const d = this.history.undo();
    if (d) { this.doc = d; this.#afterChange('撤销', true); toast('已撤销', 'ok'); }
  }
  redo() {
    const d = this.history.redo();
    if (d) { this.doc = d; this.#afterChange('重做', true); toast('已重做', 'ok'); }
  }
  #updateHistoryButtons(canUndo, canRedo) {
    document.getElementById('btn-undo').disabled = !canUndo;
    document.getElementById('btn-redo').disabled = !canRedo;
  }
  #afterChange(_msg, keepSelection = false) {
    if (!keepSelection && !this.doc.elements.find((e) => e.id === this.selectedId)) {
      this.selectedId = this.doc.elements[0]?.id || null;
    }
    this.#applyCanvasSize();
    this.#refreshElementList();
    this.render();
    this.#refreshKeyframeEditor();
    if (this.autoSave) this.#autoSaveQuiet();
  }

  // ---------- 模板 ----------
  switchTemplate(tplId) {
    const elements = instantiateTemplate(tplId, this.doc.canvas.width, this.doc.canvas.height);
    carryText(this.doc.elements, elements); // 切换不丢文本
    this.beginEdit();
    this.doc.templateId = tplId;
    this.doc.elements = elements;
    this.commit(`切换到${tplId}模板`);
    this.select(elements.find((e) => e.type === 'text')?.id || elements[0]?.id);
    toast(`已切换到「${tplId}」模板，文本已保留`, 'ok');
  }

  // ---------- 选择与列表 ----------
  select(id) {
    this.selectedId = id;
    this.#refreshElementList();
    this.#syncPanelValues();
    this.#refreshKeyframeEditor();
    this.render();
  }
  get selected() {
    return this.doc.elements.find((e) => e.id === this.selectedId) || null;
  }
  #refreshElementList() {
    const ul = document.getElementById('element-list');
    ul.innerHTML = '';
    this.doc.elements.forEach((el, idx) => {
      const li = document.createElement('li');
      if (el.id === this.selectedId) li.className = 'sel';
      const typeLabel = el.type === 'text' ? '文字' : el.shape.shapeType === 'ellipse' ? '椭圆' : '图形';
      li.innerHTML = `<span class="el-type">[${typeLabel}]</span><span class="el-name"></span>`;
      li.querySelector('.el-name').textContent = el.name;
      li.onclick = () => this.select(el.id);
      const up = document.createElement('button');
      up.className = 'mini'; up.textContent = '↑';
      up.title = '上移一层';
      up.onclick = (e) => { e.stopPropagation(); this.#reorder(idx, idx - 1); };
      const down = document.createElement('button');
      down.className = 'mini'; down.textContent = '↓';
      down.title = '下移一层';
      down.onclick = (e) => { e.stopPropagation(); this.#reorder(idx, idx + 1); };
      const lock = document.createElement('button');
      lock.className = 'mini'; lock.textContent = el.locked ? '🔒' : '🔓';
      lock.onclick = (e) => { e.stopPropagation(); this.beginEdit(); el.locked = !el.locked; this.commit('锁定切换'); };
      const del = document.createElement('button');
      del.className = 'mini danger'; del.textContent = '删';
      del.onclick = (e) => { e.stopPropagation(); this.#deleteElement(el.id); };
      li.append(up, down, lock, del);
      ul.appendChild(li);
    });
  }
  #reorder(from, to) {
    if (to < 0 || to >= this.doc.elements.length) return;
    this.beginEdit();
    const [it] = this.doc.elements.splice(from, 1);
    this.doc.elements.splice(to, 0, it);
    this.commit('调整层级');
  }
  #deleteElement(id) {
    this.beginEdit();
    this.doc.elements = this.doc.elements.filter((e) => e.id !== id);
    if (this.selectedId === id) this.selectedId = this.doc.elements[0]?.id || null;
    this.commit('删除元素');
  }

  // ---------- 右侧属性面板 ----------
  #bindPanels() {
    const $ = (id) => document.getElementById(id);
    const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

    // 文本属性
    on('tp-text', 'focus', () => this.beginEdit());
    on('tp-text', 'input', () => { const el = this.selected; if (el) { el.text.content = $('tp-text').value; this.render(); } });
    on('tp-text', 'change', () => this.commit('修改文本'));
    on('tp-size', 'focus', () => this.beginEdit());
    on('tp-size', 'input', () => { const el = this.selected; if (el) { el.text.fontSize = Number($('tp-size').value) || MIN_FONT_SIZE; this.render(); } });
    on('tp-size', 'change', () => this.commit('调整字号'));
    on('tp-color', 'input', () => { const el = this.selected; if (el) { el.text.color = $('tp-color').value; this.render(); } });
    on('tp-color', 'change', () => this.commit('文字颜色'));
    on('tp-bold', 'change', () => { if (!this.selected) return; this.beginEdit(); this.selected.text.bold = $('tp-bold').checked; this.commit('粗体'); });
    on('tp-italic', 'change', () => { if (!this.selected) return; this.beginEdit(); this.selected.text.italic = $('tp-italic').checked; this.commit('斜体'); });
    on('tp-font', 'change', () => { if (!this.selected) return; this.beginEdit(); this.selected.text.fontFamily = $('tp-font').value; this.commit('字体'); });
    on('tp-align', 'change', () => { if (!this.selected) return; this.beginEdit(); this.selected.text.align = $('tp-align').value; this.commit('对齐'); });
    on('tp-leading', 'input', () => { const el = this.selected; if (el) { el.text.leading = Number($('tp-leading').value); this.render(); } });
    on('tp-leading', 'change', () => this.commit('行高'));
    on('tp-autofit', 'change', () => {
      const el = this.selected;
      if (!el) return;
      this.beginEdit();
      el.text.autoFit = $('tp-autofit').checked;
      if (el.text.autoFit) this.#runAutofit(el);
      this.commit('自动缩字号');
      this.render();
    });
    on('btn-font-upload', 'click', () => $('font-file').click());
    on('font-file', 'change', async (e) => this.#handleFontUpload(e));

    // 图形属性
    on('sp-fill', 'input', () => { const el = this.selected; if (el) { el.shape.fill = $('sp-fill').value; this.render(); } });
    on('sp-fill', 'change', () => this.commit('填充色'));
    on('sp-fill-a', 'input', () => { const el = this.selected; if (el) { el.shape.fillAlpha = Number($('sp-fill-a').value); this.render(); } });
    on('sp-fill-a', 'change', () => this.commit('填充透明度'));
    on('sp-stroke', 'input', () => { const el = this.selected; if (el) { el.shape.stroke = $('sp-stroke').value; this.render(); } });
    on('sp-stroke', 'change', () => this.commit('描边色'));
    on('sp-stroke-w', 'input', () => { const el = this.selected; if (el) { el.shape.strokeWidth = Number($('sp-stroke-w').value) || 0; this.render(); } });
    on('sp-stroke-w', 'change', () => this.commit('描边宽度'));
    on('sp-radius', 'input', () => { const el = this.selected; if (el) { el.shape.radius = Number($('sp-radius').value); this.render(); } });
    on('sp-radius', 'change', () => this.commit('圆角'));
    on('btn-img-upload', 'click', () => $('img-file').click());
    on('img-file', 'change', (e) => this.#handleImageUpload(e));
    on('btn-img-remove', 'click', () => {
      const el = this.selected;
      if (!el || el.type !== 'shape') return;
      this.beginEdit(); el.shape.imageRef = null; this.commit('移除图片');
    });

    // 几何
    for (const id of ['gp-x', 'gp-y', 'gp-w', 'gp-h']) {
      on(id, 'focus', () => this.beginEdit());
      on(id, 'input', () => this.#applyGeometryInputs());
      on(id, 'change', () => this.commit('几何调整'));
    }
    on('gp-rot', 'input', () => { const el = this.selected; if (el) { el.rotation = Number($('gp-rot').value); $('gp-rot-val').textContent = `${el.rotation}°`; this.render(); } });
    on('gp-rot', 'change', () => this.commit('旋转'));
    on('gp-anim', 'change', () => { if (!this.selected) return; this.beginEdit(); this.selected.entrance.type = $('gp-anim').value; this.commit('入场动画'); this.render(); });
    on('gp-dur', 'input', () => { const el = this.selected; if (el) { el.entrance.duration = Number($('gp-dur').value); $('gp-dur-val').textContent = `${el.entrance.duration.toFixed(2)}s`; this.render(); } });
    on('gp-dur', 'change', () => this.commit('入场时长'));

    // 安全区
    on('safe-action', 'change', () => { this.beginEdit(); this.doc.safe.actionMarginPercent = Number($('safe-action').value); this.commit('动作安全区'); });
    on('safe-title', 'change', () => { this.beginEdit(); this.doc.safe.titleMarginPercent = Number($('safe-title').value); this.commit('标题安全区'); });
    on('btn-validate', () => this.#runValidation(true));
  }

  #applyGeometryInputs() {
    const el = this.selected;
    if (!el) return;
    const $ = (id) => document.getElementById(id);
    el.x = Number($('gp-x').value) || 0;
    el.y = Number($('gp-y').value) || 0;
    el.width = Math.max(4, Number($('gp-w').value) || 4);
    el.height = Math.max(4, Number($('gp-h').value) || 4);
    this.render();
  }

  #runAutofit(el) {
    const result = autofitFontSize(el, this.doc, this.measureFn);
    if (!result.fits) {
      toast(`「${el.name}」即使缩到最小字号 ${MIN_FONT_SIZE}px 仍放不下全部文字`,
        'err', '减少文字、增大元素高度，或把画布调大；系统没有截断任何字符。');
      el.text.fontSize = MIN_FONT_SIZE;
    } else {
      el.text.fontSize = result.fontSize;
    }
    return result;
  }

  // 对所有开启 autoFit 的文字元素执行适配（载入/重排/修复后调用）
  #applyAutofitAll(quiet = false) {
    let changed = 0;
    for (const el of this.doc.elements) {
      if (el.type !== 'text' || !el.text.autoFit) continue;
      const before = el.text.fontSize;
      const r = this.#runAutofit(el);
      if (r.fits && Math.abs(r.fontSize - before) > 0.05) changed++;
    }
    if (changed && !quiet) toast(`已对 ${changed} 个文字元素自动缩字号`, 'ok');
  }

  #syncPanelValues() {
    const el = this.selected;
    const $ = (id) => document.getElementById(id);
    const textSec = $('text-props');
    const shapeSec = $('shape-props');
    if (!el) {
      [textSec, shapeSec].forEach((s) => { s.style.opacity = '.45'; s.style.pointerEvents = 'none'; });
      return;
    }
    textSec.style.opacity = el.type === 'text' ? '1' : '.4';
    textSec.style.pointerEvents = el.type === 'text' ? 'auto' : 'none';
    shapeSec.style.opacity = el.type === 'shape' ? '1' : '.4';
    shapeSec.style.pointerEvents = el.type === 'shape' ? 'auto' : 'none';

    $('gp-x').value = Math.round(el.x);
    $('gp-y').value = Math.round(el.y);
    $('gp-w').value = Math.round(el.width);
    $('gp-h').value = Math.round(el.height);
    $('gp-rot').value = el.rotation || 0;
    $('gp-rot-val').textContent = `${el.rotation || 0}°`;
    $('gp-anim').value = el.entrance?.type || 'none';
    $('gp-dur').value = el.entrance?.duration ?? 0.8;
    $('gp-dur-val').textContent = `${(el.entrance?.duration ?? 0.8).toFixed(2)}s`;

    if (el.type === 'text') {
      if (document.activeElement !== $('tp-text')) $('tp-text').value = el.text.content;
      $('tp-size').value = Math.round(el.text.fontSize);
      $('tp-color').value = el.text.color;
      $('tp-bold').checked = !!el.text.bold;
      $('tp-italic').checked = !!el.text.italic;
      $('tp-align').value = el.text.align;
      $('tp-leading').value = el.text.leading;
      $('tp-autofit').checked = !!el.text.autoFit;
      this.#populateFontSelect(el.text.fontFamily);
      const m = measureSummary(el, this.doc, this.measureFn, this.time);
      $('tp-kf').innerHTML = m.overflow
        ? `<b style="color:var(--err)">⚠ 文本溢出</b> 需要 ${Math.round(m.requiredHeight)}px / 可用 ${Math.round(el.height)}px`
        : `需要 ${Math.round(m.requiredHeight)}px，可用 ${Math.round(el.height)}px · 字号 ${Math.round(el.text.fontSize)}px`;
    } else if (el.type === 'shape') {
      $('sp-fill').value = el.shape.fill;
      $('sp-fill-a').value = el.shape.fillAlpha;
      $('sp-stroke').value = el.shape.stroke === 'none' ? '#000000' : el.shape.stroke;
      $('sp-stroke-w').value = el.shape.strokeWidth;
      $('sp-radius').value = el.shape.radius;
      $('sp-kf').innerHTML = el.shape.imageRef ? '背景：已嵌入图片' : '背景：纯色/透明';
    }
  }

  #populateFontSelect(selected) {
    const sel = document.getElementById('tp-font');
    const builtin = ['system-ui, sans-serif', 'Georgia, "Songti SC", serif', '"PingFang SC", "Microsoft YaHei", sans-serif', 'monospace'];
    const custom = (this.doc.assets.fonts || []).map((f) => f.family);
    const all = [...new Set([...builtin, ...custom])];
    sel.innerHTML = all.map((f) => `<option value="${f}" ${f === selected ? 'selected' : ''}>${f.split(',')[0].replace(/"/g, '')}</option>`).join('');
    if (!all.includes(selected)) sel.add(new Option(selected, selected, true, true));
  }

  async #handleFontUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const family = await registerFont(file, this.doc);
      const el = this.selected;
      if (el?.type === 'text') { this.beginEdit(); el.text.fontFamily = family; this.commit('上传字体'); }
      else this.commit('上传字体');
      this.#populateFontSelect(family);
      toast(`字体「${family}」已注册并嵌入工程`, 'ok');
    } catch (err) {
      toast(`字体加载失败：${err.message}`, 'err', '确认文件是 .ttf/.otf/.woff/.woff2 且未损坏后重试。');
    }
    e.target.value = '';
  }

  async #handleImageUpload(e) {
    const file = e.target.files?.[0];
    const el = this.selected;
    if (!file || !el || el.type !== 'shape') return;
    try {
      const asset = await addImage(file, this.doc);
      this.beginEdit();
      el.shape.imageRef = asset.id;
      await this.renderer.preloadImages(this.doc);
      this.commit('设置背景图片');
      toast(`图片「${asset.originalName}」已嵌入工程（${asset.width}×${asset.height}）`, 'ok');
    } catch (err) {
      toast(`图片处理失败：${err.message}`, 'err', '换用 PNG/JPEG 等标准格式后重试。');
    }
    e.target.value = '';
  }

  // ---------- 关键帧编辑器 ----------
  #refreshKeyframeEditor() {
    const host = document.getElementById('kf-editor');
    const el = this.selected;
    if (!el) { host.innerHTML = '<p class="hint">选择一个元素后编辑关键帧。</p>'; return; }
    const rows = (el.keyframes || []).map((kf, i) => `
      <tr>
        <td><input data-i="${i}" data-k="t" type="number" step="0.05" min="0" value="${kf.t}"></td>
        <td><input data-i="${i}" data-k="x" type="number" value="${kf.props.x ?? ''}"></td>
        <td><input data-i="${i}" data-k="y" type="number" value="${kf.props.y ?? ''}"></td>
        <td><input data-i="${i}" data-k="opacity" type="number" step="0.05" min="0" max="1" value="${kf.props.opacity ?? ''}"></td>
        <td><input data-i="${i}" data-k="rotation" type="number" value="${kf.props.rotation ?? ''}"></td>
        <td><button class="mini danger" data-del="${i}">删</button></td>
      </tr>`).join('');
    host.innerHTML = `
      <div class="kf-actions">
        <button id="kf-add" class="mini">在当前时间 t=${this.time.toFixed(2)}s 添加关键帧</button>
        <button id="kf-clear" class="mini danger">清空关键帧</button>
      </div>
      <table class="kf-table">
        <thead><tr><th>t(秒)</th><th>x</th><th>y</th><th>不透明度</th><th>旋转°</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="hint">暂无关键帧，使用入场动画或在此添加。</td></tr>'}</tbody>
      </table>`;
    host.querySelector('#kf-add').onclick = () => {
      this.beginEdit();
      el.keyframes.push({ t: Number(this.time.toFixed(3)), easing: 'easeOutCubic', props: { x: el.x, y: el.y, opacity: el.opacity ?? 1, rotation: el.rotation || 0 } });
      el.keyframes.sort((a, b) => a.t - b.t);
      this.commit('添加关键帧');
    };
    host.querySelector('#kf-clear').onclick = () => { this.beginEdit(); el.keyframes = []; this.commit('清空关键帧'); };
    host.querySelectorAll('input').forEach((input) => {
      input.addEventListener('focus', () => this.beginEdit());
      input.addEventListener('change', () => {
        const i = Number(input.dataset.i);
        const k = input.dataset.k;
        const v = input.value === '' ? undefined : Number(input.value);
        if (k === 't') el.keyframes[i].t = v ?? 0;
        else if (v === undefined) delete el.keyframes[i].props[k];
        else el.keyframes[i].props[k] = v;
        el.keyframes.sort((a, b) => a.t - b.t);
        this.commit('编辑关键帧');
      });
    });
    host.querySelectorAll('[data-del]').forEach((btn) => {
      btn.onclick = () => { this.beginEdit(); el.keyframes.splice(Number(btn.dataset.del), 1); this.commit('删除关键帧'); };
    });
  }

  // ---------- 顶部工具栏 ----------
  #bindTopbar() {
    document.querySelectorAll('.tpl-btn').forEach((btn) => {
      btn.onclick = () => {
        this.switchTemplate(btn.dataset.tpl);
        this.#highlightTemplate();
      };
    });
    document.getElementById('btn-undo').onclick = () => this.undo();
    document.getElementById('btn-redo').onclick = () => this.redo();
    document.getElementById('btn-save').onclick = () => this.#saveProject();
    document.getElementById('btn-load').onclick = () => document.getElementById('file-load').click();
    document.getElementById('file-load').addEventListener('change', (e) => this.#loadProjectFile(e));
    document.getElementById('btn-restore-autosave').onclick = () => this.#restoreAutosave();
    document.getElementById('btn-autosave').onclick = () => this.#toggleAutoSave();
    document.getElementById('btn-case-default').onclick = () => this.#loadCase(createDefaultCase(), '默认案例');
    document.getElementById('btn-case-edge').onclick = () => this.#loadCase(createEdgeCase(), '边界案例');
    document.getElementById('btn-export-svg').onclick = () => this.#exportSVG();
    document.getElementById('btn-export-png').onclick = () => this.#exportPNG();
    document.getElementById('btn-export-frame').onclick = () => this.#exportFrame();
    document.getElementById('btn-export-tpl').onclick = () => this.#exportTemplate();
    document.getElementById('btn-import-tpl').onclick = () => document.getElementById('tpl-file').click();
    document.getElementById('tpl-file').addEventListener('change', (e) => this.#importTemplateFile(e));
    this.#highlightTemplate();
  }

  #highlightTemplate() {
    document.querySelectorAll('.tpl-btn').forEach((b) =>
      b.classList.toggle('active-tpl', b.dataset.tpl === this.doc.templateId));
  }

  async #loadCase(doc, label) {
    this.doc = doc;
    this.time = doc.duration;
    this.selectedId = doc.elements[0]?.id || null;
    this.history.reset(this.doc);
    await restoreFonts(this.doc).catch(() => {});
    await this.renderer.preloadImages(this.doc);
    this.#applyAutofitAll(true);
    this.#applyCanvasSize();
    this.#highlightTemplate();
    this.#afterChange('载入' + label, true);
    const issues = this.#runValidation(false);
    if (issues.some((i) => i.level === 'error')) {
      toast(`${label}已载入：检测到 ${issues.filter((i) => i.level === 'error').length} 个预期内的安全区/排版错误`,
        'warn', '打开「安全区与校验」查看每条错误的修复方法，或点「一键修复」。');
    } else {
      toast(`${label}已载入，校验全部通过`, 'ok');
    }
  }

  #saveProject() {
    try {
      download(`字幕工程_${this.doc.templateId}_${Date.now()}.json`, serializeProject(this.doc));
      toast('工程已导出为 JSON（含字体、图片与关键帧，可完整恢复）', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err', '移除过大的内嵌图片或字体后重试。');
    }
  }

  async #loadProjectFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const raw = parseProject(text);
      const doc = migrateDocument(raw);
      await restoreFonts(doc);
      this.doc = doc;
      this.time = Math.min(this.time, doc.duration);
      this.selectedId = doc.elements[0]?.id || null;
      this.history.reset(this.doc);
      await this.renderer.preloadImages(this.doc);
      this.#applyAutofitAll(true);
      this.#applyCanvasSize();
      this.#highlightTemplate();
      this.#afterChange('载入工程', true);
      const issues = this.#runValidation(false);
      toast(`工程「${file.name}」已恢复，字体/图片/关键帧全部重载（${issues.length} 条校验信息）`, 'ok');
    } catch (err) {
      toast(`工程载入失败：${err.message}`, 'err', '确认文件由本编辑器导出且未被修改；必要时从自动保存恢复。');
    }
    e.target.value = '';
  }

  async #restoreAutosave() {
    const saved = storage.load();
    if (!saved?.doc) {
      toast('没有可恢复的自动保存工程', 'warn', '先开启「自动保存」或用「保存工程」导出 JSON。');
      return;
    }
    try {
      const doc = migrateDocument(saved.doc);
      await restoreFonts(doc);
      this.doc = doc;
      this.selectedId = doc.elements[0]?.id || null;
      this.history.reset(this.doc);
      await this.renderer.preloadImages(this.doc);
      this.#applyAutofitAll(true);
      this.#applyCanvasSize();
      this.#highlightTemplate();
      this.#afterChange('恢复自动保存', true);
      toast(`已恢复 ${new Date(saved.savedAt).toLocaleString()} 的自动保存工程`, 'ok');
    } catch (err) {
      toast(`自动保存恢复失败：${err.message}`, 'err', '改用「重新载入」选择导出的工程 JSON 文件。');
    }
  }

  #toggleAutoSave() {
    this.autoSave = !this.autoSave;
    document.getElementById('btn-autosave').textContent = `⏱ 自动保存：${this.autoSave ? '开' : '关'}`;
    if (this.autoSave) {
      try {
        storage.save(this.doc);
        toast('自动保存已开启，每次编辑都会写入浏览器本地存储', 'ok');
      } catch (err) {
        toast(err.message, 'err');
        this.autoSave = false;
        document.getElementById('btn-autosave').textContent = '⏱ 自动保存：关';
      }
    }
  }

  #autoSaveQuiet() {
    try {
      storage.save(this.doc);
    } catch (err) {
      // 不静默失败：第一次失败即提示并关闭自动保存，避免持续写入失败
      if (this.autoSave) {
        this.autoSave = false;
        document.getElementById('btn-autosave').textContent = '⏱ 自动保存：关';
        toast(err.message, 'err', '改用「保存工程」导出 JSON 文件（可内嵌字体与图片，不受浏览器存储配额限制）。');
      }
    }
  }

  // ---------- 导出 ----------
  #collectExportIssues() {
    return validateDocument(this.doc, this.time, (el) => measureSummary(el, this.doc, this.measureFn, this.time));
  }

  async #confirmExport(title) {
    const issues = this.#collectExportIssues();
    const hasError = issues.some((i) => i.level === 'error');
    const ok = await showModal({
      title,
      bodyHTML: issuesHTML(issues) +
        (hasError ? '<p style="color:var(--warn);margin-top:8px">仍可强制导出，但出错元素可能被裁切。建议先点「一键修复」。</p>' : '') +
        '<p class="hint" style="margin-top:8px"><button id="m-repair" class="mini primary">一键修复安全区问题</button></p>',
      okText: hasError ? '仍然导出' : '导出',
      cancelText: '取消',
    });
    const repairBtn = document.getElementById('m-repair');
    if (repairBtn) repairBtn.onclick = () => {
      this.beginEdit();
      const n = autoRepair(this.doc, this.time);
      this.#applyAutofitAll(true);
      this.commit('一键修复');
      this.#runValidation(false);
      document.getElementById('modal-body').innerHTML = issuesHTML(this.#collectExportIssues());
      toast(`已修复 ${n} 个元素的安全区问题`, 'ok');
    };
    if (!ok) return { proceed: false, includeSafe: false, issues };
    const includeSafe = document.getElementById('m-include-safe')?.checked || false;
    return { proceed: true, includeSafe, issues };
  }

  async #exportSVG() {
    const { proceed, includeSafe } = await this.#confirmExport('导出 SVG（可编辑矢量 + 内嵌工程）');
    if (!proceed) return;
    try {
      const scene = computeScene(this.doc, this.time, this.measureFn);
      const svg = buildSVG(this.doc, scene, { includeSafe, embedProject: true });
      download(`字幕_${this.doc.templateId}_${Date.now()}.svg`, svg, 'image/svg+xml');
      toast('SVG 已导出：文字与图形均为可编辑元素，并内嵌完整工程 JSON', 'ok');
    } catch (err) {
      toast(`SVG 导出失败：${err.message}`, 'err');
    }
  }

  async #exportPNG() {
    const { proceed, includeSafe } = await this.#confirmExport('导出 PNG（当前帧位图）');
    if (!proceed) return;
    try {
      await this.renderer.preloadImages(this.doc);
      const scene = computeScene(this.doc, this.time, this.measureFn);
      const scale = this.doc.canvas.width < 320 ? 4 : 2; // 小画布超采样保证可读
      const dataURL = await this.renderer.exportPNG(this.doc, scene, scale, includeSafe);
      downloadDataURL(`字幕_${this.doc.templateId}_${Date.now()}.png`, dataURL);
      toast(`PNG 已导出（${this.doc.canvas.width * scale}×${this.doc.canvas.height * scale}），与预览同一渲染管线`, 'ok');
    } catch (err) {
      toast(`PNG 导出失败：${err.message}`, 'err', '浏览器可能禁用了画布导出，请检查内存后重试。');
    }
  }

  #exportFrame() {
    const scene = computeScene(this.doc, this.time, this.measureFn);
    const layouts = {};
    for (const item of scene.items) layouts[item.id] = item.textLayout || item.box;
    download(`当前帧_t${this.time.toFixed(2)}_${Date.now()}.json`, serializeFrame(this.doc, this.time, layouts));
    toast('当前帧 JSON 已导出（含每个元素的插值布局与可编辑原始参数）', 'ok');
  }

  #exportTemplate() {
    try {
      download(`模板_${this.doc.templateId}_${Date.now()}.json`, serializeTemplate(this.doc));
      toast('模板 JSON 已导出：分数坐标，可在任意画布尺寸重新实例化', 'ok');
    } catch (err) {
      toast(`模板导出失败：${err.message}`, 'err');
    }
  }

  async #importTemplateFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const tpl = parseProject(await file.text());
      const doc = documentFromTemplate(tpl, { width: this.doc.canvas.width, height: this.doc.canvas.height });
      // 导入模板同样保留当前文本（按 role 迁移）
      carryText(this.doc.elements, doc.elements);
      this.doc = doc;
      this.time = doc.duration;
      this.selectedId = doc.elements[0]?.id || null;
      this.history.reset(this.doc);
      await restoreFonts(this.doc).catch((err) => toast(err.message, 'warn'));
      this.#applyAutofitAll(true);
      this.#applyCanvasSize();
      this.#highlightTemplate();
      this.#afterChange('导入模板', true);
      const issues = this.#runValidation(false);
      toast(`模板「${file.name}」已导入并按当前画布重建（${issues.length} 条校验信息），文本已保留`, 'ok');
    } catch (err) {
      toast(`模板导入失败：${err.message}`, 'err', '确认文件由本编辑器「导出模板 JSON」生成且未被手工修改。');
    }
    e.target.value = '';
  }

  // ---------- 校验 ----------
  #runValidation(showToastFlag) {
    const issues = this.#updateStatus();
    const ul = document.getElementById('validate-list');
    ul.innerHTML = issues.length === 0
      ? '<li class="ok">✅ 全部元素在安全区内，文字无裁切</li>'
      : issues.map((i) => `<li class="${i.level}">${i.level === 'error' ? '⛔' : '⚠️'} ${i.message}<br><span style="opacity:.85">修复：${i.fix}</span></li>`).join('');
    if (showToastFlag) {
      const errs = issues.filter((i) => i.level === 'error').length;
      toast(errs ? `校验发现 ${errs} 个错误、${issues.length - errs} 个警告` : '校验通过', errs ? 'err' : 'ok',
        errs ? '使用「一键修复」或按每条提示调整。' : null);
    }
    return issues;
  }

  // ---------- 画布/缩放/时间 ----------
  #bindStage() {
    const $ = (id) => document.getElementById(id);
    $('canvas-w').addEventListener('change', () => this.#resizeCanvas());
    $('canvas-h').addEventListener('change', () => this.#resizeCanvas());
    $('zoom').addEventListener('input', () => {
      this.zoom = Number($('zoom').value);
      $('zoom-val').textContent = `${Math.round(this.zoom * 100)}%`;
      this.#applyZoom();
    });
    $('show-safe').addEventListener('change', () => this.render());
    $('show-grid').addEventListener('change', () => this.render());
    $('safe-action').value = this.doc.safe.actionMarginPercent;
    $('safe-title').value = this.doc.safe.titleMarginPercent;

    $('time-scrub').addEventListener('input', () => {
      this.time = (Number($('time-scrub').value) / 1000) * this.doc.duration;
      this.render();
    });
    $('btn-play').onclick = () => this.#togglePlay();
    $('btn-replay').onclick = () => { this.time = 0; this.#setScrub(); this.render(); this.#togglePlay(true); };
  }

  #resizeCanvas() {
    const w = Math.max(64, Number(document.getElementById('canvas-w').value) || 64);
    const h = Math.max(64, Number(document.getElementById('canvas-h').value) || 64);
    if (w === this.doc.canvas.width && h === this.doc.canvas.height) return;
    this.beginEdit();
    reflowForResize(this.doc, w, h);
    this.#applyAutofitAll(true);
    this.commit('画布尺寸调整（元素等比重排）');
    toast(`画布改为 ${w}×${h}，所有元素与关键帧已等比重排`, 'ok');
    const issues = this.#updateStatus();
    if (issues.some((i) => i.level === 'error')) {
      toast('重排后有元素离开安全区', 'warn', '打开校验面板并使用「一键修复」。');
    }
  }

  #applyCanvasSize() {
    const c = document.getElementById('canvas');
    // 内部像素与 CSS 像素 1:1，缩放交给 stage 的 transform，避免 DPR 双重缩放
    c.width = this.doc.canvas.width;
    c.height = this.doc.canvas.height;
    c.style.width = `${this.doc.canvas.width}px`;
    c.style.height = `${this.doc.canvas.height}px`;
    const m = document.getElementById('overlay');
    m.style.width = `${this.doc.canvas.width}px`;
    m.style.height = `${this.doc.canvas.height}px`;
    document.getElementById('canvas-w').value = this.doc.canvas.width;
    document.getElementById('canvas-h').value = this.doc.canvas.height;
    document.getElementById('safe-action').value = this.doc.safe.actionMarginPercent;
    document.getElementById('safe-title').value = this.doc.safe.titleMarginPercent;
    this.#applyZoom();
    this.#setScrub();
  }

  #applyZoom() {
    this.canvasEl.style.transform = `scale(${this.zoom})`;
    const wrap = document.getElementById('stage-wrap');
    wrap.style.width = `${this.doc.canvas.width}px`;
    wrap.style.height = `${this.doc.canvas.height}px`;
    this.overlay.update(this.doc, this.time, this.selectedId);
  }

  #setScrub() {
    const scrub = document.getElementById('time-scrub');
    scrub.value = Math.round((this.time / this.doc.duration) * 1000);
    document.getElementById('time-label').textContent = `${this.time.toFixed(2)}s / ${this.doc.duration.toFixed(2)}s`;
  }

  #togglePlay(forcePlay = false) {
    const btn = document.getElementById('btn-play');
    if (this.playing && !forcePlay) {
      this.playing = false;
      cancelAnimationFrame(this.rafId);
      btn.textContent = '▶ 播放入场';
      return;
    }
    this.playing = true;
    btn.textContent = '⏸ 暂停';
    if (this.time >= this.doc.duration) this.time = 0;
    this.playStart = performance.now() - this.time * 1000;
    const tick = (now) => {
      if (!this.playing) return;
      this.time = Math.min(this.doc.duration, (now - this.playStart) / 1000);
      this.#setScrub();
      this.render();
      if (this.time >= this.doc.duration) {
        this.playing = false;
        btn.textContent = '▶ 播放入场';
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  // ---------- 节拍器 ----------
  #bindMetronome() {
    const btn = document.getElementById('btn-metro');
    btn.onclick = async () => {
      try {
        if (this.metroEnabled) {
          this.metro.stop();
          this.metroEnabled = false;
          btn.textContent = '🔔 节拍器：关';
        } else {
          const bpm = Number(document.getElementById('bpm').value) || 90;
          this.metro.onBeat = () => {
            const dot = document.getElementById('beat-dot');
            dot.classList.add('flash');
            setTimeout(() => dot.classList.remove('flash'), 90);
            if (document.getElementById('metro-sync').checked && !this.playing) {
              this.time = 0;
              this.#togglePlay(true);
            }
          };
          await this.metro.start(bpm);
          this.metroEnabled = true;
          btn.textContent = '🔔 节拍器：开';
        }
      } catch (err) {
        toast(`节拍器启动失败：${err.message}`, 'err', '检查浏览器音频权限后重试。');
      }
    };
    document.getElementById('bpm').addEventListener('change', (e) => {
      this.metro.setBpm(Number(e.target.value) || 90);
    });
  }

  // ---------- 键盘 ----------
  #bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.#saveProject();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedId) this.#deleteElement(this.selectedId);
      } else if (e.key === 'Escape') {
        this.select(null);
      }
    });
  }
}

const app = new App();
window.addEventListener('DOMContentLoaded', () => app.init());
window.__app = app; // 供无头测试与调试
