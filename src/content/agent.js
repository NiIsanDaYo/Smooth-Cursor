'use strict';
// Per-document plumbing: our host element, the user-origin hide stylesheet, and probing the
// cursor the page asks for while the OS cursor stays hidden.
(function (SC) {
  const HOST_STYLE = [
    'all:initial', 'display:block', 'position:fixed', 'left:0', 'top:0', 'right:auto', 'bottom:auto',
    'width:0', 'height:0', 'margin:0', 'padding:0', 'border:0', 'overflow:visible', 'background:none',
    'pointer-events:none', 'z-index:2147483647', 'contain:style', 'transform:none', 'filter:none', 'opacity:1',
  ].map((d) => d + '!important').join(';');

  class Agent {
    constructor() {
      this.host = null;
      this.box = null;          // probe checkbox (light DOM child of the host)
      this.layer = null;        // container for the renderer canvas (inside the shadow root)
      this.cssOn = false;
      this.native = null;       // native scrollbar thickness, CSS px { regular, thin }
      this.probeCost = 0.5;     // EMA of probe duration (ms)
      this.dead = false;
    }

    // Host must be a direct child of <html>: the hide stylesheet keys off
    // `:root:has(> smooth-cursor-host > input:checked)`.
    mount() {
      if (this.host) { this.ensureMounted(); return; }
      const host = document.createElement(SC.HOST_TAG);
      host.setAttribute('style', HOST_STYLE);
      host.setAttribute('aria-hidden', 'true');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.tabIndex = -1;
      host.appendChild(box);    // unslotted: never rendered, never focusable
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML =
        '<style>:host{all:initial!important}' +
        '.m{position:absolute;left:-200px;top:0;width:100px;height:100px;overflow:scroll;visibility:hidden}' +
        '.thin{scrollbar-width:thin}.layer{position:fixed;left:0;top:0;width:0;height:0;overflow:visible}</style>' +
        '<div class="m"></div><div class="m thin"></div><div class="layer"></div>';
      this.host = host;
      this.box = box;
      this.shadow = shadow;
      this.layer = shadow.querySelector('.layer');
      this.ensureMounted();
    }

    ensureMounted() {
      const de = document.documentElement;
      if (!de || !this.host) return false;
      if (this.host.parentNode !== de) {
        de.appendChild(this.host);
        this.native = null;
        if (this.onRemount) this.onRemount();
      }
      return true;
    }

    unmount() {
      if (this.host) this.host.remove();
      this.host = null;
    }

    // Hiding starts lazily on the first pointer sample, when the cursor position is known;
    // hiding earlier would leave a still mouse with no cursor at all.
    ensureCss() {
      if (this.cssOn || this.cssPending || this.dead || this.suspended || performance.now() < (this.cssRetryAt || 0)) return;
      this.cssPending = true;
      this.setCss(true).then((ok) => {
        this.cssPending = false;
        if (!ok) this.cssRetryAt = performance.now() + 3000;
        if (this.onCss) this.onCss(ok);
      });
    }

    // Calls are chained so the last request wins: a stop() that lands while an insert is still
    // in flight removes the stylesheet afterwards instead of leaving the cursor hidden.
    setCss(on) {
      this.wantCss = on;
      this.cssChain = (this.cssChain || Promise.resolve()).then(() => this.applyCss(this.wantCss));
      return this.cssChain.then(() => this.cssOn === on);
    }

    async applyCss(on) {
      if (on === this.cssOn) return true;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'css', on });
        if (r && r.ok) { this.cssOn = on; return true; }
      } catch (e) { /* service worker unavailable or extension reloaded */ }
      // The reply can be lost after the stylesheet went in (worker shut down mid-call); trust
      // the page instead, since only our stylesheet names this container.
      const applied = getComputedStyle(document.documentElement).containerName === 'smooth-cursor-root';
      if (applied === on) { this.cssOn = on; return true; }
      return false;
    }

    // Reads the computed cursor of a hovered element with the hide rule lifted for the
    // hovered chain only. Synchronous, so the OS never sees the lifted state.
    probe(el) {
      const box = this.box;
      if (!box || this.host.parentNode !== document.documentElement) return null;
      const t0 = performance.now();
      box.checked = true;
      let v;
      try { v = getComputedStyle(el).cursor; } finally { box.checked = false; }
      this.probeCost += 0.2 * (performance.now() - t0 - this.probeCost);
      return v;
    }

    // Drawing is impossible on this page (no WebGL2): keep the real cursor for good.
    suspend() {
      this.suspended = true;
      this.setCss(false);
    }

    // Fail-safe when the extension is reloaded or removed under a running page: leave the
    // hovered chain unhidden so the OS cursor shows even if Chrome keeps our stylesheet.
    failOpen() {
      this.dead = true;
      if (this.box) this.box.checked = true;
      if (this.layer) this.layer.textContent = '';
    }

    nativeScrollbar() {
      if (this.native) return this.native;
      const ms = this.shadow ? this.shadow.querySelectorAll('.m') : [];
      if (ms.length < 2) return { regular: 15, thin: 11 };
      this.native = { regular: ms[0].offsetWidth - ms[0].clientWidth, thin: ms[1].offsetWidth - ms[1].clientWidth };
      return this.native;
    }
    invalidateMetrics() { this.native = null; }
  }

  SC.Agent = Agent;
})(self.SmoothCursor);
