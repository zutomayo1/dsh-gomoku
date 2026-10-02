#!/usr/bin/env node
/**
 * 宣传片的音轨：用纯 JS 合成一条 120 BPM 的电子乐，写成 WAV。
 *
 * 为什么自己合成而不是找现成音乐：
 *   1. 片子是按 120 BPM 的网格排的（棋子落在 16 分音符上、冲击打在重拍上），
 *      自己生成才可能**逐拍对齐**；
 *   2. 不引入版权与外部依赖，`node promo/audio.mjs` 随时重建；
 *   3. 全部用固定种子的噪声，重跑得到字节一致的音轨（跟逐帧渲染一个道理）。
 *
 * 编曲：intro(渐变) → verse(4-on-the-floor + 贝斯) → gap(抽掉鼓) → drop(重拍冲击)
 *        → tools(滤波过场) → modes(推进) → outro(渐弱)
 *
 * 用法：node promo/audio.mjs [out.wav]
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(process.argv[2] ?? join(HERE, 'out', 'dsh-gomoku-promo.wav'));

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM;          // 0.5s
const BAR = BEAT * 4;           // 2.0s
const STEP = BEAT / 4;          // 16 分音符 = 0.125s
const DUR = 29.0;               // 与视频等长
const N = Math.round(SR * DUR);

const L = new Float32Array(N);
const R = new Float32Array(N);

/* ---------- 固定种子噪声（不用 Math.random，保证可复现）---------- */
let seed = 0x9e3779b9;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return (seed / 4294967296) * 2 - 1;
}

/* ---------- 基础工具 ---------- */
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
/** 指数衰减包络。 */
const decay = (t, tau) => Math.exp(-t / tau);
/** 线性 attack + 指数 decay。 */
function ade(t, atk, tau) {
  if (t < 0) return 0;
  if (t < atk) return t / atk;
  return Math.exp(-(t - atk) / tau);
}

function add(i, l, r) {
  if (i < 0 || i >= N) return;
  L[i] += l;
  R[i] += r;
}

