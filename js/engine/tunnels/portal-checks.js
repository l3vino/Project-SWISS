/* portal-checks.js — the portals as placed, checked against the ground as drawn (5.19a: on the render thread, which
 * has that ground; the tunnels' thread, which placed them, is told what was found).
 *
 * Every LIFT_EVERY frames, for the tubes placed (their copies: placed.js) in turn, CHECK_MS at a time, each portal:
 *
 *   - Its floor against the road in front of it as drawn (align). The road running out of a portal is pinned to its
 *     floor (vector/portals.js) and held there for its first metres (shape.c PORTAL_HOLD: at Airolo's farm track box
 *     a minor road meeting the track 3 m out had pulled them up to its own level, 0.6 m over the floor), but where a
 *     more important road's level width reaches over the portal's front (a road passing right in front of it), that
 *     level holds the ground there (shape.c: the most important level width wins), and the floor, placed from the
 *     ground before any road was cut into it (tunnels.js #portalFloor), would stand under or over it: a step at the
 *     mouth the walker cannot take. Where the ground in front is cut with the roads as they are now (this portal's
 *     pin among them), stands level across the way out and is more than LIFT_TOL off the height the pin gives it,
 *     the floor takes that height.
 *
 *   - Its tube's start against the ground as cut (trim, 5.17f). A tube starts where the ground covers it (fit.js
 *     coverStart, from the ground as measured); short of it the road runs on in an open cutting of the least priority
 *     (vector/portals.js), and where a more important road's level width reaches over the cutting (a road crossing over
 *     the tube right at its portal: Airolo's farm track box under the pass road), that road's level holds the ground
 *     there, over the vault: a wall in front of the mouth, which hid it and stopped the walker 0.7 m short of it. Along
 *     the cutting's middle and TRIM_ACROSS of the way to its walls either side: where the ground as cut rises in each
 *     from the cutting's own (TRIM_LOW over the floor at most) to over the vault and its concrete within TRIM_WALL (a
 *     road's level width's edge, the terrain's triangles sloping it over the last of the cutting's), or holds over it
 *     from the portal on, the tube starts where the first of them leaves the cutting's own (it only ever moves out
 *     towards the portal, so it settles). What it found per portal is kept for the probe (`trimSeen`); a portal is
 *     looked at again only once the ground under its cutting has changed since (the tiles indexed there: 5.18b
 *     looked at every portal again whenever any tile anywhere was, which while loading is every few frames, at
 *     thousands of ground lookups a portal), or its tube was placed again (a new copy).
 *
 * Each finding is a correction for the tunnels' thread ({ key, sig, end, portal, lift, tries } or { …, start }), which
 * places the tube again with it if it is still placed as the copy says (its signature, the tries): a new mesh, a new
 * copy, and then they agree. A copy with a correction on its way is not looked at again (`asked`).
 */

import { TUBE_END, TUBE_POINT } from './groups.js';
import { spineOf, middleAt } from './mesh.js';
import { pinnedRoadAt } from '../vector/portals.js';

/* Frames between the checks (render.js), and the milliseconds a check may take: the tubes are gone through in turn
 * from where the last one stopped (5.18f: all of them at once, while the ground was loading, took the render thread
 * 56 ms after a jump to Lugano). */
export const LIFT_EVERY = 3;
const CHECK_MS = 2;
/* align: the ground in front looked at LIFT_OUT metres out, LIFT_ACROSS either side of the middle (at most half the
 * mouth's half-width); level within LIFT_LEVEL, off by more than LIFT_TOL; the floor moved LIFT_MOST at most, in
 * LIFT_TRIES goes at most. */
const LIFT_OUT = [0.4, 0.8];
const LIFT_ACROSS = 1;
const LIFT_LEVEL = 0.15, LIFT_TOL = 0.1, LIFT_MOST = 2, LIFT_TRIES = 3;
/* trim: the ground looked at every TRIM_STEP metres along lines TRIM_EVERY apart, out to TRIM_EDGE of the way to
 * the walls (and at TRIM_ACROSS of it). */
const TRIM_STEP = 0.1, TRIM_LOW = 0.3, TRIM_WALL = 1.2, TRIM_ACROSS = 0.6, TRIM_EDGE = 0.95, TRIM_EVERY = 1;

export class PortalChecks {
  /**
   * The corrections the tubes' portals call for now.
   * @param tubes        the placed tubes (placed.js PlacedTube)
   * @param groundAt     (lon, lat) => the ground as drawn there (accurate), or null
   * @param shapedGround (lon, lat) => the ground as drawn there from a tile the roads are cut into, or null
   * @param shapedAt     (lon, lat) => whether the ground there is cut with the roads as they are now
   * @param entryAt      (lon, lat) => the ground's indexed tile there (terrain/ground.js entryAt: a new one where the
   *                     ground there changed), or null
   */
  run(tubes, { groundAt, shapedGround, shapedAt, entryAt }) {
    const out = [], start = performance.now(), n = tubes.length;
    for (let k = 0; k < n; k++) {
      const t = tubes[((this.next ?? 0) + k) % n];
      if (t.asked) continue;
      const before = out.length;
      if (!this.align(t, groundAt, shapedAt, out)) this.trim(t, shapedGround, shapedAt, entryAt, out);
      if (out.length > before) t.asked = true;
      // Its time taken: the next check goes on from the tube after this one.
      if (performance.now() - start > CHECK_MS) { this.next = ((this.next ?? 0) + k + 1) % n; return out; }
    }
    return out;
  }

