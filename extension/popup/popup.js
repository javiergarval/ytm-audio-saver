/*
 * YTM Audio Saver: popup.js
 * Settings live in storage.local (single source of truth). The status line is
 * what the page reported for the active tab (via background.js).
 */
'use strict';

const api = typeof browser !== 'undefined' ? browser : chrome;
const DEFAULTS = { enabled: true, level: 0, autoLearn: true, restyle: true, clean: true, design: 'ambient', theme: 'auto' };
const DESIGN_DESC = {
  ambient: 'Colors follow the current cover. Floating glass. No Premium upsells.',
  clean: 'Calm, flat and simple. No Premium upsells.',
  off: "YouTube Music's original look.",
};
const MODE_DESC = [
  'The player only gets audio. No video is downloaded.',
  'A tiny video is listed but blocked. No video is downloaded.',
  'A tiny 144p video is downloaded. Always works.',
];

const $ = (id) => document.getElementById(id);

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function loadSettings() {
  const raw = await api.storage.local.get(null);
  const cfg = { ...DEFAULTS, ...raw };
  if (!('design' in raw) && raw.clean === false) cfg.design = 'off';
  $('enabled').checked = cfg.enabled;
  $('autoLearn').checked = cfg.autoLearn;
  $('restyle').checked = cfg.restyle;
  for (const r of document.querySelectorAll('input[name="design"]')) r.checked = r.value === cfg.design;
  $('design-desc').textContent = DESIGN_DESC[cfg.design] || '';
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === cfg.theme;
  document.querySelector('.seg-theme').classList.toggle('disabled', cfg.design === 'off');
  for (const r of document.querySelectorAll('input[name="level"]')) {
    r.checked = Number(r.value) === cfg.level;
  }
  $('mode-desc').textContent = MODE_DESC[cfg.level] || '';
}

/** "audio/webm; codecs=\"opus\"" -> "Opus" */
function codecName(mime) {
  const m = String(mime || '');
  if (/opus/i.test(m)) return 'Opus';
  if (/mp4a/i.test(m)) return 'AAC';
  return m.split(';')[0] || 'Audio';
}

function setStatus(tone, headline, detail) {
  $('dot').className = `dot ${tone}`;
  $('headline').textContent = headline;
  $('detail').textContent = detail;
}

function render(info) {
  const s = info && info.status;
  if (!s) {
    setStatus('', 'Not playing', 'Open YouTube Music and play a song');
  } else if (!s.enabled) {
    setStatus('', 'Off', 'Video plays normally');
  } else if (s.ad) {
    setStatus('warn', 'Ad playing', 'Video allowed until it ends');
  } else if (s.tempAllow) {
    setStatus('warn', 'Recovering', 'Video allowed for this song');
  } else if (!s.patched) {
    setStatus('', 'Waiting for a song', 'Reload the tab if this persists');
  } else {
    const audio = `${codecName(s.audioMime)}${s.audioKbps ? ` · ${s.audioKbps} kbps` : ''}`;
    if (s.videoItag && s.level === 'minimal') setStatus('ok', 'Audio + tiny video', `${audio} · 144p`);
    else setStatus('ok', 'Audio only', audio);
  }

  // Advanced details
  $('s-video').textContent = s && s.patched ? (s.videoItag ? s.videoLabel : 'None') : '–';
  // In Strict mode the player never asks for video, so 0 blocked is the expected result.
  $('s-blocked').textContent = info ? `${info.blockedTab} requests` : '–';
  const proto = $('s-proto');
  if (s && s.sabr === true) {
    proto.textContent = 'SABR (can’t block)';
    proto.className = 'warn';
  } else {
    proto.textContent = s && s.sabr === false ? 'Separate streams' : '–';
    proto.className = '';
  }
}

async function refreshStatus() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) return;
  try {
    render(await api.runtime.sendMessage({ type: 'getTabInfo', tabId: tab.id }));
  } catch {
    render(null);
  }
}

function settingsChanged() {
  $('hint').hidden = false;
}

$('enabled').addEventListener('change', (e) => {
  api.storage.local.set({ enabled: e.target.checked });
  settingsChanged();
});
$('autoLearn').addEventListener('change', (e) => api.storage.local.set({ autoLearn: e.target.checked }));
// Applies instantly on the page (a CSS class), so no reload hint.
$('restyle').addEventListener('change', (e) => api.storage.local.set({ restyle: e.target.checked }));
for (const r of document.querySelectorAll('input[name="design"]')) {
  r.addEventListener('change', () => api.storage.local.set({ design: r.value }));
}
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener('change', () => api.storage.local.set({ theme: r.value }));
}
for (const r of document.querySelectorAll('input[name="level"]')) {
  r.addEventListener('change', () => {
    api.storage.local.set({ level: Number(r.value) });
    settingsChanged();
  });
}
$('retest').addEventListener('click', async () => {
  await api.storage.local.set({ level: 0, resetAt: Date.now() });
  settingsChanged();
});
$('reload').addEventListener('click', async () => {
  const tab = await activeTab();
  const ytm = await api.tabs.query({ url: 'https://music.youtube.com/*' });
  const target = ytm.find((t) => t.id === tab?.id) || ytm[0];
  if (target) api.tabs.reload(target.id);
  window.close();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.level || changes.enabled || changes.autoLearn || changes.restyle || changes.design || changes.theme)) loadSettings();
});

loadSettings();
refreshStatus();
setInterval(refreshStatus, 1500);
