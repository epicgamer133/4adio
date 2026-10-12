import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { ROOT, config, paths } from './config.js';
import { library, newId, LINK_KEYS, SOCIAL_KEYS } from './library.js';
import { station } from './broadcaster.js';
import { enqueueUpload, makeJpeg, makeBackgroundVideo, probe, checkFfmpeg } from './media.js';
import { login, logout, isAdmin, requireAdmin } from './auth.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

// --- security headers --------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      `frame-ancestors ${config.frameAncestors}`,
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// --- public: listener page, stream, now-playing events -----------------------
// no-cache = the browser must check for a newer version every load (a cheap
// 304 when nothing changed). Without it, after an update a browser can mix
// new HTML with an old cached script, and the page breaks.
app.use(express.static(config.publicDir, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('/stream', (req, res) => station.addListener(req, res));

const sseClients = new Set();
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.write(`retry: 3000\n\nevent: state\ndata: ${JSON.stringify(station.publicState())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcastState() {
  const msg = `event: state\ndata: ${JSON.stringify(station.publicState())}\n\n`;
  for (const res of sseClients) res.write(msg);
}
station.on('update', broadcastState);
library.on('settings', broadcastState);
// Heartbeat doubles as a clock-sync sample for clients.
setInterval(() => {
  const msg = `event: time\ndata: ${Date.now()}\n\n`;
  for (const res of sseClients) res.write(msg);
}, 10_000);

app.get('/api/state', (req, res) => res.json(station.publicState()));

const SAFE_FILE = /^[a-z0-9]+\.(jpg|mp4)$/;
app.get('/cover/:file', (req, res) => {
  if (!SAFE_FILE.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(paths.covers, req.params.file), { maxAge: '30d', immutable: true }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});
app.get('/bg/:file', (req, res) => {
  if (!SAFE_FILE.test(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(paths.backgrounds, req.params.file), { maxAge: '30d', immutable: true }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Brand icons served from the installed simple-icons package (no CDN, no tracking).
const ICON_SLUGS = {
  spotify: 'spotify', appleMusic: 'applemusic', youtube: 'youtube', soundcloud: 'soundcloud',
  bandcamp: 'bandcamp', tidal: 'tidal', deezer: 'deezer', instagram: 'instagram', x: 'x',
  tiktok: 'tiktok', facebook: 'facebook', twitch: 'twitch', discord: 'discord',
};
let iconsDir = path.join(ROOT, 'node_modules', 'simple-icons', 'icons');
if (!fs.existsSync(iconsDir)) {
  iconsDir = null;
  console.warn('[icons] simple-icons not installed; social links will use text badges.');
}
app.get('/icons/:key.svg', (req, res) => {
  const slug = ICON_SLUGS[req.params.key];
  if (!slug || !iconsDir) return res.sendStatus(404);
  res.type('image/svg+xml');
  res.sendFile(path.join(iconsDir, `${slug}.svg`), { maxAge: '30d' }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// --- admin --------------------------------------------------------------------
// The admin page lives outside public/ so it is only reachable at ADMIN_PATH.
// (Its script and styles are in public/admin-assets; they hold no secrets.)
app.get(config.adminPath, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(ROOT, 'views', 'admin.html'));
});

const admin = express.Router();
admin.use(express.json({ limit: '64kb' }));

admin.post('/login', (req, res) => {
  if (req.get('X-Requested-With') !== 'radio-admin') return res.status(403).json({ error: 'Forbidden' });
  login(req, res);
});
admin.post('/logout', logout);
admin.get('/session', (req, res) => res.json({ loggedIn: isAdmin(req), linkKeys: LINK_KEYS, socialKeys: SOCIAL_KEYS }));

admin.use(requireAdmin);

const upload = multer({
  storage: multer.diskStorage({
    destination: paths.tmp,
    filename: (req, file, cb) => cb(null, `${newId()}.upload`),
  }),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 2 },
});

const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|oga|opus|aiff?|wma|alac|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv)$/i;

function cleanupFiles(req) {
  for (const list of Object.values(req.files || {})) for (const f of list) fs.rm(f.path, { force: true }, () => {});
  if (req.file) fs.rm(req.file.path, { force: true }, () => {});
}

// Browsers send UTF-8 file names but multer decodes them as latin1.
function fixName(name) {
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('�') ? name : decoded;
}

function parseJsonField(value) {
  try {
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}

admin.get('/status', (req, res) => res.json(station.adminState()));

admin.get('/tracks', (req, res) => {
  res.json(
    library.tracks.map((t) => ({
      ...library.publicTrack(t),
      enabled: t.enabled,
      status: t.status,
      error: t.error,
      plays: t.plays || 0,
      addedAt: t.addedAt,
      lastPlayedAt: t.lastPlayedAt || null,
      originalName: t.originalName,
    })),
  );
});

admin.post('/tracks', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]), (req, res) => {
  const audio = req.files?.audio?.[0];
  const cover = req.files?.cover?.[0];
  if (!audio || !AUDIO_EXT.test(audio.originalname)) {
    cleanupFiles(req);
    return res.status(400).json({ error: 'Upload an audio file (mp3, wav, flac, m4a, ogg, opus, aiff...).' });
  }
  if (cover && !IMAGE_EXT.test(cover.originalname)) {
    cleanupFiles(req);
    return res.status(400).json({ error: 'Cover must be an image.' });
  }
  const track = enqueueUpload({
    tmpPath: audio.path,
    originalName: fixName(audio.originalname),
    coverTmpPath: cover?.path || null,
    meta: {
      title: String(req.body.title || '').trim(),
      artist: String(req.body.artist || '').trim(),
      album: String(req.body.album || '').trim(),
      links: parseJsonField(req.body.links),
    },
  });
  res.status(202).json({ id: track.id });
});

admin.patch('/tracks/:id', (req, res) => {
  const allowed = {};
  for (const key of ['title', 'artist', 'album', 'enabled', 'links']) if (key in req.body) allowed[key] = req.body[key];
  const track = library.update(req.params.id, allowed);
  if (!track) return res.sendStatus(404);
  station.emitUpdate();
  res.json({ ok: true });
});

admin.post('/tracks/:id/cover', upload.single('cover'), async (req, res) => {
  const track = library.get(req.params.id);
  if (!track || !req.file || !IMAGE_EXT.test(req.file.originalname)) {
    cleanupFiles(req);
    return res.status(400).json({ error: 'Pick an image file.' });
  }
  try {
    const file = `${track.id}.jpg`;
    await makeJpeg(req.file.path, path.join(paths.covers, file));
    library.update(track.id, { coverFile: file, coverRev: Date.now() });
    station.emitUpdate();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `Could not read that image: ${err.message}` });
  } finally {
    cleanupFiles(req);
  }
});

admin.delete('/tracks/:id', (req, res) => {
  if (!library.remove(req.params.id)) return res.sendStatus(404);
  res.json({ ok: true });
});

admin.post('/skip', (req, res) => {
  station.skip();
  res.json({ ok: true });
});

admin.post('/queue', (req, res) => {
  if (!station.enqueue(String(req.body?.id || ''))) return res.status(400).json({ error: 'Track is not playable.' });
  res.json({ ok: true });
});

admin.delete('/queue/:requestId', (req, res) => {
  station.dequeue(req.params.requestId);
  res.json({ ok: true });
});

admin.get('/settings', (req, res) => res.json(library.settings));
admin.patch('/settings', (req, res) => res.json(library.updateSettings(req.body || {})));

admin.post('/settings/background', upload.single('background'), async (req, res) => {
  const f = req.file;
  if (!f || !(IMAGE_EXT.test(f.originalname) || VIDEO_EXT.test(f.originalname))) {
    cleanupFiles(req);
    return res.status(400).json({ error: 'Pick an image or video file.' });
  }
  try {
    const info = await probe(f.path);
    const isVideo = info.hasVideo && VIDEO_EXT.test(f.originalname);
    const file = `${newId()}.${isVideo ? 'mp4' : 'jpg'}`;
    const out = path.join(paths.backgrounds, file);
    if (isVideo) await makeBackgroundVideo(f.path, out);
    else await makeJpeg(f.path, out, 2560);
    const old = library.settings.background;
    library.updateSettings({ background: { file, type: isVideo ? 'video' : 'image', rev: Date.now() } });
    if (old?.file) fs.rm(path.join(paths.backgrounds, old.file), { force: true }, () => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: `Could not process that file: ${err.message}` });
  } finally {
    cleanupFiles(req);
  }
});

admin.delete('/settings/background', (req, res) => {
  const old = library.settings.background;
  library.updateSettings({ background: null });
  if (old?.file) fs.rm(path.join(paths.backgrounds, old.file), { force: true }, () => {});
  res.json({ ok: true });
});

app.use('/api/admin', admin);

// Multer / JSON errors -> clean JSON instead of stack traces.
app.use((err, req, res, next) => {
  cleanupFiles(req);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status === 413 ? `File too large (max ${config.maxUploadMb} MB).` : err.message || 'Server error' });
});

// --- boot -----------------------------------------------------------------------
// Clear leftover partial uploads from a previous run.
for (const f of fs.readdirSync(paths.tmp)) fs.rm(path.join(paths.tmp, f), { force: true }, () => {});

if (!config.adminPassword) console.warn('[admin] ADMIN_PASSWORD is not set. Admin login is disabled until you set it in .env');
checkFfmpeg();
station.start();

const server = app.listen(config.port, config.host, () => {
  console.log(`[radio] "${library.settings.stationName}" on http://${config.host}:${config.port}`);
  console.log(`[radio] admin panel at ${config.adminPath}  |  ${library.playable().length} playable tracks`);
});
server.keepAliveTimeout = 65_000;
server.requestTimeout = 0; // the stream and event connections are meant to stay open
