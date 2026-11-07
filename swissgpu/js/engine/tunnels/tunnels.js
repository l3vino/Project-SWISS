/* tunnels.js — the tunnels near the camera, on the render thread: found,
 * followed to their portals, placed at the height of the ground there, kept
 * under the ground between, made into meshes and handed to the pass
 * (passes/tunnels.js), and cut out of the terrain and of what is built along
 * their whole bores (cuts.js; terrain.wgsl and buildings.wgsl fsCut).
 *
 *   1. The detail road tiles' tunnel runs (runs.js, made with each tile on a
 *      decode thread) are gathered whenever the tiles with tunnels change,
 *      at most every GATHER_MS, and made into tubes there ('tunnel-tubes',
 *      groups.js).
 *   2. A tube that runs on past those tiles is followed to its portals
 *      through zoom-13 tiles ('tunnel-trace', trace.js), once a session per
 *      tunnel (and once ever: the decode thread keeps the answer).
 *   3. Each portal's height is the road right in front of it (5.17d, his
 *      words: "base of tunnel must be base of road in front of it (nearest
 *      one)"): the finest terrain tile there, indexed on a decode thread
 *      ('terrain-ground'), sampled along its open approach, the first metres
 *      out taken back to the portal (#portalFloor); where a bridge's deck
 *      meets the portal, the deck's. The floor runs linear between the
 *      portals, with the table's culmination (sections.js). Each portal's
 *      floor is told to the road tiles, which pin the road running into it
 *      there (vector/portals.js): its cut is carved down to the floor.
 *   4. Fitted to the ground (fit.js, 5.17c; 5.17e): the ground along the
 *      whole tube and its portals' axes against its floor gives a short
 *      tube's section (a box under an embankment) or no tube at all where
 *      there is no room for one (the terrain stays whole), its floor kept
 *      under the ground between its portals (5.17d's floor ran level or
 *      straight under any ground: by Locarno tubes stood up to 18 m out of
 *      it), and each portal's concrete over the vault where the ground is
 *      lower than it. The tube starts at the mapped portal, where the road
 *      does.
 *   5. The mesh: the tube's cross-section swept along it ('tunnel-mesh',
 *      mesh.js and wasm/src/tunnel.c), uploaded in the frame's upload slice;
 *      and the room it takes, cut out of the terrain and of what is built
 *      (cuts.js).
 * Each job waits its turn on the decode threads as every layer's does
 * (core/scheduler.js), in the view class: a tunnel is something seen.
 */

import { VIEW, hostOf } from '../../core/scheduler.js';
import { geodeticToEcef } from '../../core/math.js';
import { tileAt, tileRect, tileKey } from '../terrain/tiling.js';
import { groundEntry, sampleEntry, groundSample } from '../terrain/ground.js';
import { TUBE_END, TUBE_POINT } from './groups.js';
import { placeOn } from './trace.js';
import { sectionFor, tableEntry, floorProfile, clearanceFor, MATERIAL } from './sections.js';
import { meshPoints, spineOf, MESH_END, POINT_DOUBLES } from './mesh.js';
import { fitPoints, fitTube, SHORT, COLLAR_WIDTH } from './fit.js';
import { boreCut, CUT_PAST } from './cuts.js';
import { pinnedRoadAt } from '../vector/portals.js';

const GATHER_MS = 400;
/* A tube gone from the tiles round the camera (they moved: its open end with them) keeps being drawn until the
 * tube that takes its place has its mesh, at most this long: no flicker of the hillside inside a tunnel. */
const RETIRE_MS = 15000;
/* Metres from the open end the trace starts at (inside the tunnel's unknown part). */
const TRACE_IN = 10;
/* Metres a traced tunnel may pass an open end and be the same one. */
const MATCH = 30;
/* The ground of a portal's approach, metres out along it: right in front of it (NEAR, the road the floor is at)
 * and on beyond (APPROACH, its line); and the finest level asked for. A run's end this close to a tube's end gives
 * its approach's line. */
const NEAR = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
const APPROACH = [5, 7, 9, 11, 13, 15, 18, 21, 24];
const APPROACH_MATCH = 3;
/* The road in front of a portal: the ground NEAR, each taken back to the portal along the line through the ground
 * to RISE_REACH metres out (its rise out of the portal), their median (a portal mapped a little inside the hillside
 * has its face in the first metres out: under half of them); unless that is NEAR_OVER over the approach's line at
 * the portal (most of them on the face: the line's). */
const NEAR_OVER = 1.5, RISE_REACH = 9;
const GROUND_LEVEL = 17;
const LEAST_LEVEL = 12;
/* Terrain tiles kept indexed for the ground (those no list waits for go first, the least lately used), and lists
 * of points kept with their heights. */
const GROUND_TILES_MOST = 64;
const GROUNDS_MOST = 256;
/* The Web Mercator zoom a mesh's positions on the map are in (the pass scales them to the photos'). */
const MESH_ZOOM = 20;
/* Metres round a portal the terrain's tiles are drawn from both sides at least (5.17b's reach). */
const PORTAL_REACH = 60;
/* A portal's floor against the road in front of it as drawn (alignPortals): the ground LIFT_OUT metres out, at its
 * middle and LIFT_ACROSS either side of it (at most half-way to its walls); level across within LIFT_LEVEL, and off
 * the height its pin gives it by more than LIFT_TOL, the floor follows it, by LIFT_MOST in all and LIFT_TRIES times
 * at most; checked every LIFT_EVERY frames. */
const LIFT_OUT = [0.4, 0.8];
const LIFT_ACROSS = 1;
const LIFT_LEVEL = 0.15, LIFT_TOL = 0.1, LIFT_MOST = 2, LIFT_TRIES = 3;
export const LIFT_EVERY = 15;
/* A tube's start against the ground as cut (trimStarts): along its open cutting every TRIM_STEP metres, at its middle
 * and TRIM_ACROSS of the way to its walls either side; the ground TRIM_LOW over the floor at most is the cutting's own,
 * and from there to over the vault within TRIM_WALL a wall (a road's level width's edge, the terrain's triangles
 * sloping it: 0.75 m at Airolo's farm track box). */
const TRIM_STEP = 0.1, TRIM_LOW = 0.3, TRIM_WALL = 1.2, TRIM_ACROSS = 0.6;

/* Lamps by family: metres apart, colour at a metre, and where (vault for roads, wall for railways). */
const LAMPS = {
  1: { step: 12, colour: [10, 9.2, 8.0], size: 1.2, place: 'vault' },
  2: { step: 25, colour: [3.3, 3.45, 3.75], size: 0.3, place: 'wall' },
  3: { step: 10, colour: [4, 3.6, 3.0], size: 0.8, place: 'vault' },
};
const WALLS = { 1: [0.42, 0.41, 0.38], 2: [0.17, 0.16, 0.15], 3: [0.30, 0.29, 0.27] };

/* The eye in a tunnel (5.18b): the lamps' light against daylight on level ground (passes/tunnels.js hands it to
 * tunnel.wgsl, which dims them by it: from daylight a tunnel is dark inside), and how fast the eye adapts, in
 * stops a second: to the dark slower than back to daylight (as Unreal's eye adaptation by default; the eye takes
 * seconds in a tunnel's mouth and less coming out into the glare). render.js does the adapting. */
export const EYE = { interior: 1 / 16, darker: 1.2, brighter: 3 };

