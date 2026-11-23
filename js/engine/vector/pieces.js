/* pieces.js — the roads, tracks, paths and railway beds over a terrain tile,
 * as the pieces wasm/src/shape.c cuts into it.
 *
 * Read off the vector tiles' blocks (formats/vector-tile.js) on the render
 * thread, which keeps them for this: a block's grid says which segments come
 * near any part of the tile, so only those are looked at. Each piece carries
 * its ends in the terrain tile's own quantized units (geodetic: the lines are
 * Web Mercator, so their ends go through longitude and latitude), its
 * distance along its line (segmentArcs: not the dash pattern's lengths,
 * which start again where a line crosses its tile's edge), the half-width held level
 * (the road's own width where the national landscape model gave it, else its
 * kind's, plus a shoulder), the steepest it may climb, and its line, so its
 * pieces are shaped as one. Bridges, tunnels and fords are left out: they
 * do not lie on the ground; but where a bridge's deck ends before the
 * line's bridge does, the rest is (bridges.js: the gaps), and where a road
 * comes off a deck, a pin carries the deck's height (a piece of priority
 * -1: its place, its distance along the line, the height, the deck's grade,
 * and in its half-width the side the ground is on; shape.c). Where a road
 * goes into a tunnel the same holds for the tunnel's floor (portals.js), and
 * the road's level cut is as wide as the tunnel for the first metres out of
 * the portal (portals.js: the block's `widen`; the segments there are cut
 * into stretches, each with its half-width), and a short apron runs
 * straight out of the portal as wide (the block's `aprons`: pieces of their
 * own lines, pinned at the portal).
 *
 * A railway's track (track.c) runs on over a bridge's deck where the deck is
 * known (the block's `decks`: bridges.js deckProfile, the deck's top along
 * the line; 5.18c), its pieces carrying the deck's height. A block's lines
 * run on 32 units into each neighbouring tile's square (the vector tiles'
 * buffer); where that tile is cut into the same terrain tile too, those
 * parts are its, not this block's (the block's `owners`, 5.18c: they came
 * twice, a doubled and flickering track and road in a band ~20 m wide along
 * every road tile's edge).
 */

import { BLOCK, segmentArcs } from '../../formats/vector-tile.js';
import { PIN_FLOATS } from './bridges.js';
import { WIDEN_FLOATS, WIDEN_FULL, WIDEN_TO, APRON_FLOATS } from './portals.js';

export const PIECE_FLOATS = 10;
/* A piece of a railway's track (wasm/src/track.c TrackPiece, 5.18b): its ends in the tile's quantized units, the
 * metres along its line at each, half its gauge, its flags (TRACK_RACK), its line (its road pieces'), and the deck's
 * top at each end where it lies on a bridge's deck (5.18c; NaN on the ground). */
export const TRACK_FLOATS = 11;
export const TRACK_RACK = 1;
const Q = 32767;
/* Metres from a terrain tile a pin still reaches into it (shape.c eases one
 * over at most this). */
const PIN_REACH = 80;
/* A whole segment, as the parts of it kept (ownSpans gives fewer). */
const WHOLE = Object.freeze([0, 1]);

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const l = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI);
};
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

/* The block and segment in hand (scratch): the block, its extent and its tiles across, the terrain tile's corner and
 * quantized units a degree, the segment's start and way in block units. */
const place = { b: null, E: 1, n: 1, west: 0, south: 0, du: 0, dv: 0, ax: 0, ay: 0, sx: 0, sy: 0 };
const ownScratch = [];
const cutScratch = new Float64Array(6);

/**
 * Pieces over `rect` from the given blocks, appended to `out` (a growable
 * { data: Float32Array, count }), which is returned.
 * @param blocks  [{ block: Uint8Array, z, x, y, id, owners? }]: `id` keeps their lines apart; `owners` says which of
 *                the block's eight neighbours are among the blocks too (neighboursIn), 0 or none for none
 * @param kinds   per kind number: { shape, half, grade, priority } or null (see tiles.js)
 * @param widths  half-widths by width class (the segments' exact-width code), metres
 * @param tracks  where the railways' track pieces go (TRACK_FLOATS each, the same growable kind as `out`), or null
 *                for none: one a segment on the ground of a kind with a gauge, one a stretch of a known deck
 */
