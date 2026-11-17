# 字幕模板编辑器（News / Story / Cue）

纯原生 ES Module 实现的字幕模板编辑器，**零运行时依赖、无需构建**。
Canvas 绘制字幕与安全框，Web Audio 提供节拍，SVG/PNG 导出与预览共用同一条渲染管线。

## 运行

```bash
# 方式一：内置零依赖静态服务器（推荐，ES Module 不能用 file:// 直接打开）
node tools/serve.mjs          # 然后访问 http://localhost:5173/app/

# 方式二：任意静态服务器
npx serve .
```

## 测试

```bash
npm test
# 或分别运行：
node test/run-tests.mjs       # 33 项纯逻辑测试（布局/安全区/撤销/序列化/SVG/边界案例）
node test/smoke-dom.mjs       # 12 项 jsdom DOM 冒烟测试（完整 UI 交互与导出链路）
```

测试运行时依赖仅用于 Node 环境（jsdom），应用本身不依赖任何第三方库。

## 功能与需求对照

| 需求 | 实现 |
| --- | --- |
| 新闻 / 剧情 / 提示卡三种模板 | `src/core/templates.js`，分数坐标定义，与分辨率无关 |
| 用户输入文本，调字号/背景/入场动画 | 右侧属性面板 + 画布双击原位编辑；入场含淡入、上滑、左滑、缩放、打字机 |
| 切换模板不丢失文本 | `carryText()` 按 role 迁移文本与字体偏好，有测试覆盖 |
| 导出当前帧与模板 JSON | 顶部工具栏；帧 JSON 同时保留 `editable` 原始参数与 `layout` 插值结果 |
| Canvas 画字幕与安全框 | `src/browser/canvas-renderer.js`，动作安全区（蓝）与标题安全区（青）虚线框 |
| Web Audio 节拍 | `src/browser/audio.js`，lookahead 精确调度的节拍器，可 BPM 同步预览 |
| 撤销 / 重做 / 保存 / 重新载入 | 快照式 `History`（100 步）、Ctrl+Z / Ctrl+Shift+Z / Ctrl+S、工程 JSON 单文件 |
| 文字与图形都可编辑 | 元素列表 + 属性面板；SVG 导出为真实 `<text>`/`<rect>`/`<ellipse>`，**非截图烧录** |
| 缩放 / 移动 / 重排后仍在安全区 | 画布拖拽、8 向手柄缩放、画布改尺寸时 `reflowForResize` 等比重排（关键帧同步），每次校验 |
| 导出与预览一致 | Canvas 与 SVG 都消费同一个 `computeScene()` 结果，坐标/基线逐元素一致，有测试 |
| 不通过烧录截图绕过可编辑输出 | SVG 内嵌完整工程 JSON（`<metadata>`），可直接重新载入恢复 |
| 模板/字体/图片/关键帧保存后一致恢复 | 资产以 dataURL 内嵌工程；往返深度相等测试覆盖（时间戳除外） |
| 导出检查安全边距与裁切、保留参数 | 导出前弹窗列出每条 error/warn 与**具体修复建议**，可选「一键修复」 |
| 极端长文本 / 极小尺寸 | 边界案例 160×90 + 111 字长文；最小字号 6px 仍放不下时报 `FONT_TOO_SMALL`，不静默截断 |
| 错误提示如何修复 | 所有校验 issue 带 `fix` 文案；Toast/模态框分级展示，无静默失败路径 |

## 默认案例与边界案例

- **默认案例**：1280×720 新闻下沿条，4 个元素全部位于标题安全区内，零校验错误。
- **边界案例**（顶部「边界案例」按钮）：
  - 160×90 极小画布；
  - 正文 111 字符极端长文本，容器被压到 60×26，强制触发最小可读字号约束；
  - 装饰圆点故意挪到画布外，制造越界；
  - 标题带自定义关键帧，验证随缩放一致恢复。
  - 载入后校验面板列出全部错误与修复方法；「一键修复」把几何越界收回标题安全区，文本字符数保持不变。

## 目录结构

```
app/
  index.html              # 入口
  styles.css
  src/
    core/                 # 纯逻辑（Node 可直接测试，不依赖 DOM）
      document.js         # 文档模型、默认/边界案例、迁移
      templates.js        # 三模板、文本迁移、尺寸重排
      text.js             # 换行、测量、自动缩字号
      safe-area.js        # 安全区、校验、一键修复
      easing.js           # 缓动、关键帧插值、入场状态
      render-scene.js     # 统一渲染场景（Canvas/SVG 共用）
      svg.js              # 可编辑 SVG 导出
      serialize.js        # 工程/模板/帧 JSON、模板导入
      history.js          # 撤销重做
      util.js
    browser/              # 浏览器适配层
      canvas-renderer.js  # Canvas 2D 渲染 + PNG 导出
      overlay.js          # 选择/拖拽/缩放/原位编辑
      audio.js            # Web Audio 节拍器
      assets.js           # 字体 @font-face、图片内嵌
      storage.js          # localStorage 自动保存、下载
      dialogs.js          # Toast / 模态框
    main.js               # 控制器与 UI 绑定
test/
  run-tests.mjs           # 纯逻辑测试
  smoke-dom.mjs           # jsdom 冒烟测试
  mock-canvas.js
tools/
  serve.mjs               # 零依赖静态服务器
```

## 数据模型要点

- 元素坐标为绝对像素；模板 JSON 用分数坐标（`fx/fy/fw/fh`、`fontScale`）归一化，任意尺寸可重建。
- 安全区按宽、高分别按百分比计算，非标准画幅也能得到正确边距。
- 全屏背景元素（如剧情暗角遮罩，`background: true`）有意豁免安全区检查。
- 工程 JSON 含 `schemaVersion`，载入时 `migrateDocument` 补全缺省字段；高版本文件给出明确报错。
