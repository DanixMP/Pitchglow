// Draws the app icon (colored lanes + glowing auto-tune staircase) and writes PNGs to public/icons.
// No dependencies: a tiny supersampled rasterizer + PNG encoder on Node's zlib.
// Run: node scripts/make-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const BG = [15, 15, 16];

function hsl(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Lane hues top to bottom: purple, blue, teal, yellow, rose (the app's palette, spread out). */
const LANE_HUES = [272, 212, 160, 45, 345];

/**
 * Colour at unit coordinates (x, y) for content scaled into the [pad, 1-pad] box.
 * Returns [r, g, b, a] with a in 0..1.
 */
function shade(x, y, { pad, rounded }) {
  // Map into the content box.
  const u = (x - pad) / (1 - 2 * pad);
  const v = (y - pad) / (1 - 2 * pad);

  // Rounded-square mask for the regular icon; full bleed for maskable.
  if (rounded) {
    const r = 0.22;
    const dx = Math.max(r - x, 0, x - (1 - r));
    const dy = Math.max(r - y, 0, y - (1 - r));
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
  }

  let c = [...BG];
  // Lanes: 5 semitone rows.
  const lanes = [0.2, 0.32, 0.44, 0.56, 0.68, 0.8];
  for (let i = 0; i < 5; i++) {
    if (v >= lanes[i] && v < lanes[i + 1] && u > 0.06 && u < 0.94) {
      c = hsl(LANE_HUES[i], 34, 21 + (i % 2) * 3);
      if (v - lanes[i] < 0.006) c = c.map((ch) => ch * 0.55); // separator
    }
  }

  // Staircase (the tuned line) with each step in its lane's lit colour.
  const steps = [
    { x0: 0.14, x1: 0.38, y: 0.62, lane: 3 },
    { x0: 0.38, x1: 0.6, y: 0.5, lane: 2 },
    { x0: 0.6, x1: 0.84, y: 0.38, lane: 1 },
  ];
  const segs = [];
  steps.forEach((s, i) => {
    const col = hsl(LANE_HUES[s.lane], 82, 64);
    segs.push({ ax: s.x0, ay: s.y, bx: s.x1, by: s.y, col });
    if (i + 1 < steps.length) segs.push({ ax: s.x1, ay: s.y, bx: s.x1, by: steps[i + 1].y, col: hsl(LANE_HUES[steps[i + 1].lane], 82, 64) });
  });

  const width = 0.022;
  let best = Infinity;
  let bestCol = null;
  for (const s of segs) {
    const d = distToSeg(u, v, s.ax, s.ay, s.bx, s.by);
    if (d < best) {
      best = d;
      bestCol = s.col;
    }
  }
  // Glow, then the solid line, then the head dot.
  const glow = Math.exp(-((best / 0.05) ** 2)) * 0.55;
  c = mix(c, bestCol, glow);
  if (best < width) c = mix(c, bestCol, Math.min(1, (width - best) / 0.004));

  const dot = Math.hypot(u - 0.84, v - 0.38);
  c = mix(c, [255, 255, 255], Math.exp(-((dot / 0.07) ** 2)) * 0.5);
  if (dot < 0.042) c = mix(c, [255, 255, 255], Math.min(1, (0.042 - dot) / 0.004));
  return [...c, 1];
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

function render(size, opts) {
  const ss = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = shade((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size, opts);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const i = (y * size + x) * 4;
      const n = ss * ss;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(size, size, px);
}

// --- PNG encoding --------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = [
  ['icon-192.png', 192, { pad: 0.04, rounded: true }],
  ['icon-512.png', 512, { pad: 0.04, rounded: true }],
  // Maskable: full bleed, content inside the 80% safe zone.
  ['maskable-512.png', 512, { pad: 0.12, rounded: false }],
  ['apple-touch-icon.png', 180, { pad: 0.08, rounded: false }],
];
for (const [name, size, opts] of icons) {
  writeFileSync(new URL(name, OUT), render(size, opts));
  console.log(`wrote public/icons/${name}`);
}