export function piecesFor(blocks, rect, kinds, widths, out = { data: new Float32Array(1024 * PIECE_FLOATS), count: 0 }, tracks = null) {
  const du = Q / (rect.east - rect.west), dv = Q / (rect.north - rect.south);
  const c = place;
  for (const b of blocks) {
    const bytes = b.block;
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    const E = u32[BLOCK.extent], G = u32[BLOCK.grid], n = 2 ** b.z;
    const cells = u32[BLOCK.cellsOff] / 4, refs = u32[BLOCK.refsOff] / 2, segs = u32[BLOCK.segmentsOff] / 4;
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 1);
    const arcs = b.arcs ??= segmentArcs(bytes), mpu = f32[BLOCK.metresPerUnit];
    const owners = b.owners ?? 0;
    // The terrain tile in this block's units, a cell's reach beyond it.
    const tx = (lon) => (mercX(lon) * n - b.x) * E, ty = (lat) => (mercY(lat) * n - b.y) * E;
    const cell = E / G;
    const i0 = Math.max(0, Math.floor(tx(rect.west) / cell) - 1), i1 = Math.min(G - 1, Math.floor(tx(rect.east) / cell) + 1);
    const j0 = Math.max(0, Math.floor(ty(rect.north) / cell) - 1), j1 = Math.min(G - 1, Math.floor(ty(rect.south) / cell) + 1);
    if (i0 > i1 || j0 > j1) continue;
    c.b = b; c.E = E; c.n = n; c.west = rect.west; c.south = rect.south; c.du = du; c.dv = dv;
    const seen = b.seen ??= new Uint32Array(u32[BLOCK.segmentCount]);
    const stamp = (b.stamp = (b.stamp ?? 0) + 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const w = u32[cells + j * G + i], first = w >>> 8, count = w & 255;
        for (let k = 0; k < count; k++) {
          const s = u16[refs + first + k];
          if (seen[s] === stamp) continue;
          seen[s] = stamp;
          const o = segs + s * 8, attr = u32[o + 6];
          const kind = kinds[attr & 63];
          if (!kind || !kind.shape) continue;
          c.ax = f32[o]; c.ay = f32[o + 1]; c.sx = f32[o + 2] - c.ax; c.sy = f32[o + 3] - c.ay;
          const a0 = arcs[s], span = Math.hypot(c.sx, c.sy) * mpu;
          const code = attr >>> 28;
          const half = (code ? widths[code] : kind.half) + kind.bench;
          if (!(half > 0)) continue;
          const line = u32[o + 7] & 0xffff, id = b.id * 65536 + line;
          // The parts of it that are this block's (see the top).
          const own = owners && !insideSquare(c) ? ownSpans(c, owners, ownScratch) : WHOLE;
          if (!own.length) continue;
          // Bridges, tunnels and fords are not on the ground; a bridge's stretch past the end of its deck is
          // (bridges.js), and a railway's track runs on over the deck where it is known.
          let f0 = 0, f1 = 1;
          const brunnel = (attr >>> 6) & 3;
          if (brunnel) {
            if (!(span > 1e-6)) continue;
            if (brunnel === 1 && tracks && kind.gauge > 0) {
              const deck = b.decks ? b.decks.get(s) : null;
              if (deck) deckTrack(tracks, c, deck, own, a0, span, kind, id);
            }
            const gap = brunnel === 1 && b.gaps ? b.gaps.get(s) : null;
            if (!gap) continue;
            f0 = Math.max(0, (gap[0] - a0) / span);
            f1 = Math.min(1, (gap[1] - a0) / span);
            if (f1 - f0 <= 1e-4) continue;
          }
          for (let q = 0; q < own.length; q += 2) {
            const g0 = Math.max(f0, own[q]), g1 = Math.min(f1, own[q + 1]);
            if (g1 - g0 <= 1e-6) continue;
            // The railway's track over it (5.18b: track.c builds it on the ground cut here), the whole stretch at once.
            if (tracks && kind.gauge > 0) pushTrack(tracks, c, g0, g1, a0, span, kind, id, NaN, NaN);
            // In front of a tunnel's portal, stretches at the widths its level cut takes (portals.js); else one.
            const parts = b.widen && span > 1e-6 ? stretchesOf(b.widen, line, a0 + span * g0, a0 + span * g1, half, stretches) : null;
            for (let r = 0, m = parts ? parts.length : 3; r < m; r += 3) {
              const p0 = parts ? (parts[r] - a0) / span : g0, p1 = parts ? (parts[r + 1] - a0) / span : g1;
              // (A piece ending at a tunnel's portal ends square there: shape.c, by the portal's pin on its line.)
              pushPiece(out, c, p0, p1, a0, span, parts ? parts[r + 2] : half, kind, id);
            }
          }
        }
      }
    }
    const cosLat = Math.cos(((rect.south + rect.north) / 2) * Math.PI / 180);
    const mu = (PIN_REACH * du) / (111320 * cosLat), mv = (PIN_REACH * dv) / 111132;
    // The block's tunnel portals' aprons and open cuttings near the tile (portals.js: the landing in front of a portal,
    // and the cutting from it to where its tube starts, as wide as its road's widening), as pieces of their own lines.
    const aprons = b.aprons;
    for (let k = 0; aprons && k + APRON_FLOATS <= aprons.length; k += APRON_FLOATS) {
      const u0 = ((b.x + aprons[k] / E) / n) * 360 - 180, v0 = latOf((b.y + aprons[k + 1] / E) / n);
      const u1 = ((b.x + aprons[k + 2] / E) / n) * 360 - 180, v1 = latOf((b.y + aprons[k + 3] / E) / n);
      const pu0 = (u0 - rect.west) * du, pv0 = (v0 - rect.south) * dv, pu1 = (u1 - rect.west) * du, pv1 = (v1 - rect.south) * dv;
      if (Math.max(pu0, pu1) < -mu || Math.min(pu0, pu1) > Q + mu || Math.max(pv0, pv1) < -mv || Math.min(pv0, pv1) > Q + mv) continue;
      const p = room(out, PIECE_FLOATS), at = out.count * PIECE_FLOATS;
      p[at] = pu0; p[at + 1] = pv0; p[at + 2] = pu1; p[at + 3] = pv1;
      p[at + 4] = aprons[k + 4];
      p[at + 5] = aprons[k + 5];
      p[at + 6] = aprons[k + 6];
      p[at + 7] = aprons[k + 7];
      p[at + 8] = aprons[k + 8];
      p[at + 9] = b.id * 65536 + aprons[k + 9];
      out.count++;
    }
    // The block's pins near the tile.
    const pins = b.pins;
    if (!pins) continue;
    for (let k = 0; k + PIN_FLOATS <= pins.length; k += PIN_FLOATS) {
      const px = (b.x + pins[k] / E) / n, py = (b.y + pins[k + 1] / E) / n;
      const u = (px * 360 - 180 - rect.west) * du, v = (latOf(py) - rect.south) * dv;
      if (u < -mu || u > Q + mu || v < -mv || v > Q + mv) continue;
      const p = room(out, PIECE_FLOATS), at = out.count * PIECE_FLOATS;
      p[at] = p[at + 2] = u;
      p[at + 1] = p[at + 3] = v;
      p[at + 4] = pins[k + 2];
      p[at + 5] = pins[k + 3];
      p[at + 6] = pins[k + 6];     // the side the ground is on (shape.c reads the road's height there)
      p[at + 7] = pins[k + 4];
      p[at + 8] = -1;
      p[at + 9] = b.id * 65536 + pins[k + 5];
      out.count++;
    }
  }
  return out;
}