export class TunnelSet {
  constructor({ device, scheduler, terrain, vector, uploads }) {
    this.device = device;
    this.terrain = terrain;
    this.vector = vector;
    this.uploads = uploads;
    this.client = scheduler.client('tunnels', { weight: 1, pick: (cls) => this.#pick(cls) });
    this.enabled = true;
    this.records = new Map();      // tube key → record
    this.retiring = [];            // records gone, drawn until a tube taking their place is (RETIRE_MS)
    this.wholes = [];              // whole tunnels traced this session
    this.traces = new Map();       // trace key → 'pending' | 'failed'
    this.grounds = new Map();      // list key → { lonlat, heights (once in), state, … } (#groundFor)
    this.groundTiles = new Map();  // terrain tile key → { z, x, y, url, rect, accept, host, state, entry, usedAt }
    this.meshes = [];              // what the pass draws
    this.portals = [];             // where the terrain is opened
    this.cuts = [];                // the bores cut out of what is built (cuts.js), and a number that changes with them
    this.cutVersion = 0;
    this.floorSig = '';            // the portal floors last told to the road tiles
    this.starts = new Map();       // portal key → metres in its tube starts at most, from the ground as cut (trimStarts)
    this.lifts = new Map();        // portal key → metres its floor follows the road in front as drawn (alignPortals)
    this.liftTries = new Map();    // portal key → how often it has
    this.seenVersion = -1;
    this.changedAt = 0;
    this.tubesBusy = false;
    this.tubesWanted = false;
    this.gpuBytes = 0;
    this.stats = { tubes: 0, meshes: 0, skipped: 0, traced: 0, traceTiles: 0, traceBytes: 0, grounds: 0, groundTiles: 0, failed: 0, meshMs: 0 };
    this.scratch = groundSample();
    this.bore = { record: null, s: 0, floor: 0, ground: 0, top: 0, across: 0, half: 0, wallHalf: 0, wallTop: 0, archY: 0, archA: 0, archH: 0,
      rightX: 1, rightY: 0 };
    this.room = { ...this.bore };
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.client.cancelAll(); this.#clear(); this.seenVersion = -1; }
  }

  /**
   * Once a frame: notices new tunnels, keeps every tube's state moving, and
   * says which mesh the camera is inside of.
   */
  update(camera, now = performance.now()) {
    if (!this.enabled || !this.vector.source) return;
    if (this.vector.tunnelVersion !== this.seenVersion) {
      this.seenVersion = this.vector.tunnelVersion;
      this.changedAt = now;
      this.tubesWanted = true;
    }
    for (const r of this.records.values()) this.#advance(r);
    if (this.retiring.length && this.retiring.some((r) => r.retireBy < now)) {
      this.retiring = this.retiring.filter((r) => { if (r.retireBy >= now) return true; this.#drop(r); return false; });
    }
    this.#inside(camera);
  }

  /**
   * Each placed portal's floor against the road in front of it as drawn. The road running out of a portal is pinned
   * to its floor (vector/portals.js) and held there for its first metres (shape.c PORTAL_HOLD: at Airolo's farm track
   * box a minor road meeting the track 3 m out had pulled them up to its own level, 0.6 m over the floor), but where a
   * more important road's level width reaches over the portal's front (a road passing right in front of it), that
   * level holds the ground there (shape.c: the most important level width wins), and the floor, placed from the
   * ground before any road was cut into it (#portalFloor), would stand under or over it: a step at the mouth, from
   * inside a band of ground across the bottom of the way out, a step the walker cannot take. Where the ground in
   * front is cut with the roads as they are now (this portal's pin among them), stands level across the way out and
   * is more than LIFT_TOL off the height the pin gives it, the floor takes that height (a refit, a new mesh, the pin
   * moved with it: then they agree, and nothing changes again).
   * @param groundAt  (lon, lat) => the ground as drawn there (accurate), or null
   * @param shapedAt  (lon, lat) => whether the ground there is cut with the roads as they are now
   */
  alignPortals(groundAt, shapedAt) {
    if (!this.enabled) return;
    for (const r of this.records.values()) {
      if (!r.mesh || !r.fit || r.skipped || r.meshBusy || r.meshWanted || !r.settled) continue;
      const near = r.tube, p = near.points;
      for (let e = 0; e < 2; e++) {
        const end = near.ends[e], f = r.fit.ends[e];
        if (end.type !== TUBE_END.PORTAL || !f) continue;
        const key = portalKey(end, near.family), tries = this.liftTries.get(key) ?? 0;
        if (tries >= LIFT_TRIES) continue;
        const floor = r.floorAt(p[e ? p.length - TUBE_POINT + 2 : 2]);
        const m = 111320 * Math.cos((end.lat * Math.PI) / 180), ox = end.dirX, oy = end.dirY;
        const a = Math.min(LIFT_ACROSS, f.outline.half / 2);
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
        const lift = Math.max(-LIFT_MOST, Math.min(LIFT_MOST, (this.lifts.get(key) ?? 0) + off));
        this.lifts.set(key, lift);
        this.liftTries.set(key, tries + 1);
        // Placed again with it (its floor's signature changes: a refit and a new mesh).
        r.settled = false;
      }
    }
  }

  /**
   * Each portal's tube start against the ground as cut now (5.17f). A tube starts where the ground covers it (fit.js
   * coverStart, from the ground as measured); short of it the road runs on in an open cutting of the least priority
   * (vector/portals.js), and where a more important road's level width reaches over the cutting (a road crossing over
   * the tube right at its portal: Airolo's farm track box under the pass road), that road's level holds the ground
   * there, over the vault: a wall in front of the mouth, which hid it and stopped the walker 0.7 m short of it. Along
   * the cutting's middle and TRIM_ACROSS of the way to its walls either side: where the ground as cut rises in each
   * from the cutting's own (TRIM_LOW over the floor at most) to over the vault and its concrete within TRIM_WALL (a
   * road's level width's edge, the terrain's triangles sloping it over the last of the cutting's), or holds over it
   * from the portal on, the tube starts where the first of them leaves the cutting's own (a refit, a new mesh, a
   * shorter cutting; it only ever moves out towards the portal, so it settles). Checked with alignPortals; what it
   * found per portal is kept for the probe (r.trimSeen); a portal is looked at again only once the ground or its tube
   * has changed since (`epoch`, and its fit's signature).
   * @param groundAt  (lon, lat) => the ground as drawn there from a tile the roads are cut into (accurate), or null
   * @param shapedAt  (lon, lat) => whether the ground there is cut with the roads as they are now
   * @param epoch     a number that changes whenever the ground as drawn may have (terrain/ground.js version)
   */
  trimStarts(groundAt, shapedAt, epoch = 0) {
    if (!this.enabled) return;
    for (const r of this.records.values()) {
      if (!r.mesh || !r.fit || r.skipped || r.open || r.meshBusy || r.meshWanted || !r.settled) continue;
      const near = r.tube, L = near.length;
      let spine = null, n = 0;
      for (let e = 0; e < 2; e++) {
        const end = near.ends[e], f = r.fit.ends[e];
        if (end.type !== TUBE_END.PORTAL || !f || !(f.start > TRIM_STEP)) continue;
        if (!spine) { spine = spineOf(near, r.section.half); n = spine.length / TUBE_POINT; }
        const stamp = `${epoch}|${r.sig}`;
        if (r.trimStamp?.[e] === stamp) continue;
        const top = f.outline.crown + (r.fit.collarWidth ?? 0), a = TRIM_ACROSS * f.outline.half;
        r.trimSeen ??= [null, null];
        let first = Infinity, seen = '';
        for (const c of [-a, 0, a]) {
          let low = null, found = null;
          // (To where the tube starts and no further: the cutting's own square end's step is just past it.)
          for (let k = 0, d = 0; d <= f.start; d = ++k * TRIM_STEP < f.start - 1e-6 ? k * TRIM_STEP : d < f.start ? f.start : Infinity) {
            const s = e ? L - d : d, q = middleAt(spine, n, s, c);
            const g = shapedAt(q[0], q[1]) ? groundAt(q[0], q[1]) : null;
            if (g === null) { seen = 'not cut yet'; break; }
            const over = g - r.floorAt(s);
            if (over >= top) { found = d; break; }
            if (over <= TRIM_LOW) low = d;
          }
          if (seen) break;
          // Nothing over the vault along it: the cutting holds (or a road's level part-way up, which would have the vault
          // through it); over it, but not straight up from the cutting's own: likewise.
          if (found === null) { seen = 'the cutting holds'; break; }
          const at = low === null ? (found === 0 ? 0 : null) : found - low <= TRIM_WALL ? low : null;
          if (at === null) { seen = `not a wall (${found.toFixed(1)} m in)`; break; }
          first = Math.min(first, at);
        }
        r.trimSeen[e] = seen || `a road's level from ${first.toFixed(1)} m in`;
        // (Looked at again when the ground has changed; until all of it is cut, every time.)
        if (seen !== 'not cut yet') (r.trimStamp ??= ['', ''])[e] = stamp;
        if (seen) continue;
        const key = portalKey(end, near.family), was = this.starts.get(key);
        if (was !== undefined && was <= first + 0.01) continue;
        this.starts.set(key, first);
        // Placed again with it (its signature changes: a refit and a new mesh).
        r.settled = false;
      }
    }
  }

  /** Metres in a portal's tube starts at most from the ground as cut (trimStarts), or null, for the probe. */
  trimAt(end, family) {
    return this.starts.get(portalKey(end, family)) ?? null;
  }

  /** Metres a portal's floor has followed the road in front of it (alignPortals), for the probe. */
  liftAt(end, family) {
    return this.lifts.get(portalKey(end, family)) ?? 0;
  }

  /* ---- the decode threads' turn ------------------------------------------- */

  #pick(cls) {
    if (!this.enabled || cls !== VIEW) return false;
    if (this.tubesWanted && !this.tubesBusy && performance.now() - this.changedAt >= GATHER_MS) { this.#runTubes(); return true; }
    for (const g of this.groundTiles.values()) if (g.state === 'wanted' && this.client.canRun(g.host)) { this.#runGround(g); return true; }
    for (const r of this.records.values()) if (r.traceWanted && this.client.canRun(r.traceHost)) { this.#runTrace(r); return true; }
    for (const r of this.records.values()) if (r.meshWanted) { this.#runMesh(r); return true; }
    return false;
  }

  async #runTubes() {
    this.tubesWanted = false;
    this.tubesBusy = true;
    const runs = [];
    for (const t of this.vector.tiles.values()) if (t.level === 0 && t.tunnels) runs.push(...t.tunnels);
    const priority = {};
    for (const k of this.vector.kinds ?? []) if (k) priority[k.id] = k.priority;
    try {
      const { tubes } = runs.length ? await this.client.run('tunnel-tubes', { runs, priority }, { cls: VIEW, cost: 1 }) : { tubes: [] };
      this.#reconcile(tubes);
    } catch (err) {
      if (err.name !== 'AbortError') { console.warn(`[tunnels] tubes: ${err.message}`); this.tubesWanted = true; this.changedAt = performance.now(); }
    } finally {
      this.tubesBusy = false;
    }
  }

  /* The new tubes against the old: the same tube (its key and length) keeps its state; the rest go. */
  #reconcile(tubes) {
    const next = new Map();
    for (const tube of tubes) {
      const old = this.records.get(tube.key);
      if (old && Math.abs(old.tube.length - tube.length) < 1) { next.set(tube.key, old); continue; }
      next.set(tube.key, this.#record(tube));
    }
    const now = performance.now();
    for (const [key, r] of this.records) {
      if (next.get(key) === r) continue;
      if (r.mesh && !r.dropped) { r.retireBy = now + RETIRE_MS; r.dropped = true; this.retiring.push(r); }
      else this.#drop(r);
    }
    this.records = next;
    this.stats.tubes = next.size;
    this.#lists();
  }

  #record(tube) {
    const kind = (this.vector.kinds ?? []).find((k) => k?.id === tube.kind) ?? null;
    return {
      tube, kind, whole: null, wholeAt: null, traceWanted: false, traceHost: '', traced: false,
      rule: null, section: null, fit: null, skipped: false, entry: null, sig: '', meshWanted: false, meshBusy: false, mesh: null, failed: 0,
    };
  }

  /* ---- a tube's way to a mesh ----------------------------------------------- */

  #advance(r) {
    if (r.settled) return;
    const near = r.tube;
    // 1. The whole tunnel, if this is only part of it.
    const open = near.ends.filter((e) => e.type === TUBE_END.OPEN);
    if (open.length && !r.whole) {
      const found = this.#wholeFor(near, open);
      if (found) this.#adoptWhole(r, found);
      else if (!r.traced && !r.traceWanted && !r.traceBusy && !(r.traceAgainAt > performance.now())) {
        r.traceWanted = true;
        r.traceHost = hostOf(this.vector.source.templates[0]);
      }
    }
    if (!open.length && !r.whole) this.#adoptWhole(r, near);
    if (open.length && !r.whole && !r.traced) return;   // the far portal is still being looked for
    // 2. Its portals' heights, and the ground along it and round its portals for its fit.
    const whole = r.whole ?? near;
    r.entry ??= r.whole ? tableEntry(whole) : null;
    // A short whole tunnel must fit under the ground (one whose far end was not found is not known to be short).
    const short = Boolean(r.whole) && whole.length <= SHORT;
    const heights = [NaN, NaN];
    let waiting = false;
    for (let e = 0; e < 2; e++) {
      const end = whole.ends[e];
      if (end.type !== TUBE_END.PORTAL) continue;
      // The near tube's own portal is the better placed (z14), where it is this end: the nearest within 60 m (a short
      // tube's other portal may be as near).
      let mine = whole === near ? near.ends[e] : end;
      if (whole !== near) {
        let nearest = 60;
        for (const n of near.ends) if (n.type === TUBE_END.PORTAL && distance(n, end) < nearest) { nearest = distance(n, end); mine = n; }
      }
      const g = this.#portalFloor(mine, near.family);
      // (And how far the road in front as drawn has moved it: alignPortals.)
      if (g.state === 'done') heights[e] = g.height + (this.lifts.get(portalKey(mine, near.family)) ?? 0);
      else if (g.state !== 'failed') waiting = true;
    }
    // The near tube's own portals' approaches (their rise outwards: the ground out of a portal is held against it).
    const slopes = near.ends.map((n) => {
      if (n.type !== TUBE_END.PORTAL) return 0;
      const g = this.#portalFloor(n, near.family);
      if (g.state === 'tiles') waiting = true;
      return g.slope ?? 0;
    });
    r.rule ??= sectionFor(near, r.kind, r.entry, whole.length);
    // The ground along the whole of it and round its portals (a long tube's middle from coarser tiles: fit.js).
    const fg = this.#groundFor(`f|${near.key}|${short ? 1 : 0}`, () => fitPoints(near, short));
    if (fg.state === 'tiles') waiting = true;
    if (waiting) return;
    // 3. The floor by its portals.
    const length = whole.length;
    const pa = whole.points, pb = whole.points.length - TUBE_POINT;
    const floor = floorProfile(length, heights[0], heights[1], r.entry, pa[1], pa[pb + 1]);
    if (!floor) { r.unplaced = true; r.settled = !open.length || r.traced; return; }
    r.unplaced = false;
    // (And where the ground as cut has its tubes start at most: trimStarts.)
    const starts = near.ends.map((n) => (n.type === TUBE_END.PORTAL ? this.starts.get(portalKey(n, near.family)) : undefined));
    const sig = `${heights[0].toFixed(2)}|${heights[1].toFixed(2)}|${r.entry?.name ?? ''}|${starts.map((v) => v?.toFixed(2) ?? '').join(',')}`;
    if (sig === r.sig || r.meshBusy) return;
    r.sig = sig;
    const at = r.wholeAt ?? { s0: 0, sign: 1 };
    r.baseAt = (s) => floor(at.s0 + at.sign * s);
    // 4. Fitted to the ground: its section where it is shallow, its portals' faces, its floor kept under the ground;
    // or no room for it at all.
    const known = fg.state === 'done' ? fg.heights : null;
    r.fit = fitTube({
      tube: near, floorAt: r.baseAt, section: r.rule, clearance: clearanceFor(near, r.kind), kind: r.kind, short, slopes,
      pts: fg.pts, heights: known, starts,
    });
    r.floorAt = r.fit.floorAt ?? r.baseAt;
    // No ground over it anywhere (5.17f): no tube, the open cutting the whole way (#lists, vector/portals.js).
    r.open = Boolean(r.fit.section && r.fit.open);
    if (r.open) {
      r.section = r.fit.section;
      r.skipped = false;
      r.settled = true;
      if (r.mesh) { this.#freeMesh(r.mesh); r.mesh = null; }
      this.#lists();
      return;
    }
    if (!r.fit.section) {
      // The terrain stays whole there, and the line is not drawn (a tunnel's never is on the ground).
      r.skipped = true;
      r.settled = true;
      if (r.mesh) { this.#freeMesh(r.mesh); r.mesh = null; }
      this.#lists();
      return;
    }
    r.skipped = false;
    r.section = r.fit.section;
    r.meshWanted = true;
  }

  /* A traced whole tunnel this session that passes the near tube's open ends. */
  #wholeFor(near, open) {
    for (const w of this.wholes) {
      if (w.family !== near.family) continue;
      if (open.every((e) => placeOn(w, e.lon, e.lat).off <= MATCH)) return w;
    }
    return null;
  }

  /* Where the near tube lies along the whole: its first point's metres along it, and which way it runs. */
  #adoptWhole(r, whole) {
    r.whole = whole;
    if (whole === r.tube) { r.wholeAt = { s0: 0, sign: 1 }; return; }
    const p = r.tube.points, last = p.length - TUBE_POINT;
    const a = placeOn(whole, p[0], p[1]), b = placeOn(whole, p[last], p[last + 1]);
    r.wholeAt = { s0: a.s, sign: b.s >= a.s ? 1 : -1 };
  }

  async #runTrace(r) {
    r.traceWanted = false;
    r.traceBusy = true;
    const near = r.tube, e = near.ends.find((x) => x.type === TUBE_END.OPEN);
    const m = 111320 * Math.cos((e.lat * Math.PI) / 180);
    const lon = e.lon + (e.dirX * TRACE_IN) / m, lat = e.lat + (e.dirY * TRACE_IN) / 111132;
    try {
      const got = await this.client.run('tunnel-trace', {
        family: near.family, lon, lat, templates: this.vector.source.templates, schema: this.vector.source.schema, priority: 'low',
      }, { cls: VIEW, cost: 4, host: r.traceHost, timeout: 90000 });
      if (got.tube) {
        if (!this.wholes.some((w) => w.key === got.tube.key)) this.wholes.push(got.tube);
        this.stats.traced++;
        this.stats.traceTiles += got.tiles;
        this.stats.traceBytes += got.bytes;
        // Only a traced tunnel that is this one: both open ends on it.
        const open = near.ends.filter((x) => x.type === TUBE_END.OPEN);
        if (open.every((x) => placeOn(got.tube, x.lon, x.lat).off <= MATCH)) this.#adoptWhole(r, got.tube);
      }
    } catch (err) {
      r.traceBusy = false;
      if (err.name === 'AbortError') return;
      // A service that failed is asked again a little later, twice, before the tube goes on without its far end.
      r.traceFails = (r.traceFails ?? 0) + 1;
      if (r.traceFails < 3) { r.traceAgainAt = performance.now() + 20000 * r.traceFails; return; }
      this.stats.failed++;
      console.warn(`[tunnels] trace from ${lon.toFixed(5)}, ${lat.toFixed(5)}: ${err.message}`);
    }
    r.traceBusy = false;
    // Found or not, the tube goes on: without its far portal, its floor runs level from the one it has.
    r.traced = true;
  }

  /* ---- the ground ------------------------------------------------------------ */

  /* A portal's floor: the road right in front of it (his words on 5.17c: "base of tunnel must be base of road in
   * front of it (nearest one)"), the ground along its approach (a bridge's deck where one meets it): the first
   * metres out taken back to the portal at the rise of the ground to RISE_REACH out, their median; unless that
   * stands on the hillside's face over the line through the approach's ground on beyond (Siegel's). Once its tiles
   * are in, `height` and `slope` (its rise a metre out). */
  #portalFloor(end, family) {
    const key = `a|${family}|${end.lon.toFixed(5)}|${end.lat.toFixed(5)}`;
    const ALL = [...NEAR, ...APPROACH];
    const g = this.#groundFor(key, () => ({ lonlat: alongApproach(end, this.#approachOf(end), ALL) }));
    if (g.state === 'done' && g.height === undefined) {
      const nd = [], nh = [], ds = [], hs = [], rd = [], rh = [];
      ALL.forEach((d, i) => {
        const deck = this.vector.decks?.heightAt(g.lonlat[2 * i], g.lonlat[2 * i + 1]) ?? NaN;
        const h = Number.isFinite(deck) ? deck : g.heights[i];
        if (!Number.isFinite(h)) return;
        if (d < APPROACH[0]) { nd.push(d); nh.push(h); } else { ds.push(d); hs.push(h); }
        if (d <= RISE_REACH) { rd.push(d); rh.push(h); }
      });
      const line = ds.length >= 3 ? approachLine(ds, hs) : { height: ds.length ? hs[0] : NaN, slope: 0 };
      const rise = rd.length >= 3 ? approachLine(rd, rh).slope : line.slope;
      const front = nd.length >= 3 ? median(nd.map((d, i) => nh[i] - rise * d)) : NaN;
      const onFace = Number.isFinite(line.height) && front > line.height + NEAR_OVER;
      g.height = Number.isFinite(front) && !onFace ? front : line.height;
      g.slope = onFace ? line.slope : rise;
      g.near = front;
      g.line = line.height;
      if (!Number.isFinite(g.height)) g.state = 'failed';
    }
    return g;
  }

  /* The open line on beyond a portal (runs.js `approach`, of the run whose end it is), or null. */
  #approachOf(end) {
    const m = 111320 * Math.cos((end.lat * Math.PI) / 180);
    let best = null, bestGap = APPROACH_MATCH;
    for (const t of this.vector.tiles.values()) {
      if (t.level !== 0 || !t.tunnels) continue;
      for (const run of t.tunnels) {
        for (let e = 0; e < 2; e++) {
          const line = run.ends[e].approach;
          if (!line) continue;
          const k = e ? run.points.length - 2 : 0;
          const gap = Math.hypot((run.points[k] - end.lon) * m, (run.points[k + 1] - end.lat) * 111132);
          if (gap < bestGap) { bestGap = gap; best = line; }
        }
      }
    }
    return best;
  }

  /* A list of points whose ground is wanted (`make` gives { lonlat: [lon, lat, …], … } the first time; the rest
   * is kept as `pts`): asks for its tiles, and once they are in its `heights` (NaN where not known). */
  #groundFor(key, make) {
    let g = this.grounds.get(key);
    if (!g) {
      const pts = make();
      g = { key, pts, lonlat: pts.lonlat, pointTiles: [], tiles: [], heights: null, state: 'tiles' };
      for (let i = 0; i < g.lonlat.length; i += 2) {
        const tile = this.#groundTile(g.lonlat[i], g.lonlat[i + 1], pts.under?.[i / 2] ?? Infinity);
        g.pointTiles.push(tile);
        if (tile && !g.tiles.includes(tile)) g.tiles.push(tile);
      }
      if (!g.tiles.length) g.state = 'failed';
      if (this.grounds.size >= GROUNDS_MOST) {
        // The oldest lists done with go (a record still wanting one asks again).
        for (const [k, q] of this.grounds) {
          if (this.grounds.size < GROUNDS_MOST * 0.75) break;
          if (q.state !== 'tiles') this.grounds.delete(k);
        }
      }
      this.grounds.set(key, g);
      this.stats.grounds = this.grounds.size;
    }
    if (g.state === 'tiles') this.#resolveGround(g);
    return g;
  }

