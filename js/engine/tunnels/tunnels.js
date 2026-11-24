/* tunnels.js — the tunnels near the camera, on their own thread (5.19a:
 * workers/tunnels.js; up to 5.18b on the render thread): found, followed to
 * their portals, placed at the height of the ground there, kept under the
 * ground between, made into meshes and sent to the render thread (view.js:
 * drawn by passes/tunnels.js, the bodies touching their copies, placed.js),
 * and cut out of the terrain and of what is built along their whole bores
 * (cuts.js; terrain.wgsl and buildings.wgsl fsCut).
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
 * The jobs run on this same thread (core/local-scheduler.js: it has the C
 * core too), the nearest tube's first. The render thread sends the camera,
 * the detail road tiles' tunnel runs and the bridges' decks as they change,
 * and what its checks of the portals against the ground as drawn found
 * (portal-checks.js: applyChecks); everything here is sent to it through
 * `sink` (workers/tunnels.js).
 */

import { VIEW, hostOf } from '../../core/scheduler.js';
import { geodeticToEcef } from '../../core/math.js';
import { GroundPoints } from '../terrain/ground-points.js';
import { TUBE_END, TUBE_POINT, LINE_FLOATS, LINE_MOST } from './groups.js';
import { placeOn } from './trace.js';
import { sectionFor, tableEntry, floorProfile, clearanceFor, outlineAt, lookFor, LOOK, MATERIAL } from './sections.js';
import { meshPoints, spineOf, middleAt, boreWide, MESH_END, POINT_DOUBLES, HEAD_N, CUT_FOOT } from './mesh.js';
import { fitPoints, fitTube, SHORT, COLLAR_WIDTH } from './fit.js';
import { boreCut, addAprons, boreMeets } from './cuts.js';
import { placedCopy, wingOff, WING_SPLAY, WING_LEN } from './placed.js';

const GATHER_MS = 400;
/* A tube gone from the tiles round the camera (they moved: its open end with them) keeps being drawn until the
 * tube that takes its place has its mesh (or has no room: onItsWay), RETIRE_MS where none does (5.17w, his words on
 * 5.17v: "I entered, and then it closed the hole behind me!": inside the Ceneri tunnel its open end moved with the
 * road tiles round him, a new tube took its place, and the old one went after RETIRE_MS, or at once when any railway
 * tube near got its mesh, its box overlapping the old one's as a 6 km tube's box does them all, before the new one had
 * its own: the hillside closed over the portal). A tube takes (some of) another's place where a stretch of one lies on
 * the other's line (replaces: REPLACE_OFF metres, as a line moves a few metres where the tracks sharing its bore
 * change, the Ceneri base tunnel's portal by Giubiasco 8 m; the next tube lies 40 m off). */
const RETIRE_MS = 15000, REPLACE_OFF = 20;
/* Metres out of a portal along a tube the hint for its bore's spine lies (#spineHints, 5.18a). */
const HINT_IN = 600;
/* Metres from the open end the trace starts at (inside the tunnel's unknown part). */
const TRACE_IN = 10;
/* Metres a traced tunnel may pass an open end (or any point of the tube between its ends) and be the same one; and
 * its portal or junction ends (5.17w: a traced tunnel's ends are placed from coarser tiles). */
const MATCH = 30, END_MATCH = 60;
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
/* Metres out of a portal as mapped its approach's ground is drawn as the floor is (5.17r: cuts.js addAprons). */
const APRON_OUT = 20;
/* A portal's cutting (5.17u, tunnel.c `cutting`): looked for every CUT_STEP metres out of its collar to CUT_MOST,
 * running out to where the ground along its middle comes within CUT_ENDS of its floor (beyond, the way runs on the
 * ground; 5.17u's first cut ran on while the ground at either wall was over it, 80 m of walls along a road on a
 * hillside); its walls stand CUT_OUT past the collar's outer side, their tops CUT_OVER over the ground at their outer
 * faces, where the terrain meets them (between CUT_LEAST and CUT_TALL over the floor: a wall lower than the ground at
 * its face would leave the terrain's cut edge open over it), the headwall's over the ground CUT_BEHIND metres inside
 * its face. */
const CUT_STEP = 2, CUT_MOST = 20, CUT_ENDS = 0.4, CUT_OUT = 0.3, CUT_OVER = 0.15, CUT_LEAST = 0.5, CUT_TALL = 40, CUT_BEHIND = 0.5;
const CUT_WALL = 0.5, CUT_AGAIN_MS = 250;
/* Since 5.17v (his words on 5.17u: "now it looks too strange"): as the real portals by Giubiasco, short wing walls
 * splayed WING_SPLAY (tan 30°) off the way either side over their first WING_LEN metres (a whole number of CUT_STEPs;
 * tunnel.c WING_LEN), then along it, each one's top in straight runs through the ground's heights along it, never under
 * one and at most CUT_SLACK over one (topLine: it steps down where the ground does), out to CUT_MOST at most; only
 * railways' and road tunnels CUT_ROAD_LEAST long or more (no concrete at an underpass). */
const CUT_SLACK = 0.6, CUT_ROAD_LEAST = 150;
const CUT_THICK = CUT_WALL * Math.hypot(1, WING_SPLAY);   // a wing wall's thickness across the way
const GROUND_LEVEL = 17;
const LEAST_LEVEL = 12;
/* Terrain tiles kept indexed for the ground (those no list waits for go first, the least lately used), and lists
 * of points kept with their heights. */
const GROUND_TILES_MOST = 64;
/* A ground tile that failed to come: asked for again after GROUND_AGAIN_MS, three times longer each time, GROUND_TRIES
 * times in all before a coarser one stands in for it. */
const GROUND_TRIES = 5, GROUND_AGAIN_MS = 2000;
/* Where tubes cross (#crossings): metres of rock between the lower one's vault and concrete and the upper one's floor,
 * the steepest the lower one's floor dips at on average, metres from its portals the dip keeps clear of, and the
 * narrowest half-width a dip may be made there. */
const CROSS_ROCK = 2.5, CROSS_GRADE = 0.06, CROSS_CLEAR = 15, CROSS_LEAST = 10;
/* Where a tube opens into another (#joins, 5.17m: a JOIN end inside the other's bore, within JOIN_NEAR metres of its
 * walls): its floor eases to the other's there over JOIN_EASE metres (half its length at most), as a dip does. */
const JOIN_NEAR = 1, JOIN_EASE = 40;
/* Metres a near tube's JOIN end and its whole tunnel's may lie apart and be the same (5.17t: by Giubiasco 23 m), and
 * its portal and a whole tunnel's end that is not one (at Vezia 74 m). */
const JOIN_MATCH = 60, PORTAL_MATCH = 100;
/* Metres a tube's line may pass a JOIN end of another and lend it its table entry (#joinedEntry, 5.18g). */
const JOIN_ENTRY = 25;
const GROUNDS_MOST = 256;
/* The Web Mercator zoom a mesh's positions on the map are in (the pass scales them to the photos'). */
const MESH_ZOOM = 20;
/* Metres a railway tube's ballast bed stands over its floor with the open track in 3D: the open bed's (track.c
 * BED_TOP), whose ground is pinned to the floor at the portal (5.18c). */
const TRACK_BED = 0.30;
/* Metres round a portal the terrain's tiles are drawn from both sides at least (5.17b's reach). */
const PORTAL_REACH = 60;
/* Metres of open approach between a portal and its tube's collar from which on it is drawn as the tube's floor
 * (cuts.js addAprons). */
const APRON_LEAST = 0.5;


/* A portal's run ends looked for in cells of this many degrees (#approachOf: the runs' approach ends indexed). */
const APPROACH_CELL = 1e-4;

