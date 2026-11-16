/*
 * samples.js — 用 canvas 现画 6 张带编号的假海报，不依赖任何外部素材。
 * 尺寸混排：1600×1000 / 1080×1080 / 1200×1600。
 */
(function (root) {
  'use strict';

  var SIZES = [
    [1600, 1000],
    [1080, 1080],
    [1200, 1600],
    [1600, 1000],
    [1080, 1080],
    [1200, 1600]
  ];

  var PALETTES = [
    ['#1f3b73', '#e2603f', '#f5d76e'],
    ['#0e6b5c', '#f2b134', '#ef5b5b'],
    ['#4a2b6b', '#ff8c42', '#7bdff2'],
    ['#8c2f39', '#f4a259', '#2e294e'],
    ['#22577a', '#80ed99', '#ffd166'],
    ['#3d405b', '#e07a5f', '#81b29a']
  ];

  function drawPoster(index) {
    var w = SIZES[index][0], h = SIZES[index][1];
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    var pal = PALETTES[index % PALETTES.length];

    // 背景渐变
    var g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, pal[0]);
    g.addColorStop(1, pal[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // 装饰圆
    ctx.globalAlpha = 0.25;
    for (var i = 0; i < 7; i++) {
      var r = (w + h) * 0.03 * (1 + (i % 3));
      var cx = ((i * 397 + index * 211) % 1000) / 1000 * w;
      var cy = ((i * 613 + index * 307) % 1000) / 1000 * h;
      ctx.fillStyle = i % 2 ? pal[1] : '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 斜向色带
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.35);
    ctx.fillStyle = pal[1];
    ctx.fillRect(-w, -h * 0.06, w * 2, h * 0.12);
    ctx.restore();

    // 大编号
    var num = String(index + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '900 ' + Math.round(Math.min(w, h) * 0.5) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(num, w / 2, h / 2);

    // 标题与尺寸标注
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '700 ' + Math.round(Math.min(w, h) * 0.055) + 'px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('SAMPLE POSTER #' + num, w * 0.05, h * 0.05);
    ctx.font = '500 ' + Math.round(Math.min(w, h) * 0.032) + 'px system-ui, sans-serif';
    ctx.fillText(w + ' × ' + h, w * 0.05, h * 0.05 + Math.min(w, h) * 0.075);

    // 底部横条
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, h * 0.88, w, h * 0.12);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 ' + Math.round(Math.min(w, h) * 0.04) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WEEKLY CAMPAIGN · SLOT ' + num, w / 2, h * 0.94);

    // 边框
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = Math.max(4, Math.min(w, h) * 0.008);
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);

    return cv;
  }

  root.Samples = {
    count: SIZES.length,
    sizeAt: function (i) { return { w: SIZES[i][0], h: SIZES[i][1] }; },
    draw: drawPoster
  };
})(typeof self !== 'undefined' ? self : this);
