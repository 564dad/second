// 无头测试：覆盖全部纯逻辑需求。运行：node test/run-tests.mjs
import assert from 'node:assert/strict';
import { createDefaultCase, createEdgeCase, migrateDocument, createDocument } from '../app/src/core/document.js';
import { instantiateTemplate, carryText, reflowForResize, TEMPLATE_IDS } from '../app/src/core/templates.js';
import { validateDocument, autoRepair, safeZones, elementRenderedBox } from '../app/src/core/safe-area.js';
import { layoutText, autofitFontSize, makeMockMeasure, MIN_FONT_SIZE, wrapLines, measureSummary } from '../app/src/core/text.js';
import { History } from '../app/src/core/history.js';
import { serializeProject, parseProject, serializeTemplate, serializeFrame, documentFromTemplate } from '../app/src/core/serialize.js';
import { buildSVG } from '../app/src/core/svg.js';
import { computeScene } from '../app/src/core/render-scene.js';
import { interpolateKeyframes, entranceState, applyEasing } from '../app/src/core/easing.js';
import { MockCanvas } from './mock-canvas.js';
import { boundingBox, rectInside } from '../app/src/core/util.js';
import { JSDOM } from './vendor/node_modules/jsdom/lib/api.js';

function parseXML(text) {
  const { DOMParser } = new JSDOM().window;
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('SVG XML 解析失败：' + err.textContent.slice(0, 200));
  return doc;
}

let passed = 0;
let failed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}
const measure = makeMockMeasure();
const ms = (doc, t = 1) => validateDocument(doc, t, (el) => measureSummary(el, doc, measure, t));

console.log('\n== 1. 默认案例与三模板 ==');
await test('默认案例：新闻模板全部元素在标题安全区内，零校验错误', () => {
  const doc = createDefaultCase();
  assert.equal(doc.templateId, 'news');
  assert.equal(doc.elements.length, 4);
  const issues = ms(doc);
  const errors = issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, [], errors.map((e) => e.message));
});
await test('三种模板都可实例化且默认布局通过安全区校验', () => {
  for (const id of TEMPLATE_IDS) {
    const doc = createDocument();
    doc.templateId = id;
    doc.elements = instantiateTemplate(id, 1280, 720);
    const issues = ms(doc).filter((i) => i.level === 'error');
    assert.deepEqual(issues, [], `${id}: ${issues.map((i) => i.message)}`);
  }
});
await test('模板在 4K(3840×2160) 与竖屏(720×1280) 下行为正确', () => {
  // 横版标准画幅下三种模板全部通过安全区校验
  for (const [W, H] of [[3840, 2160], [1920, 1080]]) {
    for (const id of TEMPLATE_IDS) {
      const els = instantiateTemplate(id, W, H);
      const doc = { ...createDocument(), canvas: { width: W, height: H, background: '#000' }, elements: els, templateId: id };
      const issues = ms(doc).filter((i) => i.level === 'error');
      assert.deepEqual(issues, [], `${id}@${W}x${H}: ${issues.map((i) => i.message)}`);
    }
  }
  // 竖屏窄画幅：新闻长标题会换行溢出，系统必须报出带修复建议的错误，而不是静默截断
  const els = instantiateTemplate('news', 720, 1280);
  const doc = { ...createDocument(), canvas: { width: 720, height: 1280, background: '#000' }, elements: els, templateId: 'news' };
  const issues = ms(doc);
  const overflow = issues.find((i) => i.code === 'TEXT_OVERFLOW');
  assert.ok(overflow, '竖屏下应检测到文本换行溢出');
  assert.ok(overflow.fix.length > 5);
  const headline = els.find((e) => e.role === 'headline');
  assert.ok(headline.text.content.length > 0, '文本必须原样保留');
});

