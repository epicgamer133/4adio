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
  S.shown = tr;
  S.shownSig = sig(tr);
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
      cover.src = tr.cover;
      cover.alt = `Cover art for ${tr.title}`;
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

function trackRow(tr, { featured = false, label = '' } = {}) {
  return el('div', { class: `track-row${featured ? ' featured' : ''}` }, [
    tr.cover ? el('img', { src: tr.cover, alt: '', loading: 'lazy' }) : el('span', { class: 'thumb' }),
    el('div', {}, [el('b', { text: tr.title }), el('span', { text: tr.artist || 'Unknown artist' })]),
    label ? el('time', { text: label }) : null,
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

  $('upNext').replaceChildren(next ? trackRow(next, { featured: true }) : el('p', { class: 'empty-note', text: 'Shuffle picks the next song when this one ends.' }));
  $('history').replaceChildren(
    ...(history.length
      ? history.slice(0, 12).map((h) =>
          trackRow(h, { label: new Date(h.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
        )
      : [el('p', { class: 'empty-note', text: 'Nothing yet. You are early.' })]),
  );
}

function tick() {
  measureLatency();
  const tr = heardTrack();
  if (sig(tr) !== S.shownSig) showTrack(tr);
  renderLists();
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
    applySettings(st.settings);
    $('listenerCount').textContent = st.listeners;
    tick();
  });
  es.addEventListener('time', (e) => addClockSample(Number(e.data)));
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
$('queueBtn').addEventListener('click', () => toggleDrawer());
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
  else if (e.key === 'Escape') toggleDrawer(false);
});
