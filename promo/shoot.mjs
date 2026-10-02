#!/usr/bin/env node
/**
 * 逐帧截图：把 promo.html 的确定性舞台渲染成图片序列。
 *
 * 为什么不用「录屏」：宣传片里的每个镜头都要精确可控（棋子正好在第几帧落下、
 * 五连连线正好在第几帧画完）。录屏会有掉帧、会有编码抖动，而且不可重跑。
 * promo.html 暴露了 window.__seek(t)，对同一个 t 永远给出同一帧，所以这里
 * 只做一件事：启动 headless Chrome，连上 CDP，逐帧 evaluate + 截图。
 *
 * 用 Node 内置的 WebSocket（Node ≥ 22）直连 DevTools 协议，不依赖 Playwright/Puppeteer。
 *
 * 用法：
 *   node promo/shoot.mjs [fps] [outDir]
 *   node promo/shoot.mjs 30 promo/frames
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const FPS = Number(process.argv[2] ?? 30);
const OUT = resolve(process.argv[3] ?? join(HERE, 'frames'));
const WIDTH = 1920;
const HEIGHT = 1080;
const PORT = 9333;
const QUALITY = 94;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (CHROME === undefined) {
  console.error('找不到 Chrome / Edge，可用 CHROME_PATH 环境变量指定');
  process.exit(1);
}

const PAGE = `file:///${join(HERE, 'promo.html').replace(/\\/g, '/')}`;
const PROFILE = join(tmpdir(), `dsh-promo-chrome-${process.pid}`);

/* ---------- 极简 CDP 客户端 ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined) {
        const slot = this.pending.get(msg.id);
        if (slot === undefined) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else slot.resolve(msg.result);
        return;
      }
      for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve2, reject) => {
      this.pending.set(id, { resolve: resolve2, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method) {
    return new Promise((resolve2) => {
      const list = this.listeners.get(method) ?? [];
      const fn = (params) => {
        this.listeners.set(method, list.filter((f) => f !== fn));
        resolve2(params);
      };
      list.push(fn);
      this.listeners.set(method, list);
    });
  }
  on(method, fn) {
    const list = this.listeners.get(method) ?? [];
    list.push(fn);
    this.listeners.set(method, list);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 起过的子进程都记在这里，异常路径由 process 钩子统一收掉。 */
const CHILDREN = [];

async function main() {
  console.log(`chrome   : ${CHROME}`);
  console.log(`page     : ${PAGE}`);
  console.log(`fps      : ${FPS}`);
  console.log(`output   : ${OUT}`);

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: 'ignore' });
  CHILDREN.push(chrome);

  // 等 DevTools 端点起来
  let version = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch {}
    await sleep(120);
  }
  if (version === null) { chrome.kill(); throw new Error('DevTools 端点没起来'); }
  console.log(`browser  : ${version.Browser}`);

  // 拿一个 page target（about:blank）
  let target = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
    await sleep(120);
  }
  if (target === null) { chrome.kill(); throw new Error('没有可用的 page target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
  });
  const cdp = new CDP(ws);

  // 页面里抛异常会让 __seek 半路中断 —— 后面的场景整块不动，画面却只是"少了几样东西"。
  // 所以这里直接抓出来并让整次渲染失败，别把坏帧编进成片。
  let pageError = null;
  cdp.on('Runtime.exceptionThrown', (params) => {
    if (pageError === null) {
      pageError = params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown';
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } });

  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: PAGE });
  await loaded;
  // 字体就绪 + 让首帧画完
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts ? document.fonts.ready.then(()=>1) : 1', awaitPromise: true });

  const duration = await cdp.send('Runtime.evaluate', {
    expression: 'window.__duration', returnByValue: true,
  }).then((r) => r.result.value);
  if (typeof duration !== 'number') throw new Error('页面没有暴露 window.__duration');

  const total = Math.round(duration * FPS);
  console.log(`duration : ${duration}s -> ${total} 帧\n`);

  const started = Date.now();
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await cdp.send('Runtime.evaluate', { expression: `window.__seek(${t.toFixed(4)})`, returnByValue: true });
    if (pageError !== null) {
      ws.close(); chrome.kill();
      throw new Error(`第 ${i} 帧（t=${t.toFixed(2)}s）页面抛错，已中止：\n  ${pageError}`);
    }
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: QUALITY, captureBeyondViewport: false, fromSurface: true,
    });
    writeFileSync(join(OUT, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
    if (i % 60 === 0 || i === total - 1) {
      const pct = (((i + 1) / total) * 100).toFixed(0);
      const eta = ((Date.now() - started) / (i + 1)) * (total - i - 1) / 1000;
      process.stdout.write(`  ${String(i + 1).padStart(4)}/${total}  ${pct}%  eta ${eta.toFixed(0)}s\r`);
    }
  }
  process.stdout.write('\n');

  // 顺手导出几张"定妆照"，用于 README / 对话里贴图
  const stills = {
    'still-01-intro': 2.2,
    'still-02-dock': 6.2,
    'still-03-engine': 9.0,
    'still-04-win': 17.6,
    'still-05-modes': 21.2,
    'still-06-outro': 24.2,
  };
  for (const [name, t] of Object.entries(stills)) {
    await cdp.send('Runtime.evaluate', { expression: `window.__seek(${t})`, returnByValue: true });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, 'base64'));
  }

  ws.close();
  chrome.kill();
  await sleep(300);
  rmSync(PROFILE, { recursive: true, force: true });

  const bytes = readFileSync; // 保持导入使用（lint 友好）
  void bytes;
  console.log(`done: ${total} 帧 + ${Object.keys(stills).length} 张定妆照，用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  process.exitCode = 1;
});

/* 兜底：任何一条异常路径（包括脚本自己写错、DPAPI 端点没起来）都要把 Chrome 收掉，
   否则子进程会让 Node 的事件循环永远不退出 —— 表现为"命令卡住不返回"（踩过）。 */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of CHILDREN) child.kill();
    process.exit(1);
  });
}
process.on('exit', () => {
  for (const child of CHILDREN) child.kill();
});
