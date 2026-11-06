'use strict';
// Bootstrap for every frame: settings, activation, and wiring between modules.
(function (SC) {
  if (SC.booted) return;
  SC.booted = true;

  const isTop = window === window.top;
  const NULL_SINK = { samples() {}, press() {}, state() {}, leave() {} };
  let settings = { ...SC.DEFAULTS };
  let loaded = false;
  let parentOn = false;     // child frames: the parent chain is active and drawing
  let upPort = null;
  let want = false;
  let running = false;
  let starting = null;
  const agent = new SC.Agent();
  const mux = new SC.Mux(NULL_SINK);
  let tracker = null;
  let compositor = null;
  // Isolated-world handle for debugging from DevTools (not reachable by page scripts).
  SC.debug = { agent, mux, get tracker() { return tracker; }, get compositor() { return compositor; }, get running() { return running; } };

  // Per-tab secret for the frame handshake, shared only by this extension's scripts.
  const token = chrome.runtime.sendMessage({ type: 'token' }).then((t) => (typeof t === 'string' ? t : null), () => null);

  // Child frames can say hello before settings load; answer once we know.
  SC.listenForChildren(token, (source, port) => {
    for (const b of mux.bridges) {
      // A frame that reloaded replaces its old bridge; removed frames report closed.
      if (b.source === source || b.source.closed) { b.close(); mux.bridges.delete(b); }
    }
    const b = new SC.ChildBridge(mux, source, port);
    mux.bridges.add(b);
    if (loaded) b.setLive(running);
  });

  if (!isTop) {
    SC.connectUpstream(token, (on, port) => {
      upPort = port;
      parentOn = on;
      evaluate();
    });
  }

  chrome.storage.local.get(SC.DEFAULTS).then((s) => {
    settings = s;
    loaded = true;
    evaluate();
  }, () => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k in changes) settings[k] = changes[k].newValue ?? SC.DEFAULTS[k];
    evaluate();
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'zoom' && compositor) compositor.setZoom(msg.factor);
    if (msg.type === 'ping' && isTop) sendResponse({ alive: true, running });
  });

  function evaluate() {
    if (!loaded) return;
    const site = SC.siteKey(location.href);
    const siteOff = isTop && site && (settings.disabledSites || []).includes(site);
    want = !!settings.enabled && !siteOff && (isTop || parentOn);
    if (want && !running && !starting) {
      starting = start().catch(() => {}).finally(() => { starting = null; if (!want && running) stop(); });
    }
    else if (!want && running) stop();
    if (running && compositor) compositor.setSettings(settings);
  }

  // Our host element goes into <html>. Waiting for the page to finish loading keeps it out of
  // the DOM while frameworks hydrate server-rendered markup (React 18 rebuilds a whole root on
  // an unexpected node).
  function pageSettled() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((res) => {
      let t = 0;
      const done = () => { clearTimeout(t); res(); };
      window.addEventListener('load', done, { once: true });
      const afterDcl = () => { t = setTimeout(done, 2000); };
      if (document.readyState === 'interactive') afterDcl();
      else document.addEventListener('DOMContentLoaded', afterDcl, { once: true });
    });
  }

  async function start() {
    await pageSettled();
    // XML and SVG documents cannot host our element (attachShadow needs HTML), so they keep
    // the real cursor; a parent sees no 'ready' from them and steps aside too.
    if (!want || !(document.documentElement instanceof HTMLElement)) return;
    agent.mount();
    agent.onCss = () => tracker && tracker.queueTick();
    if (isTop) {
      compositor = new SC.Compositor(agent, settings);
      mux.out = compositor;
    } else {
      mux.out = new SC.Upstream(upPort);
    }
    tracker = new SC.Tracker(agent, mux);
    tracker.attach();
    running = true;
    if (mux.out.ready) mux.out.ready(true);
    for (const b of mux.bridges) b.setLive(true);
  }

  function stop() {
    running = false;
    for (const b of mux.bridges) b.setLive(false);
    if (tracker) tracker.detach();
    tracker = null;
    if (compositor) compositor.destroy();
    compositor = null;
    if (mux.out && mux.out.leave) mux.out.leave();
    if (mux.out && mux.out.ready) mux.out.ready(false);
    mux.out = NULL_SINK;
    mux.own = null;
    agent.setCss(false).then(() => { if (!running) agent.unmount(); });
  }
})(self.SmoothCursor);
