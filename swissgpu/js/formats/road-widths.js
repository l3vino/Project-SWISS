/* road-widths.js — each road's own width class, from the national landscape
 * model, matched onto a vector tile's segments.
 *
 * Runs on a decode thread (workers/codec.js, the 'road-widths' job). The
 * vector tiles (base.vt) say what kind a road is but not how wide; the
 * landscape model swissTLM3D has every road's width class (its OBJEKTART:
 * "4m Strasse" for 4.21 to 6.20 m, and so on), and swisstopo's identify
 * service hands out its roads in any rectangle, with their geometry, at
 * most about 200 rows an answer (research doc §8). Its answers are not
 * compressed and repeat rows (two and a half times over in a busy street),
 * and paging through a full answer repeats rows too, so a full answer is
 * split into four smaller rectangles instead. The rectangles are planned
 * from the tile's own segments (about TARGET of them each, as base.vt's
 * roads are swissTLM3D's), so a city tile takes tens of calls and the open
 * country one or two.
 *
 * The two come from the same survey (median 0.07 to 0.11 m apart), so a
 * segment takes the class of the model's road beside it: within REACH
 * metres and running the same way, at most of three points along it. What
 * comes back is one byte per segment, the width class's number (the
 * adapter's widthClasses, 1-15; 0 where nothing matched), kept between
 * sessions (workers/index-cache.js) under the tile and a hash of its
 * segments, so a tile that changes is matched again.
 */

import { BLOCK } from './vector-tile.js';

/* A rectangle is planned to hold at most TARGET of the tile's lines (a
 * line of base.vt runs on across junctions where the model's roads stop,
 * so about two of them a line), so that its answer stays under the cap;
 * the smallest rectangle planned or split to, metres. Bigger rectangles
 * are better: every rectangle a long road crosses sends all of it again. */
const TARGET = 90;
const SMALLEST = 60;
/* Metres between a segment and the model's road it is matched to, at most,
 * and how alike their directions must be (|cos|). */
const REACH = 4;
const ALIGN = 0.85;
/* Margin round each rectangle (metres), so a road crossing its edge is
 * found from both sides. */
const PAD = 8;
const GRID = 64;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const l = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI);
};
const lonOf = (mx) => mx * 360 - 180;
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

/** The segments section of a block as [ax, ay, bx, by, s0, s1, attr, link] words, and its header. */
export function blockSegments(block) {
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const at = u32[BLOCK.segmentsOff] / 4, n = u32[BLOCK.segmentCount];
  return {
    count: n, extent: u32[BLOCK.extent], metres: new Float32Array(u32.buffer, u32.byteOffset, 16)[BLOCK.metresPerUnit],
    words: u32.subarray(at, at + n * BLOCK.SEGMENT_WORDS), offset: at * 4,
  };
}

