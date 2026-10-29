/* decks.js — how high a bridge's deck is at a place, from the bridge layers'
 * tiles as drawn.
 *
 * The terrain model has no bridges (it is the bare ground), and where a road
 * comes off one the ground under the bridge's last metres can fall away or
 * rise; the vector tiles say where a bridge is, not how high. So where a
 * road leaves a bridge, the road tiles (engine/vector/tiles.js) ask here for
 * the deck's height and pin the road on the ground to it. The heights are
 * the tops of the decks the bridge layer's tiles hold (formats/decks.js: a
 * 2 m grid in each tile's local frame), whatever their level of detail, so
 * a bridge far from the camera has one as soon as any tile of it is in;
 * where tiles of several levels overlap, the finest answers.
 */

import { geodeticToEcef } from '../../core/math.js';
import { deckKey } from '../../formats/decks.js';

export class Decks {
  /** @param tilesets  the feature layers (features/tileset.js); those of the adapter's `decks` count */
  constructor(tilesets) {
    this.tilesets = tilesets;
    this.p = new Float64Array(3);
  }

  /** Whether any layer of bridges is on at all. */
  get active() { return this.tilesets.some((t) => t.spec.decks && t.enabled); }

  /**
   * Where decks came or went since the last call: rectangles [west, south,
   * east, north] in degrees, the list taken (so ask once a frame).
   */
  changes(out = []) {
    out.length = 0;
    for (const t of this.tilesets) {
      if (!t.spec.decks || !t.deckChanges?.length) continue;
      for (const r of t.deckChanges) out.push(r);
      t.deckChanges.length = 0;
    }
    return out;
  }

  /**
   * The height (metres above the ellipsoid, like the terrain's) of the top of
   * a deck at (lon, lat), from the finest tile holding one there; with
   * `near`, only a deck within `within` metres of that height. NaN if none.
   */
  heightAt(lon, lat, near = NaN, within = Infinity) {
    let best = NaN, bestError = Infinity;
    const p = geodeticToEcef(lon, lat, 0, this.p);
    for (const t of this.tilesets) {
      if (!t.spec.decks || !t.enabled) continue;
      for (const node of t.deckNodes) {
        const d = node.decks, b = d.box;
        if (lon < b[0] || lat < b[1] || lon > b[2] || lat > b[3] || d.error >= bestError) continue;
        // The place in the tile's frame: the ground there (height 0) is at
        // local z0, so a deck at local z is z - z0 above the ellipsoid.
        const o = d.origin, dx = p[0] - o[0], dy = p[1] - o[1], dz = p[2] - o[2];
        const x = dx * d.east[0] + dy * d.east[1] + dz * d.east[2];
        const y = dx * d.north[0] + dy * d.north[1] + dz * d.north[2];
        const z0 = dx * d.up[0] + dy * d.up[1] + dz * d.up[2];
        const z = deckAt(d, x, y);
        if (Number.isNaN(z)) continue;
        const h = z - z0;
        if (!Number.isNaN(near) && Math.abs(h - near) > within) continue;
        best = h;
        bestError = d.error;
      }
    }
    return best;
  }
}

/* A tile's deck top at local (x, y): bilinear between the four grid points
 * round it where all four have a deck, the nearest of them that has one
 * otherwise, NaN if none does. */
function deckAt(d, x, y) {
  const fx = x / d.step, fy = y / d.step;
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const z00 = find(d, i, j), z10 = find(d, i + 1, j), z01 = find(d, i, j + 1), z11 = find(d, i + 1, j + 1);
  if (!Number.isNaN(z00 + z10 + z01 + z11)) return (z00 * (1 - u) + z10 * u) * (1 - v) + (z01 * (1 - u) + z11 * u) * v;
  const near = [[z00, u + v], [z10, 1 - u + v], [z01, u + 1 - v], [z11, 2 - u - v]];
  let z = NaN, best = Infinity;
  for (const [h, w] of near) if (!Number.isNaN(h) && w < best) { best = w; z = h; }
  return z;
}

/* A grid point's height, NaN if it has no deck (keys are sorted). */
function find(d, i, j) {
  const key = deckKey(i, j), keys = d.keys;
  let lo = 0, hi = keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, k = keys[mid];
    if (k === key) return d.heights[mid];
    if (k < key) lo = mid + 1; else hi = mid - 1;
  }
  return NaN;
}
