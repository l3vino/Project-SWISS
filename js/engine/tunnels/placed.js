/* placed.js — the tubes as placed, as the render thread keeps them for the bodies (5.19a).
 *
 * The tunnels are worked out on their own thread (workers/tunnels.js runs engine/tunnels/tunnels.js). Each tube
 * placed comes back with its mesh and a compact copy of what touching it needs (placedCopy, made there): its line,
 * its ends, its section, its portals' cuttings and its floor sampled every FLOOR_STEP metres. Physics asks about it
 * every step (TubeQuery: inside a tunnel the floor is the tube's, its walls and vault hold the body in; controllers/),
 * and the portals' checks against the ground as drawn look at it every few frames (portal-checks.js); neither waits on
 * the tunnels' thread, and nothing here makes garbage per question.
 */

import { TUBE_POINT } from './groups.js';
import { placeOn } from './trace.js';
import { CUT_PAST } from './cuts.js';

/* Metres between the floor's samples (a long tube's at most FLOOR_MOST of them; linear between: a dip under a crossing
 * tube is tens of metres long, so the error is well under a millimetre). */
export const FLOOR_STEP = 1;
const FLOOR_MOST = 65536;
/* Metres inside a bore's walls the nearest place inside it is (boreNear). */
const BORE_HOLD_IN = 0.8;
/* Metres over a cutting's floor its room is open to (boreAt: no vault). */
export const CUT_OPEN = 200;
/* A cutting's wing walls (5.17t): splayed 30° out over their first WING_LEN metres (tunnel.c wing_off). */
export const WING_SPLAY = Math.tan((30 * Math.PI) / 180), WING_LEN = 6;
const WGS84_A = 6378137, DEG = Math.PI / 180;

/**
 * The copy of a placed tube sent with its mesh (plain data and typed arrays, cloned once).
 * @param r         the tube's record (tunnels.js): its tube, signature, fit, section and floor
 * @param box       the box round its mesh, degrees [west, south, east, north]
 * @param cuttings  its portals' cuttings (tunnels.js #cuttings: [end 0, end 1], each null or one)
 * @param portals   per end, what the portals' checks need: { key, lift, tries, start } or null (not a portal)
 */
export function placedCopy(r, box, cuttings, portals) {
  const t = r.tube, L = t.length, count = Math.min(FLOOR_MOST, Math.max(2, Math.ceil(L / FLOOR_STEP) + 1));
  const step = L / (count - 1), floor = new Float32Array(count);
  for (let i = 0; i < count; i++) floor[i] = r.floorAt(Math.min(L, i * step));
  const s = r.section;
  return {
    key: t.key, family: t.family, length: L, sig: r.sig, box,
    points: Float64Array.from(t.points),
    ends: t.ends.map((e) => ({ type: e.type, lon: e.lon, lat: e.lat, dirX: e.dirX, dirY: e.dirY })),
    fit: (r.fit?.ends ?? [null, null]).map((f) => f && {
      start: f.start ?? 0, collar: f.collar ?? 0, rise: f.rise ?? 0, half: f.outline?.half ?? 0, crown: f.outline?.crown ?? 0 }),
    collarWidth: r.fit?.collarWidth ?? 0,
    section: { half: s.half, spring: s.spring, ceiling: s.ceiling ?? 0, kerb: s.kerb ?? 0, walkway: s.walkway ?? 0,
      low: { top: s.low.top, half: s.low.half }, arch: s.arch ? { r: s.arch.r, y: s.arch.y } : null },
    floor, floorStep: step,
    cuttings,
    portals,
  };
}

/** A placed tube on the render thread (placedCopy's fields), with its floor between the samples. */
export class PlacedTube {
  constructor(copy) {
    Object.assign(this, copy);
    this.lastK = -1;          // the piece of its spine the last point asked about lay by (placeOn's `near`)
    this.at = {};             // placeOn's answer, kept
    this.mesh = null;         // its mesh as drawn (view.js)
  }

  /** Its floor (metres above the ellipsoid) `s` metres along it, within its length. */
  floorAt(s) {
    const f = this.floor, x = Math.min(Math.max(s, 0), this.length) / this.floorStep;
    const i = Math.min(f.length - 2, Math.floor(x)), u = x - i;
    return f[i] + (f[i + 1] - f[i]) * u;
  }
}

function emptyBore() {
  return { record: null, s: 0, floor: 0, ground: 0, top: 0, across: 0, half: 0, wallHalf: 0, wallTop: 0, archY: 0, archA: 0, archH: 0,
    rightX: 1, rightY: 0 };
}

