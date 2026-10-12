import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

// Listeners have no accounts. Each browser gets an anonymous random id
// (cookie) and can like a song once; a per-network cap stops someone
// clearing cookies to stack likes. Ids and IPs are stored only as salted
// hashes, never in the clear.

const FILE = path.join(config.dataDir, 'likes.json');
const SALT_FILE = path.join(config.dataDir, 'likes.salt');
const MAX_PER_NETWORK = 3; // likes per song from one IP (a household, a dorm...)
const MAX_TOGGLES_PER_MIN = 40;

function loadSalt() {
  try {
    return fs.readFileSync(SALT_FILE, 'utf8').trim();
  } catch {
    const salt = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(SALT_FILE, salt);
    return salt;
  }
}

class Likes extends EventEmitter {
  constructor() {
    super();
    this.salt = loadSalt();
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); // { trackId: { listenerHash: ipHash } }
    } catch {
      this.data = {};
    }
    this.rate = new Map(); // ip -> { n, since }
    this.saveTimer = null;
  }

  hash(value) {
    return crypto.createHash('sha256').update(`${this.salt}:${value}`).digest('base64url').slice(0, 22);
  }

  save() {
    // Batch bursts of likes into one write.
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, FILE);
    }, 1000);
  }

  count(trackId) {
    return Object.keys(this.data[trackId] || {}).length;
  }

  likedBy(listenerId) {
    const h = this.hash(listenerId);
    return Object.keys(this.data).filter((id) => this.data[id][h]);
  }

  rateLimited(ip) {
    const now = Date.now();
    const r = this.rate.get(ip);
    if (!r || now - r.since > 60_000) {
      this.rate.set(ip, { n: 1, since: now });
      return false;
    }
    r.n++;
    return r.n > MAX_TOGGLES_PER_MIN;
  }

  /** Like or un-like. Returns { liked, count } or { error }. */
  toggle(trackId, listenerId, ip) {
    if (this.rateLimited(ip)) return { error: 'Slow down a little.' };
    const lh = this.hash(listenerId);
    const ih = this.hash(ip);
    const set = (this.data[trackId] ||= {});
    let liked;
    if (set[lh]) {
      delete set[lh];
      liked = false;
    } else {
      const fromNetwork = Object.values(set).filter((v) => v === ih).length;
      if (fromNetwork >= MAX_PER_NETWORK) return { error: 'This song already has the most likes allowed from your network.' };
      set[lh] = ih;
      liked = true;
    }
    if (!Object.keys(set).length) delete this.data[trackId];
    this.save();
    this.emit('change');
    return { liked, count: this.count(trackId) };
  }

  removeTrack(trackId) {
    if (!this.data[trackId]) return;
    delete this.data[trackId];
    this.save();
    this.emit('change');
  }

  /** [{ id, likes }] most liked first. */
  ranking() {
    return Object.keys(this.data)
      .map((id) => ({ id, likes: this.count(id) }))
      .filter((r) => r.likes > 0)
      .sort((a, b) => b.likes - a.likes);
  }
}

export const likes = new Likes();
