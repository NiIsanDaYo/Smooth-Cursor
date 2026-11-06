'use strict';
// Cross-frame plumbing. Only the top frame draws: its overlay covers every iframe, so the
// cursor and its blur cross iframe edges without being clipped. Child frames forward their
// samples and cursor state up a private MessagePort; each hop converts to its own viewport.
(function (SC) {
  const TAG = '__smoothCursor';
  const SELF = 'self';

  // Picks which source (this document or a child frame) currently owns the pointer and
  // forwards that source's stream to `out` (the compositor, or the upstream port).
  class Mux {
    constructor(out) {
      this.out = out;
      this.owner = SELF;
      this.own = null;
      this.lastT = -Infinity;
      this.bridges = new Set();
    }

    // ----- this document -----
    samples(buf) {
      this.lastT = Math.max(this.lastT, buf[buf.length - 3]);
      if (this.owner !== SELF) { this.owner = SELF; this.emit(); }
      this.out.samples(buf);
    }
    press(on) { if (this.owner === SELF) this.out.press(on); }
    state(st) { this.own = st; if (this.owner === SELF) this.emit(); }
    leave() {
      this.own = null;
      if (this.owner === SELF) this.out.leave();
    }
    // Extension reloaded under this page: children must stop hiding their cursor, since
    // nothing up here will draw it any more.
    orphaned() {
      for (const b of this.bridges) b.setLive(false);
      if (this.out.orphaned) this.out.orphaned();
    }

    // ----- child frames (already converted to this document's coordinates and clock) -----
    childSamples(b, buf) {
      // A child may only drive the cursor while this document saw the pointer enter its
      // frame element, so an embedded page cannot move the cursor anywhere else.
      if (!this.own || !this.own.frame || this.own.frame !== b.element()) return;
      const newest = buf[buf.length - 3];
      if (!(newest > this.lastT)) return;    // arrived after the pointer moved on
      this.lastT = newest;
      if (this.owner !== b) { this.owner = b; this.emit(); }
      this.out.samples(buf);
    }
    childPress(b, on) { if (this.owner === b) this.out.press(on); }
    childState(b, st) { b.st = st; if (this.owner === b) this.emit(); }
    childLeave(b) {
      b.st = null;
      if (this.owner === b) { this.owner = SELF; this.emit(); }
    }

    bridgeFor(el) {
      if (!el) return null;
      let win = null;
      try { win = el.contentWindow; } catch { /* no browsing context */ }
      if (!win) return null;
      for (const b of this.bridges) if (b.source === win) return b;
      return null;
    }

    emit() {
      const own = this.own;
      if (this.owner !== SELF) {
        const b = this.owner;
        if (own && own.frame && own.frame === b.element()) {
          this.out.state(b.st || { inside: true, os: null, cursor: null, keep: true, layer: own.layer });
          return;
        }
        this.owner = SELF;
      }
      if (!own) { this.out.leave(); return; }
      if (own.frame) {
        const b = this.bridgeFor(own.frame);
        // The frame draws through us only once its own script runs and hides its cursor
        // (it says so with 'ready'). Until then, or with no script at all (PDF viewer,
        // chrome:// pages, SVG documents), its own cursor shows there and ours steps aside.
        if (!b || !b.ready) { this.out.state({ inside: true, os: 'frame', cursor: null, layer: own.layer }); return; }
        // The child takes over as soon as its first samples arrive; keep the last look.
        this.out.state({ inside: true, os: null, cursor: null, keep: true, layer: own.layer });
        return;
      }
      this.out.state(own);
    }
  }

  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  // Parent-side end of a child frame's port.
  class ChildBridge {
    constructor(mux, source, port) {
      this.mux = mux;
      this.source = source;
      this.port = port;
      this.st = null;
      this.live = false;     // we told the child to run
      this.ready = false;    // the child reports it runs and its cursor is hidden
      port.onmessage = (e) => this.onMessage(e.data);
    }

    // The frame element matters only while the pointer is over it, and then it is exactly the
    // element this document's tracker reports, so no DOM search is ever needed.
    element() {
      const own = this.mux.own && this.mux.own.frame;
      try { return own && own.contentWindow === this.source ? own : null; } catch { return null; }
    }

    // Child viewport -> this viewport, child clock -> this clock, clamped to the frame's box.
    // Non-finite values and timestamps outside the last second are dropped.
    convert(buf) {
      const el = this.element();
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const sx = el.offsetWidth ? r.width / el.offsetWidth : 1;
      const sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
      const ox = r.left + (el.clientLeft + (parseFloat(cs.paddingLeft) || 0)) * sx;
      const oy = r.top + (el.clientTop + (parseFloat(cs.paddingTop) || 0)) * sy;
      const t0 = performance.timeOrigin, now = performance.now();
      const out = [];
      for (let i = 0; i + 2 < buf.length; i += 3) {
        const t = buf[i] - t0, x = buf[i + 1], y = buf[i + 2];
        if (!finite(t) || !finite(x) || !finite(y) || t > now + 1 || t < now - 1000) continue;
        out.push(t, Math.min(Math.max(ox + x * sx, r.left), r.right), Math.min(Math.max(oy + y * sy, r.top), r.bottom));
      }
      return out.length ? Float64Array.from(out) : null;
    }

    onMessage(d) {
      if (!d || typeof d !== 'object') return;
      switch (d.t) {
        case 's': {
          if (!(d.b instanceof Float64Array) || d.b.length < 3 || d.b.length % 3 || d.b.length > 3000) return;
          const buf = this.convert(d.b);
          if (buf) this.mux.childSamples(this, buf);
          break;
        }
        case 'p': this.mux.childPress(this, !!d.on); break;
        case 'st': this.mux.childState(this, sanitizeState(d.st)); break;
        case 'l': this.mux.childLeave(this); break;
        case 'r':
          this.ready = !!d.on;
          if (this.mux.own && this.mux.own.frame) this.mux.emit();
          break;
      }
    }

    setLive(on) {
      // An orphaned instance (extension reloaded) can no longer draw, so it never says yes.
      this.live = on && !!(chrome.runtime && chrome.runtime.id);
      if (!this.live) this.ready = false;
      try { this.port.postMessage({ t: 'on', on: this.live }); } catch { /* frame gone */ }
    }

    close() {
      this.port.onmessage = null;
      try { this.port.close(); } catch { /* already closed */ }
    }
  }

  function sanitizeState(st) {
    if (!st || typeof st !== 'object') return null;
    const c = st.cursor && typeof st.cursor === 'object' ? st.cursor : null;
    return {
      inside: !!st.inside,
      os: typeof st.os === 'string' ? st.os : null,
      keep: !!st.keep,
      cursor: c ? {
        kind: SC.cursorKind(c.kind) === 'auto' ? 'default' : SC.cursorKind(c.kind),
        url: typeof c.url === 'string' && /^(https?:|data:image\/)/i.test(c.url) ? c.url : undefined,
        hx: finite(c.hx) ? c.hx : null,
        hy: finite(c.hy) ? c.hy : null,
      } : null,
    };
  }

  // Child-side end: the parent's port, used as the Mux output in non-top frames.
  class Upstream {
    constructor(port) { this.port = port; }
    post(m, transfer) { try { this.port.postMessage(m, transfer); } catch { /* parent gone */ } }
    samples(buf) {
      const t0 = performance.timeOrigin;
      const out = new Float64Array(buf);
      for (let i = 0; i < out.length; i += 3) out[i] += t0;
      this.post({ t: 's', b: out }, [out.buffer]);
    }
    press(on) { this.post({ t: 'p', on }); }
    state(st) {
      // Element references cannot cross frames; the parent only needs the resolved look.
      this.post({ t: 'st', st: { inside: st.inside, os: st.os || null, keep: !!st.keep, cursor: st.cursor || null } });
    }
    leave() { this.post({ t: 'l' }); }
    ready(on) { this.post({ t: 'r', on }); }
  }

  // Accepts handshakes from direct child frames. Registered at document_start, before any
  // page listener, so the handshake message is stopped before page scripts see it.
  // `token` resolves to a secret the service worker hands only to this extension's content
  // scripts in this tab; a page inside an iframe cannot forge a hello without it.
  function listenForChildren(token, onBridge) {
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || typeof d !== 'object' || d[TAG] !== 1 || d.t !== 'hello') return;
      e.stopImmediatePropagation();
      const port = e.ports && e.ports[0];
      if (!port || !e.source || e.source === window) return;
      let isChild = false;
      for (let i = 0; i < window.frames.length; i++) if (window.frames[i] === e.source) { isChild = true; break; }
      if (!isChild) return;
      const source = e.source;
      token.then((t) => {
        if (t && d.k === t) onBridge(source, port);
        else port.close();
      });
    }, true);
  }

  // Child frame: offer a port to the parent. onActive fires when the parent's extension
  // instance answers, and again whenever it starts or stops drawing.
  function connectUpstream(token, onActive) {
    token.then((t) => {
      if (!t) return;
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => {
        const d = e.data;
        if (d && d.t === 'on') onActive(!!d.on, ch.port1);
      };
      try { window.parent.postMessage({ [TAG]: 1, t: 'hello', k: t }, '*', [ch.port2]); } catch { /* detached */ }
    });
  }

  SC.Mux = Mux;
  SC.ChildBridge = ChildBridge;
  SC.Upstream = Upstream;
  SC.listenForChildren = listenForChildren;
  SC.connectUpstream = connectUpstream;
})(self.SmoothCursor);
