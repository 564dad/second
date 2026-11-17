// audio.js — WebAudio 现场合成，无任何音频文件
// 撞击音按力度变调：轻碰低幅短促，狠撞高频响亮。

export function createAudio() {
  let ctx = null;
  let master = null;
  let enabled = true;

  function ensure() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { enabled = false; return; }
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    // 简单限幅：压缩器防止多音叠加爆音
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 8;
    master.connect(comp);
    comp.connect(ctx.destination);
  }

  function resume() {
    ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  /**
   * 通用撞击音：正弦 + 三角双振荡器，频率/音量/时长随 impact(0..1) 变化
   */
  function hit(impact, kind = 'wall') {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const power = Math.min(1, Math.max(0.04, impact));

    // 力度 -> 基频：轻碰 ~220Hz，狠撞 ~880Hz
    const baseFreq = 200 + power * 700;
    const kindBoost = kind === 'bumper' ? 1.35 : kind === 'flipper' ? 1.15 : 1;
    const freq = baseFreq * kindBoost;
    const dur = 0.05 + power * 0.14;
    const vol = 0.08 + power * 0.4;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = 'triangle';
    osc2.type = 'sine';
    osc1.frequency.setValueAtTime(freq, t);
    osc1.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur);
    osc2.frequency.setValueAtTime(freq * 1.98, t);
    osc2.frequency.exponentialRampToValueAtTime(freq, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(master);
    osc1.start(t); osc2.start(t);
    osc1.stop(t + dur + 0.02); osc2.stop(t + dur + 0.02);
  }

  /** 金属导轨：高频方波短噪声感，带一点扫频 */
  function rail(impact) {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const power = Math.min(1, Math.max(0.05, impact));
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    const f = 900 + power * 1400;
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.08);
    gain.gain.setValueAtTime(0.05 + power * 0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain); gain.connect(master);
    osc.start(t); osc.stop(t + 0.1);
  }

  /** 靶子：清脆双音叮 */
  function target(impact, combo) {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const root = 660 * Math.pow(1.12, Math.min(combo - 1, 6)); // 连击升调
    [root, root * 1.5].forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const dur = 0.22;
      gain.gain.setValueAtTime(0.22 * (i ? 0.5 : 1), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain); gain.connect(master);
      osc.start(t); osc.stop(t + dur);
    });
  }

  /** 发射：弹簧上紧后的释放滑音 */
  function launch(power01) {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(700 + power01 * 900, t + 0.25);
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(gain); gain.connect(master);
    osc.start(t); osc.stop(t + 0.3);
  }

  /** 排水：下坠音 */
  function drain() {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.5);
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain); gain.connect(master);
    osc.start(t); osc.stop(t + 0.6);
  }

  /** 游戏结束 */
  function gameover() {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    const notes = [392, 330, 262, 196];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.22;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      osc.connect(gain); gain.connect(master);
      osc.start(t); osc.stop(t + 0.28);
    });
  }

  /** multiball 触发：上扬琶音 */
  function multiball() {
    if (!enabled) return;
    ensure();
    if (!ctx) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      const t = ctx.currentTime + i * 0.08;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain); gain.connect(master);
      osc.start(t); osc.stop(t + 0.2);
    });
  }

  return { resume, hit, rail, target, launch, drain, gameover, multiball };
}
