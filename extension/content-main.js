/*
 * YTM Audio Saver: content-main.js
 * ---------------------------------------------------------------------------
 * Runs in the PAGE's own JavaScript world ("world": "MAIN") at document_start,
 * i.e. before any YouTube Music script executes. Firefox injects MAIN-world
 * content scripts itself, so the page's CSP / Trusted Types cannot block it
 * (this is the main reason this is an extension and not a userscript).
 *
 * What it does:
 *   1. FORMAT REWRITE: every player response that passes through JSON.parse,
 *      Response.json(), XHR(json) or window.ytInitialPlayerResponse gets its
 *      streamingData.adaptiveFormats reduced to:
 *        - the single best free audio format (251 Opus > 140 AAC > ...), and
 *        - depending on the level, zero or one (the cheapest) video format.
 *   2. SELF-HEALING LADDER: blocking video can make some player builds stall.
 *      A watchdog detects stalls and steps down, learning what works:
 *        STRICT  (0): audio-only formats + video requests blocked  -> 0 video bytes
 *        BLOCK   (1): audio + 1 tiny video format, video blocked   -> 0 video bytes
 *        MINIMAL (2): audio + 1 tiny video format, nothing blocked -> ~144p video only
 *      A level is only demoted permanently after failures on 2 different
 *      tracks with no successful track in between (one-off network hiccups
 *      do not demote you). You can re-test from the toolbar popup.
 *   3. CLEAN UI: html.ytm-ao-on lets content.css hide #song-video and show
 *      #song-image; this script fills #song-image with the sharpest artwork
 *      available. html.ytm-ao-style adds the album-art look (centered art over
 *      a blurred copy of itself); it can be switched off in the popup.
 *      During ads nothing is hidden or blocked (skip buttons stay usable).
 *   4. SPA RESILIENCE: hooks are global and permanent; a 1 s watchdog plus
 *      yt-navigate-finish / MutationObserver handle track & page changes.
 *
 * This world has NO WebExtension APIs. It talks to content-bridge.js
 * (isolated world) through window.postMessage.
 */
