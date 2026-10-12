// Audio-reactive canvas backgrounds. Every mode reads the same analysed
// levels and the colors pulled from the current cover art.

const TAU = Math.PI * 2;

export const MODES = [
  { id: 'nebula', label: 'Nebula' },
  { id: 'bars', label: 'Spectrum' },
  { id: 'ring', label: 'Halo' },
  { id: 'wave', label: 'Waves' },
  { id: 'warp', label: 'Warp' },
  { id: 'minimal', label: 'Minimal' },
];

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export class Visualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mode = 'nebula';
    this.analyser = null;
    this.live = false; // true when real audio data is flowing
    this.freq = new Uint8Array(1024);
    this.wave = new Uint8Array(2048);
    this.colors = [[139, 92, 246], [236, 72, 153], [59, 130, 246]];
    this.target = this.colors.map((c) => [...c]);
    this.levels = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0 };
    this.bassAvg = 0;
    this.lastBeat = 0;
    this.focus = { x: innerWidth / 2, y: innerHeight / 2, r: 150 };
    this.particles = [];
    this.stars = [];
    this.peaks = new Float32Array(128);
    this.t = 0;
    this.boost = 0; // 0..1, hyperspeed during a hype train
    this.boostUntil = 0;
    this.onLevels = null;
    this.resize = this.resize.bind(this);
    addEventListener('resize', this.resize);
    this.resize();
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.wave = new Uint8Array(analyser.fftSize);
    this.binHz = analyser.context.sampleRate / analyser.fftSize;
  }

  setPalette(colors) {
    if (colors?.length) this.target = colors.map((c) => [...c]);
  }

  setMode(mode) {
    this.mode = mode;
    this.particles = [];
    this.stars = [];
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /** Kick into hyperspeed for a few seconds (hype train). */
  hype(seconds = 3.5) {
    this.boostUntil = Math.max(this.boostUntil, this.t + seconds);
  }

  setFocus(x, y, r) {
    this.focus = { x, y, r };
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start() {
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.t += dt;
      this.sample(dt);
      this.draw(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // --- analysis --------------------------------------------------------------

  sample(dt) {
    if (this.analyser && this.live) {
      this.analyser.getByteFrequencyData(this.freq);
      this.analyser.getByteTimeDomainData(this.wave);
    } else {
      // Gentle procedural motion while paused or before tuning in.
      const n = this.freq.length;
      for (let i = 0; i < n; i++) {
        const fall = 1 - i / n;
        this.freq[i] = (0.5 + 0.5 * Math.sin(this.t * 0.8 + i * 0.05) * Math.sin(this.t * 0.31 + i * 0.013)) * 55 * fall * fall;
      }
      for (let i = 0; i < this.wave.length; i++) {
        this.wave[i] = 128 + Math.sin(this.t * 1.4 + i * 0.012) * 9 + Math.sin(this.t * 0.6 + i * 0.031) * 5;
      }
    }

    const binHz = this.binHz || 44100 / 2048;
    const avg = (fromHz, toHz) => {
      const a = Math.max(1, Math.floor(fromHz / binHz));
      const b = Math.min(this.freq.length - 1, Math.ceil(toHz / binHz));
      let s = 0;
      for (let i = a; i <= b; i++) s += this.freq[i];
      return s / ((b - a + 1) * 255);
    };
    const L = this.levels;
    const follow = (cur, v) => cur + (v - cur) * Math.min(1, dt * (v > cur ? 18 : 5));
    L.bass = follow(L.bass, avg(25, 150));
    L.mid = follow(L.mid, avg(150, 2000));
    L.high = follow(L.high, avg(2000, 9000));
    L.energy = L.bass * 0.5 + L.mid * 0.35 + L.high * 0.15;

    this.bassAvg += (L.bass - this.bassAvg) * Math.min(1, dt * 1.5);
    if (L.bass > this.bassAvg * 1.18 + 0.04 && L.bass > 0.3 && this.t - this.lastBeat > 0.28) {
      L.beat = 1;
      this.lastBeat = this.t;
    }
    L.beat *= Math.pow(0.02, dt); // fast decay

    for (let i = 0; i < 3; i++) this.colors[i] = mix(this.colors[i], this.target[i], Math.min(1, dt * 1.2));
    // Ease in fast, ease out slowly.
    const want = this.t < this.boostUntil ? 1 : 0;
    this.boost += (want - this.boost) * Math.min(1, dt * (want ? 4 : 1.2));
    this.onLevels?.(L);
  }

  /** Log-spaced band i of n, 0..1 — what the eye expects from a spectrum. */
  band(i, n) {
    const binHz = this.binHz || 44100 / 2048;
    const lo = 32 * Math.pow(14000 / 32, i / n);
    const hi = 32 * Math.pow(14000 / 32, (i + 1) / n);
    const a = Math.max(1, Math.floor(lo / binHz));
    const b = Math.max(a, Math.min(this.freq.length - 1, Math.floor(hi / binHz)));
    let max = 0;
    for (let k = a; k <= b; k++) if (this.freq[k] > max) max = this.freq[k];
    // Treble naturally reads quieter; tilt it up a bit.
    return Math.min(1, (max / 255) * (1 + (i / n) * 0.45));
  }

  // --- drawing ---------------------------------------------------------------

  draw(dt) {
    const fn = this[`draw_${this.mode}`] || this.draw_nebula;
    fn.call(this, this.ctx, this.w, this.h, dt);
  }

  blobs(ctx, w, h, strength) {
    const { bass, energy, beat } = this.levels;
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      const c = this.colors[k % 3];
      const x = w * (0.5 + 0.34 * Math.sin(this.t * 0.06 * (k + 1) + k * 2.1));
      const y = h * (0.5 + 0.3 * Math.cos(this.t * 0.045 * (k + 1.4) + k * 1.3));
      const r = Math.max(w, h) * (0.28 + 0.2 * bass + 0.05 * k) * (1 + beat * 0.06);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, rgba(c, (0.22 + 0.3 * energy) * strength));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  draw_minimal(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    this.blobs(ctx, w, h, 0.55);
  }

  draw_nebula(ctx, w, h, dt) {
    ctx.clearRect(0, 0, w, h);
    this.blobs(ctx, w, h, 1);
    const { energy, beat } = this.levels;
    const target = w < 700 ? 70 : 150;
    while (this.particles.length < target) {
      const a = Math.random() * TAU;
      const d = this.focus.r * (0.6 + Math.random() * 0.6);
      this.particles.push({
        x: this.focus.x + Math.cos(a) * d,
        y: this.focus.y + Math.sin(a) * d,
        a,
        v: 0.4 + Math.random(),
        life: 0,
        max: 3 + Math.random() * 5,
        s: 0.6 + Math.random() * 1.8,
        c: (Math.random() * 3) | 0,
      });
    }
    ctx.globalCompositeOperation = 'lighter';
    const speed = 18 + energy * 160 + beat * 220;
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      p.a += dt * 0.15;
      p.x += Math.cos(p.a) * p.v * speed * dt;
      p.y += Math.sin(p.a) * p.v * speed * dt;
      const fade = Math.sin(Math.PI * Math.min(1, p.life / p.max));
      ctx.fillStyle = rgba(this.colors[p.c], fade * (0.5 + energy));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.s * (1 + beat * 0.8), 0, TAU);
      ctx.fill();
      return p.life < p.max && p.x > -20 && p.x < w + 20 && p.y > -20 && p.y < h + 20;
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  draw_bars(ctx, w, h, dt) {
    ctx.clearRect(0, 0, w, h);
    this.blobs(ctx, w, h, 0.45);
    const n = Math.max(24, Math.min(96, Math.floor(w / 16)));
    const gap = 3;
    const bw = w / n;
    const base = h * 0.84;
    const maxH = h * 0.42;
    const grad = ctx.createLinearGradient(0, base - maxH, 0, base);
    grad.addColorStop(0, rgba(this.colors[1], 0.95));
    grad.addColorStop(1, rgba(this.colors[0], 0.85));
    const refl = ctx.createLinearGradient(0, base, 0, base + maxH * 0.35);
    refl.addColorStop(0, rgba(this.colors[0], 0.22));
    refl.addColorStop(1, rgba(this.colors[0], 0));
    for (let i = 0; i < n; i++) {
      const v = Math.pow(this.band(i, n), 1.5);
      const bh = Math.max(2, v * maxH);
      const x = i * bw + gap / 2;
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, base - bh, bw - gap, bh, [3, 3, 0, 0]);
      else ctx.rect(x, base - bh, bw - gap, bh);
      ctx.fill();
      ctx.fillStyle = refl;
      ctx.fillRect(x, base + 2, bw - gap, bh * 0.35);
      this.peaks[i] = Math.max(this.peaks[i] - dt * 0.35, v);
      ctx.fillStyle = rgba(this.colors[2], 0.9);
      ctx.fillRect(x, base - this.peaks[i] * maxH - 6, bw - gap, 2);
    }
  }

  draw_ring(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    this.blobs(ctx, w, h, 0.4);
    const { bass, beat } = this.levels;
    const { x, y } = this.focus;
    const r0 = this.focus.r * 1.12 + bass * 16 + beat * 8;
    const n = w < 700 ? 90 : 140;
    const half = n / 2;
    const reach = Math.min(w, h) * 0.2;

    const glow = ctx.createRadialGradient(x, y, r0 * 0.8, x, y, r0 + reach * 1.3);
    glow.addColorStop(0, rgba(this.colors[0], 0.25 + bass * 0.35));
    glow.addColorStop(1, rgba(this.colors[0], 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, ((TAU * r0) / n) * 0.5);
    for (let i = 0; i < n; i++) {
      // Mirror so lows sit at the top and both sides match.
      const k = i < half ? i : n - 1 - i;
      const v = Math.pow(this.band(k, half), 1.3);
      const a = (i / n) * TAU - Math.PI / 2 + this.t * 0.05;
      const len = 4 + v * reach;
      const c = mix(this.colors[1], this.colors[2], k / half);
      ctx.strokeStyle = rgba(c, 0.55 + v * 0.45);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      ctx.lineTo(x + Math.cos(a) * (r0 + len), y + Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(this.colors[2], 0.25);
    ctx.beginPath();
    ctx.arc(x, y, r0 + reach * 1.15 + beat * 10, 0, TAU);
    ctx.stroke();
  }

  draw_wave(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    this.blobs(ctx, w, h, 0.5);
    const { energy } = this.levels;
    const pts = w < 700 ? 96 : 180;
    const step = Math.floor(this.wave.length / pts);
    ctx.lineJoin = 'round';
    for (let L = 0; L < 3; L++) {
      const amp = h * 0.16 * (1 + L * 0.35) * (0.5 + energy * 1.6);
      const yBase = h * (0.5 + (L - 1) * 0.07);
      const offset = L * 37;
      ctx.beginPath();
      for (let p = 0; p <= pts; p++) {
        const x = (p / pts) * w;
        const idx = Math.min(this.wave.length - 1, (p * step + offset) % this.wave.length);
        const env = Math.sin((Math.PI * p) / pts);
        const y = yBase + ((this.wave[idx] - 128) / 128) * amp * env;
        if (p === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(this.colors[L], 0.12);
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = rgba(this.colors[L], 0.85);
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
  }

  draw_warp(ctx, w, h, dt) {
    // Fade the previous frame instead of clearing to leave light trails.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const { energy, beat } = this.levels;
    const count = w < 700 ? 220 : 420;
    while (this.stars.length < count) {
      this.stars.push({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() * 1 + 0.05, c: (Math.random() * 3) | 0 });
    }
    const speed = 0.12 + energy * 1.4 + beat * 1.2 + this.boost * 3.2;
    const fov = Math.max(w, h) * 0.5;
    const { x: cx, y: cy } = this.focus;
    ctx.lineCap = 'round';
    for (const s of this.stars) {
      const px = cx + (s.x / s.z) * fov;
      const py = cy + (s.y / s.z) * fov;
      s.z -= speed * dt;
      const nx = cx + (s.x / Math.max(0.01, s.z)) * fov;
      const ny = cy + (s.y / Math.max(0.01, s.z)) * fov;
      if (s.z <= 0.01 || nx < -50 || nx > w + 50 || ny < -50 || ny > h + 50) {
        s.x = (Math.random() - 0.5) * 2;
        s.y = (Math.random() - 0.5) * 2;
        s.z = 1.05;
        continue;
      }
      // Tinted toward white so streaks stay visible over a custom background,
      // even one that shares the cover's colors.
      // During a hype train, streaks turn hot pink/gold.
      const base = this.boost > 0.01 ? mix(this.colors[s.c], s.c % 2 ? [255, 77, 125] : [255, 210, 63], this.boost) : this.colors[s.c];
      ctx.strokeStyle = rgba(mix(base, [255, 255, 255], 0.45), (1.05 - s.z) * 0.95);
      ctx.lineWidth = (1.05 - s.z) * (3 + this.boost * 2);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
