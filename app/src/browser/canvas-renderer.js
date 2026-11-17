// Canvas 渲染器：与 SVG 导出共享 scene，按相同坐标与基线绘制，保证导出与预览一致。
import { safeZones } from '../core/safe-area.js';
import { fontString } from '../core/text.js';

export class CanvasRenderer {
  constructor(canvas, measureCanvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mctx = measureCanvas.getContext('2d');
    this.imageCache = new Map();
  }

  // 供 text.js 使用的测量函数
  measure = (fontStr, text) => {
    this.mctx.font = fontStr;
    return this.mctx.measureText(text);
  };

  preloadImages(doc) {
    const jobs = [];
    for (const asset of doc.assets.images || []) {
      if (this.imageCache.has(asset.id)) continue;
      jobs.push(new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { this.imageCache.set(asset.id, img); resolve(); };
        img.onerror = () => resolve();
        img.src = asset.ref;
      }));
    }
    return Promise.all(jobs);
  }

  render(doc, scene, options = {}) {
    const { ctx } = this;
    const dpr = options.dpr || 1;
    const W = doc.canvas.width;
    const H = doc.canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = doc.canvas.background || '#000';
    ctx.fillRect(0, 0, W, H);

    for (const item of scene.items) {
      if (item.opacity <= 0.001) continue;
      ctx.save();
      ctx.globalAlpha = item.opacity;
      const { box } = item;
      if (box.rotation) {
        ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
        ctx.rotate((box.rotation * Math.PI) / 180);
        ctx.translate(-(box.x + box.width / 2), -(box.y + box.height / 2));
      }
      if (item.type === 'shape') this.#drawShape(item);
      else this.#drawText(item);
      ctx.restore();
    }

    if (options.showSafe !== false) this.#drawSafe(doc, options);
    if (options.showGrid) this.#drawGrid(W, H);
    if (options.selectionId) this.#drawSelection(scene, options.selectionId);
  }

  #drawShape(item) {
    const { ctx } = this;
    const { box } = item;
    const sh = item.element.shape;
    const path = () => {
      const r = Math.min(sh.radius || 0, box.width / 2, box.height / 2);
      if (sh.shapeType === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
      } else if (r > 0) {
        roundRectPath(ctx, box.x, box.y, box.width, box.height, r);
      } else {
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.width, box.height);
      }
    };
    if (item.image) {
      const img = this.imageCache.get(item.image.asset.id);
      const d = item.image.dest;
      ctx.save();
      path();
      ctx.clip();
      if (img) ctx.drawImage(img, box.x + d.x, box.y + d.y, d.width, d.height);
      else {
        ctx.fillStyle = '#333';
        ctx.fillRect(box.x, box.y, box.width, box.height);
      }
      ctx.restore();
    } else {
      ctx.globalAlpha *= sh.fillAlpha ?? 1;
      path();
      ctx.fillStyle = sh.fill || '#000';
      ctx.fill();
    }
    if (sh.strokeWidth > 0 && sh.stroke && sh.stroke !== 'none') {
      path();
      ctx.strokeStyle = sh.stroke;
      ctx.lineWidth = sh.strokeWidth;
      ctx.stroke();
    }
  }

  #drawText(item) {
    const { ctx } = this;
    const { box } = item;
    const tp = item.element.text;
    const layout = item.textLayout;
    const { padding: pad } = layout;
    ctx.font = fontString({ ...tp, fontSize: item.fontSize });
    ctx.fillStyle = tp.color;
    ctx.textBaseline = 'alphabetic';
    const tx = tp.align === 'center' ? box.x + box.width / 2
      : tp.align === 'right' ? box.x + box.width - pad.right
      : box.x + pad.left;
    ctx.textAlign = tp.align === 'center' ? 'center' : tp.align === 'right' ? 'right' : 'left';
    let baseline = box.y + pad.top + item.fontSize * 0.85;
    for (const line of layout.lines) {
      ctx.fillText(line.text, tx, baseline);
      baseline += layout.lineHeight;
    }
  }

  #drawSafe(doc) {
    const { ctx } = this;
    const zones = safeZones(doc);
    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(79,140,255,0.9)';
    ctx.strokeRect(zones.action.x, zones.action.y, zones.action.width, zones.action.height);
    ctx.strokeStyle = 'rgba(34,195,166,0.9)';
    ctx.strokeRect(zones.title.x, zones.title.y, zones.title.width, zones.title.height);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(79,140,255,0.85)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`动作安全 ${doc.safe.actionMarginPercent}%`, zones.action.x + 6, zones.action.y + 14);
    ctx.fillStyle = 'rgba(34,195,166,0.9)';
    ctx.fillText(`标题安全 ${doc.safe.titleMarginPercent}%`, zones.title.x + 6, zones.title.y + 14);
    ctx.restore();
  }

  #drawGrid(W, H) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const step = 40;
    for (let x = step; x < W; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = step; y < H; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  #drawSelection(scene, id) {
    const item = scene.items.find((i) => i.id === id);
    if (!item) return;
    const { ctx } = this;
    const { box } = item;
    ctx.save();
    ctx.strokeStyle = '#4f8cff';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(box.x - 2, box.y - 2, box.width + 4, box.height + 4);
    ctx.restore();
  }

  // 导出 PNG：离屏按 scale 渲染，不绘制选择框；安全框按选项决定
  async exportPNG(doc, scene, scale = 1, includeSafe = false) {
    const off = document.createElement('canvas');
    off.width = Math.round(doc.canvas.width * scale);
    off.height = Math.round(doc.canvas.height * scale);
    const offCtx = off.getContext('2d');
    const offMeasure = document.createElement('canvas');
    const renderer = new CanvasRenderer(off, offMeasure);
    renderer.imageCache = this.imageCache;
    offCtx.setTransform(scale, 0, 0, scale, 0, 0);
    renderer.render(doc, scene, { dpr: 1, showSafe: includeSafe, showGrid: false, selectionId: null });
    return off.toDataURL('image/png');
  }
}

export function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
