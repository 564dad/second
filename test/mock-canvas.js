// 最小 Canvas 2D mock：记录绘制调用、提供 measureText。
// 用于在无浏览器环境验证渲染管线与导出一致性。
export class Mock2D {
  constructor() {
    this.calls = [];
    this.font = '16px sans-serif';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.globalAlpha = 1;
    this.lineWidth = 1;
    this.textAlign = 'left';
    this.textBaseline = 'alphabetic';
    this._stack = [];
    this._clipStack = [];
  }
  #log(name, args) { this.calls.push({ name, args: args.map((a) => (typeof a === 'number' ? Math.round(a * 1000) / 1000 : a)) }); }
  save() { this._stack.push({ font: this.font, fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); this.#log('save', []); }
  restore() { const s = this._stack.pop(); if (s) Object.assign(this, s); this.#log('restore', []); }
  scale(x, y) { this.#log('scale', [x, y]); }
  setTransform(...a) { this.#log('setTransform', a); }
  translate(x, y) { this.#log('translate', [x, y]); }
  rotate(r) { this.#log('rotate', [r]); }
  clearRect(...a) { this.#log('clearRect', a); }
  fillRect(...a) { this.#log('fillRect', a); }
  strokeRect(...a) { this.#log('strokeRect', a); }
  beginPath() { this.#log('beginPath', []); }
  closePath() { this.#log('closePath', []); }
  rect(...a) { this.#log('rect', a); }
  arc(...a) { this.#log('arc', a); }
  ellipse(...a) { this.#log('ellipse', a); }
  arcTo(...a) { this.#log('arcTo', a); }
  moveTo(...a) { this.#log('moveTo', a); }
  lineTo(...a) { this.#log('lineTo', a); }
  fill() { this.#log('fill', []); }
  stroke() { this.#log('stroke', []); }
  clip() { this._clipStack.push(true); this.#log('clip', []); }
  drawImage(...a) { this.#log('drawImage', a); }
  fillText(text, x, y) { this.#log('fillText', [text, x, y]); }
  measureText(text) {
    const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const em = m ? parseFloat(m[1]) : 16;
    let w = 0;
    for (const ch of String(text)) {
      w += /[⺀-鿿豈-﫿　-〿＀-￯]/.test(ch) ? em : em * 0.55;
    }
    return { width: w };
  }
  setLineDash(a) { this.#log('setLineDash', [a]); }
}

export class MockCanvas {
  constructor(w = 1280, h = 720) {
    this.width = w;
    this.height = h;
    this.style = {};
    this._ctx = new Mock2D();
  }
  getContext() { return this._ctx; }
  toDataURL() { return 'data:image/png;base64,MOCK'; }
}

// 无 DOM 的环境下模拟 CanvasRenderer 所需接口
export function mockDocument() {
  return {
    createElement: (tag) => {
      if (tag === 'canvas') return new MockCanvas();
      throw new Error(`unexpected createElement ${tag}`);
    },
  };
}
