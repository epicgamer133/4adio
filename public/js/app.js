import { Visualizer } from './visualizer.js';
import { extractPalette, paletteFromAccent } from './palette.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const body = document.body;

const LINK_LABELS = {
  spotify: 'Spotify', appleMusic: 'Apple Music', youtube: 'YouTube', soundcloud: 'SoundCloud',
  bandcamp: 'Bandcamp', tidal: 'TIDAL', deezer: 'Deezer', other: 'More',
};
const SOCIAL_LABELS = {
  instagram: 'Instagram', x: 'X', tiktok: 'TikTok', youtube: 'YouTube', spotify: 'Spotify',
  soundcloud: 'SoundCloud', facebook: 'Facebook', twitch: 'Twitch', discord: 'Discord', website: 'Website',
};
const GENERIC_ICONS = {
  website: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
  other: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

// --- tiny DOM helper (data is always set via textContent, never innerHTML) ---
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

function brandIcon(key, label) {
  if (GENERIC_ICONS[key]) {
    const span = el('span');
    span.innerHTML = GENERIC_ICONS[key]; // static markup, not user data
    return span.firstChild;
  }
  const img = el('img', { src: `/icons/${key}.svg`, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: 'mono', text: label[0] })));
  return img;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// --- state ---------------------------------------------------------------------
const S = {
  server: null,
  samples: [],
  offset: 0, // serverClock - localClock (ms)
  lat: 0, // seconds between the live edge and what this listener hears
  want: false,
  shown: null,
  shownSig: '',
  listKey: '',
  settings: null,
  bgUrl: null,
  accentPalette: paletteFromAccent('#8b5cf6'),
  retry: 0,
  retryTimer: null,
  connectedAt: 0,
  connectServer: 0, // server clock (ms) when the current stream connection began
  eventsOnline: false,
  lastTime: 0,
  stuckFor: 0,
  flatFor: 0,
};

const serverNow = () => Date.now() + S.offset;

function addClockSample(serverTime) {
  // One-way network delay only ever makes a sample too small, so the max of
  // recent samples is the best estimate of the true offset.
  S.samples.push(serverTime - Date.now());
  if (S.samples.length > 12) S.samples.shift();
  S.offset = Math.max(...S.samples);
}

// --- visualizer -----------------------------------------------------------------
const viz = new Visualizer($('viz'));
viz.onLevels = (L) => {
  root.style.setProperty('--bass', L.bass.toFixed(3));
  root.style.setProperty('--beat', L.beat.toFixed(3));
};
viz.setPalette(S.accentPalette);
viz.start();

function updateFocus() {
  const r = $('art').getBoundingClientRect();
  viz.setFocus(r.left + r.width / 2, r.top + r.height / 2, r.width / 2);
}
new ResizeObserver(updateFocus).observe($('art'));
addEventListener('resize', updateFocus);

// Artwork protection: no right-click menu or dragging on covers and thumbnails.
// (The rest of the page keeps its normal right-click menu.)
for (const ev of ['contextmenu', 'dragstart']) {
  document.addEventListener(ev, (e) => {
    if (e.target.closest?.('#art, .thumb')) e.preventDefault();
  });
}

// --- 3D album cover: tilts toward the pointer (mouse or finger) ---------------------
const MAX_TILT = 16; // degrees
let tiltFrame = 0;
function tiltTo(e) {
  const art = $('art');
  const r = art.getBoundingClientRect();
  const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const py = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  cancelAnimationFrame(tiltFrame);
  tiltFrame = requestAnimationFrame(() => {
    art.classList.add('tilting');
    art.style.setProperty('--ry', `${((px - 0.5) * 2 * MAX_TILT).toFixed(2)}deg`);
    art.style.setProperty('--rx', `${((0.5 - py) * 2 * MAX_TILT).toFixed(2)}deg`);
    art.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
    art.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
    art.style.setProperty('--lift', '1');
  });
}
function untilt() {
  cancelAnimationFrame(tiltFrame);
  const art = $('art');
  art.classList.remove('tilting'); // slower transition back to rest
  for (const [k, v] of [['--rx', '0deg'], ['--ry', '0deg'], ['--gx', '50%'], ['--gy', '50%'], ['--lift', '0']]) {
    art.style.setProperty(k, v);
  }
}
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
  $('art').addEventListener('pointermove', tiltTo);
  $('art').addEventListener('pointerdown', tiltTo);
  for (const ev of ['pointerleave', 'pointerup', 'pointercancel']) $('art').addEventListener(ev, untilt);
}

// The station has one signature look: Warp. (People who ask their OS for
// reduced motion get the calm Minimal mode instead.)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
viz.setMode(reducedMotion ? 'minimal' : 'warp');

// --- audio ------------------------------------------------------------------------
let audio = $('audio');
let actx = null;
let analyser = null;
let gain = null;
let webAudioOk = Boolean(window.AudioContext || window.webkitAudioContext);
const flatBuf = new Uint8Array(2048);

function ensureGraph() {
  if (actx || !webAudioOk) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    gain = actx.createGain();
    actx.createMediaElementSource(audio).connect(analyser);
    analyser.connect(gain);
    gain.connect(actx.destination);
    viz.setAnalyser(analyser);
    applyVolume();
  } catch (err) {
    console.warn('Web Audio unavailable, visualizer will idle:', err);
    webAudioOk = false;
  }
}

/** Some browsers output silence when a live stream is routed through Web Audio. Fall back to a plain element. */
function dropWebAudio() {
  console.warn('Live stream not reaching Web Audio; falling back to direct playback.');
  webAudioOk = false;
  viz.live = false;
  try { actx?.close(); } catch { /* ignore */ }
  actx = analyser = gain = null;
  const fresh = el('audio', { preload: 'none' });
  audio.replaceWith(fresh);
  audio = fresh;
  bindAudioEvents();
  applyVolume();
  connectStream();
}

