# Project notes: vision, status, and design decisions

> **Status: experimental (started October 2026).**
> The design and functionality are both still being explored. Nothing here is final:
> the look, the feature set, and even parts of the architecture may change. Treat this as a
> working prototype that has been tested locally, not a finished product. Read this file
> before making changes, so new work builds on the reasoning below instead of starting over.

---

## 1. The idea

A simple **internet radio** website. People open the page, press play, and hear whatever is on
air, together with everyone else.

What the owner asked for:

| Want | Meaning |
|---|---|
| Join by listening | No accounts. Open the page, tune in. |
| Add music manually | The owner uploads songs through a private admin page. |
| Backend stays private | Listeners must not be able to download the music files from the web server. |
| Rotation | The station pulls from the library in a randomized order and plays continuously. |
| Synced | When someone joins, they hear the same moment as everyone else. Not "start from the beginning". |
| Visualizers | Background visuals, generated and/or custom. |
| Modern UI | Cover art, song title, and artist front and center. |
| Extras | Station socials, per-song links so people can find the songs elsewhere, listener count, up next / recently played, and admin controls for requests and skipping. |

### History

An earlier version was built with a lower-quality AI model. This project is a **clean rebuild of
the same concept** with a stronger architecture. Nothing from the old code was carried over, by choice.

It is **standalone**: separate from the 4TUNAT website, and meant to run on its own subdomain
(e.g. `radio.yourdomain.com`). It can be embedded into 4TUNAT later with an iframe.

---

## 2. How the idea is executed (the core decisions)

### Decision 1: a true live broadcast, not a playlist player
The server *is* the radio station. It reads songs, splits them into MP3 frames, and pushes those
frames to every connected listener at exactly real-time speed, around the clock, whether or not
anyone is listening.

**Why:** this one decision delivers three of the requirements at once.
- **Sync is automatic.** Everyone receives the same bytes at the same moment. No client-side clock tricks.
- **Privacy.** The browser only ever sees `/stream`, one endless feed with no file URLs. Files
  live in `data/audio/`, which is never served over HTTP.
- **Continuous play.** The station never stops between listeners.

**Rejected alternative:** serving song files with a shared "start time" so each browser seeks to
the right spot. It's simpler, but it exposes file URLs (easy to download) and drifts between devices.

**Honest limit, agreed up front:** nothing a browser can play is immune to someone recording their own
audio output. The goal is to stop downloading and scraping, not recording.

### Decision 2: normalize every upload
On upload, ffmpeg converts every song to the same format: CBR MP3, 44.1 kHz stereo, a configurable
bitrate (default 192k), loudness-normalized to -14 LUFS, with all tags stripped. Identical frames
make the stream seamless between tracks. Duration is calculated from the actual frames, so progress
bars are exact.

### Decision 3: a fair shuffle
The shuffle uses a bag model: every song plays once before any repeats, and the same song never plays
twice in a row. New uploads join the current cycle. Admin requests go into a queue that plays before the shuffle.

### Decision 4: now-playing timing per listener
Track changes are pushed over Server-Sent Events (`/events`) with server timestamps. Each page
estimates its clock offset from the server and measures its own buffer delay, so the cover and title
switch at the moment *that listener* hears the new song.

A new listener first gets a 2-second burst of recent audio, so playback starts instantly. If a listener
falls more than 8 seconds behind, the page reconnects to live.

### Decision 5: one visualizer, Warp, driven by the real audio
Web Audio's AnalyserNode reads the stream; the stream is same-origin, so there are no CORS issues. Star
speed and brightness follow the music's energy and bass hits. Colors are pulled from the current cover
art and also re-theme the UI accent.

**Owner's choice (2026-10-11): Warp is the station's single signature style.** The listener-facing
visualizer switcher and the admin "default visualizer" setting were removed. Listeners whose OS asks
for reduced motion get the calm Minimal mode. The other modes (Nebula, Spectrum, Halo, Waves) still
exist in `public/js/visualizer.js`, unused, in case the owner wants to revisit them.

**Custom background (planned use):** the owner wants to add their own background later. This is
already supported: admin → Station → Custom background accepts an image or a video (converted to a
muted looping MP4), plus a visibility slider. Warp draws its streaks over it with transparent trails,
and the streaks are tinted toward white so they stay visible on bright or similarly colored
backgrounds. Tested with a sample image; the slot was left empty for the owner's own background.

