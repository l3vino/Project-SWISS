/* terrain.js — which terrain tiles are drawn, and at what detail.
 *
 * A quadtree over the global-geodetic tile grid, walked from the roots down
 * whenever the view changes. A tile is split into its four children only while
 * its error, projected onto the screen, is larger than the detail setting
 * allows: a couple of pixels by default. That puts metre-scale triangles under
 * your feet and kilometre-scale ones at the horizon, with roughly the same
 * number of triangles per pixel everywhere in between.
 *
 * A quantized-mesh tile does not state its own error, so the convention Cesium
 * established is used: the error of a 65 x 65 heightmap over the tile, which
 * halves with every level. Matching it means a service tuned for Cesium looks
 * the way its authors intended.
 *
 * Three rules keep this correct while tiles are still streaming in:
 *  - A tile is replaced by its children only once every child in view has
 *    arrived. Until then the parent keeps drawing and the children are what
 *    get requested, so refinement never opens a hole.
 *  - A child that does not exist is never requested: outside the service's
 *    coverage, beyond its deepest level, or absent according to the
 *    availability the tiles themselves publish. Its quarter stays covered by
 *    the parent, which then draws with a mask telling the shader which
 *    quarters its children cover instead.
 *  - Only tiles inside the view frustum and short of the horizon are
 *    visited, so what is behind you or below the curve of the earth costs
 *    neither requests nor draw calls. Children just outside the view are
 *    requested last, so turning round mostly finds them already loaded.
 *
 * Requests go out nearest first: a selection keeps only the few dozen most
 * urgent candidates (engine/topk.js) rather than sorting every tile it would
 * like, and the scheduler (core/scheduler.js) says when the next may start.
 * While a search flight streams the ground past fast, finer tiles are only
 * asked for where a coarser detail (`motionScale`) would still want them:
 * what is already here is drawn as ever, but the way past is not loaded in
 * a detail nobody can follow (render.js sets it from the flight's pace).
 * Tiles under a point physics needs (a column) go first, in the physics
 * class. A request for a tile that selections have stopped wanting is called
 * off; a failed one is tried again later, spaced out (see #retryLater).
 *
 * Flights ask how high the ground anywhere near a point can be (upperBound):
 * every tile arrives with the highest point over each cell of a 16 x 16 grid
 * laid on it (wasm/src/qm.c, qm_tops), and the finest loaded tiles answer,
 * with a margin for the detail their level leaves out. A tile dropped for
 * memory keeps its grid (512 bytes) for as long as its node is in the tree:
 * the ground has not moved, so what it said still holds.
 *
 * Memory is a budget kept in least-recently-used order without ever scanning
 * or sorting the loaded tiles (engine/lru.js): each selection marks what it
 * uses, and what went unused longest is dropped first, finer tiles before
 * the coarser ones they refine. When the view in front of you needs more than
 * the budget holds, so that nothing unused is left to drop, the detail of the
 * next selection is lowered a step instead, and raised again once there is
 * room. Branches left empty are forgotten a few at a time, never by walking
 * the whole tree in one frame.
 */

import { tileRect, tileKey, tileAt } from './tiling.js';
import { TerrainSource } from './source.js';
import { VERTEX_STRIDE } from './format.js';
import { regionSphere } from '../bounds.js';
import { LruList } from '../lru.js';
import { TopK } from '../topk.js';
import { WGS84_A } from '../../core/math.js';
import { PHYSICS, VIEW, PRELOAD, hostOf } from '../../core/scheduler.js';
import { isAbort } from '../../core/rpc.js';

export const UNLOADED = 0, LOADING = 1, READY = 2, MISSING = 3;

/* Cesium's level-zero error for quantized-mesh terrain: a 65 x 65 heightmap
 * over one of the two level-zero tiles, a quarter of its sample spacing. About
 * 77 km at level 0, 0.6 m at level 17. */
const LEVEL_ZERO_ERROR = (WGS84_A * 2 * Math.PI * 0.25) / (65 * 2);
export const geometricError = (z) => LEVEL_ZERO_ERROR / 2 ** z;

/* The coarsest level physics may stand on anywhere: about 5 m of error. A
 * coarser tile is only a stand-in while detail streams: over the Alps its
 * surface can be kilometres above a valley floor (the level-3 tile over
 * Bellinzona puts the ground at 2,710 m; it is at 248 m). Where a service has
 * nothing finer, its finest tile is the ground there, whatever its level. */
export const ACCURATE_LEVEL = 14;

/* Curtains hang five times the level's error, which covers the step between
 * neighbours up to two levels apart. The bounds keep coarse levels from
 * hanging kilometres of wall and fine ones from hanging almost none. */
const skirtFor = (z) => Math.min(2000, Math.max(2, 5 * geometricError(z)));

/* A tile's grid of highest points (see upperBound): cells a side, and how
 * far above its own mesh the real ground may be, in geometric errors. Over
 * six 4,000 m peaks at levels 7 to 13 the worst was 0.43 of the error;
 * 1.5 leaves room. An estimate rather than a bound (estimate) adds half. */
const TOPS = 16;
const TOPS_ERROR = 1.5;
const ESTIMATE_ERROR = 0.5;
const QUANTIZED_MAX = 32767;

/* Children are numbered by quarter: bit 0 set for the east half, bit 1 for
 * the north half. With rows counted from the south, child i of (x, y) is
 * (2x + (i & 1), 2y + (i >> 1)). */
export const quarterOf = (t, lon, lat) =>
  (lon >= (t.rect.west + t.rect.east) / 2 ? 1 : 0) | (lat >= (t.rect.south + t.rect.north) / 2 ? 2 : 0);

/* A tile selections have not wanted for this long, while they went on, is
 * called off; one asked for in a column (for physics) stays wanted this long
 * (whoever needs a column asks for it again every frame, or every quarter
 * second). */
