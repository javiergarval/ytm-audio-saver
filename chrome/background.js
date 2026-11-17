/*
 * YTM Audio Saver: background.js (Chrome, Manifest V3 service worker)
 * ---------------------------------------------------------------------------
 * Same job as the Firefox background page, done the MV3 way:
 *   - rules.json (static ruleset "block-video") blocks googlevideo.com
 *     videoplayback requests whose URL says mime=video/..., only when they come
 *     from music.youtube.com. Audio (mime=audio/...) is never matched.
 *   - The on/off switch enables or disables that ruleset.
 *   - A tab that needs video (ads, stall recovery, MINIMAL level) gets a
 *     higher-priority "allow" session rule scoped to that tab only.
 * Service workers sleep, so nothing important lives in memory: allow rules are
 * session rules and the last status per tab lives in storage.session.
 */
'use strict';

const RULESET = 'block-video';
const BLOCK_RULE_ID = 1;
const allowRuleId = (tabId) => tabId + 1; // session rule ids must be >= 1

async function applyEnabled() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  await chrome.declarativeNetRequest.updateEnabledRulesets(
    enabled !== false ? { enableRulesetIds: [RULESET] } : { disableRulesetIds: [RULESET] },
  );
}
applyEnabled();
chrome.runtime.onStartup.addListener(applyEnabled);
chrome.runtime.onInstalled.addListener(applyEnabled);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) applyEnabled();
});

async function setAllow(tabId, allowed) {
  const id = allowRuleId(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: allowed ? [{
      id,
      priority: 2,
      action: { type: 'allow' },
      condition: { tabIds: [tabId], requestDomains: ['googlevideo.com'] },
    }] : [],
  });
}

async function isAllowed(tabId) {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.id === allowRuleId(tabId));
}

async function blockedCounts(tabId) {
  // Needs "declarativeNetRequestFeedback"; Chrome rate-limits it, so never fatal.
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({});
    const blocks = rulesMatchedInfo.filter((m) => m.rule.rulesetId === RULESET && m.rule.ruleId === BLOCK_RULE_ID);
    return { blockedTab: blocks.filter((m) => m.tabId === tabId).length, blockedTotal: blocks.length };
  } catch {
    return { blockedTab: 0, blockedTotal: 0 };
  }
}

async function tabInfo(tabId) {
  const key = `tab:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const [allowVideo, counts] = await Promise.all([isAllowed(tabId), blockedCounts(tabId)]);
  return { status: stored[key] || null, allowVideo, ...counts };
}

// Chrome: answer with sendResponse + `return true` (not a returned Promise).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  const tabId = sender.tab ? sender.tab.id : undefined;

  switch (msg.type) {
    case 'allowVideo':
      if (tabId !== undefined) setAllow(tabId, Boolean(msg.allowed)).catch(() => {});
      return false;

    case 'status':
      if (tabId !== undefined) {
        chrome.storage.session.set({ [`tab:${tabId}`]: { ...msg.status, at: Date.now() } }).catch(() => {});
      }
      return false;

    case 'getTabInfo': // from the popup
      tabInfo(msg.tabId).then(sendResponse, () => sendResponse(null));
      return true;

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  setAllow(tabId, false).catch(() => {});
  chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
});