function applyVolume() {
  const v = Number($('volume').value);
  if (gain) {
    gain.gain.value = v * v; // perceptual curve
    audio.volume = 1;
  } else {
    audio.volume = v * v;
  }
  body.classList.toggle('muted', v === 0);
  body.classList.toggle('vol-low', v > 0 && v < 0.45);
  const pct = Math.round(v * 100);
  $('volumeCtl').style.setProperty('--vol', `${pct}%`);
  $('volume').setAttribute('aria-valuetext', `${pct}%`);
  $('volume').title = `Volume ${pct}%`;
  $('muteBtn').setAttribute('aria-label', v === 0 ? 'Unmute' : 'Mute');
}

function setVolume(v) {
  $('volume').value = String(Math.min(1, Math.max(0, Math.round(v * 100) / 100)));
  applyVolume();
  store.set('radio.volume', $('volume').value);
}

// Mute remembers the level it came from, so unmuting restores it.
let volumeBeforeMute = 0.8;
function toggleMute() {
  const v = Number($('volume').value);
  if (v > 0) {
    volumeBeforeMute = v;
    setVolume(0);
  } else {
    setVolume(volumeBeforeMute || 0.8);
  }
}

function connectStream() {
  clearTimeout(S.retryTimer);
  body.classList.add('loading');
  S.connectedAt = performance.now();
  // The stream starts with a burst of the last few seconds, so its first
  // byte is (server time at connect - burst). See streamDelay().
  S.connectServer = serverNow();
  S.lat = S.server?.burstSeconds ?? 2;
  S.stuckFor = 0;
  S.flatFor = 0;
  audio.src = `/stream?_=${Date.now()}`;
  audio.play().catch((err) => {
    if (err.name === 'NotAllowedError') {
      stopListening();
      $('tuneIn').classList.remove('gone');
    }
  });
}

function startListening() {
  S.want = true;
  ensureGraph();
  actx?.resume();
  $('tuneIn').classList.add('gone');
  connectStream();
}

function stopListening() {
  S.want = false;
  clearTimeout(S.retryTimer);
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  viz.live = false;
  body.classList.remove('playing', 'loading');
  $('playBtn').setAttribute('aria-label', 'Tune in');
}

function scheduleReconnect() {
  if (!S.want) return;
  clearTimeout(S.retryTimer);
  const delay = Math.min(15000, 1000 * 2 ** S.retry++);
  body.classList.add('loading');
  if (S.retry > 1) toast('Connection lost. Reconnecting...');
  S.retryTimer = setTimeout(connectStream, delay);
}

function bindAudioEvents() {
  audio.addEventListener('playing', () => {
    body.classList.add('playing');
    body.classList.remove('loading');
    $('playBtn').setAttribute('aria-label', 'Stop');
    viz.live = Boolean(analyser);
    S.retry = 0;
  });
  audio.addEventListener('waiting', () => S.want && body.classList.add('loading'));
  audio.addEventListener('error', () => S.want && audio.getAttribute('src') && scheduleReconnect());
  audio.addEventListener('ended', scheduleReconnect);
  audio.addEventListener('pause', () => {
    // Paused by the OS (headphones unplugged, media keys): treat as stop.
    // Ignore the pause some browsers fire while we swap in a fresh stream URL.
    if (performance.now() - S.connectedAt < 1500) return;
    if (S.want && audio.getAttribute('src')) stopListening();
  });
}
bindAudioEvents();

$('playBtn').addEventListener('click', () => (S.want ? stopListening() : startListening()));
$('tuneInBtn').addEventListener('click', startListening);
$('volume').value = store.get('radio.volume') ?? '0.8';
$('volume').addEventListener('input', () => {
  applyVolume();
  store.set('radio.volume', $('volume').value);
});
$('muteBtn').addEventListener('click', toggleMute);
// Scroll over the volume control to nudge it 5% at a time.
$('volumeCtl').addEventListener('wheel', (e) => {
  e.preventDefault();
  setVolume(Number($('volume').value) + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });
applyVolume();

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', startListening);
  navigator.mediaSession.setActionHandler('pause', stopListening);
  navigator.mediaSession.setActionHandler('stop', stopListening);
}

// Watchdog: keeps every listener close to live and recovers dead connections.
setInterval(() => {
  if (!S.want || audio.paused) return;
  const t = audio.currentTime;
  S.stuckFor = t === S.lastTime ? S.stuckFor + 1 : 0;
  S.lastTime = t;
  if (S.stuckFor >= 10) return scheduleReconnect();
  // Small drift shows the "Jump to live" prompt (see renderSync). Only a huge
  // gap, like a phone waking from sleep, resyncs without asking.
  if (S.lat > 60) {
    toast('Caught up to live');
    return connectStream();
  }
  if (analyser && S.server?.now) {
    const sinceConnect = (performance.now() - S.connectedAt) / 1000;
    analyser.getByteTimeDomainData(flatBuf);
    const flat = flatBuf.every((v) => v === 128);
    S.flatFor = flat && t > 0 ? S.flatFor + 1 : 0;
    if (S.flatFor >= 8 && sinceConnect < 25) dropWebAudio();
  }
}, 1000);

// --- now playing ----------------------------------------------------------------------
/**
 * Seconds between the live edge and what this listener hears. Measured
 * against the server clock, so it also catches slow networks and stalls
 * (a buffer-size estimate would miss those).
 */
function streamDelay() {
  if (!S.want || !audio.getAttribute('src') || !S.connectServer) return null;
  const burst = S.server?.burstSeconds ?? 2;
  return Math.max(0, (serverNow() - S.connectServer) / 1000 + burst - audio.currentTime);
}