  /** Its portals' floors against the road in front as drawn; whether it found a correction (into `out`). */
  align(t, groundAt, shapedAt, out) {
    const p = t.points;
    let found = false;
    for (let e = 0; e < 2; e++) {
      const end = t.ends[e], f = t.fit[e], q = t.portals?.[e];
      // (Not one whose tube runs on out of it under a way crossing over its mouth, 5.18o: that way's level and the ground
      // filled in over the tube stand right behind where the road in front starts.)
      if (end.type !== TUBE_END.PORTAL || !f || !q || q.tries >= LIFT_TRIES || f.collar > 0) continue;
      const floor = t.floorAt(p[e ? p.length - TUBE_POINT + 2 : 2]);
      const m = 111320 * Math.cos((end.lat * Math.PI) / 180), ox = end.dirX, oy = end.dirY;
      const a = Math.min(LIFT_ACROSS, f.half / 2);
      let lo = Infinity, hi = -Infinity, sum = 0, n = 0, known = true;
      for (const d of LIFT_OUT) {
        for (const c of [-a, 0, a]) {
          // Out of the portal (ox, oy), and right of that (oy, -ox).
          const lon = end.lon + (ox * d + oy * c) / m, lat = end.lat + (oy * d - ox * c) / 111132;
          const g = shapedAt(lon, lat) ? groundAt(lon, lat) : null;
          if (g === null) { known = false; break; }
          const off = g - pinnedRoadAt(floor, f.rise, d);
          if (off < lo) lo = off;
          if (off > hi) hi = off;
          sum += off;
          n++;
        }
        if (!known) break;
      }
      if (!known || hi - lo > LIFT_LEVEL) continue;
      const off = sum / n;
      if (Math.abs(off) <= LIFT_TOL) continue;
      const lift = Math.max(-LIFT_MOST, Math.min(LIFT_MOST, q.lift + off));
      out.push({ key: t.key, sig: t.sig, end: e, portal: q.key, lift, tries: q.tries });
      found = true;
    }
    return found;
  }

  /** Where its tube starts at each portal against the ground as cut (into `out`). */
  trim(t, groundAt, shapedAt, entryAt, out) {
    const L = t.length;
    let spine = null, n = 0;
    for (let e = 0; e < 2; e++) {
      const end = t.ends[e], f = t.fit[e], q = t.portals?.[e];
      if (end.type !== TUBE_END.PORTAL || !f || !q || !(f.start > TRIM_STEP)) continue;
      // (Its spine smoothed as the mesh's is, made once a copy.)
      if (!spine) { spine = t.spine ??= spineOf(t, t.section.half); n = spine.length / TUBE_POINT; }
      // The ground's tiles along the cutting (at the portal, half-way, where the tube starts): looked at again only
      // where one of them is new.
      const stamp = [0, 0.5, 1].map((k) => { const at = middleAt(spine, n, e ? L - k * f.start : k * f.start); return entryAt ? entryAt(at[0], at[1]) : null; });
      const was = t.trimStamp?.[e];
      if (was && entryAt && was.every((x, i) => x === stamp[i])) continue;
      const top = f.crown + t.collarWidth;
      t.trimSeen ??= [null, null];
      let first = Infinity, seen = '', walls = 0, notWall = null;
      for (const c of trimLines(f.half)) {
        let low = null, hit = null;
        // (To where the tube starts and no further: the cutting's own square end's step is just past it.)
        for (let k = 0, d = 0; d <= f.start; d = ++k * TRIM_STEP < f.start - 1e-6 ? k * TRIM_STEP : d < f.start ? f.start : Infinity) {
          const s = e ? L - d : d, at = middleAt(spine, n, s, c);
          const g = shapedAt(at[0], at[1]) ? groundAt(at[0], at[1]) : null;
          if (g === null) { seen = 'not cut yet'; break; }
          const over = g - t.floorAt(s);
          if (over >= top) { hit = d; break; }
          if (over <= TRIM_LOW) low = d;
        }
        if (seen) break;
        // Nothing over the vault along it: the cutting holds there (or a road's level part-way up, which would have
        // the vault through it); over it, but not straight up from the cutting's own: likewise. Where any line
        // meets a wall, the tube starts at the first such (over the cutting's own there, its concrete covers it).
        if (hit === null) continue;
        const at = low === null ? (hit === 0 ? 0 : null) : hit - low <= TRIM_WALL ? low : null;
        if (at === null) { notWall ??= hit; continue; }
        first = Math.min(first, at);
        walls++;
      }
      if (!seen && !walls) seen = notWall === null ? 'the cutting holds' : `not a wall (${notWall.toFixed(1)} m in)`;
      t.trimSeen[e] = seen || `a road's level from ${first.toFixed(1)} m in`;
      // (Looked at again when the ground there has changed; until all of it is cut, every time.)
      if (seen !== 'not cut yet') (t.trimStamp ??= [null, null])[e] = stamp;
      if (seen) continue;
      if (q.start !== null && q.start <= first + 0.01) continue;
      out.push({ key: t.key, sig: t.sig, end: e, portal: q.key, start: first });
    }
  }
}

/* The lines across a cutting trim looks along (metres right of its middle): the middle, TRIM_ACROSS of the way to its
 * walls either side, and out to TRIM_EDGE of the way, at most TRIM_EVERY apart. */
function trimLines(half) {
  const edge = TRIM_EDGE * half, n = Math.max(1, Math.ceil(edge / TRIM_EVERY)), out = new Set([0, TRIM_ACROSS * half, -TRIM_ACROSS * half]);
  for (let i = 1; i <= n; i++) { out.add((edge * i) / n); out.add((-edge * i) / n); }
  return [...out];
}
