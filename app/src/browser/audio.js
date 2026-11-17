// Web Audio 节拍器：精确调度的滴答声 + 可选的入场预览同步。
export class Metronome {
  constructor() {
    this.ctx = null;
    this.timer = null;
    this.running = false;
    this.bpm = 90;
    this.onBeat = null;
    this._nextNoteTime = 0;
    this._current16th = 0;
    this._lookahead = 25; // ms
    this._scheduleAhead = 0.12; // s
  }

  async start(bpm) {
    if (this.running) return;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('当前浏览器不支持 Web Audio API，无法启用节拍器');
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.bpm = bpm;
    this.running = true;
    this._nextNoteTime = this.ctx.currentTime + 0.06;
    this._current16th = 0;
    this.timer = setInterval(() => this._scheduler(), this._lookahead);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setBpm(bpm) {
    this.bpm = bpm;
  }

  _scheduler() {
    while (this._nextNoteTime < this.ctx.currentTime + this._scheduleAhead) {
      const accent = this._current16th % 4 === 0;
      this._scheduleClick(this._nextNoteTime, accent);
      const beatIndex = Math.floor(this._current16th / 4);
      const when = (this._nextNoteTime - this.ctx.currentTime) * 1000;
      setTimeout(() => this.onBeat?.(beatIndex), Math.max(0, when));
      const secondsPer16th = 60.0 / this.bpm / 4;
      this._nextNoteTime += secondsPer16th;
      this._current16th += 1;
    }
  }

  _scheduleClick(time, accent) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.frequency.value = accent ? 1320 : 880;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.25, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);
    osc.start(time);
    osc.stop(time + 0.1);
  }

  // 单次预览滴答（导出前试听）
  clickOnce() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    this._scheduleClick(this.ctx.currentTime + 0.01, true);
  }
}
