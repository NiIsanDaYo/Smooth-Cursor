'use strict';
importScripts('shared/constants.js');
const SC = self.SmoothCursor;

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  const missing = {};
  for (const k of Object.keys(SC.DEFAULTS)) if (!(k in cur)) missing[k] = SC.DEFAULTS[k];
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  if ('shutter' in cur) await chrome.storage.local.remove('shutter'); // replaced by blur (ms) in 1.0
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !sender.tab) return false;
  switch (msg.type) {
    case 'css': {
      // documentIds pins the stylesheet to this exact document, not whatever the frame
      // navigates to later.
      const target = sender.documentId
        ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
        : { tabId: sender.tab.id, frameIds: [sender.frameId] };
      const req = { target, css: SC.HIDE_CSS, origin: 'USER' };
      (msg.on ? chrome.scripting.insertCSS(req) : chrome.scripting.removeCSS(req))
        .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    case 'zoom':
      chrome.tabs.getZoom(sender.tab.id).then((z) => sendResponse(z), () => sendResponse(1));
      return true;
    case 'image':
      fetchImage(msg.url).then(sendResponse, () => sendResponse(null));
      return true;
  }
  return false;
});

chrome.tabs.onZoomChange.addListener(({ tabId, newZoomFactor }) => {
  chrome.tabs.sendMessage(tabId, { type: 'zoom', factor: newZoomFactor }, { frameId: 0 }).catch(() => {});
});

// Cursor images named by pages. Fetched here because the extension's host permission is
// exempt from CORS; drawing a cross-origin image would taint the WebGL texture upload.
async function fetchImage(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return null;
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > 512 * 1024) return null;
  let type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\//i.test(type)) type = /\.svg(\?|#|$)/i.test(url) ? 'image/svg+xml' : 'image/x-icon';
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { dataUrl: `data:${type};base64,${btoa(bin)}` };
}
