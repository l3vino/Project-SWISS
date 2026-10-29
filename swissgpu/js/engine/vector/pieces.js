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
 * -1: its place, its distance along the line, the height; shape.c).
 */

import { BLOCK, segmentArcs } from '../../formats/vector-tile.js';
import { PIN_FLOATS } from './bridges.js';

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
          if (out.count * PIECE_FLOATS + PIECE_FLOATS > out.data.length) {
            const grown = new Float32Array(out.data.length * 2);
            grown.set(out.data);
            out.data = grown;
          }
          const p = out.data, at = out.count * PIECE_FLOATS;
          const ax = (b.x + (f32[o] + sx * f0) / E) / n, ay = (b.y + (f32[o + 1] + sy * f0) / E) / n;
          const bx = (b.x + (f32[o] + sx * f1) / E) / n, by = (b.y + (f32[o + 1] + sy * f1) / E) / n;
          p[at] = (ax * 360 - 180 - rect.west) * du;
          p[at + 1] = (latOf(ay) - rect.south) * dv;
          p[at + 2] = (bx * 360 - 180 - rect.west) * du;
          p[at + 3] = (latOf(by) - rect.south) * dv;
          p[at + 4] = a0 + span * f0;
          p[at + 5] = a0 + span * f1;
          p[at + 6] = half;
          p[at + 7] = kind.grade;
          p[at + 8] = kind.priority;
          p[at + 9] = b.id * 65536 + (u32[o + 7] & 0xffff);
          out.count++;
        }
      }
    }
    // The block's pins near the tile.
    const pins = b.pins;
    if (!pins) continue;
    const cosLat = Math.cos(((rect.south + rect.north) / 2) * Math.PI / 180);
    const mu = (PIN_REACH * du) / (111320 * cosLat), mv = (PIN_REACH * dv) / 111132;
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
      p[at + 6] = 0;
      p[at + 7] = pins[k + 4];
      p[at + 8] = -1;
      p[at + 9] = b.id * 65536 + pins[k + 5];
      out.count++;
    }
  }
  return out;
}