/** FNV-1a over the segments' words (their width classes left out): what the tile's matching is kept under. */
export function segmentsHash(words) {
  let h = 2166136261;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ (i % 8 === 6 ? words[i] & 0x0fffffff : words[i]), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * The rectangles to ask for (degrees, padded), planned from the segments
 * of the kinds `matchable[kind]` says to match.
 */
export function planBoxes({ z, x, y, words, count, extent, metres }, matchable) {
  // Each matchable segment's middle and its line.
  const mids = [];
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  for (let i = 0; i < count; i++) {
    const o = i * 8, attr = words[o + 6];
    if (!matchable[attr & 63] || (attr >>> 6) & 3) continue;
    mids.push((f32[o] + f32[o + 2]) / 2, (f32[o + 1] + f32[o + 3]) / 2, words[o + 7] & 0xffff);
  }
  const boxes = [];
  const lines = new Set();
  const split = (x0, y0, size, list) => {
    if (!list.length) return;
    lines.clear();
    for (let k = 2; k < list.length; k += 3) lines.add(list[k]);
    if (lines.size > TARGET && size * metres / 2 >= SMALLEST) {
      const h = size / 2;
      for (const [ox, oy] of [[0, 0], [h, 0], [0, h], [h, h]]) {
        const sub = [];
        for (let k = 0; k < list.length; k += 3) {
          const px = list[k], py = list[k + 1];
          if (px >= x0 + ox && px < x0 + ox + h && py >= y0 + oy && py < y0 + oy + h) sub.push(px, py, list[k + 2]);
        }
        split(x0 + ox, y0 + oy, h, sub);
      }
      return;
    }
    boxes.push(unitsToDegrees(z, x, y, extent, x0, y0, size, PAD / metres));
  };
  split(0, 0, extent, mids);
  return boxes;
}

/* A square of tile units as a padded rectangle in degrees, with its size. */
function unitsToDegrees(z, x, y, extent, x0, y0, size, pad) {
  const n = 2 ** z;
  const mx0 = (x + (x0 - pad) / extent) / n, mx1 = (x + (x0 + size + pad) / extent) / n;
  const my0 = (y + (y0 - pad) / extent) / n, my1 = (y + (y0 + size + pad) / extent) / n;
  return { west: lonOf(mx0), east: lonOf(mx1), north: latOf(my0), south: latOf(my1), units: { x0, y0, size } };
}

/** A rectangle's four quarters (for an answer that came back full). */
export function quarters(box, { z, x, y, extent, metres }) {
  const { x0, y0, size } = box.units;
  if (size * metres / 2 < SMALLEST / 2) return null;
  const h = size / 2;
  return [[0, 0], [h, 0], [0, h], [h, h]].map(([ox, oy]) => unitsToDegrees(z, x, y, extent, x0 + ox, y0 + oy, h, PAD / metres));
}

/** The identify call for a rectangle. With the rectangle as the map's
 * extent too, each road comes once (without, two or three times over). */
export function identifyUrl(spec, box) {
  const f = (v) => v.toFixed(6);
  const r = `${f(box.west)},${f(box.south)},${f(box.east)},${f(box.north)}`;
  return `${spec.identify}?geometry=${r}&geometryType=esriGeometryEnvelope&layers=all:${spec.layer}` +
    `&mapExtent=${r}&imageDisplay=1000,1000,96&tolerance=0&returnGeometry=true&geometryFormat=geojson&sr=4326&limit=${spec.limit}`;
}

/**
 * An identify answer's roads into `into` (a Map: feature id → { code,
 * lines }), the width class each has (`classes`: OBJEKTART → class number);
 * roads of no width class (squares, accesses) are left out. Returns the
 * rows it had, repeats included (whether the answer was full).
 */
export function readAnswer(json, field, classes, into) {
  const rows = Array.isArray(json?.results) ? json.results : [];
  for (const r of rows) {
    const id = r.featureId ?? r.id;
    if (id == null || into.has(id)) continue;
    const code = classes[r.properties?.[field]];
    const g = r.geometry;
    if (!code || !g) { into.set(id, null); continue; }
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    into.set(id, { code, lines });
  }
  return rows.length;
}

/**
 * The width class of every segment (a Uint8Array, 0 where no road of the
 * model runs beside it), from the roads read (`roads`, readAnswer's Map).
 * `rules`: `matchable` (per kind number, 1 to match it), `widest` (per kind,
 * the widest it may be drawn, metres: a footpath never takes a street's
 * width) and `widths` (per class, metres). Also how many were asked about
 * and how many matched.
 */
export function matchWidths({ z, x, y, words, count, extent, metres }, roads, { matchable, widest, widths }) {
  const n = 2 ** z;
  const tx = (lon) => (mercX(lon) * n - x) * extent, ty = (lat) => (mercY(lat) * n - y) * extent;
  // The model's roads as segments in tile units...
  const seg = [], cls = [];
  for (const road of roads.values()) {
    if (!road) continue;
    for (const line of road.lines) {
      for (let i = 1; i < line.length; i++) {
        seg.push(tx(line[i - 1][0]), ty(line[i - 1][1]), tx(line[i][0]), ty(line[i][1]));
        cls.push(road.code);
      }
    }
  }
  // ...filed in a grid by the box they reach.
  const reach = REACH / metres, cell = extent / GRID, cells = GRID * GRID;
  const span = (a, b) => [Math.max(0, Math.floor((Math.min(a, b) - reach) / cell)), Math.min(GRID - 1, Math.floor((Math.max(a, b) + reach) / cell))];
  const start = new Uint32Array(cells + 1);
  const each = (fn) => {
    for (let s = 0; s < cls.length; s++) {
      const [i0, i1] = span(seg[s * 4], seg[s * 4 + 2]), [j0, j1] = span(seg[s * 4 + 1], seg[s * 4 + 3]);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * GRID + i, s);
    }
  };
  each((c) => { start[c + 1]++; });
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const list = new Uint32Array(start[cells]), fill = start.slice(0, cells);
  each((c, s) => { list[fill[c]++] = s; });

  const codes = new Uint8Array(count);
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const votes = new Float32Array(16);
  let matched = 0, asked = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 8, attr = words[o + 6], kind = attr & 63;
    if (!matchable[kind] || (attr >>> 6) & 3) continue;
    asked++;
    const ax = f32[o], ay = f32[o + 1], dx = f32[o + 2] - ax, dy = f32[o + 3] - ay, len = Math.hypot(dx, dy);
    if (len <= 0) continue;
    votes.fill(0);
    let hits = 0;
    for (let k = 0; k < 3; k++) {
      const t = 0.2 + 0.3 * k, px = ax + dx * t, py = ay + dy * t;
      const ci = Math.min(GRID - 1, Math.max(0, Math.floor(px / cell))), cj = Math.min(GRID - 1, Math.max(0, Math.floor(py / cell)));
      const c = cj * GRID + ci;
      let best = -1, bestD = reach;
      for (let e = start[c]; e < start[c + 1]; e++) {
        const s = list[e], s4 = s * 4;
        const qx = seg[s4 + 2] - seg[s4], qy = seg[s4 + 3] - seg[s4 + 1], ql = Math.hypot(qx, qy);
        if (ql <= 0 || Math.abs(dx * qx + dy * qy) / (len * ql) < ALIGN) continue;
        const u = Math.max(0, Math.min(1, ((px - seg[s4]) * qx + (py - seg[s4 + 1]) * qy) / (ql * ql)));
        const d = Math.hypot(px - seg[s4] - qx * u, py - seg[s4 + 1] - qy * u);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best >= 0) { votes[cls[best]] += 1 / (1 + bestD * metres); hits++; }
    }
    if (hits < 2) continue;
    let code = 0;
    for (let k = 1; k < 16; k++) if (votes[k] > votes[code]) code = k;
    if (!code || widths[code] > widest[kind]) continue;
    codes[i] = code;
    matched++;
  }
  return { codes, matched, asked, modelSegments: cls.length };
}