  /* The finest terrain tile a service has at a point (below level `under`), as a ground record (asked for when
   * first wanted). */
  #groundTile(lon, lat, under = Infinity) {
    const source = this.terrain.sourceList.find((s) => s.adapter.covers(lon, lat));
    if (!source) return null;
    for (let z = Math.min(source.maxLevel, GROUND_LEVEL, under - 1); z >= LEAST_LEVEL; z--) {
      const { x, y } = tileAt(z, lon, lat);
      if (!source.isAvailable(z, x, y)) continue;
      const key = tileKey(z, x, y);
      let t = this.groundTiles.get(key);
      if (!t) {
        const url = source.urlFor(z, x, y);
        t = { key, z, x, y, url, rect: tileRect(z, x, y), accept: source.accept, host: hostOf(url), state: 'wanted', entry: null };
        this.groundTiles.set(key, t);
      }
      return t;
    }
    return null;
  }

  async #runGround(t) {
    t.state = 'busy';
    try {
      const data = await this.client.run('terrain-ground', { url: t.url, rect: t.rect, accept: t.accept },
        { cls: VIEW, cost: 2, host: t.host, timeout: 20000 });
      t.entry = data.missing ? null : groundEntry(data, t.rect, { z: t.z, x: t.x, y: t.y });
      t.state = 'done';
    } catch (err) {
      if (err.name === 'AbortError') { t.state = 'wanted'; return; }
      t.state = 'done';
      this.stats.failed++;
      console.warn(`[tunnels] ground ${t.z}/${t.x}/${t.y}: ${err.message}`);
    }
  }

  /* Once a list's tiles are in: its points sampled. A tile the service did not have after all gives way to the next
   * coarser one there. */
  #resolveGround(g) {
    let again = false;
    for (let i = 0; i < g.pointTiles.length; i++) {
      const t = g.pointTiles[i];
      if (t?.state !== 'done' || t.entry) continue;
      const coarser = this.#groundTile(g.lonlat[2 * i], g.lonlat[2 * i + 1], t.z);
      g.pointTiles[i] = coarser;
      if (coarser && !g.tiles.includes(coarser)) g.tiles.push(coarser);
      again = true;
    }
    if (again) g.tiles = g.tiles.filter((t) => g.pointTiles.includes(t));
    if (g.tiles.some((t) => t.state !== 'done')) return;
    const now = performance.now();
    g.heights = new Float64Array(g.pointTiles.length);
    let known = 0;
    for (let i = 0; i < g.pointTiles.length; i++) {
      const t = g.pointTiles[i];
      const ok = Boolean(t?.entry) && sampleEntry(t.entry, g.lonlat[2 * i], g.lonlat[2 * i + 1], this.scratch);
      g.heights[i] = ok ? this.scratch.height : NaN;
      if (ok) known++;
    }
    for (const t of g.tiles) t.usedAt = now;
    g.state = known ? 'done' : 'failed';
    this.#trimTiles();
  }

  /* The terrain tiles kept indexed: at most GROUND_TILES_MOST, those no list waits for going first, the least
   * lately used first (one wanted again is asked for again). */
  #trimTiles() {
    if (this.groundTiles.size > GROUND_TILES_MOST) {
      const waited = new Set();
      for (const g of this.grounds.values()) if (g.state === 'tiles') for (const t of g.tiles) waited.add(t);
      const spare = [...this.groundTiles.values()].filter((t) => t.state === 'done' && !waited.has(t)).sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
      for (const t of spare) {
        if (this.groundTiles.size <= GROUND_TILES_MOST) break;
        this.groundTiles.delete(t.key);
      }
    }
    this.stats.groundTiles = this.groundTiles.size;
  }

  /* ---- meshes ----------------------------------------------------------------- */

  async #runMesh(r) {
    r.meshWanted = false;
    r.meshBusy = true;
    const sig = r.sig, zoom = MESH_ZOOM, sec = r.section, near = r.tube;
    const t0 = performance.now();
    try {
      // From where the ground covers it at each portal (5.17f: short of it the road runs on in an open cutting;
      // 5.17e started it at the portal as mapped, its roof and concrete out of the ground for its first metres).
      const f = r.fit.ends;
      const from = f[0]?.start ?? 0, to = near.length - (f[1]?.start ?? 0);
      const mp = meshPoints(near, r.floorAt, sec.half, zoom, from, to);
      const o = mp.origin, origin = geodeticToEcef(o.lon, o.lat, o.h);
      const ends = near.ends.map(meshEnd);
      // No wing walls (5.17d): the road's own cut holds the slope beside the approach (shape.c, pinned at the portal).
      const spec = { origin: [origin[0], origin[1], origin[2]], ends, spring: sec.spring, ringStep: 25, collar: r.fit.collarWidth ?? COLLAR_WIDTH,
        ceiling: sec.ceiling ?? 0, collarDepth: [f[0]?.collar ?? 0, f[1]?.collar ?? 0], shell: [f[0]?.shell ?? 0, f[1]?.shell ?? 0], wingTop: [0, 0],
        rise: [f[0]?.rise ?? 0, f[1]?.rise ?? 0] };
      // The room it takes, cut out of the terrain and of what is built (cuts.js): from its points before they go to
      // the decode thread; where the ground is far over its vault, nothing can reach into it.
      const coverAt = r.fit.floor ? coverAlong(r.fit.floor) : null;
      const cut = boreCut(mp, sec, near.ends.map((e, i) => ({ type: ends[i], dirX: e.dirX, dirY: e.dirY, collar: f[i]?.collar ?? 0, rise: f[i]?.rise ?? 0 })), coverAt);
      const sphere = meshSphere(mp, sec, r.fit.collarWidth ?? COLLAR_WIDTH);
      const points = mp.points, profile = Float32Array.from(sec.points);
      const m = await this.client.run('tunnel-mesh', { spec, points, profile }, { cls: VIEW, cost: 1, transfer: [points.buffer, profile.buffer] });
      if (this.records.get(near.key) !== r || r.sig !== sig) { this.client.recycle(m.vertices, m.indices); return; }
      const lamps = LAMPS[near.family] ?? LAMPS[3];
      const mesh = {
        record: r, origin, zoom, mercOrigin: [o.mx, o.my],
        // Round every point of it (5.17d's was round its middle point, half its length: a bent tube's or one whose
        // points crowd round a bend left part of it out, and it went at some angles).
        center: sphere.center, radius: sphere.radius,
        vbuf: null, ibuf: null, indexCount: m.indexCount, bytes: m.vertexCount * m.stride + m.indexCount * 4,
        lampStep: lamps.step, lamp: lampAt(sec, lamps.place), lampColour: lamps.colour, lampSize: lamps.size,
        // Lamps on a ceiling slab stay at its height however wide the bore (the shader lifts only those over spring).
        family: near.family, wall: WALLS[near.family] ?? WALLS[3], spring: sec.ceiling ? 1000 : sec.spring,
        // The daylight falls in at each mouth.
        portals: [f[0] ? from : -1e9, f[1] ? to : 1e9],
        inside: false,
        cut,
      };
      await this.uploads.schedule(() => {
        const vbytes = m.vertexCount * m.stride, ibytes = m.indexCount * 4;
        mesh.vbuf = this.device.createBuffer({ label: 'tunnel-vertices', size: vbytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
        mesh.ibuf = this.device.createBuffer({ label: 'tunnel-indices', size: ibytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(mesh.vbuf, 0, m.vertices.buffer, m.vertices.byteOffset, vbytes);
        this.device.queue.writeBuffer(mesh.ibuf, 0, m.indices.buffer, m.indices.byteOffset, ibytes);
      });
      this.client.recycle(m.vertices, m.indices);
      if (this.records.get(near.key) !== r || r.sig !== sig) { mesh.vbuf.destroy(); mesh.ibuf.destroy(); return; }
      this.#setMesh(r, mesh);
      this.stats.meshMs = performance.now() - t0;
      // Nothing it waits for any more: its whole tunnel, its portals' ground and its mesh are in.
      r.settled = r.sig === sig;
    } catch (err) {
      if (err.name !== 'AbortError') {
        r.failed++;
        this.stats.failed++;
        console.warn(`[tunnels] mesh ${near.kind} ${near.length.toFixed(0)} m: ${err.message}`);
      } else {
        r.sig = '';
      }
    } finally {
      r.meshBusy = false;
    }
  }

  #setMesh(r, mesh) {
    if (r.mesh) this.#freeMesh(r.mesh);
    r.mesh = mesh;
    // The box round it (degrees), for boreAt: its spine and 30 m round.
    const p = r.tube.points;
    let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
    for (let k = 0; k < p.length; k += TUBE_POINT) { w = Math.min(w, p[k]); e = Math.max(e, p[k]); so = Math.min(so, p[k + 1]); no = Math.max(no, p[k + 1]); }
    const dl = 30 / (111320 * Math.cos((so * Math.PI) / 180)), dt = 30 / 111132;
    r.box = [w - dl, so - dt, e + dl, no + dt];
    this.gpuBytes += mesh.bytes;
    // What it takes the place of goes now.
    const b = r.box;
    this.retiring = this.retiring.filter((q) => {
      const c = q.box, over = q.tube.family === r.tube.family && c[0] <= b[2] && b[0] <= c[2] && c[1] <= b[3] && b[1] <= c[3];
      if (over) this.#drop(q);
      return !over;
    });
    this.#lists();
  }

  #freeMesh(mesh) {
    mesh.vbuf?.destroy();
    mesh.ibuf?.destroy();
    this.gpuBytes -= mesh.bytes;
  }

  #drop(r) {
    if (r.mesh) { this.#freeMesh(r.mesh); r.mesh = null; }
    r.dropped = true;
    this.#lists();
  }

  #clear() {
    for (const r of this.records.values()) this.#drop(r);
    for (const r of this.retiring) this.#drop(r);
    this.records.clear();
    this.retiring = [];
    this.#lists();
  }

  /* What the pass draws, what the terrain and what is built are cut along, and where the portals are: from every
   * placed tube. */
  #lists() {
    this.meshes = [];
    this.portals = [];
    for (const r of [...this.records.values(), ...this.retiring]) {
      if (r.dropped && !r.retireBy) continue;
      // A tube drawn, or one with no ground over it anywhere: its portals' roads run on in an open cutting (5.17f).
      if (r.mesh) this.meshes.push(r.mesh);
      else if (!(r.open && r.fit) || r.dropped) continue;
      const near = r.tube, p = near.points;
      for (let e = 0; e < 2; e++) {
        const end = near.ends[e], f = r.fit?.ends[e];
        if (end.type !== TUBE_END.PORTAL || !f) continue;
        const o = e ? p.length - TUBE_POINT : 0, floor = r.floorAt(p[o + 2]);
        this.portals.push({
          lon: end.lon, lat: end.lat, h: floor,
          // Into the tunnel (against the end's outward way); out of it the floor rises as its approach does.
          dirX: -end.dirX, dirY: -end.dirY, rise: f.rise,
          half: f.outline.half + Math.abs(f.offset),
          // Its walls' concrete there (fit.js collarWidth: the mesh's collar).
          wall: r.fit.collarWidth ?? 0,
          // How far round it the terrain's tiles are drawn from both sides (seen from inside the tunnel, the ground
          // round the way out is met from beneath: terrain.wgsl fsCut).
          reach: PORTAL_REACH + f.outline.half + Math.abs(f.offset),
          ecef: geodeticToEcef(end.lon, end.lat, floor),
          // Where the tube starts, metres in (fit.js: where the ground covers it), and the open cutting up to there.
          start: f.start ?? 0,
          cutting: cuttingOf(r, e),
        });
      }
    }
    this.stats.meshes = this.meshes.length;
    let skipped = 0;
    for (const r of this.records.values()) if (r.skipped) skipped++;
    this.stats.skipped = skipped;
    // The terrain and what is built are cut away along every tube drawn (passes/terrain.js and buildings.js ask
    // again when this changes).
    this.cuts = this.meshes.map((m) => m.cut).filter(Boolean);
    this.cutVersion++;
    // Each portal's floor, for the road running into it (vector/portals.js): told to the road tiles when it changes.
    // (And the tunnel's half-width there to its walls' outer faces: the road's level cut in front of it is as wide as
    // the tunnel and its walls, else a line of sight out through the mouth's lower corners runs on under its banks.)
    // (And the open cutting from the portal to where the tube starts: 5.17f.)
    const floors = this.portals.map((q) => ({
      lon: q.lon, lat: q.lat, height: q.h, rise: q.rise, half: q.half + q.wall, outX: -q.dirX, outY: -q.dirY, cutting: q.cutting,
    }));
    const sig = floors.map((q) => `${q.lon.toFixed(6)},${q.lat.toFixed(6)},${q.height.toFixed(2)},${q.rise.toFixed(3)},${q.half.toFixed(2)},${q.outX.toFixed(3)},${q.outY.toFixed(3)},${q.cutting ? q.cutting.length + ':' + q.cutting[q.cutting.length - 2].toFixed(1) : 0}`).join('|');
    if (sig !== this.floorSig) {
      this.floorSig = sig;
      this.vector.setPortalFloors?.(floors);
    }
  }

  /* Which mesh the camera is in (no outdoor haze on it), and where along it. */
  #inside(camera) {
    const bore = this.boreAt(camera.lon, camera.lat, camera.height - 1.5);
    for (const m of this.meshes) {
      m.inside = bore !== null && bore.record === m.record && bore.s >= 0 && bore.s <= m.record.tube.length;
      if (m.inside) m.insideAt = bore.s;
    }
  }

  /**
   * The light at the eye against daylight on level ground: 1 outside a tunnel; inside, the daylight falling in at
   * its portals (as tunnel.wgsl tDaylight has it) and its lamps' (EYE.interior). render.js adapts the eye to it.
   */
  eyeLight() {
    if (!this.enabled) return 1;
    for (const m of this.meshes) {
      if (!m.inside) continue;
      const d0 = Math.max(m.insideAt - m.portals[0], 0), d1 = Math.max(m.portals[1] - m.insideAt, 0);
      const fall = 0.55 * (Math.exp(-d0 / 18) + Math.exp(-d1 / 18)) + 0.08 * (Math.exp(-d0 / 90) + Math.exp(-d1 / 90));
      return Math.min(1, fall) + EYE.interior;
    }
    return 1;
  }

  /**
   * The tube a point is inside (from the collar out of the hillside at a portal to its far end), or null: its
   * floor there and the ground to stand on (a walkway is a kerb higher), its vault over the point, how far right of
   * the bore's middle the point is and how far it may go, which way right is, and its outline as drawn (wallHalf,
   * wallTop, archY/A/H: bore.js boreHalfAt). Flying, walking and the airplane ask it every physics step
   * (controllers/): inside a tunnel the terrain above is not the floor, the tunnel's is, and its walls and vault
   * hold the body in.
   * @param feet  metres above the ellipsoid
   * @param past  metres beyond each collar it still answers for (roomAt)
   */
  boreAt(lon, lat, feet, out = this.bore, past = 0) {
    for (const m of this.meshes) {
      const r = m.record, b = r.box;
      if (!b || lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      const near = r.tube, L = near.length, p = near.points, last = p.length - TUBE_POINT;
      const mx = 111320 * Math.cos((lat * Math.PI) / 180);
      let s, across, middle, extra, rightX, rightY;
      // Beyond an end (the collar's stretch out of the hillside): along and across from the end itself.
      const e0 = near.ends[0], e1 = near.ends[1];
      const d0x = (lon - e0.lon) * mx, d0y = (lat - e0.lat) * 111132, d1x = (lon - e1.lon) * mx, d1y = (lat - e1.lat) * 111132;
      const beyond0 = d0x * e0.dirX + d0y * e0.dirY, beyond1 = d1x * e1.dirX + d1y * e1.dirY;
      if (beyond0 > 0) {
        s = -beyond0; rightX = -e0.dirY; rightY = e0.dirX; across = d0x * rightX + d0y * rightY; middle = p[3]; extra = p[4];
      } else if (beyond1 > 0) {
        s = L + beyond1; rightX = e1.dirY; rightY = -e1.dirX; across = d1x * rightX + d1y * rightY; middle = p[last + 3]; extra = p[last + 4];
      } else {
        const at = placeOn(near, lon, lat, r.lastK ?? -1, r.at ??= {});
        r.lastK = at.k;
        s = at.s; across = at.across; middle = at.middle; extra = at.extra; rightX = at.dirY; rightY = -at.dirX;
      }
      // Only where the tube is (from where the ground covers it at a portal: short of it, the open cutting's ground).
      const f = r.fit?.ends ?? [null, null];
      const lo = f[0] ? (f[0].start ?? 0) - f[0].collar - past : 0, hi = f[1] ? L - (f[1].start ?? 0) + f[1].collar + past : L;
      if (s < lo || s > hi) continue;
      const sec = r.section, half = sec.half + extra, a = across - middle;
      if (Math.abs(a) > half + 0.5) continue;
      // Out of a portal (its collar's stretch) the floor runs on as the approach does.
      const fe = s < 0 ? f[0] : s > L ? f[1] : null;
      const floor = r.floorAt(Math.min(L, Math.max(0, s))) + (fe ? fe.rise * (s < 0 ? -s : s - L) : 0);
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
      // The ground to stand on: a walkway's kerb higher beside the floor.
      const kerbFrom = sec.kerb > 0 && sec.walkway > 0 ? (sec.arch && sec.low.top < sec.spring ? sec.low.half : sec.half - sec.walkway) * wide : Infinity;
      out.record = r; out.s = s; out.floor = floor; out.top = top; out.across = a; out.half = half;
      out.ground = floor + (Math.abs(a) > kerbFrom ? sec.kerb : 0);
      out.wallHalf = sec.low.half * wide; out.wallTop = wallTop; out.archY = archY; out.archA = archA; out.archH = archH;
      out.rightX = rightX; out.rightY = rightY;
      return out;
    }
    return null;
  }

  /**
   * Whether a body (its feet, metres above the ellipsoid) is in the room a tube takes out of what is built: inside
   * its bore, or the cut's reach beyond a collar (cuts.js CUT_PAST). The controllers leave the buildings' solids alone
   * there: they are not drawn (buildings.wgsl fsCut), so they neither hold a body up nor stop it.
   */
  roomAt(lon, lat, feet) {
    if (!this.enabled) return false;
    const b = this.boreAt(lon, lat, feet, this.room, CUT_PAST);
    return b !== null && Math.abs(b.across) <= b.half && feet >= b.floor - 0.6 && feet <= b.top;
  }

  get bytes() { return this.gpuBytes; }
}

