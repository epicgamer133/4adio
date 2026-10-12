import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { likes } from './likes.js';

// Favorites live in each listener's browser. The page reports them here only
// so the admin can see *how many* people saved each song: listeners are
// stored as salted hashes of their anonymous cookie id, never who they are.

const FILE = path.join(config.dataDir, 'favorites.json');
const MAX_PER_LISTENER = 500;

class Favorites {
  constructor() {
    try {
      this.data = JSON.parse(fs.readFileSync(FILE, 'utf8')); // { trackId: { listenerHash: savedAt } }
    } catch {
      this.data = {};
    }
    this.saveTimer = null;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, FILE);
    }, 1500);
  }

  count(trackId) {
    return Object.keys(this.data[trackId] || {}).length;
  }

  total() {
    return Object.keys(this.data).reduce((n, id) => n + this.count(id), 0);
  }

  uniqueListeners() {
    const all = new Set();
    for (const set of Object.values(this.data)) for (const h of Object.keys(set)) all.add(h);
    return all.size;
  }

  set(listenerId, trackId, on) {
    const h = likes.hash(listenerId);
    if (on) (this.data[trackId] ||= {})[h] = Date.now();
    else if (this.data[trackId]) {
      delete this.data[trackId][h];
      if (!Object.keys(this.data[trackId]).length) delete this.data[trackId];
    }
    this.save();
  }

  /** Make the server's view of one listener match their browser's list. */
  sync(listenerId, ids, isValid) {
    const h = likes.hash(listenerId);
    const want = new Set(ids.slice(0, MAX_PER_LISTENER).filter(isValid));
    for (const [trackId, set] of Object.entries(this.data)) {
      if (set[h] && !want.has(trackId)) {
        delete set[h];
        if (!Object.keys(set).length) delete this.data[trackId];
      }
    }
    for (const id of want) if (!this.data[id]?.[h]) (this.data[id] ||= {})[h] = Date.now();
    this.save();
  }

  removeTrack(trackId) {
    if (!this.data[trackId]) return;
    delete this.data[trackId];
    this.save();
  }
}

export const favorites = new Favorites();
