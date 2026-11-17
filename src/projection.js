// projection.js — 固定斜俯视透视：逻辑台面映射成屏幕上的梯形
// 纯仿射 + 透视插值的轻量实现：y 方向带透视收缩，越远（y 越小）越窄越短。
import { TABLE } from './table.js';

export function createProjection(viewportW, viewportH) {
  // 台面在屏幕上的占比（参考 1920x1080 设计稿）
  const scaleBase = Math.min(viewportH / 1080, viewportW / 980);
  const cx = viewportW * 0.5;

  // 逻辑 y=0（远/顶部）与 y=H（近/底部）的屏幕参数
  const topY = viewportH * 0.062;
  const botY = viewportH * 0.965;
  const topHalfW = 246 * scaleBase;   // 远边窄
  const botHalfW = 322 * scaleBase;   // 近边宽

  function project(p) {
    const t = p.y / TABLE.H; // 0 远 -> 1 近
    const halfW = topHalfW + (botHalfW - topHalfW) * t;
    // 透视下的纵向挤压：远处单位逻辑长度更短
    const yScreen = topY + (botY - topY) * Math.pow(t, 0.92);
    const xScreen = cx + (p.x / TABLE.W - 0.5) * 2 * halfW;
    return { x: xScreen, y: yScreen, t };
  }

  // 逻辑半径 -> 屏幕半径（远处小、近处大）
  function projectRadius(r, p) {
    const t = p.y / TABLE.H;
    const unitX = (2 * (topHalfW + (botHalfW - topHalfW) * t)) / TABLE.W;
    return r * unitX;
  }

  // 线宽缩放（描边粗细也带透视）
  function lineWidth(w, p) {
    return Math.max(0.6, w * projectRadius(1, p));
  }

  // 台面四角屏幕坐标（画外框/底板用）
  function corners() {
    return [
      project({ x: 0, y: 0 }),
      project({ x: TABLE.W, y: 0 }),
      project({ x: TABLE.W, y: TABLE.H }),
      project({ x: 0, y: TABLE.H }),
    ];
  }

  return { project, projectRadius, lineWidth, corners, scaleBase, cx, topY, botY };
}
