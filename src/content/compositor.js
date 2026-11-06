'use strict';
// Top frame only: turns the muxed pointer stream into frames on a top-layer canvas.
(function (SC) {
  const IMAGE_TIMEOUT = 4000;

  function curHotspot(dataUrl) {
    // .cur files carry their own hotspot: ICONDIR type 2, first entry bytes 10..13.
    try {
      const m = /^data:[^,]*;base64,(.*)$/i.exec(dataUrl);
      if (!m) return null;
      const b = atob(m[1].slice(0, 24));
      const u16 = (i) => b.charCodeAt(i) | (b.charCodeAt(i + 1) << 8);
      if (u16(0) !== 0 || u16(2) !== 2 || u16(4) < 1) return null;
      return [u16(10), u16(12)];
    } catch { return null; }
  }

  class Compositor {
    constructor(agent, settings) {
      this.agent = agent;
      this.engine = new SC.Engine();
      this.renderer = null;
      this.fatal = false;
      this.cur = null;
      this.look = { kind: 'default' };
      this.zoom = 1;
      this.images = new Map();
      this.raf = 0;
      this.dead = false;
      this._frame = (t) => this.frame(t);
      this._raise = () => this.raise();
      this.setSettings(settings);
      this.onToggle = (e) => { if (e.target !== agent.host) this.queueRaise(); };
      document.addEventListener('toggle', this.onToggle, true);
      document.addEventListener('fullscreenchange', this._raise, true);
      // A still pointer sends nothing while the page scrolls; redraw so the offset correction
      // below runs even when the layer itself is carried by the scroll.
      this._scroll = () => { this.layerOffDirty = true; this.request(); };
      document.addEventListener('scroll', this._scroll, { capture: true, passive: true });
      this._vis = () => this.onVisibility();
      document.addEventListener('visibilitychange', this._vis);
      this._resize = () => { this.layerOffDirty = true; this.request(); };
      window.addEventListener('resize', this._resize);
      // Modal dialogs opened with showModal() enter the top layer above us.
      this.dialogs = new MutationObserver(() => this.queueRaise());
      this.dialogs.observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
      agent.onRemount = () => { this.popover = false; this.layerOffDirty = true; this.request(); };
      chrome.runtime.sendMessage({ type: 'zoom' }).then((z) => { if (z > 0) this.setZoom(z); }, () => {});
    }

    setSettings(s) {
      this.size = Math.min(Math.max(+s.size || 1, 0.5), 4);
      this.engine.setSettings(s);
      this.request();
    }

    setZoom(z) { this.zoom = z; this.request(); }

    // ----- Mux output -----
    samples(buf) {
      for (let i = 0; i + 2 < buf.length; i += 3) this.engine.add(buf[i], buf[i + 1], buf[i + 2]);
      this.request();
    }
    press(on) { this.engine.setPressed(on); this.request(); }
    state(st) {
      this.cur = st;
      // Entering a different top-layer element: it may have opened after our overlay (a
      // popover or modal inside a shadow root fires no event we can hear), so re-stack.
      const layer = st ? st.layer || null : null;
      if (layer !== this.lastLayer) { this.lastLayer = layer; if (layer) this.queueRaise(); }
      if (st && st.cursor) this.look = st.cursor;
      this.request();
    }
    leave() { this.cur = null; this.request(); }
    orphaned() { this.destroy(); this.agent.failOpen(); }

    request() {
      if (!this.raf && !this.dead) this.raf = requestAnimationFrame(this._frame);
    }

    queueRaise() {
      if (this.raiseQueued) return;
      this.raiseQueued = true;
      queueMicrotask(() => { this.raiseQueued = false; this.raise(); });
    }

    // Our overlay must stay above dialogs, popovers and fullscreen elements, which all live in
    // the top layer; re-showing a popover moves it to the top of that stack.
    raise() {
      const host = this.agent.host;
      if (!host || !host.isConnected || !this.popover) return;
      try {
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      } catch { /* not supported: z-index fallback stays */ }
    }

    // WebGL contexts get lost: GPU resets, and Chrome drops the oldest context once a process
    // holds 16. A lost context is replaced by a fresh canvas; after 3 losses in 10 s, or with
    // no WebGL2 at all, the page gets its real cursor back instead of no cursor.
    ensureRenderer() {
      const r = this.renderer;
      if (r && r.ok) return true;
      if (this.fatal) return false;
      if (r) {
        r.destroy();
        this.renderer = null;
        const now = performance.now();
        this.losses = (this.losses || []).filter((t) => now - t < 10000);
        this.losses.push(now);
        if (this.losses.length >= 3) { this.giveUp(); return false; }
      }
      this.renderer = new SC.Renderer(this.agent.layer, { onFatal: () => this.giveUp(), onLost: () => this.request() });
      return this.renderer.ok;
    }

    giveUp() {
      this.fatal = true;
      this.agent.suspend();
    }

    // Hidden tabs hand their WebGL context back, so only visible tabs count toward Chrome's
    // per-process limit; the next visible frame builds a new one.
    onVisibility() {
      if (document.hidden && this.renderer) {
        this.renderer.destroy();
        this.renderer = null;
      }
    }

    sprite(look, scale, T) {
      if (look.url) {
        const img = this.image(look.url);
        if (img && img.status === 'ok') {
          const hot = look.hx != null ? [look.hx, look.hy] : (img.hot || [0, 0]);
          const key = 'img:' + look.url + ':' + hot.join(',');
          const devScale = devicePixelRatio / this.zoom;
          if (!img.sprite || img.sprite.key !== key + '@' + devScale) img.sprite = SC.imageSprite(key, img.el, hot[0], hot[1], devScale);
          if (img.sprite) return img.sprite;
        }
      }
      const kind = look.kind === 'auto' ? 'default' : look.kind;
      return SC.getSprite(kind, scale, T);
    }

    image(url) {
      let e = this.images.get(url);
      if (e) return e;
      e = { status: 'loading', el: null, hot: null, sprite: null };
      this.images.set(url, e);
      if (this.images.size > 32) this.images.delete(this.images.keys().next().value);
      const load = (src) => new Promise((res, rej) => {
        const img = new Image();
        const timer = setTimeout(() => rej(new Error('timeout')), IMAGE_TIMEOUT);
        img.onload = () => { clearTimeout(timer); res(img); };
        img.onerror = () => { clearTimeout(timer); rej(new Error('load')); };
        img.src = src;
      });
      // Remote images go through the service worker so the canvas is not tainted by CORS.
      const src = /^data:/i.test(url) ? Promise.resolve(url) : chrome.runtime.sendMessage({ type: 'image', url }).then((r) => {
        if (!r || !r.dataUrl) throw new Error('fetch');
        return r.dataUrl;
      });
      src.then(async (dataUrl) => {
        e.hot = curHotspot(dataUrl);
        e.el = await load(dataUrl);
        e.status = 'ok';
        this.request();
      }).catch(() => { e.status = 'fail'; this.request(); });
      return e;
    }

    frame(T) {
      this.raf = 0;
      if (this.dead) return;
      const agent = this.agent;
      const st = this.cur;
      const pinch = window.visualViewport ? visualViewport.scale : 1;
      const dpr = devicePixelRatio * pinch;
      const settled = this.engine.compute(T, dpr);
      const look = st && st.cursor ? st.cursor : this.look;
      let visible = !!(st && st.inside && !st.os && agent.cssOn && !agent.dead) && look.kind !== 'none' && this.engine.count > 0;
      let animated = false;
      if (visible && !this.ensureRenderer()) visible = false;
      if (visible) {
        agent.ensureMounted();
        if (!this.popover && agent.host) {
          try { agent.host.popover = 'manual'; agent.host.showPopover(); this.popover = true; } catch { /* old Chrome */ }
        }
        const sprite = this.sprite(look, (devicePixelRatio / this.zoom) * this.size, T);
        animated = !!sprite.dynamic;
        this.renderer.setSprite(sprite);
        const cssZoom = (agent.host && agent.host.currentCSSZoom) || 1;
        // The layer is position: fixed, so it normally sits at the viewport origin. Pages can
        // still move it: Google search computes our top-layer host as position: absolute, and a
        // transform or filter on <html> makes fixed boxes scroll with the page. Measuring the
        // layer and subtracting its offset keeps the cursor on the pointer anyway. It is
        // re-measured after scroll or resize and every 30 frames, not every frame, so a moving
        // mouse never forces layout on the page.
        if (!this.layerOff || this.layerOffDirty || ++this.layerOffAge > 30) {
          const lr = agent.layer.getBoundingClientRect();
          this.layerOff = [lr.left, lr.top];
          this.layerOffDirty = false;
          this.layerOffAge = 0;
        }
        this.renderer.draw(this.engine.positions, this.engine.count, dpr * cssZoom, this.layerOff[0] * dpr, this.layerOff[1] * dpr);
      } else if (this.renderer) {
        this.renderer.hide();
      }
      if (!settled || animated) this.request();
    }

    destroy() {
      this.dead = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      document.removeEventListener('toggle', this.onToggle, true);
      document.removeEventListener('fullscreenchange', this._raise, true);
      document.removeEventListener('scroll', this._scroll, { capture: true, passive: true });
      document.removeEventListener('visibilitychange', this._vis);
      window.removeEventListener('resize', this._resize);
      this.dialogs.disconnect();
      if (this.renderer) this.renderer.destroy();
      this.renderer = null;
      const host = this.agent.host;
      if (host && this.popover) { try { host.hidePopover(); } catch { /* ignore */ } }
      this.popover = false;
    }
  }

  SC.Compositor = Compositor;
})(self.SmoothCursor);