/**
 * Which of a tile's eight neighbours are among `tiles` too, as piecesFor's `owners`: bit (dy + 1) * 3 + dx + 1 for
 * the one dx, dy tiles away. `tiles`: records { x, y } of one zoom (nulls skipped); `t` one of them.
 */
export function neighboursIn(tiles, t) {
  let bits = 0;
  for (const u of tiles) {
    if (!u || u === t) continue;
    const dx = u.x - t.x, dy = u.y - t.y;
    if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) bits |= 1 << ((dy + 1) * 3 + dx + 1);
  }
  return bits;
}

/* A growable { data, count } with room for one more of `floats` floats: its data, grown if need be. */
function room(buf, floats) {
  if (buf.count * floats + floats > buf.data.length) {
    const grown = new Float32Array(buf.data.length * 2);
    grown.set(buf.data);
    buf.data = grown;
  }
  return buf.data;
}

/* The point a fraction f along the segment in hand, in the terrain tile's quantized units, into arr[i], arr[i + 1]. */
function tileUnits(c, f, arr, i) {
  const mx = (c.b.x + (c.ax + c.sx * f) / c.E) / c.n, my = (c.b.y + (c.ay + c.sy * f) / c.E) / c.n;
  arr[i] = (mx * 360 - 180 - c.west) * c.du;
  arr[i + 1] = (latOf(my) - c.south) * c.dv;
}