/* A near tube's end as its mesh finishes it. */
function meshEnd(e) {
  switch (e.type) {
    case TUBE_END.PORTAL: return MESH_END.PORTAL;
    case TUBE_END.OPEN: return MESH_END.DARK;
    case TUBE_END.CLOSED: return MESH_END.WALL;
    default: return MESH_END.JOIN;
  }
}

/* Where a family's lamps go on a cross-section: in the vault a little right of the middle, or on the right wall a
 * metre up; the point of the loop there. */
function lampAt(sec, place) {
  const p = sec.points, n = sec.count;
  let best = null;
  if (place === 'vault' && sec.ceiling) return [0.4 * sec.half, sec.ceiling - 0.05];
  if (place === 'vault') {
    // The loop's highest point at 0.4 of the half-width to the right.
    const a = 0.4 * sec.half;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a0 = p[i * 4], a1 = p[j * 4], h0 = p[i * 4 + 1], h1 = p[j * 4 + 1];
      if ((a0 - a) * (a1 - a) > 0 || a0 === a1) continue;
      const h = h0 + ((h1 - h0) * (a - a0)) / (a1 - a0);
      if (!best || h > best[1]) best = [a, h - 0.05];
    }
  } else {
    // The loop's rightmost point a metre up.
    const h = 1.0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, a0 = p[i * 4], a1 = p[j * 4], h0 = p[i * 4 + 1], h1 = p[j * 4 + 1];
      if ((h0 - h) * (h1 - h) > 0 || h0 === h1) continue;
      const a = a0 + ((a1 - a0) * (h - h0)) / (h1 - h0);
      if (!best || a > best[0]) best = [a - 0.05, h];
    }
  }
  return best ?? [0, sec.height - 0.3];
}

