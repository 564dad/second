/*
 * pipeline.js — 纯函数层：几何换算 + 像素滤镜管线。
 * 不依赖 DOM / canvas，浏览器和 node 测试脚本共用同一份实现。
 * 预览与导出走的就是这里的同一套函数，保证两边结果一致。
 */
(function (root) {
  'use strict';

  var DEG = Math.PI / 180;

  // ---------- 几何 ----------

  // 旋转后画布（包围盒）尺寸。theta 为角度制，顺时针为正。
  function rotatedSize(sw, sh, thetaDeg) {
    var t = thetaDeg * DEG;
    var c = Math.abs(Math.cos(t));
    var s = Math.abs(Math.sin(t));
    return {
      w: Math.max(1, Math.round(sw * c + sh * s)),
      h: Math.max(1, Math.round(sw * s + sh * c))
    };
  }

  // 旋转后坐标 -> 源图坐标
  function rotToSrc(px, py, rw, rh, sw, sh, thetaDeg) {
    var t = thetaDeg * DEG;
    var cos = Math.cos(t), sin = Math.sin(t);
    var dx = px - rw / 2, dy = py - rh / 2;
    return {
      x: sw / 2 + dx * cos + dy * sin,
      y: sh / 2 - dx * sin + dy * cos
    };
  }

  // 源图坐标 -> 旋转后坐标
  function srcToRot(px, py, rw, rh, sw, sh, thetaDeg) {
    var t = thetaDeg * DEG;
    var cos = Math.cos(t), sin = Math.sin(t);
    var dx = px - sw / 2, dy = py - sh / 2;
    return {
      x: rw / 2 + dx * cos - dy * sin,
      y: rh / 2 + dx * sin + dy * cos
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // 把选区（中心点 + 宽高，旋转后坐标系）夹进 rw×rh 内
  function clampSel(sel, rw, rh) {
    var w = Math.min(sel.w, rw);
    var h = Math.min(sel.h, rh);
    return {
      cx: clamp(sel.cx, w / 2, rw - w / 2),
      cy: clamp(sel.cy, h / 2, rh - h / 2),
      w: w,
      h: h
    };
  }

  // 旋转角变化时，把选区从旧旋转坐标系映射到新坐标系：
  // 中心点跟着内容走（经源图坐标中转），尺寸不变（旋转不改变缩放），
  // 越界则等比缩小并夹回画布内。lockedRatio 为 w/h 或 null。
  function remapSelOnRotation(sel, oldR, newR, sw, sh, oldTheta, newTheta, lockedRatio) {
    var srcP = rotToSrc(sel.cx, sel.cy, oldR.w, oldR.h, sw, sh, oldTheta);
    var newC = srcToRot(srcP.x, srcP.y, newR.w, newR.h, sw, sh, newTheta);
    var w = sel.w, h = sel.h;
    if (lockedRatio) {
      h = w / lockedRatio;
    }
    // 等比缩小直到放得下
    var fit = Math.min(1, newR.w / w, newR.h / h);
    w *= fit; h *= fit;
    return clampSel({ cx: newC.x, cy: newC.y, w: w, h: h }, newR.w, newR.h);
  }

  // 切换锁定比例：保持焦点（中心）不动，尽量保持当前宽度，
  // 放不下就等比缩小，最后把中心夹回合法范围。
  function applyRatio(sel, ratio, rw, rh) {
    if (!ratio) return clampSel(sel, rw, rh);
    var w = sel.w;
    var h = w / ratio;
    var fit = Math.min(1, rw / w, rh / h);
    w *= fit; h *= fit;
    return clampSel({ cx: sel.cx, cy: sel.cy, w: w, h: h }, rw, rh);
  }

  // 选区 -> 左上角矩形（导出 / manifest 用），坐标取整并保证在画布内
  function selToRect(sel, rw, rh) {
    var s = clampSel(sel, rw, rh);
    var x = clamp(Math.round(s.cx - s.w / 2), 0, rw - 1);
    var y = clamp(Math.round(s.cy - s.h / 2), 0, rh - 1);
    var w = clamp(Math.round(s.w), 1, rw - x);
    var h = clamp(Math.round(s.h), 1, rh - y);
    return { x: x, y: y, w: w, h: h };
  }

  // 导出尺寸：给定目标宽度，按选区比例算高度
  function exportSize(sel, rw, rh, targetW) {
    var r = selToRect(sel, rw, rh);
    return {
      w: targetW,
      h: Math.max(1, Math.round(targetW * r.h / r.w))
    };
  }

  // ---------- 像素滤镜 ----------
  // filters: { bri, con, sat, tmp } 均为 -100..100
  // 顺序：色温(加性) -> 亮度(乘性) -> 对比度(绕128) 合成每通道 LUT，再做饱和度混合。
  // sat = -100 时输出严格 r=g=b（真灰度）。

  function clamp8(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  function buildLUTs(f) {
    var tShift = f.tmp * 0.3;              // ±30
    var bf = 1 + f.bri / 100;              // 0..2
    var cf = 1 + f.con / 100;              // 0..2
    var shifts = [tShift, 0, -tShift];     // R 加、B 减 = 暖；反之为冷
    var luts = [];
    for (var c = 0; c < 3; c++) {
      var lut = new Uint8ClampedArray(256);
      var sh = shifts[c];
      for (var v = 0; v < 256; v++) {
        lut[v] = clamp8(Math.round(((v + sh) * bf - 128) * cf + 128));
      }
      luts.push(lut);
    }
    return luts;
  }

  // 就地修改 ImageData.data，返回同一对象（方便测试）。
  function applyFilter(imageData, f) {
    var d = imageData.data;
    var luts = buildLUTs(f);
    var lr = luts[0], lg = luts[1], lb = luts[2];
    var s = 1 + f.sat / 100;
    var doSat = f.sat !== 0;
    for (var i = 0, n = d.length; i < n; i += 4) {
      var r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
      if (doSat) {
        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = clamp8(Math.round(lum + (r - lum) * s));
        g = clamp8(Math.round(lum + (g - lum) * s));
        b = clamp8(Math.round(lum + (b - lum) * s));
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
    return imageData;
  }

  var PRESETS = {
    original: { bri: 0, con: 0, sat: 0, tmp: 0 },
    film:     { bri: 8, con: 12, sat: -20, tmp: 18 },
    mono:     { bri: 0, con: 0, sat: -100, tmp: 0 },
    contrast: { bri: -5, con: 45, sat: 12, tmp: 0 }
  };

  var RATIOS = {
    'free': null,
    '16:9': 16 / 9,
    '4:3': 4 / 3,
    '1:1': 1,
    '3:4': 3 / 4,
    '9:16': 9 / 16
  };

  var api = {
    rotatedSize: rotatedSize,
    rotToSrc: rotToSrc,
    srcToRot: srcToRot,
    clamp: clamp,
    clampSel: clampSel,
    remapSelOnRotation: remapSelOnRotation,
    applyRatio: applyRatio,
    selToRect: selToRect,
    exportSize: exportSize,
    applyFilter: applyFilter,
    buildLUTs: buildLUTs,
    PRESETS: PRESETS,
    RATIOS: RATIOS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pipeline = api;
})(typeof self !== 'undefined' ? self : this);