const STALE_MS = 500;
const STALE_SELECTIONS = 2;
const COLUMN_LIFE_MS = 2000;
/* Preloading (a flight's arrival view): tiles kept per walk, and how long
 * they stay wanted without the view asking for them. */
const PRELOAD_KEPT = 128;
const PRELOAD_LIFE_MS = 30000;
/* Keys of tiles known not to exist, kept across pruning, oldest dropped first. */
const MISSING_MEMORY = 50000;
/* Candidates kept per selection: several times what can be in flight. */
const WANTED_KEPT = 64;
/* Tiles waiting in prefetched columns, at most; and in columns ahead of a
 * flight (prefetchAhead). */
const COLUMN_KEPT = 128;
const AHEAD_KEPT = 64;
/* Tiles dropped per frame at most; the rest go on the frames after. */
const DROPS_PER_FRAME = 32;
const DROP_MS = 0.5;       // and for at most this long; at least one goes
/* Memory pressure: each selection that finds nothing unused to drop lowers
 * detail by at least this factor (more when far over), never below the
 * floor; with 30% of the budget free for a while, detail comes back a step
 * at a time. */
const COARSEN = 0.85;
const RELAX = 1.1;
const RELAX_AFTER_MS = 2000;
const MIN_DETAIL = 0.2;
/* Empty branches go once nothing in them was used for this many selections.
 * The sweep that finds them looks at this many nodes a frame, one pass a
 * second. */
const PRUNE_AFTER = 60;
const SWEEP_NODES = 256;
const SWEEP_INTERVAL_MS = 1000;

/* Whether two rectangles in degrees touch. */
const overlaps = (r, b) => !(b.east < r.west || b.west > r.east || b.north < r.south || b.south > r.north);

/* The highest of a loaded tile's grid cells over a rectangle (clipped to
 * the tile), in metres, plus the margin for detail its level leaves out. */
function cellsTop(t, w, s, e, n, k) {
  const r = t.rect, sx = TOPS / (r.east - r.west), sy = TOPS / (r.north - r.south);
  const i0 = Math.max(0, Math.min(TOPS - 1, Math.floor((w - r.west) * sx)));
  const i1 = Math.max(0, Math.min(TOPS - 1, Math.floor((e - r.west) * sx)));
  const j0 = Math.max(0, Math.min(TOPS - 1, Math.floor((s - r.south) * sy)));
  const j1 = Math.max(0, Math.min(TOPS - 1, Math.floor((n - r.south) * sy)));
  const tops = t.tops;
  let q = 0;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0, k = j * TOPS + i0; i <= i1; i++, k++) if (tops[k] > q) q = tops[k];
  }
  return t.minHeight + (q / QUANTIZED_MAX) * (t.maxHeight - t.minHeight) + k * geometricError(t.z);
}

class TerrainTile {
  constructor(z, x, y, parent) {
    this.z = z; this.x = x; this.y = y;
    this.key = tileKey(z, x, y);
    this.rect = tileRect(z, x, y);
    this.parent = parent;
    this.isRoot = false;          // where every traversal starts; never evicted
    this.children = null;         // four TerrainTiles, once this tile has been split
    this.sources = [];            // services that should have this tile, best first
    this.state = UNLOADED;
    this.retryAt = 0;
    this.attempts = 0;            // failures in a row worth retrying
    this.wantedAt = 0;            // when a selection last wanted it loaded
    this.wantedSel = 0;           // and which selection that was
    this.columnAt = -Infinity;    // when a column for physics last asked for it
    this.preloadAt = -Infinity;   // when a preload last asked for it

    // The parent's height range stands in until this tile's own header
    // arrives. It is always a superset, which keeps culling conservative.
    this.minHeight = parent ? parent.minHeight : -500;
    this.maxHeight = parent ? parent.maxHeight : 9000;
    this.center = new Float64Array(3);    // bounding sphere, absolute ECEF
    this.radius = regionSphere(this.rect, this.minHeight, this.maxHeight, this.center);

    this.lastUsed = 0;            // traversal that last touched this tile
    this.priority = 0;
    this.heapIndex = -1;          // place among a selection's kept candidates (topk.js)
    this.lruPrev = null;          // links in the memory budget's order (lru.js)
    this.lruNext = null;
    this.drawnFrame = -1;         // traversal that last drew it
    this.mask = 0;                // quarters covered by children when drawn
    this.final = false;           // drawn because it is detailed enough, not as a stand-in
    this.distance = 0;            // metres from the eye when last drawn

    this.vbuf = null;
    this.ibuf = null;
    this.tops = null;             // highest point per cell of a TOPS x TOPS grid, quantized (kept when dropped)
    this.indexCount = 0;
    this.indexFormat = 'uint16';
    this.origin = null;           // tile origin, absolute ECEF, doubles
    this.bytes = 0;
    this.url = null;
    this.source = null;
    this.imageryMap = null;       // cached by the terrain pass
    this.imageryZoom = -1;
  }

  /** Worth asking for at all. */
  get available() { return this.state !== MISSING && this.sources.length > 0; }
}

/* The host a service's tiles come from, worked out once per service. */
function hostFor(source) {
  return source ? (source.host ??= hostOf(source.urlFor(0, 0, 0))) : '';
}