(() => {
  'use strict';

  if (window.__ytmAoInstalled) return;
  Object.defineProperty(window, '__ytmAoInstalled', { value: true });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const MSG_FROM_MAIN = 'ytm-ao-main';
  const MSG_FROM_BRIDGE = 'ytm-ao-bridge';

  const LS_CONFIG = 'ytm-ao-config';          // mirror of extension storage (sync read at startup)
  const LS_STRIKES = 'ytm-ao-strikes';        // tracks that failed per level
  const SS_SESSION_LEVEL = 'ytm-ao-session-level'; // per-tab temporary demotion
  const SS_LAST_RELOAD = 'ytm-ao-last-reload';

  const LEVEL = Object.freeze({ STRICT: 0, BLOCK: 1, MINIMAL: 2 });
  const LEVEL_NAMES = ['strict', 'block', 'minimal'];
  const DEFAULT_CONFIG = Object.freeze({
    enabled: true, level: LEVEL.STRICT, autoLearn: true, restyle: true, design: 'nowplaying', theme: 'auto',
  });
  const THEMES = ['auto', 'dark', 'light'];
  const DESIGNS = ['nowplaying', 'ambient', 'clean', 'off'];
  const usesAmbient = () => config.design === 'ambient' || config.design === 'nowplaying';

  // Audio itag preference. 774 (Opus ~256k) and 141 (AAC 256k) are Premium-only:
  // they never appear for free accounts, they are listed so the order stays correct
  // if they ever do. For free accounts the effective choice is 251 (Opus) or 140 (AAC).
  const AUDIO_ITAG_PRIORITY = [774, 141, 251, 140, 250, 249, 139];

  const TICK_MS = 1000;
  const STALL_LIMIT_S = 8;           // seconds "playing" without progress => stall
  const ERROR_LIMIT_S = 2;           // seconds with a visible player error => stall
  const CLEAN_PLAY_CONFIRM_S = 20;   // seconds of clean playback that prove a level works
  const STRIKES_TO_DEMOTE = 2;       // distinct failing tracks before a permanent demotion
  const MIN_RELOAD_INTERVAL_MS = 60_000;
  const STATUS_EVERY_S = 10;
  const ALLOW_HEARTBEAT_MS = 30_000;

  // Keep native references BEFORE we patch anything.
  const nativeParse = JSON.parse;
  const nativeStringify = JSON.stringify;

  // ---------------------------------------------------------------------------
  // Storage helpers (localStorage can throw if cookies/site data are blocked)
  // ---------------------------------------------------------------------------
  function safeStorage(name) {
    try {
      const s = window[name];
      s.getItem('__ytm_ao_probe__');
      return s;
    } catch {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => void m.set(k, String(v)),
        removeItem: (k) => void m.delete(k),
      };
    }
  }
  const LS = safeStorage('localStorage');
  const SS = safeStorage('sessionStorage');

  const readJSON = (store, key, fallback) => {
    try {
      const raw = store.getItem(key);
      return raw ? nativeParse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJSON = (store, key, value) => {
    try { store.setItem(key, nativeStringify(value)); } catch { /* quota / disabled */ }
  };

  const clampLevel = (n) => Math.min(LEVEL.MINIMAL, Math.max(LEVEL.STRICT, Number(n) || 0));

  function sanitizeConfig(c) {
    const src = c && typeof c === 'object' ? c : {};
    return {
      enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULT_CONFIG.enabled,
      level: clampLevel(src.level ?? DEFAULT_CONFIG.level),
      autoLearn: typeof src.autoLearn === 'boolean' ? src.autoLearn : DEFAULT_CONFIG.autoLearn,
      restyle: typeof src.restyle === 'boolean' ? src.restyle : DEFAULT_CONFIG.restyle,
      // 'design' replaced the old on/off 'clean' setting: keep an explicit "off".
      design: DESIGNS.includes(src.design) ? src.design : (src.clean === false ? 'off' : DEFAULT_CONFIG.design),
      theme: THEMES.includes(src.theme) ? src.theme : DEFAULT_CONFIG.theme,
    };
  }

  let config = sanitizeConfig(readJSON(LS, LS_CONFIG, DEFAULT_CONFIG));

  /** Level applied to NEW player responses: persisted level, possibly raised for this tab. */
  function effectiveLevel() {
    return Math.max(config.level, clampLevel(SS.getItem(SS_SESSION_LEVEL)));
  }

  const log = (...a) => console.debug('[YTM Audio Saver]', ...a);

  // ---------------------------------------------------------------------------
  // Messaging with content-bridge.js
  // ---------------------------------------------------------------------------
  const post = (type, payload = {}) => {
    try { window.postMessage({ source: MSG_FROM_MAIN, type, ...payload }, location.origin); } catch { /* ignore */ }
  };

  // ---------------------------------------------------------------------------
  // 1. Format selection & player-response rewrite
  // ---------------------------------------------------------------------------
  const isAudio = (f) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('audio/');
  const isVideo = (f) => typeof f?.mimeType === 'string' && f.mimeType.startsWith('video/');
  const bitrateOf = (f) => Number(f?.averageBitrate || f?.bitrate || 0);
  const preferNonEmpty = (filtered, original) => (filtered.length ? filtered : original);

  function canPlay(mime) {
    try {
      return typeof MediaSource === 'undefined' || !mime || MediaSource.isTypeSupported(mime);
    } catch {
      return true;
    }
  }

  /** Best audio: default language track, non-"stable volume" (DRC), decodable, by itag priority then bitrate. */
  function pickBestAudio(formats) {
    let list = formats.filter(isAudio);
    if (!list.length) return null;
    if (list.some((f) => f.audioTrack)) {
      list = preferNonEmpty(list.filter((f) => f.audioTrack?.audioIsDefault), list);
    }
    list = preferNonEmpty(list.filter((f) => !f.isDrc), list);
    list = preferNonEmpty(list.filter((f) => canPlay(f.mimeType)), list);
    const rank = (f) => {
      const i = AUDIO_ITAG_PRIORITY.indexOf(Number(f.itag));
      return i === -1 ? AUDIO_ITAG_PRIORITY.length : i;
    };
    return [...list].sort((a, b) => rank(a) - rank(b) || bitrateOf(b) - bitrateOf(a))[0];
  }

  /**
   * Cheapest video to fetch AND decode: lowest resolution first, then H.264
   * (cheapest to decode, usually hardware), then VP9, then AV1, then bitrate.
   */
  function pickCheapestVideo(formats) {
    let list = formats.filter(isVideo);
    if (!list.length) return null;
    list = preferNonEmpty(list.filter((f) => canPlay(f.mimeType)), list);
    const pixels = (f) => Number(f.width || 0) * Number(f.height || 0) || Number.MAX_SAFE_INTEGER;
    const codecCost = (f) => (/avc1/.test(f.mimeType) ? 0 : /vp0?9/.test(f.mimeType) ? 1 : 2);
    return [...list].sort(
      (a, b) => pixels(a) - pixels(b) || codecCost(a) - codecCost(b) || bitrateOf(a) - bitrateOf(b)
    )[0];
  }

  const patched = new WeakSet();
  const trackInfo = new Map(); // videoId -> what we did to its player response
  const artByVid = new Map();  // videoId -> best artwork URL

  function remember(map, key, value, max = 60) {
    map.set(key, value);
    if (map.size > max) map.delete(map.keys().next().value);
  }

  function normalizeArtUrl(u) {
    if (!u) return null;
    try {
      const url = new URL(u, location.href);
      // i.ytimg.com query strings are crop/resize parameters; the bare file is full size.
      if (url.hostname.endsWith('ytimg.com')) url.search = '';
      return url.href;
    } catch {
      return null;
    }
  }

  function largestThumb(list) {
    if (!Array.isArray(list) || !list.length) return null;
    const area = (t) => Number(t?.width || 0) * Number(t?.height || 0);
    return normalizeArtUrl([...list].sort((a, b) => area(b) - area(a))[0]?.url);
  }

  function patchPlayerResponse(pr) {
    if (!config.enabled || !pr || typeof pr !== 'object' || patched.has(pr)) return;
    const sd = pr.streamingData;
    if (!sd || !Array.isArray(sd.adaptiveFormats) || !sd.adaptiveFormats.length) return;
    patched.add(pr);

    const vd = pr.videoDetails || {};
    if (vd.videoId) {
      const art = largestThumb(vd.thumbnail?.thumbnails);
      if (art) remember(artByVid, vd.videoId, art);
    }

    // Leave live streams and unplayable responses untouched.
    if (vd.isLive || sd.hlsManifestUrl) return;
    if (pr.playabilityStatus && pr.playabilityStatus.status !== 'OK') return;

    const level = effectiveLevel();
    const audio = pickBestAudio(sd.adaptiveFormats);
    if (!audio) return; // no audio-only stream: never break playback

    const video = level === LEVEL.STRICT ? null : pickCheapestVideo(sd.adaptiveFormats);
    const before = sd.adaptiveFormats.length;
    sd.adaptiveFormats = video ? [video, audio] : [audio];
    // In STRICT mode also drop the muxed progressive fallback (e.g. itag 18),
    // otherwise the player could fall back to a 360p audio+video file.
    if (level === LEVEL.STRICT && 'formats' in sd) delete sd.formats;

    const info = {
      level,
      audioItag: Number(audio.itag),
      audioMime: audio.mimeType,
      audioKbps: Math.round(bitrateOf(audio) / 1000),
      videoItag: video ? Number(video.itag) : null,
      videoLabel: video ? `${video.qualityLabel || `${video.height || '?'}p`} ${String(video.mimeType).split(';')[0]}` : null,
      // SABR = YouTube's newer single-request protocol. When present, network
      // blocking by "mime=video" cannot work and only the format rewrite helps.
      sabr: Boolean(sd.serverAbrStreamingUrl),
    };
    if (vd.videoId) remember(trackInfo, vd.videoId, info);
    log(`patched ${vd.videoId || '?'}: ${before} -> ${sd.adaptiveFormats.length} formats`, info);
  }

  /** Accepts any parsed JSON value; patches player responses found at known spots. */
  function patchAny(value) {
    if (!value || typeof value !== 'object') return value;
    try {
      if (value.streamingData && (value.videoDetails || value.playabilityStatus)) {
        patchPlayerResponse(value);
      }
      if (value.playerResponse?.streamingData) patchPlayerResponse(value.playerResponse);
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item?.playerResponse?.streamingData) patchPlayerResponse(item.playerResponse);
        }
      }
    } catch (e) {
      console.warn('[YTM Audio Saver] patch failed (playback left untouched):', e);
    }
    return value;
  }

  // --- Hook 1: JSON.parse (covers text responses, embedded initialData strings) ---
  const wrappedParse = function parse(text, reviver) {
    const result = nativeParse.apply(this, arguments);
    if (result && typeof result === 'object' &&
        ('streamingData' in result || 'playerResponse' in result || Array.isArray(result))) {
      patchAny(result);
    }
    return result;
  };
  try {
    Object.defineProperty(JSON, 'parse', { value: wrappedParse, writable: true, configurable: true });
  } catch { JSON.parse = wrappedParse; }

  // --- Hook 2: fetch Response.json() ---
  try {
    const nativeJson = Response.prototype.json;
    Object.defineProperty(Response.prototype, 'json', {
      configurable: true,
      writable: true,
      value: function json() {
        return nativeJson.apply(this, arguments).then(patchAny);
      },
    });
  } catch (e) { log('Response.json hook unavailable', e); }

  // --- Hook 3: XMLHttpRequest with responseType = "json" ---
  try {
    const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
    if (desc && typeof desc.get === 'function') {
      Object.defineProperty(XMLHttpRequest.prototype, 'response', {
        configurable: true,
        enumerable: desc.enumerable,
        get() {
          const v = desc.get.call(this);
          if (this.responseType === 'json') patchAny(v);
          return v;
        },
      });
    }
  } catch (e) { log('XHR hook unavailable', e); }

  // --- Hook 4: object-literal globals assigned by inline scripts ---
  try {
    let initialPR;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      enumerable: true,
      get: () => initialPR,
      set: (v) => { initialPR = patchAny(v); },
    });
  } catch (e) { log('ytInitialPlayerResponse hook unavailable', e); }

  // ---------------------------------------------------------------------------
  // 2. Watchdog / self-healing ladder
  // ---------------------------------------------------------------------------
  const state = {
    videoId: null,
    ad: false,
    lastTime: -1,
    stallSecs: 0,
    stallEvents: 0,
    cleanSecs: 0,
    tempAllow: false,     // video temporarily allowed for this track (recovery)
    allowSent: null,
    allowSentAt: 0,
    ticks: 0,
    observedPlayer: null,
  };

  const trackLevel = (vid) => trackInfo.get(vid)?.level ?? effectiveLevel();

  function computeAllow() {
    return !config.enabled || trackLevel(state.videoId) >= LEVEL.MINIMAL || state.ad || state.tempAllow;
  }

  function syncAllow(force = false) {
    const allowed = computeAllow();
    const now = Date.now();
    if (force || allowed !== state.allowSent || now - state.allowSentAt > ALLOW_HEARTBEAT_MS) {
      post('allowVideo', { allowed });
      state.allowSent = allowed;
      state.allowSentAt = now;
    }
  }

  function sendStatus() {
    const info = trackInfo.get(state.videoId) || null;
    post('status', {
      status: {
        enabled: config.enabled,
        videoId: state.videoId,
        level: LEVEL_NAMES[trackLevel(state.videoId)],
        configLevel: LEVEL_NAMES[config.level],
        autoLearn: config.autoLearn,
        audioItag: info?.audioItag ?? null,
        audioMime: info?.audioMime ?? null,
        audioKbps: info?.audioKbps ?? null,
        videoItag: info?.videoItag ?? null,
        videoLabel: info?.videoLabel ?? null,
        sabr: info ? info.sabr : null,
        patched: Boolean(info),
        tempAllow: state.tempAllow,
        ad: state.ad,
      },
    });
  }

  function strikes() {
    const s = readJSON(LS, LS_STRIKES, {});
    return { strict: Array.isArray(s.strict) ? s.strict : [], block: Array.isArray(s.block) ? s.block : [] };
  }
  function addStrike(kind, vid) {
    const s = strikes();
    if (!s[kind].includes(vid)) s[kind].push(vid);
    s[kind] = s[kind].slice(-10);
    writeJSON(LS, LS_STRIKES, s);
    return s[kind].length;
  }
  function clearStrikes(kind) {
    const s = strikes();
    if (!s[kind].length) return;
    s[kind] = [];
    writeJSON(LS, LS_STRIKES, s);
  }

  /** Persistently step down (only if auto-learn is on). */
  function demote(toLevel) {
    if (!config.autoLearn || toLevel <= config.level) return;
    log(`demoting to "${LEVEL_NAMES[toLevel]}" (blocking broke playback on ${STRIKES_TO_DEMOTE} tracks)`);
    config = { ...config, level: toLevel };
    writeJSON(LS, LS_CONFIG, config);
    post('setLevel', { level: toLevel });
  }

  function nudge(player, video) {
    try {
      const t = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : video.currentTime;
      const target = Math.max(0, Number(t) - 0.25);
      if (typeof player.seekTo === 'function') player.seekTo(target, true);
      else video.currentTime = target;
      if (video.paused && typeof player.playVideo === 'function') player.playVideo();
    } catch (e) { log('nudge failed', e); }
  }

  /** Reload the tab so a fresh player response is built at a safer level. */
  function reloadAtLevel(level, player, video) {
    const last = Number(SS.getItem(SS_LAST_RELOAD)) || 0;
    if (Date.now() - last < MIN_RELOAD_INTERVAL_MS) {
      // Never loop reloads: just let video through for this track.
      state.tempAllow = true;
      syncAllow(true);
      nudge(player, video);
      return;
    }
    SS.setItem(SS_SESSION_LEVEL, String(Math.max(level, clampLevel(SS.getItem(SS_SESSION_LEVEL)))));
    SS.setItem(SS_LAST_RELOAD, String(Date.now()));
    log(`reloading at level "${LEVEL_NAMES[level]}" to recover playback`);
    location.reload();
  }

  function handleStall(player, video) {
    const vid = state.videoId;
    if (!vid) return;
    state.stallEvents++;
    const lvl = trackLevel(vid);
    log(`stall #${state.stallEvents} on ${vid} at level "${LEVEL_NAMES[lvl]}"${state.ad ? ' (ad)' : ''}`);

    // Ads: video is already allowed; give the player one poke before treating it as our fault.
    if (state.ad && state.stallEvents === 1) { nudge(player, video); return; }

    if (lvl === LEVEL.STRICT) {
      // Player could not cope with an audio-only format list: rebuild the response at BLOCK.
      if (addStrike('strict', vid) >= STRIKES_TO_DEMOTE) demote(LEVEL.BLOCK);
      reloadAtLevel(LEVEL.BLOCK, player, video);
      return;
    }
    if (lvl === LEVEL.BLOCK) {
      if (!state.tempAllow) {
        // First try: let video through for this track and poke the player.
        state.tempAllow = true;
        syncAllow(true);
        sendStatus();
        if (addStrike('block', vid) >= STRIKES_TO_DEMOTE) demote(LEVEL.MINIMAL);
        setTimeout(() => nudge(player, video), 300);
        return;
      }
      // Still stuck even with video allowed: the player gave up; rebuild at MINIMAL.
      reloadAtLevel(LEVEL.MINIMAL, player, video);
      return;
    }
    // MINIMAL blocks nothing, so a stall here is the network, not us.
    nudge(player, video);
  }

  function onTrackChange(vid) {
    state.videoId = vid;
    state.lastTime = -1;
    state.stallSecs = 0;
    state.stallEvents = 0;
    state.cleanSecs = 0;
    state.tempAllow = false;
    syncAllow(true);
    sendStatus();
  }

  // YouTube Music reports some playback failures only as a toast at the bottom
  // ("No se admite este formato de vídeo" / "This video format is not supported"),
  // and the <video> may sit paused meanwhile: treat those as errors too.
  const FORMAT_ERROR = /formato de v[ií]deo|video format|format (?:is )?not supported|unsupported format/i;

  function isErrorVisible(player) {
    const el = player.querySelector('.ytp-error');
    if (el && el.textContent && el.textContent.trim()) return true;
    // Not video.error: YouTube clears the src between tracks, which leaves a stale
    // 'format not supported' error on the element and caused false reloads (1.0.11).
    for (const toast of document.querySelectorAll('tp-yt-paper-toast, ytmusic-notification-text-renderer, yt-notification-action-renderer')) {
      const b = toast.getBoundingClientRect();
      if (b.width > 0 && b.height > 0 && FORMAT_ERROR.test(toast.textContent || '')) return true;
    }
    return false;
  }

  function watchPlayback(player) {
    const video = player.querySelector('video');
    if (!video || !state.videoId) return;
    const t = video.currentTime;
    const progressed = state.lastTime >= 0 && Math.abs(t - state.lastTime) > 0.05;
    state.lastTime = t;

    if (!config.enabled || !trackInfo.has(state.videoId)) { state.stallSecs = 0; return; }

    if (progressed) {
      state.stallSecs = 0;
      if (!state.ad && ++state.cleanSecs === CLEAN_PLAY_CONFIRM_S && state.stallEvents === 0) {
        // This level demonstrably works: forget earlier failures.
        const lvl = trackLevel(state.videoId);
        if (lvl === LEVEL.STRICT) clearStrikes('strict');
        if (lvl <= LEVEL.BLOCK && !state.tempAllow) clearStrikes('block');
      }
      return;
    }

    const error = isErrorVisible(player);
    const wantsToPlay = !video.paused && !video.ended;
    if (!wantsToPlay && !error) { state.stallSecs = 0; return; } // user paused / autoplay blocked

    state.stallSecs++;
    if (state.stallSecs >= (error ? ERROR_LIMIT_S : STALL_LIMIT_S)) {
      state.stallSecs = 0;
      handleStall(player, video);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Clean UI (artwork in #song-image; CSS lives in content.css)
  // ---------------------------------------------------------------------------
  function artFor(player, vid) {
    try {
      const pr = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      if (pr?.videoDetails?.videoId === vid) {
        const u = largestThumb(pr.videoDetails.thumbnail?.thumbnails);
        if (u) return u;
      }
    } catch { /* ignore */ }
    return artByVid.get(vid) || `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg`;
  }

  // --- Artwork upgrade: try sharper sources first, keep the first that really loads ---
  const LH3_SIZE = /=w\d+-h\d+/;
  const LETTERBOX_FILE = /\/(?:hq|sd)?default\.jpg$|\/[0-3]\.jpg$/; // 4:3 files with black bars

  /** Ordered candidate URLs, sharpest first. */
  function artCandidates(base, vid) {
    const id = encodeURIComponent(vid);
    const list = [];
    if (/googleusercontent\.com/.test(base) && LH3_SIZE.test(base)) {
      list.push(base.replace(LH3_SIZE, '=w1200-h1200')); // album art (song tracks)
    } else if (!/googleusercontent\.com/.test(base)) {
      list.push(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hq720.jpg`);
    }
    list.push(base, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    return [...new Set(list.filter(Boolean))];
  }

  /** "square" | "wide" | "letterbox" (4:3 file holding a 16:9 picture between black bars). */
  function artShape(url, w, h) {
    const r = w && h ? w / h : 1;
    let path = '';
    try { path = new URL(url).pathname; } catch { /* keep '' */ }
    if (/ytimg\.com/.test(url) && LETTERBOX_FILE.test(path) && r > 1.25 && r < 1.4) return 'letterbox';
    return r > 1.2 ? 'wide' : 'square';
  }

  /** Loads candidates in order; YouTube serves a 120x90 placeholder for missing sizes, so skip those. */
  function resolveArt(candidates) {
    return new Promise((resolve) => {
      let i = 0;
      const next = () => {
        if (i >= candidates.length) { resolve(null); return; }
        const url = candidates[i++];
        const probe = new Image();
        probe.onload = () => (probe.naturalWidth > 120
          ? resolve({ url, shape: artShape(url, probe.naturalWidth, probe.naturalHeight) })
          : next());
        probe.onerror = next;
        probe.src = url;
      };
      next();
    });
  }

  const art = { vid: null, url: null, shape: 'square', base: null, since: 0 };

  /**
   * The player bar thumbnail is the square album cover for songs (lh3.googleusercontent.com).
   * For music videos it's the video thumbnail (i.ytimg.com). Only trust it once it differs
   * from the previous track's, because it updates a moment after the track changes.
   */
  function playerBarArt() {
    const src = document.querySelector('ytmusic-player-bar img.image')?.getAttribute('src') || '';
    return /^https:\/\//.test(src) ? src : null;
  }

  function bestBase(player, vid) {
    const bar = playerBarArt();
    if (bar && /googleusercontent\.com/.test(bar)) return bar; // square album art: always best
    return artFor(player, vid);
  }

  function resolveFrom(base, vid) {
    art.base = base;
    resolveArt(artCandidates(base, vid)).then((best) => {
      if (best && art.vid === vid && art.base === base) Object.assign(art, best);
      paintArt();
    });
  }

  function updateArt(player) {
    if (!config.enabled || !state.videoId) return;
    const vid = state.videoId;
    if (art.vid !== vid) {
      // Show what we have immediately, then swap in a sharper version once it loads.
      const base = bestBase(player, vid);
      Object.assign(art, { vid, url: base, since: Date.now(), shape: artShape(base, 4, 3) === 'letterbox' ? 'letterbox' : 'square' });
      resolveFrom(base, vid);
    } else if (Date.now() - art.since < 10_000) {
      // The player bar may switch to the new cover a moment later: follow it for a few seconds.
      const base = bestBase(player, vid);
      if (base !== art.base && /googleusercontent\.com/.test(base)) resolveFrom(base, vid);
    }
    paintArt();
  }

  /** Cheap and idempotent: re-applied every tick in case YouTube Music re-renders the element. */
  function paintArt() {
    const box = document.querySelector('ytmusic-player #song-image');
    const img = box && box.querySelector('img');
    if (!img || !art.url || art.vid !== state.videoId) return;
    if (img.getAttribute('src') !== art.url) {
      img.removeAttribute('srcset');
      img.setAttribute('src', art.url);
    }
    if (img.dataset.ytmAoShape !== art.shape) img.dataset.ytmAoShape = art.shape;
    const cssUrl = `url("${art.url.replace(/"/g, '%22')}")`;
    if (box.style.getPropertyValue('--ytm-ao-art') !== cssUrl) box.style.setProperty('--ytm-ao-art', cssUrl);
  }

  // ---------------------------------------------------------------------------
  // Clean design helpers: theme and Premium/upgrade removal
  // ---------------------------------------------------------------------------
  const designOn = () => config.enabled && config.design !== 'off';

  // ---- Ambient: the window takes the colors of the current cover ----------
  const ambient = { url: null };

  /** A small copy is plenty for a 80px blur and for color sampling. */
  function smallArt(url, vid) {
    if (/googleusercontent\.com/.test(url) && /=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+/, '=w240-h240');
    return vid ? `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/mqdefault.jpg` : url;
  }

  const rgbToHsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };

  /**
   * Most "vivid" color family of the cover: pixels are grouped into 12 hue
   * buckets weighted by saturation x brightness, the heaviest bucket wins.
   * Returns [hue, saturation] or null (grey covers, or images without CORS).
   */
  function pickAccent(pixels) {
    const buckets = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0 }));
    for (let i = 0; i < pixels.length; i += 4) {
      const [h, s, l] = rgbToHsl(pixels[i], pixels[i + 1], pixels[i + 2]);
      const v = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) / 255;
      if (s < 0.25 || v < 0.2 || l > 0.92) continue;
      const w = s * v, b = buckets[Math.floor(h / 30) % 12];
      b.w += w; b.h += h * w; b.s += s * w;
    }
    const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
    return best.w > 0.5 ? [best.h / best.w, best.s / best.w] : null;
  }

  function extractAccent(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 32;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, 32, 32);
          resolve(pickAccent(g.getImageData(0, 0, 32, 32).data));
        } catch { resolve(null); } // canvas tainted: no CORS on this image host
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function applyAmbient() {
    const root = document.documentElement;
    if (!root || !designOn() || !usesAmbient()) return;
    const url = art.vid === state.videoId ? art.url : null;
    if (!url || url === ambient.url) return;
    ambient.url = url;
    const small = smallArt(url, art.vid);
    root.style.setProperty('--ao-art', `url("${small.replace(/"/g, '%22')}")`);
    extractAccent(small).then((hs) => {
      if (ambient.url !== url) return;
      if (!hs) { root.style.removeProperty('--ao-accent-dark'); root.style.removeProperty('--ao-accent-light'); return; }
      const h = Math.round(hs[0]), s = Math.round(Math.min(0.9, Math.max(0.55, hs[1])) * 100);
      root.style.setProperty('--ao-accent-dark', `hsl(${h} ${s}% 64%)`);   // readable on dark
      root.style.setProperty('--ao-accent-light', `hsl(${h} ${s}% 42%)`);  // readable on light
    });
  }

  const lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const isLight = () => config.theme === 'light' || (config.theme === 'auto' && Boolean(lightQuery?.matches));
  lightQuery?.addEventListener?.('change', () => setRootClasses());

  // Anything whose data points at the Premium page / upsell gets a hide marker (CSS hides it).
  const PREMIUM = /SPunlimited|music_premium|upsell|UNLIMITED/i;
  const PREMIUM_CANDIDATES = [
    'ytmusic-guide-entry-renderer',            // sidebar "Upgrade"
    'ytmusic-compact-link-renderer',           // account menu "Get Music Premium"
    'ytmusic-menu-navigation-item-renderer',
    'ytmusic-navigation-item-renderer',
    'ytmusic-mealbar-promo-renderer',
    'yt-mealbar-promo-renderer',
  ].join(',');
  const checked = new WeakMap(); // element -> data object it was checked against

  function hidePremium(root = document) {
    if (!designOn()) return;
    for (const el of root.querySelectorAll(PREMIUM_CANDIDATES)) {
      const data = el.data ?? el.__data?.data ?? null;
      if (!data || checked.get(el) === data) continue;
      checked.set(el, data);
      let json = '';
      try { json = nativeStringify(data); } catch { /* circular: skip */ }
      el.toggleAttribute('ytm-ao-hidden', PREMIUM.test(json));
    }
  }

  let popupObserved = null;
  function observePopups() {
    const popups = document.querySelector('ytmusic-popup-container');
    if (!popups || popupObserved === popups) return;
    popupObserved = popups;
    new MutationObserver(() => hidePremium(popups)).observe(popups, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // macOS "Now Playing" / media keys (Media Session API)
  // Gives the system the square cover, track position, and working
  // previous / next / seek controls, all driven through the page's own player.
  // ---------------------------------------------------------------------------
  const media = { key: null, handlers: false, lastPos: 0 };

  function clickPlayerBar(cls) {
    const el = document.querySelector(`ytmusic-player-bar ${cls}`);
    if (!el) return false;
    (el.querySelector('button') || el).click();
    return true;
  }

  function setMediaHandlers(player) {
    const ms = navigator.mediaSession;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported action */ } };
    on('previoustrack', () => { if (!clickPlayerBar('.previous-button')) player.previousVideo?.(); });
    on('nexttrack', () => { if (!clickPlayerBar('.next-button')) player.nextVideo?.(); });
    on('play', () => player.playVideo?.());
    on('pause', () => player.pauseVideo?.());
    on('seekto', (d) => { if (Number.isFinite(d?.seekTime)) player.seekTo?.(d.seekTime, true); });
    media.handlers = true;
  }

  /** "Artist • Album • 2020" (songs) or "Channel • 1.2M views • …" (videos). */
  function trackText() {
    const title = document.querySelector('ytmusic-player-bar .title')?.textContent?.trim() || '';
    const parts = (document.querySelector('ytmusic-player-bar .byline')?.textContent || '')
      .split('•').map((s) => s.trim()).filter(Boolean);
    const isSong = parts.length >= 3 && /^\d{4}$/.test(parts[parts.length - 1]);
    return { title, artist: parts[0] || '', album: isSong ? parts[1] : '', year: isSong ? parts[parts.length - 1] : '' };
  }

  function artworkFor(url) {
    if (!url) return [];
    const m = url.match(/=w(\d+)-h(\d+)/);
    const sizes = m ? `${m[1]}x${m[2]}` : undefined;
    // A 512px copy too: some systems pick the closest size.
    const small = m ? url.replace(/=w\d+-h\d+/, '=w512-h512') : null;
    return [small && { src: small, sizes: '512x512', type: 'image/jpeg' }, { src: url, sizes, type: 'image/jpeg' }]
      .filter(Boolean).map((a) => (a.sizes ? a : { src: a.src, type: a.type }));
  }

  function updateMediaSession(player, video) {
    const ms = navigator.mediaSession;
    if (!ms || typeof MediaMetadata === 'undefined' || !config.enabled || state.ad || !state.videoId) return;
    if (!media.handlers) setMediaHandlers(player);

    const info = trackText();
    const cover = art.vid === state.videoId ? art.url : null;
    if (info.title && cover) {
      const key = `${state.videoId}|${info.title}|${cover}`;
      // Re-apply if YouTube Music replaced the metadata (it uses the 16:9 video frame).
      const current = ms.metadata?.artwork?.[ms.metadata.artwork.length - 1]?.src;
      if (key !== media.key || current !== cover) {
        try {
          ms.metadata = new MediaMetadata({ title: info.title, artist: info.artist, album: info.album, artwork: artworkFor(cover) });
          media.key = key;
        } catch (e) { log('media metadata failed', e); }
      }
    }

    if (video) {
      try { ms.playbackState = video.paused ? 'paused' : 'playing'; } catch { /* ignore */ }
      const d = video.duration;
      const pos = video.currentTime;
      if (Number.isFinite(d) && d > 0 && pos <= d && Math.abs(pos - media.lastPos) >= 0.5) {
        media.lastPos = pos;
        try { ms.setPositionState?.({ duration: d, position: pos, playbackRate: video.playbackRate || 1 }); } catch { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // "Now playing" hero (design: nowplaying)
  // A big now-playing block at the top of Home / Explore / Library: the cover
  // sliding out of a spinning record, the title, controls and a progress bar.
  // It is our own element in <body> (YouTube's components are never touched):
  // it is positioned over the top of the page, and the page content is pushed
  // down by the same height with one CSS variable.
  // ---------------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    prev: 'M6 6h2v12H6zm3.5 6L18 6v12z',
    play: 'M8 5v14l11-7z',
    pause: 'M7 5h4v14H7zm6 0h4v14h-4z',
    next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
    like: 'M2 21h4V9H2zm20-11a2 2 0 00-2-2h-6.3l1-4.6V3a1.5 1.5 0 00-.4-1L13 1 6.6 7.4A2 2 0 006 9v10a2 2 0 002 2h9a2 2 0 001.8-1.2l3-7.1A2 2 0 0022 12z',
  };
  const HERO_PATHS = (path) => path === '/' || path === '/explore' || path.startsWith('/library');
  const es = /^es\b/i.test(document.documentElement?.lang || navigator.language || '');
  const T = es
    ? { eyebrow: 'Sonando ahora', prev: 'Anterior', next: 'Siguiente', play: 'Reproducir', pause: 'Pausar', like: 'Me gusta' }
    : { eyebrow: 'Now playing', prev: 'Previous', next: 'Next', play: 'Play', pause: 'Pause', like: 'Like' };

  const hero = { el: null, parts: null, visible: false, mode: null, height: 0, key: '', pageObserved: null };

  function el(tag, cls, parent) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (parent) parent.appendChild(node);
    return node;
  }

  function iconButton(name, label, cls, parent) {
    const b = el('button', `ao-btn ${cls || ''}`.trim(), parent);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    b.appendChild(svg);
    b._path = path;
    return b;
  }

  const fmtTime = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
  };

  function playerEl() { return document.getElementById('movie_player'); }

  function buildHero() {
    const root = el('section', '', null);
    root.id = 'ytm-ao-hero';
    root.setAttribute('aria-label', T.eyebrow);
    const disc = el('div', 'ao-disc', root);
    el('div', 'ao-vinyl', disc);
    el('div', 'ao-sleeve', disc);
    const meta = el('div', 'ao-meta', root);
    el('div', 'ao-eyebrow', meta).textContent = T.eyebrow;
    const title = el('div', 'ao-title', meta);
    const sub = el('div', 'ao-sub', meta);
    const ctrl = el('div', 'ao-ctrl', meta);
    const prev = iconButton('prev', T.prev, '', ctrl);
    const play = iconButton('pause', T.pause, 'ao-play', ctrl);
    const next = iconButton('next', T.next, '', ctrl);
    const like = iconButton('like', T.like, 'ao-like', ctrl);
    const bar = el('div', 'ao-bar', meta);
    bar.setAttribute('role', 'slider');
    bar.setAttribute('aria-label', 'Progress');
    bar.tabIndex = 0;
    const fill = el('div', 'ao-fill', bar);
    const times = el('div', 'ao-times', meta);
    const cur = el('span', '', times);
    const dur = el('span', '', times);

    prev.addEventListener('click', () => { if (!clickPlayerBar('.previous-button')) playerEl()?.previousVideo?.(); });
    next.addEventListener('click', () => { if (!clickPlayerBar('.next-button')) playerEl()?.nextVideo?.(); });
    play.addEventListener('click', () => {
      if (clickPlayerBar('#play-pause-button')) return;
      const v = playerEl()?.querySelector('video');
      if (v) (v.paused ? playerEl().playVideo?.() : playerEl().pauseVideo?.());
    });
    like.addEventListener('click', () => {
      const btn = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer button');
      btn?.click();
      setTimeout(updateHero, 250);
    });
    const seekFromEvent = (e) => {
      const v = playerEl()?.querySelector('video');
      if (!v || !Number.isFinite(v.duration)) return;
      const r = bar.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      playerEl()?.seekTo?.(frac * v.duration, true);
    };
    bar.addEventListener('click', seekFromEvent);
    bar.addEventListener('keydown', (e) => {
      const v = playerEl()?.querySelector('video');
      if (!v) return;
      const step = e.key === 'ArrowRight' ? 5 : e.key === 'ArrowLeft' ? -5 : 0;
      if (step) { e.preventDefault(); playerEl()?.seekTo?.(Math.max(0, v.currentTime + step), true); }
    });

    document.body.appendChild(root);
    hero.el = root;
    hero.parts = { title, sub, play, like, fill, bar, cur, dur };
  }

  /**
   * Where the hero goes, or null:
   *  - 'player': the full player page is open; the hero replaces the cover/video
   *    area on the left (the queue on the right stays YouTube's).
   *  - 'browse': top of Home / Explore / Library.
   */
  function heroWanted() {
    if (!designOn() || config.design !== 'nowplaying' || state.ad || !state.videoId) return null;
    const open = document.querySelector('ytmusic-player-page[player-ui-state="PLAYER_PAGE_OPEN"]');
    if (open) {
      const panel = open.querySelector('#main-panel');
      const r = panel?.getBoundingClientRect();
      return r && r.width > 280 && r.height > 280 ? { mode: 'player', panel, rect: r } : null;
    }
    if (!HERO_PATHS(location.pathname)) return null;
    // YouTube keeps earlier pages in the DOM, hidden: use the one actually on screen.
    for (const browse of document.querySelectorAll('ytmusic-browse-response')) {
      const r = browse.getBoundingClientRect();
      if (r.width > 300 && r.height > 0) return { mode: 'browse', browse, rect: r };
    }
    return null;
  }

  // What the user actually sees lined up: cards, chips, buttons and shelf headers.
  const COLUMN_ITEMS = 'ytmusic-two-row-item-renderer, ytmusic-navigation-button-renderer, '
    + 'ytmusic-chip-cloud-chip-renderer, ytmusic-responsive-list-item-renderer, '
    + 'ytmusic-carousel-shelf-basic-header-renderer, ytmusic-tastebuilder-shelf-renderer';
  const SHELF_HEADERS = 'ytmusic-carousel-shelf-basic-header-renderer';

  /** Most common value (within `tol` px) among numbers; null if none repeats. */
  function modeOf(values, tol = 6) {
    let best = null, bestCount = 1;
    for (const v of values) {
      const n = values.filter((o) => Math.abs(o - v) <= tol).length;
      if (n > bestCount || (n === bestCount && best !== null && v < best)) { best = v; bestCount = n; }
    }
    return best;
  }

  /**
   * Left/right edges of the content column, in page coordinates.
   * Left = the x where most rows start (the first card of every row, chips,
   * buttons and shelf titles share it). Measuring containers proved unreliable:
   * some are full-bleed (Explore), some narrower than the column (Library).
   */
  function contentEdges(browse, rect) {
    const guide = document.getElementById('guide-wrapper') || document.getElementById('guide');
    const g = guide?.getBoundingClientRect();
    const guideRight = g && g.width > 0 && g.right > 0 && g.right < innerWidth / 2 ? g.right : 0;

    const lefts = [];
    for (const el of browse.querySelectorAll(COLUMN_ITEMS)) {
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0 || b.left < guideRight || b.left > innerWidth * 0.6) continue;
      lefts.push(b.left);
      if (lefts.length >= 200) break;
    }
    let left = modeOf(lefts);
    if (left === null) {
      const cs = getComputedStyle(browse);
      left = rect.left + Math.max(parseFloat(cs.paddingLeft) || 0, 24);
    }
    left = Math.max(left, guideRight + 24);

    // Right: shelf headers span the column exactly (title … "Más" + arrows).
    const rights = [...browse.querySelectorAll(SHELF_HEADERS)]
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 300 && b.height > 0 && Math.abs(b.left - left) <= 12)
      .map((b) => b.right);
    let right = modeOf(rights, 6) ?? (rights.length ? Math.max(...rights) : null);
    // Fallback: the column is centred, so mirror the left margin.
    if (right === null) right = innerWidth - Math.max(24, left - guideRight);
    return { left: left + window.scrollX, width: Math.max(320, right - left) };
  }

  function setHeroVisible(on, mode = null) {
    hero.visible = on;
    hero.mode = on ? mode : null;
    const root = document.documentElement;
    root?.classList.toggle('ytm-ao-hero-on', on && mode === 'browse');
    root?.classList.toggle('ytm-ao-hero-player', on && mode === 'player');
    if (hero.el) {
      hero.el.hidden = !on;
      hero.el.classList.toggle('ao-player', mode === 'player');
      if (!on || mode !== 'player') hero.el.style.height = '';
    }
  }

  // The player page slides open/closed: follow it for the length of the animation.
  function watchPlayerPage() {
    const page = document.querySelector('ytmusic-player-page');
    if (!page || hero.pageObserved === page) return;
    hero.pageObserved = page;
    new MutationObserver(() => {
      try { updateHero(); } catch { /* next tick retries */ }
      const until = performance.now() + 800;
      const follow = () => {
        if (!hero.visible) return;
        positionHero();
        if (performance.now() < until) requestAnimationFrame(follow);
      };
      requestAnimationFrame(follow);
    }).observe(page, { attributes: true, attributeFilter: ['player-ui-state'] });
  }

  /** Text, cover, play state and liked state: cheap, safe to call every tick. */
  function updateHero() {
    watchPlayerPage();
    const want = heroWanted();
    if (!want) { if (hero.visible) setHeroVisible(false); return; }
    if (!hero.el) buildHero();
    const p = hero.parts;
    const info = trackText();
    const cover = art.vid === state.videoId ? art.url : null;
    const key = `${info.title}|${info.artist}|${info.year}|${cover}`;
    if (key !== hero.key) {
      hero.key = key;
      p.title.textContent = info.title;
      p.sub.textContent = [info.artist, info.year].filter(Boolean).join(' · ');
      if (cover) hero.el.style.setProperty('--ao-cover', `url("${cover.replace(/"/g, '%22')}")`);
      // 4:3 YouTube thumbnails carry black bars around a 16:9 frame: zoom past them.
      hero.el.dataset.shape = cover ? art.shape : 'square';
    }
    const v = playerEl()?.querySelector('video');
    const playing = Boolean(v && !v.paused && !v.ended);
    hero.el.classList.toggle('playing', playing);
    p.play._path.setAttribute('d', playing ? ICONS.pause : ICONS.play);
    p.play.setAttribute('aria-label', playing ? T.pause : T.play);
    p.play.title = playing ? T.pause : T.play;
    const liked = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer')?.getAttribute('like-status') === 'LIKE';
    p.like.classList.toggle('on', liked);
    p.like.setAttribute('aria-pressed', String(liked));
    updateHeroProgress();
    if (!hero.visible || hero.mode !== want.mode) setHeroVisible(true, want.mode);
    positionHero(want);
  }

  function updateHeroProgress() {
    if (!hero.el || !hero.visible) return;
    const v = playerEl()?.querySelector('video');
    const d = v?.duration, c = v?.currentTime;
    const frac = Number.isFinite(d) && d > 0 ? Math.min(1, c / d) : 0;
    hero.parts.fill.style.width = `${(frac * 100).toFixed(2)}%`;
    hero.parts.cur.textContent = fmtTime(c);
    hero.parts.dur.textContent = fmtTime(d);
    hero.parts.bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  }

  /**
   * Place the hero at the top of the page content (it scrolls with the page),
   * reserve its height in the page, and clip it under the top bar / above the
   * player bar so it never covers them.
   */
  function positionHero(want = heroWanted()) {
    if (!hero.el || !hero.visible || !want) return;
    if (want.mode !== hero.mode) { setHeroVisible(true, want.mode); }
    if (want.mode === 'player') {
      // Fixed over the player page's left panel (that page does not scroll).
      const r = want.rect, s = hero.el.style;
      s.left = `${Math.round(r.left)}px`;
      s.top = `${Math.round(r.top)}px`;
      s.width = `${Math.round(r.width)}px`;
      s.height = `${Math.round(r.height)}px`;
      s.setProperty('--ao-panel-h', `${Math.round(r.height)}px`);
      clipHero();
      return;
    }
    const { browse, rect } = want;
    const { left, width } = contentEdges(browse, rect);
    // The content area can start behind the fixed top bar: never place the hero there.
    const browseTop = rect.top + window.scrollY;
    const navH = document.getElementById('nav-bar-background')?.offsetHeight || 64;
    const top = Math.max(browseTop, navH) + 20;
    const s = hero.el.style;
    s.left = `${Math.round(left)}px`;
    s.top = `${Math.round(top)}px`;
    s.width = `${Math.round(width)}px`;
    const reserve = Math.round(top - browseTop + hero.el.offsetHeight + 28);
    if (reserve > 0 && Math.abs(reserve - hero.height) > 1) {
      hero.height = reserve;
      document.documentElement.style.setProperty('--ao-hero-h', `${reserve}px`);
    }
    clipHero();
  }

  function clipHero() {
    if (!hero.el || !hero.visible) return;
    const r = hero.el.getBoundingClientRect();
    const navBottom = document.getElementById('nav-bar-background')?.getBoundingClientRect().bottom ?? 64;
    const barTop = document.querySelector('ytmusic-player-bar')?.getBoundingClientRect().top ?? innerHeight;
    const topCut = Math.max(0, navBottom - r.top);
    const bottomCut = Math.max(0, r.bottom - barTop);
    hero.el.style.clipPath = topCut || bottomCut ? `inset(${topCut}px 0 ${bottomCut}px 0)` : '';
    // Menus and dialogs must stay on top: drop the hero behind the page while one is open.
    const popupOpen = [...document.querySelectorAll('ytmusic-popup-container tp-yt-iron-dropdown, tp-yt-paper-dialog')]
      .some((d) => { const b = d.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(d).display !== 'none'; });
    const drawer = document.querySelector('tp-yt-app-drawer#guide[opened]');
    const drawerOver = !!drawer && drawer.getBoundingClientRect().right > r.left + 4;
    hero.el.classList.toggle('under', popupOpen || drawerOver);
  }

  window.addEventListener('scroll', () => { if (hero.visible) requestAnimationFrame(clipHero); }, { passive: true });
  window.addEventListener('resize', () => { if (hero.visible) requestAnimationFrame(() => positionHero()); }, { passive: true });
  document.addEventListener('timeupdate', () => updateHeroProgress(), true);
  document.addEventListener('click', () => { if (hero.visible) setTimeout(clipHero, 60); }, true);

  function setRootClasses() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle('ytm-ao-on', config.enabled);
    root.classList.toggle('ytm-ao-style', config.enabled && config.restyle);
    root.classList.toggle('ytm-ao-clean', designOn());
    root.classList.toggle('ytm-ao-ambient', designOn() && usesAmbient());
    root.classList.toggle('ytm-ao-np', designOn() && config.design === 'nowplaying');
    root.classList.toggle('ytm-ao-light', designOn() && isLight());
    root.classList.toggle('ytm-ao-ad', state.ad);
  }

  function readAdState(player) {
    const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
    if (ad !== state.ad) {
      state.ad = ad;
      setRootClasses();
      syncAllow(true);
      sendStatus();
    }
  }

  /** React to ad start/end instantly instead of waiting for the next tick. */
  function observePlayer(player) {
    if (state.observedPlayer === player) return;
    state.observedPlayer = player;
    new MutationObserver(() => readAdState(player))
      .observe(player, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------------------------------------------------------------------------
  // 4. Main loop + SPA hooks
  // ---------------------------------------------------------------------------
  function tick() {
    state.ticks++;
    setRootClasses();
    const player = document.getElementById('movie_player');
    if (!player) { syncAllow(); try { hidePremium(); observePopups(); } catch { /* ignore */ } return; }
    observePlayer(player);
    readAdState(player);

    let vid = null;
    try { vid = typeof player.getVideoData === 'function' ? player.getVideoData()?.video_id : null; } catch { /* ignore */ }
    if (vid && vid !== state.videoId) onTrackChange(vid);

    syncAllow();
    watchPlayback(player); // first: playback recovery must never depend on cosmetics
    try { updateArt(player); applyAmbient(); } catch (e) { log('artwork update failed', e); }
    try { hidePremium(); observePopups(); } catch (e) { log('clean-up failed', e); }
    try { updateMediaSession(player, player.querySelector('video')); } catch (e) { log('media session failed', e); }
    try { updateHero(); } catch (e) { log('hero failed', e); }
    if (state.ticks % STATUS_EVERY_S === 0) sendStatus();
  }

  function safeTick() {
    try { tick(); } catch (e) { console.warn('[YTM Audio Saver] tick error', e); }
  }

  function applyConfig(c) {
    const next = sanitizeConfig(c);
    const levelLowered = next.level < config.level;
    config = next;
    writeJSON(LS, LS_CONFIG, config);
    if (levelLowered) SS.removeItem(SS_SESSION_LEVEL);
    syncAllow(true);
    safeTick();
    sendStatus();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== MSG_FROM_BRIDGE) return;
    switch (d.type) {
      case 'config':
        applyConfig(d.config);
        break;
      case 'hello':
        post('ready');
        syncAllow(true);
        sendStatus();
        break;
      case 'resetLearning':
        writeJSON(LS, LS_STRIKES, { strict: [], block: [] });
        SS.removeItem(SS_SESSION_LEVEL);
        SS.removeItem(SS_LAST_RELOAD);
        sendStatus();
        break;
      default:
        break;
    }
  });

  for (const evt of ['yt-navigate-finish', 'yt-page-data-updated']) {
    document.addEventListener(evt, safeTick, true);
  }
  // Media events bubble-less: capture phase on document catches every <video>.
  for (const evt of ['loadstart', 'loadeddata', 'emptied', 'playing']) {
    document.addEventListener(evt, safeTick, true);
  }

  setInterval(safeTick, TICK_MS);
  post('ready');
  syncAllow(true);

  // Test hook for the bundled Node test (absent in a real browser page).
  if (globalThis.__YTM_AO_TEST__) {
    globalThis.__YTM_AO_TEST__.api = {
      isErrorVisible,
      pickBestAudio, pickCheapestVideo, patchAny, trackInfo, LEVEL,
      getConfig: () => config, applyConfig, effectiveLevel, artCandidates, artShape, hidePremium, isLight, trackText, artworkFor, pickAccent, smallArt, updateHero, hero, fmtTime,
    };
  }
})();
