'use strict';
// Shared by the content scripts, the popup and the service worker (importScripts).
self.SmoothCursor = self.SmoothCursor || {};

(function (SC) {
  // Element we own: a light-DOM child of <html>. It carries the probe checkbox and,
  // in the top frame, the top-layer canvas overlay inside a closed shadow root.
  SC.HOST_TAG = 'smooth-cursor-host';

  // Injected with origin USER (chrome.scripting.insertCSS). User-origin !important beats
  // every author declaration (inline !important and @layer included) and also matches
  // elements inside open and closed shadow roots.
  //
  // Reading the page's own cursor without showing the OS cursor:
  // - every element that is not :hover is always hidden;
  // - the hovered chain is hidden only while --smooth-cursor-probe is 0 on <html>;
  // - --smooth-cursor-probe is a non-inherited registered property flipped by the
  //   :checked state of our checkbox, so a probe invalidates <html> plus the hovered
  //   chain only (about 0.6 ms on a 10k-element page, versus 18 ms for a global toggle),
  //   and produces no DOM mutation records for the page to observe.
  // - ancestors of a modal <dialog> are inert, so they lose :hover; forcing them to `none`
  //   would leak into the dialog through inheritance, hence :not(:has(:modal)).
  SC.HIDE_CSS = `
@property --smooth-cursor-probe { syntax: "<integer>"; inherits: false; initial-value: 0; }
:root { container-name: smooth-cursor-root !important; }
:root:has(> smooth-cursor-host > input:checked) { --smooth-cursor-probe: 1 !important; }
:root:not(:has(> smooth-cursor-host > input:checked)),
:not(:root):not(:hover):not(:has(:modal)),
:not(:hover)::before,
:not(:hover)::after,
::backdrop { cursor: none !important; }
:not(:hover)::file-selector-button { cursor: none !important; }
:not(:hover)::-webkit-inner-spin-button { cursor: none !important; }
:not(:hover)::-webkit-search-cancel-button { cursor: none !important; }
:not(:hover)::-webkit-calendar-picker-indicator { cursor: none !important; }
@container smooth-cursor-root style(--smooth-cursor-probe: 0) {
  :hover, :hover::before, :hover::after { cursor: none !important; }
  :hover::file-selector-button { cursor: none !important; }
  :hover::-webkit-inner-spin-button { cursor: none !important; }
  :hover::-webkit-search-cancel-button { cursor: none !important; }
  :hover::-webkit-calendar-picker-indicator { cursor: none !important; }
}
`;

  SC.DEFAULTS = Object.freeze({
    enabled: true,
    smoothing: 0.4,   // 0..1, see smoothingParams()
    // Exposure in ms. A shutter angle would tie the blur to the refresh rate: 180° is 8 ms on a
    // 60 Hz screen but 4 ms on 120 Hz, which reads as no blur at all. 17 ms equals one 60 Hz
    // frame, so every screen shows the look of 60 fps footage shot with a 360° shutter.
    blur: 17,
    size: 1,          // multiple of the Windows default pointer size
    predict: true,    // latency compensation
    disabledSites: [],
  });

  // Maps the single 0..1 slider onto One Euro Filter parameters (Casiez et al., CHI 2012).
  // Both ends are log-interpolated because perceived smoothing is roughly logarithmic in the
  // cutoff frequency. minCutoff: 30 Hz (barely filtered) .. 1.2 Hz (very soft).
  // beta: 0.25 .. 0.012; the worst-case lag at high speed is 1 / (2*pi*beta) px,
  // so 0.6 px at the low end and 13 px at the top.
  SC.smoothingParams = function (s) {
    if (!(s > 0.005)) return null;
    const lerpLog = (a, b, t) => a * Math.pow(b / a, t);
    return { minCutoff: lerpLog(30, 1.2, s), beta: lerpLog(0.25, 0.012, s), dCutoff: 8 };
  };

  SC.siteKey = function (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'file:') return 'file://';
      return u.hostname || null;
    } catch { return null; }
  };
})(self.SmoothCursor);
