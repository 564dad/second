// 序列化：工程、模板、当前帧 JSON。导出必须是可编辑结构而非截图。
import { deepClone } from './util.js';
import { SCHEMA_VERSION } from './document.js';

function stamp(doc) {
  return { ...doc, meta: { ...doc.meta, updatedAt: new Date().toISOString() } };
}

// 完整工程：文档 + 字体/图片资产（dataURL 内嵌，单文件可一致恢复）
export function serializeProject(doc) {
  return JSON.stringify(stamp(deepClone(doc)), null, 2);
}

export function parseProject(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`JSON 解析失败：${e.message}。请确认文件未被损坏。`);
  }
  return raw;
}

// 模板 JSON：把绝对坐标归一化回分数坐标，可在任意画布尺寸重新实例化
export function serializeTemplate(doc) {
  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const tpl = {
    kind: 'subtitle-template',
    schemaVersion: SCHEMA_VERSION,
    templateId: doc.templateId,
    sourceCanvas: { width: W, height: H },
    safe: deepClone(doc.safe),
    specs: doc.elements.map((el) => {
      const spec = {
        type: el.type,
        role: el.role,
        name: el.name,
        background: !!el.background,
        fx: round6(el.x / W),
        fy: round6(el.y / H),
        fw: round6(el.width / W),
        fh: round6(el.height / H),
        entrance: deepClone(el.entrance),
        keyframes: (el.keyframes || []).map((kf) => ({
          t: kf.t,
          easing: kf.easing,
          props: normalizeKfProps(kf.props, W, H),
        })),
      };
      if (el.type === 'text') {
        spec.text = el.text.content;
        spec.fontScale = round6(el.text.fontSize / H);
        spec.fontFamily = el.text.fontFamily;
        spec.color = el.text.color;
        spec.bold = el.text.bold;
        spec.italic = el.text.italic;
        spec.align = el.text.align;
        spec.leading = el.text.leading;
        spec.autoFit = el.text.autoFit;
        spec.padding = deepClone(el.padding);
      } else {
        spec.shapeType = el.shape.shapeType;
        spec.fill = el.shape.fill;
        spec.fillAlpha = el.shape.fillAlpha;
        spec.stroke = el.shape.stroke;
        spec.strokeWidth = el.shape.strokeWidth;
        spec.radius = el.shape.radius;
        spec.imageRef = el.shape.imageRef;
        spec.imageFit = el.shape.imageFit;
      }
      return spec;
    }),
    fonts: doc.assets.fonts.map((f) => ({ family: f.family, format: f.format, ref: f.ref })),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(tpl, null, 2);
}

function normalizeKfProps(props, W, H) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'x' || k === 'width') out[k] = round6(v / W);
    else if (k === 'y' || k === 'height') out[k] = round6(v / H);
    else if (k === 'fontSize') out[k] = round6(v / H);
    else out[k] = v;
  }
  return out;
}

// 当前帧：时间 t 上的插值结果 + 原始可编辑参数，两者都保留
export function serializeFrame(doc, t, layoutResults) {
  const frame = {
    kind: 'subtitle-frame',
    schemaVersion: SCHEMA_VERSION,
    time: t,
    canvas: deepClone(doc.canvas),
    safe: deepClone(doc.safe),
    elements: doc.elements.map((el) => ({
      id: el.id,
      name: el.name,
      type: el.type,
      role: el.role,
      editable: deepClone(el),
      layout: layoutResults?.[el.id] || null,
    })),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(frame, null, 2);
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// 从模板 JSON 重建文档（任意画布尺寸）
export function documentFromTemplate(tpl, canvas) {
  if (!tpl || tpl.kind !== 'subtitle-template') {
    throw new Error('不是有效的模板 JSON（缺少 kind: "subtitle-template"）');
  }
  const W = canvas?.width || tpl.sourceCanvas?.width || 1280;
  const H = canvas?.height || tpl.sourceCanvas?.height || 720;
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    templateId: tpl.templateId || 'news',
    canvas: { width: W, height: H, background: '#101318' },
    safe: tpl.safe || { actionMarginPercent: 5, titleMarginPercent: 10, enforceTitleOnShapes: false },
    duration: 2,
    assets: { fonts: tpl.fonts || [], images: [] },
    elements: (tpl.specs || []).map((s) => {
      const base = {
        id: `tplimp_${Math.random().toString(36).slice(2, 10)}`,
        role: s.role, type: s.type, name: s.name || s.role,
        x: s.fx * W, y: s.fy * H, width: s.fw * W, height: s.fh * H,
        rotation: 0, opacity: 1, locked: false, visible: true, background: !!s.background,
        entrance: s.entrance || { type: 'none', duration: 0.8, easing: 'easeOutCubic' },
        keyframes: (s.keyframes || []).map((kf) => ({
          t: kf.t, easing: kf.easing,
          props: Object.fromEntries(Object.entries(kf.props || {}).map(([k, v]) => [
            k,
            k === 'x' || k === 'width' ? v * W : k === 'y' || k === 'height' || k === 'fontSize' ? v * H : v,
          ])),
        })),
      };
      if (s.type === 'text') {
        base.padding = s.padding || { left: 0.012 * W, right: 0.012 * W, top: 0.008 * H, bottom: 0.008 * H };
        base.text = {
          content: s.text || '', fontSize: Math.max(6, s.fontScale * H), fontFamily: s.fontFamily || 'system-ui, sans-serif',
          color: s.color || '#fff', bold: !!s.bold, italic: !!s.italic, align: s.align || 'left',
          leading: s.leading || 1.3, autoFit: s.autoFit ?? true,
        };
      } else {
        base.shape = {
          shapeType: s.shapeType || 'rect', fill: s.fill || '#000', fillAlpha: s.fillAlpha ?? 1,
          stroke: s.stroke || 'none', strokeWidth: s.strokeWidth || 0, radius: s.radius ?? 0,
          imageRef: s.imageRef || null, imageFit: s.imageFit || 'cover',
        };
      }
      return base;
    }),
    meta: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };
  return doc;
}
