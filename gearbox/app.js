/*
 * gearbox/app.js — 主控：UI 装配、固定步长调度、暂停/单步/重置、回放、自测
 *
 * 时间模型（保证确定性与暂停/单步等价）：
 *  - 物理只由 sim.step() 推进固定步长 DT；rAF 仅负责按累积时间“消费”固定步，
 *    真实帧率波动不影响积分序列。暂停 = 停止消费；单步 = 恰好消费一个 DT。
 *  - 回放读取录制的快照序列（60Hz），不重新积分，因此逐帧无跳变。
 */
(function () {
  'use strict';
  const P = globalThis.GearboxPhysics;
  const { GearboxSim, LIMITS, DT, GEAR_TEETH_CHOICES } = P;

  const $ = (id) => document.getElementById(id);
  const els = {};
  let sim = null, renderer = null, audio = null;
  let mode = 'idle';           // idle | running | paused | tripped | replay
  let acc = 0, lastTs = 0;
  let replayIndex = 0, replayLastTs = 0;
  let prevStats = null;        // 上一帧关键量，用于“最近一次变化”
  let changeHistory = [];      // 最近变化记录
  let currentCfg = null;

  const PRESETS = {
    normal: { teeth: [32, 32, 24], inputRpm: 900, loadNm: 60, seed: 42,
      label: '正常工况' },
    extreme: { teeth: [32, 32, 24], inputRpm: 900, loadNm: 195, seed: 42,
      label: '极限载荷' },
    loose: { teeth: [20, 28, 24], inputRpm: 900, loadNm: 40, seed: 7,
      label: '失稳（齿侧松旷）' },
    jam: { teeth: [40, 40, 32], inputRpm: 900, loadNm: 60, seed: 1,
      label: '轴距过紧卡死' }
  };

  function init() {
    cacheEls();
    buildGearSelects();
    bindControls();
    audio = new globalThis.GearboxAudio();
    renderer = new globalThis.GearboxRenderer($('canvas'), P);
    loadPreset('normal');
    requestAnimationFrame(loop);
    runSelfTest();
  }

  function cacheEls() {
    ['canvas', 'gearA', 'gearB', 'gearC', 'inputRpm', 'loadNm', 'seed',
      'btnRun', 'btnPause', 'btnStep', 'btnReset', 'btnReplay',
      'geomStatus', 'statGrid', 'changeLog', 'faultBanner', 'faultDetail',
      'trendCanvas', 'selftest', 'limitBar'].forEach((id) => { els[id] = $(id); });
  }

  function buildGearSelects() {
    [els.gearA, els.gearB, els.gearC].forEach((sel) => {
      sel.innerHTML = GEAR_TEETH_CHOICES.map((z) => `<option value="${z}">${z} 齿</option>`).join('');
    });
  }

  function readConfig() {
    return {
      teeth: [+els.gearA.value, +els.gearB.value, +els.gearC.value],
      inputRpm: +els.inputRpm.value,
      loadNm: +els.loadNm.value,
      seed: +els.seed.value || P.DEFAULT_SEED
    };
  }

  function loadPreset(key) {
    const c = PRESETS[key];
    els.gearA.value = c.teeth[0];
    els.gearB.value = c.teeth[1];
    els.gearC.value = c.teeth[2];
    els.inputRpm.value = c.inputRpm;
    els.loadNm.value = c.loadNm;
    els.seed.value = c.seed;
    doReset();
  }

  function bindControls() {
    els.btnRun.addEventListener('click', doRun);
    els.btnPause.addEventListener('click', doPause);
    els.btnStep.addEventListener('click', doStep);
    els.btnReset.addEventListener('click', doReset);
    els.btnReplay.addEventListener('click', doReplay);
    [els.gearA, els.gearB, els.gearC, els.inputRpm, els.loadNm, els.seed]
      .forEach((el) => el.addEventListener('change', doReset));
    document.querySelectorAll('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => loadPreset(b.dataset.preset)));
  }

  /* ---------------- 状态机 ---------------- */
  function doReset() {
    currentCfg = readConfig();
    sim = new GearboxSim(currentCfg);
    sim.reset();
    mode = sim.fault ? 'tripped' : 'idle';
    acc = 0;
    prevStats = null;
    changeHistory = [];
    replayIndex = 0;
    audio.pause();
    renderAll(sim.snapshot());
    setButtons();
  }

  async function doRun() {
    if (mode === 'replay') doReset();
    if (sim.fault) return; // 跳闸后必须先重置
    // 先进入运行态，再尝试音频；音频不可用（如无音频设备/被策略拦截）不得阻断物理仿真
    mode = 'running';
    lastTs = 0;
    setButtons();
    try { await audio.start(); }
    catch (err) { console.warn('音频初始化失败，静音运行：', err); }
  }

  function doPause() {
    if (mode !== 'running') return;
    mode = 'paused';
    audio.pause();
    setButtons();
  }

  function doStep() {
    if (mode === 'replay' || sim.fault) return;
    mode = 'paused';
    sim.step(); // 单步与连续运行调用同一个固定步长方法
    audio.pause();
    renderAll(sim.snapshot());
    if (sim.fault) onTrip();
    setButtons();
  }

  function doReplay() {
    if (!sim || sim.recorder.length < 2) return;
    mode = 'replay';
    replayIndex = 0;
    replayLastTs = 0;
    audio.pause();
    setButtons();
  }

  function onTrip() {
    mode = 'tripped';
    audio.pause();
    audio.trip();
    setButtons();
  }

  function setButtons() {
    els.btnRun.disabled = mode === 'running' || mode === 'replay' || !!sim.fault;
    els.btnPause.disabled = mode !== 'running';
    els.btnStep.disabled = mode === 'replay' || !!sim.fault;
    els.btnReplay.disabled = sim.recorder.length < 2;
  }

  /* ---------------- 主循环：固定步长消费 ---------------- */
  function loop(ts) {
    requestAnimationFrame(loop);
    if (mode === 'running') {
      if (!lastTs) lastTs = ts;
      let frameMs = ts - lastTs;
      lastTs = ts;
      if (frameMs > 100) frameMs = 100; // 切后台回来不追算一大堆步
      acc += frameMs / 1000;
      let guard = 0;
      while (acc >= DT && guard < 64) {
        sim.step();
        acc -= DT;
        guard++;
        if (sim.fault) { onTrip(); break; }
      }
      const snap = sim.snapshot();
      renderAll(snap);
      audio.update(Math.abs(snap.rpm[0]), currentCfg.loadNm / LIMITS.load.max,
        snap.vibrationMmS, sim.geom.status === 'loose');
    } else if (mode === 'replay') {
      if (!replayLastTs) replayLastTs = ts;
      const elapsed = (ts - replayLastTs) / 1000;
      const idx = Math.min(sim.recorder.length - 1, Math.floor(elapsed / (DT * P.RECORD_EVERY)));
      replayIndex = idx;
      renderAll(sim.recorder[idx]);
      if (idx >= sim.recorder.length - 1) {
        mode = sim.fault ? 'tripped' : 'paused';
        setButtons();
      }
    }
  }

  /* ---------------- 渲染装配 ---------------- */
  function renderAll(snap) {
    const replayInfo = mode === 'replay'
      ? { index: replayIndex, total: sim.recorder.length, t: snap.t } : null;
    renderer.draw(snap, currentCfg, sim.geom, sim.fault ? sim.fault.snap : null, replayInfo);
    renderGeom();
    renderStats(snap);
    renderFault();
    renderLimits(snap);
    drawTrend();
  }

  function renderGeom() {
    const g = sim.geom;
    const map = { healthy: ['健康啮合', '#8ff0a4'], loose: ['齿侧松旷', '#ffaa3c'], tight: ['轴距过紧', '#ff5c5c'] };
    const [name, color] = map[g.status];
    els.geomStatus.innerHTML =
      `<span style="color:${color};font-weight:600">● ${name}</span>
       AB 偏差 ${g.gaps.AB.toFixed(2)} mm ｜ BC 偏差 ${g.gaps.BC.toFixed(2)} mm ｜
       理论速比 ${g.ratio.toFixed(3)}（目标输出 ${P.expectedOutputRpm(currentCfg).toFixed(0)} rpm）`;
  }

  const STAT_DEFS = [
    { k: 'rpm0', label: '输入轴转速', unit: 'rpm', d: 0, src: (s) => Math.abs(s.rpm[0]), lim: LIMITS.inputSpeed },
    { k: 'rpm2', label: '输出轴转速', unit: 'rpm', d: 0, src: (s) => Math.abs(s.rpm[2]), lim: LIMITS.outputSpeed },
    { k: 'pressure', label: '接触压力', unit: 'MPa', d: 1, src: (s) => s.pressureMPa, lim: LIMITS.pressure },
    { k: 'temp', label: '油温', unit: '°C', d: 1, src: (s) => s.tempC, lim: LIMITS.temperature },
    { k: 'vib', label: '振动速度', unit: 'mm/s', d: 2, src: (s) => s.vibrationMmS, lim: LIMITS.vibration },
    { k: 'forceAB', label: 'AB 啮合力', unit: 'N', d: 0, src: (s) => s.forces.AB },
    { k: 'forceBC', label: 'BC 啮合力', unit: 'N', d: 0, src: (s) => s.forces.BC },
    { k: 'theta2', label: '输出轴角位置', unit: 'rad', d: 2, src: (s) => s.theta[2] }
  ];

  function renderStats(snap) {
    const isReplay = mode === 'replay';
    const rows = STAT_DEFS.map((def) => {
      const v = def.src(snap);
      let delta = '—';
      if (prevStats) {
        const pv = def.src(prevStats);
        const dv = v - pv;
        if (Math.abs(dv) > 1e-9) {
          const arrow = dv > 0 ? '▲' : '▼';
          delta = `<span style="color:${dv > 0 ? '#ff9a9a' : '#9ad8ff'}">${arrow} ${Math.abs(dv).toFixed(def.d)}</span>`;
          if (!isReplay) pushChange(def.label, v, dv, def.unit, snap.t);
        }
      }
      // 运行中只判上限越限：下限是设定值工艺约束（已在 reset 时 t=0 拒绝），
      // 软启动爬坡/跳闸减速经过低转速区属正常过程，不应标红。
      const over = def.lim && v > def.lim.max;
      return `<div class="stat ${over ? 'over' : ''}">
        <div class="stat-label">${def.label}</div>
        <div class="stat-value">${v.toFixed(def.d)} <small>${def.unit}</small></div>
        <div class="stat-delta">最近变化 ${delta}</div>
        ${def.lim ? `<div class="stat-lim">限值 ${def.lim.min}~${def.lim.max} ${def.unit}</div>` : ''}
      </div>`;
    }).join('');
    els.statGrid.innerHTML = rows;
    els.changeLog.innerHTML = changeHistory.slice(0, 8).map((c) =>
      `<div class="log-row"><span class="log-t">${c.t.toFixed(2)}s</span> ${c.label}
       <b style="color:${c.dv > 0 ? '#ff9a9a' : '#9ad8ff'}">${c.dv > 0 ? '+' : ''}${c.dv.toFixed(2)} ${c.unit}</b>
       → ${c.v.toFixed(2)} ${c.unit}</div>`).join('') || '<div class="log-row muted">尚无变化（点击启动或单步）</div>';
    prevStats = JSON.parse(JSON.stringify(snap));
  }

  function pushChange(label, v, dv, unit, t) {
    if (changeHistory[0] && changeHistory[0].label === label && Math.abs(changeHistory[0].t - t) < DT * 1.5) {
      changeHistory[0] = { label, v, dv, unit, t };
    } else {
      changeHistory.unshift({ label, v, dv, unit, t });
      if (changeHistory.length > 40) changeHistory.pop();
    }
  }

  function renderFault() {
    if (sim.fault) {
      const f = sim.fault;
      els.faultBanner.classList.add('show');
      els.faultDetail.innerHTML =
        `<b>${f.message}</b><br>触发时刻 t=${f.t.toFixed(3)}s（物理步 #${f.step}）｜
         位置 θ=[${f.snap.theta.map((x) => x.toFixed(2)).join(', ')}] rad｜
         速度 [${f.snap.rpm.map((x) => x.toFixed(0)).join(', ')}] rpm｜
         压力 ${f.snap.pressureMPa.toFixed(1)} MPa｜温度 ${f.snap.tempC.toFixed(1)} °C｜
         振动 ${f.snap.vibrationMmS.toFixed(1)} mm/s<br>
         <small>已冻结计算并定位触发点，点击“重置”后才能重新运行。</small>`;
    } else {
      els.faultBanner.classList.remove('show');
    }
  }

  function renderLimits(snap) {
    const items = [
      ['输入转速', snap.rpm[0], LIMITS.inputSpeed],
      ['输出转速', Math.abs(snap.rpm[2]), LIMITS.outputSpeed],
      ['负载', currentCfg.loadNm, LIMITS.load],
      ['压力', snap.pressureMPa, LIMITS.pressure],
      ['温度', snap.tempC, LIMITS.temperature],
      ['振动', snap.vibrationMmS, LIMITS.vibration]
    ];
    els.limitBar.innerHTML = items.map(([label, v, lim]) => {
      const pct = Math.max(0, Math.min(100, (v - lim.min) / (lim.max - lim.min) * 100));
      const hot = pct > 85;
      return `<div class="lim-item">
        <div class="lim-head"><span>${label}</span><span>${v.toFixed(1)} / ${lim.max}${lim.unit}</span></div>
        <div class="lim-track"><div class="lim-fill ${hot ? 'hot' : ''}" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');
  }

  /* 趋势曲线：输出转速、压力、温度归一化叠加 */
  function drawTrend() {
    const cv = els.trendCanvas;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const rect = cv.getBoundingClientRect();
    if (cv.width !== Math.round(rect.width * dpr)) {
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0d131c';
    ctx.fillRect(0, 0, W, H);
    const rec = sim.recorder;
    if (rec.length < 2) {
      ctx.fillStyle = '#5a708c';
      ctx.font = '12px system-ui';
      ctx.fillText('趋势区：运行后显示输出转速 / 压力 / 温度', 12, H / 2);
      return;
    }
    const series = [
      { color: '#8ff0a4', f: (s) => Math.abs(s.rpm[2]) / LIMITS.outputSpeed.max },
      { color: '#ff9a9a', f: (s) => s.pressureMPa / LIMITS.pressure.max },
      { color: '#ffd479', f: (s) => (s.tempC - 20) / (LIMITS.temperature.max - 20) }
    ];
    // 85% 告警线
    ctx.strokeStyle = 'rgba(255,90,90,0.5)';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(0, H * 0.15); ctx.lineTo(W, H * 0.15); ctx.stroke();
    ctx.setLineDash([]);
    series.forEach((sr) => {
      ctx.strokeStyle = sr.color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      rec.forEach((s, i) => {
        const x = i / (rec.length - 1) * W;
        const y = H - Math.max(0, Math.min(1, sr.f(s))) * (H - 8) - 4;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });
    const replayMarker = mode === 'replay'
      ? replayIndex / (rec.length - 1) * W : -1;
    if (replayMarker >= 0) {
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.moveTo(replayMarker, 0); ctx.lineTo(replayMarker, H); ctx.stroke();
    }
  }

  /* ---------------- 页面内自测（与 Node 无头套件同源） ---------------- */
  function runSelfTest() {
    const out = [];
    const ok = (name, cond) => out.push({ name, pass: !!cond });
    const a = new GearboxSim(PRESETS.normal);
    const b = new GearboxSim(PRESETS.normal);
    for (let i = 0; i < 50; i++) { a.step(); b.step(); }
    ok('同参数运行可重复', JSON.stringify(a.snapshot()) === JSON.stringify(b.snapshot()));
    const init = JSON.stringify(a.reset());
    a.step(); a.step();
    ok('重置零漂移', JSON.stringify(a.reset()) === init);
    const c = new GearboxSim(PRESETS.normal);
    const d = new GearboxSim(PRESETS.normal);
    for (let i = 0; i < 20; i++) c.step();
    for (let i = 0; i < 20; i++) d.step();
    ok('暂停/单步状态等价', JSON.stringify(c.snapshot()) === JSON.stringify(d.snapshot()));
    const trip = new GearboxSim(PRESETS.extreme);
    while (!trip.fault) trip.step();
    const frozen = JSON.stringify(trip.snapshot());
    trip.step(); trip.step();
    ok('跳闸后冻结', JSON.stringify(trip.snapshot()) === frozen);
    const jam = new GearboxSim(PRESETS.jam);
    ok('过紧 t=0 拒绝', !!jam.fault && jam.fault.code === 'jam' && jam.fault.t === 0);
    const over = new GearboxSim({ teeth: [32, 32, 24], inputRpm: 900, loadNm: 250 });
    ok('负载越限 t=0 拒绝', !!over.fault && over.fault.code === 'load');
    const loose = new GearboxSim(PRESETS.loose);
    while (!loose.fault) loose.step();
    ok('松旷发展为失稳跳闸', loose.fault.code === 'instability' && loose.fault.t > 0.3);
    // 热保护路径（限定步数，避免页面卡顿）
    const thermal = new GearboxSim({ teeth: [32, 32, 24], inputRpm: 1000, loadNm: 140, seed: 42 });
    let guard = 0;
    while (!thermal.fault && guard < 200000) { thermal.step(); guard++; }
    ok('持续满载触发热保护', !!thermal.fault && thermal.fault.code === 'temperature');
    const passN = out.filter((x) => x.pass).length;
    els.selftest.innerHTML = out.map((x) =>
      `<span class="badge ${x.pass ? 'pass' : 'fail'}">${x.pass ? '✓' : '✗'} ${x.name}</span>`
    ).join('') + `<span class="badge summary">页面自测 ${passN}/${out.length}</span>`;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
