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
 */

import { BLOCK, segmentArcs } from '../../formats/vector-tile.js';
import { PIN_FLOATS } from './bridges.js';
import { WIDEN_FLOATS, WIDEN_FULL, WIDEN_TO, APRON_FLOATS } from './portals.js';

export const PIECE_FLOATS = 10;
const Q = 32767;
/* Metres from a terrain tile a pin still reaches into it (shape.c eases one
 * over at most this). */
const PIN_REACH = 80;

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const l = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI);
};
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

/**
 * Pieces over `rect` from the given blocks, appended to `out` (a growable
 * { data: Float32Array, count }), which is returned.
 * @param blocks  [{ block: Uint8Array, z, x, y, id }]: `id` keeps their lines apart
 * @param kinds   per kind number: { shape, half, grade, priority } or null (see tiles.js)
 * @param widths  half-widths by width class (the segments' exact-width code), metres
 */
export function piecesFor(blocks, rect, kinds, widths, out = { data: new Float32Array(1024 * PIECE_FLOATS), count: 0 }) {
  const du = Q / (rect.east - rect.west), dv = Q / (rect.north - rect.south);
  for (const b of blocks) {
    const bytes = b.block;
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
    const E = u32[BLOCK.extent], G = u32[BLOCK.grid], n = 2 ** b.z;
    const cells = u32[BLOCK.cellsOff] / 4, refs = u32[BLOCK.refsOff] / 2, segs = u32[BLOCK.segmentsOff] / 4;
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 1);
    const arcs = b.arcs ??= segmentArcs(bytes), mpu = f32[BLOCK.metresPerUnit];
    // The terrain tile in this block's units, a cell's reach beyond it.
    const tx = (lon) => (mercX(lon) * n - b.x) * E, ty = (lat) => (mercY(lat) * n - b.y) * E;
    const cell = E / G;
    const i0 = Math.max(0, Math.floor(tx(rect.west) / cell) - 1), i1 = Math.min(G - 1, Math.floor(tx(rect.east) / cell) + 1);
    const j0 = Math.max(0, Math.floor(ty(rect.north) / cell) - 1), j1 = Math.min(G - 1, Math.floor(ty(rect.south) / cell) + 1);
    if (i0 > i1 || j0 > j1) continue;
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
          const sx = f32[o + 2] - f32[o], sy = f32[o + 3] - f32[o + 1];
          const a0 = arcs[s], span = Math.hypot(sx, sy) * mpu;
          // Bridges, tunnels and fords are not on the ground; a bridge's
          // stretch past the end of its deck is (bridges.js).
          let f0 = 0, f1 = 1;
          const brunnel = (attr >>> 6) & 3;
          if (brunnel) {
            const gap = brunnel === 1 && b.gaps ? b.gaps.get(s) : null;
            if (!gap || !(span > 1e-6)) continue;
            f0 = Math.max(0, (gap[0] - a0) / span);
            f1 = Math.min(1, (gap[1] - a0) / span);
            if (f1 - f0 <= 1e-4) continue;
          }
          const code = attr >>> 28;
          const half = (code ? widths[code] : kind.half) + kind.bench;
          if (!(half > 0)) continue;
          const line = u32[o + 7] & 0xffff;
          // In front of a tunnel's portal, stretches at the widths its level cut takes (portals.js); else one.
          const parts = b.widen && span > 1e-6 ? stretchesOf(b.widen, line, a0 + span * f0, a0 + span * f1, half, stretches) : null;
          for (let q = 0, m = parts ? parts.length : 3; q < m; q += 3) {
            const g0 = parts ? (parts[q] - a0) / span : f0, g1 = parts ? (parts[q + 1] - a0) / span : f1;
            if (out.count * PIECE_FLOATS + PIECE_FLOATS > out.data.length) {
              const grown = new Float32Array(out.data.length * 2);
              grown.set(out.data);
              out.data = grown;
            }
            const p = out.data, at = out.count * PIECE_FLOATS;
            const ax = (b.x + (f32[o] + sx * g0) / E) / n, ay = (b.y + (f32[o + 1] + sy * g0) / E) / n;
            const bx = (b.x + (f32[o] + sx * g1) / E) / n, by = (b.y + (f32[o + 1] + sy * g1) / E) / n;
            p[at] = (ax * 360 - 180 - rect.west) * du;
            p[at + 1] = (latOf(ay) - rect.south) * dv;
            p[at + 2] = (bx * 360 - 180 - rect.west) * du;
            p[at + 3] = (latOf(by) - rect.south) * dv;
            p[at + 4] = a0 + span * g0;
            p[at + 5] = a0 + span * g1;
            // (A piece ending at a tunnel's portal ends square there: shape.c, by the portal's pin on its line.)
            p[at + 6] = parts ? parts[q + 2] : half;
            p[at + 7] = kind.grade;
            p[at + 8] = kind.priority;
            p[at + 9] = b.id * 65536 + line;
            out.count++;
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
      if (out.count * PIECE_FLOATS + PIECE_FLOATS > out.data.length) {
        const grown = new Float32Array(out.data.length * 2);
        grown.set(out.data);
        out.data = grown;
      }
      const p = out.data, at = out.count * PIECE_FLOATS;
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
      if (out.count * PIECE_FLOATS + PIECE_FLOATS > out.data.length) {
        const grown = new Float32Array(out.data.length * 2);
        grown.set(out.data);
        out.data = grown;
      }
      const p = out.data, at = out.count * PIECE_FLOATS;
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
