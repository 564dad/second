// 覆盖层交互：点选、拖拽移动、8 向手柄缩放、双击原位编辑文字。
// 所有几何修改通过 commit 回调进入撤销栈。
import { boundingBox } from '../core/util.js';
import { elementRenderedBox } from '../core/safe-area.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class Overlay {
  constructor(canvasEl, overlayEl, hooks) {
    this.canvasEl = canvasEl;
    this.overlayEl = overlayEl;
    this.hooks = hooks; // { getDoc, getTime, getSelectedId, select, commit, getZoom, measureSummary }
    this.drag = null;
    this.#bind();
  }

  #toCanvas(e) {
    const rect = this.canvasEl.getBoundingClientRect();
    // getBoundingClientRect 已包含 transform 缩放，直接换算回画布坐标
    return {
      x: (e.clientX - rect.left) * (this.canvasEl.width / rect.width),
      y: (e.clientY - rect.top) * (this.canvasEl.height / rect.height),
    };
  }

  #bind() {
    this.overlayEl.addEventListener('pointerdown', (e) => this.#onDown(e));
    window.addEventListener('pointermove', (e) => this.#onMove(e));
    window.addEventListener('pointerup', () => this.#onUp());
    this.overlayEl.addEventListener('dblclick', (e) => this.#onDblClick(e));
  }

  #hitHandles(pt, box) {
    const size = 9 / this.hooks.getZoom();
    const corners = {
      nw: [box.x, box.y], n: [box.x + box.width / 2, box.y], ne: [box.x + box.width, box.y],
      e: [box.x + box.width, box.y + box.height / 2], se: [box.x + box.width, box.y + box.height],
      s: [box.x + box.width / 2, box.y + box.height], sw: [box.x, box.y + box.height],
      w: [box.x, box.y + box.height / 2],
    };
    for (const h of HANDLES) {
      const [hx, hy] = corners[h];
      if (Math.abs(pt.x - hx) <= size && Math.abs(pt.y - hy) <= size) return h;
    }
    return null;
  }

  #onDown(e) {
    const target = e.target.dataset?.handle;
    const id = e.target.dataset?.id;
    const pt = this.#toCanvas(e);
    const doc = this.hooks.getDoc();
    const t = this.hooks.getTime();

    if (target) {
      const el = doc.elements.find((x) => x.id === id);
      if (!el || el.locked) return;
      this.hooks.select(id);
      this.drag = { mode: 'resize', handle: target, el, start: pt, orig: snapshot(el) };
      e.preventDefault();
      return;
    }
    // 从顶层向下命中
    for (let i = doc.elements.length - 1; i >= 0; i--) {
      const el = doc.elements[i];
      if (el.visible === false) continue;
      const box = elementRenderedBox(el, doc, t);
      if (pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
        this.hooks.select(el.id);
        if (!el.locked) {
          this.drag = { mode: 'move', el, start: pt, orig: snapshot(el) };
        }
        e.preventDefault();
        return;
      }
    }
    this.hooks.select(null);
  }

  #onMove(e) {
    if (!this.drag) {
      this.#updateCursor(e);
      return;
    }
    const pt = this.#toCanvas(e);
    const dx = pt.x - this.drag.start.x;
    const dy = pt.y - this.drag.start.y;
    const el = this.drag.el;
    const o = this.drag.orig;
    if (this.drag.mode === 'move') {
      el.x = o.x + dx;
      el.y = o.y + dy;
    } else {
      const h = this.drag.handle;
      let { x, y, width, height } = o;
      if (h.includes('e')) width = Math.max(4, o.width + dx);
      if (h.includes('s')) height = Math.max(4, o.height + dy);
      if (h.includes('w')) { width = Math.max(4, o.width - dx); x = o.x + (o.width - width); }
      if (h.includes('n')) { height = Math.max(4, o.height - dy); y = o.y + (o.height - height); }
      el.x = x; el.y = y; el.width = width; el.height = height;
    }
    this.hooks.preview();
  }

  #onUp() {
    if (this.drag) {
      this.hooks.commit();
      this.drag = null;
    }
  }

  #updateCursor(e) {
    const doc = this.hooks.getDoc();
    const t = this.hooks.getTime();
    const id = this.hooks.getSelectedId();
    if (!id) { this.overlayEl.style.cursor = 'default'; return; }
    const el = doc.elements.find((x) => x.id === id);
    if (!el) return;
    const box = elementRenderedBox(el, doc, t);
    const pt = this.#toCanvas(e);
    const h = this.#hitHandles(pt, box);
    const map = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    this.overlayEl.style.cursor = h ? map[h] : 'move';
  }

  #onDblClick(e) {
    const doc = this.hooks.getDoc();
    const t = this.hooks.getTime();
    const pt = this.#toCanvas(e);
    for (let i = doc.elements.length - 1; i >= 0; i--) {
      const el = doc.elements[i];
      if (el.type !== 'text' || el.visible === false) continue;
      const box = elementRenderedBox(el, doc, t);
      if (pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height) {
        this.#startInlineEdit(el, box);
        return;
      }
    }
  }

  #startInlineEdit(el, box) {
    const ta = document.createElement('textarea');
    ta.className = 'inline-edit';
    ta.value = el.text.content;
    ta.style.left = `${box.x}px`;
    ta.style.top = `${box.y}px`;
    ta.style.width = `${box.width}px`;
    ta.style.height = `${box.height}px`;
    ta.style.fontSize = `${el.text.fontSize}px`;
    ta.style.fontFamily = el.text.fontFamily;
    ta.style.lineHeight = String(el.text.leading);
    ta.style.textAlign = el.text.align;
    this.overlayEl.appendChild(ta);
    ta.focus();
    ta.select();
    const finish = (save) => {
      if (save && ta.value !== el.text.content) {
        el.text.content = ta.value;
        this.hooks.commit();
      }
      ta.remove();
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); }
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) finish(true);
      ev.stopPropagation();
    });
  }

  // 每帧重绘选择框与手柄（坐标为画布坐标，外层 transform 统一负责缩放）
  update(doc, t, selectedId) {
    this.overlayEl.innerHTML = '';
    if (!selectedId) return;
    const el = doc.elements.find((x) => x.id === selectedId);
    if (!el) return;
    const box = boundingBox(elementRenderedBox(el, doc, t));
    const sel = document.createElement('div');
    sel.className = 'sel-box';
    sel.dataset.id = el.id;
    Object.assign(sel.style, {
      left: `${box.x}px`, top: `${box.y}px`,
      width: `${box.width}px`, height: `${box.height}px`,
    });
    this.overlayEl.appendChild(sel);
    const pos = {
      nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50],
      se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50],
    };
    for (const h of HANDLES) {
      const d = document.createElement('div');
      d.className = 'sel-handle';
      d.dataset.handle = h;
      d.dataset.id = el.id;
      const [px, py] = pos[h];
      d.style.left = `calc(${px}% - 5px)`;
      d.style.top = `calc(${py}% - 5px)`;
      sel.appendChild(d);
    }
  }
}

function snapshot(el) {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}