/* The ground over a fitted tube's vault along it (fit.js floor: its samples' ground, floor and vault): s => metres
 * (NaN where not known), linear between the samples. */
function coverAlong(floor) {
  const n = floor.ss.length, cover = new Float64Array(n);
  for (let i = 0; i < n; i++) cover[i] = floor.gs[i] - floor.zs[i] - floor.crowns[i];
  return (s) => {
    if (!n) return NaN;
    let lo = 0, hi = n - 1;
    if (s <= floor.ss[0]) return cover[0];
    if (s >= floor.ss[hi]) return cover[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (floor.ss[mid] <= s) lo = mid; else hi = mid; }
    const f = (s - floor.ss[lo]) / Math.max(1e-9, floor.ss[hi] - floor.ss[lo]);
    // (Where either sample is not known, neither is the cover between.)
    return cover[lo] + (cover[hi] - cover[lo]) * f;
  };
}

/* A sphere round a mesh (earth-centred metres): round all of its points, as far again as its section reaches round
 * one (its width, its height, the collar's concrete) and a little more. */
function meshSphere(mp, sec, collar) {
  const p = mp.points, n = mp.count, pts = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let widest = 1, offset = 0;
  for (let k = 0; k < n; k++) {
    const o = k * POINT_DOUBLES, e = geodeticToEcef(p[o], p[o + 1], p[o + 2]);
    pts.push(e);
    for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], e[j]); hi[j] = Math.max(hi[j], e[j]); }
    widest = Math.max(widest, p[o + 8]);
    offset = Math.max(offset, Math.abs(p[o + 7]));
  }
  const center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let radius = 0;
  for (const e of pts) radius = Math.max(radius, Math.hypot(e[0] - center[0], e[1] - center[1], e[2] - center[2]));
  const reach = Math.hypot(sec.half * widest + offset, sec.height * Math.sqrt(widest)) + collar + 2;
  return { center, radius: radius + reach };
}

