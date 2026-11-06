'use strict';
// Pointer trajectory: raw samples at the device polling rate -> isotropic One Euro Filter
// -> time-indexed history that the renderer can query at any instant.
(function (SC) {
  const TAU = Math.PI * 2;
  const CAP = 2048;          // ring buffer size; 2 s at 1000 Hz
  const KEEP_MS = 1000;      // history kept for interpolation
  const SNAP_MS = 16;        // glide from the smoothed point to the click point on press

  class Motion {
    constructor() {
      this.t = new Float64Array(CAP);
      this.x = new Float64Array(CAP);
      this.y = new Float64Array(CAP);
      this.qx = new Float64Array(CAP);   // raw positions, for the prediction velocity fit
      this.qy = new Float64Array(CAP);
      this.params = null;    // One Euro params, or null when smoothing is off
      this.reset();
    }

    configure(params) { this.params = params; }

    reset() {
      this.len = 0;
      this.head = 0;         // next write slot
      this.has = false;
      this.rx = 0; this.ry = 0;      // last raw sample (CSS px)
      this.fx = 0; this.fy = 0;      // filter state at tLast
      this.vx = 0; this.vy = 0;      // filtered derivative of the raw input (px/s)
      this.tLast = 0;
      this.dtTyp = 4;                // typical sample interval (ms), adapts to the device
      this.bypass = false;
      this.snapT = null;             // history switches to raw positions here
      this.glideT = null;            // first drawn time after the press; the offset decays from it
      this.snapX = 0; this.snapY = 0;
    }

    // Pressed buttons: the page reacts to the raw position (drags, selections), so the
    // visible cursor must sit exactly on it.
    // tDrawn: the time last drawn on screen, so the glide starts where the cursor was seen.
    setBypass(on, tDrawn) {
      if (on === this.bypass) return;
      if (on) this.snap(tDrawn);   // before bypass is set: snap projects with the filter
      this.bypass = on;
    }

    // On press the filter jumps to the raw position, so drags start exactly on the click point.
    // The drawn path glides over SNAP_MS instead: history after the press holds raw positions,
    // and sampleAt adds the press-time offset back, in full until the first frame drawn after
    // the press (glideT, set by the engine) and then with a smoothstep decay. A second sample
    // at the same timestamp holds the raw point, so the path stays continuous at the press.
    snap(tDrawn) {
      if (!this.has) return;
      // The committed filter state is from the last sample; while the mouse rested, the drawn
      // cursor kept settling past it, so measure the offset from the settled point instead.
      let px = this.fx, py = this.fy;
      if (tDrawn > this.tLast && this.params) {
        const o = [0, 0];
        this._project((tDrawn - this.tLast) / 1000, { fade: 0, capS: 0, vx: 0, vy: 0 }, o);
        px = o[0]; py = o[1];
      }
      const ox = px - this.rx, oy = py - this.ry;
      this.fx = this.rx; this.fy = this.ry;
      if (Math.hypot(ox, oy) < 0.05) { this.snapT = null; return; }
      this.snapT = this.tLast;
      this.glideT = null;
      this.snapX = ox; this.snapY = oy;
      this._store(this.tLast, this.rx, this.ry);
    }

    _store(t, x, y) {
      const i = this.head;
      this.t[i] = t; this.x[i] = x; this.y[i] = y; this.qx[i] = this.rx; this.qy[i] = this.ry;
      this.head = (i + 1) % CAP;
      if (this.len < CAP) this.len++;
    }

    _at(k) { return (this.head - this.len + k + CAP) % CAP; } // k = 0 oldest .. len-1 newest

    push(t, x, y) {
      if (!this.has) {
        this.has = true;
        this.rx = this.fx = x; this.ry = this.fy = y;
        this.vx = this.vy = 0; this.tLast = t;
        this._store(t, x, y);
        return;
      }
      let dt = t - this.tLast;
      if (dt < 0) return;                       // late sample from another frame source
      if (dt === 0) {                           // same timestamp: keep the newest position
        this.rx = x; this.ry = y;
        if (!this.params || this.bypass) { this.fx = x; this.fy = y; }
        const i = (this.head - 1 + CAP) % CAP;
        this.x[i] = this.fx; this.y[i] = this.fy; this.qx[i] = x; this.qy[i] = y;
        return;
      }
      // A jump after a pause can only come from leaving and re-entering the page or an
      // iframe handoff; filtering it would fling the cursor across the screen.
      if (dt > 25 && Math.hypot(x - this.rx, y - this.ry) > 64) {
        this.reset();
        this.push(t, x, y);
        return;
      }
      this.dtTyp += 0.2 * (Math.min(dt, 3 * this.dtTyp) - this.dtTyp);
      this.dtTyp = Math.min(Math.max(this.dtTyp, 0.5), 16);

      // A mouse sends nothing while still, so a long interval means "held at the previous
      // position, then moved". Hold first, then apply the step over one typical interval.
      // This matches what the renderer projected while waiting, so nothing jumps.
      if (dt > 2 * this.dtTyp + 4) {
        const hold = dt - this.dtTyp;
        this._hold(hold / 1000);
        dt = this.dtTyp;
      }
      this._step(dt / 1000, x, y);
      this.tLast = t;
      this._store(t, this.fx, this.fy);
      this._prune(t);
    }

    _prune(now) {
      while (this.len > 2 && this.t[this._at(0)] < now - KEEP_MS) this.len--;
    }

    // Exact exponential smoothing, alpha = 1 - exp(-2*pi*fc*dt), instead of the paper's
    // 1/(1 + tau/dt): it stays correct for the irregular intervals real mice produce.
    _step(dt, x, y) {
      const p = this.params;
      const ex = (x - this.rx) / dt, ey = (y - this.ry) / dt;
      const dc = p ? p.dCutoff : 8;
      const ad = 1 - Math.exp(-TAU * dc * dt);
      this.vx += ad * (ex - this.vx);
      this.vy += ad * (ey - this.vy);
      this.rx = x; this.ry = y;
      if (!p || this.bypass) { this.fx = x; this.fy = y; return; }
      // Isotropic: one cutoff from the 2D speed, so diagonal and axis-aligned motion get
      // the same lag (per-axis filters bend curves and circles).
      const fc = p.minCutoff + p.beta * Math.hypot(this.vx, this.vy);
      const a = 1 - Math.exp(-TAU * fc * dt);
      this.fx += a * (x - this.fx);
      this.fy += a * (y - this.fy);
    }

    _hold(dt) {
      const dc = this.params ? this.params.dCutoff : 8;
      const ad = Math.exp(-TAU * dc * dt);
      this.vx *= ad; this.vy *= ad;
      const p = this.params;
      if (!p || this.bypass) { this.fx = this.rx; this.fy = this.ry; return; }
      const r = Math.exp(-TAU * p.minCutoff * dt);
      this.fx = this.rx + (this.fx - this.rx) * r;
      this.fy = this.ry + (this.fy - this.ry) * r;
    }

    // Position at time tau (ms). Inside the history: linear interpolation of filtered samples.
    // After the newest sample: closed-form response of the filter to the raw input
    // extrapolated at velocity f*v for up to capMs, then held. f = 0 gives pure settling.
    // `out` receives [x, y]. `hint` is a history index to start searching from.
    sampleAt(tau, ex, out, hint) {
      const k = this._base(tau, ex, out, hint);
      if (this.snapT !== null && tau >= this.snapT) {
        const u = this.glideT === null ? 0 : Math.max(0, (tau - this.glideT) / SNAP_MS);
        if (u >= 1) { if (tau - this.glideT > 1000) this.snapT = null; }
        else { const w = 1 - u * u * (3 - 2 * u); out[0] += this.snapX * w; out[1] += this.snapY * w; }
      }
      return k;
    }

    _base(tau, ex, out, hint) {
      if (!this.has) { out[0] = 0; out[1] = 0; return 0; }
      if (tau >= this.tLast) { this._project((tau - this.tLast) / 1000, ex, out); return this.len - 1; }
      let k = Math.min(hint ?? this.len - 1, this.len - 1);
      while (k > 0 && this.t[this._at(k)] > tau) k--;
      while (k < this.len - 1 && this.t[this._at(k + 1)] <= tau) k++;
      const i0 = this._at(k);
      if (k >= this.len - 1) { out[0] = this.x[i0]; out[1] = this.y[i0]; return k; }
      const i1 = this._at(k + 1);
      const t0 = this.t[i0], t1 = this.t[i1];
      if (tau <= t0) { out[0] = this.x[i0]; out[1] = this.y[i0]; return k; }
      const u = (tau - t0) / (t1 - t0);
      out[0] = this.x[i0] + (this.x[i1] - this.x[i0]) * u;
      out[1] = this.y[i0] + (this.y[i1] - this.y[i0]) * u;
      return k;
    }

    // Least-squares velocity of the raw samples in the last windowMs. Lags about windowMs / 2,
    // far less than the filter's smoothed derivative, so extrapolated curves stay on the curve.
    fitVelocity(windowMs, out) {
      out[0] = 0; out[1] = 0;
      if (this.len < 2) return 0;
      let n = 0, st = 0, sx = 0, sy = 0;
      const from = this.tLast - windowMs;
      let k = this.len - 1;
      for (; k >= 0; k--) {
        const i = this._at(k);
        if (this.t[i] < from && n >= 2) break;
        st += this.t[i]; sx += this.qx[i]; sy += this.qy[i]; n++;
      }
      if (n < 2) return 0;
      const mt = st / n, mx = sx / n, my = sy / n;
      let stt = 0, stx = 0, sty = 0;
      for (let j = this.len - n; j < this.len; j++) {
        const i = this._at(j), dt = this.t[i] - mt;
        stt += dt * dt; stx += dt * (this.qx[i] - mx); sty += dt * (this.qy[i] - my);
      }
      if (stt <= 0) return 0;
      out[0] = (stx / stt) * 1000; out[1] = (sty / stt) * 1000;
      return n;
    }

    _project(d, ex, out) {
      const f = ex.fade;
      const vx = ex.vx, vy = ex.vy;
      const d1 = Math.min(d, ex.capS);
      const p = this.params;
      if (!p || this.bypass) {
        out[0] = this.rx + vx * d1; out[1] = this.ry + vy * d1;
        return;
      }
      const k = TAU * (p.minCutoff + p.beta * f * Math.hypot(this.vx, this.vy));
      const ik = 1 / k;
      // Phase 1, ramp input r(t) = raw + v t:  y(t) = r(t) - v/k + (y0 - raw + v/k) e^{-kt}
      const e1 = Math.exp(-k * d1);
      let x = this.rx + vx * d1 - vx * ik + (this.fx - this.rx + vx * ik) * e1;
      let y = this.ry + vy * d1 - vy * ik + (this.fy - this.ry + vy * ik) * e1;
      // Phase 2, input held at r(d1): plain exponential settling.
      if (d > d1) {
        const hx = this.rx + vx * d1, hy = this.ry + vy * d1;
        const e2 = Math.exp(-k * (d - d1));
        x = hx + (x - hx) * e2;
        y = hy + (y - hy) * e2;
      }
      out[0] = x; out[1] = y;
    }

    get speed() { return Math.hypot(this.vx, this.vy); }
  }

  SC.Motion = Motion;
})(self.SmoothCursor);
