import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config, paths } from './config.js';

export const LINK_KEYS = ['spotify', 'appleMusic', 'youtube', 'soundcloud', 'bandcamp', 'tidal', 'deezer', 'other'];
export const SOCIAL_KEYS = ['instagram', 'x', 'tiktok', 'youtube', 'spotify', 'soundcloud', 'facebook', 'twitch', 'discord', 'website'];

const DEFAULT_SETTINGS = {
  stationName: 'Night Radio',
  tagline: 'Always on. Always live.',
  accent: '#8b5cf6',
  background: null, // { file, type: 'image' | 'video', rev }
  backgroundOpacity: 0.35,
  socials: {},
  // Site colors. mode "cover": colors follow each song's artwork (these are
  // the fallback). mode "fixed": always these colors.
  theme: {
    mode: 'cover',
    accent: '#8b5cf6',
    accent2: '#ec4899',
    accent3: '#3b82f6',
    background: '#07060b',
    surface: '#12101c',
    text: '#f5f3ff',
  },
  // Small, dismissible "come hang out" card on the listener page.
  reminder: {
    enabled: true,
    title: 'Join the community',
    message: 'Hop in the Discord to hear new music first, request songs and hang out with other listeners.',
    delaySec: 45,
  },
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
    const data = readJson(paths.library, {});
    this.tracks = data.tracks || [];
    this.albums = data.albums || [];
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(paths.settings, {}) };
    // Anything that was mid-processing when the server stopped is unrecoverable.
    for (const t of this.tracks) {
      if (t.status === 'processing') t.status = 'error';
    }
    // Songs from before albums existed: group them by their album tag.
    let migrated = false;
    for (const t of this.tracks) {
      if (!t.albumId && t.album) {
        t.albumId = this.findOrCreateAlbum(t.album, t.artist, { save: false }).id;
        this.adoptCover(t.albumId, t, { save: false });
        migrated = true;
      }
    }
    if (migrated) writeJson(paths.library, { tracks: this.tracks, albums: this.albums });
  }

  saveTracks() {
    writeJson(paths.library, { tracks: this.tracks, albums: this.albums });
    this.emit('tracks');
  }

  // --- albums ---------------------------------------------------------------

  getAlbum(id) {
    return (id && this.albums.find((a) => a.id === id)) || null;
  }

  addAlbum({ title, artist }) {
    const album = {
      id: newId(),
      title: cleanText(title) || 'Untitled album',
      artist: cleanText(artist),
      coverFile: null,
      coverRev: 0,
      createdAt: Date.now(),
    };
    this.albums.push(album);
    this.saveTracks();
    return album;
  }

  /** Match by title (and artist when both have one), ignoring case. */
  findOrCreateAlbum(title, artist, { save = true } = {}) {
    const t = cleanText(title).toLowerCase();
    const a = cleanText(artist).toLowerCase();
    const found = this.albums.find(
      (al) => al.title.toLowerCase() === t && (!a || !al.artist || al.artist.toLowerCase() === a),
    );
    if (found) return found;
    if (save) return this.addAlbum({ title, artist });
    const album = { id: newId(), title: cleanText(title), artist: cleanText(artist), coverFile: null, coverRev: 0, createdAt: Date.now() };
    this.albums.push(album);
    return album;
  }

  updateAlbum(id, patch) {
    const album = this.getAlbum(id);
    if (!album) return null;
    if ('title' in patch) album.title = cleanText(patch.title) || album.title;
    if ('artist' in patch) album.artist = cleanText(patch.artist);
    for (const key of ['coverFile', 'coverRev']) if (key in patch) album[key] = patch[key];
    this.saveTracks();
    return album;
  }

  /** Deletes the group only; its songs stay in the library, ungrouped. */
  removeAlbum(id) {
    const album = this.getAlbum(id);
    if (!album) return false;
    this.albums = this.albums.filter((a) => a.id !== id);
    for (const t of this.tracks) {
      if (t.albumId === id) {
        t.albumId = null;
        t.album = '';
      }
    }
    if (album.coverFile) fs.rm(path.join(paths.covers, album.coverFile), { force: true }, () => {});
    this.saveTracks();
    return true;
  }

  /** If the album has no artwork yet, copy this song's cover onto it. */
  adoptCover(albumId, track, { save = true } = {}) {
    const album = this.getAlbum(albumId);
    if (!album || album.coverFile || !track?.coverFile) return;
    const file = `a${album.id}.jpg`;
    try {
      fs.copyFileSync(path.join(paths.covers, track.coverFile), path.join(paths.covers, file));
      album.coverFile = file;
      album.coverRev = Date.now();
      if (save) this.saveTracks();
    } catch {
      /* the song's cover file is missing; leave the album without one */
    }
  }

  albumTrackCount(id) {
    return this.tracks.filter((t) => t.albumId === id).length;
  }

  adminAlbum(album) {
    return {
      id: album.id,
      title: album.title,
      artist: album.artist,
      cover: album.coverFile ? `${config.basePath}/cover/${album.coverFile}?v=${album.coverRev || 0}` : null,
      trackCount: this.albumTrackCount(album.id),
      createdAt: album.createdAt,
    };
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
    if ('albumId' in patch) {
      const album = this.getAlbum(patch.albumId);
      track.albumId = album ? album.id : null;
      track.album = album ? album.title : '';
    }
    if ('enabled' in patch) track.enabled = Boolean(patch.enabled);
    if ('links' in patch) track.links = cleanLinks(patch.links, LINK_KEYS);
    for (const key of ['status', 'error', 'audioFile', 'coverFile', 'coverRev', 'coverCustom', 'duration']) {
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
    if ('accent' in patch && /^#[0-9a-f]{6}$/i.test(patch.accent)) {
      s.accent = patch.accent;
      s.theme = { ...DEFAULT_SETTINGS.theme, ...s.theme, accent: patch.accent };
    }
    if (patch.theme && typeof patch.theme === 'object') {
      const t = { ...DEFAULT_SETTINGS.theme, ...s.theme };
      for (const key of ['accent', 'accent2', 'accent3', 'background', 'surface', 'text']) {
        if (/^#[0-9a-f]{6}$/i.test(patch.theme[key] || '')) t[key] = patch.theme[key].toLowerCase();
      }
      if (['cover', 'fixed'].includes(patch.theme.mode)) t.mode = patch.theme.mode;
      s.theme = t;
      s.accent = t.accent;
    }
    if ('backgroundOpacity' in patch) {
      const o = Number(patch.backgroundOpacity);
      if (Number.isFinite(o)) s.backgroundOpacity = Math.min(1, Math.max(0, o));
    }
    if ('socials' in patch) s.socials = cleanLinks(patch.socials, SOCIAL_KEYS);
    if (patch.reminder && typeof patch.reminder === 'object') {
      const r = { ...DEFAULT_SETTINGS.reminder, ...s.reminder };
      const p = patch.reminder;
      if ('enabled' in p) r.enabled = Boolean(p.enabled);
      if ('title' in p) r.title = cleanText(p.title, 60) || DEFAULT_SETTINGS.reminder.title;
      if ('message' in p) r.message = cleanText(p.message, 220);
      if ('delaySec' in p) {
        const d = Number(p.delaySec);
        if (Number.isFinite(d)) r.delaySec = Math.min(600, Math.max(0, Math.round(d)));
      }
      s.reminder = r;
    }
    if ('background' in patch) s.background = patch.background;
    if ('logo' in patch) s.logo = patch.logo; // { file, rev } or null
    this.saveSettings();
    return s;
  }

  /** What listeners are allowed to see about a track. Never includes file paths. */
  publicTrack(track) {
    if (!track) return null;
    // Priority: artwork uploaded by hand for this one song > album artwork >
    // the cover embedded in the song file.
    const album = this.getAlbum(track.albumId);
    const own = track.coverFile ? `${config.basePath}/cover/${track.coverFile}?v=${track.coverRev || 0}` : null;
    const albumCover = album?.coverFile ? `${config.basePath}/cover/${album.coverFile}?v=${album.coverRev || 0}` : null;
    const cover = (track.coverCustom && own) || albumCover || own;
    return {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: album ? album.title : track.album || '',
      duration: track.duration,
      cover,
      links: track.links || {},
    };
  }

  publicSettings() {
    const s = this.settings;
    return {
      stationName: s.stationName,
      tagline: s.tagline,
      accent: s.accent,
      backgroundOpacity: s.backgroundOpacity,
      background: s.background ? { url: `${config.basePath}/bg/${s.background.file}?v=${s.background.rev}`, type: s.background.type } : null,
      logo: s.logo ? `${config.basePath}/logo/${s.logo.file}?v=${s.logo.rev}` : null,
      socials: s.socials,
      reminder: { ...DEFAULT_SETTINGS.reminder, ...s.reminder },
      // Older settings files only had one accent color; carry it into the theme.
      theme: { ...DEFAULT_SETTINGS.theme, accent: s.accent || DEFAULT_SETTINGS.theme.accent, ...s.theme },
    };
  }
}

export const library = new Library();
