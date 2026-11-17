// 资产管理：字体（@font-face 注册）与图片（dataURL 内嵌）。
// 纯数据部分可在 Node 测试；Blob/FileReader 部分由宿主注入。

// 读取文件为 dataURL
export function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

const FONT_FORMATS = {
  ttf: 'truetype',
  otf: 'opentype',
  woff: 'woff',
  woff2: 'woff2',
};

export function fontFormatFromName(name) {
  const ext = name.split('.').pop().toLowerCase();
  return FONT_FORMATS[ext] || 'truetype';
}

// 在浏览器中注册字体，返回 family 名
export async function registerFont(file, doc) {
  const dataURL = await fileToDataURL(file);
  const family = normalizeFamily(file.name);
  const format = fontFormatFromName(file.name);
  const fontFace = new FontFace(family, `url(${dataURL})`, { format });
  await fontFace.load();
  document.fonts.add(fontFace);
  const asset = {
    family,
    format,
    ref: dataURL,
    originalName: file.name,
    size: file.size,
  };
  const existing = doc.assets.fonts.findIndex((f) => f.family === family);
  if (existing >= 0) doc.assets.fonts[existing] = asset;
  else doc.assets.fonts.push(asset);
  return family;
}

// 从载入的工程恢复全部字体
export async function restoreFonts(doc) {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return [];
  const restored = [];
  for (const asset of doc.assets.fonts || []) {
    try {
      const fontFace = new FontFace(asset.family, `url(${asset.ref})`, { format: asset.format });
      await fontFace.load();
      if (!document.fonts.has(asset.family)) document.fonts.add(fontFace);
      restored.push(asset.family);
    } catch (e) {
      throw new Error(`字体「${asset.family}」恢复失败：${e.message}。文件可能已损坏，请重新上传。`);
    }
  }
  return restored;
}

export async function addImage(file, doc) {
  const dataURL = await fileToDataURL(file);
  const dims = await imageDimensions(dataURL);
  const asset = {
    id: `img_${Date.now().toString(36)}`,
    ref: dataURL,
    originalName: file.name,
    width: dims.width,
    height: dims.height,
    size: file.size,
  };
  doc.assets.images.push(asset);
  return asset;
}

export function imageDimensions(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解码失败：文件可能不是有效图片'));
    img.src = dataURL;
  });
}

function normalizeFamily(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w一-鿿 -]/g, ' ').trim() || 'CustomFont';
}
