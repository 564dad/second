// 无头浏览器驱动：通过 CDP 连 Edge/Chrome，做真实页面验证
// 用法：node tests/browser-harness.js
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const EDGE = '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = 'http://localhost:8080/';
const PORT = 9222;
const SHOT_DIR = '/mnt/c/temp';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      // 优先连页面 target（浏览器级 endpoint 不支持 Page/Runtime domain）
      const res = await fetch(`http://localhost:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { await sleep(250); }
  }
  throw new Error('CDP page target not reachable');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && cdp.pending.has(m.id)) {
        const { resolve, reject } = cdp.pending.get(m.id);
        cdp.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        cdp.events.push(m);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const edge = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1920,1080',
    '--user-data-dir=C:\\temp\\edge-harness-' + Date.now(),
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await getWsUrl();
    const cdp = await CDP.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // headless 下 --window-size 可能被忽略，显式通过 CDP 设置窗口
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId, bounds: { width: 1920, height: 1080, windowState: 'normal' },
    });
    await cdp.send('Page.navigate', { url: URL });
    await sleep(3000);

    // 1. 控制台错误检查
    const errors = cdp.events
      .filter(e => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
      .map(e => e.params.args.map(a => a.value || a.description).join(' '));
    const pageErrors = cdp.events
      .filter(e => e.method === 'Runtime.exceptionThrown')
      .map(e => e.params.exceptionDetails.exception?.description || 'exception');
    console.log('console errors:', errors.length ? errors : 'none');
    console.log('page exceptions:', pageErrors.length ? pageErrors : 'none');

    // 2. 页面基本状态
    const state = await cdp.evaluate(`(() => {
      const c = document.getElementById('table');
      const r = c.getBoundingClientRect();
      return {
        canvasW: c.width, canvasH: c.height,
        cssW: Math.round(r.width), cssH: Math.round(r.height),
        innerW: window.innerWidth, innerH: window.innerHeight,
        remaining: document.getElementById('remaining').textContent,
        message: document.getElementById('message').textContent,
      };
    })()`);
    console.log('page state:', JSON.stringify(state));

    // 3. FPS 采样：空转 2 秒，用 requestAnimationFrame 计数
    const fps = await cdp.evaluate(`new Promise(res => {
      let n = 0; const t0 = performance.now();
      function tick() {
        n++;
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
        else res(Math.round(n * 1000 / (performance.now() - t0)));
      }
      requestAnimationFrame(tick);
    })`);
    console.log(`idle FPS (1920x1080, DPR=${await cdp.evaluate('window.devicePixelRatio')}): ${fps}`);

    // 4. 模拟完整击球：移动鼠标到球桌右侧瞄准 -> 按下蓄力 -> 松开
    const box = await cdp.evaluate(`(() => {
      const r = document.getElementById('table').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    })()`);
    const aimX = box.x + box.w * 0.75;
    const aimY = box.y + box.h * 0.5;
    async function mouse(type, x, y, button = 'left') {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x, y, button, clickCount: 1,
        buttons: type === 'mouseReleased' ? 0 : 1,
      });
    }
    await mouse('mouseMoved', aimX, aimY);
    await sleep(100);
    await mouse('mousePressed', aimX, aimY);
    await sleep(700); // 蓄力 70%
    await mouse('mouseReleased', aimX, aimY);
    console.log('shot fired, waiting for balls to settle...');
    await sleep(9000);

    const after = await cdp.evaluate(`(() => ({
      remaining: document.getElementById('remaining').textContent,
      foul: document.getElementById('foul').textContent,
      phase: window.__debugPhase || 'n/a',
    }))()`);
    console.log('after shot:', JSON.stringify(after));

    // 5. 击球后截图
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('/home/wll/feedback/uidreczz28Z50zxF86N/artifacts/shot-after-break.png',
      Buffer.from(shot.data, 'base64'));
    console.log('screenshot saved: artifacts/shot-after-break.png');

    // 6. 击球过程中的 FPS（通过注入计数器取最近 1 秒）
    const fpsBusy = await cdp.evaluate(`new Promise(res => {
      let n = 0; const t0 = performance.now();
      function tick() {
        n++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else res(Math.round(n * 1000 / (performance.now() - t0)));
      }
      requestAnimationFrame(tick);
    })`);
    console.log(`post-shot FPS: ${fpsBusy}`);

    cdp.close();
    edge.kill();
    if (errors.length || pageErrors.length) process.exit(1);
  } catch (e) {
    edge.kill();
    console.error('HARNESS FAIL:', e.message);
    process.exit(2);
  }
}

main();
