// 安全区、几何校验。纯函数。
import { boundingBox, rectInside, clamp } from './util.js';

// 返回动作安全区 / 标题安全区（百分比基于较小边的传统做法改为按宽高分别计算，
// 这样非标准画幅也能得到正确的边距）
export function safeZones(doc) {
  const { width: W, height: H } = doc.canvas;
  const a = doc.safe.actionMarginPercent / 100;
  const t = doc.safe.titleMarginPercent / 100;
  return {
    action: { x: W * a, y: H * a, width: W * (1 - 2 * a), height: H * (1 - 2 * a) },
    title: { x: W * t, y: H * t, width: W * (1 - 2 * t), height: H * (1 - 2 * t) },
  };
}

// 元素在时间 t 的实际渲染外接框（含关键帧插值与入场位移/缩放）
import { interpolateKeyframes, entranceState } from './easing.js';

export function elementRenderedBox(element, doc, t = 1) {
  let { x, y, width, height, rotation = 0 } = element;
  const kfProps = interpolateKeyframes(element.keyframes, t);
  if (kfProps) {
    x = kfProps.x ?? x;
    y = kfProps.y ?? y;
    width = kfProps.width ?? width;
    height = kfProps.height ?? height;
    rotation = kfProps.rotation ?? rotation;
  }
  const dur = element.entrance?.duration ?? 0.8;
  const localT = dur > 0 ? clamp(t / dur, 0, 1) : 1;
  const st = entranceState(element.entrance, localT, element, doc);
  if (st.scale !== 1) {
    const cx = x + width / 2;
    const cy = y + height / 2;
    width *= st.scale;
    height *= st.scale;
    x = cx - width / 2;
    y = cy - height / 2;
  }
  x += st.offsetX || 0;
  y += st.offsetY || 0;
  return boundingBox({ x, y, width, height, rotation });
}

// 校验单个元素；issues: [{level:'error'|'warn', code, message, fix}]
export function validateElement(element, doc, t = 1) {
  const issues = [];
  // 全屏背景（如暗角遮罩）有意覆盖整个画布，豁免安全区检查
  if (element.background) return issues;
  const zones = safeZones(doc);
  const box = elementRenderedBox(element, doc, t);
  const canvasBox = { x: 0, y: 0, width: doc.canvas.width, height: doc.canvas.height };

  // 1. 画布裁切（硬错误）
  if (!rectInside(box, canvasBox, 0.5)) {
    issues.push({
      level: 'error',
      code: 'CLIPPED_BY_CANVAS',
      elementId: element.id,
      message: `「${element.name}」超出画布 ${doc.canvas.width}×${doc.canvas.height}，导出时会被裁切`,
      detail: { box, canvas: canvasBox },
      fix: '开启「自动缩字号」或在几何面板缩小尺寸、拖回画布内；也可执行「一键修复」自动缩放。',
    });
  }

  // 2. 标题安全区（错误级，字幕文字必须在标题安全区内）
  const strict = element.type === 'text' || doc.safe.enforceTitleOnShapes === true;
  const zone = strict ? zones.title : zones.action;
  if (!rectInside(box, zone, 0.5)) {
    issues.push({
      level: strict ? 'error' : 'warn',
      code: strict ? 'OUTSIDE_TITLE_SAFE' : 'OUTSIDE_ACTION_SAFE',
      elementId: element.id,
      message: `「${element.name}」位于${strict ? '标题' : '动作'}安全区之外（${strict ? doc.safe.titleMarginPercent : doc.safe.actionMarginPercent}% 边距）`,
      detail: { box, zone },
      fix: '将元素向画面中心移动，或降低字号/尺寸；「一键修复」会等比缩回安全区内。',
    });
  } else if (!strict && !rectInside(box, zones.title, 0.5)) {
    issues.push({
      level: 'warn',
      code: 'OUTSIDE_TITLE_SAFE',
      elementId: element.id,
      message: `「${element.name}」在动作安全区内但超出标题安全区`,
      detail: { box, zone: zones.title },
      fix: '若该元素含文字，请移入标题安全区。',
    });
  }

  // 3. 尺寸异常
  if (box.width < 4 || box.height < 4) {
    issues.push({
      level: 'error',
      code: 'TOO_SMALL',
      elementId: element.id,
      message: `「${element.name}」尺寸过小（${Math.round(box.width)}×${Math.round(box.height)}px），内容无法辨识`,
      fix: '在几何面板增大 W/H，或删除该元素。',
    });
  }

  // 4. 文字特有检查（调用方注入 measure 结果后在 text.js 里补充）
  return issues;
}

export function validateDocument(doc, t = 1, measureFn = null) {
  const issues = [];
  for (const el of doc.elements) {
    if (el.locked) continue;
    issues.push(...validateElement(el, doc, t));
  }
  if (measureFn) {
    for (const el of doc.elements) {
      if (el.type !== 'text') continue;
      const m = measureFn(el, doc, t);
      if (m.overflow) {
        issues.push({
          level: 'error',
          code: 'TEXT_OVERFLOW',
          elementId: el.id,
          message: `「${el.name}」文本溢出其容器（${m.overflowLines} 行放不下，需要 ${Math.round(m.requiredHeight)}px，可用 ${Math.round(el.height)}px）`,
          detail: m,
          fix: '开启「自动缩字号」、增大元素高度、减少文字，或点「一键修复」自动适配。',
        });
      }
      if (m.fontSizeBelowMin) {
        issues.push({
          level: 'error',
          code: 'FONT_TOO_SMALL',
          elementId: el.id,
          message: `「${el.name}」为容纳全部文字需缩小到 ${Math.round(m.requiredFontSize)}px，低于最小可读字号 ${m.minFontSize}px`,
          detail: m,
          fix: '减少文字量、增大画布/元素尺寸，或拆分为多条字幕。',
        });
      }
    }
  }
  return issues;
}

// 一键修复：把所有越界元素缩回标题安全区（先等比缩放，再平移归位；保留旋转）
export function autoRepair(doc, t = 1) {
  const zone = safeZones(doc).title;
  let repaired = 0;
  for (const el of doc.elements) {
    if (el.background) continue;
    const before = { x: el.x, y: el.y, width: el.width, height: el.height, fontSize: el.text?.fontSize };
    const box = elementRenderedBox(el, doc, t);
    if (!rectInside(box, zone, 0.5)) {
      const sx = zone.width / Math.max(box.width, 1);
      const sy = zone.height / Math.max(box.height, 1);
      const s = Math.min(1, sx, sy);
      if (Number.isFinite(s) && s < 1) {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        el.width *= s;
        el.height *= s;
        el.x = cx - el.width / 2;
        el.y = cy - el.height / 2;
        if (el.type === 'text' && el.text.fontSize) el.text.fontSize *= s;
      }
      // 平移归位
      const box2 = elementRenderedBox(el, doc, t);
      const overflowLeft = zone.x - box2.x;
      const overflowRight = box2.x + box2.width - (zone.x + zone.width);
      const overflowTop = zone.y - box2.y;
      const overflowBottom = box2.y + box2.height - (zone.y + zone.height);
      if (overflowLeft > 0) el.x += overflowLeft;
      else if (overflowRight > 0) el.x -= overflowRight;
      if (overflowTop > 0) el.y += overflowTop;
      else if (overflowBottom > 0) el.y -= overflowBottom;
    }
    const changed = before.x !== el.x || before.y !== el.y ||
      before.width !== el.width || before.height !== el.height ||
      before.fontSize !== el.text?.fontSize;
    if (changed) repaired++;
  }
  return repaired;
}
