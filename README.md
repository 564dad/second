# 实木地板贴图生成器

纯静态页面，无框架、无构建步骤，纹理全部由 canvas 现场计算，不加载任何外部图片。

## 使用

任意静态服务器指向本目录即可，例如：

```
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- 板材按行排布、行与行错缝；板长、板宽、错缝比例、年轮密度、木纹扭曲、
  结疤概率、色差、光泽度、缝隙深度均可调
- 每块板的底色与光泽度独立抖动，不会一片塑料感
- 板缝是真实的高度凹槽（平底 + 光滑缝壁），法线图里能看见凹沟
- 结疤按板生成并限制在板内，绝不跨板缝
- 同一 seed 重复生成逐像素一致
- 右侧九宫格平铺预览，可切换 200% 放大检查接缝
- 一键导出底色 / 法线 / 粗糙度三张 PNG，512 与 1024 各一版

## 文件

- `index.html` / `style.css` / `app.js` — 界面
- `wood.js` — 生成核心（纯计算，无 DOM，node 可直接 require）
- `test/verify.js` — 验收脚本：`node test/verify.js`
- `test/render-preview.js` — 命令行出图：`node test/render-preview.js [seed]`
