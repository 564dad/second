// 人工验收：三杆不同力度，截图 + 量停稳时间/走位
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const EDGE = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9240;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
      const p = l.find(t => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('no cdp');
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async open(u) {
    const ws = new WebSocket(u);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new CDP(ws);
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.id && c.pend.has(m.id)) { c.pend.get(m.id)(m.result); c.pend.delete(m.id); } };
    return c;
  }
  cmd(method, params = {}) { return new Promise(res => { const id = ++this.id;
    this.pend.set(id, res); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expr) { const r = await this.cmd('Runtime.evaluate',
    { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
    return r.result.value; }
}

const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
  `--remote-debugging-port=${PORT}`, '--window-size=1920,1080',
  '--user-data-dir=C:\\temp\\edge-3shots-' + Date.now(), 'about:blank'], { stdio: 'ignore' });

const shots = [
  { name: 'soft', power: 0.3, side: 0, top: 0, ang: 0.05, label: '轻推 30%' },
  { name: 'mid', power: 0.6, side: 0, top: -0.7, ang: 0, label: '中力 60% 低杆' },
  { name: 'hard', power: 1, side: 0.7, top: 0.2, ang: -0.04, label: '满力 100% 右塞高杆' },
];

try {
  const cdp = await CDP.open(await getWs());
  await cdp.cmd('Page.enable'); await cdp.cmd('Runtime.enable');
  const { windowId } = await cdp.cmd('Browser.getWindowForTarget');
  await cdp.cmd('Browser.setWindowBounds', { windowId, bounds: { width: 1920, height: 1080 } });
  await cdp.cmd('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(3000);

  for (let i = 0; i < shots.length; i++) {
    const s = shots[i];
    const t0 = performance.now();
    await cdp.ev(`(() => {
      window.__pool.restart();
      window.__pool.cueStrike(${s.power}, ${s.side}, ${s.top}, ${s.ang});
    })()`);
    // 等停稳
    let settled = false;
    while (performance.now() - t0 < 12000) {
      const phase = await cdp.ev('window.__pool.game.phase');
      if (phase === 'aiming' || phase === 'gameover') { settled = true; break; }
      await sleep(120);
    }
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    const info = await cdp.ev(`(() => {
      const g = window.__pool.game;
      const cue = g.balls.find(b => b.num === 0);
      return {
        remaining: g.balls.filter(b => b.num && b.active).length,
        cueX: +cue.x.toFixed(3), cueY: +cue.y.toFixed(3),
        cueRest: cue.state === 'rest',
        foul: g.foul || '无',
      };
    })()`);
    console.log(`杆${i + 1}【${s.label}】停稳=${settled} 用时=${elapsed}s`, JSON.stringify(info));
    const shot = await cdp.cmd('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`/home/wll/feedback/uidreczz28Z50zxF86N/artifacts/3shots-${s.name}.png`,
      Buffer.from(shot.data, 'base64'));
  }
  cdp.ws.close(); edge.kill();
} catch (e) { edge.kill(); console.error('FAIL', e); process.exit(1); }
