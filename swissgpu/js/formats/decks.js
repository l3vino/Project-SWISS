/* decks.js — the tops of a tile's bridge decks, as heights on a grid.
 *
 * Runs on a decode thread, for the tiles of a layer whose upward faces are
 * bridge decks (the adapter's `decks`: swissTLM3D's structures). Every
 * triangle facing up (its normal within UP_MOST of straight up) is sampled
 * at the points of a DECK_STEP-metre grid of the tile's local frame (x
 * east, y north, z up) that it covers, and each point keeps the highest such
 * surface: the deck's top. On the render thread (engine/features/decks.js)
 * they say how high a deck is at a place, which the terrain needs where a
 * road comes off a bridge (engine/vector/tiles.js): there the road on the
 * ground starts at the deck's height, whatever the ground under the
 * bridge's last metres does.
 *
 * Out: the grid points that have a deck, as sorted keys (column and row,
 * offset by DECK_OFFSET, in 16 bits each) and their heights (local z), or
 * null. A bridge of 100 by 10 metres is some 250 points, 2 KB.
 */

export const DECK_STEP = 2;
const DECK_OFFSET = 32768;
const UP_MOST = Math.cos((25 * Math.PI) / 180);

/**
 * @param positions  local positions, three floats a vertex
 * @param indices    three a triangle
 * @param features   each vertex's feature
 * @param skip       per feature, true to leave it out (hidden, or cable cars)
 * @returns { step, keys: Uint32Array, heights: Float32Array } or null
 */
export function deckPoints(positions, indices, features, skip) {
  const grid = new Map();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    if (skip && skip[features[indices[t]]]) continue;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, wx = cx - ax, wy = cy - ay, wz = cz - az;
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    // Up only (either winding): decks, not walls or undersides.
    if (!(len > 0) || Math.abs(nz) / len < UP_MOST) continue;
    const i0 = Math.ceil(Math.min(ax, bx, cx) / DECK_STEP), i1 = Math.floor(Math.max(ax, bx, cx) / DECK_STEP);
    const j0 = Math.ceil(Math.min(ay, by, cy) / DECK_STEP), j1 = Math.floor(Math.max(ay, by, cy) / DECK_STEP);
    if (i0 > i1 || j0 > j1) continue;
    const d = uy * wx - ux * wy;   // twice the signed area in plan, negated
    if (d === 0) continue;
    for (let j = j0; j <= j1; j++) {
      const y = j * DECK_STEP;
      for (let i = i0; i <= i1; i++) {
        const x = i * DECK_STEP;
        // Barycentric weights of (x, y) in the plan of the triangle.
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / -d;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / -d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        const z = l1 * az + l2 * bz + l3 * cz;
        const key = ((i + DECK_OFFSET) << 16 | (j + DECK_OFFSET)) >>> 0;
        const was = grid.get(key);
        if (was === undefined || z > was) grid.set(key, z);
      }
    }
  }
  if (!grid.size) return null;
  const keys = Uint32Array.from(grid.keys()).sort();
  const heights = new Float32Array(keys.length);
  for (let k = 0; k < keys.length; k++) heights[k] = grid.get(keys[k]);
  return { step: DECK_STEP, keys, heights };
}

/** The key of grid point (i, j), as deckPoints makes them. */
export const deckKey = (i, j) => ((i + DECK_OFFSET) << 16 | (j + DECK_OFFSET)) >>> 0;
