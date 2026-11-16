// Canvas 2D 渲染器：固定机位，俯视带轻微透视
import { PLAY_W, PLAY_H, BALL_R } from './constants.js';
import {
  makeClothTexture, makeWoodTexture, makeBallSprite, makeShadowSprite,
} from './textures.js';

const RAIL_M = 0.12;          // 库边（木帮）宽度，米
const CUSHION_M = 0.045;      // 橡胶库边宽度
const SQUASH = 0.94;          // y 方向轻微透视压缩
const ROOM = 0.16;            // 四周留边（屏幕比例）

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view = { scale: 1, ox: 0, oy: 0 };
    this.sprites = new Map();
    this.shadow = null;
    this._buildAssets();
    this.resize();
    // 布局/字号稳定后及容器尺寸变化时自动重算（模块加载时 CSS 可能尚未生效）
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
  }

  _buildAssets() {
    this.cloth = makeClothTexture(256);
    this.wood = makeWoodTexture(512, 256);
    this.shadow = makeShadowSprite(60);
  }

  _ballSprite(num) {
    if (!this.sprites.has(num)) this.sprites.set(num, makeBallSprite(num, 60));
    return this.sprites.get(num);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const totalW = PLAY_W + (RAIL_M + ROOM) * 2;
    const totalH = (PLAY_H + (RAIL_M + ROOM) * 2) * SQUASH;
    const scale = Math.min(this.w / totalW, this.h / totalH);
    this.view.scale = scale;
    const drawW = totalW * scale;
    const drawH = totalH * scale;
    this.view.ox = (this.w - drawW) / 2;
    this.view.oy = (this.h - drawH) / 2;
    this._staticDirty = true;
  }

  // 静态球桌层（木框/布/库边/袋口/灯光）只在尺寸变化时重建一次
  _buildStaticLayer(game) {
    const off = document.createElement('canvas');
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const ctx = off.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const prev = this.ctx;
    this.ctx = ctx;
    this._drawRoom();
    const [cx0, cy0] = this.toScreen(-RAIL_M - 0.02, -RAIL_M - 0.02);
    const cw = (PLAY_W + (RAIL_M + 0.02) * 2) * this.view.scale;
    const ch = (PLAY_H + (RAIL_M + 0.02) * 2) * SQUASH * this.view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cw, ch);
    ctx.clip();
    this._drawWoodRails();
    this._drawCloth();
    this._drawPockets(game);
    this._drawCushions(game);
    this._drawHeadString();
    ctx.restore();
    this._drawVignette();
    this.ctx = prev;
    this._staticLayer = off;
    this._staticDirty = false;
  }

  // 台面坐标 -> 屏幕坐标
  toScreen(x, y) {
    const s = this.view.scale;
    return [
      this.view.ox + (ROOM + RAIL_M + x) * s,
      this.view.oy + (ROOM + RAIL_M + y) * SQUASH * s,
    ];
  }

  // 屏幕坐标 -> 台面坐标
  toWorld(sx, sy) {
    const s = this.view.scale;
    return [
      (sx - this.view.ox) / s - ROOM - RAIL_M,
      (sy - this.view.oy) / (SQUASH * s) - ROOM - RAIL_M,
    ];
  }

  get ballPx() {
    return BALL_R * this.view.scale;
  }

  draw(game, aim, cueAnim) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (this._staticDirty || !this._staticLayer) this._buildStaticLayer(game);
    ctx.drawImage(this._staticLayer, 0, 0, this.w, this.h);

    // 动态层裁剪在球桌木框内
    const [cx0, cy0] = this.toScreen(-RAIL_M - 0.02, -RAIL_M - 0.02);
    const cw = (PLAY_W + (RAIL_M + 0.02) * 2) * this.view.scale;
    const ch = (PLAY_H + (RAIL_M + 0.02) * 2) * SQUASH * this.view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx0, cy0, cw, ch);
    ctx.clip();
    if (aim) this._drawAim(game, aim);
    this._drawBalls(game, cueAnim);
    if (aim && (game.phase === 'aiming' || game.phase === 'charging')) {
      this._drawCue(game, aim, cueAnim);
    }
    ctx.restore();
  }

  _drawRoom() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.2,
      this.w / 2, this.h / 2, this.h * 0.85);
    g.addColorStop(0, '#242028');
    g.addColorStop(1, '#0d0b0f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  _rectWorld(x, y, w, h) {
    const [sx, sy] = this.toScreen(x, y);
    return [sx, sy, w * this.view.scale, h * SQUASH * this.view.scale];
  }

  _drawWoodRails() {
    const ctx = this.ctx;
    const s = this.view.scale;
    // 外框整体（含木纹）
    const [x0, y0] = this.toScreen(-RAIL_M, -RAIL_M);
    const w = (PLAY_W + RAIL_M * 2) * s;
    const h = (PLAY_H + RAIL_M * 2) * SQUASH * s;
    ctx.save();
    const pat = ctx.createPattern(this.wood, 'repeat');
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, w, h);
    // 木框倒角高光/暗边
    ctx.strokeStyle = 'rgba(255,220,170,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeRect(x0 - 2, y0 - 2, w + 4, h + 4);
    ctx.restore();
  }

  _drawCloth() {
    const ctx = this.ctx;
    const [x, y] = this.toScreen(0, 0);
    const w = PLAY_W * this.view.scale;
    const h = PLAY_H * SQUASH * this.view.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    const pat = ctx.createPattern(this.cloth, 'repeat');
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, w, h);
    // 光照明暗过渡：中央吊灯区更亮，边缘压暗
    const g = ctx.createRadialGradient(x + w * 0.5, y + h * 0.45, h * 0.1,
      x + w * 0.5, y + h * 0.5, h * 0.95);
    g.addColorStop(0, 'rgba(255,250,225,0.14)');
    g.addColorStop(0.6, 'rgba(255,250,225,0.02)');
    g.addColorStop(1, 'rgba(0,0,0,0.32)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  _drawCushions(game) {
    const ctx = this.ctx;
    const s = this.view.scale;
    ctx.save();
    for (const seg of game.table.segments) {
      // 沿内法线反方向画一条粗线段作为橡胶库边
      const [ax, ay] = this.toScreen(seg.ax, seg.ay);
      const [bx, by] = this.toScreen(seg.bx, seg.by);
      const nx = seg.nx, ny = seg.ny * SQUASH;
      const nl = Math.hypot(nx, ny);
      const ox = (nx / nl) * CUSHION_M * s * -1;
      const oy = (ny / nl) * CUSHION_M * s * -1;
      const grad = ctx.createLinearGradient(ax, ay, ax - nx * 10, ay - ny * 10);
      grad.addColorStop(0, '#15503a');
      grad.addColorStop(1, '#0a2c1e');
      ctx.strokeStyle = grad;
      ctx.lineWidth = CUSHION_M * s * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax + ox * 0.2, ay + oy * 0.2);
      ctx.lineTo(bx + ox * 0.2, by + oy * 0.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawPockets(game) {
    const ctx = this.ctx;
    for (const p of game.table.pockets) {
      const [x, y] = this.toScreen(p.x, p.y);
      const r = p.visualR * this.view.scale;
      const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.75, '#050505');
      g.addColorStop(1, 'rgba(20,14,8,0.9)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * SQUASH, 0, 0, Math.PI * 2);
      ctx.fill();
      // 包口铜圈
      ctx.strokeStyle = 'rgba(176,138,74,0.55)';
      ctx.lineWidth = Math.max(1.5, r * 0.12);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.02, r * SQUASH * 1.02, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  _drawHeadString() {
    const ctx = this.ctx;
    const hx = PLAY_W * 0.25;
    const [x, y0] = this.toScreen(hx, 0);
    const [, y1] = this.toScreen(hx, PLAY_H);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();
    ctx.restore();
  }

  // 瞄准线 + 影子球（母球撞击点位置）
  _drawAim(game, aim) {
    const cue = game.balls.find(b => b.num === 0);
    if (!cue.active) return;
    const ctx = this.ctx;
    const [cx, cy] = this.toScreen(cue.x, cue.y);
    const r = this.ballPx;

    // 光线：直到碰到第一颗球或库边
    const hit = this._raycast(game, cue.x, cue.y, aim.ax, aim.ay);
    const [hx, hy] = this.toScreen(hit.x, hit.y);

    ctx.save();
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.setLineDash([]);

    // 影子球
    if (hit.ball) {
      const [gx, gy] = this.toScreen(
        hit.ball.x - aim.ax * 2 * BALL_R,
        hit.ball.y - aim.ay * 2 * BALL_R,
      );
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(gx, gy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      // 目标球被撞后的走向提示
      const [tx, ty] = this.toScreen(hit.ball.x, hit.ball.y);
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = 'rgba(255,210,120,0.8)';
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + aim.ax * r * 2.2, ty + aim.ay * SQUASH * r * 2.2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  _raycast(game, x, y, ax, ay) {
    let bestT = Infinity;
    let bestBall = null;
    for (const b of game.balls) {
      if (!b.active || b.num === 0) continue;
      const dx = b.x - x, dy = b.y - y;
      const proj = dx * ax + dy * ay;
      if (proj <= 0) continue;
      const perp2 = dx * dx + dy * dy - proj * proj;
      const rr = 2 * BALL_R;
      if (perp2 > rr * rr) continue;
      const t = proj - Math.sqrt(rr * rr - perp2);
      if (t < bestT) { bestT = t; bestBall = b; }
    }
    // 与库边求交
    let wallT = Infinity;
    for (const s of game.table.segments) {
      const t = this._raySegment(x, y, ax, ay, s.ax, s.ay, s.bx, s.by);
      if (t !== null && t < wallT) wallT = t;
    }
    if (bestT < wallT) {
      return { x: x + ax * bestT, y: y + ay * bestT, ball: bestBall };
    }
    return { x: x + ax * Math.max(0, wallT - BALL_R), y: y + ay * Math.max(0, wallT - BALL_R), ball: null };
  }

  _raySegment(px, py, dx, dy, ax, ay, bx, by) {
    const ex = bx - ax, ey = by - ay;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((ax - px) * ey - (ay - py) * ex) / denom;
    const u = ((ax - px) * dy - (ay - py) * dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1) return t;
    return null;
  }

  _drawBalls(game) {
    const ctx = this.ctx;
    const r = this.ballPx;
    // 先画全部接触阴影
    for (const b of game.balls) {
      if (!b.active && b.state !== 'sink') continue;
      const [x, y] = this.toScreen(b.x, b.y);
      const sinkScale = b.state === 'sink' ? Math.max(0, 1 - b.sinkT / 0.18) : 1;
      const sw = r * 2.3 * (b.state === 'sink' ? sinkScale : 1);
      ctx.globalAlpha = 0.5 * (b.state === 'sink' ? sinkScale : 1);
      ctx.drawImage(this.shadow, x - sw / 2, y - sw / 2 + r * 0.25, sw, sw * 0.82);
      ctx.globalAlpha = 1;
    }
    // 再画球体（落袋缩小+下沉）
    for (const b of game.balls) {
      if (!b.active && b.state !== 'sink') continue;
      const [x, y] = this.toScreen(b.x, b.y);
      let scale = 1;
      let alpha = 1;
      if (b.state === 'sink') {
        const k = Math.min(1, b.sinkT / 0.18);
        scale = 1 - k * 0.85;
        alpha = 1 - k * 0.7;
      }
      const size = r * 2 * scale;
      ctx.globalAlpha = alpha;
      ctx.drawImage(this._ballSprite(b.num), x - size / 2, y - size / 2, size, size);
      ctx.globalAlpha = 1;
    }
  }

  _drawCue(game, aim, cueAnim) {
    const cue = game.balls.find(b => b.num === 0);
    if (!cue.active) return;
    const ctx = this.ctx;
    const s = this.view.scale;
    const [cx, cy] = this.toScreen(cue.x, cue.y);
    const ang = Math.atan2(aim.ay * SQUASH, aim.ax);

    // 后拉量：蓄力越多拉得越远；出杆阶段向前捅
    const pullback = (0.04 + cueAnim.power * 0.16) * s;
    const strike = cueAnim.strikeOffset * s;
    const gap = this.ballPx * 1.15 + pullback - strike;
    const len = 1.05 * s;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    // 杆身（浅色木杆 + 深色杆尾 + 皮头）
    const grad = ctx.createLinearGradient(0, -4, 0, 4);
    grad.addColorStop(0, '#d8b48a');
    grad.addColorStop(0.5, '#b98a58');
    grad.addColorStop(1, '#7d5430');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(-(gap + len), -3.2, len, 6.4, 3);
    ctx.fill();
    // 杆尾配重
    ctx.fillStyle = '#3a2616';
    ctx.beginPath();
    ctx.roundRect(-(gap + len), -3.4, 0.16 * s, 6.8, 2);
    ctx.fill();
    // 先角+皮头
    ctx.fillStyle = '#e9e2d2';
    ctx.fillRect(-gap - 0.05 * s, -2.6, 0.05 * s, 5.2);
    ctx.fillStyle = '#3a6fb0';
    ctx.beginPath();
    ctx.arc(-gap, 0, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  _drawVignette() {
    const ctx = this.ctx;
    const g = ctx.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.35,
      this.w / 2, this.h / 2, this.h * 0.9);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }
}
