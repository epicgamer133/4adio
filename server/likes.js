import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

// TikTok LIVE style likes: listeners tap as much as they want. Every tap
// counts toward the song's all-time total (the leaderboard) and toward the
// current play's like goals, which set off "hype trains" for everyone.
//
// Abuse control is a speed limit, not a cap: token buckets per listener
// (anonymous cookie) and per network (IP) refill every second, so fast
// human tapping always counts and a script can't inflate a song beyond that pace.

const FILE = path.join(config.dataDir, 'likes.json');
const SALT_FILE = path.join(config.dataDir, 'likes.salt');

const LISTENER_BUCKET = { cap: 40, perSec: 12 }; // ~12 taps/sec sustained, short bursts above
const NETWORK_BUCKET = { cap: 120, perSec: 36 }; // a few people on one Wi-Fi
const MAX_BATCH = 60;

// Like goals for a single play of a song. Past the list, each goal is 1.5x the last.
export const HYPE_GOALS = [20, 50, 100, 200, 400, 700, 1000];

function goalAt(level) {
  if (level < HYPE_GOALS.length) return HYPE_GOALS[level];
  let g = HYPE_GOALS[HYPE_GOALS.length - 1];
  for (let i = HYPE_GOALS.length - 1; i < level; i++) g = Math.round((g * 1.5) / 50) * 50;
  return g;
}

function loadSalt() {
  try {
    return fs.readFileSync(SALT_FILE, 'utf8').trim();
  } catch {
    const salt = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(SALT_FILE, salt);
    return salt;
  }
}

function loadData() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (data.totals) return data;
    // Older format ({ trackId: { listener: ip } }): one like per listener.
    return { totals: Object.fromEntries(Object.entries(data).map(([id, set]) => [id, Object.keys(set).length])) };
  } catch {
    return {};
  }
}

/** Calendar day on the server, e.g. "2026-10-12". */
const today = () => new Date().toLocaleDateString('en-CA');

class Likes extends EventEmitter {
  constructor() {
    super();
    this.salt = loadSalt();
    const data = loadData();
    this.totals = data.totals || {}; // trackId -> all-time likes
    this.days = data.days || {}; // "YYYY-MM-DD" -> likes that day (admin stats)
    this.hypeDays = data.hypeDays || {}; // "YYYY-MM-DD" -> hype trains that day
    this.record = data.record || null; // biggest hype train: { level, trackId, at }
    // Changes whenever counts are reset, so listener pages know to drop
    // their cached (only-ever-increasing) numbers.
    this.epoch = Date.now();
    this.plays = new Map(); // playId -> { trackId, count, level }
    this.buckets = new Map(); // hashed key -> { tokens, at }
    this.pending = new Map(); // playId -> taps since the last broadcast
    this.saveTimer = null;
    this.flushTimer = null;
    // Forget idle rate-limit buckets.
    setInterval(() => {
      const cutoff = Date.now() - 60_000;
      for (const [k, b] of this.buckets) if (b.at < cutoff) this.buckets.delete(k);
    }, 60_000).unref();
  }

