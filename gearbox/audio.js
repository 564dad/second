/*
 * gearbox/audio.js — Web Audio 程序化合成（无外部音频资源）
 *  - 基频跟随输入轴转速的锯齿波（齿轮嗡鸣）+ 两级啮合频率边带
 *  - 滤波白噪声（宽带转动声），增益随负载/压力变化
 *  - 松旷冲击：检测到振动包络上升时触发短促金属敲击
 *  - 跳闸：下降音提示
 * AudioContext 仅在用户手势（启动/按钮）后创建/恢复，满足浏览器自动播放策略。
 */
(function (global) {
  'use strict';

  class GearboxAudio {
    constructor() {
      this.ctx = null;
      this.master = null;
      this.nodes = null;
      this.lastImpactT = 0;
      this.running = false;
    }

    ensureContext() {
      if (this.ctx) return;
      try {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      } catch (e) {
        this.ctx = null; // 无音频设备或被策略拦截：静音降级，不影响仿真
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.0;
      this.master.connect(this.ctx.destination);
      this._buildGraph();
    }

    _buildGraph() {
      const ctx = this.ctx;
      // --- 齿轮嗡鸣：基频锯齿 + 低通 ---
      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = 30;
      const osc2 = ctx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = 60;
      const buzzGain = ctx.createGain();
      buzzGain.gain.value = 0.12;
      const buzzFilter = ctx.createBiquadFilter();
      buzzFilter.type = 'lowpass';
      buzzFilter.frequency.value = 900;
      buzzFilter.Q.value = 2;
      osc1.connect(buzzFilter);
      osc2.connect(buzzFilter);
      buzzFilter.connect(buzzGain);
      buzzGain.connect(this.master);

      // --- 宽带转动噪声：循环噪声缓冲经带通滤波 ---
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      noise.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 500;
      bp.Q.value = 0.8;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.05;
      noise.connect(bp);
      bp.connect(noiseGain);
      noiseGain.connect(this.master);

      osc1.start();
      osc2.start();
      noise.start();
      this.nodes = { osc1, osc2, buzzGain, buzzFilter, noiseGain, bp };
    }

    async start() {
      this.ensureContext();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.running = true;
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setTargetAtTime(0.5, this.ctx.currentTime, 0.1);
    }

    pause() {
      this.running = false;
      if (!this.ctx) return;
      this.master.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.05);
    }

    /* 每帧由主控调用：rpmIn=输入轴转速，load01=负载归一化，vib=振动，loose=是否松旷 */
    update(rpmIn, load01, vib, loose) {
      if (!this.ctx || !this.nodes) return;
      const t = this.ctx.currentTime;
      const f0 = Math.max(8, rpmIn / 60 * 12); // 12 齿/转 的脉冲频率感
      this.nodes.osc1.frequency.setTargetAtTime(f0, t, 0.05);
      this.nodes.osc2.frequency.setTargetAtTime(f0 * 1.9, t, 0.05);
      this.nodes.buzzFilter.frequency.setTargetAtTime(500 + load01 * 1400, t, 0.1);
      this.nodes.bp.frequency.setTargetAtTime(300 + rpmIn * 0.8, t, 0.1);
      this.nodes.noiseGain.gain.setTargetAtTime(0.03 + load01 * 0.12, t, 0.1);
      this.nodes.buzzGain.gain.setTargetAtTime(0.08 + load01 * 0.1, t, 0.1);

      // 松旷金属敲击：振动超阈值且距上次敲击 >80ms
      if (loose && vib > 25 && t - this.lastImpactT > 0.08) {
        this.lastImpactT = t;
        this._impact(Math.min(1, vib / 200));
      }
    }

    _impact(strength) {
      const ctx = this.ctx;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1400 + Math.random() * 900, t);
      osc.frequency.exponentialRampToValueAtTime(180, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.25 * strength, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.connect(g);
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + 0.16);
    }

    /* 跳闸提示音：两音下行 */
    trip() {
      if (!this.ctx) return;
      const ctx = this.ctx;
      const t = ctx.currentTime;
      [660, 330].forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        const t0 = t + i * 0.16;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
        osc.connect(g);
        g.connect(this.master);
        osc.start(t0);
        osc.stop(t0 + 0.16);
      });
    }

    dispose() {
      if (this.ctx) this.ctx.close();
      this.ctx = null;
      this.nodes = null;
      this.running = false;
    }
  }

  global.GearboxAudio = GearboxAudio;
})(typeof globalThis !== 'undefined' ? globalThis : this);
