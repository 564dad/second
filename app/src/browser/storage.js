// 本地持久化：localStorage 自动保存与恢复。
const KEY = 'subtitle-editor-autosave-v1';

export const storage = {
  save(doc) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ savedAt: new Date().toISOString(), doc }));
      return true;
    } catch (e) {
      // 容量超限（通常是内嵌大图/字体）：提示而非静默失败
      throw new Error(`自动保存失败：${e.name === 'QuotaExceededError' ? '浏览器存储容量不足，请改用「保存工程」导出 JSON 文件' : e.message}`);
    }
  },
  load() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  clear() {
    localStorage.removeItem(KEY);
  },
  key: KEY,
};

export function download(filename, content, mime = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadDataURL(filename, dataURL) {
  const a = document.createElement('a');
  a.href = dataURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