function measureLatency() {
  const target = streamDelay() ?? 0;
  // Smooth small jitter, but follow real jumps (a stall) right away.
  S.lat = Math.abs(target - S.lat) > 1 ? target : S.lat + (target - S.lat) * 0.25;
}

// --- live / sync indicator -------------------------------------------------------------
const SYNC_SLACK = 3; // seconds past normal buffering before we call it "behind"

function syncState() {
  if (!S.eventsOnline) return 'offline';
  if (!S.server?.now) return 'offair';
  if (!S.want) return 'live';
  const behind = S.lat - (S.server.burstSeconds ?? 2);
  // Before audio actually starts, the gap is just the connection time.
  const started = body.classList.contains('playing') && audio.currentTime > 0;
  if (started && behind > SYNC_SLACK) return 'behind';
  if (!started || body.classList.contains('loading')) return 'connecting';
  return 'synced';
}

const SYNC_LABELS = {
  offline: 'Offline',
  offair: 'Off air',
  live: 'Live',
  synced: 'Live · Synced',
  connecting: 'Connecting',
};

function renderSync() {
  const state = syncState();
  const behindBy = Math.round(S.lat - (S.server?.burstSeconds ?? 2));
  const pill = $('livePill');
  pill.dataset.state = state;
  $('liveText').textContent = state === 'behind' ? `Behind ${behindBy}s` : SYNC_LABELS[state];
  pill.title =
    state === 'behind' ? 'You are behind the live stream. Click to jump to live.'
    : state === 'synced' ? 'You are hearing the same moment as everyone else.'
    : state === 'offline' ? 'Lost connection to the station. Reconnecting...'
    : state === 'offair' ? 'Nothing is playing right now.'
    : '';
  pill.disabled = state !== 'behind';
  $('resync').hidden = state !== 'behind';
  $('reminder').classList.toggle('yield', state === 'behind');
  if (state === 'behind') $('behindBy').textContent = `${behindBy}s`;
}

function resync() {
  if (!S.want) return startListening();
  toast('Jumped to live', 1400);
  connectStream();
}
$('livePill').addEventListener('click', resync);
$('resyncBtn').addEventListener('click', resync);

/** The track this listener is actually hearing right now (accounts for their buffer). */
function heardTrack() {
  const st = S.server;
  if (!st?.now) return null;
  const t = serverNow() - S.lat * 1000;
  const list = [st.now, ...st.history];
  return list.find((tr) => tr.startedAt <= t) || st.now;
}

const sig = (tr) => (tr ? [tr.playId, tr.title, tr.artist, tr.album, tr.cover, JSON.stringify(tr.links)].join('|') : '');

function swapText(node, text) {
  if (node.textContent === text) return;
  node.textContent = text;
  node.classList.remove('swap');
  void node.offsetWidth;
  node.classList.add('swap');
}

function setPalette(pal) {
  viz.setPalette(pal);
  const css = (c) => `rgb(${c.map((v) => v | 0).join(',')})`;
  root.style.setProperty('--accent', css(pal[0]));
  root.style.setProperty('--accent-2', css(pal[1]));
}

function showTrack(tr) {
  const changedTrack = tr?.playId !== S.shown?.playId;
  const firstShow = !S.shown;
  S.shown = tr;
  S.shownSig = sig(tr);
  // Heads-up when one of your favorites comes on (not on first load).
  if (changedTrack && !firstShow && tr && S.want && isFav(tr.id)) toast(`One of your favorites is on: ${tr.title}`, 3500);
  const stationName = S.settings?.stationName || 'Radio';

  if (!tr) {
    swapText($('title'), 'Off air');
    swapText($('artist'), 'Waiting for the first track');
    $('album').textContent = '';
    $('cover').hidden = true;
    $('artEmpty').hidden = false;
    $('coverWash').style.backgroundImage = '';
    $('links').replaceChildren();
    setPalette(S.accentPalette);
    document.title = stationName;
    return;
  }

  swapText($('title'), tr.title);
  swapText($('artist'), tr.artist || 'Unknown artist');
  $('album').textContent = tr.album || '';
  document.title = `${tr.title}${tr.artist ? ` - ${tr.artist}` : ''} | ${stationName}`;

  if (tr.cover) {
    const img = new Image();
    img.onload = () => {
      if (S.shown?.cover !== tr.cover) return;
      const cover = $('cover');
      cover.style.backgroundImage = `url("${tr.cover}")`;
      cover.setAttribute('aria-label', `Cover art for ${tr.title}`);
      cover.hidden = false;
      if (changedTrack) {
        cover.style.animation = 'none';
        void cover.offsetWidth;
        cover.style.animation = '';
      }
      $('artEmpty').hidden = true;
      $('coverWash').style.backgroundImage = `url("${tr.cover}")`;
      try {
        setPalette(extractPalette(img) || S.accentPalette);
      } catch {
        setPalette(S.accentPalette);
      }
    };
    img.src = tr.cover;
  } else {
    $('cover').hidden = true;
    $('artEmpty').hidden = false;
    $('coverWash').style.backgroundImage = '';
    setPalette(S.accentPalette);
  }

  $('links').replaceChildren(
    ...Object.entries(tr.links || {}).map(([key, url]) =>
      el('a', { class: 'link-chip', href: url, target: '_blank', rel: 'noopener noreferrer' }, [
        brandIcon(key, LINK_LABELS[key] || key),
        el('span', { text: LINK_LABELS[key] || 'Link' }),
      ]),
    ),
  );

  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: tr.title,
      artist: tr.artist || '',
      album: tr.album || stationName,
      artwork: tr.cover ? [{ src: new URL(tr.cover, location.href).href, sizes: '800x800', type: 'image/jpeg' }] : [],
    });
  }
}

