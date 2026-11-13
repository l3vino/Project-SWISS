/* portals.js — where roads go into tunnels, and how high their floors are
 * there: pins for the terrain under the roads (wasm/src/shape.c), as
 * bridges.js has them where roads come off decks.
 *
 * His words (on 5.17c): "any type of road should be priority, base of tunnel
 * must be base of road in front of it (nearest one)". The tunnels place each
 * portal's floor at the road right in front of it (tunnels/tunnels.js
 * #portalFloor); here that floor becomes a pin on the road running out of
 * the portal (tunnels/runs.js: the run's end, the line on beyond it and the
 * distance along that line there), so its profile takes the floor's height
 * at the portal and the approach's rise out of it, and eases back onto its
 * own: the road's level cut is carved into the slope down to the floor, the
 * portal at its end, and the tube's floor and the road meet without a step.
 * A portal's pin is always met (its side ±2, shape.c), however far the face
 * of the hillside over it rises: the line is the tunnel's own road.
 *
 * Where the tunnel is wider than the road's level cut (Bellinzona's 3 m
 * footpath underpass at the foot of a 2 m path's ramp, Airolo's 8.4 m box
 * at the end of a 4 m farm track), the cut's banks stand in front of the
 * tunnel's lower corners, and a line of sight out of the tunnel through
 * them runs on under the ground and meets nothing (the sky shows: 5.17c's
 * "see through spots"). So the road's own level cut is widened to the
 * tunnel's width to its walls' outer faces (and WIDEN_MARGIN) for WIDEN_FULL
 * metres out of the portal along the road itself, narrowing back to the
 * road's own width by WIDEN_TO (pieces.js `widen`): an underpass's ramp as
 * wide as the underpass. 5.17d's apron, the same width straight out of the portal for
 * 8 m, dug a pocket into whatever lay straight ahead where the road turned
 * at the portal (his words on 5.17d, with the Bellinzona underpass's street
 * broken by a cliff, and a notch beside the Airolo underpass's track); along
 * the road it follows the road, and a more important road it meets keeps
 * its own level (shape.c: the most important level width wins). Where the
 * road turns right at its portal, its widened cut turns with it and leaves
 * the mouth's corner on the inside of the turn against the bank (live at
 * the Bellinzona underpass's west mouth: the ground 0.2–0.6 m over the floor
 * across its left half, from inside the sky under it), so each portal also
 * gets a short apron: a piece APRON metres straight out of it as wide as
 * the widening, its own line pinned to the floor the same way, of the least
 * priority (any road of the data keeps its own level): the landing in front
 * of a portal (5.17d's apron ran 8 m and dug into a street, when it was not the least of them; 2 m until 5.17p,
 * now 5 m: his words on 5.17n, "make it so there is a sort of excavation for a couple of meters even when the
 * tunnel is finished"). The terrain
 * itself is cut along the tunnel's bore (tunnels/cuts.js, terrain.wgsl),
 * from its mouth in.
 */

import { PIN_FLOATS, PIN_BELOW } from './bridges.js';

/* Metres a run's end may be from a portal the tunnels placed and be it. */
const SAME_PORTAL = 1;
/* Floats a widening (pieces.js): the road's line, the distance along it at the portal, which way it runs out of the
 * portal (+1: s grows), the half-width its level cut takes there. Metres the road's level cut is as wide as the
 * tunnel (and the margin) out of the portal, and by which it is back to its own. */
export const WIDEN_FLOATS = 4;
export const WIDEN_FULL = 6, WIDEN_TO = 12;
const WIDEN_MARGIN = 0.3;
/* The rise a metre out of a portal its road is pinned to at most, either way. */
const RISE_MOST = 0.3;
/* The apron: metres out of the portal, its priority (under every kind's) and the steepest its profile may climb (its
 * pin holds it). Floats a piece of an apron or a cutting (pieces.js): its ends (the block's units), the metres along
 * its line at each, half-width, grade, priority, line. */