/** What the bodies ask about the tubes placed (the meshes drawn, in their order). */
export class TubeQuery {
  constructor() {
    this.tubes = [];
    this.bore = emptyBore();
    this.room = emptyBore();
    this.near = {};
    this.cutting = {};
  }

  /**
   * The tube a point is inside (from the collar out of the hillside at a portal to its far end), or null: its
   * floor there and the ground to stand on (a walkway is a kerb higher), its vault over the point, how far right of
   * the bore's middle the point is and how far it may go, which way right is, and its outline as drawn (wallHalf,
   * wallTop, archY/A/H: bore.js boreHalfAt). Flying, walking and the airplane ask it every physics step
   * (controllers/): inside a tunnel the terrain above is not the floor, the tunnel's is, and its walls and vault
   * hold the body in. Where tubes run into each other (5.17m) and the point is inside more than one, the one it is
   * furthest inside the walls of: its walls hold the body only where it would leave them all. `out.record` is the
   * placed tube.
   * @param feet  metres above the ellipsoid
   * @param past  metres beyond each collar it still answers for (roomAt)
   */
  boreAt(lon, lat, feet, out = this.bore, past = 0) {
    let best = -Infinity;
    for (const t of this.tubes) {
      const b = t.box;
      if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      const L = t.length, p = t.points, last = p.length - TUBE_POINT;
      const mx = 111320 * Math.cos((lat * Math.PI) / 180);
      let s, across, middle, extra, rightX, rightY;
      // Beyond an end (the collar's stretch out of the hillside): along and across from the end itself.
      const e0 = t.ends[0], e1 = t.ends[1];
      const d0x = (lon - e0.lon) * mx, d0y = (lat - e0.lat) * 111132, d1x = (lon - e1.lon) * mx, d1y = (lat - e1.lat) * 111132;
      const beyond0 = d0x * e0.dirX + d0y * e0.dirY, beyond1 = d1x * e1.dirX + d1y * e1.dirY;
      if (beyond0 > 0) {
        s = -beyond0; rightX = -e0.dirY; rightY = e0.dirX; across = d0x * rightX + d0y * rightY; middle = p[3]; extra = p[4];
      } else if (beyond1 > 0) {
        s = L + beyond1; rightX = e1.dirY; rightY = -e1.dirX; across = d1x * rightX + d1y * rightY; middle = p[last + 3]; extra = p[last + 4];
      } else {
        const at = placeOn(t, lon, lat, t.lastK, t.at);
        t.lastK = at.k;
        s = at.s; across = at.across; middle = at.middle; extra = at.extra; rightX = at.dirY; rightY = -at.dirX;
      }
      // Only where the tube is (from where the ground covers it at a portal: short of it, the open cutting's ground).
      const f = t.fit;
      const lo = f[0] ? f[0].start - f[0].collar - past : 0, hi = f[1] ? L - f[1].start + f[1].collar + past : L;
      if (s < lo || s > hi) {
        // In a portal's cutting (5.17t): its floor to stand on, open to the sky, its walls either side.
        const c = t.cuttings ? cuttingAt(t.cuttings, lon, lat, feet, this.cutting) : null;
        if (c && c.inside > best) {
          best = c.inside;
          out.record = t; out.s = s; out.floor = c.floor; out.top = c.floor + CUT_OPEN; out.across = c.a; out.half = c.half;
          out.ground = c.floor; out.wallHalf = c.half; out.wallTop = CUT_OPEN; out.archY = 0; out.archA = 0; out.archH = 0;
          out.rightX = c.rx; out.rightY = c.ry;
        }
        continue;
      }
      const sec = t.section, half = sec.half + extra, a = across - middle;
      if (Math.abs(a) > half + 0.5) continue;
      // Out of a portal (its collar's stretch) the floor runs on as the approach does.
      const fe = s < 0 ? f[0] : s > L ? f[1] : null;
      const floor = t.floorAt(s) + (fe ? fe.rise * (s < 0 ? -s : s - L) : 0);
      // Its outline as drawn here (sections.js outlineAt, written out: no object a call).
      const wide = half / sec.half, root = Math.sqrt(wide);
      const wallTop = sec.low.top > sec.spring ? sec.spring + (sec.low.top - sec.spring) * root : sec.low.top;
      const archA = sec.arch ? sec.arch.r * wide : 0, archH = sec.arch ? sec.arch.r * root : 0;
      const archY = sec.arch ? sec.spring + (sec.arch.y - sec.spring) * root : 0;
      // The vault over the point: the arch where it is over the point, else the walls' top (a flat roof); a
      // ventilation ceiling at its own height.
      const xa = archA > 0 ? Math.abs(a) / archA : 1;
      const top = floor + (sec.ceiling ? sec.ceiling : xa < 1 ? Math.max(wallTop, archY + archH * Math.sqrt(1 - xa * xa)) : wallTop);
      if (feet < floor - 2 || feet > top + 0.5) continue;
      const inside = half - Math.abs(a);
      if (inside <= best) continue;
      best = inside;
      // The ground to stand on: a walkway's kerb higher beside the floor.
      const kerbFrom = sec.kerb > 0 && sec.walkway > 0 ? (sec.arch && sec.low.top < sec.spring ? sec.low.half : sec.half - sec.walkway) * wide : Infinity;
      out.record = t; out.s = s; out.floor = floor; out.top = top; out.across = a; out.half = half;
      out.ground = floor + (Math.abs(a) > kerbFrom ? sec.kerb : 0);
      out.wallHalf = sec.low.half * wide; out.wallTop = wallTop; out.archY = archY; out.archA = archA; out.archH = archH;
      out.rightX = rightX; out.rightY = rightY;
    }
    return best > -Infinity ? out : null;
  }

