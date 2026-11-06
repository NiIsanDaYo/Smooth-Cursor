'use strict';
// Per-frame timing: where the cursor is "now", and the shutter samples for motion blur.
(function (SC) {
  const MAX_SAMPLES = 256;
  const smoothstep = (a, b, x) => {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const u = (x - a) / (b - a);
    return u * u * (3 - 2 * u);
  };

  class Engine {
    constructor() {
      this.motion = new SC.Motion();
      this.frameMs = 1000 / 60;   // display frame interval, measured from rAF deltas
      this.latency = 4;           // age of the newest sample at frame time (input delivery)
      this.prevT = 0;
      this.seenTLast = -1;
      this.blurMs = SC.DEFAULTS.blur;
      this.predict = SC.DEFAULTS.predict;
      this.pressed = false;
      this.positions = new Float32Array(MAX_SAMPLES * 2);
      this.count = 0;
      this._p = [0, 0];
      this._ex = { fade: 1, capS: 0, vx: 0, vy: 0 };
      this._v = [0, 0];
      this.motion.configure(SC.smoothingParams(SC.DEFAULTS.smoothing));
    }

    setSettings(s) {
      this.blurMs = Math.min(Math.max(+s.blur || 0, 0), 50);
      this.predict = !!s.predict;
      this.motion.configure(SC.smoothingParams(+s.smoothing || 0));
    }

    setPressed(on) {
      this.pressed = on;
      this.motion.setBypass(on);
    }

    add(t, x, y) { this.motion.push(t, x, y); }
    reset() { this.motion.reset(); this.seenTLast = -1; }
    get hasData() { return this.motion.has; }

    // T: rAF timestamp (ms). scale: CSS px -> device px. Fills this.positions with device-px
    // points spread uniformly in time across the shutter interval. Returns true when the
    // cursor is at rest and further frames would draw the same image.
    compute(T, scale) {
      const m = this.motion;
      const dT = T - this.prevT;
      if (dT > 2 && dT < 50) this.frameMs += 0.1 * (dT - this.frameMs);
      this.prevT = T;
      if (!m.has) { this.count = 0; return true; }

      if (m.tLast !== this.seenTLast) {
        const g = Math.min(Math.max(T - m.tLast, 0), 30);
        this.latency += 0.15 * (g - this.latency);
        this.seenTLast = m.tLast;
      }
      const F = this.frameMs;
      const usePredict = this.predict && !this.pressed;
      // Software cursors trail the hardware cursor by about one composited frame plus input
      // delivery. Prediction looks one frame ahead (4..12 ms) to cancel that; without it the
      // head sits at the typical age of the newest sample, so it only interpolates.
      const lead = usePredict ? Math.min(Math.max(F, 4), 12) : 0;
      const head = usePredict ? T + lead : T - this.latency;

      // A mouse sends nothing while still: once samples are later than expected, fade the
      // extrapolation out so a sudden stop does not overshoot.
      const gap = T - m.tLast;
      const expected = this.latency + 1.5 * m.dtTyp + 2;
      const ex = this._ex;
      ex.fade = this.pressed ? 0 : 1 - smoothstep(expected, expected + 1.5 * m.dtTyp + 6, gap);
      ex.capS = (lead + this.latency + 2 * m.dtTyp + 4) / 1000;
      // Velocity for extrapolation: a 16 ms least-squares fit. 8 ms tracked turns slightly
      // better but tripled frame-to-frame jitter (1.0 vs 0.5 px RMS at 800 px/s, see
      // dev/jitter-test.mjs); 16 ms costs 1.4 px more overshoot when a fast reach stops.
      // Below ~60 px/s a few whole-pixel counts make any velocity estimate jump around, and the
      // lag there is under a pixel anyway, so extrapolation fades in only above that.
      const v = this._v;
      m.fitVelocity(Math.max(16, 3 * m.dtTyp), v);
      const w = ex.fade * smoothstep(60, 300, Math.hypot(v[0], v[1]));
      ex.vx = v[0] * w;
      ex.vy = v[1] * w;

      const S = this.blurMs;
      const p = this._p;
      let hint = m.sampleAt(head - S, ex, p);
      const ax = p[0], ay = p[1];
      hint = m.sampleAt(head - S / 2, ex, p, hint);
      const bx = p[0], by = p[1];
      m.sampleAt(head, ex, p, hint);
      const cx = p[0], cy = p[1];
      const len = (Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by)) * scale;

      const out = this.positions;
      const rest = Math.hypot(cx - m.rx, cy - m.ry) * scale;
      if (len < 0.02 && rest < 0.02) {
        // At rest: lock to whole device pixels so the sprite stays crisp.
        out[0] = Math.round(m.rx * scale); out[1] = Math.round(m.ry * scale);
        this.count = 1;
        return true;
      }
      if (S <= 0.01 || len < 0.02) {
        out[0] = cx * scale; out[1] = cy * scale;
        this.count = 1;
        return false;
      }
      // Bilinear sampling of the sprite hides gaps up to ~0.5 device px between copies.
      const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(len / 0.5) + 1));
      hint = undefined;
      for (let k = 0; k < n; k++) {
        const tau = head - S + (S * (k + 0.5)) / n;
        hint = m.sampleAt(tau, ex, p, hint);
        out[2 * k] = p[0] * scale;
        out[2 * k + 1] = p[1] * scale;
      }
      this.count = n;
      return false;
    }
  }

  SC.Engine = Engine;
})(self.SmoothCursor);
