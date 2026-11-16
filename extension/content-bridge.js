/*
 * YTM Audio Saver: content-bridge.js
 * ---------------------------------------------------------------------------
 * Runs in the ISOLATED content-script world (has WebExtension APIs, cannot see
 * page JS). Relays between content-main.js (page world) and background.js:
 *
 *   page  --postMessage-->  bridge  --runtime.sendMessage-->  background
 *   page  <--postMessage--  bridge  <--storage.onChanged----  popup/background
 *
 * Messages from the page are only accepted from this window and this origin.
 * A hostile page script could forge them, but the worst it can do is let
 * video through or lower the level: nothing beyond this extension's own state.
 */
(() => {
  'use strict';

  const api = typeof browser !== 'undefined' ? browser : chrome;
  const MSG_FROM_MAIN = 'ytm-ao-main';
  const MSG_FROM_BRIDGE = 'ytm-ao-bridge';
  const DEFAULTS = { enabled: true, level: 0, autoLearn: true, restyle: true };

  const toPage = (type, payload = {}) =>
    window.postMessage({ source: MSG_FROM_BRIDGE, type, ...payload }, location.origin);

  const send = (msg) => {
    try {
      const p = api.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {}); // background reloading: ignore
    } catch { /* extension context invalidated (update/reload) */ }
  };

  async function pushConfig() {
    try {
      const cfg = await api.storage.local.get(DEFAULTS);
      toPage('config', { config: { enabled: cfg.enabled, level: cfg.level, autoLearn: cfg.autoLearn, restyle: cfg.restyle } });
    } catch { /* ignore */ }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== MSG_FROM_MAIN) return;
    switch (d.type) {
      case 'ready':
        pushConfig();
        break;
      case 'allowVideo':
        send({ type: 'allowVideo', allowed: Boolean(d.allowed) });
        break;
      case 'status':
        if (d.status && typeof d.status === 'object') send({ type: 'status', status: d.status });
        break;
      case 'setLevel': {
        const level = Math.min(2, Math.max(0, Number(d.level) || 0));
        api.storage.local.set({ level }).catch(() => {});
        break;
      }
      default:
        break;
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled || changes.level || changes.autoLearn || changes.restyle) pushConfig();
    if (changes.resetAt) toPage('resetLearning');
  });

  // Whichever script loads first, this handshake makes both sides sync.
  pushConfig();
  toPage('hello');
})();
