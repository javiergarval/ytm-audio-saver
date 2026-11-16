/*
 * YTM Audio Saver: background.js (persistent MV2 background page)
 * ---------------------------------------------------------------------------
 * Network layer. Cancels googlevideo.com/videoplayback requests whose URL says
 * mime=video/..., but only when ALL of these hold:
 *   - the extension is enabled,
 *   - the request comes from a music.youtube.com tab,
 *   - that tab has not asked to let video through (ads, stall recovery, or
 *     the MINIMAL level; see content-main.js).
 * Audio requests (mime=audio/...) are never touched.
 *
 * Note: if YouTube Music moves to SABR (one POST carrying audio+video, no
 * "mime" in the URL), this filter simply stops matching. Nothing breaks; the
 * format rewrite in content-main.js still keeps video at the cheapest format.
 */
'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULTS = { enabled: true, level: 0, autoLearn: true };
let enabled = DEFAULTS.enabled;

const allowTabs = new Set();       // tabIds currently allowed to download video
const tabStatus = new Map();       // tabId -> last status reported by the page
const blockedPerTab = new Map();   // tabId -> cancelled video requests (since browser start)
let blockedTotal = 0;

api.storage.local.get(DEFAULTS).then((cfg) => { enabled = cfg.enabled; });
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) enabled = changes.enabled.newValue !== false;
});

function isYtmUrl(u) {
  return typeof u === 'string' && u.startsWith('https://music.youtube.com/');
}

function onBeforeRequest(details) {
  if (!enabled || details.tabId < 0 || allowTabs.has(details.tabId)) return {};
  if (!isYtmUrl(details.originUrl) && !isYtmUrl(details.documentUrl)) return {};

  let mime = '';
  try { mime = new URL(details.url).searchParams.get('mime') || ''; } catch { return {}; }

  if (mime.startsWith('video/')) {
    blockedTotal++;
    blockedPerTab.set(details.tabId, (blockedPerTab.get(details.tabId) || 0) + 1);
    return { cancel: true };
  }
  return {};
}

api.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ['*://*.googlevideo.com/videoplayback*'] },
  ['blocking']
);

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg !== 'object') return undefined;
  const tabId = sender.tab ? sender.tab.id : undefined;

  switch (msg.type) {
    case 'allowVideo':
      if (tabId === undefined) return undefined;
      if (msg.allowed) allowTabs.add(tabId); else allowTabs.delete(tabId);
      return undefined;

    case 'status':
      if (tabId === undefined) return undefined;
      tabStatus.set(tabId, { ...msg.status, allowVideo: allowTabs.has(tabId), at: Date.now() });
      return undefined;

    case 'getTabInfo': // from the popup
      return Promise.resolve({
        status: tabStatus.get(msg.tabId) || null,
        allowVideo: allowTabs.has(msg.tabId),
        blockedTab: blockedPerTab.get(msg.tabId) || 0,
        blockedTotal,
      });

    default:
      return undefined;
  }
});

api.tabs.onRemoved.addListener((tabId) => {
  allowTabs.delete(tabId);
  tabStatus.delete(tabId);
  blockedPerTab.delete(tabId);
});
