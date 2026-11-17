// 三种字幕模板：news（新闻）/ story（剧情）/ cue（提示卡）。
// 模板使用分数坐标（0..1）与相对字号（相对画布高度），与分辨率无关。
import { uid, deepClone } from './util.js';

export const TEMPLATE_IDS = ['news', 'story', 'cue'];

export const TEMPLATE_META = {
  news: { name: '新闻下沿条', icon: '📰' },
  story: { name: '剧情台词', icon: '🎬' },
  cue: { name: '提示卡', icon: '🃏' },
};

let seq = 0;
function elId() {
  seq += 1;
  return `tpl_el_${seq}`;
}

// 把分数规格实例化为绝对像素元素
function instantiate(spec, W, H) {
  const base = {
    id: uid(spec.type),
    role: spec.role || null,
    type: spec.type,
    name: spec.name,
    x: Math.round(spec.fx * W),
    y: Math.round(spec.fy * H),
    width: Math.round(spec.fw * W),
    height: Math.round(spec.fh * H),
    rotation: 0,
    opacity: 1,
    locked: false,
    visible: true,
    background: !!spec.background,
    entrance: spec.entrance ? deepClone(spec.entrance) : { type: 'none', duration: 0.8, easing: 'easeOutCubic' },
    keyframes: [],
  };
  if (spec.type === 'text') {
    base.padding = spec.padding || { left: 0.012 * W, right: 0.012 * W, top: 0.008 * H, bottom: 0.008 * H };
    base.text = {
      content: spec.text || '',
      fontSize: Math.max(6, Math.round(H * spec.fontScale)),
      fontFamily: spec.fontFamily || 'system-ui, sans-serif',
      color: spec.color || '#ffffff',
      bold: !!spec.bold,
      italic: !!spec.italic,
      align: spec.align || 'left',
      leading: spec.leading || 1.3,
      autoFit: spec.autoFit ?? true,
    };
  } else {
    base.shape = {
      shapeType: spec.shapeType || 'rect',
      fill: spec.fill || '#000000',
      fillAlpha: spec.fillAlpha ?? 1,
      stroke: spec.stroke || 'none',
      strokeWidth: spec.strokeWidth || 0,
      radius: spec.radius ?? 12,
      imageRef: null,
      imageFit: 'cover',
    };
  }
  return base;
}

function specsFor(templateId) {
  switch (templateId) {
    case 'news':
      // 文字全部落在标题安全区（10%）内；底板/色条落在动作安全区（5%）内
      return [
        { type: 'shape', shapeType: 'rect', role: 'panel', name: '新闻底板',
          fx: 0.06, fy: 0.72, fw: 0.88, fh: 0.215, radius: 14,
          fill: '#0b1f3a', fillAlpha: 0.82,
          entrance: { type: 'slideLeft', duration: 0.7, easing: 'easeOutCubic' } },
        { type: 'shape', shapeType: 'rect', role: 'accent', name: '强调色条',
          fx: 0.06, fy: 0.72, fw: 0.01, fh: 0.215, radius: 3,
          fill: '#e63946', fillAlpha: 1,
          entrance: { type: 'fade', duration: 0.5, easing: 'easeOutCubic' } },
        { type: 'text', role: 'kicker', name: '栏目标签',
          fx: 0.105, fy: 0.735, fw: 0.785, fh: 0.065, fontScale: 0.032,
          text: '现场报道', color: '#8ec7ff', bold: true, align: 'left',
          fontFamily: 'system-ui, sans-serif',
          entrance: { type: 'fade', duration: 0.6, easing: 'easeOutCubic' } },
        { type: 'text', role: 'headline', name: '新闻主标题',
          fx: 0.105, fy: 0.795, fw: 0.785, fh: 0.105, fontScale: 0.046,
          text: '城市新地铁线路今日开通，首班车清晨发出', color: '#ffffff', bold: true, align: 'left',
          fontFamily: 'system-ui, sans-serif',
          entrance: { type: 'slideUp', duration: 0.7, easing: 'easeOutCubic' } },
      ];
    case 'story':
      return [
        { type: 'shape', shapeType: 'rect', role: 'scrim', name: '暗角遮罩', background: true,
          fx: 0, fy: 0, fw: 1, fh: 1, radius: 0,
          fill: '#000000', fillAlpha: 0.32,
          entrance: { type: 'fade', duration: 1.2, easing: 'linear' } },
        { type: 'text', role: 'headline', name: '剧情台词',
          fx: 0.12, fy: 0.36, fw: 0.76, fh: 0.22, fontScale: 0.055,
          text: '“不管走多远，灯火亮着的地方就是家。”', color: '#f5f1e8', bold: false, italic: true,
          align: 'center', leading: 1.5, fontFamily: 'Georgia, "Songti SC", serif',
          entrance: { type: 'zoom', duration: 0.9, easing: 'easeOutCubic' } },
        { type: 'text', role: 'kicker', name: '角色名',
          fx: 0.12, fy: 0.6, fw: 0.76, fh: 0.07, fontScale: 0.032,
          text: '—— 林晚', color: '#cfc7b8', align: 'center',
          fontFamily: 'Georgia, "Songti SC", serif',
          entrance: { type: 'fade', duration: 1, easing: 'easeOutCubic' } },
      ];
    case 'cue':
      return [
        { type: 'shape', shapeType: 'rect', role: 'panel', name: '卡片底板',
          fx: 0.105, fy: 0.105, fw: 0.79, fh: 0.79, radius: 24,
          fill: '#14213d', fillAlpha: 0.94,
          stroke: '#fca311', strokeWidth: 4,
          entrance: { type: 'zoom', duration: 0.6, easing: 'easeOutBack' } },
        { type: 'shape', shapeType: 'ellipse', role: 'accent', name: '装饰圆点',
          fx: 0.8, fy: 0.12, fw: 0.06, fh: 0.09, radius: 999,
          fill: '#fca311', fillAlpha: 1,
          entrance: { type: 'fade', duration: 0.5, easing: 'easeOutCubic' } },
        { type: 'text', role: 'headline', name: '卡片标题',
          fx: 0.13, fy: 0.14, fw: 0.66, fh: 0.12, fontScale: 0.06,
          text: '拍摄提示', color: '#fca311', bold: true, align: 'left',
          fontFamily: 'system-ui, sans-serif',
          entrance: { type: 'slideUp', duration: 0.6, easing: 'easeOutBack' } },
        { type: 'text', role: 'body', name: '卡片正文',
          fx: 0.13, fy: 0.29, fw: 0.74, fh: 0.57, fontScale: 0.036,
          text: '1. 保持主体位于标题安全区内\n2. 每条字幕不超过两行\n3. 录制前先检查声音电平',
          color: '#e8eef7', align: 'left', leading: 1.5,
          fontFamily: 'system-ui, sans-serif',
          entrance: { type: 'typewriter', duration: 1.4, easing: 'linear' } },
      ];
    default:
      throw new Error(`未知模板: ${templateId}`);
  }
}