const APRON = 5, APRON_PRIORITY = 1, APRON_GRADE = 1;
export const APRON_FLOATS = 10;
/* Floats a point of a portal's open cutting (tunnels.js cuttingOf): lon, lat, floor, metres in, the floor's rise; and
 * metres beyond its width a tile still lays it (shape.c's faces beside it reach about as far). */
const CUTTING_FLOATS = 5, CUTTING_MARGIN = 40;

/** The height the road in front of a portal is pinned to `d` metres out of it: a hair under its floor, at its rise. */
export function pinnedRoadAt(floor, rise, d) {
  return floor - PIN_BELOW + Math.max(-RISE_MOST, Math.min(RISE_MOST, rise)) * d;
}

/**
 * The pins of a detail tile's tunnel portals, their roads' widenings and their aprons, from the floors placed now:
 * { pins: Float32Array (PIN_FLOATS each) or null, widen: Float32Array (WIDEN_FLOATS each) or null, aprons:
 * Float32Array (APRON_FLOATS each) or null, sig: a number that changes when they do (0 none) }.
 * @param runs    the tile's tunnel runs (tunnels/runs.js), each end with its `pin`
 * @param floors  [{ lon, lat, height, rise, half, outX, outY }] (tunnels.js: each placed portal's floor, its rise a
 *                metre out, the tunnel's half-width there to its walls' outer faces, its way out east and north)
 * @param tile    the block's tile { z, x, y, extent, mpu (metres a unit) }: its units, and which portals are its own
 */
