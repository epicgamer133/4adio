import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config, paths } from './config.js';
import { library, newId } from './library.js';
import { parseFrames, silentFrame } from './mp3.js';
import { likes } from './likes.js';

const LEADERBOARD_SIZE = 10;

/** A track as listeners see it, with its like count. */
function shown(track, extra = {}) {
  const t = library.publicTrack(track);
  return t ? { ...t, likes: likes.count(track.id), ...extra } : null;
}

const TICK_MS = 50;
const BURST_SECONDS = 2; // audio a new listener gets instantly so playback starts right away
const MAX_CLIENT_BACKLOG = 1024 * 1024; // drop listeners that stop reading
const HISTORY_SIZE = 20;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * One continuous MP3 stream shared by every listener. The station keeps
 * playing whether anyone is connected or not; joining means tapping into the
 * live edge, which is what keeps everyone in sync.
 */
class Station extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // res -> ip
    this.burst = [];
    this.burstDuration = 0;
    this.current = null; // { track, frames, index, playId, startedAt }
    this.queue = []; // admin requests: [{ id, requestId }]
    this.bag = []; // remaining ids in this shuffle cycle
    this.cycle = new Set(); // ids already played this cycle
    this.history = [];
    this.skipRequested = false;
    this.silence = silentFrame(config.bitrate);
    this.listenerTimer = null;

    library.on('tracks', () => this.syncBag());
  }

  start() {
    this.epoch = Date.now();
    this.sent = 0; // seconds of audio broadcast so far
    setInterval(() => this.tick(), TICK_MS);
  }

  /** Wall-clock time (ms) at which audio currently being written is "live". */
  liveEdge() {
    return this.epoch + this.sent * 1000;
  }

  tick() {
    const now = Date.now();
    let target = (now - this.epoch) / 1000;
    // If the process was paused (sleep, heavy GC), resync instead of flooding listeners.
    if (target - this.sent > 5) {
      this.epoch = now - this.sent * 1000;
      target = this.sent;
    }
    const chunks = [];
    while (this.sent < target) {
      const frame = this.nextFrame();
      chunks.push(frame.data);
      this.sent += frame.duration;
      this.burst.push(frame);
      this.burstDuration += frame.duration;
    }
    while (this.burstDuration > BURST_SECONDS && this.burst.length) {
      this.burstDuration -= this.burst.shift().duration;
    }
    if (!chunks.length || !this.clients.size) return;
    const data = Buffer.concat(chunks);
    for (const res of this.clients.keys()) {
      if (res.writableLength > MAX_CLIENT_BACKLOG) {
        res.destroy();
        continue;
      }
      res.write(data);
    }
  }

  nextFrame() {
    const cur = this.current;
    if (!cur || this.skipRequested || cur.index >= cur.frames.length) {
      this.skipRequested = false;
      this.advance();
    }
    if (!this.current) return this.silence;
    return this.current.frames[this.current.index++];
  }

  // --- rotation -----------------------------------------------------------

  isPlayable(id) {
    const t = library.get(id);
    return Boolean(t && t.status === 'ready' && t.enabled && t.audioFile);
  }

  refillBag() {
    const ids = shuffle(library.playable().map((t) => t.id));
    // Don't play the same song twice in a row across a cycle boundary.
    const lastId = this.current?.track.id;
    if (ids.length > 1 && ids[0] === lastId) [ids[0], ids[ids.length - 1]] = [ids[ids.length - 1], ids[0]];
    this.bag = ids;
    this.cycle.clear();
  }

  /** Keep the shuffle bag in step with library edits (new uploads join this cycle). */
  syncBag() {
    this.bag = this.bag.filter((id) => this.isPlayable(id));
    this.queue = this.queue.filter((q) => this.isPlayable(q.id));
    const known = new Set([...this.bag, ...this.cycle]);
    for (const t of library.playable()) {
      if (!known.has(t.id)) this.bag.splice(Math.floor(Math.random() * (this.bag.length + 1)), 0, t.id);
    }
    this.emitUpdate();
  }

  peekNextId() {
    this.queue = this.queue.filter((q) => this.isPlayable(q.id));
    if (this.queue.length) return this.queue[0].id;
    this.bag = this.bag.filter((id) => this.isPlayable(id));
    if (!this.bag.length) this.refillBag();
    return this.bag[0] || null;
  }

  takeNextId() {
    const id = this.peekNextId();
    if (!id) return null;
    if (this.queue.length && this.queue[0].id === id) this.queue.shift();
    else this.bag.shift();
    this.cycle.add(id);
    return id;
  }

  advance() {
    const previous = this.current;
    if (previous && previous.index > 0) {
      this.history.unshift({ playId: previous.playId, id: previous.track.id, startedAt: previous.startedAt });
      this.history.length = Math.min(this.history.length, HISTORY_SIZE);
    }
    this.current = null;

    // Try a few candidates in case a file went missing on disk.
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = this.takeNextId();
      if (!id) break;
      const track = library.get(id);
      try {
        const frames = parseFrames(fs.readFileSync(path.join(paths.audio, track.audioFile)));
        if (!frames.length) throw new Error('no frames');
        this.current = { track, frames, index: 0, playId: newId(), startedAt: this.liveEdge() };
        likes.startPlay(this.current.playId, track.id);
        library.markPlayed(id);
        break;
      } catch (err) {
        console.error(`[station] cannot play ${id}: ${err.message}`);
        library.update(id, { status: 'error', error: `Playback failed: ${err.message}` });
      }
    }

    if (this.current || previous) {
      if (this.current) console.log(`[station] now playing: ${this.current.track.artist} - ${this.current.track.title}`);
      this.emitUpdate();
    }
  }

  // --- admin controls -------------------------------------------------------

  skip() {
    this.skipRequested = true;
  }

  enqueue(id) {
    if (!this.isPlayable(id)) return false;
    this.queue.push({ id, requestId: newId() });
    this.emitUpdate();
    return true;
  }

  dequeue(requestId) {
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => q.requestId !== requestId);
    if (this.queue.length !== before) this.emitUpdate();
  }

  // --- listeners --------------------------------------------------------------

  ipCount(ip) {
    let n = 0;
    for (const v of this.clients.values()) if (v === ip) n++;
    return n;
  }

  addListener(req, res) {
    const ip = req.ip;
    if (this.ipCount(ip) >= config.maxStreamsPerIp) {
      res.status(429).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Accel-Buffering': 'no', // tell nginx not to buffer the live stream
      'Content-Disposition': 'inline',
      Connection: 'keep-alive',
    });
    req.socket.setNoDelay(true);
    if (this.burst.length) res.write(Buffer.concat(this.burst.map((f) => f.data)));
    this.clients.set(res, ip);
    this.listenersChanged();
    const drop = () => {
      if (this.clients.delete(res)) this.listenersChanged();
    };
    req.on('close', drop);
    res.on('error', drop);
  }

  listenersChanged() {
    // Debounce so a burst of joins/leaves sends one update.
    clearTimeout(this.listenerTimer);
    this.listenerTimer = setTimeout(() => this.emitUpdate(), 750);
  }

  /** Unique listening devices (several tabs from one IP count once). */
  listenerCount() {
    return new Set(this.clients.values()).size;
  }

  // --- state ------------------------------------------------------------------

  emitUpdate() {
    this.emit('update');
  }

  publicState() {
    const cur = this.current;
    const nextId = this.peekNextId();
    return {
      serverTime: Date.now(),
      burstSeconds: BURST_SECONDS,
      now: cur ? shown(cur.track, { playId: cur.playId, startedAt: cur.startedAt, hype: likes.playInfo(cur.playId) }) : null,
      next: nextId && nextId !== cur?.track.id ? shown(library.get(nextId)) : null,
      history: this.history
        .map((h) => {
          const t = library.get(h.id);
          return t ? shown(t, { playId: h.playId, startedAt: h.startedAt, hype: likes.playInfo(h.playId) }) : null;
        })
        .filter(Boolean),
      likesEpoch: likes.epoch,
      leaderboard: likes
        .ranking()
        .map((r) => library.get(r.id))
        .filter((t) => t && t.status === 'ready')
        .slice(0, LEADERBOARD_SIZE)
        .map((t) => shown(t)),
      listeners: this.listenerCount(),
      settings: library.publicSettings(),
    };
  }

  adminState() {
    return {
      ...this.publicState(),
      queue: this.queue.map((q) => ({ requestId: q.requestId, ...shown(library.get(q.id)) })),
      connections: this.clients.size,
      position: this.current ? (this.liveEdge() - this.current.startedAt) / 1000 : 0,
    };
  }
}

export const station = new Station();