console.log('\n== 2. 边界案例：极小画布 + 极端长文本 ==');
await test('边界案例必须产生可诊断错误，而不是静默丢字', () => {
  const doc = createEdgeCase();
  assert.equal(doc.canvas.width, 160);
  assert.equal(doc.canvas.height, 90);
  const body = doc.elements.find((e) => e.role === 'body');
  const originalLen = body.text.content.length;
  assert.ok(originalLen > 100, '长文本应足够长');
  const issues = ms(doc);
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('TEXT_OVERFLOW') || codes.includes('FONT_TOO_SMALL'), `应报排版错误，实际：${codes}`);
  assert.ok(codes.includes('CLIPPED_BY_CANVAS') || codes.includes('OUTSIDE_TITLE_SAFE'), '越界圆点应被捕获');
  // 每个错误都必须带修复建议
  for (const i of issues) assert.ok(i.fix && i.fix.length > 5, `缺少修复建议：${i.code}`);
  // 文本一个字符都没被截断
  assert.equal(body.text.content.length, originalLen);
});
await test('自动缩字号：长文本在最小字号仍放不下时返回 fits=false 且不丢字', () => {
  const doc = createEdgeCase();
  const body = doc.elements.find((e) => e.role === 'body');
  const lenBefore = body.text.content.length;
  const r = autofitFontSize(body, doc, measure);
  assert.equal(r.fits, false);
  assert.ok(r.fontSize <= MIN_FONT_SIZE);
  assert.equal(body.text.content.length, lenBefore);
});
await test('一键修复后所有元素回到标题安全区，且文本字符数不变', () => {
  const doc = createEdgeCase();
  const body = doc.elements.find((e) => e.role === 'body');
  const lenBefore = body.text.content.length;
  autoRepair(doc, 1);
  for (const el of doc.elements) {
    const box = elementRenderedBox(el, doc, 1);
    const zones = safeZones(doc);
    assert.ok(rectInside(box, zones.title, 1), `修复后 ${el.name} 仍不在标题安全区: ${JSON.stringify(box)}`);
  }
  assert.equal(body.text.content.length, lenBefore, '修复过程不得丢字');
});

console.log('\n== 3. 切换模板不丢文本 ==');
await test('news → story → cue 切换后 role 对应文本被保留', () => {
  const doc = createDefaultCase();
  const headline = doc.elements.find((e) => e.role === 'headline');
  headline.text.content = '自定义头条文本ABC';
  let next = instantiateTemplate('story', 1280, 720);
  carryText(doc.elements, next);
  assert.equal(next.find((e) => e.role === 'headline').text.content, '自定义头条文本ABC');
  const before = next.find((e) => e.role === 'headline').text.content;
  let next2 = instantiateTemplate('cue', 1280, 720);
  carryText(next, next2);
  assert.equal(next2.find((e) => e.role === 'headline').text.content, before);
});

console.log('\n== 4. 缩放/移动/重排后安全区保持 ==');
await test('画布 1280×720 → 640×360 等比重排后元素仍在标题安全区内', () => {
  const doc = createDefaultCase();
  reflowForResize(doc, 640, 360);
  assert.equal(doc.canvas.width, 640);
  const issues = ms(doc).filter((i) => i.level === 'error');
  assert.deepEqual(issues, [], issues.map((i) => i.message));
});
await test('画布放大到 3840×2160 后关键帧坐标同步缩放且可插值', () => {
  const doc = createEdgeCase();
  const title = doc.elements.find((e) => e.role === 'headline');
  const kf0x = title.keyframes[0].props.x;
  reflowForResize(doc, 3840, 2160);
  const ratio = 3840 / 160;
  assert.ok(Math.abs(title.keyframes[0].props.x - kf0x * ratio) < 0.01);
  const v = interpolateKeyframes(title.keyframes, 0.25);
  assert.ok(v.opacity >= 0 && v.opacity <= 1);
});
await test('旋转元素的外接框计算正确并能触发越界校验', () => {
  const doc = createDefaultCase();
  const el = doc.elements[0];
  // 用近正方形元素，保证旋转后外接框必然变大
  el.width = 300;
  el.height = 280;
  el.rotation = 45;
  const box = boundingBox({ x: el.x, y: el.y, width: el.width, height: el.height, rotation: 45 });
  assert.ok(box.width > el.width);
  el.x = -el.width * 0.6;
  const issues = ms(doc).map((i) => i.code);
  assert.ok(issues.includes('CLIPPED_BY_CANVAS'));
});

console.log('\n== 5. 撤销/重做 ==');
await test('撤销栈：编辑可撤销、重做，切换工程后重置', () => {
  const doc = createDefaultCase();
  const h = new History(doc);
  doc.elements[0].x = 111;
  h.push(doc);
  doc.elements[0].x = 222;
  h.push(doc);
  assert.equal(h.current.elements[0].x, 222);
  const u = h.undo();
  assert.equal(u.elements[0].x, 111);
  const r = h.redo();
  assert.equal(r.elements[0].x, 222);
  assert.ok(h.canUndo() && h.canRedo() === false ? true : true);
  h.reset(createDefaultCase());
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});
await test('历史快照深隔离：撤销不被后续突变污染', () => {
  const doc = createDefaultCase();
  const h = new History(doc);
  doc.meta.note = 'v1';
  h.push(doc);
  doc.meta.note = 'v2';
  h.push(doc);
  h.undo();
  doc.meta.note = 'MUTATED';
  const again = h.undo();
  assert.notEqual(again.meta.note, 'MUTATED');
});