/** Thumbnail as a background, not an <img>, so it can't be saved or dragged. */
function thumbEl(src) {
  const t = el('span', { class: 'thumb', 'aria-hidden': 'true' });
  if (src) t.style.backgroundImage = `url("${src}")`;
  return t;
}

function trackRow(tr, { featured = false, label = '', tag = null } = {}) {
  return el('div', { class: `track-row${featured ? ' featured' : ''}` }, [
    thumbEl(tr.cover),
    el('div', {}, [el('b', { text: tr.title }, tag), el('span', { text: tr.artist || 'Unknown artist' })]),
    label ? el('time', { text: label }) : null,
    starButton(tr),
  ]);
}

function renderLists() {
  const st = S.server;
  if (!st) return;
  const shown = S.shown;
  // While a listener's buffer is still finishing the previous song, the
  // server's "now" is still that listener's "next".
  const next = shown && st.now && shown.playId !== st.now.playId ? st.now : st.next;
  const history = shown ? st.history.filter((h) => h.startedAt < shown.startedAt) : st.history;
  const key = [next?.playId || next?.id, sig(next), history.map((h) => h.playId).join()].join('#');
  if (key === S.listKey) return;
  S.listKey = key;

  $('upNext').replaceChildren(
    next
      ? trackRow(next, { featured: true, tag: isFav(next.id) ? el('span', { class: 'up-tag', text: 'FAVORITE' }) : null })
      : el('p', { class: 'empty-note', text: 'Shuffle picks the next song when this one ends.' }),
  );
  $('history').replaceChildren(
    ...(history.length
      ? history.slice(0, 12).map((h) =>
          trackRow(h, { label: new Date(h.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
        )
      : [el('p', { class: 'empty-note', text: 'Nothing yet. You are early.' })]),
  );
}

// --- favorites (private: saved in this browser only, never sent anywhere) --------------------
const FAV_KEY = 'radio.favorites';
const STAR_PATH = 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z';
// A small snapshot is kept with each favorite so the list shows instantly
// (and still makes sense if a song is later removed from the station).
let favorites = loadFavorites(); // [{ id, savedAt, title, artist, cover, links }]
const favGone = new Set(); // ids no longer on the station
let favKey = '';

function loadFavorites() {
  try {
    const v = JSON.parse(store.get(FAV_KEY) || '[]');
    return Array.isArray(v) ? v.filter((f) => f && typeof f.id === 'string') : [];
  } catch {
    return [];
  }
}
const saveFavorites = () => store.set(FAV_KEY, JSON.stringify(favorites));
const isFav = (id) => favorites.some((f) => f.id === id);

function starSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', STAR_PATH);
  svg.append(p);
  return svg;
}

function starButton(tr) {
  const saved = isFav(tr.id);
  const b = el('button', {
    class: 'row-star',
    'aria-pressed': String(saved),
    'aria-label': saved ? `Remove ${tr.title} from favorites` : `Save ${tr.title} to favorites`,
    title: saved ? 'Remove from favorites' : 'Save to favorites',
  }, starSvg());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFav(tr, b);
  });
  return b;
}

function popStar(btn) {
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
}

function toggleFav(tr, fromBtn) {
  if (!tr) return;
  if (isFav(tr.id)) {
    favorites = favorites.filter((f) => f.id !== tr.id);
    toast('Removed from your favorites', 1400);
  } else {
    favorites.unshift({ id: tr.id, savedAt: Date.now(), title: tr.title, artist: tr.artist, cover: tr.cover, links: tr.links || {} });
    favGone.delete(tr.id);
    toast(`Saved "${tr.title}" to your favorites`, 1600);
    if (fromBtn) popStar(fromBtn);
  }
  saveFavorites();
  S.listKey = '';
  leaderKey = '';
  favKey = '';
  renderFavButton(S.shown);
  renderFavorites();
}
$('favBtn').addEventListener('click', () => toggleFav(S.shown, $('favBtn')));

function renderFavButton(tr) {
  const btn = $('favBtn');
  const saved = Boolean(tr && isFav(tr.id));
  btn.disabled = !tr;
  btn.setAttribute('aria-pressed', String(saved));
  btn.setAttribute('aria-label', saved ? 'Remove from favorites' : 'Save to favorites');
  btn.title = saved ? 'In your favorites (S to remove)' : 'Save to your favorites (S)';
}

/** Refresh titles/artwork/links from the station (they may have been edited). */
async function refreshFavorites() {
  if (favorites.length) {
    try {
      const ids = favorites.map((f) => f.id).join(',');
      const list = await (await fetch(`/api/tracks?ids=${encodeURIComponent(ids)}`)).json();
      const found = new Map(list.map((t) => [t.id, t]));
      for (const f of favorites) {
        const t = found.get(f.id);
        if (t) {
          Object.assign(f, { title: t.title, artist: t.artist, cover: t.cover, links: t.links || {} });
          favGone.delete(f.id);
        } else {
          favGone.add(f.id);
        }
      }
      saveFavorites();
    } catch {
      /* offline: keep the saved snapshot */
    }
  }
  favKey = '';
  renderFavorites();
}