export function instantiateTemplate(templateId, W, H) {
  if (!TEMPLATE_IDS.includes(templateId)) throw new Error(`未知模板: ${templateId}`);
  return specsFor(templateId).map((s) => instantiate(s, W, H));
}

// 切换模板时保留文本：按 role 迁移文字内容与字体偏好（几何/入场由新模板提供）
export function carryText(oldElements, newElements) {
  if (!Array.isArray(oldElements) || !Array.isArray(newElements)) {
    throw new Error('carryText 需要两个元素数组作为参数');
  }
  const byRole = new Map();
  for (const el of oldElements) {
    if (el.type === 'text' && el.role) byRole.set(el.role, el);
  }
  for (const el of newElements) {
    if (el.type !== 'text' || !el.role) continue;
    const old = byRole.get(el.role);
    if (!old) continue;
    el.text.content = old.text.content;
    el.text.fontFamily = old.text.fontFamily;
    el.text.bold = old.text.bold;
    el.text.italic = old.text.italic;
    el.text.color = old.text.color;
    el.text.align = old.text.align;
    el.text.leading = old.text.leading;
  }
  return newElements;
}

// 画布尺寸变化时重排：全部按分数比例缩放，关键帧同步缩放
export function reflowForResize(doc, newW, newH) {
  const { width: ow, height: oh } = doc.canvas;
  const sx = newW / ow;
  const sy = newH / oh;
  for (const el of doc.elements) {
    el.x *= sx; el.y *= sy; el.width *= sx; el.height *= sy;
    if (el.type === 'text') el.text.fontSize *= Math.min(sx, sy);
    if (el.padding) {
      el.padding = {
        left: el.padding.left * sx, right: el.padding.right * sx,
        top: el.padding.top * sy, bottom: el.padding.bottom * sy,
      };
    }
    if (el.shape?.strokeWidth) el.shape.strokeWidth *= Math.min(sx, sy);
    if (el.shape?.radius) el.shape.radius *= Math.min(sx, sy);
    for (const kf of el.keyframes || []) {
      const p = kf.props;
      if (p.x !== undefined) p.x *= sx;
      if (p.y !== undefined) p.y *= sy;
      if (p.width !== undefined) p.width *= sx;
      if (p.height !== undefined) p.height *= sy;
      if (p.fontSize !== undefined) p.fontSize *= Math.min(sx, sy);
    }
  }
  doc.canvas.width = newW;
  doc.canvas.height = newH;
  return doc;
}