/* A road piece: the segment in hand from fraction f0 to f1, held level `half` either side. */
function pushPiece(out, c, f0, f1, a0, span, half, kind, id) {
  const p = room(out, PIECE_FLOATS), at = out.count * PIECE_FLOATS;
  tileUnits(c, f0, p, at);
  tileUnits(c, f1, p, at + 2);
  p[at + 4] = a0 + span * f0;
  p[at + 5] = a0 + span * f1;
  p[at + 6] = half;
  p[at + 7] = kind.grade;
  p[at + 8] = kind.priority;
  p[at + 9] = id;
  out.count++;
}

/* A track piece: the segment in hand from fraction f0 to f1, on the deck's top h0..h1 (NaN: on the ground). */
function pushTrack(tracks, c, f0, f1, a0, span, kind, id, h0, h1) {
  const t = room(tracks, TRACK_FLOATS), at = tracks.count * TRACK_FLOATS;
  tileUnits(c, f0, t, at);
  tileUnits(c, f1, t, at + 2);
  t[at + 4] = a0 + span * f0;
  t[at + 5] = a0 + span * f1;
  t[at + 6] = kind.gauge;
  t[at + 7] = kind.rack ? TRACK_RACK : 0;
  t[at + 8] = id;
  t[at + 9] = h0;
  t[at + 10] = h1;
  tracks.count++;
}

/* A railway's track over a bridge's deck: a piece between each two points of the deck's profile along the line
 * ([s, top, …], kept where the deck bends) over the segment's own parts, each end on the deck's top there. */
function deckTrack(tracks, c, deck, own, a0, span, kind, id) {
  const a1 = a0 + span;
  for (let k = 0; k + 3 < deck.length; k += 2) {
    const s0 = Math.max(deck[k], a0), s1 = Math.min(deck[k + 2], a1);
    if (s1 - s0 <= 0.01) continue;
    for (let q = 0; q < own.length; q += 2) {
      const f0 = Math.max((s0 - a0) / span, own[q]), f1 = Math.min((s1 - a0) / span, own[q + 1]);
      if (f1 - f0 <= 1e-6) continue;
      pushTrack(tracks, c, f0, f1, a0, span, kind, id, deckAt(deck, k, a0 + span * f0), deckAt(deck, k, a0 + span * f1));
    }
  }
}

/* The deck's top at s along its line, from its profile's points k and k + 1. */
const deckAt = (d, k, s) => d[k + 1] + ((d[k + 3] - d[k + 1]) * (s - d[k])) / (d[k + 2] - d[k] || 1);

/* Whether the segment in hand lies wholly inside its block's own square. */
function insideSquare(c) {
  const E = c.E, bx = c.ax + c.sx, by = c.ay + c.sy;
  return c.ax >= 0 && c.ax <= E && c.ay >= 0 && c.ay <= E && bx >= 0 && bx <= E && by >= 0 && by <= E;
}

/**
 * The parts of the segment in hand that are its block's, as fractions [from, to, …] in `out` (merged): inside the
 * block's square, or over a neighbour's square that is not among the blocks (`owners`). The segment is cut where it
 * crosses the square's edges, so each part lies over one tile's square.
 */