export class TunnelSet {
  /**
   * @param scheduler  where its jobs run (core/local-scheduler.js; core/scheduler.js has the same client interface)
   * @param terrain    { sourceList }: the terrain services (terrain/source.js), for the ground round the portals
   * @param vector     the road tiles as far as the tunnels go: { source: { templates, schema }, kinds, tiles (key →
   *                   { level, tunnels }), tunnelVersion, decks (features/decks.js) }
   * @param sink       where what is placed goes (workers/tunnels.js): mesh(mesh, data, copy) → a promise kept once it
   *                   is drawn, unused(mesh) (one made but not wanted any more), lists(lists) (after every change)
   */
  constructor({ scheduler, terrain, vector, sink }) {
    this.terrain = terrain;
    this.vector = vector;
    this.sink = sink;
    this.client = scheduler.client('tunnels', { weight: 1, pick: (cls) => this.#pick(cls) });
    this.enabled = true;
    this.trackBed = TRACK_BED;     // metres a railway tube's bed stands over its floor (setTrack)
    this.records = new Map();      // tube key → record
    this.retiring = [];            // records gone, drawn until the tubes taking their place are (r.successors)
    this.wholes = [];              // whole tunnels traced this session
    this.traces = new Map();       // trace key → 'pending' | 'failed'
    this.meshes = [];              // what the pass draws
    this.portals = [];             // where the terrain is opened
    this.cuts = [];                // the bores cut out of what is built (cuts.js), and a number that changes with them
    this.cutVersion = 0;
    this.meets = [];               // per cut, the other bores reaching into it (cuts.js boreMeets: tubes running into each other)
    this.floorSig = '';            // the portal floors last told to the road tiles
    this.starts = new Map();       // portal key → metres in its tube starts at most, from the ground as cut (trimStarts)
    this.lifts = new Map();        // portal key → metres its floor follows the road in front as drawn (alignPortals)
    this.liftTries = new Map();    // portal key → how often it has
    this.seenVersion = -1;
    this.changedAt = 0;
    this.tubesBusy = false;
    this.tubesWanted = false;
    this.gpuBytes = 0;             // what the meshes take on the GPU (the render thread's)
    this.meshIds = 0;
    this.stats = { tubes: 0, meshes: 0, skipped: 0, traced: 0, traceTiles: 0, traceBytes: 0, grounds: 0, groundTiles: 0, failed: 0, meshMs: 0 };
    // The ground round the portals and along the tubes (#groundFor), shared with the railways' profiles (5.18d).
    this.ground = new GroundPoints(terrain.sourceList, { most: GROUND_LEVEL, least: LEAST_LEVEL, tilesMost: GROUND_TILES_MOST,
      listsMost: GROUNDS_MOST, tries: GROUND_TRIES, againMs: GROUND_AGAIN_MS, stats: this.stats, label: 'tunnels' });
    this.eye = { lon: 0, lat: 0 };   // the camera, for the order of the jobs (#pick)
    this.approaches = null;        // the runs' approach ends by cell (#approachOf), for one tunnelVersion
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) { this.client.cancelAll(); this.#clear(); this.seenVersion = -1; }
  }

  /** What can start now (the console's swissgpu.settled waits for none of it, 5.18e; the jobs out the scheduler
   *  counts): the tubes to find, and per tube not settled its mesh, its trace or a ground tile it waits for (one to be
   *  tried again later is not). Into `why` by kind. */
  pending(now = performance.now(), why = { tubes: 0, mesh: 0, trace: 0, ground: 0 }) {
    why.tubes = this.tubesWanted || this.tubesBusy ? 1 : 0;
    why.mesh = why.trace = why.ground = 0;
    for (const r of this.records.values()) {
      if (r.settled) continue;
      if (r.meshWanted && !(r.meshAgainAt > now)) why.mesh++;
      else if (r.traceWanted) why.trace++;
      else if (r.grounds?.some((g) => g.state === 'tiles' && g.tiles.some((t) => t.state === 'wanted'))) why.ground++;
    }
    return why.tubes + why.mesh + why.trace + why.ground;
  }

  /** Whether the open track is built in 3D (the setting): a railway tube's bed then stands as high as its (5.18c),
   *  else lies on the floor; each tube is made again (its signature holds the bed's height). */
  setTrack(on) {
    this.trackBed = on ? TRACK_BED : 0;
  }

  /** Once a frame: notices new tunnels and keeps every tube's state moving. */
  update(camera, now = performance.now()) {
    if (!this.enabled || !this.vector.source) return;
    if (this.vector.tunnelVersion !== this.seenVersion) {
      this.seenVersion = this.vector.tunnelVersion;
      this.changedAt = now;
      this.tubesWanted = true;
    }
    this.eye.lon = camera.lon; this.eye.lat = camera.lat;
    const decks = this.vector.decks;
    if (decks && decks.epoch !== this.deckEpoch) { this.deckEpoch = decks.epoch; this.#decksCame(); }
    for (const r of this.records.values()) { this.asking = r; this.#advance(r); }
    this.asking = null;
    if (this.retiring.length && this.retiring.some((r) => r.retireBy < now)) {
      this.retiring = this.retiring.filter((r) => {
        if (r.retireBy >= now) return true;
        if ((r.successors ?? []).some(onItsWay)) {
          if (!r.keptLonger) { r.keptLonger = true; this.stats.keptLonger = (this.stats.keptLonger ?? 0) + 1; }
          return true;
        }
        this.#drop(r);
        return false;
      });
    }
  }

  /**
   * What the render thread's checks of the portals against the ground as drawn found (portal-checks.js): a portal's
   * floor to follow the road in front of it as drawn ({ lift, tries }), or its tube to start nearer it ({ start }).
   * Each is taken only where its tube is still placed as the copy checked was (its signature; a lift's tries: the
   * same finding again from that copy is not taken twice), and places the tube again (a refit, a new mesh).
   */
  applyChecks(corrections) {
    for (const c of corrections) {
      const r = this.records.get(c.key);
      if (!r || r.sig !== c.sig || !r.mesh || r.meshBusy || r.meshWanted || r.skipped) continue;
      if (c.lift !== undefined) {
        if ((this.liftTries.get(c.portal) ?? 0) !== c.tries) continue;
        this.lifts.set(c.portal, c.lift);
        this.liftTries.set(c.portal, c.tries + 1);
      } else {
        const was = this.starts.get(c.portal);
        if (was !== undefined && was <= c.start + 0.01) continue;
        this.starts.set(c.portal, c.start);
      }
      r.settled = false;
    }
  }

  /** Metres in a portal's tube starts at most from the ground as cut (portal-checks.js trim), or null, for the probe. */
  trimAt(end, family) {
    return this.starts.get(portalKey(end, family)) ?? null;
  }

  /** How a portal's floor was found (#portalFloor: the ground right in front, the approach's line, the height and the
   *  rise taken; the approach's points' ground; the finest level of the tiles it was taken from), for the probe. */
  portalGround(end, family) {
    const g = this.ground.lists.get(`a|${family}|${end.lon.toFixed(5)}|${end.lat.toFixed(5)}`);
    if (!g || g.state !== 'done') return null;
    const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
    // (Whether its way goes on as a bridge, its deck's height over the approach's points and whether it was not in
    // yet when the floor was found: 5.17x.)
    const decks = this.vector.decks, out = this.#approachOf(end);
    return { near: r2(g.near), line: r2(g.line), height: r2(g.height), slope: r2(g.slope),
      bridge: out ? out.bridge === true : null, decksOn: decks ? decks.active : null, deckless: g.deckless ?? null,
      decks: decks ? [...NEAR, ...APPROACH].map((d, i) => r2(decks.heightAt(g.lonlat[2 * i], g.lonlat[2 * i + 1]))) : null,
      levels: [...new Set(g.pointTiles.map((t) => t?.z ?? null))],
      along: [...NEAR, ...APPROACH].map((d, i) => [d, r2(g.heights[i]), +g.lonlat[2 * i].toFixed(6), +g.lonlat[2 * i + 1].toFixed(6)]) };
  }

  /** Metres a portal's floor has followed the road in front of it (portal-checks.js align), for the probe. */
  liftAt(end, family) {
    return this.lifts.get(portalKey(end, family)) ?? 0;
  }

  /* ---- the decode threads' turn ------------------------------------------- */

  /*
   * The next job, the nearest tube's first (5.17t: the roads' detail zoom, and the tunnels with it, now loads 5 km
   * round; 5.17s took every ground tile wanted before any mesh, in the order asked, so the tube beside the camera
   * waited for the ground along tunnels kilometres off): tubes by their distance from the camera, each its mesh, its
   * trace or the ground it waits for (all of a long tube's, however far: its fit needs the whole); then any other
   * ground tile wanted.
   */
  #pick(cls) {
    if (!this.enabled || cls !== VIEW) return false;
    if (this.tubesWanted && !this.tubesBusy && performance.now() - this.changedAt >= GATHER_MS) { this.#runTubes(); return true; }
    const now = performance.now(), m = 111320 * Math.cos((this.eye.lat * Math.PI) / 180);
    const order = this.pickOrder ??= [];
    order.length = 0;
    for (const r of this.records.values()) {
      if ((r.meshWanted && !(r.meshAgainAt > now)) || r.traceWanted || r.grounds?.length) order.push(r);
    }
    for (const r of order) r.pickD = this.#distance(r, m);
    order.sort((a, b) => a.pickD - b.pickD);
    const ground = this.ground;
    for (const r of order) {
      if (r.meshWanted && !(r.meshAgainAt > now)) { this.#runMesh(r); return true; }
      if (r.traceWanted && this.client.canRun(r.traceHost)) { this.#runTrace(r); return true; }
      for (const g of r.grounds ?? []) {
        if (g.state !== 'tiles') continue;
        for (const t of g.tiles) if (ground.ready(t, this.client, now)) { ground.run(t, this.client); return true; }
      }
    }
    return ground.runAny(this.client, now);
  }

  /* Metres from the camera to the nearest of a record's tube's box (0 inside it). */
  #distance(r, m) {
    const b = r.lineBox ??= lineBox(r.tube.points), eye = this.eye;
    const dx = Math.max(b[0] - eye.lon, 0, eye.lon - b[2]) * m, dy = Math.max(b[1] - eye.lat, 0, eye.lat - b[3]) * 111132;
    return Math.hypot(dx, dy);
  }

  async #runTubes() {
    this.tubesWanted = false;
    this.tubesBusy = true;
    const runs = [];
    for (const t of this.vector.tiles.values()) if (t.level === 0 && t.tunnels) runs.push(...t.tunnels);
    const priority = {};
    for (const k of this.vector.kinds ?? []) if (k) priority[k.id] = k.priority;
    const hints = this.#spineHints();
    try {
      const { tubes } = runs.length ? await this.client.run('tunnel-tubes', { runs, priority, hints }, { cls: VIEW, cost: 1 }) : { tubes: [] };
      this.#reconcile(tubes);
    } catch (err) {
      if (err.name !== 'AbortError') { console.warn(`[tunnels] tubes: ${err.message}`); this.tubesWanted = true; this.changedAt = performance.now(); }
    } finally {
      this.tubesBusy = false;
    }
  }

  /* Where the bores' spines are to run (groups.js hints, 5.18a): from each portal of a whole tunnel traced, the point
   * HINT_IN along it (rank 2: the line it goes on along); from each portal of a tube as it is, the same (rank 1: the
   * line its bore took before). At most 60% along a shorter one; beyond where a branch leaves the line it shares a
   * bore with out of the portal (~230 m by Giubiasco) and before the lines are far apart. */
  #spineHints() {
    const hints = [];
    const add = (t, rank) => {
      for (let e = 0; e < 2; e++) {
        if (t.ends[e].type !== TUBE_END.PORTAL) continue;
        const p = pointAlong(t, e, Math.min(HINT_IN, 0.6 * t.length));
        if (p) hints.push({ lon: p[0], lat: p[1], rank });
      }
    };
    for (const w of this.wholes) add(w, 2);
    for (const r of this.records.values()) add(r.tube, 1);
    return hints;
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
    // (Which new tubes take each one's place, those gone before too: a tube may move on again before it has a mesh.)
    for (const r of this.retiring) r.successors = [...next.values()].filter((q) => replaces(q, r));
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
    // (The ground it waits for, gathered afresh by #groundFor: #pick fetches the nearest tube's first.)
    if (r.grounds) r.grounds.length = 0; else r.grounds = [];
    const near = r.tube;
    // 1. The whole tunnel, if this is only part of it.
    const open = near.ends.filter((e) => e.type === TUBE_END.OPEN);
    if (open.length && !r.whole) {
      const found = this.#wholeFor(near);
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
    // Its entry in the table of the longest tunnels (sections.js): by its portals or its whole's length, else that of a
    // tube it opens into (5.18g: the Ceneri base tunnel's crossover and west tube have no portal of their own, and were
    // drawn as old masonry with ballast while the tubes they open into were concrete); its section made again with it.
    if (!r.entry) {
      const entry = tableEntry(whole) ?? (whole !== near ? tableEntry(near) : null) ?? this.#joinedEntry(r);
      if (entry) { r.entry = entry; r.rule = null; }
    }
    // A short whole tunnel must fit under the ground (one whose far end was not found is not known to be short).
    const short = Boolean(r.whole) && whole.length <= SHORT;
    const heights = [NaN, NaN];
    let waiting = false;
    const byPortal = [false, false];
    for (let e = 0; e < 2; e++) {
      const end = whole.ends[e];
      // The near tube's own portal is the better placed (z14), where it is this end: the nearest within 60 m (a short
      // tube's other portal may be as near); and where the whole tunnel's end is not a portal but the near tube comes
      // out within PORTAL_MATCH of it, that portal (5.17t: the Ceneri base tunnel's west tube was traced to where its
      // line meets the east one's 74 m inside the Vezia portal, and was never placed).
      let mine = whole === near ? (end.type === TUBE_END.PORTAL ? near.ends[e] : null) : (end.type === TUBE_END.PORTAL ? end : null);
      if (whole !== near) {
        let nearest = end.type === TUBE_END.PORTAL ? 60 : PORTAL_MATCH;
        for (const n of near.ends) if (n.type === TUBE_END.PORTAL && distance(n, end) < nearest) { nearest = distance(n, end); mine = n; }
      }
      if (!mine) continue;
      const g = this.#portalFloor(mine, near.family);
      byPortal[e] = g.state !== 'failed';
      // (And how far the road in front as drawn has moved it: alignPortals.)
      if (g.state === 'done') heights[e] = g.height + (this.lifts.get(portalKey(mine, near.family)) ?? 0);
      else if (g.state !== 'failed') waiting = true;
    }
    // An end opening into another tube (5.17m): that one's floor there, once it has one (#joinedFloor), so the floor
    // runs from its portal to where it meets the other's (from one portal only it was level at that portal's height:
    // by Giubiasco a branch 6 m over the floor it opens into). The whole tunnel's ends too (5.17t: the Ceneri base
    // tunnel's west tube parts from the east one 714 m in and was traced 14.4 km to a junction at Vezia, no portal at
    // either end: 5.17s took JOIN ends only of a tube that was all of its tunnel, so it was never placed, and the
    // west line ran on in the east tube's room to the end of it).
    for (let e = 0; e < 2; e++) {
      const we = whole.ends[e];
      if (we.type !== TUBE_END.JOIN || byPortal[e]) continue;
      // (The near tube's own JOIN end there first: groups.js runs it JOIN_INTO back into the bore it opens into,
      // where the traced tunnel's end, where its line meets the other's, may lie past that bore's reach.)
      let h = null;
      for (const ne of near.ends) if (h === null && ne.type === TUBE_END.JOIN && distance(ne, we) < JOIN_MATCH) h = this.#joinedFloor(r, ne);
      if (h === null) h = this.#joinedFloor(r, we);
      if (h !== null) heights[e] = h;
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
    const sig = `${heights[0].toFixed(2)}|${heights[1].toFixed(2)}|${r.entry?.name ?? ''}|${starts.map((v) => v?.toFixed(2) ?? '').join(',')}|${this.trackBed}`;
    if (sig === r.sig || r.meshBusy) return;
    r.sig = sig;
    const at = r.wholeAt ?? { s0: 0, sign: 1 };
    r.baseAt = (s) => floor(at.s0 + at.sign * s);
    // 4. Fitted to the ground: its section where it is shallow, its portals' faces, its floor kept under the ground;
    // or no room for it at all.
    const known = fg.state === 'done' ? fg.heights : null;
    r.fit = fitTube({
      tube: near, floorAt: r.baseAt, section: r.rule, clearance: clearanceFor(near, r.kind), kind: r.kind, short, slopes,
      pts: fg.pts, heights: known, starts, spine: known ? spineOf(near, r.rule.half) : null,
    });
    r.floorAt = r.fit.floorAt ?? r.baseAt;
    if (!r.fit.section) {
      // No room for it, or no ground over it anywhere (5.17h: 5.17f dug a cutting the whole way, through the bank a
      // low underpass passes under): the terrain stays whole there (its line is not drawn yet: a later step).
      r.skipped = true;
      r.settled = true;
      if (r.mesh) { this.#freeMesh(r.mesh); r.mesh = null; }
      this.#lists();
      return;
    }
    r.skipped = false;
    r.section = r.fit.section;
    r.meshWanted = true;
    // Under or over the tubes it crosses (#crossings: the lower one dips under the other); its floor meeting the floor
    // of a tube it opens into, and those opening into it meeting its (#joins).
    r.fitFloor = r.floorAt;
    r.floorAt = this.#withDips(r);
    this.#crossings(r);
    this.#joins(r);
  }

  /* ---- where a tube opens into another (5.17m) --------------------------------------------------------------------
   * A branch's floor runs from its own portal and is only kept under the ground (fit.js), the floor of the tube it
   * opens into from that one's: where they meet the two may lie a metre apart, a step across the way into the branch.
   * A JOIN end inside another's bore takes that one's floor there (its fitted floor, so two opening into each other do
   * not chase each other), eased in over JOIN_EASE (`r.joins`, by end: the other's key and the floor). Asked again
   * for those opening into this one now that it has a floor. */
  #joins(r) {
    for (const q of this.records.values()) {
      // (A JOIN end meets a bore of its own family: groups.js makes them per family.)
      if (q === r || q.dropped || q.tube.family !== r.tube.family) continue;
      // One not placed for want of a floor whose (whole tunnel's) JOIN end lies in this bore is placed again now
      // (5.17t: the Ceneri base tunnel's west tube was looked at before the east one had a floor, and never again).
      if (q.unplaced && q.settled) {
        const ends = [...q.tube.ends, ...(q.whole && q.whole !== q.tube ? q.whole.ends : [])];
        if (ends.some((e) => e.type === TUBE_END.JOIN && this.#inBoreOf(r, e.lon, e.lat))) q.settled = false;
        continue;
      }
      if (q.skipped || !q.section || !q.fitFloor) continue;
      this.#joinTo(r, q);
      this.#joinTo(q, r);
    }
  }

  /* The table entry of a tube one of record r's JOIN ends opens into (5.18g), or null: the first with one whose line
   * passes within JOIN_ENTRY metres of that end. */
  #joinedEntry(r) {
    for (const end of r.tube.ends) {
      if (end.type !== TUBE_END.JOIN) continue;
      const mLon = 111320 * Math.cos((end.lat * Math.PI) / 180);
      for (const q of this.records.values()) {
        if (q === r || !q.entry || q.tube.family !== r.tube.family) continue;
        const p = q.tube.points;
        for (let k = 0; k < p.length; k += TUBE_POINT) {
          if (Math.hypot((p[k] - end.lon) * mLon, (p[k + 1] - end.lat) * 111132) <= JOIN_ENTRY) return q.entry;
        }
      }
    }
    return null;
  }

  /* The floor of the tube a JOIN end of record r opens into, there (its fitted floor), or null: none placed, or the
   * one it lies in takes its own floor from r (two opening into each other: the first placed keeps its own). The
   * tubes it takes floors from are kept (`r.joinFrom`, by key). */
  #joinedFloor(r, end) {
    for (const q of this.records.values()) {
      if (q === r || q.dropped || q.skipped || !q.section || !q.fitFloor || q.joinFrom?.has(r.tube.key) || q.tube.family !== r.tube.family) continue;
      const at = this.#inBoreOf(q, end.lon, end.lat);
      if (!at) continue;
      (r.joinFrom ??= new Set()).add(q.tube.key);
      return q.fitFloor(at.s);
    }
    r.joinFrom?.clear();
    return null;
  }

  /** For the probe (5.17t): where a JOIN end of record r lies against the placed tube nearest it: that one's key,
   *  metres along it, how far from its bore's middle and how far its walls reach there (section, bore, JOIN_NEAR). */
  joinSeen(r, e) {
    const end = r.tube.ends[e];
    let best = null;
    for (const q of this.records.values()) {
      if (q === r || q.dropped || !q.section || q.tube.family !== r.tube.family) continue;
      const box = lineBox(q.tube.points), mm = 30 / 111132;
      if (end.lon < box[0] - 2 * mm || end.lon > box[2] + 2 * mm || end.lat < box[1] - mm || end.lat > box[3] + mm) continue;
      const at = placeOn(q.tube, end.lon, end.lat);
      const off = Math.abs(at.across - at.middle), reach = q.section.half + at.extra + JOIN_NEAR;
      if (!best || off - reach < best.off - best.reach) {
        best = { key: q.tube.key, s: Math.round(at.s), off: Math.round(off * 10) / 10, reach: Math.round(reach * 10) / 10,
          skipped: Boolean(q.skipped), floored: Boolean(q.fitFloor) };
      }
    }
    return best;
  }

  /* Where a point lies along record q's tube if it is inside its bore (within JOIN_NEAR of its walls), else null. */
  #inBoreOf(q, lon, lat) {
    const box = lineBox(q.tube.points), m = 30 / 111132;
    if (lon < box[0] - 2 * m || lon > box[2] + 2 * m || lat < box[1] - m || lat > box[3] + m) return null;
    const at = placeOn(q.tube, lon, lat);
    const inside = Math.abs(at.across - at.middle) <= q.section.half + at.extra + JOIN_NEAR && at.s >= 0 && at.s <= q.tube.length;
    return inside ? at : null;
  }

  /* Whether a JOIN end of record a lies in record b's bore, and if so a's floor there meets b's. */
  #joinTo(a, b) {
    const t = a.tube;
    for (let e = 0; e < 2; e++) {
      const end = t.ends[e];
      if (end.type !== TUBE_END.JOIN) continue;
      const at = this.#inBoreOf(b, end.lon, end.lat), inside = at !== null;
      const was = a.joins?.get(e);
      if (!inside) { if (was?.key === b.tube.key) this.#setJoin(a, e, null); continue; }
      // Placed before b had a floor: its floor is fitted again from b's there (#advance, #joinedFloor), once.
      if (!a.joinFrom?.has(b.tube.key) && !b.joinFrom?.has(a.tube.key) && !(a.joinAsked ??= new Set()).has(b.tube.key)) {
        a.joinAsked.add(b.tube.key);
        a.settled = false;
      }
      // (One it already meets keeps it: an end inside two bores at once takes the first.)
      if (was && was.key !== b.tube.key) continue;
      const floor = b.fitFloor(at.s);
      if (was && Math.abs(was.floor - floor) < 0.02) continue;
      this.#setJoin(a, e, { key: b.tube.key, floor });
    }
  }

  #setJoin(r, e, join) {
    r.joins ??= new Map();
    if (join) r.joins.set(e, join);
    else r.joins.delete(e);
    if (!r.fitFloor) return;
    r.floorAt = this.#withDips(r);
    if (r.section && !r.skipped) r.meshWanted = true;
  }

  /* ---- where two tubes cross (5.17j, his words on 5.17i: "they cross into each other") ---------------------------
   * Each floor runs straight between its portals and is only kept under the ground (fit.js), so two tunnels that
   * cross (a road tunnel over a railway's, as by Locarno) may meet. Where their lines cross, the one mapped on the
   * lower layer (else the one whose floor is lower there) dips under the other: its vault, its concrete and CROSS_ROCK
   * of rock below the upper one's floor, on a smooth dip no steeper than CROSS_GRADE on average (and kept clear of its
   * portals by CROSS_CLEAR). A record's dips are kept by the other's key (`r.dips`); the lower one's mesh is built
   * again. */

  #crossings(r) {
    const a = r.tube, boxA = lineBox(a.points);
    for (const q of this.records.values()) {
      if (q === r || q.dropped || q.skipped || !q.section || !q.fitFloor) continue;
      const b = q.tube, boxB = lineBox(b.points);
      if (boxA[0] > boxB[2] || boxB[0] > boxA[2] || boxA[1] > boxB[3] || boxB[1] > boxA[3]) continue;
      const x = crossingOf(a.points, b.points);
      if (!x) continue;
      const fa = r.fitFloor(x.sa), fb = q.fitFloor(x.sb);
      const layered = a.layer !== b.layer && Number.isFinite(a.layer) && Number.isFinite(b.layer);
      const aLower = layered ? a.layer < b.layer : fa <= fb;
      const [low, high, sLow, fLow, fHigh] = aLower ? [r, q, x.sa, fa, fb] : [q, r, x.sb, fb, fa];
      const need = outlineAt(low.section).crown + (low.fit.collarWidth ?? 0) + CROSS_ROCK;
      const depth = need - (fHigh - fLow);
      this.#setDip(low, high.tube.key, depth > 0.05 ? { s: sLow, depth } : null);
      this.#setDip(high, low.tube.key, null);
    }
  }

  #setDip(r, key, dip) {
    r.dips ??= new Map();
    const was = r.dips.get(key);
    if (!dip && !was) return;
    if (dip && was && Math.abs(dip.s - was.s) < 0.5 && Math.abs(dip.depth - was.depth) < 0.05) return;
    if (dip) r.dips.set(key, dip);
    else r.dips.delete(key);
    if (!r.fitFloor) return;
    r.floorAt = this.#withDips(r);
    // Its mesh built again with it (and the portals' and cuts' lists with that).
    if (r.section && !r.skipped) r.meshWanted = true;
  }

  /* A record's floor with its dips under the tubes it crosses (#crossings): each a smooth (cosine) dip `depth` deep
   * at `s`, as wide as CROSS_GRADE allows, narrower near a portal (its floor there stays the road's). */
  #withDips(r) {
    const base = withJoins(r), dips = r.dips ? [...r.dips.values()] : [];
    if (!dips.length) return base;
    const L = r.tube.length, ends = r.tube.ends;
    const lo = ends[0].type === TUBE_END.PORTAL ? CROSS_CLEAR : -Infinity, hi = ends[1].type === TUBE_END.PORTAL ? L - CROSS_CLEAR : Infinity;
    const shaped = dips.map(({ s, depth }) => {
      const room = Math.max(CROSS_LEAST, Math.min(s - lo, hi - s));
      return { s, depth, w: Math.min((2 * depth) / CROSS_GRADE, room) };
    });
    return (s) => {
      let under = 0;
      for (const d of shaped) {
        const t = Math.abs(s - d.s) / d.w;
        if (t < 1) under = Math.max(under, d.depth * 0.5 * (1 + Math.cos(Math.PI * t)));
      }
      return base(s) - under;
    };
  }