/* The open cutting from portal e of a tube to where the tube starts (fit.js `start`, 5.17f): points every CUTTING_STEP
 * metres along the bore's middle to its headwall (the cutting ends square there: shape.c), each [lon, lat, floor,
 * metres in, the floor's rise a metre further in] (vector/portals.js pins the cutting's ground to them), or null where
 * the tube starts at the portal. */
const CUTTING_STEP = 2, CUTTING_PAST = 0;
function cuttingOf(r, e) {
  const f = r.fit?.ends[e], start = f?.start ?? 0;
  if (!(start > 0.25)) return null;
  const sec = r.section ?? r.fit.section, tube = r.tube, L = tube.length, p = spineOf(tube, sec.half), n = p.length / TUBE_POINT;
  const reach = Math.min(L, start + CUTTING_PAST), out = [];
  const at = (d) => Math.min(L, Math.max(0, e ? L - d : d));
  for (let d = 0; ; d = Math.min(reach, d + CUTTING_STEP)) {
    const s = at(d), q = middleAt(p, n, s);
    out.push(q[0], q[1], r.floorAt(s), d, (r.floorAt(at(d + 1)) - r.floorAt(at(d - 1))) / 2);
    if (d >= reach) break;
  }
  return Float64Array.from(out);
}

/* The bore's middle at s along a spine (TUBE_POINT doubles a point): [lon, lat], its offset right of the line (and
 * `across` metres further right). */