/* ---------- 乐器 ---------- */
/** 底鼓：正弦扫频 + 咔哒。 */
function kick(t0) {
  const len = Math.round(0.42 * SR);
  const start = Math.round(t0 * SR);
  let phase = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const f = 48 + 150 * Math.exp(-t / 0.028);
    phase += (2 * Math.PI * f) / SR;
    const body = Math.sin(phase) * Math.exp(-t / 0.19);
    const click = n < 120 ? rnd() * 0.25 * (1 - n / 120) : 0;
    const s = (body + click) * 0.95;
    add(start + n, s, s);
  }
}
/** 踩镲：高通噪声。 */
function hat(t0, open) {
  const len = Math.round((open ? 0.16 : 0.05) * SR);
  const start = Math.round(t0 * SR);
  let prev = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const w = rnd() * (open ? 2.2 : 3.2);
    const hp = w - prev;                 // 一阶差分 = 粗糙高通
    prev = w;
    const s = hp * decay(t, open ? 0.05 : 0.012) * 0.30;
    add(start + n, s * 0.85, s);
  }
}
/** 拍手：两段噪声叠一点延迟。 */
function clap(t0) {
  const len = Math.round(0.22 * SR);
  const start = Math.round(t0 * SR);
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const a = decay(t, 0.012) + 0.7 * decay(Math.max(0, t - 0.009), 0.03) + 0.5 * decay(Math.max(0, t - 0.019), 0.05);
    const s = rnd() * a * 0.30;
    add(start + n, s, s);
  }
}
/** 贝斯：锯齿 + 一阶低通（带包络）+ 软削波。 */
function bass(t0, freq, dur, gain = 1) {
  const len = Math.round(Math.min(dur, 1.2) * SR);
  const start = Math.round(t0 * SR);
  let phase = 0;
  let lp = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    phase += freq / SR;
    const saw = 2 * (phase - Math.floor(phase)) - 1;
    const sq = saw > 0 ? 1 : -1;
    const raw = saw * 0.7 + sq * 0.3;
    const cut = Math.exp(-t / 0.14);
    lp += (raw - lp) * clamp(0.06 + 0.5 * cut, 0, 1);
    const env = ade(t, 0.004, 0.16) * (1 - t / (len / SR));
    const s = Math.tanh(lp * 2.4) * env * 0.55 * gain;
    add(start + n, s, s);
  }
}
/** 琶音：锯齿+方波，短促，左右交替摆位。 */
function arp(t0, freq, gain = 1, pan = 0) {
  const len = Math.round(0.30 * SR);
  const start = Math.round(t0 * SR);
  let phase = 0;
  const l = 0.5 - pan * 0.5, r = 0.5 + pan * 0.5;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    phase += freq / SR;
    const saw = 2 * (phase - Math.floor(phase)) - 1;
    const sq = Math.sin(2 * Math.PI * phase) > 0 ? 1 : -1;
    const raw = saw * 0.55 + sq * 0.45;
    const env = ade(t, 0.002, 0.075);
    const s = raw * env * 0.20 * gain;
    add(start + n, s * l * 2, s * r * 2);
  }
}
/** 铺底：两个失谐锯齿 + 慢起音，低通。 */
function pad(t0, freqs, dur, gain = 1) {
  const len = Math.round(dur * SR);
  const start = Math.round(t0 * SR);
  const phases = freqs.map(() => 0);
  let lp = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    let raw = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] += (freqs[k] * (1 + (k % 2 === 0 ? 0.0016 : -0.0016))) / SR;
      const p = phases[k] - Math.floor(phases[k]);
      raw += (2 * p - 1) * 0.33;
    }
    lp += (raw / freqs.length - lp) * 0.09;
    const env = ade(t, 0.5, dur * 0.9) * (1 - clamp((t - (dur - 0.8)) / 0.8, 0, 1));
    const s = lp * env * 0.30 * gain;
    add(start + n, s, s);
  }
}
/** 上升音（riser）：带通噪声往上扫 + 升调正弦。 */
function riser(t0, dur, gain = 0.5) {
  const len = Math.round(dur * SR);
  const start = Math.round(t0 * SR);
  let lp = 0, phase = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const k = t / dur;
    const w = rnd();
    lp += (w - lp) * (0.02 + 0.55 * k * k);
    const hp = w - lp;
    phase += (180 + 900 * k * k) / SR;
    const tone = Math.sin(2 * Math.PI * phase) * 0.25;
    const env = Math.pow(k, 1.5);
    const s = (hp * 1.6 + tone) * env * 0.5 * gain;
    add(start + n, s, s * 0.92);
  }
}
/** 冲击：低频砸 + 噪声爆 + 快速下行。 */
function impact(t0, gain = 1) {
  const len = Math.round(1.4 * SR);
  const start = Math.round(t0 * SR);
  let phase = 0, lp = 0;
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    const f = 40 + 220 * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * f) / SR;
    const thud = Math.sin(phase) * decay(t, 0.35);
    const w = rnd();
    lp += (w - lp) * 0.35;
    const burst = (w - lp) * decay(t, 0.16);
    const s = (thud * 0.9 + burst * 0.5) * 0.9 * gain;
    add(start + n, s, s);
  }
}
/** 和弦刺（stinger）。 */
function stinger(t0, freqs, gain = 1) {
  const len = Math.round(1.1 * SR);
  const start = Math.round(t0 * SR);
  const phases = freqs.map(() => 0);
  for (let n = 0; n < len; n++) {
    const t = n / SR;
    let raw = 0;
    for (let k = 0; k < freqs.length; k++) {
      phases[k] += freqs[k] / SR;
      const p = phases[k] - Math.floor(phases[k]);
      raw += (2 * p - 1) * 0.25;
    }
    const env = ade(t, 0.004, 0.22);
    const s = Math.tanh(raw * 1.6) * env * 0.42 * gain;
    add(start + n, s, s);
  }
}

/* ---------- 编曲 ----------
 * 段落（全部落在 120 BPM 的网格上）：
 *   0.0-0.5  静场 + riser
 *   0.5      冲击（与画面白光命中同拍）
 *   1.0-3.0  intro：稀疏底鼓 + 铺底
 *   3.0-7.5  verse：4-on-the-floor + 贝斯 + 铺底
 *   7.5-14.0 对局：加 8 分踩镲与 16 分琶音（棋子正落在 16 分音符上）
 *   14.0-14.5 gap：抽掉鼓，只剩铺底 —— 与画面的命中停顿对齐
 *   14.5     五连 drop：最强冲击 + 和弦刺
 *   14.5-18.0 half-time，粒子段
 *   18.0-21.5 tools：低通过场，琶音放缓
 *   21.5-24.5 modes：重新推进
 *   24.5-29.0 outro：渐弱 + 尾音
 */
const ROOTS = [33, 33, 29, 31];                  // A1 A1 F1 G1
const ARP = [0, 3, 7, 12, 7, 3];                 // 小调琶音音级
const PAD_CHORD = [[57, 60, 64], [57, 60, 64], [53, 57, 60], [55, 59, 62]];

