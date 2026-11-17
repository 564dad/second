// SVG 导出：真实可编辑的 SVG 文本与图形（非截图），并内嵌完整工程 JSON。
import { safeZones } from './safe-area.js';
import { serializeProject } from './serialize.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function rgba(hex, alpha) {
  let h = (hex || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha ?? 1})`;
}

function fontStringAttr(tp) {
  const style = tp.italic ? 'italic' : 'normal';
  const weight = tp.bold ? '700' : '400';
  return `font-style:${style};font-weight:${weight};font-size:${tp.fontSize}px;font-family:${esc(tp.fontFamily || 'sans-serif')};`;
}

export function buildSVG(doc, scene, options = {}) {
  const { includeSafe = false, embedProject = true } = options;
  const W = scene.width;
  const H = scene.height;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  parts.push(`<title>字幕模板导出 ${esc(doc.templateId)}</title>`);
  if (embedProject) {
    parts.push(`<metadata id="subtitle-project" type="application/json">${esc(serializeProject(doc))}</metadata>`);
  }
  parts.push(`<rect id="canvas-bg" x="0" y="0" width="${W}" height="${H}" fill="${esc(scene.background || '#000')}"/>`);

  for (const item of scene.items) {
    if (item.opacity <= 0.001) continue;
    const { box } = item;
    const op = ` opacity="${round3(item.opacity)}"`;
    const transform = box.rotation
      ? ` transform="rotate(${round3(box.rotation)} ${round3(box.x + box.width / 2)} ${round3(box.y + box.height / 2)})"`
      : '';
    parts.push(`<g data-id="${esc(item.id)}" data-name="${esc(item.name)}" data-type="${esc(item.type)}"${op}>`);

    if (item.type === 'shape') {
      const sh = item.element.shape;
      if (item.image) {
        const d = item.image.dest;
        const par = sh.imageFit === 'cover' ? 'xMidYMid slice' : sh.imageFit === 'fill' ? 'none' : 'xMidYMid meet';
        parts.push(`<image x="${round3(box.x + d.x)}" y="${round3(box.y + d.y)}" width="${round3(d.width)}" height="${round3(d.height)}" preserveAspectRatio="${par}" href="${item.image.asset.ref}"/>`);
      } else if (sh.shapeType === 'ellipse') {
        parts.push(`<ellipse cx="${round3(box.x + box.width / 2)}" cy="${round3(box.y + box.height / 2)}" rx="${round3(box.width / 2)}" ry="${round3(box.height / 2)}" fill="${rgba(sh.fill, sh.fillAlpha)}"${sh.strokeWidth ? ` stroke="${esc(sh.stroke)}" stroke-width="${round3(sh.strokeWidth)}"` : ''}/>`);
      } else {
        parts.push(`<rect x="${round3(box.x)}" y="${round3(box.y)}" width="${round3(box.width)}" height="${round3(box.height)}" rx="${round3(Math.min(sh.radius || 0, box.width / 2, box.height / 2))}" fill="${rgba(sh.fill, sh.fillAlpha)}"${sh.strokeWidth ? ` stroke="${esc(sh.stroke)}" stroke-width="${round3(sh.strokeWidth)}"` : ''}${transform}/>`);
      }
    } else if (item.type === 'text') {
      const tp = item.element.text;
      const layout = item.textLayout;
      const pad = layout.padding;
      const anchor = tp.align === 'center' ? 'middle' : tp.align === 'right' ? 'end' : 'start';
      const tx = tp.align === 'center' ? box.x + box.width / 2
        : tp.align === 'right' ? box.x + box.width - pad.right
        : box.x + pad.left;
      const firstBaseline = box.y + pad.top + item.fontSize * 0.85;
      const tspans = layout.lines.map((line, i) => {
        const dy = i === 0 ? round3(firstBaseline) : round3(layout.lineHeight);
        return `<tspan x="${round3(tx)}" dy="${dy}">${esc(line.text)}</tspan>`;
      });
      parts.push(`<text data-editable="true" x="0" y="0" text-anchor="${anchor}" fill="${esc(tp.color)}" style="${fontStringAttr(tp)};line-height:${round3(tp.leading)}" dominant-baseline="alphabetic">${tspans.join('')}</text>`);
    }
    parts.push('</g>');
  }

  if (includeSafe) {
    const zones = safeZones(doc);
    const z = zones.action;
    const zt = zones.title;
    parts.push(`<g id="safe-zones" fill="none" stroke="#4f8cff" stroke-width="1" stroke-dasharray="6 6" opacity="0.85">`);
    parts.push(`<rect data-zone="action" x="${round3(z.x)}" y="${round3(z.y)}" width="${round3(z.width)}" height="${round3(z.height)}"/>`);
    parts.push(`<rect data-zone="title" x="${round3(zt.x)}" y="${round3(zt.y)}" width="${round3(zt.width)}" height="${round3(zt.height)}" stroke="#22c3a6"/>`);
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