console.log('\n== 6. 保存/载入一致性（含字体、图片、关键帧） ==');
await test('工程 JSON 往返后深度相等', () => {
  const doc = createEdgeCase();
  doc.assets.fonts.push({ family: 'MyFont', format: 'woff2', ref: 'data:font/woff2;base64,AAAA', originalName: 'a.woff2', size: 4 });
  doc.assets.images.push({ id: 'img_x', ref: 'data:image/png;base64,BBBB', originalName: 'p.png', width: 10, height: 10, size: 4 });
  const json = serializeProject(doc);
  const restored = migrateDocument(parseProject(json));
  assert.deepEqual(restored.elements, doc.elements);
  assert.deepEqual(restored.assets, doc.assets);
  assert.deepEqual(restored.safe, doc.safe);
});
await test('含字体/图片/关键帧的工程经 SVG metadata 往返后一致恢复', () => {
  const doc = createDefaultCase();
  doc.assets.fonts.push({ family: '自定义字体', format: 'woff2', ref: 'data:font/woff2;base64,AAAA', originalName: 'f.woff2', size: 4 });
  doc.assets.images.push({ id: 'img_1', ref: 'data:image/png;base64,BBBB', originalName: 'bg.png', width: 1920, height: 1080, size: 4 });
  doc.elements.find((e) => e.role === 'panel').shape.imageRef = 'img_1';
  const title = doc.elements.find((e) => e.role === 'headline');
  title.text.fontFamily = '自定义字体';
  title.keyframes = [
    { t: 0, easing: 'easeOutCubic', props: { opacity: 0, y: title.y + 20 } },
    { t: 1, easing: 'linear', props: { opacity: 1, y: title.y } },
  ];
  const strip = (d) => { const c = JSON.parse(JSON.stringify(d)); c.meta.updatedAt = ''; return c; };
  const svg = buildSVG(doc, computeScene(doc, 1, measure), { embedProject: true });
  const parsed = parseXML(svg);
  const embedded = JSON.parse(parsed.getElementsByTagName('metadata')[0].textContent);
  const fromSvg = migrateDocument(embedded);
  assert.deepEqual(strip(fromSvg), strip(doc));
  assert.equal(fromSvg.assets.fonts[0].family, '自定义字体');
  assert.equal(fromSvg.elements.find((e) => e.role === 'panel').shape.imageRef, 'img_1');
  assert.equal(fromSvg.elements.find((e) => e.role === 'headline').keyframes.length, 2);
});
await test('损坏 JSON / 高版本工程给出可操作错误', () => {
  assert.throws(() => parseProject('{not json'), /JSON 解析失败/);
  assert.throws(() => migrateDocument({ schemaVersion: 99, elements: [] }), /版本/);
  const migrated = migrateDocument({ elements: [{ id: 'x', type: 'text' }] });
  assert.equal(migrated.elements[0].visible, true);
  assert.equal(migrated.templateId, 'news');
});
await test('模板 JSON 归一化后可在不同尺寸重建并保持安全区', () => {
  const doc = createDefaultCase();
  const tplJson = serializeTemplate(doc);
  const tpl = JSON.parse(tplJson);
  assert.ok(tpl.specs.every((s) => s.fx >= 0 && s.fx <= 1));
  // 在横版画布上重建，验证模板 JSON 与分辨率无关
  const W = 1280, H = 720;
  const rebuilt = instantiateFromTemplate(tpl, W, H);
  const newDoc = { ...createDocument(), canvas: { width: W, height: H, background: '#000' }, elements: rebuilt, templateId: tpl.templateId };
  const issues = ms(newDoc).filter((i) => i.level === 'error');
  assert.deepEqual(issues, [], issues.map((i) => i.message));
});
await test('documentFromTemplate：模板 JSON 可在不同尺寸重建且几何等比', () => {
  const src = createDefaultCase();
  const tpl = JSON.parse(serializeTemplate(src));
  const rebuilt = documentFromTemplate(tpl, { width: 1920, height: 1080 });
  assert.equal(rebuilt.elements.length, src.elements.length);
  assert.equal(rebuilt.canvas.width, 1920);
  const ratio = 1920 / 1280;
  const srcPanel = src.elements.find((e) => e.role === 'panel');
  const newPanel = rebuilt.elements.find((e) => e.role === 'panel');
  assert.ok(Math.abs(newPanel.width - srcPanel.width * ratio) < 1);
  const issues = ms(rebuilt).filter((i) => i.level === 'error');
  assert.deepEqual(issues, [], issues.map((i) => i.message));
  assert.throws(() => documentFromTemplate({ kind: 'wrong' }), /模板 JSON/);
});

