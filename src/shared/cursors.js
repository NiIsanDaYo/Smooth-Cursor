'use strict';
// Vector cursor set, rasterized at the exact device pixel size it is shown at.
// Units: 1 unit = 1 device px at 100% scaling, matching the 32 px Windows default pointer.
// Convention: white body with a 1-unit black outline, line art (I-beam, crosshair) in black
// with a white halo, soft drop shadow like the Windows pointer shadow.
(function (SC) {
  const PAD = 4;   // room for the shadow around the design box

  // ---------- path helpers ----------
  const P = (d) => new Path2D(d);
  const rrect = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
  const circle = (cx, cy, r, ccw = false) => { const p = new Path2D(); p.arc(cx, cy, r, 0, Math.PI * 2, ccw); p.closePath(); return p; };
  const xform = (path, m) => { const p = new Path2D(); p.addPath(path, m); return p; };
  const rot = (deg, cx, cy) => new DOMMatrix().translate(cx, cy).rotate(deg).translate(-cx, -cy);
  const move = (dx, dy, s = 1) => new DOMMatrix().translate(dx, dy).scale(s);

  // Body: stroke every part 2 units wide in the outline color, then fill every part, so the
  // outline is 1 unit outside the geometry and internal seams between parts disappear.
  function body(ctx, parts, fill = '#fff', edge = '#000') {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
    ctx.strokeStyle = edge;
    for (const p of parts) ctx.stroke(p.path || p);
    ctx.fillStyle = fill;
    for (const p of parts) ctx.fill(p.path || p, p.rule || 'nonzero');
  }
  function ink(ctx, paths, width = 1, halo = 1, color = '#000') {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = width + 2 * halo;
    for (const p of paths) ctx.stroke(p);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const p of paths) ctx.stroke(p);
  }
  function lines(ctx, paths, width = 1, color = '#000') {
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    for (const p of paths) ctx.stroke(p);
  }

  // ---------- shapes ----------
  const ARROW = P('M1 1 L1 17.6 L4.9 13.9 L7.55 20.1 L9.75 19.15 L7.15 13.1 L12.6 13.1 Z');
  const arrow = (ctx) => body(ctx, [ARROW]);

  const HAND = [
    rrect(6, 1.5, 3.6, 12, 1.8),          // index finger
    rrect(9.6, 7.3, 3.2, 8, 1.6),         // middle knuckle
    rrect(12.8, 8.1, 3.0, 7.5, 1.5),      // ring knuckle
    rrect(15.8, 9.4, 2.6, 7, 1.3),        // little finger
    P('M6 11 L18.4 11 L18.4 16.6 Q18.4 19.2 16.5 21 L16.5 22.5 L8.3 22.5 L8.3 21.2 Q7 20 5.7 18 Z'),
    xform(rrect(1.8, 10.9, 7.6, 3.4, 1.7), rot(40, 1.8, 12.6)),  // thumb
  ];
  const HAND_CREASES = [P('M9.6 9.6 L9.6 12.2'), P('M12.8 10.3 L12.8 12.6'), P('M15.8 11.4 L15.8 13.4')];
  const hand = (ctx) => { body(ctx, HAND); lines(ctx, HAND_CREASES, 0.85); };

  const OPEN = [
    rrect(5.6, 3.6, 2.9, 10, 1.45),
    rrect(8.5, 1.6, 2.9, 11, 1.45),
    rrect(11.4, 2.4, 2.9, 10.5, 1.45),
    rrect(14.3, 4.6, 2.6, 9, 1.3),
    P('M5.6 10 L16.9 10 L16.9 15.6 Q16.9 18.6 14.8 20.4 L14.8 21.6 L7.4 21.6 L7.4 20.4 Q5.4 18.8 4.6 16.2 Z'),
    xform(rrect(0.9, 11.4, 6.8, 3.0, 1.5), rot(38, 0.9, 12.9)),
  ];
  const OPEN_CREASES = [P('M8.5 9.4 L8.5 12'), P('M11.4 9.4 L11.4 12'), P('M14.3 9.6 L14.3 12')];
  const openHand = (ctx) => { body(ctx, OPEN); lines(ctx, OPEN_CREASES, 0.85); };

  const FIST = [
    rrect(5.4, 6.2, 3.0, 5, 1.5),
    rrect(8.4, 5.4, 3.0, 5.6, 1.5),
    rrect(11.4, 5.8, 3.0, 5.2, 1.5),
    rrect(14.4, 7, 2.6, 4.6, 1.3),
    P('M4.4 9 L17 9 L17 14.4 Q17 17.6 14.9 19.4 L14.9 20.6 L7.4 20.6 L7.4 19.4 Q4.4 17.4 4.4 14 Z'),
  ];
  const FIST_CREASES = [P('M8.4 7.9 L8.4 10'), P('M11.4 7.9 L11.4 10'), P('M14.4 8.8 L14.4 10.4')];
  const THUMB = rrect(4.6, 11.4, 7.2, 3.1, 1.55);
  const fist = (ctx) => { body(ctx, FIST); lines(ctx, FIST_CREASES, 0.85); body(ctx, [THUMB]); };

  const IBEAM = [P('M1.5 1.5 Q4.5 1.5 4.5 3.6 Q4.5 1.5 7.5 1.5'), P('M4.5 3.6 L4.5 15.4'), P('M1.5 17.5 Q4.5 17.5 4.5 15.4 Q4.5 17.5 7.5 17.5')];
  const ibeam = (ctx) => ink(ctx, IBEAM);
  const vbeam = (ctx) => ink(ctx, IBEAM.map((p) => xform(p, new DOMMatrix([0, 1, -1, 0, 19, 0]))));

  const cross = (ctx) => ink(ctx, [P('M9.5 0.5 L9.5 18.5'), P('M0.5 9.5 L18.5 9.5')]);

  const MOVE = P('M11 1 L14.6 5.6 L12 5.6 L12 10 L16.4 10 L16.4 7.4 L21 11 L16.4 14.6 L16.4 12 L12 12 L12 16.4 L14.6 16.4 L11 21 L7.4 16.4 L10 16.4 L10 12 L5.6 12 L5.6 14.6 L1 11 L5.6 7.4 L5.6 10 L10 10 L10 5.6 L7.4 5.6 Z');
  const moveArrows = (ctx) => body(ctx, [MOVE]);

  const EW = P('M1 5 L6 1 L6 4 L18 4 L18 1 L23 5 L18 9 L18 6 L6 6 L6 9 Z');      // 24 x 10
  const resize = (deg) => {
    const m = new DOMMatrix().translate(11.5, 11.5).rotate(deg).translate(-12, -5);
    const p = xform(EW, m);
    return (ctx) => body(ctx, [p]);
  };
  const COL = [
    P('M1 9 L5.6 5 L5.6 8 L8.6 8 L8.6 10 L5.6 10 L5.6 13 Z'),
    P('M22 9 L17.4 5 L17.4 8 L14.4 8 L14.4 10 L17.4 10 L17.4 13 Z'),
    rrect(9.7, 1, 1.3, 16, 0.4),
    rrect(12, 1, 1.3, 16, 0.4),
  ];
  const colResize = (ctx) => body(ctx, COL);
  const rowResize = (ctx) => body(ctx, COL.map((p) => xform(p, new DOMMatrix([0, 1, -1, 0, 18, 0]))));

  const NO = [
    { path: (() => { const p = circle(10, 10, 8.2); p.addPath(circle(10, 10, 5.6, true)); return p; })(), rule: 'nonzero' },
    xform(rrect(10 - 6.4, 10 - 1.3, 12.8, 2.6, 0.3), rot(45, 10, 10)),
  ];
  const notAllowed = (ctx) => body(ctx, NO, '#000', '#fff');

  const SPIN_PERIOD = 900; // ms per revolution
  const spinner = (cx, cy, r, w) => (ctx, t) => {
    const a = ((t % SPIN_PERIOD) / SPIN_PERIOD) * Math.PI * 2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = w + 2; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = w; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, a, a + 2.1);
    ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = w; ctx.stroke();
  };
  const bigSpinner = spinner(10, 10, 7.4, 2.6);
  const smallSpinner = spinner(16.2, 17.2, 3.7, 1.7);

  const badge = (draw) => (ctx, t) => { arrow(ctx); draw(ctx, t); };
  const QUESTION = [P('M13.3 10.3 Q13.3 7.6 16.1 7.6 Q18.9 7.6 18.9 10.2 Q18.9 12 17 12.9 Q16.1 13.4 16.1 14.9')];
  const help = badge((ctx) => {
    ink(ctx, QUESTION, 1.9, 1.1);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(16.1, 18.2, 2.15, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(16.1, 18.2, 1.15, 0, Math.PI * 2); ctx.fill();
  });
  const contextMenu = badge((ctx) => {
    body(ctx, [rrect(12.6, 12.2, 8.4, 9.6, 1)]);
    lines(ctx, [P('M14.6 15 L19 15'), P('M14.6 17.5 L19 17.5'), P('M14.6 20 L17.6 20')], 1);
  });
  const copy = badge((ctx) => {
    body(ctx, [rrect(13.2, 13.4, 7.6, 7.6, 1.2)]);
    lines(ctx, [P('M17 15.3 L17 19.1'), P('M15.1 17.2 L18.9 17.2')], 1.4);
  });
  const alias = badge((ctx) => {
    body(ctx, [rrect(13.2, 13.4, 7.6, 7.6, 1.2)]);
    lines(ctx, [P('M15.2 19.4 L15.2 17.6 Q15.2 15.7 17.2 15.7 L18.9 15.7'), P('M17.5 14.4 L18.9 15.7 L17.5 17')], 1.15);
  });
  const noDrop = badge((ctx) => {
    ctx.save(); ctx.translate(11.4, 12.4); ctx.scale(0.5, 0.5); notAllowed(ctx); ctx.restore();
  });
  const progress = badge((ctx, t) => smallSpinner(ctx, t));

  const CELL = P('M7.8 1 L12.2 1 L12.2 7.8 L19 7.8 L19 12.2 L12.2 12.2 L12.2 19 L7.8 19 L7.8 12.2 L1 12.2 L1 7.8 L7.8 7.8 Z');
  const cell = (ctx) => body(ctx, [CELL]);

  const zoom = (plus) => (ctx) => {
    body(ctx, [xform(rrect(12.4, 11.5, 8.6, 3.4, 1.4), rot(45, 12.4, 13.2)), circle(8, 8, 6.6)]);
    const l = [P('M5 8 L11 8')];
    if (plus) l.push(P('M8 5 L8 11'));
    lines(ctx, l, 1.6);
  };

  // kind -> { box: [w, h], hot: [x, y], draw, animated }
  // hot is the top-left corner of the pixel the OS would treat as the hotspot.
  const KINDS = {
    default: { box: [14, 22], hot: [0, 0], draw: arrow },
    pointer: { box: [20, 24], hot: [7.3, 0.6], draw: hand },
    text: { box: [9, 19], hot: [4, 9], draw: ibeam },
    'vertical-text': { box: [19, 9], hot: [9, 4], draw: vbeam },
    crosshair: { box: [19, 19], hot: [9, 9], draw: cross },
    move: { box: [22, 22], hot: [10.5, 10.5], draw: moveArrows },
    'ew-resize': { box: [23, 23], hot: [11, 11], draw: resize(0) },
    'ns-resize': { box: [23, 23], hot: [11, 11], draw: resize(90) },
    'nwse-resize': { box: [23, 23], hot: [11, 11], draw: resize(45) },
    'nesw-resize': { box: [23, 23], hot: [11, 11], draw: resize(-45) },
    'col-resize': { box: [23, 18], hot: [11, 8.5], draw: colResize },
    'row-resize': { box: [18, 23], hot: [8.5, 11], draw: rowResize },
    'not-allowed': { box: [20, 20], hot: [9.5, 9.5], draw: notAllowed },
    'no-drop': { box: [22, 22], hot: [0, 0], draw: noDrop },
    wait: { box: [20, 20], hot: [9.5, 9.5], draw: bigSpinner, animated: true },
    progress: { box: [22, 22], hot: [0, 0], draw: progress, animated: true },
    help: { box: [22, 22], hot: [0, 0], draw: help },
    'context-menu': { box: [22, 23], hot: [0, 0], draw: contextMenu },
    copy: { box: [22, 22], hot: [0, 0], draw: copy },
    alias: { box: [22, 22], hot: [0, 0], draw: alias },
    cell: { box: [20, 20], hot: [9.5, 9.5], draw: cell },
    grab: { box: [18, 23], hot: [9, 9], draw: openHand },
    grabbing: { box: [18, 22], hot: [9, 9], draw: fist },
    'zoom-in': { box: [21, 21], hot: [7.5, 7.5], draw: zoom(true) },
    'zoom-out': { box: [21, 21], hot: [7.5, 7.5], draw: zoom(false) },
  };

  const ALIASES = {
    'all-scroll': 'move',
    'e-resize': 'ew-resize', 'w-resize': 'ew-resize',
    'n-resize': 'ns-resize', 's-resize': 'ns-resize',
    'ne-resize': 'nesw-resize', 'sw-resize': 'nesw-resize',
    'nw-resize': 'nwse-resize', 'se-resize': 'nwse-resize',
    '-webkit-grab': 'grab', '-webkit-grabbing': 'grabbing',
    '-webkit-zoom-in': 'zoom-in', '-webkit-zoom-out': 'zoom-out',
  };

  // Normalizes a CSS cursor keyword. Returns a KINDS key, 'none', 'auto', or 'default'.
  SC.cursorKind = function (keyword) {
    const k = String(keyword || '').trim().toLowerCase();
    if (k === 'none' || k === 'auto') return k;
    if (KINDS[k]) return k;
    if (ALIASES[k]) return ALIASES[k];
    return 'default';
  };
  SC.isAnimatedKind = (kind) => !!(KINDS[kind] && KINDS[kind].animated);

  // ---------- rasterization ----------
  function withShadow(src, scale) {
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    // Matches the Windows pointer shadow: offset down-right, soft, about 30% black.
    ctx.shadowColor = 'rgba(0,0,0,0.32)';
    ctx.shadowBlur = 2.2 * scale;
    ctx.shadowOffsetX = 1.1 * scale;
    ctx.shadowOffsetY = 1.6 * scale;
    ctx.drawImage(src, 0, 0);
    return out;
  }

  const cache = new Map();

  // Returns { key, canvas, hx, hy, dynamic } with hx/hy in device px inside the canvas.
  SC.getSprite = function (kind, scale, timeMs = 0) {
    const def = KINDS[kind] || KINDS.default;
    scale = Math.round(scale * 1000) / 1000;
    const key = kind + '@' + scale;
    let entry = cache.get(key);
    if (entry && !def.animated) return entry.sprite;
    const w = Math.ceil((def.box[0] + PAD * 2) * scale);
    const h = Math.ceil((def.box[1] + PAD * 2) * scale);
    if (!entry) {
      const base = document.createElement('canvas');
      base.width = w; base.height = h;
      entry = { base, sprite: null };
      if (cache.size > 64) cache.clear();
      cache.set(key, entry);
    }
    const ctx = entry.base.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(scale, 0, 0, scale, PAD * scale, PAD * scale);
    def.draw(ctx, timeMs);
    const canvas = withShadow(entry.base, scale);
    entry.sprite = { key, canvas, hx: (PAD + def.hot[0]) * scale, hy: (PAD + def.hot[1]) * scale, dynamic: !!def.animated };
    return entry.sprite;
  };

  // Page-supplied cursor image. Chrome draws these at intrinsic size times the device scale
  // factor (not page zoom, not the OS pointer size), capped at 128 px.
  SC.imageSprite = function (key, img, hotX, hotY, scale) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih || iw > 128 || ih > 128) return null;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(iw * scale)) + 2;
    c.height = Math.max(1, Math.round(ih * scale)) + 2;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 1, 1, c.width - 2, c.height - 2);
    return { key: key + '@' + scale, canvas: c, hx: 1 + hotX * scale, hy: 1 + hotY * scale, dynamic: false };
  };

  SC.CURSOR_KINDS = Object.keys(KINDS);
})(self.SmoothCursor);
