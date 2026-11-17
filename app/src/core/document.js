// 文档模型工厂、默认案例与边界案例。纯数据 + 纯函数。
import { instantiateTemplate } from './templates.js';

export const SCHEMA_VERSION = 1;

export function createDocument(canvas = { width: 1280, height: 720 }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    templateId: 'news',
    canvas: { width: canvas.width, height: canvas.height, background: '#101318' },
    safe: { actionMarginPercent: 5, titleMarginPercent: 10, enforceTitleOnShapes: false },
    duration: 2,
    elements: [],
    assets: { fonts: [], images: [] },
    meta: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
  };
}

// 默认案例：1280×720 新闻模板，内容适中
export function createDefaultCase() {
  const doc = createDocument({ width: 1280, height: 720 });
  doc.templateId = 'news';
  doc.elements = instantiateTemplate('news', 1280, 720);
  doc.meta.createdAt = new Date(0).toISOString();
  return doc;
}

// 边界案例：极小画布 160×90（16:9）+ 极端长文本 + 装饰元素故意压边，
// 用于验证安全区报错、自动修复与不静默丢字。
export function createEdgeCase() {
  const doc = createDocument({ width: 160, height: 90 });
  doc.templateId = 'cue';
  doc.elements = instantiateTemplate('cue', 160, 90);
  const body = doc.elements.find((e) => e.role === 'body');
  body.text.content =
    '这是一段极端超长文本，用来检验在极小画布（160×90）上换行、安全区与最小字号约束是否仍然成立：' +
    '系统必须提示如何修复，而不是静默截断任何一个字符。ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789。';
  // 把正文容器压到极小，强制触发“最小可读字号仍放不下”的错误路径
  body.x = 20;
  body.y = 40;
  body.width = 60;
  body.height = 26;
  // 故意把装饰圆点挪到画布外，制造可被校验捕获的越界
  const dot = doc.elements.find((e) => e.role === 'accent');
  dot.x = 150;
  dot.y = -4;
  // 故意给标题加自定义关键帧，验证关键帧随缩放恢复
  const title = doc.elements.find((e) => e.role === 'headline');
  title.keyframes = [
    { t: 0, easing: 'easeOutCubic', props: { x: 16, y: 12, opacity: 0 } },
    { t: 0.5, easing: 'easeOutCubic', props: { x: 16, y: 14, opacity: 1 } },
    { t: 1, easing: 'linear', props: { x: 16, y: 12.6, opacity: 1 } },
  ];
  doc.safe.titleMarginPercent = 10;
  return doc;
}

// 迁移/校验读入的工程，保证缺字段有默认值（向前兼容）
export function migrateDocument(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('工程文件不是有效的 JSON 对象');
  if (raw.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`工程版本 ${raw.schemaVersion} 高于当前支持版本 ${SCHEMA_VERSION}，请升级应用`);
  }
  const base = createDocument(raw.canvas || {});
  const doc = {
    ...base,
    ...raw,
    canvas: { ...base.canvas, ...(raw.canvas || {}) },
    safe: { ...base.safe, ...(raw.safe || {}) },
    assets: {
      fonts: Array.isArray(raw.assets?.fonts) ? raw.assets.fonts : [],
      images: Array.isArray(raw.assets?.images) ? raw.assets.images : [],
    },
    elements: Array.isArray(raw.elements) ? raw.elements : [],
    meta: { ...base.meta, ...(raw.meta || {}) },
  };
  if (!['news', 'story', 'cue'].includes(doc.templateId)) doc.templateId = 'news';
  for (const el of doc.elements) {
    el.keyframes ||= [];
    el.entrance ||= { type: 'none', duration: 0.8, easing: 'easeOutCubic' };
    el.opacity ??= 1;
    el.rotation ||= 0;
    el.visible ??= true;
    el.locked ??= false;
    el.background ??= false;
  }
  return doc;
}
