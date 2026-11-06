// Frame-to-frame smoothness under realistic input delivery. Usage: node dev/jitter-test.mjs
// A 1000 Hz mouse moves at constant speed; samples reach the page late (steady delay, bursty
// delivery, or a janky main thread). Jerk = RMS deviation of each frame's step from the ideal
// step v*dT, in px. 0 means perfectly even motion; the OS cursor is ~0 by construction.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.self = globalThis;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared');
for (const f of ['constants.js', 'motion.js', 'engine.js']) (0, eval)(readFileSync(join(root, f), 'utf8'));
const SC = globalThis.SmoothCursor;

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const DELIVERY = {
  steady: (t) => t + 1 + rnd() * 2,                       // 1..3 ms after the sample
  bursty: (t) => Math.ceil((t + 1) / 8) * 8 + rnd(),      // arrives in 8 ms clumps
  janky: (t) => { const blk = Math.floor(t / 50); return (blk % 3 === 2) ? (blk + 1) * 50 : t + 1 + rnd() * 2; }, // 1 in 3 blocks of 50 ms stalls
};

function run({ predict, smoothing, delivery, fps, v = 800 }) {
  const e = new SC.Engine();
  e.setSettings({ blur: 0, smoothing, predict });
  const F = 1000 / fps;
  const samples = [];
  for (let t = 0; t < 2000; t += 1) samples.push({ t, x: Math.round((t * v) / 1000), at: DELIVERY[delivery](t) });
  samples.sort((a, b) => a.at - b.at);
  let k = 0, prev = null, sum = 0, n = 0;
  for (let T = 0; T < 2000; T += F) {
    while (k < samples.length && samples[k].at <= T) { const s = samples[k++]; e.add(s.t, s.x, 0); }
    e.compute(T, 1);
    const x = e.positions[0];
    if (prev != null && T > 300) { const d = x - prev - (v * F) / 1000; sum += d * d; n++; }
    prev = x;
  }
  return Math.sqrt(sum / n);
}

for (const fps of [60, 120]) {
  for (const delivery of Object.keys(DELIVERY)) {
    const row = [];
    for (const predict of [false, true]) for (const smoothing of [0, 0.4]) row.push(`${predict ? 'pred' : 'nopred'}/s${smoothing}: ${run({ predict, smoothing, delivery, fps }).toFixed(2)}`);
    console.log(`${fps} fps ${delivery.padEnd(6)} | ${row.join(' | ')}`);
  }
}
