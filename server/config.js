import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so there is no extra dependency. Real env vars win.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = process.env;

function normalizeAdminPath(p) {
  const clean = '/' + String(p || 'admin').replace(/^\/+|\/+$/g, '');
  return /^\/[A-Za-z0-9_-]+$/.test(clean) ? clean : '/admin';
}

export const config = {
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 8090),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  publicDir: path.join(ROOT, 'public'),
  adminPassword: env.ADMIN_PASSWORD || '',
  adminPath: normalizeAdminPath(env.ADMIN_PATH),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
  bitrate: Number(env.STREAM_BITRATE || 192), // kbps, CBR
  loudnorm: env.LOUDNORM !== 'false',
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 300),
  maxStreamsPerIp: Number(env.MAX_STREAMS_PER_IP || 4),
  trustProxy: env.TRUST_PROXY || 'loopback',
  secureCookies: env.SECURE_COOKIES === 'true',
  frameAncestors: normalizeSources(env.FRAME_ANCESTORS || "'self'"),
};

// CSP keywords must be single-quoted; .env quote stripping often removes them.
function normalizeSources(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (/^(self|none)$/i.test(t) ? `'${t.toLowerCase()}'` : t))
    .join(' ');
}

export const paths = {
  audio: path.join(config.dataDir, 'audio'),
  covers: path.join(config.dataDir, 'covers'),
  backgrounds: path.join(config.dataDir, 'backgrounds'),
  tmp: path.join(config.dataDir, 'tmp'),
  library: path.join(config.dataDir, 'library.json'),
  settings: path.join(config.dataDir, 'settings.json'),
};

for (const dir of [config.dataDir, paths.audio, paths.covers, paths.backgrounds, paths.tmp]) {
  fs.mkdirSync(dir, { recursive: true });
}
