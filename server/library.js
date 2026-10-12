import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { paths } from './config.js';

export const LINK_KEYS = ['spotify', 'appleMusic', 'youtube', 'soundcloud', 'bandcamp', 'tidal', 'deezer', 'other'];
export const SOCIAL_KEYS = ['instagram', 'x', 'tiktok', 'youtube', 'spotify', 'soundcloud', 'facebook', 'twitch', 'discord', 'website'];
export const VISUALIZERS = ['nebula', 'bars', 'ring', 'wave', 'warp', 'minimal'];

const DEFAULT_SETTINGS = {
  stationName: 'Night Radio',
  tagline: 'Always on. Always live.',
  accent: '#8b5cf6',
  defaultVisualizer: 'nebula',
  background: null, // { file, type: 'image' | 'video', rev }
  backgroundOpacity: 0.35,
  socials: {},
};

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write to a temp file then rename, so a crash mid-write never corrupts data.
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function newId() {
  return crypto.randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').toLowerCase();
}

function cleanUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function cleanText(value, max = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

export function cleanLinks(input, keys) {
  const out = {};
  for (const key of keys) {
    const url = cleanUrl(input?.[key]);
    if (url) out[key] = url;
  }
  return out;
}

class Library extends EventEmitter {
  constructor() {
    super();
    this.tracks = readJson(paths.library, { tracks: [] }).tracks || [];
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(paths.settings, {}) };
    // Anything that was mid-processing when the server stopped is unrecoverable.
    for (const t of this.tracks) {
      if (t.status === 'processing') t.status = 'error';
    }
  }

  saveTracks() {
    writeJson(paths.library, { tracks: this.tracks });
    this.emit('tracks');
  }

  saveSettings() {
    writeJson(paths.settings, this.settings);
    this.emit('settings');
  }

  get(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  playable() {
    return this.tracks.filter((t) => t.status === 'ready' && t.enabled);
  }

  add(track) {
    this.tracks.push(track);
    this.saveTracks();
    return track;
  }

  update(id, patch) {
    const track = this.get(id);
    if (!track) return null;
    if ('title' in patch) track.title = cleanText(patch.title) || track.title;
    if ('artist' in patch) track.artist = cleanText(patch.artist);
    if ('album' in patch) track.album = cleanText(patch.album);
    if ('enabled' in patch) track.enabled = Boolean(patch.enabled);
    if ('links' in patch) track.links = cleanLinks(patch.links, LINK_KEYS);
    for (const key of ['status', 'error', 'audioFile', 'coverFile', 'coverRev', 'duration']) {
      if (key in patch) track[key] = patch[key];
    }
    this.saveTracks();
    return track;
  }

  remove(id) {
    const track = this.get(id);
    if (!track) return false;
    this.tracks = this.tracks.filter((t) => t.id !== id);
    for (const [dir, file] of [[paths.audio, track.audioFile], [paths.covers, track.coverFile]]) {
      if (file) fs.rm(path.join(dir, file), { force: true }, () => {});
    }
    this.saveTracks();
    return true;
  }

  markPlayed(id) {
    const track = this.get(id);
    if (!track) return;
    track.plays = (track.plays || 0) + 1;
    track.lastPlayedAt = Date.now();
    this.saveTracks();
  }

  updateSettings(patch) {
    const s = this.settings;
    if ('stationName' in patch) s.stationName = cleanText(patch.stationName, 80) || s.stationName;
    if ('tagline' in patch) s.tagline = cleanText(patch.tagline, 160);
    if ('accent' in patch && /^#[0-9a-f]{6}$/i.test(patch.accent)) s.accent = patch.accent;
    if ('defaultVisualizer' in patch && VISUALIZERS.includes(patch.defaultVisualizer)) {
      s.defaultVisualizer = patch.defaultVisualizer;
    }
    if ('backgroundOpacity' in patch) {
      const o = Number(patch.backgroundOpacity);
      if (Number.isFinite(o)) s.backgroundOpacity = Math.min(1, Math.max(0, o));
    }
    if ('socials' in patch) s.socials = cleanLinks(patch.socials, SOCIAL_KEYS);
    if ('background' in patch) s.background = patch.background;
    this.saveSettings();
    return s;
  }

  /** What listeners are allowed to see about a track. Never includes file paths. */
  publicTrack(track) {
    if (!track) return null;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration,
      cover: track.coverFile ? `/cover/${track.coverFile}?v=${track.coverRev || 0}` : null,
      links: track.links || {},
    };
  }

  publicSettings() {
    const s = this.settings;
    return {
      stationName: s.stationName,
      tagline: s.tagline,
      accent: s.accent,
      defaultVisualizer: s.defaultVisualizer,
      backgroundOpacity: s.backgroundOpacity,
      background: s.background ? { url: `/bg/${s.background.file}?v=${s.background.rev}`, type: s.background.type } : null,
      socials: s.socials,
    };
  }
}

export const library = new Library();
