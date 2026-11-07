/* cuts.js — the room a tube takes, as the terrain and what is built are cut
 * away from it (Stage 5.17d; the terrain 5.17e).
 *
 * His words (on 5.17c): "it should be able to traverse building walls (like
 * the underground castle wall)"; on 5.17d: "there is weird terrain
 * triangles/Parts inside the tunnel (so that tunnel is not cutting
 * cleanly)", "tunnels kind of disappear at certain view angles". Neither
 * the terrain nor the building layers know anything of the tunnels: the
 * ground over a shallow tube dips into it wherever its tiles are coarser or
 * its fit left it thin, and a castle's wall modelled down into the hill
 * stands across the railway's tunnel under it. So each tube's bore is a
 * chain of points along its middle at its floor, each with its outline
 * there (sections.js outlineAt: as wide as the mesh makes the bore at that
 * point), the mesh's own points (mesh.js meshPoints: straight between them,
 * as the mesh is), run on out of each portal to its collar and CUT_PAST
 * beyond (a wall the portal stands in; not the terrain: the road in front
 * of the portal is its own). Each tile drawn (passes/terrain.js, the
 * terrain at every level; passes/buildings.js) gets the segments of it that
 * reach its box, in its own frame (cutsInFrame), in a storage buffer shared
 * by every tile; its fragments inside the bore are not drawn (terrain.wgsl,
 * buildings.wgsl fsCut). Where the ground stands DEEP metres over the vault
 * (a mountain over a tunnel), no tile reaches the bore and nothing is cut.
 * Like Unity's terrain holes, the room counts for the bodies too (tunnels.js
 * boreAt, roomAt): inside a bore the tunnel's floor holds them, not the
 * terrain over it, and the solids of what is built there are left alone.
 */

import { geodeticToEcef } from '../../core/math.js';
import { outlineAt } from './sections.js';
import { POINT_DOUBLES, MESH_END } from './mesh.js';

/* Doubles a cut point: its middle at the floor (earth-centred, metres), then its outline: the walls' half-width and
 * top, the arch's middle up, half-width and half-height (sections.js outlineAt; archA 0 a flat roof). */
export const CUT_DOUBLES = 8;
/* Metres the cut of what is built runs on beyond a portal's collar (tunnels.js roomAt: the controllers leave the
 * solids alone there too). */
export const CUT_PAST = 1;
/* Floats a segment in a tile's frame (terrain.wgsl and buildings.wgsl Cut): its ends at the floor and their
 * half-widths, then each end's outline (top, archY, archA, archH). A negative top: the bore ends there (not run on a
 * little past it, as where two segments meet). */
export const CUT_FLOATS = 16;
/* Metres of ground over the vault from which on nothing reaches into the bore. */
const DEEP = 30;
/* Point flags: deep under the ground; beyond a portal (the collar and CUT_PAST out of it). */
const FLAG_DEEP = 1, FLAG_BEYOND = 2;

const M_LAT = 111132;
const metresLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * A tube's cut.
 * @param mp       mesh.js meshPoints' answer (points: lon, lat, floor, s, …, the bore's middle right of the line, how wide)
 * @param sec      its cross-section (sections.js)
 * @param ends     per end: { type (MESH_END), dirX, dirY (out of it, east and north), collar, rise } (collar and rise
 *                 only for a portal)
 * @param coverAt  (s along the tube) => metres of ground over its vault there (NaN not known), or null
 * @returns { points: Float64Array (CUT_DOUBLES each), flags: Uint8Array, count, centre: [x, y, z], radius }: a
 *          bounding sphere round it
 */
export function boreCut(mp, sec, ends, coverAt = null) {
  const p = mp.points, n = mp.count, out = [], flags = [];
  const put = (lon, lat, h, wide, flag) => {
    const e = geodeticToEcef(lon, lat, h), o = outlineAt(sec, wide);
    out.push(e[0], e[1], e[2], o.half, o.top, o.archY, o.archA, o.archH);
    flags.push(flag);
  };
  // The middle of the bore at point k: its offset right of the line (as the line runs there).
  const middle = (k) => {
    const a = Math.max(0, k - 1) * POINT_DOUBLES, b = Math.min(n - 1, k + 1) * POINT_DOUBLES, o = k * POINT_DOUBLES;
    const m = metresLon(p[o + 1]);
    const dx = (p[b] - p[a]) * m, dy = (p[b + 1] - p[a + 1]) * M_LAT, l = Math.hypot(dx, dy) || 1, off = p[o + 7];
    return [p[o] + (off * dy) / l / m, p[o + 1] - (off * dx) / l / M_LAT];
  };
  // Out of a portal: along its way out to the collar and CUT_PAST on, the floor rising as the approach does.
  const beyond = (k, end) => {
    if (end.type !== MESH_END.PORTAL) return;
    const o = k * POINT_DOUBLES, [lon, lat] = middle(k), d = Math.max(0, end.collar ?? 0) + CUT_PAST;
    put(lon + (end.dirX * d) / metresLon(lat), lat + (end.dirY * d) / M_LAT, p[o + 2] + (end.rise ?? 0) * d, p[o + 8], FLAG_BEYOND);
  };
  beyond(0, ends[0]);
  for (let k = 0; k < n; k++) {
    const [lon, lat] = middle(k), o = k * POINT_DOUBLES;
    const cover = coverAt ? coverAt(p[o + 3]) : NaN;
    put(lon, lat, p[o + 2], p[o + 8], cover > DEEP ? FLAG_DEEP : 0);
  }
  beyond(n - 1, ends[1]);
  const points = Float64Array.from(out), count = points.length / CUT_DOUBLES;
  const centre = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) centre[j] += points[i * CUT_DOUBLES + j] / count;
  let radius = 0, reach = 0;
  for (let i = 0; i < count; i++) {
    const o = i * CUT_DOUBLES;
    radius = Math.max(radius, Math.hypot(points[o] - centre[0], points[o + 1] - centre[1], points[o + 2] - centre[2]));
    reach = Math.max(reach, points[o + 3], points[o + 4], points[o + 5] + points[o + 7], points[o + 6]);
  }
  return { points, flags: Uint8Array.from(flags), count, centre, radius: radius + reach };
}

