// 左右侧栏 UI
export function initUI(onEvent) {
  const el = id => document.getElementById(id);

  const ui = {
    remaining: el('remaining'),
    foul: el('foul'),
    message: el('message'),
    powerFill: el('power-fill'),
    powerText: el('power-text'),
    powerSlider: el('power-slider'),
    spinPad: el('spin-pad'),
    spinDot: el('spin-dot'),
    sideText: el('side-text'),
    topText: el('top-text'),
    presets: {
      center: el('spin-center'),
      back: el('spin-back'),
      follow: el('spin-follow'),
      left: el('spin-left'),
      right: el('spin-right'),
    },
    restart: el('btn-restart'),
    debugToggle: el('btn-debug'),
    debug: el('debug-panel'),
    debugContent: el('debug-content'),
    shotCount: el('shot-count'),
  };

  const state = { side: 0, top: 0, debug: false };

  function setSpin(side, top) {
    state.side = Math.max(-1, Math.min(1, side));
    state.top = Math.max(-1, Math.min(1, top));
    ui.spinDot.style.left = `${50 + state.side * 42}%`;
    ui.spinDot.style.top = `${50 - state.top * 42}%`;
    const sideName = Math.abs(state.side) < 0.08 ? '中杆' : (state.side < 0 ? `左塞 ${(-state.side * 100) | 0}%` : `右塞 ${(state.side * 100) | 0}%`);
    const topName = Math.abs(state.top) < 0.08 ? '平杆' : (state.top < 0 ? `低杆 ${(-state.top * 100) | 0}%` : `高杆 ${(state.top * 100) | 0}%`);
    ui.sideText.textContent = sideName;
    ui.topText.textContent = topName;
  }

  // 杆法垫拖动
  let dragging = false;
  function padFromEvent(e) {
    const r = ui.spinPad.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    setSpin((px - 0.5) / 0.42, (0.5 - py) / 0.42);
  }
  ui.spinPad.addEventListener('pointerdown', e => {
    dragging = true;
    ui.spinPad.setPointerCapture(e.pointerId);
    padFromEvent(e);
  });
  ui.spinPad.addEventListener('pointermove', e => { if (dragging) padFromEvent(e); });
  ui.spinPad.addEventListener('pointerup', () => { dragging = false; });

  const presets = {
    center: [0, 0], back: [0, -0.85], follow: [0, 0.85],
    left: [-0.85, 0], right: [0.85, 0],
  };
  for (const [key, val] of Object.entries(presets)) {
    ui.presets[key].addEventListener('click', () => setSpin(val[0], val[1]));
  }

  ui.powerSlider.addEventListener('input', () => {
    ui.powerFill.style.height = `${ui.powerSlider.value}%`;
    ui.powerText.textContent = `${ui.powerSlider.value}%`;
  });

  ui.restart.addEventListener('click', () => onEvent('restart'));
  ui.debugToggle.addEventListener('click', () => {
    state.debug = !state.debug;
    ui.debug.classList.toggle('hidden', !state.debug);
    onEvent('debug', state.debug);
  });

  function setPower(p) {
    const pct = Math.round(p * 100);
    ui.powerSlider.value = pct;
    ui.powerFill.style.height = `${pct}%`;
    ui.powerText.textContent = `${pct}%`;
  }

  return {
    el: ui,
    state,
    setSpin,
    setPower,
    update(info) {
      ui.remaining.textContent = String(info.remaining);
      ui.shotCount.textContent = String(info.shots);
      ui.foul.textContent = info.foul || '无';
      ui.foul.classList.toggle('foul-active', !!info.foul);
      ui.message.textContent = info.message;
    },
    setDebug(lines) {
      if (!state.debug) return;
      ui.debugContent.textContent = lines.join('\n');
    },
  };
}
