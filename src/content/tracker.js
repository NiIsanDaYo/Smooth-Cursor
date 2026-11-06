'use strict';
// Per-document pointer tracking: raw samples at the device rate, the cursor the page wants,
// and the places where the browser or OS draws its own cursor no matter what CSS says.
(function (SC) {
  // Elements whose inside is another document or a plugin with its own cursor. <object>
  // counts only when it holds a document (an image <object> is just an image here).
  const isFrame = (el) => {
    const n = el.localName;
    if (n === 'iframe' || n === 'frame' || n === 'embed') return true;
    if (n !== 'object') return false;
    try { return !!el.contentWindow; } catch { return true; }
  };
  const TOP_LAYER = ':popover-open, :modal, :fullscreen';
  const TEXT_INPUTS = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
  const PICKER_INPUTS = new Set(['color', 'date', 'datetime-local', 'month', 'week', 'time', 'file']);
  const HIDE_REASONS_UNTIL_MOVE = new Set(['menu', 'select', 'picker', 'drag']);

  const parentOrHost = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  // "url(\"a.cur\") 4 12, url(b.png), pointer" -> { urls: [{url, hx, hy}], keyword }
  function parseCursor(value) {
    const out = { urls: [], keyword: 'auto' };
    if (!value) return out;
    const parts = [];
    let depth = 0, quote = '', cur = '';
    for (const ch of value) {
      if (quote) { if (ch === quote) quote = ''; cur += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    for (const p of parts) {
      const m = /^url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)\s*(?:(-?[\d.]+)\s+(-?[\d.]+))?$/i.exec(p);
      if (m) {
        const url = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
        out.urls.push({ url, hx: m[4] != null ? +m[4] : null, hy: m[5] != null ? +m[5] : null });
      } else if (!/^image-set\(/i.test(p)) {
        out.keyword = p.toLowerCase();
      }
    }
    return out;
  }

  class Tracker {
    // sink: { samples(Float64Array [t,x,y]...), press(bool), state(obj), leave() }
    constructor(agent, sink) {
      this.agent = agent;
      this.sink = sink;
      this.x = 0; this.y = 0;
      this.inside = false;
      this.buttons = 0;
      this.target = null;
      this.override = null;       // reason the browser draws its own cursor
      this.overrideAt = 0;
      this.autoscroll = null;
      this.touch = false;
      this.selecting = false;
      this.raw = null;            // parsed page cursor for the current target
      this.probeDirty = true;
      this.lastProbe = -1e9;
      this.textCheckAt = -1e9;
      this.autoText = false;
      this.targetInfo = null;
      this.last = null;
      this.tickQueued = false;
      this.mo = new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.target === this.agent.host || r.target === this.agent.box) continue;
          this.probeDirty = true;
          this.targetInfo = null;
          this.queueTick();
          return;
        }
      });
      this.handlers = [];
      this._tick = (now) => this.tick(now);
    }

    on(type, fn, target = window, opts = { capture: true, passive: true }) {
      target.addEventListener(type, fn, opts);
      this.handlers.push([target, type, fn, opts]);
    }

    attach() {
      this.on('pointermove', (e) => this.onMove(e));
      this.on('pointerdown', (e) => this.onDown(e));
      this.on('pointerup', (e) => this.onUp(e));
      // pointerover alone marks the pointer as inside: entering the window straight onto an
      // iframe sends this document no pointermove at all.
      this.on('pointerover', (e) => {
        if (e.pointerType !== 'mouse' || !e.isTrusted) return;
        this.inside = true;
        this.x = e.clientX; this.y = e.clientY;
        this.setTarget(this.deepTarget(e));
      });
      this.on('pointerout', (e) => { if (e.pointerType === 'mouse' && e.isTrusted && !e.relatedTarget) this.onLeave(); });
      // Pointer lock hides the OS cursor and freezes clientX/Y; ours must hide with it.
      this.on('pointerlockchange', () => { if (document.pointerLockElement) this.setOverride('lock'); else this.clearOverride('lock'); }, document);
      this.on('contextmenu', (e) => {
        // Decide after every page listener ran: only an unprevented event opens the native menu.
        setTimeout(() => { if (!e.defaultPrevented) this.setOverride('menu'); }, 0);
      });
      this.on('mousedown', (e) => this.onMouseDown(e));
      this.on('mouseup', (e) => this.onMouseUp(e));
      this.on('click', (e) => {
        const t = e.target;
        if (t && t.localName === 'input' && PICKER_INPUTS.has(t.type) && !t.disabled) {
          setTimeout(() => { if (!e.defaultPrevented) this.setOverride('picker'); }, 0);
        }
      });
      this.on('dragstart', () => this.setOverride('drag'));
      this.on('dragenter', () => this.setOverride('drag'));
      this.on('dragend', () => this.clearOverride('drag'));
      this.on('drop', () => this.clearOverride('drag'));
      this.on('keydown', () => { if (this.autoscroll) this.endAutoscroll(); });
      this.on('wheel', () => { if (this.autoscroll) this.endAutoscroll(); });
      this.on('scroll', () => this.onScroll());
      // Resize also fires on page zoom, which changes the native scrollbar width in CSS px.
      this.on('resize', () => { this.zones = null; this.agent.invalidateMetrics(); }, window, { capture: false, passive: true });
      this.on('blur', () => { this.buttons = 0; this.sink.press(false); }, window, { capture: false, passive: true });
      this.idle = setInterval(() => {
        // Catches cursor changes no event announces (stylesheet swaps, timers).
        if (this.inside) { this.probeDirty = true; this.queueTick(); }
        // Extension reloaded or removed under this page: stop, and leave the real cursor on.
        if (!chrome.runtime || !chrome.runtime.id) {
          this.detach();
          this.agent.failOpen();
          if (this.sink.orphaned) this.sink.orphaned();
        }
      }, 1000);
    }

    detach() {
      this.detached = true;
      for (const [t, type, fn, opts] of this.handlers) t.removeEventListener(type, fn, opts);
      this.handlers = [];
      clearInterval(this.idle);
      clearTimeout(this.scrollTimer);
      this.mo.disconnect();
    }

    queueTick() {
      if (this.tickQueued || this.detached) return;
      this.tickQueued = true;
      requestAnimationFrame(this._tick);
    }

    deepTarget(e) {
      let el = e.composedPath ? e.composedPath()[0] : e.target;
      if (!(el instanceof Element)) el = e.target instanceof Element ? e.target : null;
      return this.descend(el, e.clientX, e.clientY);
    }

    // composedPath() stops at closed shadow roots; content scripts may look inside them.
    descend(el, x, y) {
      for (let i = 0; el && i < 16; i++) {
        if (el.shadowRoot) break;
        let root = null;
        try { root = chrome.dom.openOrClosedShadowRoot(el); } catch { /* not a host */ }
        if (!root) break;
        const inner = root.elementFromPoint(x, y);
        if (!inner || inner === el || !root.contains(inner)) break;
        el = inner;
      }
      return el;
    }

    setTarget(el) {
      if (!el || el === this.target) return;
      if (el === this.agent.host || (this.agent.host && this.agent.host.contains(el))) return;
      this.target = el;
      this.targetInfo = null;
      this.layerEl = null;
      try { for (let n = el; n; n = parentOrHost(n)) if (n.matches(TOP_LAYER)) { this.layerEl = n; break; } } catch { /* old selector support */ }
      this.probeDirty = true;
      this.mo.disconnect();
      for (let n = el, i = 0; n && i < 40; n = parentOrHost(n), i++) this.mo.observe(n, { attributes: true });
      this.queueTick();
    }

    onMove(e) {
      // Synthetic events from page scripts would let a page steer the cursor we draw.
      if (!e.isTrusted) return;
      if (e.pointerType !== 'mouse') {
        if (!this.touch) { this.touch = true; this.queueTick(); }
        return;
      }
      this.touch = false;
      const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const n = list.length || 1;
      const buf = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const s = list.length ? list[i] : e;
        buf[3 * i] = s.timeStamp; buf[3 * i + 1] = s.clientX; buf[3 * i + 2] = s.clientY;
      }
      this.x = e.clientX; this.y = e.clientY;
      this.inside = true;
      if (this.override && HIDE_REASONS_UNTIL_MOVE.has(this.override) && e.timeStamp - this.overrideAt > 120) this.override = null;
      // Real autoscroll scrolls as soon as the pointer leaves the anchor. If the page has not
      // scrolled 300 ms after that, Chrome never started it, and hiding both cursors would
      // leave none on screen.
      const as = this.autoscroll;
      if (as && Math.hypot(e.clientX - as.x, e.clientY - as.y) > 20) {
        if (!as.movedAt) as.movedAt = e.timeStamp;
        else if (e.timeStamp - as.movedAt > 300 && !(as.scrolledAt > as.movedAt)) this.endAutoscroll();
      }
      if (this.buttons !== e.buttons) this.applyButtons(e.buttons);
      this.setTarget(this.deepTarget(e));
      this.sink.samples(buf);
      this.queueTick();
    }

    applyButtons(b) {
      const was = this.buttons !== 0;
      this.buttons = b;
      if (was !== (b !== 0)) this.sink.press(b !== 0);
      if (!b) this.selecting = false;
    }

    onDown(e) {
      if (e.pointerType !== 'mouse' || !e.isTrusted) return;
      this.x = e.clientX; this.y = e.clientY;
      if (this.autoscroll && e.timeStamp - this.autoscroll.t > 50) this.endAutoscroll();
      // Chrome keeps the I-beam for the whole drag once a press starts a text selection.
      if (e.button === 0 && this.last && this.last.cursor && this.last.cursor.kind === 'text' && this.autoText) this.selecting = true;
      const t = this.deepTarget(e);
      const sel = t && t.closest && t.closest('select');
      if (sel && !sel.multiple && !(sel.size > 1) && !sel.disabled && e.button === 0) this.setOverride('select');
      this.applyButtons(e.buttons);
      this.probeDirty = true;
      this.queueTick();
    }

    onUp(e) {
      if (e.pointerType !== 'mouse' || !e.isTrusted) return;
      this.applyButtons(e.buttons);
      this.probeDirty = true;
      this.queueTick();
    }

    onMouseDown(e) {
      if (e.button !== 1) return;
      setTimeout(() => {
        if (e.defaultPrevented) return;
        const p = e.composedPath ? e.composedPath() : [];
        const t = p[0] instanceof Element ? p[0] : (e.target instanceof Element ? e.target : null);
        // composedPath reaches links inside open shadow roots, which e.target hides.
        if (p.some((n) => n instanceof Element && n.localName === 'a' && n.hasAttribute('href'))) return;
        if (!this.canScroll(t)) return;
        this.autoscroll = { t: e.timeStamp, x: e.clientX, y: e.clientY };
        this.setOverride('autoscroll');
      }, 0);
    }

    onMouseUp(e) {
      // Holding the middle button and dragging ends autoscroll on release; a click toggles it on.
      if (e.button === 1 && this.autoscroll && Math.hypot(e.clientX - this.autoscroll.x, e.clientY - this.autoscroll.y) > 12) this.endAutoscroll();
    }

    endAutoscroll() {
      this.autoscroll = null;
      this.clearOverride('autoscroll');
    }

    canScroll(el) {
      const se = document.scrollingElement;
      if (se && (se.scrollHeight > se.clientHeight + 1 || se.scrollWidth > se.clientWidth + 1)) return true;
      for (let n = el; n && n !== document.documentElement; n = parentOrHost(n)) {
        const cs = getComputedStyle(n);
        if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1) return true;
        if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
      }
      return false;
    }

    setOverride(reason) {
      this.override = reason;
      this.overrideAt = performance.now();
      this.queueTick();
    }

    clearOverride(reason) {
      if (this.override === reason) { this.override = null; this.queueTick(); }
    }

    onLeave() {
      this.inside = false;
      this.selecting = false;
      this.last = null;
      this.sink.leave();
    }

    // The element under a still pointer changes while the page scrolls; Chrome refreshes
    // hover about 100 ms after scrolling stops, so re-hit-test after that.
    onScroll() {
      if (this.autoscroll) this.autoscroll.scrolledAt = performance.now();
      this.zones = null;
      if (!this.inside) return;
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => {
        const el = this.descend(document.elementFromPoint(this.x, this.y), this.x, this.y);
        if (el) this.setTarget(el);
        this.probeDirty = true;
        this.queueTick();
      }, 140);
    }

    // ---------- per-frame resolution ----------
    tick(now) {
      this.tickQueued = false;
      if (!this.inside || this.detached) return;
      this.agent.ensureMounted();
      // layer: the top-layer element (popover, modal, fullscreen) the pointer is in, so the
      // compositor can re-stack above ones it never saw open (e.g. inside shadow roots).
      const st = { inside: true, frame: null, os: null, cursor: null, layer: this.layerEl };
      const el = this.target;
      if (this.touch) st.os = 'touch';
      else if (this.override) st.os = this.override;
      else if (!this.agent.cssOn) { st.os = 'pending'; this.agent.ensureCss(); }
      if (el && isFrame(el)) {
        st.frame = el;
      } else if (el) {
        if (!st.os) st.os = this.scrollUiAt(el, this.x, this.y);
        st.cursor = this.resolveCursor(el, now);
      }
      this.emit(st);
    }

    emit(st) {
      const a = this.last;
      const same = a && a.inside === st.inside && a.frame === st.frame && a.os === st.os && a.layer === st.layer &&
        ((!a.cursor && !st.cursor) || (a.cursor && st.cursor && a.cursor.kind === st.cursor.kind &&
          a.cursor.url === st.cursor.url && a.cursor.hx === st.cursor.hx && a.cursor.hy === st.cursor.hy));
      this.last = st;
      if (!same) this.sink.state(st);
    }

    // Chrome takes the cursor from the deepest :hover element. The event target or
    // elementFromPoint can differ from it (YouTube inserts a video under a still pointer; hover
    // is refreshed late after scrolling), and a non-hovered element always reads `none` under
    // the hide stylesheet, which used to make the cursor vanish.
    hovered(from) {
      let n = from;
      while (n && !n.matches(':hover')) n = parentOrHost(n);
      if (!n) return null;
      for (let i = 0; i < 64; i++) {
        // Light children first: slotted content is deeper than the slot that shows it.
        let next = n.querySelector(':scope > :hover');
        if (!next) {
          let sr = n.shadowRoot;
          if (!sr) { try { sr = chrome.dom.openOrClosedShadowRoot(n); } catch { /* not a host */ } }
          if (sr) { const all = sr.querySelectorAll(':hover'); next = all.length ? all[all.length - 1] : null; }
        }
        if (!next || next === n) break;
        n = next;
      }
      return n;
    }

    resolveCursor(target, now) {
      const agent = this.agent;
      const el = this.hovered(target);
      if (!el) {
        // Hover catches up within a frame or two; the 1 s idle probe covers anything longer.
        this.noHover = this.noHover || now;
        if (now - this.noHover < 500) this.queueTick();
        return this.lastCursor || { kind: 'default' };
      }
      this.noHover = 0;
      if (el !== this.probeEl) { this.probeEl = el; this.probeDirty = true; }
      // Probes cost a style update of the hovered chain; keep them under ~3% of main-thread time.
      const minGap = Math.min(agent.probeCost * 30, 250);
      if (this.probeDirty && now - this.lastProbe >= minGap) {
        const v = el.isConnected ? agent.probe(el) : null;
        if (v != null) this.raw = parseCursor(v);
        this.probeDirty = false;
        this.lastProbe = now;
      } else if (this.probeDirty) {
        this.queueTick();
      }
      const raw = this.raw || { urls: [], keyword: 'auto' };
      let kind = SC.cursorKind(raw.keyword);
      this.autoText = false;
      if (kind === 'auto') {
        kind = this.autoKind(el, now);
        this.autoText = kind === 'text' || kind === 'vertical-text';
      }
      if (this.selecting) kind = 'text';
      const c = { kind };
      const u = raw.urls.find((x) => /^(https?:|data:image\/)/i.test(x.url));
      if (u && kind !== 'none') { c.url = u.url; c.hx = u.hx; c.hy = u.hy; }
      this.lastCursor = c;
      return c;
    }

    info(el) {
      if (this.targetInfo && this.targetInfo.el === el) return this.targetInfo;
      const cs = getComputedStyle(el);
      let selectable = true;
      for (let n = el, i = 0; n && i < 40; n = parentOrHost(n), i++) {
        const v = getComputedStyle(n).userSelect;
        if (v === 'none') { selectable = false; break; }
        if (v && v !== 'auto') break;
      }
      const tag = el.localName;
      const editable = el.isContentEditable ||
        (tag === 'textarea' && !el.disabled) ||
        (tag === 'input' && TEXT_INPUTS.has(el.type) && !el.disabled);
      this.targetInfo = {
        el, cs, editable, selectable,
        vertical: /^(vertical|sideways)/.test(cs.writingMode),
        hasText: [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim()),
      };
      return this.targetInfo;
    }

    // Chrome's rule for `cursor: auto`: I-beam over editable content, or over a text box that
    // can start a selection; the arrow everywhere else.
    autoKind(el, now) {
      const inf = this.info(el);
      const beam = inf.vertical ? 'vertical-text' : 'text';
      if (inf.editable) return beam;
      if (!inf.selectable || !inf.hasText) return 'default';
      if (now - this.textCheckAt > 12 || this.textCheckX !== this.x || this.textCheckY !== this.y) {
        this.textCheckAt = now;
        this.textCheckX = this.x; this.textCheckY = this.y;
        this.overTextCache = this.overText(el, this.x, this.y);
      }
      return this.overTextCache ? beam : 'default';
    }

    overText(el, x, y) {
      let node = null, off = 0;
      const root = el.getRootNode();
      try {
        if (document.caretPositionFromPoint) {
          const p = document.caretPositionFromPoint(x, y, root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined);
          if (p) { node = p.offsetNode; off = p.offset; }
        } else if (document.caretRangeFromPoint) {
          const r = document.caretRangeFromPoint(x, y);
          if (r) { node = r.startContainer; off = r.startOffset; }
        }
      } catch { return false; }
      if (!node || node.nodeType !== 3 || node.parentNode !== el) return false;
      const range = document.createRange();
      range.setStart(node, Math.max(0, off - 1));
      range.setEnd(node, Math.min(node.length, off + 1));
      for (const r of range.getClientRects()) {
        if (x >= r.left - 0.5 && x <= r.right + 0.5 && y >= r.top - 0.5 && y <= r.bottom + 0.5) return true;
      }
      return false;
    }

    // Chrome paints the arrow over non-custom scrollbars and the resize grip regardless of
    // CSS, so the fake cursor must step aside there. The regions are measured once per target
    // and again after scroll, resize, or 500 ms; the per-frame check is plain arithmetic, so
    // moving the mouse never forces a style or layout pass on the page.
    scrollUiAt(el, x, y) {
      const now = performance.now();
      const z = this.zones;
      if (!z || z.el !== el || now - z.at > 500) this.zones = { el, at: now, list: this.measureZones(el) };
      for (const r of this.zones.list) if (x >= r.l && x <= r.r && y >= r.t && y <= r.b) return r.kind;
      return null;
    }

    measureZones(el) {
      const list = [];
      const de = document.documentElement;
      const native = this.agent.nativeScrollbar();
      const isNative = (cs, g) => (cs.scrollbarWidth && cs.scrollbarWidth !== 'auto') ||
        (cs.scrollbarColor && cs.scrollbarColor !== 'auto') ||
        Math.abs(g - native.regular) < 0.75 || Math.abs(g - native.thin) < 0.75;
      // Viewport scrollbars
      const gv = innerWidth - de.clientWidth, gh = innerHeight - de.clientHeight;
      if (gv > 0.5 || gh > 0.5) {
        const rcs = getComputedStyle(de);
        const rtl = rcs.direction === 'rtl';
        if (gv > 0.5 && isNative(rcs, gv)) list.push(rtl ? { kind: 'scrollbar', l: -1, r: gv, t: -1, b: innerHeight + 1 } : { kind: 'scrollbar', l: de.clientWidth, r: innerWidth + 1, t: -1, b: innerHeight + 1 });
        if (gh > 0.5 && isNative(rcs, gh)) list.push({ kind: 'scrollbar', l: -1, r: innerWidth + 1, t: de.clientHeight, b: innerHeight + 1 });
      }
      // Element scrollbars and resizer (the scroller itself is the hit target there)
      if (el === de || el === document.body) return list;
      const cs = this.info(el).cs;
      const ox = cs.overflowX, oy = cs.overflowY;
      const resizable = cs.resize && cs.resize !== 'none';
      if (!resizable && !/(auto|scroll)/.test(ox + oy)) return list;
      const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
      const gx = el.offsetWidth - el.clientWidth - bl - br;
      const gy = el.offsetHeight - el.clientHeight - bt - bb;
      const r = el.getBoundingClientRect();
      const s = el.offsetWidth ? r.width / el.offsetWidth : 1;
      const rtl = cs.direction === 'rtl';
      const vBar = gx > 0.5 && (oy === 'scroll' || el.scrollHeight > el.clientHeight);
      const hBar = gy > 0.5 && (ox === 'scroll' || el.scrollWidth > el.clientWidth);
      const left = r.left + bl * s, right = r.right - br * s, top = r.top + bt * s, bottom = r.bottom - bb * s;
      if (resizable && !/visible/.test(ox + oy)) {
        const sz = Math.max(gx, gy, native.regular) * s;
        list.push({ kind: 'resizer', l: rtl ? left : right - sz, r: rtl ? left + sz : right, t: bottom - sz, b: bottom });
      }
      if (vBar && isNative(cs, gx)) list.push({ kind: 'scrollbar', l: rtl ? left : right - gx * s, r: rtl ? left + gx * s : right, t: top, b: bottom });
      if (hBar && isNative(cs, gy)) list.push({ kind: 'scrollbar', l: left, r: right, t: bottom - gy * s, b: bottom });
      return list;
    }
  }

  SC.Tracker = Tracker;
  SC.parseCursor = parseCursor;
})(self.SmoothCursor);