export function portalPinsFor(runs, floors, tile = { z: 0, x: 0, y: 0, extent: 0, mpu: 1 }) {
  if (!floors.length) return { pins: null, widen: null, aprons: null, sig: 0 };
  const out = [], widen = [], aprons = [], aproned = new Set(), mpu = tile.mpu || 1;
  let h = 2166136261, own = 0;
  // A portal's apron: straight out of it (the block's y runs south), a line of its own (from the top of the block's
  // line numbers down), pinned at the portal.
  const apron = (x, y, f, z, rise) => {
    if (!(f.half > 0) || !Number.isFinite(f.outX) || !Number.isFinite(f.outY)) return;
    const line = 65535 - own++;
    aprons.push(x, y, x + (f.outX * APRON) / mpu, y - (f.outY * APRON) / mpu, 0, APRON, f.half + WIDEN_MARGIN, APRON_GRADE,
      APRON_PRIORITY, line);
    out.push(x, y, 0, z, rise, line, 2);
    aproned.add(f);
    h = Math.imul(h ^ Math.round(x * 7 + y * 13 + f.outX * 100 + f.outY * 10000), 16777619);
  };
  const n = 2 ** tile.z, E = tile.extent;
  const unitsOf = (lon, lat) => [(mercX(lon) * n - tile.x) * E, (mercY(lat) * n - tile.y) * E];
  const mine = (f) => {
    if (!(E > 0)) return null;
    const [x, y] = unitsOf(f.lon, f.lat);
    return x >= 0 && x < E && y >= 0 && y < E ? [x, y] : null;
  };
  // Whether points (CUTTING_FLOATS each) come within `metres` of the tile.
  const reaches = (c, metres) => {
    if (!(E > 0)) return false;
    const m = metres / mpu;
    for (let k = 0; k < c.length; k += CUTTING_FLOATS) {
      const [x, y] = unitsOf(c[k], c[k + 1]);
      if (x >= -m && x < E + m && y >= -m && y < E + m) return true;
    }
    return false;
  };
  for (const run of runs ?? []) {
    for (let e = 0; e < 2; e++) {
      const pin = run.ends[e].pin;
      if (!pin) continue;
      const k = e ? run.points.length - 2 : 0, lon = run.points[k], lat = run.points[k + 1];
      const m = 111320 * Math.cos((lat * Math.PI) / 180);
      // (A line ending in a portal beside its middle, as the other tracks into a wide one, 5.17q: pinned to its floor
      // too, his words: "connect the tracks correctly even if the data is not there"; its middle's line alone widens
      // the portal's way out and lays its apron.)
      let best = null, gap = Infinity;
      for (const f of floors) {
        const d = Math.hypot((f.lon - lon) * m, (f.lat - lat) * 111132);
        if (d < gap && d <= Math.max(SAME_PORTAL, (f.half ?? 0) + SAME_PORTAL)) { gap = d; best = f; }
      }
      if (!best) continue;
      // The floor's rise out of the portal, along s (which grows out of it where dir is +1).
      const z = pinnedRoadAt(best.height, best.rise, 0), rise = Math.max(-RISE_MOST, Math.min(RISE_MOST, best.rise));
      out.push(pin.x, pin.y, pin.s, z, pin.dir * rise, pin.line, 2 * pin.dir);
      h = Math.imul(h ^ (pin.line * 31 + Math.round(pin.s * 2)), 16777619);
      h = Math.imul(h ^ Math.round(z * 10), 16777619);
      if (!(best.half > 0) || gap > SAME_PORTAL) continue;
      widen.push(pin.line, pin.s, pin.dir, best.half + WIDEN_MARGIN);
      h = Math.imul(h ^ Math.round(best.half * 10), 16777619);
      apron(pin.x, pin.y, best, z, rise);
    }
  }
  // The portals in this tile whose road does not run on out of them as a line (none mapped, or one stopping short
  // of the portal: the Bellinzona underpass's steps end 1.9 m from its west portal): their aprons from their own
  // place, pinned the same way.
  for (const f of floors) {
    if (aproned.has(f)) continue;
    const xy = mine(f);
    if (!xy) continue;
    const z = pinnedRoadAt(f.height, f.rise, 0), rise = Math.max(-RISE_MOST, Math.min(RISE_MOST, f.rise));
    apron(xy[0], xy[1], f, z, rise);
    h = Math.imul(h ^ Math.round(z * 10), 16777619);
  }
  // The open cuttings (5.17f, his words: "make sure nothing goes above the ground"): from a portal in to where its
  // tube starts, the ground covering it there (tunnels.js), a line of its own as wide as the road's widening, its
  // ground pinned to the floor at every point (shape.c holds a line near a portal's pin against any junction's
  // height; side 2 at its ends, which end square there, 3 between them); laid by every tile it comes near (a terrain
  // tile is cut with the tiles over it only: one beside the portal's tile would leave the hillside standing in it).
  for (const f of floors) {
    const c = f.cutting;
    if (!c || c.length < 2 * CUTTING_FLOATS || !(f.half > 0) || !reaches(c, f.half + CUTTING_MARGIN)) continue;
    const line = 65535 - own++;
    let last = null;
    for (let k = 0; k < c.length; k += CUTTING_FLOATS) {
      const [x, y] = unitsOf(c[k], c[k + 1]), end = k === 0 || k + CUTTING_FLOATS >= c.length;
      out.push(x, y, c[k + 3], c[k + 2] - PIN_BELOW, c[k + 4], line, end ? 2 : 3);
      if (last) aprons.push(last[0], last[1], x, y, last[2], c[k + 3], f.half + WIDEN_MARGIN, APRON_GRADE, APRON_PRIORITY, line);
      last = [x, y, c[k + 3]];
      h = Math.imul(h ^ Math.round(x * 7 + y * 13 + c[k + 2] * 10), 16777619);
    }
  }
  return out.length
    ? { pins: Float32Array.from(out), widen: widen.length ? Float32Array.from(widen) : null,
        aprons: aprons.length ? Float32Array.from(aprons) : null, sig: (h >>> 0) || 1 }
    : { pins: null, widen: null, aprons: null, sig: 0 };
}

const mercX = (lon) => (lon + 180) / 360;
const mercY = (lat) => {
  const l = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI);
};

/** Two tiles' pins as one array (either may be null). */
export function joinPins(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export { PIN_FLOATS };