  /* A traced whole tunnel this session that passes the near tube's open ends. */
  #wholeFor(near) {
    let best = null, least = Infinity;
    for (const w of this.wholes) {
      if (w.family !== near.family) continue;
      const off = offWhole(near, w);
      if (off < least) { least = off; best = w; }
    }
    return best;
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
        // Only a traced tunnel that is this one: all of it on it (offWhole).
        if (Number.isFinite(offWhole(near, got.tube))) this.#adoptWhole(r, got.tube);
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
    const out = this.#approachOf(end), approach = out?.approach ?? null;
    const g = this.#groundFor(key, () => ({ lonlat: alongApproach(end, approach, ALL) }));
    if (g.state === 'done' && g.height === undefined) {
      const nd = [], nh = [], ds = [], hs = [], rd = [], rh = [];
      // A deck over the approach is its own only where the way goes on as a bridge (5.17s: by Giubiasco a road
      // crossing over the 443 m tube's approach right at its portal stood its floor on the road's deck, 8 m over the
      // tracks going on).
      const ownDeck = out?.bridge === true;
      let decked = 0;
      ALL.forEach((d, i) => {
        const deck = ownDeck ? this.vector.decks?.heightAt(g.lonlat[2 * i], g.lonlat[2 * i + 1]) ?? NaN : NaN;
        if (Number.isFinite(deck)) decked++;
        const h = Number.isFinite(deck) ? deck : g.heights[i];
        if (!Number.isFinite(h)) return;
        if (d < APPROACH[0]) { nd.push(d); nh.push(h); } else { ds.push(d); hs.push(h); }
        if (d <= RISE_REACH) { rd.push(d); rh.push(h); }
      });
      // (A railway's approach climbs 5% at the most, a road's 15%: 5.17r.)
      const steepest = family === 'rail' || family === 2 ? 0.05 : 0.15;
      const line = ds.length >= 3 ? approachLine(ds, hs, steepest) : { height: ds.length ? hs[0] : NaN, slope: 0 };
      const rise = rd.length >= 3 ? approachLine(rd, rh, steepest).slope : line.slope;
      const front = nd.length >= 3 ? median(nd.map((d, i) => nh[i] - rise * d)) : NaN;
      const onFace = Number.isFinite(line.height) && front > line.height + NEAR_OVER;
      g.height = Number.isFinite(front) && !onFace ? front : line.height;
      g.slope = onFace ? line.slope : rise;
      g.near = front;
      g.line = line.height;
      // Its own deck not in yet (5.17x, his words on 5.17w: "do you not see that the right tunnel
      // is under the rails?": by Giubiasco the Ceneri base tunnel's single-track portal runs straight onto its viaduct,
      // whose deck came after the floor was found on the ground under it, 7 m lower): from the ground for now, and
      // again once decks come (#decksCame).
      g.deckless = ownDeck && decked === 0 ? (this.vector.decks?.epoch ?? -1) : undefined;
      g.bridge = ownDeck;
      if (!Number.isFinite(g.height)) g.state = 'failed';
    }
    return g;
  }

  /* Decks came (or went): each portal floor found on the ground where its way goes on as a bridge whose deck was not
   * in yet is found again, and the tubes with that portal are looked at again (5.17x). */
  #decksCame() {
    const again = new Set();
    for (const g of this.ground.lists.values()) {
      if (g.deckless === undefined || g.deckless === this.deckEpoch || g.state !== 'done') continue;
      g.height = undefined;
      g.deckless = undefined;
      again.add(g.key);
    }
    if (!again.size) return;
    for (const r of this.records.values()) {
      const ends = r.whole && r.whole !== r.tube ? [...r.tube.ends, ...r.whole.ends] : r.tube.ends;
      if (ends.some((e) => e.type === TUBE_END.PORTAL && again.has(`a|${r.tube.family}|${e.lon.toFixed(5)}|${e.lat.toFixed(5)}`))) r.settled = false;
    }
  }

  /* The run's end at a portal whose open line goes on beyond it (runs.js: its `approach`, and `bridge`, whether that
   * goes on as a bridge), or null: the nearest within APPROACH_MATCH, from the runs' ends indexed by cell (5.19a: up
   * to 5.18b every run of every tile was looked at for every portal, each frame a tube waited). */
  #approachOf(end) {
    const cells = this.#approachIndex(), m = 111320 * Math.cos((end.lat * Math.PI) / 180);
    const cx = Math.floor(end.lon / APPROACH_CELL), cy = Math.floor(end.lat / APPROACH_CELL);
    let best = null, bestGap = APPROACH_MATCH;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get((cx + dx) * 2e6 + cy + dy);
        if (!list) continue;
        for (const a of list) {
          const gap = Math.hypot((a.lon - end.lon) * m, (a.lat - end.lat) * 111132);
          if (gap < bestGap) { bestGap = gap; best = a.end; }
        }
      }
    }
    return best;
  }

  /* The detail tiles' runs' ends with an approach, by cell (APPROACH_CELL degrees): made again when the tiles with
   * tunnels change. */
  #approachIndex() {
    const version = this.vector.tunnelVersion;
    if (this.approaches?.version === version) return this.approaches.cells;
    const cells = new Map();
    for (const t of this.vector.tiles.values()) {
      if (t.level !== 0 || !t.tunnels) continue;
      for (const run of t.tunnels) {
        for (let e = 0; e < 2; e++) {
          if (!run.ends[e].approach) continue;
          const k = e ? run.points.length - 2 : 0, lon = run.points[k], lat = run.points[k + 1];
          const key = Math.floor(lon / APPROACH_CELL) * 2e6 + Math.floor(lat / APPROACH_CELL);
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push({ lon, lat, end: run.ends[e] });
        }
      }
    }
    this.approaches = { version, cells };
    return cells;
  }

  /* A list of points whose ground is wanted (GroundPoints.list), kept with the record asking for it, so #pick fetches
   * the nearest tube's first. */
  #groundFor(key, make) {
    const g = this.ground.list(key, make);
    if (g.state === 'tiles' && this.asking && !this.asking.grounds.includes(g)) this.asking.grounds.push(g);
    return g;
  }

  /*
   * Each portal's cutting (5.17t; tunnel.c `cutting` builds it from the mesh's end, this its frame the same way):
   * [end 0, end 1], each null (none: the ground out of the collar is not over its floor) or cuttingFrom's; null while
   * the ground there is on its way (its tiles go with the tube's: #pick).
   */
  #cuttings(r, mp, sec, cw) {
    const near = r.tube, f = r.fit.ends, out = [null, null];
    let waiting = false;
    for (let e = 0; e < 2; e++) {
      const fe = f[e];
      if (near.ends[e].type !== TUBE_END.PORTAL || !fe || mp.count < 2) continue;
      if (near.family !== 2 && !(near.length >= CUT_ROAD_LEAST)) continue;
      const g = cuttingFrame(mp, e, fe.collar ?? 0, fe.rise ?? 0);
      const half = outlineAt(sec, g.wide).half + cw + CUT_OUT;
      const key = `k|${portalKey(near.ends[e], near.family)}|${g.lon.toFixed(6)},${g.lat.toFixed(6)},${half.toFixed(1)}`;
      const gr = this.#groundFor(key, () => ({ lonlat: cuttingPoints(g, half) }));
      if (gr.state === 'tiles') {
        waiting = true;
        if (!(r.grounds ??= []).includes(gr)) r.grounds.push(gr);
        continue;
      }
      if (gr.state === 'done' && gr.heights) out[e] = cuttingFrom(g, half, gr.heights);
    }
    return waiting ? null : out;
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
      const mp = meshPoints(near, r.floorAt, sec.half, zoom, from, to, sec.low?.half ?? 0);
      const o = mp.origin, origin = geodeticToEcef(o.lon, o.lat, o.h);
      const ends = near.ends.map(meshEnd);
      // No wing walls (5.17d): the road's own cut holds the slope beside the approach (shape.c, pinned at the portal).
      // How it looks inside by what it is for (5.17n, sections.js lookFor): its lamps, walls and fittings.
      const look = lookFor(near, r.kind, sec, r.entry, (r.whole ?? near).length);
      const spec = { origin: [origin[0], origin[1], origin[2]], ends, spring: sec.spring, ringStep: 25, collar: r.fit.collarWidth ?? COLLAR_WIDTH,
        ceiling: sec.ceiling ?? 0, collarDepth: [f[0]?.collar ?? 0, f[1]?.collar ?? 0], shell: [f[0]?.shell ?? 0, f[1]?.shell ?? 0], wingTop: [0, 0],
        rise: [f[0]?.rise ?? 0, f[1]?.rise ?? 0], overhead: look.overhead, fanStep: look.fanStep, gauge: look.gauge ?? 0 };
      // Luminaires' housings where the lamps hang in the vault or under the ceiling, a handrail along a railway's
      // walkways (5.17p, his words on 5.17o: "more detailed tunnels").
      const lampPlace = lampAt(sec, look.lamps.place);
      if (look.lamps.place === 'vault') Object.assign(spec, { lampStep: look.lamps.step, lampA: lampPlace[0], lampH: lampPlace[1], lampSize: look.lamps.size });
      if (look.look === LOOK.RAIL && sec.kerb > 0 && sec.walkway > 0) spec.handrail = sec.kerb + 1.0;
      // A railway's tracks stay a sleeper's half and more in from its kerbs (5.17q: tunnel.c TRACK_EDGE), and its
      // walkways give way where the bore is stretched for a line beside it (tunnel.c walkway_at; sections.js
      // outlineAt gives the cut the same).
      if (look.look === LOOK.RAIL) Object.assign(spec, { floorHalf: sec.low.inner ?? sec.low.half, half: sec.low.half, kerb: sec.walkway > 0 ? sec.kerb : 0 });
      // Its tracks on a ballast bed as high as the open track's, so that runs straight in (5.18c: tunnel.c bedTop).
      if (look.look === LOOK.RAIL) spec.bedTop = this.trackBed;
      // Its portals' cuttings (5.17t, tunnel.c `cutting`): from the ground out of each collar; until that ground is
      // here, the mesh waits (its tiles fetched first as the tube's: #pick).
      const cuttings = this.#cuttings(r, mp, sec, spec.collar);
      if (cuttings === null) { r.meshWanted = true; r.meshAgainAt = performance.now() + CUT_AGAIN_MS; return; }
      spec.cutting = cuttings.map((c) => (c ? { len: c.len, half: c.half, tops: c.tops, feet: c.feet, head: c.head } : null));
      // The room it takes, cut out of the terrain and of what is built (cuts.js): from its points before they go to
      // the decode thread; where the ground is far over its vault, nothing can reach into it.
      const coverAt = r.fit.floor ? coverAlong(r.fit.floor) : null;
      const cut = boreCut(mp, sec, near.ends.map((e, i) => ({ type: ends[i], dirX: e.dirX, dirY: e.dirY, collar: f[i]?.collar ?? 0, rise: f[i]?.rise ?? 0,
        open: Math.max(0, (f[i]?.start ?? 0) - (f[i]?.collar ?? 0)) })), coverAt);
      // Its open approaches (5.17n, cuts.js addAprons): from each portal as mapped to its collar, the floor running
      // on as the approach does (as the mesh's run out of the portal does).
      const aprons = [];
      for (let e = 0; e < 2; e++) {
        const fe = f[e], collar = fe?.collar ?? 0;
        // (A cutting's floor is the tube's own, its walls hold the ground: no apron.)
        if (!fe || near.ends[e].type !== TUBE_END.PORTAL || cuttings[e]) continue;
        const sTube = e === 0 ? from : to, rise = fe.rise ?? 0, h = r.floorAt(sTube);
        if ((fe.start ?? 0) - collar >= APRON_LEAST) {
          aprons.push(meshPoints(near, (s) => h + rise * Math.abs(s - sTube), sec.half, zoom, e === 0 ? 0 : to + collar, e === 0 ? from - collar : near.length, sec.low?.half ?? 0));
        }
        // And APRON_OUT on out of the portal as mapped (5.17r): the ground there is the tracks' bed, drawn as the
        // floor is (the photo showed the real portal's shadow and walls there, a dark pit in front of the Ceneri tube
        // by Giubiasco over level ground, his "terrain messing things up").
        const end = near.ends[e], m = 111320 * Math.cos((end.lat * Math.PI) / 180), h0 = h + rise * Math.abs((e === 0 ? 0 : near.length) - sTube);
        // (A railway's only, 5.17t: out of a road tunnel the photo shows the road and its markings up to the portal,
        // and 5.17s's apron there was 20 m of plain asphalt.)
        if (near.family === 2 && Number.isFinite(end.dirX) && Number.isFinite(end.dirY)) {
          // (As wide as the bore is at its end, about its middle there: the Ceneri tube's portal is 22 m wide.)
          const pts = new Float64Array(2 * POINT_DOUBLES), q = (e === 0 ? 0 : mp.count - 1) * POINT_DOUBLES;
          for (let k = 0; k < 2; k++) {
            const d = k * APRON_OUT, o = k * POINT_DOUBLES;
            pts[o] = end.lon + (end.dirX * d) / m; pts[o + 1] = end.lat + (end.dirY * d) / 111132; pts[o + 2] = h0 + rise * d;
            pts[o + 3] = e === 0 ? -d : near.length + d; pts[o + 7] = mp.points[q + 7]; pts[o + 8] = mp.points[q + 8] || 1; pts[o + 9] = 1;
          }
          aprons.push({ points: pts, count: 2 });
        }
      }
      addAprons(cut, aprons, sec);
      // The terrain inside each cutting is left out, from a hair under its floor up (terrain.wgsl inBore: a piece
      // of the terrain's that is not an apron), out to its walls' outer faces.
      for (const c of cuttings) if (c) addCuttingBox(cut, c);
      const sphere = meshSphere(mp, sec, r.fit.collarWidth ?? COLLAR_WIDTH);
      // The box round it (the bodies' questions start with it) and the copy of the tube as placed that the render
      // thread keeps for them (placed.js), made with the floor the mesh is made with.
      const box = meshBox(near.points, cuttings);
      const copy = placedCopy(r, box, cuttings, this.#portalState(r));
      const points = mp.points, profile = Float32Array.from(sec.points);
      const m = await this.client.run('tunnel-mesh', { spec, points, profile }, { cls: VIEW, cost: 1, transfer: [points.buffer, profile.buffer] });
      if (this.records.get(near.key) !== r || r.sig !== sig) return;
      const lamps = look.lamps;
      const mesh = {
        id: ++this.meshIds, record: r, box, origin, originLonLat: [o.lon, o.lat], zoom, mercOrigin: [o.mx, o.my],
        // Round every point of it (5.17d's was round its middle point, half its length: a bent tube's or one whose
        // points crowd round a bend left part of it out, and it went at some angles).
        center: sphere.center, radius: sphere.radius,
        indexCount: m.indexCount, bytes: m.vertexCount * m.stride + m.indexCount * 4,
        lampStep: lamps.step, lamp: lampAt(sec, lamps.place), lampColour: lamps.colour, lampSize: lamps.size,
        // Lamps on a ceiling slab stay at its height however wide the bore (the shader lifts only those over spring).
        look: look.look, flags: look.flags, ways: look.ways, wall: look.wall, spring: sec.ceiling ? 1000 : sec.spring,
        // The floor between the walkways and their height (one line's: the shader stretches it with the bore), the
        // ventilation ceiling's height (its exhaust openings).
        inner: sec.low?.inner ?? sec.half, kerb: sec.kerb > 0 && sec.walkway > 0 ? sec.kerb : 0, ceiling: sec.ceiling ?? 0,
        // The daylight falls in at each mouth.
        portals: [f[0] ? from : -1e9, f[1] ? to : 1e9],
        inside: false,
        cut,
        // Its portals' cuttings (boreAt: their floors to stand on; the road in front pinned past them).
        cuttings,
      };
      // Drawn once the render thread has its buffers (made there in a frame's upload slice: view.js).
      await this.sink.mesh(mesh, m, copy);
      if (this.records.get(near.key) !== r || r.sig !== sig) { this.sink.unused(mesh); return; }
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
    r.box = mesh.box;
    this.gpuBytes += mesh.bytes;
    // What it takes the place of goes now, once none of the others taking it is still on its way (5.17w: not what its
    // box overlaps).
    const b = r.box;
    this.retiring = this.retiring.filter((q) => {
      const over = (q.successors ?? []).includes(r) && !q.successors.some(onItsWay);
      // (How many 5.17v's rule dropped here before their own took their place: the probe's.)
      const c = q.box, boxes = q.tube.family === r.tube.family && c[0] <= b[2] && b[0] <= c[2] && c[1] <= b[3] && b[1] <= c[3];
      if (boxes && !over && !q.spared) { q.spared = true; this.stats.spared = (this.stats.spared ?? 0) + 1; }
      if (over) this.#drop(q);
      return !over;
    });
    this.#lists();
  }

  /* (Its buffers go on the render thread once the lists no longer hold it: view.js.) */
  #freeMesh(mesh) {
    this.gpuBytes -= mesh.bytes;
  }

  /* Per end of a record's tube, what the portals' checks need (portal-checks.js): the portal's key, how far its floor
   * follows the road in front and how often it has, where the ground as cut has its tube start; null where not a
   * portal. */
  #portalState(r) {
    return r.tube.ends.map((e) => {
      if (e.type !== TUBE_END.PORTAL) return null;
      const key = portalKey(e, r.tube.family);
      return { key, lift: this.lifts.get(key) ?? 0, tries: this.liftTries.get(key) ?? 0, start: this.starts.get(key) ?? null };
    });
  }

  #drop(r) {
    if (r.mesh) { this.#freeMesh(r.mesh); r.mesh = null; }
    r.dropped = true;
    // (The tubes that dipped under it come back up; those opening into it keep their own floors.)
    for (const q of this.records.values()) {
      if (q === r) continue;
      if (q.dips?.has(r.tube.key)) this.#setDip(q, r.tube.key, null);
      for (const [e, j] of q.joins ?? []) if (j.key === r.tube.key) this.#setJoin(q, e, null);
    }
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
      if (!r.mesh) continue;
      this.meshes.push(r.mesh);
      const near = r.tube, p = near.points;
      for (let e = 0; e < 2; e++) {
        const end = near.ends[e], f = r.fit?.ends[e];
        if (end.type !== TUBE_END.PORTAL || !f) continue;
        const o = e ? p.length - TUBE_POINT : 0, s = p[o + 2], inward = e ? -1 : 1;
        const floor = r.floorAt(s), grade = (r.floorAt(s + inward * 10) - floor) / 10;
        // The terrain's opening (fit.js `opening`, passes/terrain.js: 5.17d's portal openings), from where the tube
        // starts in (its `before`: metres out of the portal it begins, negative inside).
        const q = f.opening, w = q.outline, mouth = f.outline.half + Math.abs(f.offset);
        const reachOpen = q.depth + w.half + Math.abs(q.offset) + 0.5 * Math.abs(q.bend) * q.depth * q.depth + 2;
        this.portals.push({
          lon: end.lon, lat: end.lat, h: floor,
          // Into the tunnel (against the end's outward way); out of it the floor rises as its approach does.
          dirX: -end.dirX, dirY: -end.dirY, rise: f.rise, grade,
          // The opening: the bore's middle right of the way in and how it bends on in; its outline (sections.js
          // outlineAt: a rectangle to `spring`, the arch's ellipse over it); from `before` out of the portal to
          // `depth` in.
          offset: q.offset, bend: q.bend,
          half: w.half, spring: w.top, crown: w.crown, archY: w.archY, archA: w.archA, archH: w.archH,
          before: -q.from, depth: q.depth,
          // The tube's half-width at its mouth (the road in front: vector/portals.js) and its walls' concrete (fit.js
          // collarWidth: the mesh's collar).
          mouth, wall: r.fit.collarWidth ?? 0,
          // How far round it the opening reaches (the tiles it opens), and the tiles drawn from both sides (seen from
          // inside the tunnel, the ground round the way out is met from beneath: terrain.wgsl fsPortal).
          open: reachOpen,
          reach: Math.max(PORTAL_REACH + mouth, reachOpen),
          ecef: geodeticToEcef(end.lon, end.lat, floor),
          // Where the tube starts, metres in (fit.js: where the ground covers it), and the open cutting up to there.
          start: f.start ?? 0,
          cutting: cuttingOf(r, e),
          // Metres out of the portal as mapped its cutting runs (5.17t: the road in front is pinned there).
          cut: r.mesh.cuttings?.[e] ? Math.max(0, r.mesh.cuttings[e].len - ((f.start ?? 0) - (f.collar ?? 0))) : 0,
          // Whether its way goes on as a bridge (#portalFloor: its floor on the deck, 5.17x).
          bridge: this.ground.lists.get(`a|${near.family}|${end.lon.toFixed(5)}|${end.lat.toFixed(5)}`)?.bridge === true,
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
    // Where tubes run into each other (5.17m: cuts.js boreMeets), each mesh's pieces of the others (meetsOf).
    this.meets = boreMeets(this.cuts);
    for (const m of this.meshes) { m.cutIndex = m.cut ? this.cuts.indexOf(m.cut) : -1; m.meet = null; }
    this.stats.meets = this.meets.reduce((n, list) => n + list.length, 0) / 2;
    // Each portal's floor, for the road running into it (vector/portals.js): told to the road tiles when it changes.
    // (And the tunnel's half-width there to its walls' outer faces: the road's level cut in front of it is as wide as
    // the tunnel and its walls, else a line of sight out through the mouth's lower corners runs on under its banks.)
    // (And the open cutting from the portal to where the tube starts: 5.17f.)
    // (And whether its way goes on as a bridge: no level cut or apron of its own under the deck, 5.17x.)
    const floors = this.portals.map((q) => ({
      lon: q.lon, lat: q.lat, height: q.h, rise: q.rise, half: q.mouth + q.wall, outX: -q.dirX, outY: -q.dirY, cutting: q.cutting, cut: q.cut,
      bridge: q.bridge,
    }));
    const sig = floors.map((q) => `${q.lon.toFixed(6)},${q.lat.toFixed(6)},${q.height.toFixed(2)},${q.rise.toFixed(3)},${q.half.toFixed(2)},${q.outX.toFixed(3)},${q.outY.toFixed(3)},${q.cutting ? q.cutting.length + ':' + q.cutting[q.cutting.length - 2].toFixed(1) : 0},${q.cut.toFixed(1)},${q.bridge ? 1 : 0}`).join('|');
    const changed = sig !== this.floorSig;
    this.floorSig = sig;
    // To the render thread (view.js): the meshes by id in the order drawn, the portals, the bores' meetings over the
    // cuts in that order, the floors when they changed.
    this.sink.lists({ meshes: this.meshes.map((m) => m.id), portals: this.portals, meets: this.meets, floors: changed ? floors : null,
      stats: this.stats, bytes: this.gpuBytes });
  }

  get bytes() { return this.gpuBytes; }

  /**
   * The railway tubes' lines within `within` metres of a point (5.18g, the console's swissgpu.lines): per tube, each
   * spine sample there as its mesh runs (mesh.js spineOf: smoothed as the tracks are drawn on it) and as found
   * (groups.js), with the tracks' offsets right of it (the spine's own 0 first; NaN where one does not run).
   * And per sample the bore's middle right of the spine and how much wider than one line it is (its half-width over
   * the section's: where tunnel.c tracks_at keeps the tracks off the kerbs); per tube its section's half-widths.
   * @returns [{ key, length, ends, half, floorHalf, samples: [[s, lon, lat, lonRaw, latRaw, middle, wide, ...offsets]] }]
   */
  linesNear(lon, lat, within) {
    const out = [], mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    for (const r of this.records.values()) {
      const t = r.tube;
      if (t.family !== 2 || !t.lines) continue;
      const half = r.section?.half ?? 2.5, drawn = spineOf(t, half), p = t.points, L = t.lines;
      const samples = [];
      for (let k = 0, i = 0; k < p.length; k += TUBE_POINT, i++) {
        if (Math.hypot((p[k] - lon) * mLon, (p[k + 1] - lat) * 111132) > within) continue;
        const row = [Math.round(p[k + 2] * 10) / 10, drawn[k], drawn[k + 1], p[k], p[k + 1],
          Math.round(p[k + 3] * 100) / 100, Math.round(boreWide(half, p[k + 4], r.section?.low?.half ?? 0) * 1000) / 1000];
        const n = L[i * LINE_FLOATS];
        for (let j = 0; j < Math.min(n, LINE_MOST); j++) row.push(Math.round(L[i * LINE_FLOATS + 1 + j] * 100) / 100);
        samples.push(row);
      }
      if (samples.length) {
        out.push({ key: t.key, length: Math.round(t.length), ends: t.ends.map((e) => [e.type, e.lon, e.lat]), half,
          floorHalf: r.section?.low?.inner ?? r.section?.low?.half ?? null, samples });
      }
    }
    return out;
  }

  /**
   * The tubes for the probe, as plain data (render.js adds what only it knows: the bore the camera is in, what is
   * drawn, the portals' ground as drawn and their checks: view.js report).
   */
  report() {
    const r2 = (v) => Math.round(v * 100) / 100;
    const tubes = [...this.records.values()].map((r) => ({
      kind: r.tube.kind, family: r.tube.family, length: Math.round(r.tube.length), tracks: r.tube.tracks,
      ends: r.tube.ends.map((e) => ({ type: e.type, lon: e.lon, lat: e.lat, dirX: e.dirX, dirY: e.dirY })),
      whole: r.whole && r.whole !== r.tube ? { key: r.whole.key, length: Math.round(r.whole.length), ends: r.whole.ends.map((e) => ({ type: e.type, lon: e.lon, lat: e.lat })) } : null,
      traced: r.traced, unplaced: Boolean(r.unplaced), entry: r.entry?.name ?? null,
      joinSeen: r.tube.ends.map((e, i) => (e.type === TUBE_END.JOIN ? this.joinSeen(r, i) : null)),
      section: r.section ? { half: r.section.half, spring: r.section.spring, height: r.section.height, points: r.section.count, box: !r.section.arch } : null,
      // How it meets the ground (fit.js): no room for it, its cover, per portal its face, collar and concrete, and how
      // its floor was kept under the ground (how far it dipped under the line between its portals, and how much of it
      // still stands out of the ground past its mouths).
      skipped: r.skipped, cover: Number.isFinite(r.fit?.cover) ? r.fit.cover : null,
      fit: r.fit?.ends.map((f) => f && { face: f.face, collar: f.collar, shell: f.shell, start: f.start }) ?? null,
      trims: r.tube.ends.map((e) => this.trimAt(e, r.tube.family)),
      key: r.tube.key, layer: r.tube.layer,
      // Where it dips under a tube it crosses (#crossings): with which, where along it, how deep.
      dips: r.dips ? [...r.dips.entries()].map(([k, d]) => ({ with: k, s: Math.round(d.s), depth: r2(d.depth) })) : [],
      // Its ends opening into another tube, and the floor they meet there (#joins, 5.17m); its fitted floor at its
      // ends, before that.
      joins: r.joins ? [...r.joins.entries()].map(([e, j]) => ({ end: e, with: j.key, floor: r2(j.floor) })) : [],
      fitFloor: r.fitFloor ? [r.fitFloor(0), r.fitFloor(r.tube.length)].map(r2) : null,
      // Metres each portal's floor followed the road in front of it as drawn (portal-checks.js align).
      lifts: r.tube.ends.map((e) => r2(this.liftAt(e, r.tube.family))),
      // How each portal's floor was found (portalGround).
      portalGround: r.tube.ends.map((e) => (e.type === TUBE_END.PORTAL ? this.portalGround(e, r.tube.family) : null)),
      collarWidth: r.fit?.collarWidth ?? null,
      dipped: r.fit?.floor?.dipped ?? 0, out: r.fit?.floor?.out ?? 0,
      floor: r.floorAt ? [r.floorAt(0), r.floorAt(r.tube.length)] : null,
      // Its floor along it (kept under the ground: fit.js), [s, height] at most every 10 m and 41 of them.
      profile: r.floorAt ? floorSamples(r) : null,
      // Its line, [lon, lat, s] at most every 25 m and 60 of them (5.17n: the live checks place cameras along it).
      line: lineSamples(r.tube),
      places: r.tube.tracks > 1 || (r.tube.lines && r.tube.lines[0] > 1) ? placesOf(r.tube) : null,
      mesh: r.mesh ? { id: r.mesh.id, triangles: r.mesh.indexCount / 3, bytes: r.mesh.bytes, radius: Math.round(r.mesh.radius),
        look: r.mesh.look, flags: r.mesh.flags, aprons: r.mesh.cut?.aprons?.length ?? 0 } : null,
      // The tubes running into it (5.17m: meets), by key, and how many of their pieces reach into it.
      meets: r.mesh && r.mesh.cutIndex >= 0 ? (this.meets[r.mesh.cutIndex] ?? []).map(({ other, pieces }) => ({
        with: this.meshes.find((m) => m.cutIndex === other)?.record.tube.key ?? null, pieces: pieces.length })) : [],
    }));
    return {
      ...this.stats, enabled: this.enabled, bytes: this.gpuBytes, tubes,
      // The whole tunnels traced (#runTrace), which tubes take as theirs (offWhole).
      wholes: this.wholes.map((w) => ({ key: w.key, length: Math.round(w.length), ends: w.ends.map((e) => [e.type, Math.round(e.lat * 1e5) / 1e5, Math.round(e.lon * 1e5) / 1e5]) })),
      // The tubes gone but still drawn until one taking their place is (retiring).
      retiring: this.retiring.map((r) => ({ key: r.tube.key, length: Math.round(r.tube.length), mesh: Boolean(r.mesh),
        successors: (r.successors ?? []).map((q) => ({ key: q.tube.key, length: Math.round(q.tube.length), mesh: Boolean(q.mesh), settled: Boolean(q.settled) })) })),
    };
  }
}

/** A mesh's fields the render thread draws it with (view.js; passes/tunnels.js), sent with its buffers. */
export const MESH_FIELDS = ['id', 'origin', 'originLonLat', 'zoom', 'mercOrigin', 'center', 'radius', 'indexCount', 'bytes', 'lampStep', 'lamp',
  'lampColour', 'lampSize', 'look', 'flags', 'ways', 'wall', 'spring', 'inner', 'kerb', 'ceiling', 'portals', 'cut', 'cuttings'];

/* A tube's floor along it for the probe: [s, height] at most every 10 m (41 at most), its ends among them. */
function floorSamples(r) {
  const L = r.tube.length, step = Math.max(10, L / 40), out = [];
  for (let s = 0; s < L; s += step) out.push([Math.round(s * 10) / 10, Math.round(r.floorAt(s) * 100) / 100]);
  out.push([Math.round(L * 10) / 10, Math.round(r.floorAt(L) * 100) / 100]);
  return out;
}

/* A tube's line for the probe: [lon, lat, s] at most every 25 m (60 at most), its ends among them. */
function lineSamples(tube) {
  const p = tube.points, n = p.length / TUBE_POINT, step = Math.max(25, tube.length / 60), out = [];
  let next = 0;
  for (let k = 0; k < n; k++) {
    const s = p[k * TUBE_POINT + 2];
    if (s < next && k < n - 1) continue;
    out.push([Math.round(p[k * TUBE_POINT] * 1e6) / 1e6, Math.round(p[k * TUBE_POINT + 1] * 1e6) / 1e6, Math.round(s * 10) / 10]);
    next = s + step;
  }
  return out;
}

/* (5.17t) Where a tube's lines beside its own run (groups.js `lines`, 7 floats a sample: how many, the spine's 0, then
 * each place's offset, NaN where it does not run): per place, its first and last metres along, its nearest to the
 * spine and its offset every 50 m or so (at most 24), for the probe. */
function placesOf(tube) {
  const L = tube.lines, p = tube.points;
  if (!L) return null;
  const n = Math.min(p.length / TUBE_POINT, L.length / 7), out = [];
  for (let i = 0; i < 5; i++) {
    let first = -1, last = -1, least = Infinity;
    const at = [];
    const step = Math.max(50, tube.length / 24);
    let next = 0;
    for (let k = 0; k < n; k++) {
      const v = L[k * 7 + 2 + i], sk = p[k * TUBE_POINT + 2];
      if (Number.isNaN(v)) continue;
      if (first < 0) first = sk;
      last = sk;
      least = Math.min(least, Math.abs(v));
      if (sk >= next) { at.push([Math.round(sk), Math.round(v * 10) / 10]); next = sk + step; }
    }
    if (first >= 0) out.push({ from: Math.round(first), to: Math.round(last), least: Math.round(least * 10) / 10, at });
  }
  return out;
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
  // A railway's emergency lights under the handrail along its walkway (TSI SRT: as low as possible over it).
  if (place === 'rail') place = 'wall', sec = { ...sec, lampUp: (sec.kerb > 0 && sec.walkway > 0 ? sec.kerb : 0) + 0.85 };
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
    // The loop's rightmost point a metre up (a railway's under its handrail).
    const h = sec.lampUp ?? 1.0;
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
/* A tube line's box: [west, south, east, north]. */
function lineBox(p) {
  let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
  for (let o = 0; o < p.length; o += TUBE_POINT) {
    if (p[o] < w) w = p[o];
    if (p[o] > e) e = p[o];
    if (p[o + 1] < so) so = p[o + 1];
    if (p[o + 1] > no) no = p[o + 1];
  }
  return [w, so, e, no];
}

/* A record's fitted floor with its JOIN ends eased to the floors of the tubes they open into (#joins): over
 * JOIN_EASE (half its length at most) from each, a cosine ease of the difference at that end. */
function withJoins(r) {
  const base = r.fitFloor, joins = r.joins ? [...r.joins.entries()] : [];
  if (!joins.length) return base;
  const L = r.tube.length, w = Math.max(1, Math.min(JOIN_EASE, L / 2));
  const eases = joins.map(([e, j]) => ({ e, by: j.floor - base(e ? L : 0) }));
  return (s) => {
    let h = base(s);
    for (const { e, by } of eases) {
      const d = e ? L - s : s;
      if (d < w) h += by * 0.5 * (1 + Math.cos((Math.PI * Math.max(0, d)) / w));
    }
    return h;
  };
}

/* Where two tube lines cross: metres along each ({ sa, sb }), or null (the first crossing found: two tunnels cross
 * once). */
function crossingOf(pa, pb) {
  const m = 111320 * Math.cos((pa[1] * Math.PI) / 180), M = 111132;
  for (let i = 0; i + TUBE_POINT < pa.length; i += TUBE_POINT) {
    const ax = pa[i] * m, ay = pa[i + 1] * M, bx = pa[i + TUBE_POINT] * m, by = pa[i + TUBE_POINT + 1] * M;
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
    for (let j = 0; j + TUBE_POINT < pb.length; j += TUBE_POINT) {
      const cx = pb[j] * m, cy = pb[j + 1] * M, dx = pb[j + TUBE_POINT] * m, dy = pb[j + TUBE_POINT + 1] * M;
      if (Math.max(cx, dx) < minX || Math.min(cx, dx) > maxX || Math.max(cy, dy) < minY || Math.min(cy, dy) > maxY) continue;
      const rX = bx - ax, rY = by - ay, sX = dx - cx, sY = dy - cy, den = rX * sY - rY * sX;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * sY - (cy - ay) * sX) / den, u = ((cx - ax) * rY - (cy - ay) * rX) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      return { sa: pa[i + 2] + t * (pa[i + TUBE_POINT + 2] - pa[i + 2]), sb: pb[j + 2] + u * (pb[j + TUBE_POINT + 2] - pb[j + 2]) };
    }
  }
  return null;
}

/* A portal's open cutting, from the portal as mapped to where its tube starts (5.17f; vector/portals.js pins the road
 * in front along it): [lon, lat, floor, metres out, grade] every CUTTING_STEP metres, or null where it starts at the
 * portal. */
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
function approachLine(ds, hs, steepest = 0.3) {
  const each = [];
  for (let i = 0; i < ds.length; i++) {
    const slopes = [];
    for (let j = 0; j < ds.length; j++) if (ds[j] !== ds[i]) slopes.push((hs[j] - hs[i]) / (ds[j] - ds[i]));
    if (slopes.length) each.push(median(slopes));
  }
  const slope = Math.max(-steepest, Math.min(steepest, each.length ? median(each) : 0));
  // (5.17r) The line the way runs on, not the hillside's face over its first metres: of the heights carried back at
  // that slope the lower quarter's (by the 441 m tube's portal by Giubiasco the face fell 8 m from 6 to 15 m out;
  // the median, carried back at the 30% the face gave, stood the floor 8 m over the tracks going on).
  const back = ds.map((d, i) => hs[i] - slope * d).sort((a, b) => a - b);
  return { height: back[Math.floor((back.length - 1) * 0.25)], slope };
}

/* The median of numbers (sorts them). */
function median(v) {
  v.sort((a, b) => a - b);
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : 0.5 * (v[h - 1] + v[h]);
}

export { MATERIAL };

/* ---- portal cuttings (5.17t) ---------------------------------------------------------------------------------- */

const WGS84_A = 6378137, DEG = Math.PI / 180;

/* A cutting's frame as tunnel.c makes it from the mesh's end (ring_between, ring_beyond): where its collar's ring is
 * (degrees, its floor), the way along there (te, tn: east and north), which way is out along it (dir), the bore's
 * middle right of the line there and how many lines wide it is; the floor's rise a metre out. */
function cuttingFrame(mp, e, collar, rise) {
  const p = mp.points, n = mp.count, i = e === 0 ? 0 : n - 1, j = e === 0 ? 1 : n - 2;
  const oa = (e === 0 ? i : j) * POINT_DOUBLES, ob = (e === 0 ? j : i) * POINT_DOUBLES, o = i * POINT_DOUBLES;
  const latm = 0.5 * (p[oa + 1] + p[ob + 1]) * DEG;
  const de = (p[ob] - p[oa]) * DEG * WGS84_A * Math.cos(latm), dn = (p[ob + 1] - p[oa + 1]) * DEG * WGS84_A;
  const l = Math.hypot(de, dn) || 1, te = de / l, tn = dn / l, dir = e === 0 ? -1 : 1, d = dir * collar;
  return {
    lon: p[o] + (te * d) / (WGS84_A * Math.cos(p[o + 1] * DEG)) / DEG, lat: p[o + 1] + (tn * d) / WGS84_A / DEG, h: p[o + 2] + rise * collar,
    te, tn, dir, off: p[o + 7], wide: p[o + 8] || 1, rise,
  };
}

/* Degrees of the point `d` metres out of a cutting's collar and `a` right of its line. */
function cuttingPoint(g, d, a) {
  const x = g.te * g.dir * d + g.tn * a, y = g.tn * g.dir * d - g.te * a;
  return [g.lon + x / (WGS84_A * Math.cos(g.lat * DEG) * DEG), g.lat + y / (WGS84_A * DEG)];
}


/* The box round a tube's mesh (degrees, [west, south, east, north]): its spine and 30 m round, and its portals'
 * cuttings out to their ends (the bodies' questions start with it: placed.js TubeQuery). */
function meshBox(p, cuttings) {
  let w = Infinity, so = Infinity, e = -Infinity, no = -Infinity;
  for (let k = 0; k < p.length; k += TUBE_POINT) { w = Math.min(w, p[k]); e = Math.max(e, p[k]); so = Math.min(so, p[k + 1]); no = Math.max(no, p[k + 1]); }
  const dl = 30 / (111320 * Math.cos((so * Math.PI) / 180)), dt = 30 / 111132;
  const box = [w - dl, so - dt, e + dl, no + dt];
  for (const c of cuttings ?? []) {
    if (!c) continue;
    const far = cuttingPoint(c, c.len, c.off);
    box[0] = Math.min(box[0], far[0] - dl); box[1] = Math.min(box[1], far[1] - dt);
    box[2] = Math.max(box[2], far[0] + dl); box[3] = Math.max(box[3], far[1] + dt);
  }
  return box;
}

/* Where a cutting's ground is looked at: every CUT_STEP out to CUT_MOST, its middle and both walls' outer faces; then
 * HEAD_N across its headwall, CUT_BEHIND inside its face. */
function cuttingPoints(g, half) {
  const pts = [];
  const at = (d, a) => { const q = cuttingPoint(g, d, a); pts.push(q[0], q[1]); };
  for (let i = 0; i <= CUT_MOST / CUT_STEP; i++) {
    const d = i * CUT_STEP, w = wingOff(half, d) + CUT_THICK;
    at(d, g.off); at(d, g.off - w); at(d, g.off + w);
  }
  for (let k = 0; k < HEAD_N; k++) at(-CUT_BEHIND, g.off - half - CUT_WALL + (k * 2 * (half + CUT_WALL)) / (HEAD_N - 1));
  return pts;
}

/* A cutting from the ground at cuttingPoints': none where the ground out of the collar is not CUT_ENDS over the floor
 * along its middle; else out to where it comes down to that along its middle and both walls (CUT_MOST at most); each
 * wall's top in straight runs through the ground along its outer face (CUT_OVER over it, topLine: never under it, so the
 * terrain's edge never stands open over a wall), meeting the headwall's at its root, its foot under the ground there
 * (under the floor at the least: where the ground falls away beside it, nothing is open under it); the headwall's top
 * through the ground behind its face. */
function cuttingFrom(g, half, H) {
  const steps = CUT_MOST / CUT_STEP, over = (i, k) => H[i * 3 + k] - (g.h + g.rise * i * CUT_STEP);
  if (!(over(0, 0) >= CUT_ENDS)) return null;
  let last = steps;
  for (let i = 1; i <= steps; i++) if (!(Math.max(over(i, 0), over(i, 1), over(i, 2)) >= CUT_ENDS)) { last = i; break; }
  const n = last + 1, tops = new Float32Array(2 * n), feet = new Float32Array(2 * n), head = new Float32Array(HEAD_N);
  const clamp = (v) => Math.min(CUT_TALL, Math.max(CUT_LEAST, Number.isFinite(v) ? v : CUT_LEAST));
  const xs = Array.from({ length: HEAD_N }, (_, k) => k);
  const hd = topLine(xs, xs.map((k) => clamp(H[3 * (steps + 1) + k] - g.h + CUT_OVER)), CUT_SLACK);
  for (let k = 0; k < HEAD_N; k++) head[k] = hd[k];
  const ds = Array.from({ length: n }, (_, i) => i * CUT_STEP);
  for (let k = 0; k < 2; k++) {
    const raw = ds.map((_, i) => clamp(over(i, k + 1) + CUT_OVER));
    raw[0] = Math.max(raw[0], k === 0 ? head[0] : head[HEAD_N - 1]);
    const line = topLine(ds, raw, CUT_SLACK);
    for (let i = 0; i < n; i++) {
      tops[2 * i + k] = line[i];
      const ground = over(i, k + 1);
      feet[2 * i + k] = Number.isFinite(ground) ? Math.max(-CUT_TALL, Math.min(-CUT_FOOT, ground - CUT_FOOT)) : -CUT_FOOT;
    }
  }
  return { ...g, len: last * CUT_STEP, half, n, tops, feet, head, box: half + CUT_THICK, splay: WING_SPLAY, wing: WING_LEN };
}

/* A wall's top over heights ys at xs (rising): straight runs between some of the points, never under any and nowhere
 * more than `slack` over one, so it steps down where the ground does (5.17v's first, the points' upper hull, bridged
 * every dip: a wall standing 3 m over the ground falling away beside the branch at Giubiasco); at each x. */
function topLine(xs, ys, slack) {
  const n = xs.length, keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const split = (a, b) => {
    let worst = -1, most = 0;
    for (let i = a + 1; i < b; i++) {
      const gap = ys[a] + ((ys[b] - ys[a]) * (xs[i] - xs[a])) / (xs[b] - xs[a] || 1) - ys[i];
      // (A point over the run always splits it, first; a run more than `slack` over one splits at the furthest.)
      const e = gap < 0 ? 1e6 - gap : gap > slack ? gap : 0;
      if (e > most) { most = e; worst = i; }
    }
    if (worst < 0) return;
    keep[worst] = 1;
    split(a, worst);
    split(worst, b);
  };
  if (n > 2) split(0, n - 1);
  const out = new Array(n);
  for (let a = 0; a < n - 1;) {
    let b = a + 1;
    while (!keep[b]) b++;
    for (let i = a; i <= b; i++) out[i] = ys[a] + ((ys[b] - ys[a]) * (xs[i] - xs[a])) / (xs[b] - xs[a] || 1);
    a = b;
  }
  if (n === 1) out[0] = ys[0];
  return out;
}


/* The point `d` metres along a tube's spine from its end e: [lon, lat], or null. */
function pointAlong(t, e, d) {
  const p = t.points, n = p.length / TUBE_POINT;
  if (n < 2) return null;
  const s = e === 0 ? d : p[(n - 1) * TUBE_POINT + 2] - d;
  for (let k = 0; k + 1 < n; k++) {
    const a = k * TUBE_POINT, b = a + TUBE_POINT, sa = p[a + 2], sb = p[b + 2];
    if (s < sa || s > sb) continue;
    const f = sb > sa ? (s - sa) / (sb - sa) : 0;
    return [p[a] + (p[b] - p[a]) * f, p[a + 1] + (p[b + 1] - p[a + 1]) * f];
  }
  return null;
}

/* How far a tube lies off a whole tunnel's line at most, metres (Infinity: not this tunnel): its open ends and the
 * points a quarter, half and three quarters along it within MATCH of the line, its other ends within END_MATCH.
 * 5.17w: by the open ends alone, the Ceneri base tunnel's east tube, its open end moved on with the road tiles round
 * him inside it, took a tunnel whose line passed within MATCH of that end and not its portal: no floor known at
 * either end, it was never placed, and its portal closed (his words on 5.17v: "it closed the hole behind me!"). */
function offWhole(near, w) {
  const p = near.points, n = p.length / TUBE_POINT;
  let most = 0;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const k = Math.round(f * (n - 1)), end = f === 0 ? near.ends[0] : f === 1 ? near.ends[1] : null;
    const off = placeOn(w, p[k * TUBE_POINT], p[k * TUBE_POINT + 1]).off;
    if (!(off <= (end && end.type !== TUBE_END.OPEN ? END_MATCH : MATCH))) return Infinity;
    most = Math.max(most, off);
  }
  return most;
}

/* Whether tube record q takes (some of) r's place (5.17w): the same family, a stretch of one on the other's line
 * (REPLACE_OFF): the same tunnel with an end moved, or split where the lines in its bore part. By Giubiasco the tube
 * from the Ceneri base tunnel's portal ran on along the east line, then, the road tiles further in loaded, along the
 * west one (groups.js: a bore's spine is its longest line), the east line beyond their parting a tube of its own; the
 * one the camera was in had no tube taking its place by its ends and middle, went, and the camera was set on the
 * hillside's surface. */
function replaces(q, r) {
  if (q === r || q.tube.family !== r.tube.family) return false;
  const a = lineBox(q.tube.points), b = lineBox(r.tube.points), dl = 0.0005;
  if (a[0] > b[2] + dl || b[0] > a[2] + dl || a[1] > b[3] + dl || b[1] > a[3] + dl) return false;
  return onLine(q.tube, r.tube) || onLine(r.tube, q.tube);
}

/* Whether any of tube b's points lies on tube a's line (REPLACE_OFF). */
function onLine(a, b) {
  const p = b.points;
  for (let k = 0; k < p.length; k += TUBE_POINT) if (placeOn(a, p[k], p[k + 1]).off <= REPLACE_OFF) return true;
  return false;
}

/* A tube still on its way to a mesh (one taking a retiring one's place): none yet, not gone, not without room (one
 * whose floor is not known yet, unplaced, may yet be: till then the one it takes the place of stands for it). */
function onItsWay(q) {
  return !q.mesh && !q.dropped && !q.skipped;
}

/* The terrain left out inside a cutting (cuts.js aprons, a piece that is not one: terrain.wgsl inBore), from a hair
 * under its floor up, to its walls' outer faces. */
function addCuttingBox(cut, c) {
  const pts = [], wing = c.wing ?? 0, ds = c.len > wing && wing > 0 ? [0, wing, c.len] : [0, c.len];
  for (const d of ds) {
    const [lon, lat] = cuttingPoint(c, d, c.off), e = geodeticToEcef(lon, lat, c.h + c.rise * d - 0.02);
    const box = wingOff(c.box, d, c.splay ?? 0, wing);   // (out to the walls' outer faces, splaying, then along)
    pts.push(e[0], e[1], e[2], box, CUT_BOX_TOP, 0, 0, 0, box);
    cut.radius = Math.max(cut.radius, Math.hypot(e[0] - cut.centre[0], e[1] - cut.centre[1], e[2] - cut.centre[2]) + box + CUT_BOX_TOP);
  }
  (cut.aprons ??= []).push({ points: Float64Array.from(pts), count: ds.length, kerb: 0, lowR: 0 });
}
const CUT_BOX_TOP = 100;