function ownSpans(c, owners, out) {
  const E = c.E, ax = c.ax, ay = c.ay, dx = c.sx, dy = c.sy, ts = cutScratch;
  let n = 0;
  ts[n++] = 0;
  if (dx !== 0) { n = cutAt(ts, n, -ax / dx); n = cutAt(ts, n, (E - ax) / dx); }
  if (dy !== 0) { n = cutAt(ts, n, -ay / dy); n = cutAt(ts, n, (E - ay) / dy); }
  ts[n++] = 1;
  for (let i = 1; i < n; i++) {
    const v = ts[i];
    let j = i;
    while (j > 0 && ts[j - 1] > v) { ts[j] = ts[j - 1]; j--; }
    ts[j] = v;
  }
  out.length = 0;
  for (let i = 0; i + 1 < n; i++) {
    const t0 = ts[i], t1 = ts[i + 1];
    if (t1 - t0 <= 1e-9) continue;
    const m = (t0 + t1) / 2, x = ax + dx * m, y = ay + dy * m;
    const square = (y < 0 ? 0 : y > E ? 6 : 3) + (x < 0 ? 0 : x > E ? 2 : 1);
    if (square !== 4 && owners & (1 << square)) continue;   // that tile's own copy is cut in too
    if (out.length && out[out.length - 1] === t0) out[out.length - 1] = t1;
    else out.push(t0, t1);
  }
  return out;
}

/* ts[n] = t where t lies inside the segment (0 < t < 1); the new count. */
function cutAt(ts, n, t) {
  if (t > 0 && t < 1) ts[n++] = t;
  return n;
}

/* A segment's stretches in front of a tunnel's portal (scratch: [s from, s to, half-width, …]). */
const stretches = [];
const cutsScratch = [];
/* Steps the widening narrows back to the road's own width in, over WIDEN_FULL..WIDEN_TO metres out. */
const TAPER_STEPS = 4;

/* The half-width a portal's widening (portals.js: line, s, dir, half at WIDEN_FLOATS k) gives the road at distance x
 * along its line (its own `half` where it gives less or does not reach). */
function widenedAt(widen, k, x, half) {
  const d = (x - widen[k + 1]) * widen[k + 2], wide = widen[k + 3];
  if (d < -1e-6 || d > WIDEN_TO) return half;
  if (d <= WIDEN_FULL) return Math.max(half, wide);
  return Math.max(half, wide - ((wide - half) * (d - WIDEN_FULL)) / (WIDEN_TO - WIDEN_FULL));
}

/**
 * The stretches of a segment from sA to sB along its line (metres) with the half-widths its level cut takes, where a
 * portal's widening reaches it: [s from, s to, half, …] in `out` (each stretch the width at its end nearer the
 * portal: steps of a quarter of the narrowing); null where none reaches it.
 */
function stretchesOf(widen, line, sA, sB, half, out) {
  const cuts = cutsScratch;
  cuts.length = 0;
  for (let k = 0; k + WIDEN_FLOATS <= widen.length; k += WIDEN_FLOATS) {
    if (widen[k] !== line || !(widen[k + 3] > half)) continue;
    const sp = widen[k + 1], dir = widen[k + 2];
    const lo = dir > 0 ? sp : sp - WIDEN_TO, hi = dir > 0 ? sp + WIDEN_TO : sp;
    if (hi <= sA || lo >= sB) continue;
    cuts.push(sp, sp + dir * WIDEN_FULL);
    for (let t = 1; t <= TAPER_STEPS; t++) cuts.push(sp + dir * (WIDEN_FULL + ((WIDEN_TO - WIDEN_FULL) * t) / TAPER_STEPS));
  }
  if (!cuts.length) return null;
  const xs = [sA];
  for (const c of cuts) if (c > sA + 1e-3 && c < sB - 1e-3) xs.push(c);
  xs.push(sB);
  xs.sort((a, b) => a - b);
  out.length = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const x0 = xs[i], x1 = xs[i + 1];
    if (x1 - x0 < 1e-3) continue;
    let h = half;
    for (let k = 0; k + WIDEN_FLOATS <= widen.length; k += WIDEN_FLOATS) {
      if (widen[k] !== line) continue;
      // The end nearer the portal (out of it along the road) takes the wider width.
      const near = (x0 - widen[k + 1]) * widen[k + 2] <= (x1 - widen[k + 1]) * widen[k + 2] ? x0 : x1;
      h = Math.max(h, widenedAt(widen, k, near, half));
    }
    out.push(x0, x1, h);
  }
  return out;
}
