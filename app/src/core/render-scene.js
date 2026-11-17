// 渲染场景计算：把文档 + 时间 t 解析为确定的渲染指令。
// Canvas 渲染器与 SVG 导出器都消费同一份 scene，保证像素与结构一致。
import { interpolateKeyframes, entranceState } from './easing.js';
import { layoutText } from './text.js';
import { fitRect } from './util.js';

export function computeScene(doc, t, measureFn) {
  const scene = {
    width: doc.canvas.width,
    height: doc.canvas.height,
    background: doc.canvas.background,
    items: [],
  };
  for (const el of doc.elements) {
    if (el.visible === false) continue;
    const kf = interpolateKeyframes(el.keyframes, t) || {};
    let x = kf.x ?? el.x;
    let y = kf.y ?? el.y;
    let width = kf.width ?? el.width;
    let height = kf.height ?? el.height;
    const rotation = kf.rotation ?? el.rotation ?? 0;
    const kfOpacity = kf.opacity ?? el.opacity ?? 1;
    const kfFontSize = kf.fontSize;

    const dur = el.entrance?.duration ?? 0.8;
    const localT = dur > 0 ? Math.min(1, t / dur) : 1;
    const ent = entranceState(el.entrance, localT, el, doc);

    let scale = ent.scale;
    if (scale !== 1) {
      const cx = x + width / 2;
      const cy = y + height / 2;
      width *= scale;
      height *= scale;
      x = cx - width / 2 + (ent.offsetX || 0);
      y = cy - height / 2 + (ent.offsetY || 0);
    } else {
      x += ent.offsetX || 0;
      y += ent.offsetY || 0;
    }

    const item = {
      id: el.id,
      name: el.name,
      type: el.type,
      role: el.role,
      box: { x, y, width, height, rotation },
      opacity: kfOpacity * ent.opacityFactor,
      entrance: el.entrance,
      element: el,
    };

    if (el.type === 'text') {
      const liveEl = {
        ...el,
        x, y, width, height,
        text: { ...el.text, fontSize: kfFontSize ?? el.text.fontSize },
      };
      const layout = layoutText(liveEl, doc, measureFn, { t, entranceState: ent });
      // 打字机：按 visibleChars 截断行内容
      if (ent.visibleChars !== null && ent.visibleChars !== undefined) {
        let budget = ent.visibleChars;
        layout.lines = layout.lines.map((line) => {
          if (budget <= 0) return { ...line, text: '', width: 0 };
          const take = line.text.slice(0, budget);
          budget -= line.text.length;
          return { ...line, text: take, width: measureFn(fontOf(liveEl.text), take).width };
        });
      }
      item.textLayout = layout;
      item.fontSize = liveEl.text.fontSize;
    } else {
      // 图片适配
      if (el.shape.imageRef) {
        const img = (doc.assets.images || []).find((a) => a.id === el.shape.imageRef);
        if (img) {
          item.image = { asset: img, dest: fitRect(img.width, img.height, width, height, el.shape.imageFit || 'cover') };
        }
      }
    }
    scene.items.push(item);
  }
  return scene;
}

function fontOf(tp) {
  const parts = [];
  if (tp.italic) parts.push('italic');
  if (tp.bold) parts.push('bold');
  parts.push(`${tp.fontSize}px`, tp.fontFamily || 'sans-serif');
  return parts.join(' ');
}