function renderFavorites() {
  const nextId = S.server?.next?.id;
  const key = JSON.stringify(favorites.map((f) => [f.id, f.title, f.artist, f.cover, favGone.has(f.id)])) + (S.shown?.id || '') + (nextId || '');
  if (key === favKey) return;
  favKey = key;
  if (!favorites.length) {
    $('favList').replaceChildren(el('p', { class: 'empty-note', text: 'Tap the star next to a song to save it here. Favorites stay on this device.' }));
    return;
  }
  $('favList').replaceChildren(
    ...favorites.map((f) => {
      const gone = favGone.has(f.id);
      const tag = gone ? null
        : S.shown?.id === f.id ? el('span', { class: 'on-air-tag', text: 'ON AIR' })
        : nextId === f.id ? el('span', { class: 'up-tag', text: 'UP NEXT' })
        : null;
      const links = Object.entries(f.links || {}).map(([k, url]) =>
        el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', title: `Listen on ${LINK_LABELS[k] || k}`, 'aria-label': `${f.title} on ${LINK_LABELS[k] || k}` }, brandIcon(k, LINK_LABELS[k] || k)),
      );
      return el('div', { class: `track-row${gone ? ' gone' : ''}` }, [
        thumbEl(f.cover),
        el('div', {}, [
          el('b', { text: f.title }, tag),
          el('span', { text: gone ? 'No longer on the station' : f.artist || 'Unknown artist' }),
        ]),
        starButton(f),
        el('div', { class: 'fav-links' }, links),
      ]);
    }),
  );
}

// --- likes, hearts & hype trains (TikTok LIVE style) ---------------------------------------
// Tap as much as you like. Taps are batched to the server; every listener sees
// everyone's hearts, and when a song's like goal is reached during its play,
// everyone gets a hype train at the same moment.
const HEART_PATH = 'M12 20.5s-7.5-4.6-9.3-9.4C1.6 8.2 3.4 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.6 0 5.4 3.7 4.3 6.6-1.8 4.8-9.3 9.4-9.3 9.4z';
const SVG_NS = 'http://www.w3.org/2000/svg';
const HEART_COLORS = ['#ff4d7d', '#ff2d6a', '#ff7a45', '#ffb340', '#ffd23f', '#c86bff', '#ff5ec4', '#5fd4ff'];
const MAX_HEARTS = 90; // cap on-screen hearts so spam never bogs the page down

// Counts only ever go up, so the display keeps the highest value seen:
// optimistic taps + server totals never make the number jump backwards.
const totals = new Map(); // trackId -> all-time likes
const plays = new Map(); // playId -> { count, level, goal, prevGoal }
const tapQueue = new Map(); // "trackId|playId" -> { trackId, playId, taps }
let tapTimer = null;
let ownEcho = 0; // our taps that will come back in the shared 'likes' stream
let leaderKey = '';
let heartsOnScreen = 0;

const totalFor = (tr) => Math.max(totals.get(tr.id) || 0, tr.likes || 0);
function playFor(tr) {
  if (!tr?.playId) return null;
  const a = plays.get(tr.playId);
  const b = tr.hype;
  if (!a) return b || null;
  if (!b) return a;
  return a.count >= b.count ? a : b;
}
function bumpTotal(trackId, value) {
  totals.set(trackId, Math.max(totals.get(trackId) || 0, value));
}
function bumpPlay(playId, info) {
  if (!playId || !info) return;
  const cur = plays.get(playId);
  if (!cur || info.count >= cur.count || info.level > cur.level) plays.set(playId, info);
}

/** Server state carries counts too; fold them in. */
function absorbLikeState(st) {
  for (const t of [st.now, st.next, ...(st.history || []), ...(st.leaderboard || [])]) {
    if (!t) continue;
    bumpTotal(t.id, t.likes || 0);
    if (t.playId && t.hype) bumpPlay(t.playId, t.hype);
  }
}

function heartSvg(cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', HEART_PATH);
  svg.append(p);
  return svg;
}

/** One heart floating up from (x, y). */
function floatHeart(x, y, { rise = -(160 + Math.random() * 140), size = 18 + Math.random() * 16, dur = 1.4 + Math.random() * 0.9, parent = document.body } = {}) {
  if (reducedMotion || heartsOnScreen >= MAX_HEARTS) return;
  heartsOnScreen++;
  const h = heartSvg('float-heart');
  h.style.left = `${x}px`;
  h.style.top = `${y}px`;
  h.style.setProperty('--size', `${size.toFixed(0)}px`);
  h.style.setProperty('--c', HEART_COLORS[(Math.random() * HEART_COLORS.length) | 0]);
  h.style.setProperty('--rise', `${rise.toFixed(0)}px`);
  h.style.setProperty('--sway', `${((Math.random() - 0.5) * 70).toFixed(0)}px`);
  h.style.setProperty('--rot', `${((Math.random() - 0.5) * 50).toFixed(0)}deg`);
  h.style.setProperty('--dur', `${dur.toFixed(2)}s`);
  parent.append(h);
  setTimeout(() => {
    h.remove();
    heartsOnScreen--;
  }, dur * 1000 + 100);
}

function heartsFrom(el, n = 1) {
  const r = el.getBoundingClientRect();
  for (let i = 0; i < n; i++) {
    setTimeout(() => floatHeart(r.left + r.width / 2 + (Math.random() - 0.5) * 16, r.top + r.height / 2), i * 60);
  }
}

/** Everyone else's likes drift up the right edge, like a live stream. */
function laneHearts(n) {
  const count = Math.min(n, 14);
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      const x = innerWidth - 50 - Math.random() * 70;
      floatHeart(x, innerHeight - 110, { rise: -(innerHeight * (0.35 + Math.random() * 0.25)), parent: $('heartLane') });
    }, i * (350 / count) + Math.random() * 60);
  }
}

function popLikeButton() {
  const b = $('likeBtn');
  b.classList.remove('pop');
  void b.offsetWidth;
  b.classList.add('pop');
}

