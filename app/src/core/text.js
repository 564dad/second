// 文本排版：换行、测量、自动缩字号。measureFn 由宿主注入（浏览器用 Canvas，测试用 mock）。
import { clamp } from './util.js';

export const MIN_FONT_SIZE = 6;

export function fontString(textProps) {
  const parts = [];
  if (textProps.italic) parts.push('italic');
  if (textProps.bold) parts.push('bold');
  parts.push(`${textProps.fontSize}px`);
  const fam = textProps.fontFamily || 'sans-serif';
  parts.push(fam.includes(',') || fam.includes(' ') ? `"${fam}"` : fam);
  return parts.join(' ');
}

// 默认测量器（无 Canvas 环境的兜底/测试用）：CJK 全角 1em，其他 0.55em
export function makeMockMeasure() {
  return (fontStr, text) => {
    const m = /(\d+(?:\.\d+)?)px/.exec(fontStr);
    const em = m ? parseFloat(m[1]) : 16;
    let w = 0;
    for (const ch of text) {
      w += /[⺀-鿿豈-﫿　-〿＀-￯]/.test(ch) ? em : em * 0.55;
    }
    return { width: w };
  };
}

// 按字符贪心换行：同时支持按词换行（拉丁语）与逐字换行（中日韩）
export function wrapLines(content, maxWidth, measureOne) {
  const paragraphs = String(content ?? '').split('\n');
  const lines = [];
  for (const para of paragraphs) {
    if (para === '') {
      lines.push('');
      continue;
    }
    // 拆成 token：连续非空白词 + 空白
    const tokens = para.match(/\s+|[^\s]+/g) || [];
    let line = '';
    const isCJK = (ch) => /[⺀-鿿豈-﫿]/.test(ch);
    for (const token of tokens) {
      if (measureOne(line + token).width <= maxWidth) {
        line += token;
        continue;
      }
      // 放不下：先尝试提交当前行
      if (line.trim() !== '') {
        lines.push(line.trimEnd());
        line = '';
      }
      if (/^\s+$/.test(token)) continue;
      // 单个词仍超宽：逐字符断行（CJK 逐字、拉丁也兜底逐字）
      let rest = token;
      while (rest.length > 0) {
        let cut = rest.length;
        while (cut > 1 && measureOne(rest.slice(0, cut)).width > maxWidth) cut--;
        const piece = rest.slice(0, cut);
        rest = rest.slice(cut);
        if (rest.length === 0) {
          line = piece; // 最后一段留给统一提交
        } else {
          lines.push(piece);
          void isCJK;
        }
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// 测量整个文本块。返回排版结果与是否溢出
export function layoutText(element, doc, measureFn, opts = {}) {
  const t = opts.t ?? 1;
  const tp = element.text;
  const padding = element.padding ?? { left: 16, right: 16, top: 10, bottom: 10 };
  const maxWidth = Math.max(4, element.width - padding.left - padding.right);
  const lineHeight = tp.fontSize * tp.leading;
  const measureOne = (s) => measureFn(fontString(tp), s);

  const lines = wrapLines(tp.content, maxWidth, measureOne);
  const lineMetrics = lines.map((ln) => ({ text: ln, width: measureOne(ln).width }));
  const longestLine = Math.max(1, ...lineMetrics.map((l) => l.width));
  const requiredHeight = lineMetrics.length * lineHeight + padding.top + padding.bottom;
  const requiredWidth = longestLine + padding.left + padding.right;
  const overflow = requiredHeight > element.height + 0.5 || requiredWidth > element.width + 0.5;

  // 可见字符（打字机）
  let visibleChars = null;
  if (opts.entranceState?.visibleChars !== null && opts.entranceState?.visibleChars !== undefined) {
    visibleChars = opts.entranceState.visibleChars;
  }

  return {
    lines: lineMetrics,
    lineHeight,
    requiredHeight,
    requiredWidth,
    overflow,
    overflowLines: Math.max(0, Math.ceil((requiredHeight - element.height) / lineHeight)),
    visibleChars,
    padding,
    fontSize: tp.fontSize,
    t,
  };
}

// 自动缩字号：在 [MIN_FONT_SIZE, 当前字号] 之间二分/递减找到可容纳的字号
export function autofitFontSize(element, doc, measureFn) {
  const original = element.text.fontSize;
  if (original <= MIN_FONT_SIZE) {
    return { fontSize: original, fits: !layoutText(element, doc, measureFn).overflow, requiredFontSize: original };
  }
  let lo = MIN_FONT_SIZE;
  let hi = original;
  let best = null;
  // 先测当前字号
  if (!layoutText(element, doc, measureFn).overflow) {
    return { fontSize: original, fits: true, requiredFontSize: original };
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const probe = { ...element, text: { ...element.text, fontSize: mid } };
    if (!layoutText(probe, doc, measureFn).overflow) {
      best = mid;
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 0.5) break;
  }
  if (best === null) {
    return { fontSize: MIN_FONT_SIZE, fits: false, requiredFontSize: MIN_FONT_SIZE };
  }
  return { fontSize: clamp(Math.floor(best * 10) / 10, MIN_FONT_SIZE, original), fits: true, requiredFontSize: best };
}

// 供 safe-area 校验使用的测量摘要
export function measureSummary(element, doc, measureFn, t = 1, entranceState = null) {
  const layout = layoutText(element, doc, measureFn, { t, entranceState });
  const fit = autofitFontSize(element, doc, measureFn);
  return {
    overflow: layout.overflow,
    overflowLines: layout.overflowLines,
    requiredHeight: layout.requiredHeight,
    requiredWidth: layout.requiredWidth,
    fontSizeBelowMin: !fit.fits,
    requiredFontSize: Math.round(fit.requiredFontSize),
    minFontSize: MIN_FONT_SIZE,
  };
}