There is a fallback for browsers that output silence when a live stream goes through Web Audio:
the page detects it and switches to direct playback.

### Decision 6: keep the host server safe
The app listens on `127.0.0.1:8090` only and is reached through a new reverse-proxy block. Existing
sites are never touched. There are two deployment options: Docker (most isolated, ffmpeg in the container)
or Node + a sandboxed systemd service. Proxies must not buffer `/stream` or `/events`.

### Decision 7: show listeners whether they're live and in sync
The top-right badge shows the real state. Red **Live** = the station is on air. Green **Live · Synced**
= you hear the same moment as everyone. Amber **Connecting** / **Behind 12s** = you need attention.
Grey **Off air** / **Offline** = nothing to hear, or the server can't be reached.

"Behind" is measured against the server clock, not the buffer size: the stream's first byte is
(server time at connect − 2 s burst), so the delay is `serverNow − connectTime + burst − audio.currentTime`.
That catches stalls and slow networks too. More than 3 s past normal shows a **Jump to live** bar
(the badge is clickable too), which reconnects at the live edge. Only a gap over 60 s
(e.g. a phone waking from sleep) resyncs without asking. Owner's request, 2026-10-12.

### Decision 8: 3D album cover
The cover tilts toward the mouse or finger (up to 16°) with a moving glossy reflection, a dark slab
behind it for sleeve thickness, and a shadow that falls away from the raised edge. It eases back to
flat when the pointer leaves, and is off for reduced-motion users. Owner's request, 2026-10-12.

### Decision 9: albums group songs and share artwork
Albums are stored next to tracks in `library.json` (`albums: [{id, title, artist, coverFile}]`, with
`albumId` on each track). Songs join an album in three ways: picked at upload ("Put new uploads in"),
matched automatically from the album tag in the file (the album is created if missing), or moved later
(Edit dialog, or tick several songs and use the bulk "Move to" bar). Deleting an album keeps its songs, ungrouped.

Artwork priority for what listeners see: **artwork uploaded for that one song > album artwork > cover
embedded in the file.** An album without artwork adopts the first embedded cover it gets. The Edit
dialog's Artwork section says which source is in use and can reset a song to its album's artwork.
Owner's request, 2026-10-12.