  hash(value) {
    return crypto.createHash('sha256').update(`${this.salt}:${value}`).digest('base64url').slice(0, 22);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = `${FILE}.${process.pid}.tmp`;
      // Keep about two months of daily stats.
      for (const key of [this.days, this.hypeDays]) {
        const dates = Object.keys(key).sort();
        for (const d of dates.slice(0, Math.max(0, dates.length - 62))) delete key[d];
      }
      fs.writeFileSync(tmp, JSON.stringify({ totals: this.totals, days: this.days, hypeDays: this.hypeDays, record: this.record }));
      fs.renameSync(tmp, FILE);
    }, 1500);
  }

  /** Take up to n tokens from a refilling bucket; returns how many were granted. */
  take(key, n, { cap, perSec }) {
    const now = Date.now();
    const b = this.buckets.get(key) || { tokens: cap, at: now };
    b.tokens = Math.min(cap, b.tokens + ((now - b.at) / 1000) * perSec);
    b.at = now;
    const granted = Math.max(0, Math.min(n, Math.floor(b.tokens)));
    b.tokens -= granted;
    this.buckets.set(key, b);
    return granted;
  }

  count(trackId) {
    return this.totals[trackId] || 0;
  }

  /** Called by the station whenever a song starts, so its like goals start fresh. */
  startPlay(playId, trackId) {
    this.plays.set(playId, { trackId, count: 0, level: 0 });
    // Keep the last few plays: listeners a few seconds behind still tap the previous song.
    while (this.plays.size > 4) this.plays.delete(this.plays.keys().next().value);
  }

  playInfo(playId) {
    const p = this.plays.get(playId);
    if (!p) return null;
    return { count: p.count, level: p.level, goal: goalAt(p.level), prevGoal: p.level ? goalAt(p.level - 1) : 0 };
  }

  /** Add a batch of taps. Returns how many counted. */
  add({ trackId, playId, taps, listenerId, ip }) {
    const want = Math.max(1, Math.min(MAX_BATCH, Math.floor(taps) || 1));
    const mine = this.take(`l:${this.hash(listenerId)}`, want, LISTENER_BUCKET);
    const added = mine ? this.take(`i:${this.hash(ip)}`, mine, NETWORK_BUCKET) : 0;
    if (!added) return { added: 0, total: this.count(trackId) };

    this.totals[trackId] = this.count(trackId) + added;
    this.days[today()] = (this.days[today()] || 0) + added;
    const play = this.plays.get(playId);
    if (play && play.trackId === trackId) {
      play.count += added;
      // One batch can cross several goals; announce each level.
      while (play.count >= goalAt(play.level)) {
        const goal = goalAt(play.level);
        play.level++;
        this.hypeDays[today()] = (this.hypeDays[today()] || 0) + 1;
        if (!this.record || play.level > this.record.level) this.record = { level: play.level, trackId, at: Date.now() };
        this.emit('hype', { playId, trackId, level: play.level, goal, count: play.count });
      }
      this.pending.set(playId, (this.pending.get(playId) || 0) + added);
    } else {
      this.pending.set(`track:${trackId}`, (this.pending.get(`track:${trackId}`) || 0) + added);
    }
    this.scheduleFlush();
    this.save();
    return { added, total: this.totals[trackId] };
  }

  // Taps are announced to everyone in small batches (a few times a second),
  // which keeps the floating-hearts stream lively without flooding the network.
  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [];
      for (const [key, delta] of this.pending) {
        if (key.startsWith('track:')) {
          const trackId = key.slice(6);
          batch.push({ trackId, delta, total: this.count(trackId) });
        } else {
          const p = this.plays.get(key);
          if (p) batch.push({ playId: key, trackId: p.trackId, delta, total: this.count(p.trackId), play: this.playInfo(key) });
        }
      }
      this.pending.clear();
      if (batch.length) this.emit('batch', batch);
    }, 350);
  }

  removeTrack(trackId) {
    if (!(trackId in this.totals)) return;
    delete this.totals[trackId];
    this.save();
  }

  /** Admin: zero one song's likes (and its live like goal). */
  reset(trackId) {
    delete this.totals[trackId];
    for (const p of this.plays.values()) if (p.trackId === trackId) Object.assign(p, { count: 0, level: 0 });
    if (this.record?.trackId === trackId) this.record = null;
    this.epoch = Date.now();
    this.save();
    this.emit('batch', []);
  }

  /** Admin: a clean slate for every song, including daily stats and the record. */
  resetAll() {
    this.totals = {};
    this.days = {};
    this.hypeDays = {};
    this.record = null;
    for (const p of this.plays.values()) Object.assign(p, { count: 0, level: 0 });
    this.epoch = Date.now();
    this.save();
    this.emit('batch', []);
  }

  stats() {
    const d = today();
    return {
      totalLikes: Object.values(this.totals).reduce((a, b) => a + b, 0),
      likesToday: this.days[d] || 0,
      hypeToday: this.hypeDays[d] || 0,
      record: this.record,
      // Last 14 days, oldest first, for a small chart.
      daily: Array.from({ length: 14 }, (_, i) => {
        const day = new Date(Date.now() - (13 - i) * 86_400_000).toLocaleDateString('en-CA');
        return { day, likes: this.days[day] || 0, hype: this.hypeDays[day] || 0 };
      }),
    };
  }

  /** [{ id, likes }] most liked first. */
  ranking() {
    return Object.entries(this.totals)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, likes]) => ({ id, likes }));
  }
}

export const likes = new Likes();