/** Register one tap on a track (and its live play, if it's the one playing). */
function tap(tr, { playId = tr?.playId || '' } = {}) {
  if (!tr) return;
  const key = `${tr.id}|${playId}`;
  const q = tapQueue.get(key) || { trackId: tr.id, playId, taps: 0 };
  q.taps++;
  tapQueue.set(key, q);
  bumpTotal(tr.id, totalFor(tr) + 1);
  const p = playId && playFor({ ...tr, playId });
  if (p) bumpPlay(playId, { ...p, count: p.count + 1 });
  if (!tapTimer) tapTimer = setTimeout(sendTaps, 300);
  leaderKey = '';
  renderLike(S.shown);
}

async function sendTaps() {
  tapTimer = null;
  const batches = [...tapQueue.values()];
  tapQueue.clear();
  for (const b of batches) {
    ownEcho += b.taps;
    try {
      const res = await fetch('/api/like', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'radio' },
        body: JSON.stringify(b),
      });
      const d = await res.json();
      const dropped = b.taps - (d.added ?? 0);
      if (dropped > 0) {
        // Over the speed limit: take the uncounted taps back off the display.
        ownEcho = Math.max(0, ownEcho - dropped);
        totals.set(b.trackId, Math.max(d.total ?? 0, (totals.get(b.trackId) || 0) - dropped));
        const p = plays.get(b.playId);
        if (p) plays.set(b.playId, { ...p, count: Math.max(0, p.count - dropped) });
      } else if (d.total != null) {
        bumpTotal(b.trackId, d.total);
      }
    } catch {
      ownEcho = Math.max(0, ownEcho - b.taps);
    }
  }
  leaderKey = '';
  renderLike(S.shown);
}

function likeCurrent(fromEl) {
  if (!S.shown) return;
  tap(S.shown);
  heartsFrom(fromEl || $('likeBtn'), 1 + (Math.random() < 0.35 ? 1 : 0));
  popLikeButton();
}

// Hold the heart to keep liking; a quick tap likes once.
let holdTimer = null;
function stopHold() {
  clearTimeout(holdTimer);
  clearInterval(holdTimer);
  holdTimer = null;
  $('likeBtn').classList.remove('holding');
}
$('likeBtn').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !S.shown) return;
  e.preventDefault();
  likeCurrent();
  stopHold();
  holdTimer = setTimeout(() => {
    $('likeBtn').classList.add('holding');
    holdTimer = setInterval(() => likeCurrent(), 110);
  }, 350);
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('likeBtn').addEventListener(ev, stopHold);
// Keyboard Enter/Space on the button (pointer clicks are handled by pointerdown).
$('likeBtn').addEventListener('click', (e) => e.detail === 0 && likeCurrent());

// Tap the cover twice quickly to like; keep tapping fast to keep liking.
let lastArtTap = 0;
$('art').addEventListener('pointerup', (e) => {
  const now = performance.now();
  if (now - lastArtTap < 340 && S.shown) {
    tap(S.shown);
    floatHeart(e.clientX, e.clientY, { size: 30 + Math.random() * 20, rise: -(120 + Math.random() * 80) });
    popLikeButton();
  }
  lastArtTap = now;
});

function renderLike(tr) {
  const btn = $('likeBtn');
  btn.disabled = !tr;
  $('likeCount').textContent = tr ? totalFor(tr).toLocaleString() : '0';
  btn.setAttribute('aria-label', tr ? `Like ${tr.title} (${totalFor(tr)} likes)` : 'Like this song');

  const p = playFor(tr);
  $('hypeGoal').hidden = !p;
  if (!p) return;
  const span = Math.max(1, p.goal - p.prevGoal);
  const pct = Math.min(100, Math.max(0, ((p.count - p.prevGoal) / span) * 100));
  $('hypeFill').style.width = `${pct}%`;
  $('hypeNums').textContent = `${p.count.toLocaleString()} / ${p.goal.toLocaleString()}`;
  $('hypeLevel').textContent = p.level ? `Hype train Lv ${p.level}` : 'Like goal';
  $('hypeLevel').classList.toggle('on', p.level > 0);
  $('hypeGoal').classList.toggle('close', pct >= 80);
}

// --- the hype train ---------------------------------------------------------------------------
const hypeQueue = [];
let hypeRunning = false;

function onHype(h) {
  // Celebrate goals on the song this listener is hearing (or the one just starting).
  if (h.playId !== S.shown?.playId && h.playId !== S.server?.now?.playId) return;
  hypeQueue.push(h);
  if (!hypeRunning) nextHype();
}

function nextHype() {
  const h = hypeQueue.shift();
  if (!h) {
    hypeRunning = false;
    return;
  }
  hypeRunning = true;
  runHypeTrain(h);
  setTimeout(nextHype, reducedMotion ? 1500 : 2600);
}

