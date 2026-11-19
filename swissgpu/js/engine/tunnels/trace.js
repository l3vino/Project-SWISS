/* trace.js — a tunnel followed beyond the tiles round the camera, to its
 * portals.
 *
 * A tube (groups.js) whose end runs on past the detail tiles still needs its
 * far portal: the floor's height along it comes from both portals' ground
 * (heights.js), and a long tunnel's far portal lies many kilometres off (the
 * Gotthard road tunnel 16.9 km, the Gotthard base tunnel 57 km). It is
 * followed through TRACE_ZOOM tiles (z13: the same tunnels as z14 in a
 * quarter of the bytes, a tile ~3.4 km wide here): the tile round a point
 * inside it, then the tile beyond each end of the tube found there that runs
 * on (OPEN), until both ends are portals (or closed, or joined to another
 * tunnel), at most TRACE_MOST tiles. The tubes are made from the runs
 * gathered so far each time (groups.js), so the tiles are joined, double
 * tracks are one bore and branches their own exactly as near the camera.
 * Runs on a decode thread (workers/codec.js, 'tunnel-trace'), which fetches
 * and decodes the tiles and keeps the answers (IndexedDB).
 */

import { tubesFrom, TUBE_END, TUBE_POINT } from './groups.js';

export const TRACE_ZOOM = 13;
const TRACE_MOST = 40;
/* Metres the traced tube may pass from the point asked for (z13 lines are
 * simplified a little more than z14's), and how far beyond a tube's open end
 * the next tile is looked for. */
const MATCH = 30;
const BEYOND = 20;

const M_LAT = 111132;

/**
 * The whole tube a point inside a tunnel belongs to.
 * @param tileRuns  async (z, x, y) => the tile's runs (runs.js), [] if it has none, null if it is missing
 * @param family    'road' or 'rail'
 * @param lon, lat  a point inside the tunnel (best a little beyond the open end of the tube near the camera)
 * @returns { tube (groups.js, the whole tunnel), tiles: how many were read, done: both ends found } or null
 */
export async function traceTunnel(tileRuns, family, lon, lat, { zoom = TRACE_ZOOM, most = TRACE_MOST } = {}) {
  const runs = [], seen = new Set(), queue = [tileOf(lon, lat, zoom)];
  let tube = null;
  while (queue.length && seen.size < most) {
    const t = queue.shift(), key = `${t.x}/${t.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const got = await tileRuns(zoom, t.x, t.y);
    if (got) for (const r of got) if (r.family === family) runs.push(r);
    tube = nearestTube(tubesFrom(runs), lon, lat, family);
    if (!tube) continue;
    for (const e of tube.ends) {
      if (e.type !== TUBE_END.OPEN) continue;
      const m = 111320 * Math.cos((e.lat * Math.PI) / 180);
      const next = tileOf(e.lon + (e.dirX * BEYOND) / m, e.lat + (e.dirY * BEYOND) / M_LAT, zoom);
      if (!seen.has(`${next.x}/${next.y}`)) queue.push(next);
    }
  }
  if (!tube) return null;
  return { tube, tiles: seen.size, done: tube.ends.every((e) => e.type !== TUBE_END.OPEN) };
}

/**
 * Where a point lies along a tube: metres along its spine, metres off it (and right of it, `across`), the
 * spine's way there, and which piece of it (`k`). Looks round piece `near` first when given (a point that moves
 * a little each time), the whole spine if the point is not beside it there.
 * @returns { s, off, across, dirX, dirY, k, extra, middle (the bore's middle, metres right of the spine) }
 */
export function placeOn(tube, lon, lat, near = -1, out = {}) {
  const p = tube.points, n = p.length / TUBE_POINT;
  const m = 111320 * Math.cos((lat * Math.PI) / 180);
  out.off = Infinity;
  const look = (from, to) => {
    for (let k = Math.max(0, from); k + 1 < Math.min(n, to); k++) {
      const a = k * TUBE_POINT, b = a + TUBE_POINT;
      const ax = (p[a] - lon) * m, ay = (p[a + 1] - lat) * M_LAT, ux = (p[b] - p[a]) * m, uy = (p[b + 1] - p[a + 1]) * M_LAT;
      const L2 = ux * ux + uy * uy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * ux + ay * uy) / L2)) : 0;
      const off = Math.hypot(ax + ux * t, ay + uy * t);
      if (off < out.off) {
        const l = Math.sqrt(L2) || 1, dx = ux / l, dy = uy / l;
        out.s = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
        out.off = off;
        // Right of the way along is (dy, -dx); the point is -(a + u t) from the spine.
        out.across = -((ax + ux * t) * dy - (ay + uy * t) * dx);
        out.dirX = dx; out.dirY = dy; out.k = k;
        out.middle = p[a + 3] + (p[b + 3] - p[a + 3]) * t;
        out.extra = p[a + 4] + (p[b + 4] - p[a + 4]) * t;
      }
    }
  };
  if (near >= 0) {
    look(near - 24, near + 25);
    // At either end of the window and not at the spine's ends: the point may be nearer elsewhere.
    if (out.k > near - 24 && out.k < near + 23 || out.k === 0 || out.k === n - 2) return out;
  }
  look(0, n);
  if (!Number.isFinite(out.off)) Object.assign(out, { s: 0, across: 0, dirX: 1, dirY: 0, k: 0, middle: 0, extra: 0 });
  return out;
}

/* The tube of the family passing nearest the point, within MATCH. */
function nearestTube(tubes, lon, lat, family) {
  let best = null, bestOff = MATCH;
  for (const t of tubes) {
    if (t.family !== family) continue;
    const { off } = placeOn(t, lon, lat);
    if (off <= bestOff) { bestOff = off; best = t; }
  }
  return best;
}

/* The tile of a zoom round a point (Web Mercator). */
export function tileOf(lon, lat, z) {
  const n = 2 ** z, r = (lat * Math.PI) / 180;
  return {
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    y: Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n))),
  };
}
