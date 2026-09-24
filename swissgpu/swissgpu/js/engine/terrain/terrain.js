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
 * Requests go out nearest first, a bounded number at a time. A memory budget
 * drops the tiles that have gone unused longest, and the tree forgets the
 * empty branches they leave behind.
 */

import { tileRect, tileKey, tileAt } from './tiling.js';
import { TerrainSource } from './source.js';
import { VERTEX_STRIDE } from './format.js';
import { regionSphere } from '../bounds.js';
import { WGS84_A } from '../../core/math.js';

export const UNLOADED = 0, LOADING = 1, READY = 2, MISSING = 3;

/* Cesium's level-zero error for quantized-mesh terrain: a 65 x 65 heightmap
 * over one of the two level-zero tiles, a quarter of its sample spacing. About
 * 77 km at level 0, 0.6 m at level 17. */
const LEVEL_ZERO_ERROR = (WGS84_A * 2 * Math.PI * 0.25) / (65 * 2);
export const geometricError = (z) => LEVEL_ZERO_ERROR / 2 ** z;

/* Curtains hang five times the level's error, which covers the step between
 * neighbours up to two levels apart. The bounds keep coarse levels from
 * hanging kilometres of wall and fine ones from hanging almost none. */
const skirtFor = (z) => Math.min(2000, Math.max(2, 5 * geometricError(z)));

/* Children are numbered by quarter: bit 0 set for the east half, bit 1 for
 * the north half. With rows counted from the south, child i of (x, y) is
 * (2x + (i & 1), 2y + (i >> 1)). */
export const quarterOf = (t, lon, lat) =>
  (lon >= (t.rect.west + t.rect.east) / 2 ? 1 : 0) | (lat >= (t.rect.south + t.rect.north) / 2 ? 2 : 0);

/* A failed load (network, not "no such tile") is retried after this. */
const RETRY_MS = 5000;
/* Keys of tiles known not to exist, kept across pruning, oldest dropped first. */
const MISSING_MEMORY = 50000;

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

    // The parent's height range stands in until this tile's own header
    // arrives. It is always a superset, which keeps culling conservative.
    this.minHeight = parent ? parent.minHeight : -500;
    this.maxHeight = parent ? parent.maxHeight : 9000;
    this.center = new Float64Array(3);    // bounding sphere, absolute ECEF
    this.radius = regionSphere(this.rect, this.minHeight, this.maxHeight, this.center);

    this.lastUsed = 0;            // traversal that last touched this tile
    this.priority = 0;
    this.drawnFrame = -1;         // traversal that last drew it
    this.mask = 0;                // quarters covered by children when drawn
    this.final = false;           // drawn because it is detailed enough, not as a stand-in
    this.distance = 0;            // metres from the eye when last drawn

    this.vbuf = null;
    this.ibuf = null;
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

export class Terrain {
  /**
   * @param maxError  pixels of error a tile may show before it is split
   * @param budgetMB  vertex and index memory kept for tiles
   */
  constructor({ device, pool, registry, maxError = 2, budgetMB = 256 }) {
    this.device = device;
    this.pool = pool;
    this.registry = registry;
    this.maxError = maxError;
    this.budget = budgetMB * 1048576;

    this.sources = new Map();     // adapter id -> TerrainSource
    this.roots = [];
    this.tiles = new Map();       // key -> TerrainTile, every node of the tree
    this.missing = new Set();
    this.visible = [];            // drawn this traversal, roughly near to far
    this.wanted = [];             // not loaded yet and needed, sorted before use
    this.wantedAt = 0;
    this.column = [];             // tiles under a spawn point, loaded before anything else
    this.inFlight = 0;
    this.maxInFlight = Math.max(8, pool.size * 3);
    this.bytes = 0;
    this.readyCount = 0;

    this.frame = 0;
    this.dirty = true;
    this.view = null;
    this.viewVersion = -1;
    this.reach = 0;
    this.errorFactor = 1;
    this.stats = { drawn: 0, ready: 0, pending: 0, loading: 0, queued: 0, bytes: 0, minLevel: 0, maxLevel: 0, missing: 0 };
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
    this.#plantRoots();
    return [...this.sources.values()].map((s) => s.describe());
  }

