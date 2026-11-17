// render.js — 纯 Canvas2D 程序生成渲染，无任何图片素材
import { TABLE, WALLS, RAILS, SLINGSHOTS, BUMPERS, PLUNGER, flipperGeometry } from './table.js';

const NEON = {
  cyan: '#27e6ff',
  magenta: '#ff3fd8',
  amber: '#ffb347',
  red: '#ff3b6b',
  green: '#50ffaa',
};

export function createRenderer(ctx, proj) {
  // 静态层离屏缓存：台面底板、墙、导轨、文字 —— 每帧只 blit 一次
  let staticLayer = null;
  let staticKey = '';

  function buildStaticLayer(viewW, viewH) {
    const off = document.createElement('canvas');
    off.width = viewW;
    off.height = viewH;
    const c = off.getContext('2d');

    drawTableBase(c, viewW, viewH);
    drawWalls(c);
    drawRails(c);
    drawSlingshots(c);
    drawPlungerLane(c);
    drawNeonTitle(c);
    return off;
  }

  function ensureStatic(viewW, viewH) {
    const key = viewW + 'x' + viewH;
    if (!staticLayer || staticKey !== key) {
      staticLayer = buildStaticLayer(viewW, viewH);
      staticKey = key;
    }
  }

  // ---------- 底板：磨砂金属 + 透视梯形 ----------
  function drawTableBase(c, viewW, viewH) {
    const [tl, tr, br, bl] = proj.corners();

    // 机器外壳（梯形外的深色机身）
    c.save();
    c.beginPath();
    c.moveTo(tl.x - 26, tl.y - 18);
    c.lineTo(tr.x + 26, tr.y - 18);
    c.lineTo(br.x + 34, br.y + 14);
    c.lineTo(bl.x - 34, bl.y + 14);
    c.closePath();
    const casing = c.createLinearGradient(0, tl.y, 0, br.y);
    casing.addColorStop(0, '#15182e');
    casing.addColorStop(0.5, '#0c0e1e');
    casing.addColorStop(1, '#171326');
    c.fillStyle = casing;
    c.fill();
    c.strokeStyle = 'rgba(120,140,200,0.25)';
    c.lineWidth = 2;
    c.stroke();
    c.restore();

    // 台面
    c.save();
    c.beginPath();
    c.moveTo(tl.x, tl.y);
    c.lineTo(tr.x, tr.y);
    c.lineTo(br.x, br.y);
    c.lineTo(bl.x, bl.y);
    c.closePath();
    c.clip();

    const g = c.createLinearGradient(0, tl.y, 0, br.y);
    g.addColorStop(0, '#241b46');
    g.addColorStop(0.45, '#1c1737');
    g.addColorStop(1, '#141029');
    c.fillStyle = g;
    c.fillRect(0, 0, viewW, viewH);

    // 磨砂颗粒：程序生成噪点（固定伪随机，避免每帧闪）
    const grainCount = 2600;
    for (let i = 0; i < grainCount; i++) {
      const lx = rand01(i * 12.9898) * TABLE.W;
      const ly = rand01(i * 78.233 + 1.7) * TABLE.H;
      const s = proj.project({ x: lx, y: ly });
      const alpha = 0.03 + rand01(i * 3.17) * 0.05;
      c.fillStyle = rand01(i * 9.13) > 0.5
        ? `rgba(255,255,255,${alpha})`
        : `rgba(0,0,0,${alpha})`;
      c.fillRect(s.x, s.y, 1.4, 1.4);
    }

    // 中央虚线圈（参考图里的装饰圆）
    const center = proj.project({ x: 360, y: 700 });
    c.beginPath();
    c.arc(center.x, center.y, proj.projectRadius(118, { x: 360, y: 700 }), 0, Math.PI * 2);
    c.setLineDash([6, 10]);
    c.strokeStyle = 'rgba(39,230,255,0.22)';
    c.lineWidth = 1.5;
    c.stroke();
    c.setLineDash([]);

    c.restore();

    // 台面霓虹外框（青色灯管）
    neonPath(c, [tl, tr, br, bl], NEON.cyan, 3, true);
  }

  function drawWalls(c) {
    for (const w of WALLS) {
      const isPlunger = w.id.startsWith('plunger') || w.id.startsWith('laneArc');
      drawMetalSegment(c, w.a, w.b, w.r, isPlunger ? '#8a6b3a' : '#3a4a6b',
        isPlunger ? 'rgba(255,179,71,0.5)' : 'rgba(120,170,255,0.35)');
    }
  }

  // 金属导轨：银色渐变 + 高光条 + 青色辉光
  function drawMetalSegment(c, a, b, r, base, glow) {
    const pa = proj.project(a), pb = proj.project(b);
    const ra = proj.projectRadius(r, a), rb = proj.projectRadius(r, b);
    c.save();
    c.lineCap = 'round';
    c.shadowColor = glow;
    c.shadowBlur = 10;
    const grad = c.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
    grad.addColorStop(0, '#20263c');
    grad.addColorStop(0.35, base);
    grad.addColorStop(0.5, '#c9d6ee');
    grad.addColorStop(0.65, base);
    grad.addColorStop(1, '#1a1f33');
    c.strokeStyle = grad;
    c.lineWidth = (ra + rb) * 0.5;
    c.beginPath();
    c.moveTo(pa.x, pa.y);
    c.lineTo(pb.x, pb.y);
    c.stroke();
    // 高光细线
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = Math.max(1, (ra + rb) * 0.14);
    c.beginPath();
    c.moveTo(pa.x, pa.y - ra * 0.25);
    c.lineTo(pb.x, pb.y - rb * 0.25);
    c.stroke();
    c.restore();
  }

  function drawRails(c) {
    for (const rl of RAILS) {
      // 导轨用更亮的金属 + 白辉光，强调“顺出去”
      const pa = proj.project(rl.a), pb = proj.project(rl.b);
      c.save();
      c.lineCap = 'round';
      c.shadowColor = 'rgba(200,225,255,0.8)';
      c.shadowBlur = 14;
      const grad = c.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0, '#4a5573');
      grad.addColorStop(0.5, '#e8f0ff');
      grad.addColorStop(1, '#39425c');
      c.strokeStyle = grad;
      c.lineWidth = proj.projectRadius(rl.r, rl.a);
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      c.stroke();
      c.restore();
      // 两端固定座
      for (const p of [rl.a, rl.b]) {
        const s = proj.project(p);
        c.beginPath();
        c.arc(s.x, s.y, proj.projectRadius(5, p), 0, Math.PI * 2);
        c.fillStyle = '#2a3350';
        c.fill();
        c.strokeStyle = 'rgba(180,200,255,0.5)';
        c.lineWidth = 1;
        c.stroke();
      }
    }
  }

  function drawSlingshots(c) {
    for (const s of SLINGSHOTS) {
      const pa = proj.project(s.a), pb = proj.project(s.b);
      c.save();
      c.lineCap = 'round';
      c.shadowColor = 'rgba(255,63,216,0.7)';
      c.shadowBlur = 12;
      c.strokeStyle = NEON.magenta;
      c.lineWidth = proj.projectRadius(s.r, s.a);
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      c.stroke();
      c.restore();
    }
  }

  function drawPlungerLane(c) {
    // 发射槽内的弹簧（锯齿）
    const x = (PLUNGER.x0 + PLUNGER.x1) / 2;
    const yTop = 1010, yBot = 1062;
    const half = 14;
    const teeth = 6;
    c.save();
    c.strokeStyle = 'rgba(220,225,245,0.85)';
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i <= teeth; i++) {
      const yy = yTop + ((yBot - yTop) * i) / teeth;
      const xx = x + (i % 2 === 0 ? -half : half);
      const s = proj.project({ x: xx, y: yy });
      if (i === 0) c.moveTo(s.x, s.y); else c.lineTo(s.x, s.y);
    }
    c.stroke();
    c.restore();
  }

  function drawNeonTitle(c) {
    const t1 = proj.project({ x: 268, y: 108 });
    const t2 = proj.project({ x: 452, y: 108 });
    c.save();
    c.textAlign = 'center';
    c.font = `bold ${26 * proj.scaleBase}px "Courier New", monospace`;
    c.shadowBlur = 18;
    c.shadowColor = NEON.cyan;
    c.fillStyle = NEON.cyan;
    c.fillText('NEON', t1.x, t1.y);
    c.shadowColor = NEON.magenta;
    c.fillStyle = NEON.magenta;
    c.fillText('ZONE', t2.x, t2.y);
    c.restore();
  }

  // 霓虹多边形描边
  function neonPath(c, pts, color, width, closed) {
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.shadowColor = color;
    c.shadowBlur = 16;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
    if (closed) c.closePath();
    c.stroke();
    // 内芯高亮
    c.shadowBlur = 4;
    c.strokeStyle = 'rgba(255,255,255,0.75)';
    c.lineWidth = width * 0.35;
    c.stroke();
    c.restore();
  }

  // ---------- 动态对象 ----------
  function drawBumpers(c, state) {
    for (const b of BUMPERS) {
      const s = proj.project(b.pos);
      const r = proj.projectRadius(b.r, b.pos);
      const flash = Math.max(0, b.flash || 0) / 0.16; // 0..1
      c.save();
      // 辉光底
      c.shadowColor = flash > 0 ? '#ffffff' : 'rgba(255,59,107,0.8)';
      c.shadowBlur = 18 + flash * 30;
      const grad = c.createRadialGradient(s.x - r * 0.3, s.y - r * 0.3, r * 0.15, s.x, s.y, r);
      grad.addColorStop(0, flash > 0 ? '#ffd7e2' : '#ff7d9c');
      grad.addColorStop(0.55, NEON.red);
      grad.addColorStop(1, '#8f1638');
      c.fillStyle = grad;
      c.beginPath();
      c.arc(s.x, s.y, r * (1 + flash * 0.12), 0, Math.PI * 2);
      c.fill();
      // 金属环
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,210,225,0.9)';
      c.lineWidth = 2;
      c.stroke();
      // 中心高光
      c.beginPath();
      c.arc(s.x - r * 0.28, s.y - r * 0.3, r * 0.22, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.fill();
      c.restore();
    }
  }

  function drawTargets(c, state) {
    for (const t of state.targets) {
      const s = proj.project(t.pos);
      const r = proj.projectRadius(t.r, t.pos);
      const col = t.color === 'amber' ? NEON.amber : NEON.cyan;
      const flash = Math.max(0, t.flash || 0) / 0.22;
      c.save();
      c.shadowColor = col;
      c.shadowBlur = 10 + (t.lit ? 14 : 0) + flash * 22;
      // 外环
      c.strokeStyle = flash > 0 ? '#ffffff' : col;
      c.lineWidth = 2.5;
      c.beginPath();
      c.arc(s.x, s.y, r, 0, Math.PI * 2);
      c.stroke();
      // 点亮状态：实心半透明
      if (t.lit || flash > 0) {
        c.fillStyle = flash > 0 ? `rgba(255,255,255,${0.5 * flash + 0.25})` : 'rgba(255,179,71,0.28)';
        c.beginPath();
        c.arc(s.x, s.y, r - 3, 0, Math.PI * 2);
        c.fill();
      }
      // 中心小点
      c.shadowBlur = 0;
      c.fillStyle = col;
      c.beginPath();
      c.arc(s.x, s.y, r * 0.22, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  function drawFlippers(c, state) {
    for (const f of state.flippers) {
      const g = flipperGeometry(f);
      const pa = proj.project(g.a);
      const pb = proj.project(g.b);
      const r = proj.projectRadius(f.r, g.a);
      c.save();
      c.lineCap = 'round';
      // 挥动时品红辉光增强
      const moving = Math.abs(f.angVel || 0) > 2;
      c.shadowColor = NEON.magenta;
      c.shadowBlur = moving ? 22 : 10;
      const grad = c.createLinearGradient(pa.x, pa.y, pb.x, pb.y);
      grad.addColorStop(0, '#5b2a6e');
      grad.addColorStop(0.4, '#d48be6');
      grad.addColorStop(1, '#7a3d92');
      c.strokeStyle = grad;
      c.lineWidth = r * 2;
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      c.stroke();
      // 高光
      c.shadowBlur = 0;
      c.strokeStyle = 'rgba(255,230,255,0.7)';
      c.lineWidth = r * 0.4;
      c.beginPath();
      c.moveTo(pa.x, pa.y - r * 0.3);
      c.lineTo(pb.x, pb.y - r * 0.3);
      c.stroke();
      // 转轴
      c.shadowColor = NEON.cyan;
      c.shadowBlur = 10;
      c.beginPath();
      c.arc(pa.x, pa.y, r * 0.95, 0, Math.PI * 2);
      c.fillStyle = '#10162a';
      c.fill();
      c.strokeStyle = NEON.cyan;
      c.lineWidth = 2;
      c.stroke();
      c.restore();
    }
  }

  function drawBall(c, ball) {
    // 残影（淡色一串）
    c.save();
    for (let i = 0; i < ball.trail.length; i++) {
      const tp = ball.trail[i];
      const s = proj.project(tp);
      const a = (i / ball.trail.length) * 0.18;
      c.fillStyle = `rgba(190,225,255,${a})`;
      c.beginPath();
      c.arc(s.x, s.y, proj.projectRadius(ball.r * (0.4 + 0.5 * (i / ball.trail.length)), tp), 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    const s = proj.project(ball.pos);
    const r = proj.projectRadius(ball.r, ball.pos);
    c.save();
    c.shadowColor = 'rgba(160,200,255,0.7)';
    c.shadowBlur = 12;
    const grad = c.createRadialGradient(
      s.x - r * 0.35 + Math.cos(ball.spin) * r * 0.15,
      s.y - r * 0.35 + Math.sin(ball.spin) * r * 0.15,
      r * 0.1, s.x, s.y, r);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.45, '#d7e4f5');
    grad.addColorStop(0.8, '#8fa3c4');
    grad.addColorStop(1, '#4c5a78');
    c.fillStyle = grad;
    c.beginPath();
    c.arc(s.x, s.y, r, 0, Math.PI * 2);
    c.fill();
    // 滚动高光点（随 spin 转）
    c.shadowBlur = 0;
    const hx = s.x + Math.cos(ball.spin) * r * 0.45;
    const hy = s.y + Math.sin(ball.spin) * r * 0.45;
    c.beginPath();
    c.arc(hx, hy, r * 0.22, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fill();
    c.restore();
  }

  function drawParticles(c, particles) {
    for (const p of particles) {
      const s = proj.project(p);
      c.save();
      c.globalAlpha = clamp01(p.life / p.maxLife);
      c.fillStyle = p.color;
      c.shadowColor = p.color;
      c.shadowBlur = 8;
      c.beginPath();
      c.arc(s.x, s.y, p.size, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  }

  function render(state, particles, viewW, viewH) {
    ensureStatic(viewW, viewH);
    ctx.clearRect(0, 0, viewW, viewH);
    ctx.drawImage(staticLayer, 0, 0);
    drawBumpers(ctx, state);
    drawTargets(ctx, state);
    drawFlippers(ctx, state);
    for (const b of state.balls) drawBall(ctx, b);
    drawParticles(ctx, particles);
  }

  return { render, neonPath };
}

function rand01(seed) {
  const x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