function runHypeTrain(h) {
  const stage = $('hypeStage');
  $('hypeAnnounce').textContent = `Hype train level ${h.level}! ${h.goal} likes on ${h.title}.`;
  const ride = Math.max(3.4, 4.6 - h.level * 0.15); // higher levels ride faster
  const y = `${22 + Math.random() * 12}%`;

  const flash = el('div', { class: 'hype-flash' });
  const burst = el('div', { class: 'hype-level-burst', text: `LV ${h.level}` });
  const trail = el('div', { class: 'hype-trail' });
  trail.style.setProperty('--y', y);
  trail.style.setProperty('--ride', `${ride}s`);

  const heartIcon = () => heartSvg();
  const cars = [
    el('div', { class: 'hype-car loco' }, [heartIcon(), el('span', { text: 'Hype train' })]),
    el('div', { class: 'hype-car' }, [el('small', { text: 'Level' }), el('span', { text: String(h.level) })]),
    el('div', { class: 'hype-car' }, [heartIcon(), el('span', { text: h.goal.toLocaleString() }), el('small', { text: 'likes' })]),
    el('div', { class: 'hype-car title' }, el('span', { text: h.artist ? `${h.title} · ${h.artist}` : h.title })),
  ];
  // Bigger trains for bigger levels.
  for (let i = 0; i < Math.min(4, h.level - 1); i++) cars.push(el('div', { class: 'hype-car' }, heartIcon()));
  const train = el('div', { class: 'hype-train' }, cars.reverse()); // engine leads on the right
  train.style.setProperty('--y', y);
  train.style.setProperty('--ride', `${ride}s`);

  stage.append(flash, trail, train, burst);
  setTimeout(() => [flash, trail, train, burst].forEach((n) => n.remove()), ride * 1000 + 200);

  viz.hype(ride - 0.6);
  $('hypeGoal').classList.remove('close');
  // Heart rain rising across the whole screen.
  const rain = Math.min(60, 26 + h.level * 6);
  for (let i = 0; i < rain; i++) {
    setTimeout(() => floatHeart(Math.random() * innerWidth, innerHeight + 20, {
      rise: -(innerHeight * (0.6 + Math.random() * 0.5)),
      size: 16 + Math.random() * 26,
      dur: 1.8 + Math.random() * 1.2,
      parent: stage,
    }), Math.random() * 1400);
  }
}

// --- leaderboard ----------------------------------------------------------------------------
function renderLeaderboard() {
  const list = [...(S.server?.leaderboard || [])].sort((a, b) => totalFor(b) - totalFor(a));
  const key = JSON.stringify(list.map((t) => [t.id, totalFor(t), t.cover, t.title, t.artist, isFav(t.id)])) + (S.shown?.id || '');
  if (key === leaderKey) return;
  leaderKey = key;
  if (!list.length) {
    $('leaderboard').replaceChildren(el('p', { class: 'empty-note', text: "No likes yet. Spam the heart on a song you love and it'll show up here." }));
    return;
  }
  $('leaderboard').replaceChildren(
    ...list.map((t, i) => {
      const btn = el('button', { class: 'mini-like', 'aria-label': `Like ${t.title}, ${totalFor(t)} likes` }, [
        heartSvg(),
        el('span', { text: totalFor(t).toLocaleString() }),
      ]);
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // The song on air also feeds its live like goal.
        const live = S.shown?.id === t.id ? S.shown : t;
        tap(live, { playId: live.playId || '' });
        heartsFrom(btn, 1);
      });
      const onAir = S.shown?.id === t.id;
      return el('div', { class: `track-row${onAir ? ' on-air' : ''}` }, [
        el('span', { class: 'rank', text: String(i + 1) }),
        thumbEl(t.cover),
        el('div', {}, [
          el('b', { text: t.title }, onAir ? el('span', { class: 'on-air-tag', text: 'ON AIR' }) : null),
          el('span', { text: t.artist || 'Unknown artist' }),
        ]),
        starButton(t),
        btn,
      ]);
    }),
  );
}

function tick() {
  measureLatency();
  const tr = heardTrack();
  if (sig(tr) !== S.shownSig) showTrack(tr);
  renderLists();
  renderLeaderboard();
  renderLike(tr);
  renderFavButton(tr);
  renderFavorites();
  renderSync();
  if (tr) {
    const elapsed = Math.min(tr.duration, Math.max(0, (serverNow() - S.lat * 1000 - tr.startedAt) / 1000));
    $('progressFill').style.width = `${(elapsed / tr.duration) * 100}%`;
    $('elapsed').textContent = fmt(elapsed);
    $('duration').textContent = fmt(tr.duration);
  } else {
    $('progressFill').style.width = '0';
    $('elapsed').textContent = $('duration').textContent = '0:00';
  }
}
setInterval(tick, 250);

// --- station settings -------------------------------------------------------------------
function renderSocials(container, socials) {
  container.replaceChildren(
    ...Object.entries(socials || {}).map(([key, url]) =>
      el('a', { class: 'social', href: url, target: '_blank', rel: 'noopener noreferrer', title: SOCIAL_LABELS[key] || key, 'aria-label': SOCIAL_LABELS[key] || key }, [
        brandIcon(key, SOCIAL_LABELS[key] || key),
      ]),
    ),
  );
}

function applySettings(s) {
  const prev = S.settings;
  S.settings = s;
  if (JSON.stringify(prev) === JSON.stringify(s)) return;

  $('stationName').textContent = s.stationName;
  $('tagline').textContent = s.tagline || '';
  renderSocials($('socials'), s.socials);
  renderSocials($('drawerSocials'), s.socials);
  $('drawerFollow').hidden = !Object.keys(s.socials || {}).length;
  S.accentPalette = paletteFromAccent(s.accent || '#8b5cf6');
  if (!S.shown?.cover) setPalette(S.accentPalette);
  root.style.setProperty('--bg-opacity', String(s.backgroundOpacity ?? 0.35));

  const bgUrl = s.background?.url || null;
  if (bgUrl !== S.bgUrl) {
    S.bgUrl = bgUrl;
    const holder = $('bgMedia');
    if (!bgUrl) holder.replaceChildren();
    else if (s.background.type === 'video') {
      const v = el('video', { src: bgUrl, autoplay: '', loop: '', playsinline: '', 'aria-hidden': 'true' });
      v.muted = true;
      holder.replaceChildren(v);
      v.play().catch(() => {});
    } else {
      holder.replaceChildren(el('img', { src: bgUrl, alt: '' }));
    }
  }
  S.shownSig = ''; // re-render title with new station name
}

// --- community reminder -----------------------------------------------------------------------
// A small corner card nudging listeners toward the station's Discord / socials.
// Shows once per visit after some listening time; dismissing it snoozes it.
const REMINDER_KEY = 'radio.reminder';
let reminderShown = false;
let listenedSec = 0;

