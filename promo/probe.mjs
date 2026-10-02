#!/usr/bin/env node
/** 调试：打印若干时刻下 相机变换 / 窗口 / 棋盘 / 各场景的屏幕矩形。 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9334;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
const PROFILE = join(tmpdir(), `dsh-promo-probe-${process.pid}`);
const PAGE = `file:///${join(HERE, 'promo.html').replace(/\\/g, '/')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1920,1080', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let version = null;
for (let i = 0; i < 100 && version === null; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) version = await r.json(); } catch {}
  if (version === null) await sleep(120);
}
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); }
});
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

// 收集页面异常与 console.error —— 半路抛错会让后面的场景整块不动，这是最难查的一类
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('!! PAGE EXCEPTION:', d.text, d.exception?.description ?? '');
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    console.log('!! CONSOLE ERROR:', m.params.entry.text);
  }
});
await send('Log.enable');

await send('Page.navigate', { url: PAGE });
await sleep(1200);

const probe = `(() => {
  const r = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             display: cs.display, opacity: Number(cs.opacity).toFixed(2), z: cs.zIndex,
             color: cs.color, fs: cs.fontSize, text: (el.textContent || '').slice(0, 12) };
  };
  return {
    cam: getComputedStyle(document.getElementById('cam')).transform,
    win: r('.win'), board: r('#boardFrame'), s1: r('#s1'), app: r('#app'),
    s4: r('#s4'), s4win: r('#s4win'), s4sub: r('#s4sub'), s5: r('#s5'), s6: r('#s6'),
    kinetic: r('#kinetic'), kinTitle: r('#kinTitle'), caption: r('#caption'),
  };
})()`;

for (const t of [2.2, 6.2, 9.6, 16.0, 17.6, 18.6, 21.2, 24.2]) {
  await send('Runtime.evaluate', { expression: `window.__seek(${t})` });
  await sleep(60);
  const out = await send('Runtime.evaluate', { expression: probe, returnByValue: true });
  console.log(`\n=== t=${t} ===`);
  console.log('cam      :', out.result.value.cam);
  for (const k of ['win', 'board', 's1', 'app', 's4', 's4win', 's4sub', 's5', 's6', 'kinetic', 'kinTitle', 'caption']) {
    const v = out.result.value[k];
    console.log(`  ${k.padEnd(9)}:`, v === null ? 'null'
      : `x${v.x} y${v.y} ${v.w}x${v.h} ${v.display} op=${v.opacity} z=${v.z} fs=${v.fs} "${v.text}"`);
  }
}

ws.close();
chrome.kill();
await sleep(200);
rmSync(PROFILE, { recursive: true, force: true });