export class Terrain {
  /**
   * @param maxError  pixels of error a tile may show before it is split
   * @param budgetMB  vertex and index memory kept for tiles
   */
  constructor({ device, scheduler, registry, uploads = null, maxError = 2, budgetMB = 256 }) {
    this.device = device;
    this.scheduler = scheduler;
    this.client = scheduler.client('terrain', { weight: 3, pick: (cls) => this.#pick(cls), stale: (t) => this.#stale(t) });
    this.registry = registry;
    this.uploads = uploads;       // shared per-frame upload slice (engine/uploads.js)
    this.maxError = maxError;
    this.budget = budgetMB * 1048576;

    this.sources = new Map();     // adapter id -> TerrainSource
    this.sourceList = [];         // the same, as an array for the questions physics asks
    this.roots = [];
    this.tiles = new Map();       // key -> TerrainTile, every node of the tree
    this.missing = new Set();
    this.visible = [];            // drawn this traversal, roughly near to far
    this.wanted = new TopK(WANTED_KEPT);   // the most urgent tiles a selection asked for
    this.wantedCount = 0;         // how many it asked for in all
    this.queue = [];              // the kept ones, most urgent first, taken in order
    this.queueAt = 0;
    this.column = [];             // tiles under a spawn point, loaded before anything else
    this.ahead = [];              // tiles under a flight's way, loaded when nothing else is waiting
    this.preQueue = [];           // what a view from elsewhere would draw (see preload)
    this.preAt = 0;
    this.inFlight = 0;
    this.paused = false;          // no new requests (diagnostics)
    // Physics' say in what is decoded: whether a tile's ground index should
    // be made with it, and where such an index goes (ground.js).
    this.wantsGround = null;
    this.onGround = null;
    this.bytes = 0;
    this.readyCount = 0;

    // Loaded tiles in least-recently-used order, roots excepted.
    this.lru = new LruList();
    this.detailScale = 1;         // below 1 while the view needs more than the budget
    this.motionScale = 1;         // below 1: finer tiles asked for as if the detail were this much lower
    this.pressureAt = 0;
    this.evicting = false;
    this.dropped = 0;
    this.sweepStack = [];
    this.sweepOpen = [];
    this.sweepAt = 0;
    // Milliseconds spent this frame on dropping tiles and on tidying the
    // tree; the render thread charges them to their own profiler sections.
    this.timing = { evict: 0, maintain: 0 };

    this.frame = 0;
    this.now = 0;                 // performance.now() at the latest selection
    this.selectedAt = 0;
    this.dirty = true;
    this.view = null;
    this.viewVersion = -1;
    this.reach = 0;
    this.errorFactor = 1;
    this.stats = { drawn: 0, ready: 0, pending: 0, loading: 0, queued: 0, bytes: 0, minLevel: 0, maxLevel: 0, missing: 0,
      budget: this.budget, detail: 1, nodes: 0, dropped: 0 };
  }

  /**
   * Ask every registered service what it actually offers, once, before any
   * tile is requested. Doing this up front is what lets tile selection stay
   * synchronous.
   */
  async prepare() {
    const jobs = this.registry.all
      .filter((adapter) => adapter.terrain)
      .map(async (adapter) => {
        const source = await TerrainSource.load(adapter, adapter.terrain);
        if (source) this.sources.set(adapter.id, source);
      });
    await Promise.all(jobs);
    this.sourceList = [...this.sources.values()];
    this.#plantRoots();
    return [...this.sources.values()].map((s) => s.describe());
  }

  /**
   * Detail and memory, from the settings. `detailDistance` (metres) is how
   * far out the finest level is kept, and every coarser level reaches twice
   * as far as the one below it; without it, detail follows `maxError`, a
   * number of pixels on screen.
   */
  configure({ maxError, budgetMB, detailDistance }) {
    if (maxError !== undefined && maxError > 0) this.maxError = maxError;
    if (budgetMB !== undefined && budgetMB > 0) this.budget = budgetMB * 1048576;
    if (detailDistance !== undefined) this.detailDistance = detailDistance > 0 ? detailDistance : null;
    // New settings start from full detail; pressure, if any, shows again.
    this.detailScale = 1;
    this.dirty = true;
  }

  /** Stops sending requests (for diagnosing), or resumes. */
  pause(on) { this.paused = Boolean(on); }

  /** Geometric error of the finest level any service has. */
  get finestError() {
    let z = 0;
    for (const s of this.sources.values()) z = Math.max(z, s.maxLevel);
    return geometricError(z || 18);
  }

  /* The coarsest level any service offers, over everything the services
   * cover. For swisstopo that is level 0: one tile, which also carries the
   * availability of the ten levels below it. */
  #plantRoots() {
    if (!this.sources.size) return;
    const z = Math.min(...[...this.sources.values()].map((s) => s.minLevel));
    const roots = new Map();
    for (const source of this.sources.values()) {
      const r = source.adapter.rect;
      const a = tileAt(z, r.west, r.south), b = tileAt(z, r.east, r.north);
      for (let y = a.y; y <= b.y; y++) {
        for (let x = a.x; x <= b.x; x++) {
          const key = tileKey(z, x, y);
          if (roots.has(key)) continue;
          const root = this.#create(z, x, y, null);
          root.isRoot = true;
          roots.set(key, root);
        }
      }
    }
    this.roots = [...roots.values()];
  }

  #create(z, x, y, parent) {
    const t = new TerrainTile(z, x, y, parent);
    for (const { adapter } of this.registry.providers('terrain', t.rect)) {
      const source = this.sources.get(adapter.id);
      if (source && source.isAvailable(z, x, y)) t.sources.push(source);
    }
    if (this.missing.has(t.key)) t.state = MISSING;
    this.tiles.set(t.key, t);
    return t;
  }