  /**
   * The nearest place inside a bore within `within` metres of a point, whatever its height (5.17w: workers/render.js
   * holdInBore, a tube that changed under the camera). Inside the tube's own stretch only (not out of a portal),
   * BORE_HOLD_IN inside its walls.
   * @returns { lon, lat, floor } or null
   */
  boreNear(lon, lat, within, out = {}) {
    let least = within;
    let found = null;
    for (const t of this.tubes) {
      const b = t.box, sec = t.section;
      if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      const at = placeOn(t, lon, lat, -1, this.near);
      const f = t.fit;
      const lo = f[0] ? f[0].start : 0, hi = f[1] ? t.length - f[1].start : t.length;
      if (!(at.s > lo && at.s < hi)) continue;
      const half = Math.max(0, sec.half + at.extra - BORE_HOLD_IN), a = at.across - at.middle;
      const to = Math.max(-half, Math.min(half, a)), move = Math.abs(to - a);
      if (!(move <= least)) continue;
      least = move;
      const mx = 111320 * Math.cos((lat * Math.PI) / 180), rightX = at.dirY, rightY = -at.dirX;
      out.lon = lon + ((to - a) * rightX) / mx; out.lat = lat + ((to - a) * rightY) / 111132; out.floor = t.floorAt(at.s);
      found = out;
    }
    return found;
  }

  /**
   * Whether a body (its feet, metres above the ellipsoid) is in the room a tube takes out of what is built: inside
   * its bore, or the cut's reach beyond a collar (cuts.js CUT_PAST). The controllers leave the buildings' solids alone
   * there: they are not drawn (buildings.wgsl fsCut), so they neither hold a body up nor stop it.
   */
  roomAt(lon, lat, feet) {
    const b = this.boreAt(lon, lat, feet, this.room, CUT_PAST);
    return b !== null && Math.abs(b.across) <= b.half && feet >= b.floor - 0.6 && feet <= b.top;
  }
}

/* A cutting's walls' inner faces `d` metres out of its collar: metres from its middle (tunnel.c wing_off). */
export function wingOff(half, d, splay = WING_SPLAY, wing = WING_LEN) {
  return half + Math.min(Math.max(d, 0), wing) * splay;
}

/* Where a point lies in one of a mesh's cuttings (boreAt): its floor, metres across from the middle, its half-width,
 * how far inside its walls, the way right (into `out`); null if in none. */
export function cuttingAt(cuts, lon, lat, feet, out = {}) {
  for (const c of cuts) {
    if (!c) continue;
    const x = (lon - c.lon) * WGS84_A * Math.cos(c.lat * DEG) * DEG, y = (lat - c.lat) * WGS84_A * DEG;
    const d = (x * c.te + y * c.tn) * c.dir, a = x * c.tn - y * c.te - c.off, half = wingOff(c.half, d, c.splay ?? 0, c.wing ?? 0);
    if (d < -0.5 || d > c.len || Math.abs(a) > half + 0.3) continue;
    const floor = c.h + c.rise * Math.max(0, d);
    if (feet < floor - 2 || feet > floor + CUT_OPEN) continue;
    out.floor = floor; out.a = a; out.half = half; out.inside = half - Math.abs(a); out.rx = c.tn; out.ry = -c.te;
    return out;
  }
  return null;
}