function middleAt(p, n, s, across = 0) {
  let k = 0;
  while (k + 2 < n && p[(k + 1) * TUBE_POINT + 2] < s) k++;
  const a = k * TUBE_POINT, b = Math.min(n - 1, k + 1) * TUBE_POINT, span = p[b + 2] - p[a + 2];
  const t = span > 1e-9 ? Math.min(1, Math.max(0, (s - p[a + 2]) / span)) : 0;
  const lon = p[a] + (p[b] - p[a]) * t, lat = p[a + 1] + (p[b + 1] - p[a + 1]) * t, off = p[a + 3] + (p[b + 3] - p[a + 3]) * t + across;
  const m = 111320 * Math.cos((lat * Math.PI) / 180), dx = (p[b] - p[a]) * m, dy = (p[b + 1] - p[a + 1]) * 111132, l = Math.hypot(dx, dy) || 1;
  return [lon + (off * dy) / l / m, lat - (off * dx) / l / 111132];
}

/* A portal's key (its family and place, to a metre or so): what its floor is moved by is kept under it. */
function portalKey(end, family) {
  return `${family}|${end.lon.toFixed(5)}|${end.lat.toFixed(5)}`;
}

/* Metres between two ends (lon/lat). */
function distance(a, b) {
  const m = 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((a.lon - b.lon) * m, (a.lat - b.lat) * 111132);
}

