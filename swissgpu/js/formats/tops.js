/* tops.js — the highest point of a tile's content over each cell of a grid.
 *
 * Runs on a decode thread, for every 3D Tiles tile (tile-content.js). A
 * TOPS x TOPS grid is laid over the content's footprint in its local frame
 * (x east, y north, z up), and each cell holds the highest corner of every
 * triangle whose footprint box reaches it, and the highest point of every
 * rope or pylon piece passing over it: all of a triangle lies inside its
 * box and no higher than its highest corner, so nothing of the content over
 * a cell is above the cell's value. A cell nothing reaches holds -Infinity:
 * open air, which is most of a tile of cable cars or bridges.
 *
 * The terrain has the same grid, made in C (wasm/src/qm.c, qm_tops); a
 * flight keeps clear of both (engine/flight/obstacles.js).
 */

export const TOPS = 16;

/**
 * @param positions  local positions, three floats a vertex
 * @param indices    three a triangle
 * @param cables     { ropes, members } pieces (formats/lines.js: one end, its
 *                   radius, the other end, its shade), or null
 * @returns { cells: Float32Array(TOPS²), box: [x0, y0, x1, y1] }, or null
 *          when there is nothing at all
 */
export function topsGrid(positions, indices, cables = null) {
  const pieces = cables ? [cables.ropes, cables.members].filter(Boolean) : [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i] * 3, x = positions[v], y = positions[v + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  for (const P of pieces) {
    for (let k = 0; k + 8 <= P.length; k += 8) {
      const r = P[k + 3];
      for (const o of [k, k + 4]) {
        if (P[o] - r < x0) x0 = P[o] - r;
        if (P[o] + r > x1) x1 = P[o] + r;
        if (P[o + 1] - r < y0) y0 = P[o + 1] - r;
        if (P[o + 1] + r > y1) y1 = P[o + 1] + r;
      }
    }
  }
  if (!(x1 >= x0 && y1 >= y0)) return null;
  // A footprint a line wide still gets cells of some size.
  if (x1 - x0 < 1e-3) { x0 -= 0.5; x1 += 0.5; }
  if (y1 - y0 < 1e-3) { y0 -= 0.5; y1 += 0.5; }
  const cells = new Float32Array(TOPS * TOPS).fill(-Infinity);
  const sx = TOPS / (x1 - x0), sy = TOPS / (y1 - y0);
  const cell = (v, lo, s) => {
    const c = Math.floor((v - lo) * s);
    return c < 0 ? 0 : c >= TOPS ? TOPS - 1 : c;
  };
  const raise = (ax, ay, bx, by, top) => {
    const i0 = cell(ax, x0, sx), i1 = cell(bx, x0, sx), j0 = cell(ay, y0, sy), j1 = cell(by, y0, sy);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0, k = j * TOPS + i0; i <= i1; i++, k++) if (cells[k] < top) cells[k] = top;
    }
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], bx = positions[b], cx = positions[c];
    const ay = positions[a + 1], by = positions[b + 1], cy = positions[c + 1];
    raise(Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.max(ax, bx, cx), Math.max(ay, by, cy),
      Math.max(positions[a + 2], positions[b + 2], positions[c + 2]));
  }
  for (const P of pieces) {
    for (let k = 0; k + 8 <= P.length; k += 8) {
      const r = P[k + 3];
      raise(Math.min(P[k], P[k + 4]) - r, Math.min(P[k + 1], P[k + 5]) - r,
        Math.max(P[k], P[k + 4]) + r, Math.max(P[k + 1], P[k + 5]) + r, Math.max(P[k + 2], P[k + 6]) + r);
    }
  }
  return { cells, box: [x0, y0, x1, y1] };
}