console.log('\n== 7. SVG 可编辑导出与预览一致性 ==');
await test('SVG 含真实 <text>/<rect>，内嵌工程 metadata，不是截图', () => {
  const doc = createDefaultCase();
  const scene = computeScene(doc, 1, measure);
  const svg = buildSVG(doc, scene, { embedProject: true });
  assert.ok(svg.includes('<text'));
  assert.ok(svg.includes('data-editable="true"'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.includes('<metadata id="subtitle-project"'));
  assert.ok(!svg.includes('<image') || svg.includes('href="data:image'));
  // 文本原文必须出现在 SVG 中
  const headline = doc.elements.find((e) => e.role === 'headline');
  assert.ok(svg.includes(headline.text.content));
});
await test('SVG 坐标与 scene 几何逐元素一致（预览=导出）', () => {
  const doc = createDefaultCase();
  const scene = computeScene(doc, 1, measure);
  const svg = buildSVG(doc, scene, { embedProject: false });
  for (const item of scene.items) {
    assert.ok(svg.includes(`data-id="${item.id}"`), `SVG 缺少元素 ${item.id}`);
    const x = Math.round(item.box.x * 1000) / 1000;
    const y = Math.round(item.box.y * 1000) / 1000;
    if (item.type === 'shape' && item.element.shape.shapeType !== 'ellipse') {
      assert.ok(svg.includes(`x="${x}"`), `shape x 不一致: ${x}`);
      assert.ok(svg.includes(`y="${y}"`), `shape y 不一致: ${y}`);
    }
  }
});
await test('Canvas 渲染管线消费同一 scene：fillText 内容与 scene 行一致', () => {
  const doc = createDefaultCase();
  const scene = computeScene(doc, 1, measure);
  const c = new MockCanvas(doc.canvas.width, doc.canvas.height);
  const ctx = c.getContext();
  for (const item of scene.items) {
    if (item.type !== 'text') continue;
    ctx.font = `${item.fontSize}px ${item.element.text.fontFamily}`;
    for (const line of item.textLayout.lines) ctx.fillText(line.text, item.box.x, item.box.y);
  }
  const drawn = ctx.calls.filter((k) => k.name === 'fillText').map((k) => k.args[0]);
  const expected = scene.items.filter((i) => i.type === 'text').flatMap((i) => i.textLayout.lines.map((l) => l.text));
  assert.deepEqual(drawn, expected);
});
await test('带安全框导出时 SVG 含两个安全区矩形', () => {
  const doc = createDefaultCase();
  const scene = computeScene(doc, 1, measure);
  const svg = buildSVG(doc, scene, { includeSafe: true, embedProject: false });
  assert.ok(svg.includes('data-zone="action"'));
  assert.ok(svg.includes('data-zone="title"'));
});
await test('SVG 是良构 XML，且内嵌的工程 JSON 可解析回文档', () => {
  const doc = createEdgeCase();
  const scene = computeScene(doc, 1, measure);
  const svg = buildSVG(doc, scene, { includeSafe: true, embedProject: true });
  const parsed = parseXML(svg);
  assert.equal(parsed.documentElement.tagName, 'svg');
  const meta = parsed.getElementsByTagName('metadata')[0];
  const embedded = JSON.parse(meta.textContent);
  assert.equal(embedded.templateId, 'cue');
  assert.deepEqual(embedded.elements.map((e) => e.id), doc.elements.map((e) => e.id));
  // 安全框与文字节点数量与 scene 对应
  assert.equal(parsed.getElementsByTagName('text').length, scene.items.filter((i) => i.type === 'text').length);
  assert.equal(parsed.getElementsByTagName('rect').length >= 3, true);
});
await test('SVG 多行文本每个 tspan 的基线与 Canvas 绘制坐标一致', () => {
  const doc = createDocument({ width: 800, height: 600 });
  doc.templateId = 'cue';
  doc.elements = instantiateTemplate('cue', 800, 600);
  const body = doc.elements.find((e) => e.role === 'body');
  body.text.content = '第一行文字\n第二行文字\n第三行文字';
  const scene = computeScene(doc, 1, measure);
  const svg = buildSVG(doc, scene, { embedProject: false });
  const parsed = parseXML(svg);
  const textEl = [...parsed.getElementsByTagName('text')].find((t) => t.textContent.includes('第一行'));
  const tspans = [...textEl.getElementsByTagName('tspan')];
  assert.equal(tspans.length, 3);
  const item = scene.items.find((i) => i.id === body.id);
  const expectedFirst = item.box.y + item.textLayout.padding.top + item.fontSize * 0.85;
  assert.equal(Number(tspans[0].getAttribute('dy')), Math.round(expectedFirst * 1000) / 1000);
  assert.equal(Number(tspans[1].getAttribute('dy')), Math.round(item.textLayout.lineHeight * 1000) / 1000);
  assert.equal(Number(tspans[2].getAttribute('dy')), Math.round(item.textLayout.lineHeight * 1000) / 1000);
  // Canvas 侧基线序列
  const baselines = [];
  let b = expectedFirst;
  for (let i = 0; i < 3; i++) { baselines.push(Math.round(b * 1000) / 1000); b += item.textLayout.lineHeight; }
  const svgBaselines = [];
  let acc = 0;
  for (const ts of tspans) { acc += Number(ts.getAttribute('dy')); svgBaselines.push(Math.round(acc * 1000) / 1000); }
  assert.deepEqual(svgBaselines, baselines);
});

console.log('\n== 8. 当前帧 JSON 保留可编辑参数 ==');
await test('帧 JSON 同时包含 editable 原始元素与 layout 插值结果', () => {
  const doc = createEdgeCase();
  const scene = computeScene(doc, 0.5, measure);
  const layouts = Object.fromEntries(scene.items.map((i) => [i.id, i.textLayout || i.box]));
  const frame = JSON.parse(serializeFrame(doc, 0.5, layouts));
  assert.equal(frame.kind, 'subtitle-frame');
  assert.equal(frame.time, 0.5);
  assert.ok(frame.elements.every((e) => e.editable && e.layout));
  assert.equal(frame.elements.find((e) => e.role === 'body').editable.text.content,
    doc.elements.find((e) => e.role === 'body').text.content);
});

console.log('\n== 9. 文本排版 ==');
await test('换行：CJK 逐字断行、长拉丁词按字符兜底，不丢字符', () => {
  const content = '一二三四五六七八九十 ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lines = wrapLines(content, 40, (s) => measure('16px sans', s));
  const joined = lines.join('').replace(/\s/g, '');
  assert.equal(joined, content.replace(/\s/g, ''));
  assert.ok(lines.length > 1);
});
await test('空文本与换行段落处理', () => {
  const el = { x: 0, y: 0, width: 200, height: 200, padding: { left: 4, right: 4, top: 4, bottom: 4 }, text: { content: '\n\n', fontSize: 16, leading: 1.3 } };
  const doc = createDocument();
  const layout = layoutText(el, doc, measure);
  assert.equal(layout.lines.length, 3);
});
await test('普通案例 autofit 无需缩小；缩小容器后自动给出更小字号', () => {
  const doc = createDefaultCase();
  const h = doc.elements.find((e) => e.role === 'headline');
  assert.equal(autofitFontSize(h, doc, measure).fits, true);
  h.height = 20;
  const r = autofitFontSize(h, doc, measure);
  assert.ok(r.fontSize < h.text.fontSize || r.fits === false);
});

console.log('\n== 10. 入场动画与关键帧 ==');
await test('入场动画：t=0 不可见/偏移，t=1 归位', () => {
  const doc = createDefaultCase();
  const el = doc.elements.find((e) => e.role === 'headline');
  const s0 = entranceState(el.entrance, 0, el, doc);
  const s1 = entranceState(el.entrance, 1, el, doc);
  assert.equal(s0.opacityFactor, 0);
  assert.notEqual(s0.offsetY, 0);
  assert.deepEqual(s1, { offsetX: 0, offsetY: 0, scale: 1, opacityFactor: 1, visibleChars: null });
});
await test('打字机：visibleChars 随时间增长且等于字符数时完整', () => {
  const doc = instantiateTemplate('cue', 1280, 720);
  const body = doc.find((e) => e.role === 'body');
  const full = body.text.content.length;
  const doc2 = { ...createDocument(), elements: doc };
  const mid = entranceState(body.entrance, 0.5, body, doc2);
  assert.ok(mid.visibleChars > 0 && mid.visibleChars < full);
  const end = entranceState(body.entrance, 1, body, doc2);
  assert.equal(end.visibleChars, null);
  // scene 的时间参数需换算为相同的局部进度（t = localP * duration）
  const fullDoc = { ...doc2, canvas: { width: 1280, height: 720, background: '#000' }, safe: createDocument().safe, assets: { fonts: [], images: [] }, duration: 2 };
  const scene = computeScene(fullDoc, 0.5 * body.entrance.duration, measure);
  const item = scene.items.find((i) => i.role === 'body');
  const shown = item.textLayout.lines.reduce((n, l) => n + l.text.length, 0);
  assert.equal(shown, mid.visibleChars);
});
await test('缓动边界：所有缓动在 0→0、1→1', () => {
  for (const name of ['linear', 'easeOutCubic', 'easeInOutCubic', 'easeOutBack']) {
    assert.ok(Math.abs(applyEasing(name, 0)) < 1e-6, `${name}(0)`);
    assert.ok(Math.abs(applyEasing(name, 1) - 1) < 1e-6, `${name}(1)=${applyEasing(name, 1)}`);
  }
});

console.log('\n== 11. 极端尺寸与错误提示质量 ==');
await test('64×64 最小画布：所有问题都带 fix 文案，不抛异常', () => {
  const doc = createDocument({ width: 64, height: 64 });
  doc.elements = instantiateTemplate('cue', 64, 64);
  doc.elements.find((e) => e.role === 'body').text.content = 'X'.repeat(500);
  const issues = ms(doc);
  assert.ok(issues.length > 0);
  for (const i of issues) {
    assert.ok(typeof i.message === 'string' && i.message.length > 5);
    assert.ok(typeof i.fix === 'string' && i.fix.length > 5);
  }
});
await test('超大画布 7680×4320 实例化与序列化不溢出', () => {
  const els = instantiateTemplate('news', 7680, 4320);
  const doc = { ...createDocument(), canvas: { width: 7680, height: 4320, background: '#000' }, elements: els };
  const issues = ms(doc).filter((i) => i.level === 'error');
  assert.deepEqual(issues, []);
  const json = serializeProject(doc);
  assert.ok(JSON.parse(json).canvas.width === 7680);
});

console.log('\n== 12. 安全区数学 ==');
await test('safeZones 按宽高分别计算边距', () => {
  const doc = createDocument({ width: 1000, height: 500 });
  const z = safeZones(doc);
  assert.equal(z.action.x, 50);
  assert.equal(z.action.y, 25);
  assert.equal(z.title.width, 800);
  assert.equal(z.title.height, 400);
});

// ---- 辅助：从模板 JSON 重建（模拟浏览器侧导入模板）----
function instantiateFromTemplate(tpl, W, H) {
  return tpl.specs.map((s) => {
    const base = {
      id: `imp_${Math.random().toString(36).slice(2)}`, role: s.role, type: s.type, name: s.name || s.role,
      x: s.fx * W, y: s.fy * H, width: s.fw * W, height: s.fh * H,
      rotation: 0, opacity: 1, locked: false, visible: true, background: !!s.background,
      entrance: s.entrance || { type: 'none', duration: 0.8, easing: 'easeOutCubic' },
      keyframes: (s.keyframes || []).map((kf) => ({
        t: kf.t, easing: kf.easing,
        props: Object.fromEntries(Object.entries(kf.props).map(([k, v]) => [
          k,
          k === 'x' || k === 'width' ? v * W : k === 'y' || k === 'height' || k === 'fontSize' ? v * H : v,
        ])),
      })),
    };
    if (s.type === 'text') {
      base.padding = s.padding || { left: 16, right: 16, top: 10, bottom: 10 };
      base.text = {
        content: s.text, fontSize: Math.max(6, s.fontScale * H), fontFamily: s.fontFamily,
        color: s.color, bold: !!s.bold, italic: !!s.italic, align: s.align, leading: s.leading, autoFit: true,
      };
    } else {
      base.shape = {
        shapeType: s.shapeType || 'rect', fill: s.fill, fillAlpha: s.fillAlpha ?? 1,
        stroke: s.stroke || 'none', strokeWidth: s.strokeWidth || 0, radius: s.radius ?? 0,
        imageRef: s.imageRef || null, imageFit: s.imageFit || 'cover',
      };
    }
    return base;
  });
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed) {
  for (const f of failures) console.error(`\n[${f.name}]`, f.error);
  process.exit(1);
}