/* Points `ds` metres out along a portal's approach ([lon, lat, …]): along its line where known (from the portal
 * out), then straight on along its last piece (along the portal's own way out where there is none). */
function alongApproach(end, line, ds) {
  const m = 111320 * Math.cos((end.lat * Math.PI) / 180);
  const xs = [0], ys = [0];
  if (line) for (let i = 0; i < line.length; i += 2) { xs.push((line[i] - end.lon) * m); ys.push((line[i + 1] - end.lat) * 111132); }
  const out = new Float64Array(ds.length * 2);
  let seg = 0, at = 0;
  ds.forEach((d, i) => {
    while (seg + 1 < xs.length) {
      const l = Math.hypot(xs[seg + 1] - xs[seg], ys[seg + 1] - ys[seg]);
      if (at + l >= d && l > 1e-6) break;
      at += l;
      seg++;
    }
    let x, y;
    if (seg + 1 < xs.length) {
      const l = Math.hypot(xs[seg + 1] - xs[seg], ys[seg + 1] - ys[seg]), f = (d - at) / l;
      x = xs[seg] + (xs[seg + 1] - xs[seg]) * f;
      y = ys[seg] + (ys[seg + 1] - ys[seg]) * f;
    } else {
      const last = xs.length - 1;
      let dx = last ? xs[last] - xs[last - 1] : end.dirX, dy = last ? ys[last] - ys[last - 1] : end.dirY;
      const l = Math.hypot(dx, dy);
      if (l > 1e-6) { dx /= l; dy /= l; } else { dx = end.dirX; dy = end.dirY; }
      x = xs[last] + dx * (d - at);
      y = ys[last] + dy * (d - at);
    }
    out[2 * i] = end.lon + x / m;
    out[2 * i + 1] = end.lat + y / 111132;
  });
  return out;
}

/* The line through an approach's ground (metres out `ds`, heights `hs`): its height at the portal and its rise a
 * metre out. Siegel's repeated median (each point's median slope to the others, the median of those; then the
 * median height left): half the points may be wrong (a pier, a wall, a spike in the terrain beside the road) where
 * Theil and Sen's median of all slopes gives way at under a third; the slope held to ±30 %. */
function approachLine(ds, hs) {
  const each = [];
  for (let i = 0; i < ds.length; i++) {
    const slopes = [];
    for (let j = 0; j < ds.length; j++) if (ds[j] !== ds[i]) slopes.push((hs[j] - hs[i]) / (ds[j] - ds[i]));
    if (slopes.length) each.push(median(slopes));
  }
  const slope = Math.max(-0.3, Math.min(0.3, each.length ? median(each) : 0));
  return { height: median(ds.map((d, i) => hs[i] - slope * d)), slope };
}

/* The median of numbers (sorts them). */
function median(v) {
  v.sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : 0.5 * (v[h - 1] + v[h]);
}

export { MATERIAL };