  /** Detail and memory, from the settings. */
  configure({ maxError, budgetMB }) {
    if (maxError !== undefined && maxError > 0) this.maxError = maxError;
    if (budgetMB !== undefined && budgetMB > 0) this.budget = budgetMB * 1048576;
    this.dirty = true;
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
    for (const c of children) c.isRoot = true;
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
      if (this.bytes > this.budget) this.#evict();
    }
    this.#pump();
    this.#refreshStats();
  }

  #select(view) {
    this.frame++;
    this.view = view;
    this.errorFactor = view.pixelsPerRadian / this.maxError;

    this.visible.length = 0;
    this.wanted.length = 0;
    this.wantedAt = 0;
    this.reach = 0;
    this.drawnMin = Infinity;
    this.drawnMax = -Infinity;
    for (const root of this.roots) this.#visit(root);
    this.wanted.sort((a, b) => a.priority - b.priority);
    this.reach = Math.min(this.reach, view.horizon);
  }

  #visit(t) {
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
      return;
    }

    const children = this.#refinement(t, d);
    if (!children) { this.#draw(t, 0, true, d); return; }

    // Split only once every child in view that exists has arrived.
    let ready = true;
    for (let i = 0; i < 4; i++) {
      const c = children[i];
      if (!c.available) continue;
      c.lastUsed = this.frame;
      if (c.state === READY) continue;
      const inView = view.sphereVisible(c.center, c.radius) && this.#distance(c) <= view.horizon;
      if (inView) ready = false;
      if (c.state === UNLOADED) {
        const dc = this.#distance(c);
        this.#want(c, inView ? dc : 1e6 + dc * 4);
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
    const far = d + Math.hypot((r.east - r.west) * v.mPerDegLon, (r.north - r.south) * v.mPerDegLat);
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
    this.wanted.push(t);
  }

  /** Metres from the eye to the nearest point of a tile's rectangle and height range. */
  #distance(t) {
    return this.view.regionDistance(t.rect, t.minHeight, t.maxHeight);
  }

  /* ---- loading ------------------------------------------------------------ */

  #pump() {
    const now = performance.now();
    // A pruned branch's tiles are no longer in the tree; loading one would
    // strand its buffers where nothing draws or evicts them.
    const loadable = (t) => t.state === UNLOADED && t.available && t.retryAt <= now && this.tiles.get(t.key) === t;
    while (this.inFlight < this.maxInFlight && this.column.length) {
      const t = this.column.shift();
      if (loadable(t)) this.#load(t);
    }
    while (this.inFlight < this.maxInFlight && this.wantedAt < this.wanted.length) {
      const t = this.wanted[this.wantedAt++];
      if (loadable(t)) this.#load(t);
    }
  }

  async #load(t) {
    t.state = LOADING;
    this.inFlight++;
    let outcome = MISSING;
    try {
      for (const source of t.sources) {
        const url = source.urlFor(t.z, t.x, t.y);
        let result;
        try {
          result = await this.pool.run('terrain-tile',
            { url, rect: t.rect, skirt: skirtFor(t.z), accept: source.accept },
            { cost: 4, timeout: 20000 });
        } catch (err) {
          console.warn(`[terrain] ${t.z}/${t.x}/${t.y} from ${source.adapter.id}: ${err.message}`);
          outcome = UNLOADED;    // worth another try later
          continue;
        }
        if (result.acceptRejected && source.accept) {
          console.warn(`[terrain] ${source.adapter.id} refuses the extension request; loading tiles without it`);
          source.accept = null;
        }
        if (result.missing) continue;   // this source has no tile here: try the next
        if (result.available) source.recordAvailability(t.z, t.x, t.y, result.available);
        t.url = url;                      // the ground index fetches exactly this tile
        t.source = source;
        this.#upload(t, result);
        outcome = READY;
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
        t.retryAt = performance.now() + RETRY_MS;
      }
      this.dirty = true;
    }
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

    t.indexCount = r.indexCount;
    t.indexFormat = r.indexIsU32 ? 'uint32' : 'uint16';
    t.origin = r.origin;
    t.vertexCount = r.vertices.byteLength / VERTEX_STRIDE;
    t.serverNormals = r.serverNormals;
    t.minHeight = r.minHeight;
    t.maxHeight = r.maxHeight;
    // The tile's own bounding sphere, skirt included, replaces the estimate.
    t.center[0] = r.origin[0]; t.center[1] = r.origin[1]; t.center[2] = r.origin[2];
    t.radius = r.radius;
    t.bytes = r.vertices.byteLength + r.indices.byteLength;
    t.lastUsed = Math.max(t.lastUsed, this.frame);
    t.state = READY;
    this.bytes += t.bytes;
    this.readyCount++;
  }

  #release(t) {
    t.vbuf?.destroy();
    t.ibuf?.destroy();
    t.vbuf = t.ibuf = null;
    this.bytes -= t.bytes;
    t.bytes = 0;
    this.readyCount--;
  }

  /** Over budget: drop what has gone unused longest, finest first among equals. */
  #evict() {
    const target = this.budget * 0.9;
    const candidates = [];
    for (const t of this.tiles.values()) {
      if (t.state === READY && !t.isRoot && t.lastUsed < this.frame) candidates.push(t);
    }
    candidates.sort((a, b) => a.lastUsed - b.lastUsed || b.z - a.z);
    for (const t of candidates) {
      if (this.bytes <= target) break;
      this.#release(t);
      t.state = UNLOADED;
    }
    for (const root of this.roots) this.#prune(root);
  }

  /* Forgets branches that hold nothing, so exploring the whole country does
   * not grow the tree without bound. Known-missing tiles are remembered by
   * key and come back as missing if the branch is ever rebuilt. */
  #prune(t) {
    if (!t.children) return;
    let empty = true;
    for (const c of t.children) {
      this.#prune(c);
      if (c.children || c.state === READY || c.state === LOADING || c.lastUsed === this.frame) empty = false;
    }
    if (empty) {
      for (const c of t.children) this.tiles.delete(c.key);
      t.children = null;
    }
  }

  /**
   * Requests every tile from the coarsest down to the finest under a point,
   * all at once, ahead of everything else. After a jump across the country
   * this turns ten sequential round trips into one parallel batch.
   */
  prefetchColumn(lon, lat) {
    this.column.length = 0;
    let t = this.#rootAt(lon, lat);
    while (t && t.available) {
      if (t.state === UNLOADED) this.column.push(t);
      if (!t.sources.some((s) => s.serves(t.z + 1))) break;
      const children = t.children ?? this.#split(t);
      t = children[quarterOf(t, lon, lat)];
    }
    this.dirty = true;
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

  #refreshStats() {
    let queued = 0;
    for (let i = this.wantedAt; i < this.wanted.length; i++) if (this.wanted[i].state === UNLOADED) queued++;
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
  }

  destroy() {
    for (const t of this.tiles.values()) if (t.state === READY) this.#release(t);
    this.tiles.clear();
    this.roots = [];
    this.visible.length = 0;
  }
}
