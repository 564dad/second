// DOM 冒烟测试：在 jsdom + mock Canvas/Audio 环境中启动完整应用，
// 验证初始化、模板切换保文本、撤销、UI 导出链路与自动保存。
import { JSDOM } from './vendor/node_modules/jsdom/lib/api.js';
import { Mock2D } from './mock-canvas.js';
import { autoRepair, validateDocument } from '../app/src/core/safe-area.js';
import { measureSummary } from '../app/src/core/text.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '../app/index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// jsdom 会吞掉事件处理器中的异常，这里显式收集，测试末尾统一失败
const windowErrors = [];
window.addEventListener('error', (e) => windowErrors.push(e.error?.stack || e.message));
process.on('uncaughtException', (e) => windowErrors.push('uncaughtException: ' + (e.stack || e)));

// ---- 浏览器 API mock ----
window.HTMLCanvasElement.prototype.getContext = function () {
  if (!this._mockCtx) this._mockCtx = new Mock2D();
  return this._mockCtx;
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,MOCKPNG';
class MockFontFace {
  constructor(family) { this.family = family; this.status = 'loaded'; }
  async load() { return this; }
}
window.FontFace = MockFontFace;
window.document.fonts = { add() {}, has: () => false };
window.AudioContext = class {
  constructor() { this.currentTime = 0; this.destination = {}; }
  async resume() {}
  createOscillator() { return { connect() {}, start() {}, stop() {}, frequency: { value: 0 } }; }
  createGain() { return { connect() {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
};
window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};
class MockImage {
  set src(v) { this._src = v; setTimeout(() => this.onload?.(), 0); }
  get src() { return this._src; }
}
window.Image = MockImage;
class MockFileReader {
  readAsDataURL() { this.result = 'data:application/octet-stream;base64,AAAA'; setTimeout(() => this.onload?.(), 0); }
}
window.FileReader = MockFileReader;

for (const k of ['window', 'document', 'localStorage', 'FontFace', 'AudioContext', 'Image', 'FileReader', 'URL', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'Blob', 'File']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.performance = window.performance;

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.stack?.split('\n').slice(0, 6).join('\n     ') || e.message}`); }
}

// 加载应用模块并触发 DOMContentLoaded
await import('../app/src/main.js');
window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
const app = window.__app;
const $ = (id) => window.document.getElementById(id);

console.log('\n== DOM 冒烟测试 ==');
await t('应用初始化：4 个默认元素、选中态、画布有绘制调用', () => {
  assert.equal(app.doc.elements.length, 4);
  assert.ok(app.selectedId);
  const ctx = $('canvas')._mockCtx;
  assert.ok(ctx.calls.some((c) => c.name === 'fillRect'));
  assert.ok($('element-list').children.length === 4);
});

await t('切换模板不丢文本（UI 按钮）', () => {
  const headline = app.doc.elements.find((e) => e.role === 'headline');
  headline.text.content = '冒烟测试头条XYZ';
  $('tp-text').value = '冒烟测试头条XYZ';
  const storyBtn = [...window.document.querySelectorAll('.tpl-btn')].find((b) => b.dataset.tpl === 'story');
  storyBtn.click();
  assert.equal(app.doc.templateId, 'story');
  const h2 = app.doc.elements.find((e) => e.role === 'headline');
  assert.equal(h2.text.content, '冒烟测试头条XYZ');
});

await t('撤销/重做按钮状态与行为', () => {
  assert.equal($('btn-undo').disabled, false);
  $('btn-undo').click();
  assert.equal(app.doc.templateId, 'news');
  $('btn-redo').click();
  assert.equal(app.doc.templateId, 'story');
});

await t('属性编辑：字号修改进入撤销栈并触发重绘', () => {
  app.select(app.doc.elements.find((e) => e.type === 'text').id);
  const before = app.selected.text.fontSize;
  $('tp-size').value = String(before + 10);
  $('tp-size').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('tp-size').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(app.selected.text.fontSize, before + 10);
  assert.equal($('btn-undo').disabled, false);
});

await t('边界案例载入并产生校验错误，且每条带修复建议', async () => {
  $('btn-case-edge').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(app.doc.canvas.width, 160);
  const items = $('validate-list').children;
  assert.ok(items.length > 0);
  for (const li of items) assert.ok(li.textContent.includes('修复'));
});

await t('一键修复把所有元素收回标题安全区', () => {
  const n = autoRepair(app.doc, app.time);
  assert.ok(n >= 1, `应至少修复 1 个越界元素，实际 ${n}`);
  const issues = validateDocument(app.doc, 1, (el) => measureSummary(el, app.doc, app.measureFn, 1));
  const boxErrors = issues.filter((i) => ['CLIPPED_BY_CANVAS', 'OUTSIDE_TITLE_SAFE', 'OUTSIDE_ACTION_SAFE'].includes(i.code));
  assert.deepEqual(boxErrors, [], boxErrors.map((e) => e.message));
  // 极端长文本的排版错误仍应保留（无法靠几何修复），且带修复建议
  const textIssues = issues.filter((i) => ['TEXT_OVERFLOW', 'FONT_TOO_SMALL'].includes(i.code));
  assert.ok(textIssues.length > 0);
  assert.ok(textIssues.every((i) => i.fix.length > 5));
});

await t('自动保存写入 localStorage 且可读回', () => {
  $('btn-autosave').click();
  const raw = window.localStorage.getItem('subtitle-editor-autosave-v1');
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.doc.canvas.width, app.doc.canvas.width);
});

await t('SVG 导出链路：弹窗确认后产出可编辑 SVG 下载', async () => {
  $('btn-case-default').click();
  let downloaded = null;
  const origClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { downloaded = { href: this.href, name: this.download }; };
  $('btn-export-svg').click();
  await new Promise((r) => setTimeout(r, 10));
  $('modal-ok').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(downloaded);
  assert.ok(downloaded.name.endsWith('.svg'));
  assert.ok(downloaded.href.startsWith('blob:'));
  window.HTMLAnchorElement.prototype.click = origClick;
});

await t('PNG 导出链路：离屏渲染并触发下载', async () => {
  let downloaded = null;
  const origClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { downloaded = this.download; };
  $('btn-export-png').click();
  await new Promise((r) => setTimeout(r, 10));
  $('modal-ok').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(downloaded?.endsWith('.png'));
  window.HTMLAnchorElement.prototype.click = origClick;
});

await t('模板 JSON 与当前帧 JSON 导出', () => {
  let names = [];
  const origClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () { names.push(this.download); };
  $('btn-export-tpl').click();
  $('btn-export-frame').click();
  window.HTMLAnchorElement.prototype.click = origClick;
  assert.ok(names.some((n) => n.includes('模板')));
  assert.ok(names.some((n) => n.includes('当前帧')));
});

await t('模板 JSON 导出后可重新导入并保留当前文本', async () => {
  // 先修改文本并导出模板
  app.select(app.doc.elements.find((e) => e.type === 'text').id);
  const role = app.selected.role;
  app.selected.text.content = '导入往返专用文本';
  const { serializeTemplate, documentFromTemplate } = await import('../app/src/core/serialize.js');
  const { carryText } = await import('../app/src/core/templates.js');
  const tpl = JSON.parse(serializeTemplate(app.doc));
  const rebuilt = documentFromTemplate(tpl, app.doc.canvas);
  carryText(app.doc.elements, rebuilt.elements); // 与 main.js 导入路径一致
  assert.equal(rebuilt.elements.find((e) => e.role === role).text.content, '导入往返专用文本');
  assert.equal(rebuilt.canvas.width, app.doc.canvas.width);
  // 损坏模板必须抛出可操作错误
  assert.throws(() => documentFromTemplate({ kind: 'wrong' }), /模板 JSON/);
});

await t('节拍器可以启动并闪烁（Web Audio mock）', async () => {
  $('btn-metro').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok($('btn-metro').textContent.includes('开'));
  $('btn-metro').click();
  assert.ok($('btn-metro').textContent.includes('关'));
});

await t('键盘 Ctrl+Z 撤销', () => {
  // 先做一次真实编辑（切模板），再用键盘撤销
  [...window.document.querySelectorAll('.tpl-btn')].find((b) => b.dataset.tpl === 'cue').click();
  assert.equal(app.doc.templateId, 'cue');
  const ev = new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true });
  window.dispatchEvent(ev);
  assert.equal(app.doc.templateId, 'news');
});

console.log(`\nDOM 冒烟结果：${passed} 通过，${failed} 失败`);
if (windowErrors.length) {
  console.error('\n窗口运行时错误：');
  for (const e of windowErrors) console.error(e.split('\n').slice(0, 4).join('\n') + '\n');
  process.exit(1);
}
if (failed) process.exit(1);
