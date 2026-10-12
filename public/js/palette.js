// Pulls a few vivid, distinct colors out of the cover art for the visualizers.

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Rotate hue / adjust for a fallback palette built from one accent color. */
export function paletteFromAccent(hex) {
  const [h, s, l] = rgbToHsl(...hexToRgb(hex));
  return [0, 0.08, -0.12].map((dh) => hslToRgb((h + dh + 1) % 1, Math.max(0.6, s), Math.min(0.62, Math.max(0.5, l))));
}

export function extractPalette(img, count = 3) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
    b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; b.n++;
    buckets.set(key, b);
  }

  const candidates = [...buckets.values()].map((b) => {
    const rgb = [b.r / b.n, b.g / b.n, b.b / b.n];
    const [h, s, l] = rgbToHsl(...rgb);
    // Favor colorful, mid-bright colors; dull greys and near-black score low.
    const score = b.n * (0.15 + s) * (1 - Math.abs(l - 0.5) * 1.4);
    return { h, s, l, score };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.min(Math.abs(p.h - c.h), 1 - Math.abs(p.h - c.h)) > 0.07 || Math.abs(p.l - c.l) > 0.3)) {
      picked.push(c);
      if (picked.length === count) break;
    }
  }
  // Black & white artwork has no hue worth using; caller falls back to the accent.
  if (!picked.length || Math.max(...picked.map((p) => p.s)) < 0.15) return null;
  while (picked.length < count) {
    const base = picked[picked.length - 1];
    picked.push({ ...base, h: (base.h + 0.09) % 1 });
  }
  // Lift everything into a glow-friendly range so it reads on a dark background.
  return picked.map((c) => hslToRgb(c.h, Math.min(1, Math.max(0.55, c.s * 1.15)), Math.min(0.66, Math.max(0.5, c.l))));
}
