/*
 * gearbox/renderer.js — Canvas 齿轮箱渲染
 * 绘制：三齿轮齿形与旋转相位、固定轴与轴距、啮合点、受力方向箭头、
 * 松旷侧隙示意、跳闸触发点标记、输出轴转速表盘与指针。
 * 所有坐标由齿轮节圆半径（齿数×模数）推导，与物理几何一致。
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  class GearboxRenderer {
    constructor(canvas, physics) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.physics = physics; // 常量来源
      this.dpr = Math.min(2, global.devicePixelRatio || 1);
      this._resize();
    }

    _resize() {
      const { canvas } = this;
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.round(rect.width * this.dpr);
      canvas.height = Math.round(rect.height * this.dpr);
      this.w = rect.width;
      this.h = rect.height;
    }

    /* 依据齿数与固定轴距计算三齿轮中心（像素），保证啮合几何与物理一致 */
    _layout(teeth) {
      const P = this.physics;
      const rMM = teeth.map((z) => P.pitchRadiusMM(z));
      const scale = Math.min(
        (this.w * 0.82) / (P.SHAFT_DIST_MM.AB + P.SHAFT_DIST_MM.BC + rMM[0] + rMM[2]),
        (this.h * 0.62) / (2 * Math.max(...rMM))
      );
      const cx = this.w / 2;
      const cy = this.h * 0.46;
      const xA = cx - (P.SHAFT_DIST_MM.AB + P.SHAFT_DIST_MM.BC) * scale / 2;
      const xB = xA + P.SHAFT_DIST_MM.AB * scale;
      const xC = xB + P.SHAFT_DIST_MM.BC * scale;
      return {
        scale,
        centers: [{ x: xA, y: cy }, { x: xB, y: cy }, { x: xC, y: cy }],
        rPx: rMM.map((r) => r * scale)
      };
    }

    draw(state, cfg, geom, trigger, replayInfo) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this._drawBackground();

      const layout = this._layout(cfg.teeth);
      this._drawShaftLine(layout);
      this._drawBacklash(cfg, geom, layout);

      // 齿轮本体
      cfg.teeth.forEach((z, i) => {
        this._drawGear(layout.centers[i], layout.rPx[i], z, state.theta[i],
          geom.status === 'tight', i);
      });

      this._drawMeshPoints(layout, geom, state);
      this._drawForceArrows(layout, state, geom);
      this._drawLabels(layout, cfg, state);
      this._drawGauge(state, cfg, geom);
      if (trigger) this._drawTriggerMarker(trigger, layout);
      if (replayInfo) this._drawReplayBadge(replayInfo);
    }

    _drawReplayBadge(info) {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(40,80,140,0.92)';
      const text = `⟲ 回放 ${info.index + 1}/${info.total} · t=${info.t.toFixed(2)}s（录制快照，未重新积分）`;
      ctx.font = '12px system-ui, sans-serif';
      const w = ctx.measureText(text).width + 22;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(10, 10, w, 26, 7);
      else ctx.rect(10, 10, w, 26);
      ctx.fill();
      ctx.fillStyle = '#dce9ff';
      ctx.fillText(text, 21, 27);
      ctx.restore();
    }

    _drawBackground() {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, '#10161f');
      g.addColorStop(1, '#0a0e14');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      // 网格
      ctx.strokeStyle = 'rgba(120,150,190,0.06)';
      ctx.lineWidth = 1;
      for (let x = 0; x < this.w; x += 28) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.h); ctx.stroke();
      }
      for (let y = 0; y < this.h; y += 28) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
      }
    }

    _drawShaftLine(layout) {
      const ctx = this.ctx;
      ctx.strokeStyle = 'rgba(160,180,210,0.35)';
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(layout.centers[0].x - layout.rPx[0] - 24, layout.centers[0].y);
      ctx.lineTo(layout.centers[2].x + layout.rPx[2] + 24, layout.centers[2].y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 松旷侧隙：在松旷级用红色弧带表示齿侧间隙范围 */
    _drawBacklash(cfg, geom, layout) {
      if (geom.status !== 'loose') return;
      const ctx = this.ctx;
      ['AB', 'BC'].forEach((key, idx) => {
        if (geom.mesh[key] !== 'loose') return;
        const a = layout.centers[idx];
        const b = layout.centers[idx + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,170,60,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(mx, my, 9, 0, TAU);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,170,60,0.95)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(`侧隙 ${geom.gaps[key].toFixed(1)}mm`, mx + 12, my - 8);
        ctx.restore();
      });
    }

    /* 单个齿轮：梯形近似齿廓 + 节圆 + 轮毂 + 相位标记 */
    _drawGear(c, r, teeth, theta, isTight, index) {
      const ctx = this.ctx;
      const ra = r * 1.12; // 齿顶圆
      const rd = r * 0.9;  // 齿根圆
      const colors = ['#5b8dd9', '#7dd0c8', '#e0b15e'];
      const base = isTight ? '#d96060' : colors[index];

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(theta);

      // 齿形路径
      ctx.beginPath();
      for (let k = 0; k < teeth; k++) {
        const a0 = (k / teeth) * TAU;
        const a1 = ((k + 0.28) / teeth) * TAU;
        const a2 = ((k + 0.72) / teeth) * TAU;
        const a3 = ((k + 1) / teeth) * TAU;
        const p = (ang, rad) => [Math.cos(ang) * rad, Math.sin(ang) * rad];
        if (k === 0) ctx.moveTo(...p(a0, rd));
        ctx.lineTo(...p(a0, ra));
        ctx.lineTo(...p(a1, ra));
        ctx.lineTo(...p(a2, rd));
        ctx.lineTo(...p(a3, rd));
      }
      ctx.closePath();
      const grad = ctx.createRadialGradient(0, 0, rd * 0.2, 0, 0, ra);
      grad.addColorStop(0, this._shade(base, 25));
      grad.addColorStop(1, base);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = this._shade(base, -35);
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 节圆
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);

      // 轮毂与轴孔
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22, 0, TAU);
      ctx.fillStyle = '#1a2230';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.stroke();

      // 相位标记（随齿轮转动，便于肉眼观察转速/方向）
      ctx.beginPath();
      ctx.arc(r * 0.62, 0, Math.max(2.5, r * 0.06), 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.restore();

      // 不随旋转的中心轴座
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(3, r * 0.08), 0, TAU);
      ctx.fillStyle = '#0c1118';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    _drawMeshPoints(layout, geom, state) {
      const ctx = this.ctx;
      [0, 1].forEach((idx) => {
        const a = layout.centers[idx];
        const b = layout.centers[idx + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const key = idx === 0 ? 'AB' : 'BC';
        const color = geom.mesh[key] === 'loose' ? '#ffaa3c'
          : geom.mesh[key] === 'tight' ? '#ff5c5c' : '#8ff0a4';
        ctx.beginPath();
        ctx.arc(mx, my, 4, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
      });
    }

    /* 受力方向箭头：切向啮合力，方向随相对转动，长度随力大小 */
    _drawForceArrows(layout, state, geom) {
      const ctx = this.ctx;
      [0, 1].forEach((idx) => {
        const key = idx === 0 ? 'AB' : 'BC';
        const force = state.forces[key];
        if (!force || force < 200) return; // 力太小不画，避免与啮合点重叠
        const a = layout.centers[idx];
        const b = layout.centers[idx + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const len = Math.min(46, 8 + Math.log10(force + 1) * 14);
        const dir = idx === 0 ? 1 : -1; // 两级切向方向相反
        // 箭头画在啮合点上方，垂直于中心线（中心线为水平，故箭头竖直）
        const y2 = my - dir * len;
        ctx.strokeStyle = geom.status === 'loose' ? '#ffb347' : '#ff7d7d';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx, y2);
        ctx.stroke();
        this._arrowHead(mx, y2, dir > 0 ? -Math.PI / 2 : Math.PI / 2);
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${(force / 1000).toFixed(1)}kN`, mx + 7, y2 + (dir > 0 ? 3 : -3));
      });
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    _arrowHead(x, y, angle) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 5 * Math.cos(angle - 0.4), y - 5 * Math.sin(angle - 0.4));
      ctx.lineTo(x - 5 * Math.cos(angle + 0.4), y - 5 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    }

    _drawLabels(layout, cfg, state) {
      const ctx = this.ctx;
      const names = ['A 输入轴', 'B 中间轴', 'C 输出轴'];
      layout.centers.forEach((c, i) => {
        ctx.fillStyle = 'rgba(230,238,250,0.9)';
        ctx.font = '12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${names[i]} · ${cfg.teeth[i]}齿`, c.x, c.y + layout.rPx[i] + 22);
        ctx.fillStyle = 'rgba(150,175,210,0.9)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(`${state.rpm[i].toFixed(0)} rpm`, c.x, c.y + layout.rPx[i] + 38);
        ctx.textAlign = 'left';
      });
    }

    /* 输出轴转速表盘：目标刻度、限值红线、当前指针 */
    _drawGauge(state, cfg, geom) {
      const ctx = this.ctx;
      const P = this.physics;
      const gx = this.w - 92;
      const gy = 64;
      const R = 42;
      const outRpm = Math.abs(state.rpm[2]);
      const target = P.expectedOutputRpm(cfg);
      const max = Math.max(P.LIMITS.outputSpeed.max, target * 1.25);

      ctx.save();
      ctx.translate(gx, gy);
      // 表盘弧（-210° ~ 30°）
      const a0 = Math.PI * 0.83, a1 = Math.PI * 2.17;
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(0, 0, R, a0, a1);
      ctx.stroke();
      // 限值红区
      const limA = a0 + (P.LIMITS.outputSpeed.max / max) * (a1 - a0);
      ctx.strokeStyle = 'rgba(255,80,80,0.85)';
      ctx.beginPath();
      ctx.arc(0, 0, R, Math.min(limA, a1), a1);
      ctx.stroke();
      // 目标刻度
      const tA = a0 + (target / max) * (a1 - a0);
      ctx.strokeStyle = '#8ff0a4';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(tA) * (R - 9), Math.sin(tA) * (R - 9));
      ctx.lineTo(Math.cos(tA) * (R + 7), Math.sin(tA) * (R + 7));
      ctx.stroke();
      // 指针
      const cur = Math.min(outRpm / max, 1);
      const pA = a0 + cur * (a1 - a0);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(pA) * (R - 12), Math.sin(pA) * (R - 12));
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 4, 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
      // 数值
      ctx.fillStyle = '#eef4ff';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${outRpm.toFixed(0)}`, 0, R + 20);
      ctx.fillStyle = 'rgba(150,175,210,0.9)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(`输出 rpm / 目标 ${target.toFixed(0)}`, 0, R + 34);
      ctx.restore();
    }

    /* 跳闸触发点：红色警示环 + 触发物理量 */
    _drawTriggerMarker(trigger, layout) {
      const ctx = this.ctx;
      const c = layout.centers[2];
      const pulse = 1 + 0.08 * Math.sin(performance.now() / 180);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,70,70,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, layout.rPx[2] * 1.25 * pulse, 0, TAU);
      ctx.stroke();
      // 带底色的标签，避免与齿轮/轴标签重叠时不可读
      const label = `⚠ 触发点 t=${trigger.t.toFixed(3)}s`;
      ctx.font = 'bold 12px system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 18;
      const lx = c.x - tw / 2;
      const ly = c.y - layout.rPx[2] - 30;
      ctx.fillStyle = 'rgba(120,20,20,0.92)';
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') ctx.roundRect(lx, ly - 14, tw, 22, 6);
      else ctx.rect(lx, ly - 14, tw, 22);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#ffb0b0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, c.x, ly - 3);
      ctx.restore();
    }

    _shade(hex, amt) {
      const n = parseInt(hex.slice(1), 16);
      let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
      r = Math.max(0, Math.min(255, r));
      g = Math.max(0, Math.min(255, g));
      b = Math.max(0, Math.min(255, b));
      return `rgb(${r},${g},${b})`;
    }
  }

  global.GearboxRenderer = GearboxRenderer;
})(typeof globalThis !== 'undefined' ? globalThis : this);