### Decision 10: a gentle community reminder
A small card in the bottom-left corner invites listeners to the Discord (or the first social link
when there's no Discord), with the other socials as small icons. Kept deliberately non-invasive:
- it appears only after N seconds of actual listening (default 45), once per visit
- it never covers the player; on narrower screens it moves above the dock, and it steps aside while the "behind live" bar shows
- closing it snoozes it for 3 days; clicking Join snoozes it for 30 (stored in the listener's browser)
- it only appears if at least one social link is set
Heading, message, delay and on/off are editable in admin → Station. Owner's request, 2026-10-12.

### Decision 11: make artwork hard to grab
Same honest limit as the audio: a screenshot always works. What's blocked:
- The cover and thumbnails are CSS backgrounds, not `<img>`, so there's no "Save image as…"; right-click,
  dragging and iOS long-press are disabled over artwork only (the rest of the page is normal).
- `/cover/*` and `/bg/*` refuse requests with `Sec-Fetch-Dest: document` (URL opened in a tab) or
  `Sec-Fetch-Site: cross-site` (another site hotlinking). `Vary: Sec-Fetch-Dest, Sec-Fetch-Site` stops
  browsers answering "open in new tab" from the cached copy the page loaded.
- Artwork URLs use random ids, so they can't be guessed. Owner's request, 2026-10-12.

### Decision 12: TikTok LIVE style likes, like goals and hype trains
(Replaced the first "one heart per listener" version the same day, at the owner's request.)
- **Tap as much as you want.** Every tap is a like, and there's no un-like. Hold the heart to auto-repeat,
  tap the cover twice quickly (and keep tapping), or hold `L`. Each tap floats a randomly colored
  heart up from where you tapped. Everyone sees everyone else's taps as hearts drifting up the right edge
  (`likes` SSE event, batched about 3 times a second; the page subtracts its own taps so it only shows others').
- **Like goals per play:** each time a song starts, its goals reset: 20, 50, 100, 200, 400, 700, 1000,
  then about 1.5x each. A goal bar under the heart shows progress. Reaching a goal fires a `hype` SSE
  event to everyone at once: a "HYPE TRAIN" of cars sweeps across the screen (longer trains at higher
  levels), with a "LV n" burst, a heart rain, a pink flash, and Warp at hyperspeed with pink/gold streaks.
  Several levels at once play back to back. Reduced-motion users get the announcement without the motion.
- **Totals** (all time, per song) drive the "Most liked" leaderboard, which you can also tap-spam from.
- **Abuse control is a speed limit, not a cap:** token buckets per listener (anonymous HttpOnly `rs_lid`
  cookie: ~12 taps/s, bursts to 40) and per network (IP: ~36/s, bursts to 120). Fast human tapping always
  counts, and a script can't inflate counts beyond that pace (tested: 360 instant taps, 41 counted).
  `POST /api/like` takes batches `{trackId, playId, taps}` and requires `X-Requested-With: radio`.
- Stored in `data/likes.json` as `{ totals: { trackId: n } }`. Per-play goal progress lives in memory only.
- **Deployment gotcha:** the per-network limit needs the real visitor IP, so `TRUST_PROXY` must match your
  reverse proxy (`loopback` for nginx/Apache on the same machine; Docker uses `loopback,uniquelocal`).
  If it's wrong, all listeners share one bucket and likes are capped at ~36/s station-wide.
- Goal numbers are `HYPE_GOALS` in `server/likes.js`; tune them to the audience size.

### Stack (deliberately small)
- Node.js 20+ with express, multer, and simple-icons (brand icons served locally). ffmpeg/ffprobe for media.
- No database: `data/library.json` and `data/settings.json`, written atomically.
- Plain HTML/CSS/JS front end with ES modules and no build step, so experimenting is fast.

---

## 3. Current state

**Built and tested locally (Windows PC, 2026-10-11):**
- **Uploads:** convert correctly; tags and embedded covers are read automatically.
- **Admin auth:** works, with a password, an HttpOnly session cookie, a CSRF header guard, and login rate limiting.
- **Stream:** runs at exactly real time and is valid 192k MP3.
- **Private paths:** all return 404 (audio, library, `.env`, server code).
- **Listener page:** cover theming, visualizers, listener count, track changes, up next and history.

**Not yet tested:**
- iPhone/Safari behavior (the Web Audio fallback has not been tested on a real device).
- Many simultaneous listeners.
- A real production deploy behind nginx/Apache with HTTPS.

**Known rough edges / ideas under consideration:**
- The design is a first pass. Layout, typography, and the visualizer look are open to change.
- Custom backgrounds are station-wide; a per-song background was considered but not built.
- Live chat was offered and deliberately left out of v1.
- Admin sessions live in memory, so a server restart logs the admin out.
- Static files are served with `Cache-Control: no-cache`, so browsers check for updates on every load.
  (Earlier they were cached for 1 hour, which broke Tune in after the Warp-only update: a new page
  plus an old cached script crashed on startup.)
- Opening `public/index.html` directly from disk (`file://`) never works. Always use http://127.0.0.1:8090.
- Google Fonts are loaded from Google; self-hosting the font would be more private.

---

## 4. Where things are

```
server/broadcaster.js  the station: real-time frame pacing, shuffle bag, queue, listeners
server/mp3.js          MP3 frame parser + silent frame (used when the library is empty)
server/media.js        ffmpeg/ffprobe: transcode, covers, background video, upload queue
server/library.js      library + settings storage, input cleaning, public views of data
server/auth.js         admin login/session/rate limit
server/index.js        routes, security headers, SSE, admin API
public/js/app.js       listener page: playback, sync timing, UI, reconnects
public/js/visualizer.js  visualizer (Warp in use; other modes kept but unused)
public/js/palette.js   cover-art color extraction
views/admin.html + public/admin-assets/   admin panel
deploy/                nginx, Apache, systemd configs
start-local.bat        double-click to run locally on Windows
```

**Local dev:** `start-local.bat`, then http://127.0.0.1:8090 (radio) and `/admin`.
The `.env` file (admin password, ffmpeg paths) and `data/` (songs) are **gitignored on purpose**.
Never commit them.

**Workflow:** build and experiment locally → push to GitHub (`epicgamer133/4adio`) → pull onto the
web server later and follow the README deploy steps.
