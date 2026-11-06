'use strict';
(async function () {
  const SC = self.SmoothCursor;
  const $ = (id) => document.getElementById(id);
  const t = (key, sub) => chrome.i18n.getMessage(key, sub) || key;

  document.documentElement.lang = chrome.i18n.getUILanguage();
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));

  const settings = await chrome.storage.local.get(SC.DEFAULTS);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // ---------- controls ----------
  const en = $('enabled'), sm = $('smoothing'), bl = $('blur'), sz = $('size'), pr = $('predict');
  const fill = (input) => {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', p + '%');
  };
  const sizeText = (v) => (+v).toFixed(2).replace(/\.?0+$/, '') + '×';

  function paint() {
    en.checked = !!settings.enabled;
    document.body.classList.toggle('off', !settings.enabled);
    sm.value = Math.round(settings.smoothing * 100);
    bl.value = settings.blur;
    sz.value = settings.size;
    pr.checked = !!settings.predict;
    outputs();
  }
  function outputs() {
    $('smoothingOut').textContent = +sm.value === 0 ? t('smoothingOff') : sm.value;
    $('blurVal').textContent = +bl.value === 0 ? t('smoothingOff') : bl.value + ' ms';
    // Streak length follows the exposure: 0..50 ms maps to 0..20 units behind the dot.
    const len = (bl.value / 50) * 20;
    const bar = $('streakBar');
    bar.setAttribute('x', 22.5 - len);
    bar.setAttribute('width', len);
    $('sizeOut').textContent = sizeText(sz.value);
    bl.setAttribute('aria-valuetext', bl.value + ' ms');
    sz.setAttribute('aria-valuetext', sizeText(sz.value));
    for (const r of [sm, bl, sz]) fill(r);
  }

  // Sliders write while dragging (debounced) and once more on release, so open tabs follow
  // the slider live without hammering storage.
  let pending = {}, timer = 0;
  const flush = () => { clearTimeout(timer); timer = 0; if (Object.keys(pending).length) chrome.storage.local.set(pending); pending = {}; };
  const save = (patch, now) => {
    Object.assign(pending, patch);
    if (now) flush();
    else if (!timer) timer = setTimeout(flush, 100);
  };
  const bindRange = (input, key, map) => {
    input.addEventListener('input', () => { settings[key] = map(input.value); outputs(); save({ [key]: settings[key] }); });
    input.addEventListener('change', () => save({}, true));
  };
  bindRange(sm, 'smoothing', (v) => v / 100);
  bindRange(bl, 'blur', (v) => +v);
  bindRange(sz, 'size', (v) => +v);
  pr.addEventListener('change', () => { settings.predict = pr.checked; save({ predict: pr.checked }, true); });
  en.addEventListener('change', () => { settings.enabled = en.checked; document.body.classList.toggle('off', !en.checked); save({ enabled: en.checked }, true); });
  addEventListener('pagehide', flush);

  // ---------- this site ----------
  const site = tab && tab.url ? SC.siteKey(tab.url) : null;
  const scriptable = !!tab && /^(https?|file):/i.test(tab.url || '') && !/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(tab.url);
  const siteOn = $('siteOn'), siteLabel = $('siteLabel'), siteNote = $('siteNote'), reload = $('reload');
  if (scriptable && site) {
    siteLabel.textContent = t('site', site);
    siteLabel.title = site;
    siteOn.checked = !(settings.disabledSites || []).includes(site);
    siteOn.addEventListener('change', () => {
      const list = new Set(settings.disabledSites || []);
      if (siteOn.checked) list.delete(site); else list.add(site);
      settings.disabledSites = [...list];
      save({ disabledSites: settings.disabledSites }, true);
    });
    // Tabs opened before installation have no content script until they reload.
    chrome.tabs.sendMessage(tab.id, { type: 'ping' }, { frameId: 0 }).then(
      (r) => { if (!r) showReload(); },
      () => showReload(),
    );
  } else {
    // chrome://, the Web Store and other extensions' pages: nothing to switch, just say why.
    $('siteRow').hidden = true;
    siteNote.textContent = t('siteUnavailable');
    siteNote.hidden = false;
  }
  function showReload() {
    siteNote.textContent = t('reloadNote');
    siteNote.hidden = false;
    reload.hidden = false;
    reload.addEventListener('click', () => { chrome.tabs.reload(tab.id); window.close(); }, { once: true });
  }

  paint();
})();