  #split(t) {
    const z = t.z + 1, x = t.x * 2, y = t.y * 2;
    t.children = [
      this.#create(z, x, y, t), this.#create(z, x + 1, y, t),
      this.#create(z, x, y + 1, t), this.#create(z, x + 1, y + 1, t),
    ];
    return t.children;
  }

  /* A service that declares level 0 but starts deeper in practice would
   * otherwise draw nothing at all: a root that does not exist hands over to
   * whichever of its children do. */
  #promoteChildren(root) {
    if (![...this.sources.values()].some((s) => s.serves(root.z + 1))) return;
    const children = (root.children ?? this.#split(root)).filter((c) => c.available);
    // Roots are never dropped, so they leave the budget's order.
    for (const c of children) { c.isRoot = true; this.lru.remove(c); }
    this.roots = this.roots.flatMap((r) => (r === root ? children : [r]));
    console.info(`[terrain] no tile ${root.z}/${root.x}/${root.y}; starting from level ${root.z + 1} there`);
  }

  /* ---- per frame ---------------------------------------------------------- */

  /**
   * Re-selects the drawn set when the view changed or a tile arrived, then
   * keeps requests flowing. Standing still costs almost nothing.
   * @param view  the frame's shared View (js/engine/view.js)
   */
  update(view) {
    if (view.version !== this.viewVersion || this.dirty) {
      this.viewVersion = view.version;
      this.dirty = false;
      this.#select(view);
      this.#evict(true);
    } else if (this.evicting) {
      // A drop capped last frame carries on, view change or not.
      this.#evict(false);
    }
    this.#relax();
    this.#sweep();
    this.#refreshStats();
  }

  #select(view) {
    this.frame++;
    this.view = view;
    this.now = this.selectedAt = performance.now();
    // Everything loaded counts as unused until this selection touches it.
    this.lru.mark();
    // A tile splits while its error times this exceeds its distance.
    this.errorFactor = this.#factor(view);

    this.visible.length = 0;
    this.wantedCount = 0;
    this.reach = 0;
    this.drawnMin = Infinity;
    this.drawnMax = -Infinity;
    for (const root of this.roots) this.#visit(root);
    this.wanted.drainSorted(this.queue);
    this.queueAt = 0;
    this.reach = Math.min(this.reach, view.horizon);
  }

  /* Visits a tile, then marks it used: after its children, so that among
   * tiles last used in the same selection the finer ones are dropped first
   * and the coarser ones stay to stand in for them. */
  #visit(t) {
    this.#visitTile(t);
    this.lru.touch(t);
  }

  #visitTile(t) {
    t.lastUsed = this.frame;
    const view = this.view;
    if (!view.sphereVisible(t.center, t.radius)) return;
    const d = this.#distance(t);
    // Past the horizon: skipped along with everything under it.
    if (d > view.horizon) return;

    if (t.state !== READY) {
      // Only a root arrives here unloaded. Deeper tiles are requested by
      // their parent's visit and drawn only once they are ready.
      if (t.state === UNLOADED) this.#want(t, d);
      else if (t.state === LOADING) this.#stamp(t);
      return;
    }

    const children = this.#refinement(t, d);
    if (!children) { this.#draw(t, 0, true, d); return; }

    // Split only once every child in view that exists has arrived. Moving
    // fast, missing children are asked for only at the lower detail.
    const ask = this.motionScale >= 1 || geometricError(t.z) * this.errorFactor * this.motionScale > d;
    let ready = true;
    for (let i = 0; i < 4; i++) {
      const c = children[i];
      if (!c.available) continue;
      c.lastUsed = this.frame;
      if (c.state === READY) { this.lru.touch(c); continue; }
      const inView = view.sphereVisible(c.center, c.radius) && this.#distance(c) <= view.horizon;
      if (inView) ready = false;
      if (c.state === UNLOADED && ask) {
        const dc = this.#distance(c);
        this.#want(c, inView ? dc : 1e6 + dc * 4);
      } else if (c.state === LOADING) {
        this.#stamp(c);
      }
    }
    if (!ready) { this.#draw(t, 0, false, d); return; }

    // Near to far: the quarter under the eye, its two neighbours, then the
    // opposite one. The depth test then rejects more of what follows.
    const q = quarterOf(t, view.camera.lon, view.camera.lat);
    let covered = 0, gaps = false;
    for (let k = 0; k < 4; k++) {
      const i = q ^ k;
      const c = children[i];
      if (!c.available) { gaps = true; continue; }
      covered |= 1 << i;
      this.#visit(c);
    }
    // Quarters with no finer data stay covered by this tile.
    if (gaps) this.#draw(t, covered, true, d);
  }

  /* A tile splits while its error times this exceeds its distance. */
  #factor(view) {
    const factor = this.detailDistance ? this.detailDistance / this.finestError : view.pixelsPerRadian / this.maxError;
    return factor * this.detailScale;
  }

  /** Detail asked for while moving fast (see the top of the file): 1 is all. */
  setMotion(scale) {
    const s = Math.min(1, Math.max(0.1, scale));
    if (s === this.motionScale) return;
    this.motionScale = s;
    this.dirty = true;
  }

  /** The children to draw instead of this tile, or null if it is detailed enough. */
  #refinement(t, d) {
    if (geometricError(t.z) * this.errorFactor <= d) return null;
    const children = t.children ?? this.#split(t);
    for (let i = 0; i < 4; i++) if (children[i].available) return children;
    return null;   // nothing finer exists here
  }

  #draw(t, mask, final, d) {
    t.drawnFrame = this.frame;
    t.mask = mask;
    t.final = final;
    t.distance = d;
    this.visible.push(t);
    // How far drawn terrain extends: nearest point plus the tile's diagonal.
    const r = t.rect, v = this.view;
    const w = (r.east - r.west) * v.mPerDegLon, h = (r.north - r.south) * v.mPerDegLat;
    const far = d + Math.sqrt(w * w + h * h);
    if (far > this.reach) this.reach = far;
    // The level range reported is that of whole tiles. A partly covered one
    // fills leftover quarters, often far away, and would only make the
    // coarse end of the range look worse than what is on screen.
    if (mask === 0) {
      if (t.z < this.drawnMin) this.drawnMin = t.z;
      if (t.z > this.drawnMax) this.drawnMax = t.z;
    }
  }

  #want(t, priority) {
    t.priority = priority;
    this.#stamp(t);
    this.wantedCount++;
    this.wanted.offer(t);
  }

  /** Metres from the eye to the nearest point of a tile's rectangle and height range. */
  #distance(t) {
    const r = t.rect;
    return this.view.regionDistance(r.west, r.south, r.east, r.north, t.minHeight, t.maxHeight);
  }

  /* ---- loading ------------------------------------------------------------ */

  /*
   * The scheduler's turn (core/scheduler.js): starts the most urgent tile of
   * a class and says whether it did. Physics: the columns under points that
   * need ground. View: this selection's queue.
   */
  #pick(cls) {
    if (this.paused) return false;
    const now = performance.now();
    if (cls === PRELOAD) {
      const q = this.preQueue;
      while (this.preAt < q.length) {
        const t = q[this.preAt];
        if (!this.#loadable(t, now)) { this.preAt++; continue; }
        if (!this.client.canRun(hostFor(t.sources[0]))) return false;
        this.preAt++;
        this.#load(t, PRELOAD);
        return true;
      }
      const a = this.ahead;
      while (a.length) {
        const t = a[0];
        if (!this.#loadable(t, now)) { a.shift(); continue; }
        if (!this.client.canRun(hostFor(t.sources[0]))) return false;
        a.shift();
        this.#load(t, PRELOAD);
        return true;
      }
      return false;
    }
    if (cls === PHYSICS) {
      const column = this.column;
      while (column.length) {
        const t = column[0];
        if (!this.#loadable(t, now)) { column.shift(); continue; }
        if (!this.client.canRun(hostFor(t.sources[0]))) return false;
        column.shift();
        this.#load(t, PHYSICS);
        return true;
      }
      return false;
    }
    if (cls !== VIEW) return false;
    const q = this.queue;
    while (this.queueAt < q.length) {
      const t = q[this.queueAt];
      if (!this.#loadable(t, now)) { this.queueAt++; continue; }
      if (!this.client.canRun(hostFor(t.sources[0]))) return false;
      this.queueAt++;
      this.#load(t, VIEW);
      return true;
    }
    return false;
  }

  /* A pruned branch's tiles are no longer in the tree; loading one would
   * strand its buffers where nothing draws or drops them. */
  #loadable(t, now) {
    return t.state === UNLOADED && t.available && t.retryAt <= now && this.tiles.get(t.key) === t;
  }

  /* Wanted no more: the latest selection did not ask for it, and either
   * two selections over STALE_MS went by without it, or the view has stood
   * still for STALE_MS since; nor did a column or a preload lately. */
  #stale(t) {
    if (!t) return false;
    const now = performance.now();
    if (t.wantedSel === this.frame || now - t.columnAt < COLUMN_LIFE_MS || now - t.preloadAt < PRELOAD_LIFE_MS) return false;
    return (this.frame - t.wantedSel >= STALE_SELECTIONS && this.selectedAt - t.wantedAt > STALE_MS) ||
      now - this.selectedAt > STALE_MS;
  }

  /* A selection wants this tile loaded. */
  #stamp(t) {
    t.wantedAt = this.now;
    t.wantedSel = this.frame;
  }

  /**
   * Asks for what a view from somewhere else would draw: where a flight will
   * arrive, in full detail. In the scheduler's preload class (see there),
   * wanted for half a minute; called again as the flight goes on and tiles
   * arrive, it gets further down. What the walk finds loaded counts as used
   * (lru.js), so the flight's own streaming does not drop it before the
   * arrival. Adds to `counts` { have, need }: the tiles that view would draw
   * that are here, and those still to come.
   */
  preload(view, counts = null) {
    if (!this.roots.length) return 0;
    const keep = this.view, keepFactor = this.errorFactor;
    this.view = view;
    this.errorFactor = this.#factor(view);
    const found = this.preScratch ??= [];
    const tally = this.preTally ??= { have: 0, need: 0 };
    found.length = 0;
    tally.have = tally.need = 0;
    for (const root of this.roots) this.#preVisit(root, found, tally);
    this.view = keep;
    this.errorFactor = keepFactor;
    if (counts) { counts.have += tally.have; counts.need += tally.need; }
    found.sort((a, b) => a.priority - b.priority);
    if (found.length > PRELOAD_KEPT) found.length = PRELOAD_KEPT;
    const now = performance.now();
    for (const t of found) t.preloadAt = now;
    this.preQueue = found.slice();
    this.preAt = 0;
    return found.length;
  }

  /* The preload walk: the tiles the selection would want from `this.view`,
   * without drawing anything; the loaded ones are touched, finer first. */
  #preVisit(t, found, tally) {
    const view = this.view;
    if (!view.sphereVisible(t.center, t.radius)) return;
    const d = this.#distance(t);
    if (d > view.horizon) return;
    if (t.state !== READY) {
      if (t.state === UNLOADED && t.available) { t.priority = d; found.push(t); }
      if (t.state !== MISSING) tally.need++;
      return;
    }
    const children = this.#refinement(t, d);
    if (children) for (let i = 0; i < 4; i++) { if (children[i].available) this.#preVisit(children[i], found, tally); }
    else tally.have++;
    this.lru.touch(t);
  }

  async #load(t, cls) {
    t.state = LOADING;
    this.inFlight++;
    let outcome = MISSING, failure = null;
    try {
      for (const source of t.sources) {
        const url = source.urlFor(t.z, t.x, t.y);
        let result;
        try {
          result = await this.client.run('terrain-tile', {
            url, rect: t.rect, skirt: skirtFor(t.z), accept: source.accept, ground: Boolean(this.wantsGround?.(t)),
          }, { item: t, cls, cost: 4, host: hostFor(source), timeout: 20000 });
        } catch (err) {
          // Called off: back in line whenever it is wanted again.
          if (isAbort(err)) { outcome = UNLOADED; failure = null; break; }
          // Worth another try later; meanwhile another service may have it.
          if (err.retry) { outcome = UNLOADED; failure = err; continue; }
          console.warn(`[terrain] ${t.z}/${t.x}/${t.y} from ${source.adapter.id}: ${err.message}`);
          continue;
        }
        if (result.acceptRejected && source.accept) {
          console.warn(`[terrain] ${source.adapter.id} refuses the extension request; loading tiles without it`);
          source.accept = null;
        }
        if (result.missing) continue;   // this source has no tile here: try the next
        if (result.available) source.recordAvailability(t.z, t.x, t.y, result.available);
        // Wanted no more by the time it came: not worth the memory.
        if (this.#stale(t)) {
          this.client.recycle(result.vertices, result.indices);
          outcome = UNLOADED; failure = null; break;
        }
        t.url = url;                      // the ground index fetches exactly this tile
        t.source = source;
        t.attempts = 0;
        // To the GPU during a frame's upload slice, not the moment it lands.
        if (this.uploads) await this.uploads.schedule(() => this.#upload(t, result));
        else this.#upload(t, result);
        outcome = READY;
        failure = null;
        break;
      }
    } finally {
      this.inFlight--;
      if (outcome === MISSING) {
        t.state = MISSING;
        this.missing.add(t.key);
        if (this.missing.size > MISSING_MEMORY) this.missing.delete(this.missing.values().next().value);
        if (t.isRoot) this.#promoteChildren(t);
      } else if (outcome === UNLOADED) {
        t.state = UNLOADED;
        if (failure) this.#retryLater(t, failure);
      }
      this.dirty = true;
    }
  }

  /* Spaced retries, then a rest (scheduler.js `retryIn`), so a service that
   * is down is not hammered. */
  #retryLater(t, err) {
    const { wait } = this.client.retryIn(t, err, `${t.z}/${t.x}/${t.y}`);
    t.retryAt = performance.now() + wait;
    // A still view makes no selections: ask for one when the wait is over.
    setTimeout(() => { this.dirty = true; }, wait + 1);
  }

  #upload(t, r) {
    const device = this.device;
    const label = `${t.z}/${t.x}/${t.y}`;
    t.vbuf = device.createBuffer({
      label: `tile-v-${label}`, size: r.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    t.ibuf = device.createBuffer({
      label: `tile-i-${label}`, size: Math.ceil(r.indices.byteLength / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(t.vbuf, 0, r.vertices);
    device.queue.writeBuffer(t.ibuf, 0, r.indices);
    // Copied by the queue at once: the buffers can go back to be filled again.
    this.client.recycle(r.vertices, r.indices);

    t.indexCount = r.indexCount;
    t.indexFormat = r.indexIsU32 ? 'uint32' : 'uint16';
    t.origin = r.origin;
    t.vertexCount = r.vertices.byteLength / VERTEX_STRIDE;
    t.serverNormals = r.serverNormals;
    t.minHeight = r.minHeight;
    t.maxHeight = r.maxHeight;
    t.tops = r.tops ?? null;
    // The tile's own bounding sphere, skirt included, replaces the estimate.
    t.center[0] = r.origin[0]; t.center[1] = r.origin[1]; t.center[2] = r.origin[2];
    t.radius = r.radius;
    t.bytes = r.vertices.byteLength + r.indices.byteLength;
    t.lastUsed = Math.max(t.lastUsed, this.frame);
    t.state = READY;
    this.bytes += t.bytes;
    this.readyCount++;
    // Newly arrived counts as just used, so it is not dropped this frame.
    if (!t.isRoot) this.lru.add(t);
    // Its ground index, made in the same decode, goes to physics.
    if (r.ground) this.onGround?.(t, r.ground);
  }

  #release(t) {
    this.lru.remove(t);
    t.vbuf?.destroy();
    t.ibuf?.destroy();
    t.vbuf = t.ibuf = null;
    this.bytes -= t.bytes;
    t.bytes = 0;
    this.readyCount--;
  }

  /**
   * Over budget: drop what went unused longest, finer before coarser, from
   * the head of the order and never past this selection's marker. At most a
   * frame's worth at a time; the rest follows on the next frames.
   *
   * If the view itself needs more than the budget, nothing unused is left
   * and dropping cannot help: lower the detail of the next selection instead,
   * which turns the finest tiles into unused ones. Rescanning every frame,
   * which is what used to happen here, only turned memory pressure into
   * frame time.
   */
  #evict(selected) {
    if (!this.evicting && this.bytes <= this.budget) return;
    const start = performance.now();
    const target = this.budget * 0.9;
    this.evicting = true;
    const deadline = start + DROP_MS;
    for (let n = 0; n < DROPS_PER_FRAME && this.bytes > target && (n === 0 || performance.now() < deadline); n++) {
      const t = this.lru.stalest;
      if (!t) break;
      this.#drop(t);
    }
    if (this.bytes <= target || !this.lru.stalest) this.evicting = false;
    if (selected && this.bytes > this.budget && !this.lru.stalest) {
      // Memory goes with the area loaded in full detail, the square of the
      // scale: aim straight for nine tenths of the budget, at least a step
      // and at most halving at once.
      const aim = Math.sqrt((this.budget * 0.9) / this.bytes);
      this.detailScale = Math.max(MIN_DETAIL, this.detailScale * Math.max(0.5, Math.min(COARSEN, aim)));
      this.pressureAt = performance.now();
      this.dirty = true;
    }
    this.timing.evict += performance.now() - start;
  }

  /* Detail lowered for memory comes back a step at a time once a third of
   * the budget has been free for a while. */
  #relax() {
    if (this.detailScale >= 1 || this.bytes > this.budget * 0.7) return;
    const now = performance.now();
    if (now - this.pressureAt < RELAX_AFTER_MS) return;
    this.detailScale = Math.min(1, this.detailScale * RELAX);
    this.pressureAt = now;
    this.dirty = true;
  }

  /* Drops one tile, and the branch it leaves empty. */
  #drop(t) {
    this.#release(t);
    t.state = UNLOADED;
    this.dropped++;
    for (let p = t.parent; p && this.#pruneChildren(p); p = p.parent) { /* upwards while emptied */ }
  }

  /* Forgets a tile's children when none of them holds anything, has
   * children of its own, was used lately or waits to be asked for again
   * (a tile made anew would forget the wait, and a service's Retry-After
   * with it), so exploring the whole country does not grow the tree without
   * bound. Known-missing tiles are remembered by key and come back as
   * missing if the branch is ever rebuilt. */
  #pruneChildren(p) {
    const c = p.children;
    if (!c) return false;
    const now = performance.now();
    for (let i = 0; i < 4; i++) {
      const k = c[i];
      if (k.children || k.state === READY || k.state === LOADING || this.frame - k.lastUsed < PRUNE_AFTER || k.retryAt > now) return false;
    }
    for (let i = 0; i < 4; i++) this.tiles.delete(c[i].key);
    p.children = null;
    return true;
  }

  /*
   * Branches that were split but never loaded (the view passed on before
   * their tiles were needed) are found by a sweep that visits a few hundred
   * nodes a frame, children before parents, one pass a second.
   */
  #sweep() {
    const stack = this.sweepStack, open = this.sweepOpen;
    const start = performance.now();
    if (!stack.length) {
      if (start < this.sweepAt) return;
      this.sweepAt = start + SWEEP_INTERVAL_MS;
      for (const r of this.roots) { stack.push(r); open.push(false); }
    }
    for (let n = 0; n < SWEEP_NODES && stack.length; n++) {
      const top = stack.length - 1, t = stack[top];
      const live = t.children !== null && this.tiles.get(t.key) === t;
      if (live && !open[top]) {
        open[top] = true;
        for (const c of t.children) if (c.children) { stack.push(c); open.push(false); }
        continue;
      }
      stack.pop();
      open.pop();
      if (live) this.#pruneChildren(t);
    }
    this.timing.maintain += performance.now() - start;
  }

  /**
   * Requests every tile from the coarsest down to the finest under a point
   * (or down to `deepest`), all at once, ahead of everything else. After a
   * jump across the country this turns ten sequential round trips into one
   * parallel batch. A new column replaces any still waiting, unless `join`:
   * then it is added to them, for when several points need ground at once
   * (around a walker). Returns how many tiles it asked for.
   */
  prefetchColumn(lon, lat, deepest = Infinity, { join = false } = {}) {
    if (!join) this.column.length = 0;
    let asked = 0;
    let t = this.#rootAt(lon, lat);
    const now = performance.now();
    while (t && t.available && t.z <= deepest) {
      t.columnAt = now;
      if (t.state === UNLOADED && (!join || this.column.indexOf(t) < 0)) { this.column.push(t); asked++; }
      if (t.z === deepest || !this.#servesBelow(t)) break;
      const children = t.children ?? this.#split(t);
      t = children[quarterOf(t, lon, lat)];
    }
    // Columns that have waited longest go first when too many pile up.
    if (this.column.length > COLUMN_KEPT) this.column.splice(0, this.column.length - COLUMN_KEPT);
    if (asked) this.dirty = true;
    return asked;
  }

  /**
   * Asks for the tiles under a point down to `deepest` at low priority (the
   * preload class: only with slots to spare), wanted as long as a preload:
   * the way ahead of a flight, whose bound (upperBound) tightens as they
   * arrive. At most AHEAD_KEPT wait, the oldest dropped first. Returns how
   * many it asked for.
   */
  prefetchAhead(lon, lat, deepest) {
    let t = this.#rootAt(lon, lat), asked = 0;
    const now = performance.now();
    while (t && t.available && t.z <= deepest) {
      if (t.state === UNLOADED) {
        t.preloadAt = now;
        if (this.ahead.indexOf(t) < 0) { this.ahead.push(t); asked++; }
      }
      if (t.z === deepest || !this.#servesBelow(t)) break;
      const children = t.children ?? this.#split(t);
      t = children[quarterOf(t, lon, lat)];
    }
    if (this.ahead.length > AHEAD_KEPT) this.ahead.splice(0, this.ahead.length - AHEAD_KEPT);
    if (asked) this.dirty = true;
    return asked;
  }

  #servesBelow(t) {
    for (let i = 0; i < t.sources.length; i++) if (t.sources[i].serves(t.z + 1)) return true;
    return false;
  }

  /**
   * Whether any service has a tile below this one: the availability the
   * services publish, less the tiles already known to be missing. Asks
   * without splitting anything, so no nodes are made. Unknown counts as yes,
   * which errs towards waiting for detail rather than trusting a stand-in.
   */
  finerExists(z, x, y) {
    const cz = z + 1;
    const w = 360 / (2 << cz), h = 180 / (1 << cz);
    for (let i = 0; i < 4; i++) {
      const cx = 2 * x + (i & 1), cy = 2 * y + (i >> 1);
      if (this.missing.has(tileKey(cz, cx, cy))) continue;
      const west = -180 + cx * w, south = -90 + cy * h;
      for (let s = 0; s < this.sourceList.length; s++) {
        const source = this.sourceList[s], r = source.adapter.rect;
        if (west > r.east || west + w < r.west || south > r.north || south + h < r.south) continue;
        if (source.isAvailable(cz, cx, cy)) return true;
      }
    }
    return false;
  }

  /** Physics may stand on this tile: see ACCURATE_LEVEL. */
  isAccurate(t) {
    return t.z >= ACCURATE_LEVEL || !this.finerExists(t.z, t.x, t.y);
  }

  /**
   * The level a selection draws at this distance from the eye, at the detail
   * of the last selection: the coarsest whose error fits.
   */
  levelFor(distance) {
    const z = Math.ceil(Math.log2((LEVEL_ZERO_ERROR * this.errorFactor) / Math.max(1, distance)));
    let finest = 0;
    for (let s = 0; s < this.sourceList.length; s++) finest = Math.max(finest, this.sourceList[s].maxLevel);
    return Math.max(0, Math.min(z, finest));
  }

  /* ---- questions from physics and the rest of the engine ------------------ */

  #rootAt(lon, lat) {
    for (const r of this.roots) {
      const b = r.rect;
      if (lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north) return r;
    }
    return null;
  }

  /** The tile drawn at a point in the last selection, or null. */
  leafAt(lon, lat) {
    let t = this.#rootAt(lon, lat);
    while (t) {
      const q = quarterOf(t, lon, lat);
      if (t.drawnFrame === this.frame && !(t.mask & (1 << q))) return t;
      if (!t.children) return null;
      t = t.children[q];
    }
    return null;
  }

  /** The finest loaded tile over a point, drawn or not, or null. */
  finestAt(lon, lat) {
    let t = this.#rootAt(lon, lat), best = null;
    while (t) {
      if (t.state === READY) best = t;
      if (!t.children) break;
      t = t.children[quarterOf(t, lon, lat)];
    }
    return best;
  }

  /** Whether any terrain service claims this point at all. */
  covers(lon, lat) {
    for (const source of this.sources.values()) if (source.adapter.covers(lon, lat)) return true;
    return false;
  }

  /**
   * The height the ground within `radius` metres of a point cannot be
   * above, from the finest tiles that have loaded there (a square around the
   * circle, to be safe): the highest of their grid cells the square
   * touches, plus TOPS_ERROR times their level's error. A quarter with no
   * finer tile is answered by its parent's cells. NaN where nothing
   * covering the square has loaded at all: unknown, which the asker must
   * treat as anything (engine/flight/obstacles.js).
   */
  upperBound(lon, lat, radius = 0) {
    return this.#highest(lon, lat, radius, TOPS_ERROR);
  }

  /**
   * How high the ground within `radius` metres of a point reaches, as best
   * known: the same cells with half a level's error instead of one and a
   * half. Not a bound (the ground can be higher): what a flight's pace and a
   * place's height are judged by. NaN where nothing has loaded.
   */
  estimate(lon, lat, radius = 0) {
    return this.#highest(lon, lat, radius, ESTIMATE_ERROR);
  }

  /**
   * The ground at a point as best known from the grids alone, into `out`
   * { height, level }: the finest tile that has loaded there, its cell over
   * the point plus half its error. False where nothing has.
   */
  estimateAt(lon, lat, out) {
    let t = this.#rootAt(lon, lat), best = null;
    while (t && t.tops) {
      best = t;
      if (!t.children) break;
      t = t.children[quarterOf(t, lon, lat)];
    }
    if (!best) return false;
    out.height = cellsTop(best, lon, lat, lon, lat, ESTIMATE_ERROR);
    out.level = best.z;
    return true;
  }

  #highest(lon, lat, radius, k) {
    const b = this.#box, dLat = (radius * 1.01) / 110500;
    const dLon = (radius * 1.01) / (111000 * Math.max(0.01, Math.cos(lat * (Math.PI / 180))));
    b.west = lon - dLon; b.east = lon + dLon; b.south = lat - dLat; b.north = lat + dLat;
    // Part of the square beyond every root: nothing is known there.
    if (!this.#rootAt(b.west, b.south) || !this.#rootAt(b.east, b.south) ||
        !this.#rootAt(b.west, b.north) || !this.#rootAt(b.east, b.north)) return NaN;
    let best = -Infinity;
    for (let i = 0; i < this.roots.length; i++) {
      const root = this.roots[i];
      if (!overlaps(root.rect, b)) continue;
      if (!root.tops) return NaN;
      const h = this.#boundIn(root, b, k);
      if (h > best) best = h;
    }
    return best;
  }

  #box = { west: 0, south: 0, east: 0, north: 0 };

  /* The bound over the part of the square on a tile that has loaded: its
   * children's where they have, its own cells where they have not. Tiles
   * four times smaller than the square are not gone into: their parent's
   * cells answer as well, and a wide question stays cheap. */
  #boundIn(t, b, k) {
    const fine = (t.rect.east - t.rect.west) * 4 < b.east - b.west;
    if (t.children && !fine) {
      let best = -Infinity;
      const r = t.rect, midLon = (r.west + r.east) / 2, midLat = (r.south + r.north) / 2;
      for (let i = 0; i < 4; i++) {
        const c = t.children[i];
        // The quarter's part of the square, by the parent's split.
        const w = i & 1 ? midLon : r.west, e = i & 1 ? r.east : midLon;
        const s = i & 2 ? midLat : r.south, n = i & 2 ? r.north : midLat;
        if (b.east < w || b.west > e || b.north < s || b.south > n) continue;
        const h = c.tops ? this.#boundIn(c, b, k)
          : cellsTop(t, Math.max(b.west, w), Math.max(b.south, s), Math.min(b.east, e), Math.min(b.north, n), k);
        if (h > best) best = h;
      }
      return best;
    }
    return cellsTop(t, b.west, b.south, b.east, b.north, k);
  }

  #refreshStats() {
    // Candidates beyond the kept few are all still to load.
    let queued = this.wantedCount - this.queue.length;
    for (let i = this.queueAt; i < this.queue.length; i++) if (this.queue[i].state === UNLOADED) queued++;
    for (const t of this.column) if (t.state === UNLOADED) queued++;
    const s = this.stats;
    s.drawn = this.visible.length;
    s.ready = this.readyCount;
    s.loading = this.inFlight;
    s.queued = queued;
    s.pending = this.inFlight + queued;
    s.bytes = this.bytes;
    s.minLevel = Number.isFinite(this.drawnMin) ? this.drawnMin : 0;
    s.maxLevel = Number.isFinite(this.drawnMax) ? this.drawnMax : 0;
    s.missing = this.missing.size;
    s.budget = this.budget;
    s.detail = this.detailScale;
    s.nodes = this.tiles.size;
    s.dropped = this.dropped;
  }

  destroy() {
    for (const t of this.tiles.values()) if (t.state === READY) this.#release(t);
    this.tiles.clear();
    this.roots = [];
    this.visible.length = 0;
  }
}