riser(0.02, 0.48, 0.55);
impact(0.5, 1.0);
impact(14.5, 1.15);
stinger(14.5, [69, 72, 76, 81], 1.0);
stinger(24.5, [57, 60, 64, 69], 0.75);
impact(24.5, 0.55);

for (let i = 0; i * STEP < DUR - 0.05; i++) {
  const t = i * STEP;
  const beatIdx = Math.round(t / BEAT);
  const bar = Math.floor(t / BAR);
  const root = ROOTS[bar % 4];
  const quarter = i % 4 === 0;
  const eighth = i % 2 === 0;
  const sixteenth = true;

  const inGap = t >= 14.0 && t < 14.5;
  const tail = t > 27.6;
  if (tail) break;

  // 底鼓
  if (quarter && t >= 1.0 && !inGap) {
    if (t < 3.0) { if (beatIdx % 2 === 0) kick(t); }
    else kick(t);
  }
  // 踩镲
  if (eighth && t >= 3.0 && !inGap) hat(t, quarter && beatIdx % 4 === 3);
  // 拍手：2、4 拍
  if (quarter && beatIdx % 4 === 2 && t >= 3.0 && !inGap) clap(t);
  // 贝斯：8 分
  if (eighth && t >= 3.0 && !inGap) {
    const oct = t >= 18.0 && t < 21.5 ? 0 : 0;
    bass(t, midi(root + oct), STEP * 2, t >= 14.5 ? 1.05 : 0.9);
  }
  // 琶音：对局段 16 分，其余 8 分
  if (t >= 7.5 && !inGap) {
    const busy = t < 14.0;
    if (busy ? sixteenth : eighth) {
      const deg = ARP[i % ARP.length];
      const base = t >= 18.0 && t < 21.5 ? 48 : 57;
      arp(t, midi(root + 24 + deg - 12 + (base - 57)), t >= 14.5 ? 1.0 : 0.8, (i % 2 ? 0.5 : -0.5));
    }
  }
  // 铺底：每两小节铺一次
  if (i % 16 === 0 && t >= 0.5) {
    const chord = PAD_CHORD[bar % 4].map((n) => midi(n));
    pad(t, chord, BAR * 2 - 0.05, t < 3.0 ? 0.8 : t < 14.5 ? 0.5 : 0.62);
  }
}

/* ---------- 侧链：每次底鼓把中低频压下去一点（电子乐"呼吸"的来源）---------- */
{
  const duck = new Float32Array(N).fill(1);
  for (let b = 0; b * BEAT < DUR; b++) {
    const t0 = b * BEAT;
    if (t0 < 1.0 || (t0 >= 14.0 && t0 < 14.5) || t0 > 27.6) continue;
    const start = Math.round(t0 * SR);
    const len = Math.round(0.26 * SR);
    for (let n = 0; n < len; n++) {
      const i = start + n;
      if (i >= N) break;
      const k = Math.exp(-(n / SR) / 0.11);
      duck[i] = Math.min(duck[i], 1 - 0.55 * k);
    }
  }
  for (let i = 0; i < N; i++) { L[i] *= duck[i]; R[i] *= duck[i]; }
}

/* ---------- 母带：软限幅 + 淡出 + 归一 ---------- */
{
  let peak = 0;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh(L[i] * 1.15);
    R[i] = Math.tanh(R[i] * 1.15);
    const fadeIn = clamp(i / (SR * 0.02), 0, 1);
    const fadeOut = clamp((N - i) / (SR * 1.4), 0, 1);
    const g = fadeIn * fadeOut;
    L[i] *= g; R[i] *= g;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const norm = peak > 0 ? 0.92 / peak : 1;
  for (let i = 0; i < N; i++) { L[i] *= norm; R[i] *= norm; }
}

/* ---------- 写 16bit PCM WAV ---------- */
const bytes = 44 + N * 4;
const buf = Buffer.alloc(bytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(bytes - 8, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);          // PCM
buf.writeUInt16LE(2, 22);          // 立体声
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28);     // 字节率
buf.writeUInt16LE(4, 32);          // 块对齐
buf.writeUInt16LE(16, 34);         // 位深
buf.write('data', 36);
buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 44 + i * 4 + 2);
}
writeFileSync(OUT, buf);

let sum = 0;
for (let i = 0; i < N; i++) sum += L[i] * L[i];
console.log(`音轨：${OUT}`);
console.log(`  ${DUR}s / ${BPM} BPM / ${SR}Hz 立体声 / ${(bytes / 1048576).toFixed(1)} MB / RMS ${Math.sqrt(sum / N).toFixed(3)}`);