function reminderSnoozed() {
  try {
    return (JSON.parse(store.get(REMINDER_KEY) || 'null')?.until || 0) > Date.now();
  } catch {
    return false;
  }
}

function hideReminder(snoozeDays) {
  store.set(REMINDER_KEY, JSON.stringify({ until: Date.now() + snoozeDays * 86_400_000 }));
  const card = $('reminder');
  card.classList.add('leaving');
  setTimeout(() => (card.hidden = true), 350);
}

function showReminder() {
  const r = S.settings.reminder;
  const socials = S.settings.socials || {};
  // Lead with Discord when there is one; otherwise the first social link.
  const key = socials.discord ? 'discord' : Object.keys(socials)[0];
  const label = SOCIAL_LABELS[key] || key;
  const branded = key === 'discord';

  const icon = $('reminderIcon');
  icon.className = `reminder-icon${branded ? '' : ' generic'}`;
  icon.replaceChildren(brandIcon(key, label));
  $('reminderTitle').textContent = r.title;
  $('reminderText').textContent = r.message;
  $('reminderText').hidden = !r.message;
  const cta = $('reminderCta');
  cta.href = socials[key];
  cta.className = `reminder-cta${branded ? '' : ' generic'}`;
  cta.textContent = branded ? 'Join the Discord' : key === 'website' ? 'Visit the website' : `Follow on ${label}`;
  renderSocials($('reminderSocials'), Object.fromEntries(Object.entries(socials).filter(([k]) => k !== key).slice(0, 5)));

  const card = $('reminder');
  card.classList.remove('leaving');
  card.hidden = false;
  reminderShown = true;
}

$('reminderClose').addEventListener('click', () => hideReminder(3));
$('reminderCta').addEventListener('click', () => hideReminder(30));

setInterval(() => {
  const r = S.settings?.reminder;
  if (reminderShown || !r?.enabled || !Object.keys(S.settings.socials || {}).length || reminderSnoozed()) return;
  if (body.classList.contains('playing')) listenedSec++;
  // Wait for a calm moment: not while the sync prompt or the queue drawer is open.
  if (listenedSec >= r.delaySec && $('resync').hidden && $('drawer').hidden) showReminder();
}, 1000);

// --- live events ----------------------------------------------------------------------------
function connectEvents() {
  const es = new EventSource('/events');
  es.addEventListener('state', (e) => {
    const st = JSON.parse(e.data);
    addClockSample(st.serverTime);
    S.server = st;
    absorbLikeState(st);
    applySettings(st.settings);
    $('listenerCount').textContent = st.listeners;
    tick();
  });
  es.addEventListener('time', (e) => addClockSample(Number(e.data)));
  // Live like stream: counts, goal progress, and hearts from everyone else.
  es.addEventListener('likes', (e) => {
    let others = 0;
    for (const item of JSON.parse(e.data)) {
      bumpTotal(item.trackId, item.total);
      if (item.playId && item.play) bumpPlay(item.playId, item.play);
      // Our own taps come back in this stream too; only show other people's.
      const mine = Math.min(ownEcho, item.delta);
      ownEcho -= mine;
      others += item.delta - mine;
    }
    if (others > 0) laneHearts(others);
    leaderKey = '';
    renderLike(S.shown);
  });
  es.addEventListener('hype', (e) => onHype(JSON.parse(e.data)));
  // EventSource reconnects by itself; we only track whether it's connected.
  es.addEventListener('open', () => (S.eventsOnline = true));
  es.addEventListener('error', () => (S.eventsOnline = es.readyState === EventSource.OPEN));
}
connectEvents();

// --- drawer, fullscreen, keys ------------------------------------------------------------------
function toggleDrawer(open = $('drawer').hidden) {
  $('drawer').hidden = !open;
  $('queueBtn').setAttribute('aria-expanded', String(open));
}

const DRAWER_TABS = { queue: ['tabQueue', 'panelQueue'], top: ['tabTop', 'panelTop'], fav: ['tabFav', 'panelFav'] };
function showDrawerTab(tab) {
  for (const [name, [tabId, panelId]] of Object.entries(DRAWER_TABS)) {
    $(tabId).setAttribute('aria-selected', String(name === tab));
    $(panelId).hidden = name !== tab;
  }
  if (tab === 'fav') refreshFavorites();
}
for (const [name, [tabId]] of Object.entries(DRAWER_TABS)) $(tabId).addEventListener('click', () => showDrawerTab(name));

// The dock buttons open the panel on their tab; pressing one again closes it.
function openDrawerOn(tab) {
  const onIt = !$('drawer').hidden && $(DRAWER_TABS[tab][0]).getAttribute('aria-selected') === 'true';
  showDrawerTab(tab);
  toggleDrawer(!onIt);
}
$('queueBtn').addEventListener('click', () => openDrawerOn('queue'));
$('leaderBtn').addEventListener('click', () => openDrawerOn('top'));
$('drawerClose').addEventListener('click', () => toggleDrawer(false));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
if (!document.documentElement.requestFullscreen) $('fullscreenBtn').hidden = true;

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space' || e.key === 'k') {
    e.preventDefault();
    if (!$('tuneIn').classList.contains('gone')) startListening();
    else S.want ? stopListening() : startListening();
  } else if (e.key === 'f') toggleFullscreen();
  else if (e.key === 'm') toggleMute();
  // Holding L auto-repeats, which spams likes, which is the point.
  else if (e.key === 'l') likeCurrent();
  else if (e.key === 's' && !e.repeat && S.shown) toggleFav(S.shown, $('favBtn'));
  else if (e.key === 'Escape') toggleDrawer(false);
});
