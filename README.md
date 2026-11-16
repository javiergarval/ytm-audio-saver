# YTM Audio Saver (Firefox, YouTube Music free tier)

Audio-only YouTube Music on the free tier: blocks video stream downloads, keeps the best free
audio format, and shows an album-art player instead of the video. Works in Firefox 140+ and Firefox-based browsers such as Zen.

## How it works (3 layers)

| Layer | File | What it does |
|---|---|---|
| Format rewrite | `content-main.js` (page world, runs before YouTube's scripts) | Hooks `JSON.parse`, `Response.json`, XHR and `ytInitialPlayerResponse`. Every player response is cut down to the **best audio format** (251 Opus > 140 AAC > …, default language, no "stable volume" variant), plus **0 or 1 tiny video format** depending on the mode. |
| Network block | `background.js` | Cancels `googlevideo.com/videoplayback?…mime=video/…` requests coming from music.youtube.com tabs. Audio requests are never touched. |
| UI | `content.css` + `content-main.js` | Hides `#song-video`, shows `#song-image` filled with the sharpest artwork available. **Album-art player** (on by default, switch in popup → Advanced): centered art with rounded corners over a blurred copy of itself. Nothing is hidden during ads, so "Skip" stays clickable. |

### Design (popup → Advanced)
- **Ambient** (default): the window takes the colors of the song playing. A huge blurred
  copy of the cover fills the background, the accent color is picked from the artwork,
  and the top bar, player bar and queue float above it as frosted glass.
- **Clean**: calm, flat and simple.
- **Off**: YouTube Music's original look.
- Ambient and Clean both remove the Premium "Upgrade" entry and upsells, hint bubbles and
  the "new recommendations" chip, and follow macOS light/dark (or force Dark/Light).
- **Album-art player**: the square album cover, sharp, instead of the video.
- **Now Playing**: cover, title, position and previous/next in the macOS menu bar.

### Self-healing modes
Some player builds stall when video is missing, so the extension learns which mode works:

1. **Strict**: audio-only format list + video blocked. 0 video bytes.
2. **Block**: 1 tiny (144p H.264) video format kept, but its requests are blocked. 0 video bytes.
3. **Minimal**: tiny video format downloaded. Always works (a few tens of kbps).

A watchdog checks playback every second. If a track is "playing" but stuck for 8 s,
it steps down for that track, and recovers with a reload at most once per minute.
A mode is only demoted **permanently** after failures on 2 different tracks with no
good track in between. The toolbar popup shows the active mode, the chosen audio
itag/bitrate, the number of blocked requests, and a "Reset to Strict" button.

During ads, video is allowed and shown: ads are not touched.

## Install (once)

1. Open the [latest release](https://github.com/javiergarval/ytm-audio-saver/releases/latest) in Firefox or Zen.
2. Click the `.xpi` file → **Add**.

That's the only manual step. From then on the browser updates the extension by itself
(it checks about once a day; to force it: `about:addons` → gear → **Check for Updates**).

## How updates are published (automatic)

`extension/` is the extension. Pushing a change with a new `"version"` in
`extension/manifest.json` triggers `.github/workflows/release.yml`, which:

1. signs it with Mozilla (unlisted / self-distributed) using the repo secrets
   `AMO_API_KEY` and `AMO_API_SECRET`,
2. publishes the signed `.xpi` as a GitHub Release,
3. rewrites `updates.json`, the file the extension's `update_url` points to.

Pushing without bumping the version publishes nothing. This repo must stay public and keep
its name: installed copies only know this `update_url`.

## Check that it works
1. Open music.youtube.com, play a song that has a music video.
2. Click the toolbar icon: it should say **Audio only** with e.g. `Opus · 135 kbps`.
   Under *Advanced*, "Blocked" counts cancelled video requests. In Strict mode it
   normally stays at 0, because the player never asks for video at all.
3. Optional: DevTools → Network → filter `videoplayback`. Audio requests
   (`mime=audio`) succeed; video requests show as blocked.

## Limits (honest list)
- Free accounts top out around 128 kbps (251 Opus / 140 AAC). 256 kbps formats are Premium-only.
- If YouTube Music switches its web player to **SABR** (one request carrying
  audio + video, as regular YouTube already does), network blocking can no longer
  separate them. The popup then shows "SABR", and only the tiny-video rewrite still
  applies. Nothing breaks.
- DOM selectors (`ytmusic-player`, `#song-video`, `#song-image`, `#movie_player`)
  come from YouTube's current markup. If YouTube renames them, fix the selectors in
  `content.css` and `updateArt()`.