/**
 * The segments of the bores that reach a box, in its frame (CUT_FLOATS each), appended to `out` (an array).
 * @param cuts    boreCut answers
 * @param frame   { origin: [x, y, z] earth-centred, east, north, up: unit vectors }: the tile's
 * @param lo, size  the box in that frame (metres: its least corner and its size)
 * @param terrain  true: the terrain's (the bore not run on beyond its portals, nor past its ends)
 * @returns out
 */
export function cutsInFrame(cuts, frame, lo, size, terrain, out = []) {
  const o = frame.origin, e = frame.east, n = frame.north, u = frame.up;
  // The box's middle, earth-centred, and half its diagonal.
  const cx = lo[0] + size[0] / 2, cy = lo[1] + size[1] / 2, cz = lo[2] + size[2] / 2;
  const mid = [0, 1, 2].map((k) => o[k] + e[k] * cx + n[k] * cy + u[k] * cz);
  const reach = Math.hypot(size[0], size[1], size[2]) / 2 + MARGIN;
  const a = [0, 0, 0], b = [0, 0, 0];
  const local = (p, i, q) => {
    const dx = p[i] - o[0], dy = p[i + 1] - o[1], dz = p[i + 2] - o[2];
    q[0] = dx * e[0] + dy * e[1] + dz * e[2];
    q[1] = dx * n[0] + dy * n[1] + dz * n[2];
    q[2] = dx * u[0] + dy * u[1] + dz * u[2];
  };
  for (const cut of cuts) {
    if (Math.hypot(cut.centre[0] - mid[0], cut.centre[1] - mid[1], cut.centre[2] - mid[2]) > cut.radius + reach) continue;
    const p = cut.points, f = cut.flags;
    // The first and last points the terrain's cut runs between (not those beyond the portals).
    let first = 0, last = cut.count - 1;
    if (terrain) {
      while (first < last && f[first] & FLAG_BEYOND) first++;
      while (last > first && f[last] & FLAG_BEYOND) last--;
    }
    for (let i = first + 1; i <= last; i++) {
      const pa = (i - 1) * CUT_DOUBLES, pb = i * CUT_DOUBLES;
      if (f[i - 1] & f[i] & FLAG_DEEP) continue;
      local(p, pa, a);
      local(p, pb, b);
      // The segment's box: its ends, as wide as its outline and as high as its crown.
      const side = Math.max(p[pa + 3], p[pa + 6], p[pb + 3], p[pb + 6]) + MARGIN;
      const top = Math.max(p[pa + 4], p[pa + 5] + p[pa + 7], p[pb + 4], p[pb + 5] + p[pb + 7]) + MARGIN;
      if (Math.min(a[0], b[0]) - side > lo[0] + size[0] || Math.max(a[0], b[0]) + side < lo[0]) continue;
      if (Math.min(a[1], b[1]) - side > lo[1] + size[1] || Math.max(a[1], b[1]) + side < lo[1]) continue;
      if (Math.min(a[2], b[2]) - MARGIN > lo[2] + size[2] || Math.max(a[2], b[2]) + top < lo[2]) continue;
      // The terrain's bore ends exactly at its first and last points.
      const endA = terrain && i - 1 === first ? -1 : 1, endB = terrain && i === last ? -1 : 1;
      out.push(a[0], a[1], a[2], p[pa + 3], b[0], b[1], b[2], p[pb + 3],
        endA * p[pa + 4], p[pa + 5], p[pa + 6], p[pa + 7], endB * p[pb + 4], p[pb + 5], p[pb + 6], p[pb + 7]);
    }
  }
  return out;
}

/* Metres round a box a segment still counts as reaching it. */
const MARGIN = 0.5;
