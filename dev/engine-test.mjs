// Numeric checks for the motion engine. Usage: node dev/engine-test.mjs
// Simulates a 1000 Hz integer-quantized mouse and 60 Hz frames; reports lag while moving,
// overshoot after an abrupt stop, settling time, and radius error on a circle.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

globalThis.self = globalThis;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared');
for (const f of ['constants.js', 'motion.js', 'engine.js']) (0, eval)(readFileSync(join(root, f), 'utf8'));
const SC = globalThis.SmoothCursor;

function run({ smoothing, predict, path, until = 1500, hz = 1000, fps = 60, delay = 2 }) {
  const e = new SC.Engine();
  e.setSettings({ blur: 0, smoothing, predict });
  const F = 1000 / fps;
  let ts = 0;
  const frames = [];
  for (let T = 0; T < until; T += F) {
    for (; ts <= T - delay; ts += 1000 / hz) {
      const [x, y] = path(ts);
      const last = e.motion.has ? [e.motion.rx, e.motion.ry] : null;
      if (!last || last[0] !== x || last[1] !== y) e.add(ts, x, y); // mice report only on change
    }
    e.compute(T, 1);
    frames.push({ T, x: e.positions[0], y: e.positions[1] });
  }
  return frames;
}

const v = 2000; // px/s
const stopT = 600;
const line = (t) => [Math.round(Math.min(t, stopT) * v / 1000), 0];
// Minimum-jerk reach (Flash & Hogan 1985), the profile of real pointing moves: 700 px in 350 ms.
const reach = (t) => { const u = Math.min(Math.max((t - 250) / 350, 0), 1); return [Math.round(700 * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5)), 0]; };
const circle = (t) => { const a = t / 500 * Math.PI * 2; return [Math.round(200 * Math.cos(a)), Math.round(200 * Math.sin(a))]; };

for (const smoothing of [0, 0.4, 0.7, 1]) {
  for (const predict of [false, true]) {
    const f = run({ smoothing, predict, path: line });
    // lag while moving at steady speed: true position at frame time minus drawn position
    const mid = f.filter((r) => r.T > 300 && r.T < 550);
    const lagPx = mid.reduce((s, r) => s + (r.T * v / 1000 - r.x), 0) / mid.length;
    const end = stopT * v / 1000;
    const after = f.filter((r) => r.T >= stopT);
    const overshoot = Math.max(0, ...after.map((r) => r.x - end));
    const settle = (after.find((r, i) => after.slice(i).every((q) => Math.abs(q.x - end) < 0.5)) || {}).T - stopT;
    const r2 = run({ smoothing, predict, path: reach });
    const reachOver = Math.max(0, ...r2.map((r) => r.x - 700));
    const lagMid = r2.filter((r) => r.T > 380 && r.T < 470).reduce((s, r) => s + Math.abs(reach(r.T)[0] - r.x), 0) / r2.filter((r) => r.T > 380 && r.T < 470).length;
    const c = run({ smoothing, predict, path: circle }).filter((r) => r.T > 500);
    const radius = c.reduce((s, r) => s + Math.hypot(r.x, r.y), 0) / c.length;
    console.log(`smoothing ${smoothing.toFixed(1)} predict ${predict ? 'on ' : 'off'} | lag ${lagPx.toFixed(1).padStart(5)} px (${(lagPx / v * 1000).toFixed(1).padStart(4)} ms) | overshoot ${overshoot.toFixed(1).padStart(4)} px | settle ${String(Math.round(settle)).padStart(4)} ms | circle r=200 -> ${radius.toFixed(1)} | reach: mid err ${lagMid.toFixed(1)} px, overshoot ${reachOver.toFixed(1)} px`);
  }
}
