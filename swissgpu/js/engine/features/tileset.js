/* tileset.js — one 3D Tiles tileset, streamed by screen-space error.
 *
 * A tileset is a tree the data provider built: every tile has a bounding
 * volume, a geometric error (how wrong the picture is if this tile is drawn
 * instead of its children) and optionally content. Some tiles' content is
 * another tileset, loaded when that part of the tree is first needed, which
 * is how a whole country fits in a handful of small files.
 *
 * Tileset files are read on a decode thread into compact indexes
 * (formats/tileset-index.js, kept between sessions in IndexedDB), never
 * parsed here. Tile objects are made from an index only when the walk first
 * reaches them, a frame's share at a time, and their content URLs only when
 * they are asked for; parts of the tree that hold nothing and have not been
 * walked for a while are let go again, and so are whole files.
 *
 * Walking it follows the same rules as the terrain quadtree and shares its
 * View (js/engine/view.js): only tiles in the frustum and before the horizon
 * are visited, a tile is refined while its error would cover more pixels on
 * screen than the detail setting allows, and requests are ranked nearest
 * first, a few dozen kept per selection (engine/topk.js). The two ways a
 * tileset can refine are both honoured:
 *   ADD      children add detail to their parent, which stays drawn;
 *   REPLACE  children replace it, once every child in view has arrived.
 *
 * Requests go out when the scheduler (core/scheduler.js) gives this layer a
 * turn. While the camera moves, as Cesium does since its 2019 streaming work:
 * tiles of an ADD tree outside a cone around the centre of the view wait
 * until the camera has been still for a moment (or a quarter of a second at
 * most, so flying still fills in the sides: Stage 5.6), and tiles the camera
 * crosses in less than a quarter of a second are not asked for at all. A
 * request for a tile no
 * selection wants any more is called off; a failure worth retrying is tried
 * again later, spaced out.
 *
 * Memory is a budget in least-recently-used order that is never scanned or
 * sorted (engine/lru.js): what went unused longest is dropped first, deeper
 * tiles before shallower ones, and when the view needs more than the budget
 * holds the next selection's detail is lowered a step rather than the whole
 * tree being searched again every frame. Housekeeping works from short lists
 * on a clock.
 *
 * Tile content is decoded on the decode threads (js/formats/tile-content.js)
 * into twelve-byte vertices in a local east-north-up frame per tile, and
 * cable cars into ropes and pylons in the same frame; this file only decides
 * what is wanted and keeps the GPU buffers.
 *
 * Physics touches the same tiles. Around the view's focus (the walker, or
 * the place a flight will land at, however far away) every tile is loaded
 * in full detail whether it is on screen or not, first in line, with a CPU
 * copy of its triangles and a collision grid (wasm/src/solid.c); `focusNodes`
 * lists the ones physics should use, which are exactly the ones that would
 * be drawn there. While physics touches the world at the camera, tiles
 * decoded near it get their copy in the same decode; a tile that reaches the
 * focus without one gets it from its own GPU buffers, read back and gridded
 * on a decode thread, not downloaded and decoded again. Copies far from the
 * camera and the focus are let go. They have their own allowance, apart from
 * the video memory budget.
 *
 * Flights ask how high anything in the layer near a point can be
 * (upperBound): walked down the tree as far as its files have been read,
 * without making tile objects, a loaded tile answers from its grid of
 * highest points (formats/tops.js) and anything else from its bounding
 * volume's top. Cable cars' ropes are kept on the CPU as well (a few
 * kilobytes a tile), for exact questions near the start and the end of a
 * flight (features/solid.js).
 */

import { LruList } from '../lru.js';
import { TopK } from '../topk.js';
import { mat4d, ecefToGeodetic, radiiAt, DEG } from '../../core/math.js';
import { PHYSICS, VIEW, PRELOAD, MAX_ATTEMPTS, retryDelay, hostOf } from '../../core/scheduler.js';
import { isAbort } from '../../core/rpc.js';
import { VOLUME, CONTENT, ADD } from '../../formats/tileset-index.js';
import { TOPS } from '../../formats/tops.js';

const UNLOADED = 0, LOADING = 1, READY = 2, FAILED = 3;
const IDENTITY = mat4d.identity();
/* No children (yet): one shared empty array, never written to. A plain
 * array like every `children`, so the walk's loops see one kind of array. */
const NONE = [];
const utf8 = new TextDecoder();
/* A tile no selection has wanted for this long, while selections went on,
 * is called off. */
const STALE_MS = 500;
const STALE_SELECTIONS = 2;
/* External tilesets nothing was loaded from, and parts of the tree with
 * nothing loaded, unvisited for this long and this many selections, are let
 * go again; looked for this often. */
const FORGET_MS = 30000;
const FORGET_FRAMES = 60;
const FORGET_CHECK_MS = 2000;
/* The latest selections' times, for how long ago a tile was walked through:
 * more than FORGET_MS holds at 240 selections a second. */
const SELECTION_RING = 8192;
/* Tile objects made from the index per frame: for this long, and at least
 * this many. */
const EXPAND_MS = 0.3;
const EXPAND_MIN = 16;
/* While physics touches the world at the camera, tiles decoded within this
 * many metres keep their triangles for collision; copies farther than the
 * second distance from the camera and outside the focus are let go, checked
 * this often. */
const SOLID_NEAR = 300;
const SOLID_DROP = 600;
const SOLID_CHECK_MS = 250;
/* Moving: tiles of an ADD tree farther off the centre of the view than
 * Cesium's foveated cone (foveatedConeSize 0.1: 1 - cos of the angle is a
 * tenth of 1 - cos of half a 60° view, 9.4°; here as its tangent) wait until
 * the camera has been still this long, or for DEFER_MAX_MS at most, so the
 * middle of the view loads first. Tiles the camera crosses in less than
 * CROSS_SECONDS are not asked for: only flying extremely fast.
 * Stage 5.6, his words: "in regular flying around (not the flyto), still
 * load buildings ecc, I notice they only load when I'm still or on the
 * ground. Obviously if I'm flying EXTREMELY fast, they should probably not
 * load." swissBUILDINGS3D's tiles are all about 200 m across (bounding
 * diameter 201–206 m for 90% of the 40,325 tiles of two of its files), so
 * the crossing rule (1 s before, a quarter now) only ever skipped them above
 * 200 m/s; what held them back was the cone: waiting up to 1 s each, flying
 * at 150 m/s 104 of the 108 tiles still to load were held back (tools/
 * bench-streaming.mjs), and Cesium's own rule (no loading outside the cone
 * until the camera stops) is exactly what he saw. A quarter of a second
 * now: 48 left to load, 38 held back, and a third more buildings drawn. */
const FOVEA_TAN = Math.tan(Math.acos(1 - 0.1 * (1 - Math.cos(Math.PI / 6))));
const STILL_MS = 200;
const MOVING_SPEED = 5;    // metres a second: faster than a run
const DEFER_MAX_MS = 250;
const CROSS_SECONDS = 0.25;
/* Preloading (a flight's arrival view): tiles kept per walk, and how long
 * they stay wanted without the view asking for them. */
const PRELOAD_KEPT = 96;
const PRELOAD_LIFE_MS = 30000;
/* Reach, as flags: on screen, and within the focus. */
const SEEN = 1, FOCUSED = 2;
/* Tiles in the focus are asked for this many times more urgently than
 * their distance alone would say: physics, or a landing, is waiting. */
const FOCUS_URGENCY = 1e-3;
/* The detail distance setting says how far out a tile with this geometric
 * error keeps splitting: about a building's finest level in swisstopo's sets,
 * so the setting reads as "full detail out to". */
const REFERENCE_ERROR = 5;
/* Candidates kept per selection; tiles dropped per frame at most. */
const WANTED_KEPT = 64;
const DROPS_PER_FRAME = 16;
const DROP_MS = 0.5;       // and for at most this long; at least one goes
/* Memory pressure, as for terrain (terrain/terrain.js). */
const COARSEN = 0.85;
const RELAX = 1.1;
const RELAX_AFTER_MS = 2000;
const MIN_DETAIL = 0.2;
const MB = 1048576;

/* Metres per degree of latitude, at least, anywhere; and of longitude at
 * the equator, at least. */
const M_PER_DEG_LAT = 110500;
const M_PER_DEG_LON = 111000;
const scratchGeo = { lon: 0, lat: 0, height: 0 };
const scratchRadii = { meridian: 0, primeVertical: 0 };
/* A tile known to hold nothing. */
const EMPTY = { empty: true };

/*
 * The highest of a loaded tile's grid cells (formats/tops.js) over a square
 * in degrees, in metres above the ellipsoid, or -Infinity where the square
 * holds none of its content. The square is taken into the tile's frame
 * flat, widened by `pad` for what that flattening misses, and `lift` adds
 * how far the earth falls away under the frame's level towards its edges.
 */
export function contentTop(c, q) {
  if (c.empty) return -Infinity;
  const qx0 = (q.west - c.lon) * c.kLon - c.pad, qx1 = (q.east - c.lon) * c.kLon + c.pad;
  const qy0 = (q.south - c.lat) * c.kLat - c.pad, qy1 = (q.north - c.lat) * c.kLat + c.pad;
  if (qx1 < c.x0 || qx0 > c.x1 || qy1 < c.y0 || qy0 > c.y1) return -Infinity;
  const sx = TOPS / (c.x1 - c.x0), sy = TOPS / (c.y1 - c.y0);
  const cell = (v, s) => { const k = Math.floor(v * s); return k < 0 ? 0 : k >= TOPS ? TOPS - 1 : k; };
  const i0 = cell(qx0 - c.x0, sx), i1 = cell(qx1 - c.x0, sx), j0 = cell(qy0 - c.y0, sy), j1 = cell(qy1 - c.y0, sy);
  const cells = c.cells;
  let best = -Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0, k = j * TOPS + i0; i <= i1; i++, k++) if (cells[k] > best) best = cells[k];
  }
  return best === -Infinity ? best : c.height + best + c.lift;
}

/**
 * What contentTop reads, for a tile decoded in `frame` ({ lon, lat, height },
 * the origin of its east-north-up frame) with this grid of highest points
 * (formats/tops.js), or the record of a tile that holds nothing.
 */
export function contentRecord(frame, tops) {
  if (!tops) return EMPTY;
  const { meridian, primeVertical } = radiiAt(frame.lat, scratchRadii);
  const [x0, y0, x1, y1] = tops.box;
  const far = Math.sqrt(Math.max(x0 * x0, x1 * x1) + Math.max(y0 * y0, y1 * y1));
  return {
    cells: tops.cells, x0, y0, x1, y1, lon: frame.lon, lat: frame.lat, height: frame.height,
    kLat: (meridian + frame.height) * DEG, kLon: (primeVertical + frame.height) * Math.cos(frame.lat * DEG) * DEG,
    pad: 1 + 0.002 * far, lift: (far * far) / (2 * 6.3e6) + 0.5,
  };
}

/* One tileset file's index (formats/tileset-index.js), with where its
 * relative URIs are relative to. */
class TileIndex {
  constructor(data, base) {
    Object.assign(this, data);
    this.base = base;
    // Tiles whose content is not there: tile objects made again later (a
    // part of the tree let go and walked into again) do not ask again.
    this.gone = new Set();
    // External tiles' own files, while loaded, by slot: the tree as far as
    // it is known, for walks without tile objects (Tileset.upperBound).
    this.subs = new Map();
    // Each tile's footprint (degrees) and top (metres), five numbers a
    // tile, worked out the first time they are asked for.
    this.boxes = null;
    // Tiles' grids of highest points, by slot (see contentTop), from when
    // they first loaded: kept when a tile is dropped for memory (what it
    // holds has not moved), and let go with the file.
    this.contents = new Map();
  }

  /** The absolute URL of a tile's content, or null. */
  urlOf(i) {
    const a = this.uriAt[i], b = this.uriAt[i + 1];
    return a === b ? null : new URL(utf8.decode(this.strings.subarray(a, b)), this.base).href;
  }

  /**
   * Tile i's footprint and top, into `out` { west, south, east, north, top }:
   * a region's own; around a box or sphere, the square in degrees that holds
   * its bounding sphere, and the sphere's top.
   */
  boxOf(i, out) {
    const b = this.boxes ??= new Float64Array(this.tiles * 5).fill(NaN), o = i * 5;
    if (Number.isNaN(b[o])) {
      if ((this.kind[i] & 3) === VOLUME.REGION) {
        const v = this.volumes, at = this.volumeAt[i];
        b[o] = v[at]; b[o + 1] = v[at + 1]; b[o + 2] = v[at + 2]; b[o + 3] = v[at + 3]; b[o + 4] = v[at + 5];
      } else {
        const r = this.sphere[i * 4 + 3];
        if (!(r < 1e6)) {
          b[o] = -180; b[o + 1] = -90; b[o + 2] = 180; b[o + 3] = 90; b[o + 4] = Infinity;
        } else {
          const g = ecefToGeodetic(this.sphere.subarray(i * 4, i * 4 + 3), scratchGeo);
          const dLat = r / M_PER_DEG_LAT, edge = Math.min(89, Math.abs(g.lat) + dLat);
          const dLon = r / (M_PER_DEG_LON * Math.max(0.01, Math.cos(edge * DEG)));
          b[o] = g.lon - dLon; b[o + 1] = g.lat - dLat; b[o + 2] = g.lon + dLon; b[o + 3] = g.lat + dLat;
          b[o + 4] = g.height + r;
        }
      }
    }
    out.west = b[o]; out.south = b[o + 1]; out.east = b[o + 2]; out.north = b[o + 3]; out.top = b[o + 4];
    return out;
  }
}

class TileNode {
  constructor(index, slot, parent) {
    // What every walk reads and writes comes first and together: V8 lays the
    // fields out in the order they are first assigned, so a visit touches as
    // few cache lines of the object as it can.
    this.lastUsed = 0;        // the latest selection that walked through it
    // Its place in its file's index, which holds its bounding volume: no
    // object of its own for that, and siblings' numbers lie side by side.
    this.index = index;
    this.slot = slot;
    const k = index.kind[slot];
    this.content = (k >> 2) & 3;          // CONTENT.NONE, TILE or TILESET
    this.external = this.content === CONTENT.TILESET;
    this.state = !this.content ? READY : index.gone.has(slot) ? FAILED : UNLOADED;
    this.geometricError = index.error[slot];
    this.refine = (k & ADD) ? 'ADD' : 'REPLACE';
    this.children = null;     // made from the index when first walked into
    this.gpu = null;          // { vbuf, ibuf, indexCount, indexFormat, bytes, ... } once loaded
    this.distance = 0;        // from the eye, when last drawn or measured
    this.wantedSel = 0;       // the latest selection that wanted it loaded
    this.wantedAt = 0;        // and when that was
    this.wantedFrame = -1;
    this.priority = 0;
    this.heapIndex = -1;      // place among a selection's kept candidates (topk.js)
    this.lruPrev = null;      // links in the memory budget's order (lru.js)
    this.lruNext = null;
    this.physicsFrame = -1;   // selection that last wanted it for the focus
    this.focusFrame = -1;     // selection that last handed it to physics
    this.deferredAt = -1;     // when it was first held back for being off-centre

    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
    // The external tile this one came from, if any: whoever forgets that
    // file needs to know whether anything under it is still in use.
    this.owner = parent ? (parent.external ? parent : parent.owner) : null;
    const t = index.transformAt[slot];
    this.transform = t < 0 ? IDENTITY : index.transforms.subarray(t * 16, t * 16 + 16);
    this.href = null;         // content URL, worked out when first asked for
    this.attempts = 0;
    this.retryAt = 0;
    this.preloadAt = -Infinity;   // when a preload last asked for it
    this.decks = null;        // a bridge layer's deck tops (formats/decks.js) and where they are
    this.solid = null;        // CPU triangles and collision grid, near the camera
    this.solidWanted = false; // a copy for collision has been asked for
    this.solidFailed = false; // and could not be made: not asked for again
    this.frame = null;        // where decoded positions are expressed, once computed
    this.resident = 0;        // content at or below it loaded or loading
    this.sub = null;          // on an external tile: its file's index, once loaded
  }

  /** Has something to draw, or nothing to wait for. */
  get settled() { return !this.content || this.state === READY || this.state === FAILED; }

  /** The content's absolute URL, or null. */
  get url() { return this.content ? (this.href ??= this.index.urlOf(this.slot)) : null; }

  /** How many children it has, made or not. */
  get childCount() { return this.external ? (this.sub ? 1 : 0) : this.index.count[this.slot]; }
}

/* Farthest first, for letting collision copies go. */
const byDistanceDescending = (a, b) => b.distance - a.distance;

/* A request's priority: its distance, much smaller in the focus. */
const urgency = (d, reach) => ((reach & FOCUSED) ? d * FOCUS_URGENCY : d);

export class Tileset {
  /**
   * @param spec      the adapter's feature entry: { id, tileset, attributes, ... }
   * @param features  where each building's record goes (feature-pool.js), or null
   * @param maxError  pixels of error a tile may show before it is refined
   * @param budgetMB  video memory kept for this layer's tiles; collision
   *                  copies get half as much again, separately
   */
  constructor({ device, scheduler, spec, features = null, uploads = null, maxError = 10, budgetMB = 256 }) {
    this.device = device;
    this.scheduler = scheduler;
    this.client = scheduler.client(spec.id, {
      weight: Math.max(1, Math.round(2 * (spec.memoryShare ?? 1))),
      pick: (cls) => this.#pick(cls),
      stale: (node) => this.#stale(node),
    });
    this.features = features;
    this.uploads = uploads;       // shared per-frame upload slice (engine/uploads.js)
    this.spec = spec;
    this.host = hostOf(spec.tileset);
    this.maxError = maxError;
    this.budget = budgetMB * MB;
    this.solidBudget = Math.max(32 * MB, this.budget / 2);
    this.enabled = true;
    this.paused = false;          // no new requests (diagnostics)

    this.root = null;
    this.version = null;          // the release, for caching its files' indexes
    this.upAxis = 'Y';
    this.visible = [];
    this.focusNodes = [];     // what physics stands on and bumps into, around the focus
    this.focusPending = 0;    // tiles in the focus still on their way
    this.solidQueue = [];     // tiles in the focus waiting for a collision copy
    this.solidNodes = new Set();   // tiles holding a collision copy
    this.cableNodes = new Set();   // tiles holding cable cars (features/solid.js asks)
    this.deckNodes = new Set();    // tiles holding deck tops (features/decks.js asks)
    this.deckChanges = [];         // where decks came or went since features/decks.js last looked: [w, s, e, n]
    this.solidBytes = 0;
    this.externals = new Set();    // external tiles whose file is loaded
    this.opened = new Set();       // tiles whose children have been made
    this.wanted = new TopK(WANTED_KEPT);
    this.wantedCount = 0;
    this.queue = [];
    this.queueAt = 0;
    this.preQueue = [];       // what a view from elsewhere would draw (see preload)
    this.preAt = 0;
    this.inFlight = 0;
    this.bytes = 0;
    this.frame = 0;
    this.now = 0;             // performance.now() at the latest selection
    this.selectedAt = 0;
    this.selectionTimes = new Float64Array(SELECTION_RING);
    this.dirty = true;
    this.viewVersion = -1;
    this.errorFactor = 1;
    this.view = null;
    this.status = 'loading';
    this.expandUntil = 0;
    this.expanded = 0;        // tile objects made this selection
    this.nodes = 0;           // tile objects in existence
    // Camera motion for deferring requests: metres a second, eased, and
    // when it last moved.
    this.motion = { lon: NaN, lat: NaN, height: NaN, at: 0, speed: 0, movedAt: -Infinity };

    this.lru = new LruList();
    this.detailScale = 1;
    this.pressureAt = 0;
    this.evicting = false;
    this.dropped = 0;
    this.solidCheckAt = 0;
    this.forgetCheckAt = 0;
    // Milliseconds spent this frame on dropping tiles and on housekeeping;
    // the render thread charges them to their own profiler sections.
    this.timing = { evict: 0, maintain: 0 };

    this.stats = { drawn: 0, ready: 0, pending: 0, bytes: 0, triangles: 0, failed: 0,
      solidBytes: 0, focusTiles: 0, focusPending: 0,
      budget: this.budget, solidBudget: this.solidBudget, detail: 1, dropped: 0, files: 0,
      filesCached: 0, filesFetched: 0, nodes: 0, deferred: 0, skipped: 0, readbacks: 0,
      encodings: { plain: 0, quantized: 0, meshopt: 0, draco: 0 } };
    this.readyCount = 0;
    this.failedCount = 0;
    this.drawnTriangles = 0;
    this.deferredCount = 0;
    this.skippedCount = 0;
  }

  /** Reads the root tileset (on a decode thread). Resolves to a line for the console, or throws. */
  async load() {
    let index;
    for (let attempt = 1; ; attempt++) {
      try {
        index = await this.client.run('tileset-index', { url: this.spec.tileset },
          { cls: VIEW, cost: 6, host: this.host, timeout: 60000 });
        break;
      } catch (err) {
        if (!err.retry || attempt >= MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, retryDelay(attempt, err.retryAfter)));
      }
    }
    if (index.missing) throw new Error(`${this.spec.tileset} is not there`);
    this.upAxis = String(index.asset?.gltfUpAxis ?? 'Y').toUpperCase();
    if (index.extensionsRequired?.length) {
      console.warn(`[${this.spec.id}] tileset requires ${index.extensionsRequired.join(', ')}; drawing what can be read`);
    }
    this.version = index.validator ?? null;
    this.root = this.#node(new TileIndex(index, this.spec.tileset), 0, null);
    this.status = 'ready';
    this.dirty = true;
    return `${this.spec.id}: 3D Tiles ${index.asset?.version ?? '?'}, root error ${index.error[0]} m, ${index.tiles} tiles in the root file`;
  }

  /**
   * From the settings. `detailDistance` (metres) replaces the pixel budget
   * `maxError` when given; `maxDistance` (metres) is how far out the layer
   * is drawn at all.
   */
  configure({ maxError, budgetMB, enabled, detailDistance, maxDistance }) {
    if (maxError !== undefined && maxError > 0) this.maxError = maxError;
    if (budgetMB !== undefined && budgetMB > 0) {
      this.budget = budgetMB * MB;
      this.solidBudget = Math.max(32 * MB, this.budget / 2);
    }
    if (enabled !== undefined) {
      this.enabled = Boolean(enabled);
      if (!this.enabled) this.client.cancelAll();
    }
    if (detailDistance !== undefined) this.detailDistance = detailDistance > 0 ? detailDistance : null;
    if (maxDistance !== undefined) this.maxDistance = maxDistance > 0 ? maxDistance : Infinity;
    // New settings start from full detail; pressure, if any, shows again.
    this.detailScale = 1;
    this.dirty = true;
  }

  /** Stops sending requests (for diagnosing), or resumes. */
  pause(on) { this.paused = Boolean(on); }

  /**
   * The height nothing of this layer within `radius` metres of a point
   * reaches above (a square around the circle, to be safe), from the tops of
   * the bounding volumes, as deep as the tree's files are loaded:
   * -Infinity where the layer has nothing (or is switched off, or failed to
   * load: nothing is drawn), NaN while its root file has not loaded
   * (unknown: engine/flight/obstacles.js).
   */
  upperBound(lon, lat, radius = 0, cap = Infinity) {
    if (!this.enabled || this.status === 'failed') return -Infinity;
    if (!this.root) return NaN;
    return this.#topIn(this.root.index, this.root.slot, this.#square(lon, lat, radius), cap, false);
  }

  /**
   * The same question, answered from loaded content only (nothing not loaded
   * counts, -Infinity where nothing is): what is certainly there, which a
   * flight under way compares with what it planned for (engine/flight/).
   */
  knownTop(lon, lat, radius = 0) {
    if (!this.enabled || !this.root) return -Infinity;
    return this.#topIn(this.root.index, this.root.slot, this.#square(lon, lat, radius), Infinity, true);
  }

  #square(lon, lat, radius) {
    const q = this.#query, dLat = (radius * 1.01) / M_PER_DEG_LAT;
    const dLon = (radius * 1.01) / (M_PER_DEG_LON * Math.max(0.01, Math.cos(lat * DEG)));
    q.west = lon - dLon; q.east = lon + dLon; q.south = lat - dLat; q.north = lat + dLat;
    return q;
  }

  #query = { west: 0, south: 0, east: 0, north: 0 };
  #box = { west: 0, south: 0, east: 0, north: 0, top: 0 };

  /*
   * The highest anything under tile i of an index reaches over the square
   * q. A tile's volume holds everything under it, so its top is the answer
   * at most, and children are looked at until one reaches it. A tile's own
   * content counts where it stays drawn under its children (ADD) or has
   * none; a replacing tile's children show the same things. Content that
   * has not loaded, and files not read yet, could be anything up to the
   * volume's top, and nothing built stands higher above the ground than
   * `cap` (the asker's ground plus the tallest building there is). A tile
   * much smaller than the square answers with its volume's top: a wide
   * question stays cheap. With `known`, only loaded content counts.
   */
  #topIn(index, i, q, cap, known) {
    const box = index.boxOf(i, this.#box);
    if (q.east < box.west || q.west > box.east || q.north < box.south || q.south > box.north) return -Infinity;
    const top = box.top, width = box.east - box.west;
    const kind = index.kind[i], content = (kind >> 2) & 3, n = index.count[i];
    if (content === CONTENT.TILESET) {
      const sub = index.subs.get(i);
      return sub ? this.#topIn(sub, 0, q, cap, known) : known ? -Infinity : Math.min(top, cap);
    }
    let own = -Infinity;
    if (content === CONTENT.TILE && (!n || (kind & ADD))) {
      const c = index.contents.get(i);
      own = c ? contentTop(c, q) : known ? -Infinity : Math.min(top, cap);
    }
    if (!n) return own;
    if (!known && width * 4 < q.east - q.west) return top;
    let best = own;
    for (let k = 0, first = index.first[i]; k < n && best < top; k++) {
      const h = this.#topIn(index, first + k, q, cap, known);
      if (h > best) best = h;
    }
    return best;
  }

  /* A tile's content has arrived: its grid of highest points (or that it
   * holds nothing) goes into its file's index, for upperBound. */
  #noteContent(node, tops) {
    node.index.contents.set(node.slot, contentRecord(this.#frameOf(node), tops));
  }

  /* ---- per frame ---------------------------------------------------------- */

  update(view) {
    if (!this.root) return;
    if (!this.enabled) {
      if (this.visible.length) { this.visible.length = 0; this.queue.length = 0; this.queueAt = 0; }
      this.focusNodes.length = 0;
      this.focusPending = 0;
      this.#refreshStats();
      return;
    }
    this.#track(view.camera);
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
    this.#maintain();
    this.#refreshStats();
  }

  /* The camera's speed and when it last moved, for deferring. */
  #track(camera) {
    if (!camera) return;
    const m = this.motion, now = performance.now();
    if (Number.isFinite(m.lon) && now > m.at) {
      const v = this.view ?? { mPerDegLon: 77000, mPerDegLat: 111000 };
      const e = (camera.lon - m.lon) * v.mPerDegLon, n = (camera.lat - m.lat) * v.mPerDegLat, u = camera.height - m.height;
      const metres = Math.sqrt(e * e + n * n + u * u);
      const dt = now - m.at, speed = (metres * 1000) / dt;
      // A jump (a placement, a pick) is not a speed; a slow walk is standing.
      m.speed = speed > 100000 ? 0 : m.speed + (speed - m.speed) * Math.min(1, dt / 200);
      if (speed > MOVING_SPEED) m.movedAt = now;
    }
    m.lon = camera.lon; m.lat = camera.lat; m.height = camera.height;
    m.at = now;
  }

  #select(view) {
    this.frame++;
    this.view = view;
    this.now = this.selectedAt = performance.now();
    this.selectionTimes[this.frame % SELECTION_RING] = this.now;
    this.expandUntil = this.now + EXPAND_MS;
    this.expanded = 0;
    // Everything loaded counts as unused until this selection touches it.
    this.lru.mark();
    const factor = this.detailDistance ? this.detailDistance / REFERENCE_ERROR
      : view.pixelsPerRadian / this.maxError;
    this.errorFactor = factor * this.detailScale;
    this.reachLimit = Math.min(view.horizon, this.maxDistance ?? Infinity);
    // Moving: what to hold back (see the top of the file).
    const m = this.motion;
    this.moving = this.now - m.movedAt < STILL_MS;
    this.crossing = this.moving ? m.speed * CROSS_SECONDS : 0;
    this.visible.length = 0;
    this.focusNodes.length = 0;
    this.focusPending = 0;
    this.wantedCount = 0;
    this.deferredCount = 0;
    this.skippedCount = 0;
    this.drawnTriangles = 0;
    this.#visit(this.root);
    this.wanted.drainSorted(this.queue);
    // Tiles physics waits for first, in their own order.
    this.#partition(this.queue);
    this.queueAt = 0;
  }

  /* Stable partition: tiles wanted for the focus before the rest. */
  #partition(q) {
    let w = 0;
    const rest = this.restScratch ??= [];
    rest.length = 0;
    for (let i = 0; i < q.length; i++) {
      if (q[i].physicsFrame === this.frame) q[w++] = q[i];
      else rest.push(q[i]);
    }
    for (let i = 0; i < rest.length; i++) q[w + i] = rest[i];
  }

  /* Visits a tile, then marks it used: after its children, so that among
   * tiles last used in the same selection the deeper ones are dropped first. */
  #visit(node) {
    this.#visitNode(node);
    this.lru.touch(node);
  }

  /* A tile the walk looked at without visiting still counts as used. */
  #use(node) {
    node.lastUsed = this.frame;
    this.lru.touch(node);
  }

  /* A tile's children, made from the index the first time they are needed,
   * within this selection's share of time; none yet when that is spent (the
   * next selection, asked for here, carries on). */
  #kids(node) {
    if (node.children) return node.children;
    const n = node.childCount;
    if (!n) return NONE;
    if (this.expanded >= EXPAND_MIN && performance.now() > this.expandUntil) {
      if (!this.preloading) this.dirty = true;
      return NONE;
    }
    const kids = new Array(n);
    if (node.external) {
      kids[0] = this.#node(node.sub, 0, node);
    } else {
      const first = node.index.first[node.slot];
      for (let k = 0; k < n; k++) kids[k] = this.#node(node.index, first + k, node);
    }
    this.expanded += n;
    this.opened.add(node);
    return (node.children = kids);
  }

  #node(index, slot, parent) {
    this.nodes++;
    return new TileNode(index, slot, parent);
  }

  #visitNode(node) {
    // A part of the tree the walk still passes through stays, on screen or
    // not: turning round should not mean reading it again (see #idle).
    node.lastUsed = this.frame;
    const d = this.#distance(node);
    const reach = this.#reach(node, d);
    if (!reach) return;

    // Content that is itself a tileset has nothing of its own to draw: its
    // root is the real child. It is opened whenever this part of the tree is
    // reached, whatever its own error, the way Cesium treats it; the parent
    // that led here already decided the detail is wanted.
    if (node.external) {
      if (node.state !== READY) {
        this.#request(node, urgency(d, reach), reach);
        if (reach & FOCUSED) this.focusPending++;
        return;
      }
      this.#visitAll(this.#kids(node));
      return;
    }

    // In the focus, full detail however far away the camera is.
    const refine = node.geometricError * this.errorFactor > ((reach & FOCUSED) ? 0 : d);
    if (!refine || !node.childCount) { this.#show(node, d, reach); return; }

    if (node.refine === 'ADD') {
      this.#show(node, d, reach);
      this.#visitAll(this.#kids(node));
      return;
    }

    // REPLACE: children take over once every one in reach can stand in.
    const kids = this.#kids(node);
    let ready = kids.length > 0;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      this.#use(c);
      const dc = this.#distance(c);
      const rc = this.#reach(c, dc), inReach = rc !== 0;
      if (!c.settled) this.#request(c, inReach ? urgency(dc, rc) : 1e6 + dc * 4, rc);
      if (inReach && !this.#canStandIn(c, 0)) ready = false;
    }
    if (!ready && node.content && node.state === READY) { this.#show(node, d, reach); return; }
    this.#visitAll(kids);
  }

  /* Indexed, not for…of: the walk runs a thousand times a frame and an
   * iterator that is not optimised away allocates on every step. */
  #visitAll(kids) {
    for (let i = 0; i < kids.length; i++) this.#visit(kids[i]);
  }

  /* On screen (in the frustum and before the horizon), in the focus, both or
   * neither. */
  #reach(node, d) {
    const view = this.view, sphere = node.index.sphere, at = node.slot * 4;
    let r = 0;
    if (d <= this.reachLimit && view.sphereVisible(sphere, sphere[at + 3], at)) r |= SEEN;
    if (view.focus && this.#focusDistance(node) <= view.focus.radius) r |= FOCUSED;
    return r;
  }

  /* Whether a tile can take its parent's place yet: its own content has
   * arrived, or it has none (or is a tileset) and its children in view can
   * stand in for it in turn. Looks a few levels down at most; empty tiles are
   * rarely stacked deeper than that. What it finds missing on the way is
   * requested, so waiting always makes progress. */
  #canStandIn(node, depth) {
    if (node.content === CONTENT.TILE) return node.settled;
    if (node.external && node.state !== READY) return node.state === FAILED;
    if (depth >= 3) return true;
    const kids = this.#kids(node);
    if (node.childCount && !kids.length) return false;     // not made yet
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      this.#use(c);
      const dc = this.#distance(c), rc = this.#reach(c, dc);
      if (!rc) continue;
      if (!c.settled) this.#request(c, urgency(dc, rc), rc);
      if (!this.#canStandIn(c, depth + 1)) return false;
    }
    return true;
  }

  /**
   * Draws a tile's content if it is here and on screen, hands it to physics
   * if it is in the focus, and asks for whatever is missing.
   */
  #show(node, d, reach) {
    if (node.content !== CONTENT.TILE) return;
    const focused = (reach & FOCUSED) !== 0;
    this.#stamp(node);
    if (node.state === READY) {
      if (node.gpu) {
        node.distance = d;
        if (reach & SEEN) {
          this.visible.push(node);
          this.drawnTriangles += node.gpu.indexCount / 3;
        }
        if (focused) {
          if (node.solid) { node.focusFrame = this.frame; this.focusNodes.push(node); }
          else if (!node.solidFailed) { this.#wantSolid(node); this.focusPending++; }
        }
      }
      return;
    }
    if (focused && node.state !== FAILED) this.focusPending++;
    this.#request(node, urgency(d, reach), reach);
  }

  /* Whether a tile is in the view's focus. */
  #inFocus(node) {
    const f = this.view?.focus;
    return Boolean(f) && this.#focusDistance(node) <= f.radius;
  }

  /* A tile in the focus without a collision copy: read back from its GPU
   * buffers (see #loadSolid). */
  #wantSolid(node) {
    if (node.solidWanted) return;
    node.solidWanted = true;
    this.solidQueue.push(node);
  }

  #request(node, priority, reach = SEEN) {
    if (node.state === LOADING) { this.#stamp(node); return; }
    if (node.state !== UNLOADED) return;
    const physics = (reach & FOCUSED) !== 0;
    if (!physics && !node.external && this.#holdBack(node, priority)) return;
    this.#stamp(node);
    if (physics) node.physicsFrame = this.frame;
    // Asked for twice in one walk: keep the more urgent reason.
    if (node.wantedFrame === this.frame) {
      if (priority < node.priority) { node.priority = priority; this.wanted.offer(node); }
      return;
    }
    node.wantedFrame = this.frame;
    node.priority = priority;
    this.wantedCount++;
    this.wanted.offer(node);
  }

  /*
   * While the camera moves (see the top of the file): a tile it crosses in
   * under CROSS_SECONDS is not worth asking for, and a tile of an ADD tree
   * off the centre of the view waits for the camera to stop, or
   * DEFER_MAX_MS at most. Replacing tiles never wait: their parents would
   * stay coarse.
   */
  #holdBack(node, distance) {
    if (!this.moving) { node.deferredAt = -1; return false; }
    const sphere = node.index.sphere, at = node.slot * 4, radius = sphere[at + 3];
    if (radius * 2 < this.crossing) {
      this.skippedCount++;
      this.#comeBack();
      return true;
    }
    if (node.parent?.refine !== 'ADD' || !(distance > radius)) return false;
    // Angle off the line of sight, by its tangent.
    const view = this.view, p = view.camera.position, f = view.camera.forward;
    const dx = sphere[at] - p[0], dy = sphere[at + 1] - p[1], dz = sphere[at + 2] - p[2];
    const along = dx * f[0] + dy * f[1] + dz * f[2];
    const ax = dx - along * f[0], ay = dy - along * f[1], az = dz - along * f[2];
    const across = Math.sqrt(ax * ax + ay * ay + az * az) - radius;
    if (along > 0 && across <= along * FOVEA_TAN) { node.deferredAt = -1; return false; }
    if (node.deferredAt < 0) node.deferredAt = this.now;
    if (this.now - node.deferredAt >= DEFER_MAX_MS) return false;
    this.deferredCount++;
    this.#comeBack();
    return true;
  }

  /* Something was held back: look again once the camera may have stopped,
   * since a still camera makes no selections of its own. */
  #comeBack() {
    if (!this.deferTimer) this.deferTimer = setTimeout(() => { this.deferTimer = 0; this.dirty = true; }, STILL_MS);
  }

  /* Metres from the eye to a tile's bounding volume, read from the index
   * (formats/tileset-index.js): a region as west, south, east, north in
   * degrees and its heights; a box as centre and half-axes; a sphere. */
  #distance(node) {
    const ix = node.index, s = node.slot, view = this.view, kind = ix.kind[s] & 3;
    if (kind === VOLUME.REGION) {
      const v = ix.volumes, o = ix.volumeAt[s];
      return view.regionDistance(v[o], v[o + 1], v[o + 2], v[o + 3], v[o + 4], v[o + 5]);
    }
    if (kind === VOLUME.BOX) return view.boxDistance(ix.volumes, ix.volumeAt[s]);
    if (kind === VOLUME.SPHERE) return view.sphereDistance(ix.sphere, ix.sphere[s * 4 + 3], s * 4);
    return 0;
  }

  /* Horizontal metres from the focus's axis to a tile's volume. */
  #focusDistance(node) {
    const ix = node.index, s = node.slot, view = this.view;
    if ((ix.kind[s] & 3) === VOLUME.REGION) {
      const v = ix.volumes, o = ix.volumeAt[s];
      return view.focusRegionDistance(v[o], v[o + 1], v[o + 2], v[o + 3]);
    }
    return view.focusSphereDistance(ix.sphere, ix.sphere[s * 4 + 3], s * 4);
  }

  /**
   * Asks for what a view from somewhere else would draw: where a flight will
   * arrive. Requests go out in the scheduler's preload class (see there) and
   * stay wanted for half a minute. The walk takes the nearest tiles, from
   * the tree as far as it is made; called again as the flight goes on, it
   * gets further. What it finds loaded counts as used (lru.js), so the
   * flight's own streaming does not drop it before the arrival. Adds to
   * `counts` { have, need }: the tiles that view would draw that are here,
   * and those still to come (a part of the tree not read yet counts as one).
   */
  preload(view, counts = null) {
    if (!this.root || !this.enabled) return 0;
    const keep = this.view, keepLimit = this.reachLimit;
    this.view = view;
    this.reachLimit = Math.min(view.horizon, this.maxDistance ?? Infinity);
    // A share of time of its own for making tile objects.
    this.expandUntil = performance.now() + EXPAND_MS;
    this.expanded = 0;
    this.preloading = true;
    const found = this.preScratch ??= [];
    const tally = this.preTally ??= { have: 0, need: 0 };
    found.length = 0;
    tally.have = tally.need = 0;
    this.#preVisit(this.root, found, tally);
    this.preloading = false;
    this.view = keep;
    this.reachLimit = keepLimit;
    if (counts) { counts.have += tally.have; counts.need += tally.need; }
    found.sort((a, b) => a.priority - b.priority);
    if (found.length > PRELOAD_KEPT) found.length = PRELOAD_KEPT;
    const now = performance.now();
    for (const node of found) node.preloadAt = now;
    this.preQueue = found.slice();
    this.preAt = 0;
    return found.length;
  }

  /* The preload walk: what the selection would ask for from `this.view`,
   * without drawing or standing in; the loaded tiles are touched, deeper
   * first. */
  #preVisit(node, found, tally) {
    const d = this.#distance(node), sphere = node.index.sphere, at = node.slot * 4;
    if (d > this.reachLimit || !this.view.sphereVisible(sphere, sphere[at + 3], at)) return;
    const want = () => {
      if (node.state === READY) { tally.have++; return; }
      if (node.state === FAILED) return;
      tally.need++;
      if (node.state !== UNLOADED) return;
      node.priority = d;
      found.push(node);
    };
    const visitKids = () => {
      const kids = this.#kids(node);
      if (!kids.length && node.childCount > 0) tally.need++;
      for (let i = 0; i < kids.length; i++) this.#preVisit(kids[i], found, tally);
    };
    if (node.external) {
      if (node.state === READY) visitKids();
      else want();
    } else {
      const refine = node.geometricError * this.errorFactor > d && node.childCount > 0;
      if (node.content === CONTENT.TILE && (!refine || node.refine === 'ADD')) want();
      if (refine) visitKids();
    }
    if (node.state === READY) this.lru.touch(node);
  }

  /* ---- loading ------------------------------------------------------------ */

  /*
   * The scheduler's turn (core/scheduler.js). Physics: collision copies,
   * then the tiles wanted for the focus (first in the queue). View: the rest
   * of the queue, most urgent first.
   */
  #pick(cls) {
    if (this.paused || !this.enabled || !this.root) return false;
    if (cls === PRELOAD) return this.#pickPreload();
    if (cls === PHYSICS) {
      while (this.solidQueue.length) {
        const node = this.solidQueue[0];
        if (!node.gpu || node.solid || !node.gpu.indexCount) {
          this.solidQueue.shift();
          node.solidWanted = false;
          continue;
        }
        this.solidQueue.shift();
        this.#loadSolid(node);
        return true;
      }
    }
    const q = this.queue, now = performance.now();
    while (this.queueAt < q.length) {
      const node = q[this.queueAt];
      if (node.state !== UNLOADED || node.retryAt > now) { this.queueAt++; continue; }
      // The queue holds the focus's tiles first: physics stops where they end.
      if (cls === PHYSICS && node.physicsFrame !== this.frame) return false;
      if (!this.client.canRun(this.host)) return false;
      this.queueAt++;
      const as = node.physicsFrame === this.frame ? PHYSICS : VIEW;
      if (node.external) this.#loadExternal(node, as);
      else this.#loadContent(node, as);
      return true;
    }
    return false;
  }

  #pickPreload() {
    const q = this.preQueue, now = performance.now();
    while (this.preAt < q.length) {
      const node = q[this.preAt];
      if (node.state !== UNLOADED || node.retryAt > now) { this.preAt++; continue; }
      if (!this.client.canRun(this.host)) return false;
      this.preAt++;
      if (node.external) this.#loadExternal(node, PRELOAD);
      else this.#loadContent(node, PRELOAD);
      return true;
    }
    return false;
  }

  /* Wanted no more: the latest selection did not ask for it, and either
   * two selections over STALE_MS went by without it, or the view has stood
   * still for STALE_MS since; nor did a preload lately. */
  #stale(node) {
    if (!node) return false;
    const now = performance.now();
    if (node.wantedSel === this.frame || now - node.preloadAt < PRELOAD_LIFE_MS) return false;
    return (this.frame - node.wantedSel >= STALE_SELECTIONS && this.selectedAt - node.wantedAt > STALE_MS) ||
      now - this.selectedAt > STALE_MS;
  }

  /* A selection wants this tile. */
  #stamp(node) {
    node.wantedAt = this.now;
    node.wantedSel = this.frame;
  }

  /* Counts loaded or loading content against every tile above it, which is
   * what keeps a part of the tree, or a file, in use from being let go. */
  #hold(node, delta) {
    for (let p = node.parent; p; p = p.parent) p.resident += delta;
  }

  async #loadExternal(node, cls) {
    node.state = LOADING;
    this.inFlight++;
    this.#hold(node, 1);
    try {
      const index = await this.client.run('tileset-index', {
        url: node.url,
        transform: node.transform === IDENTITY ? null : Array.from(node.transform),
        refine: node.refine,
        geometricError: node.geometricError,
        version: this.version,
      }, { item: node, cls, cost: 6, host: this.host, timeout: 60000 });
      if (index.missing) { this.#gone(node, true); return; }
      // The file's root continues this tile's transform and refinement.
      node.sub = new TileIndex(index, node.url);
      node.index.subs.set(node.slot, node.sub);
      node.children = null;
      node.state = READY;
      node.attempts = 0;
      node.lastUsed = this.frame;
      this.externals.add(node);
      if (index.cached) this.stats.filesCached++;
      else this.stats.filesFetched++;
    } catch (err) {
      this.#failed(node, err);
    } finally {
      this.#hold(node, -1);
      this.inFlight--;
      this.dirty = true;
    }
  }

  #decode(node, solid, cls) {
    return this.client.run('feature-tile', {
      url: node.url,
      transform: Array.from(node.transform),
      upAxis: this.upAxis,
      frame: this.#frameOf(node),
      attributes: this.spec.attributes || {},
      solid,
      decks: Boolean(this.spec.decks),
    }, { item: node, cls, cost: 6, host: this.host, timeout: 30000 });
  }

  /* Whether a tile should get its collision copy in the same decode. */
  #solidAtDecode(node) {
    if (this.#inFocus(node)) return true;
    return Boolean(this.view?.touching) && this.#distance(node) < SOLID_NEAR;
  }

  async #loadContent(node, cls) {
    node.state = LOADING;
    this.inFlight++;
    this.#hold(node, 1);
    try {
      const result = await this.#decode(node, this.#solidAtDecode(node), cls);
      if (result.missing) { this.#gone(node, true); return; }
      // Wanted no more by the time it came: not worth the memory.
      if (this.#stale(node) && !this.#inFocus(node)) {
        this.#recycle(result);
        node.state = UNLOADED;
        return;
      }
      // To the GPU during a frame's upload slice, not the moment it lands.
      if (this.uploads) await this.uploads.schedule(() => this.#upload(node, result));
      else this.#upload(node, result);
      node.state = READY;
      node.attempts = 0;
      this.readyCount++;
      this.#noteTypes(result.typesSeen);
      if (result.encoding in this.stats.encodings) this.stats.encodings[result.encoding]++;
    } catch (err) {
      this.#failed(node, err);
    } finally {
      // Loaded content keeps its hold until it is dropped.
      if (!node.gpu) this.#hold(node, -1);
      this.inFlight--;
      this.dirty = true;
    }
  }

  /*
   * A collision copy from the tile's own GPU buffers: both copied into one
   * staging buffer, mapped, and handed to a decode thread that builds the
   * grid (mesh_solid, the same as at decode time) and hands them back.
   */
  async #loadSolid(node) {
    const g = node.gpu, device = this.device;
    let staging = null;
    try {
      // Counted as a physics job while it is read back and gridded.
      const vBytes = g.vertexBytes, iBytes = g.indexBytes;
      staging = device.createBuffer({ label: `${this.spec.id}-readback`, size: vBytes + iBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder({ label: 'solid-readback' });
      encoder.copyBufferToBuffer(g.vbuf, 0, staging, 0, vBytes);
      encoder.copyBufferToBuffer(g.ibuf, 0, staging, vBytes, iBytes);
      device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const range = staging.getMappedRange();
      const vertices = range.slice(0, vBytes), indices = range.slice(vBytes, vBytes + iBytes);
      staging.unmap();
      // Released meanwhile: nothing to attach it to.
      if (node.gpu !== g) return;
      const result = await this.client.run('solid-grid', {
        vertices, indices, vertexCount: vBytes / 12, indexCount: g.indexCount, narrow: g.indexFormat === 'uint16',
      }, { item: node, cls: PHYSICS, cost: 1, transfer: [vertices, indices] });
      this.stats.readbacks++;
      if (node.gpu === g && !node.solid) this.#keepSolid(node, { ...result, indexCount: g.indexCount, indexFormat: g.indexFormat });
    } catch (err) {
      if (!isAbort(err)) {
        node.solidFailed = true;
        console.warn(`[${this.spec.id}] collision copy of ${node.url}: ${err.message}`);
      }
    } finally {
      staging?.destroy();
      node.solidWanted = false;
      this.dirty = true;
    }
  }

  /* Logs each object type the first time a tile of this layer holds one. */
  #noteTypes(types) {
    if (!types?.length) return;
    this.typesSeen ??= new Set();
    const fresh = types.filter((t) => !this.typesSeen.has(t));
    if (!fresh.length) return;
    for (const t of fresh) this.typesSeen.add(t);
    console.info(`[${this.spec.id}] object types: ${fresh.join(', ')}`);
  }

  /* Nothing at that address (`absent`), or nothing to be had for now. An
   * absent tile is never asked for again, even by a tile object made anew. */
  #gone(node, absent = false) {
    node.state = FAILED;
    this.failedCount++;
    if (absent) node.index.gone.add(node.slot);
  }

  /*
   * Called off: back in line whenever it is wanted again. Worth retrying:
   * again after retryDelay, and after MAX_ATTEMPTS in a row a minute's rest
   * (failed meanwhile, so a parent waiting for it moves on). Anything else
   * (a broken file) is not asked for again.
   */
  #failed(node, err) {
    if (isAbort(err)) { node.state = UNLOADED; return; }
    if (!err.retry) {
      console.warn(`[${this.spec.id}] giving up on ${node.url}: ${err.message}`);
      this.#gone(node, true);
      this.client.noteFailure();
      return;
    }
    const { wait, resting } = this.client.retryIn(node, err, node.url);
    if (resting) {
      this.#gone(node);
      setTimeout(() => {
        if (node.state !== FAILED) return;
        node.state = UNLOADED;
        this.failedCount--;
        this.dirty = true;
      }, wait);
      return;
    }
    node.state = UNLOADED;
    node.retryAt = performance.now() + wait;
    setTimeout(() => { this.dirty = true; }, wait + 1);
  }

  /* The local frame a tile's positions are decoded into: at its volume's
   * centre, on the ground-level height of a region. */
  #frameOf(node) {
    if (node.frame) return node.frame;
    const ix = node.index, s = node.slot;
    if ((ix.kind[s] & 3) === VOLUME.REGION) {
      const v = ix.volumes, o = ix.volumeAt[s];
      node.frame = { lon: (v[o] + v[o + 2]) / 2, lat: (v[o + 1] + v[o + 3]) / 2, height: v[o + 4] };
    } else {
      const g = ecefToGeodetic(ix.sphere.subarray(s * 4, s * 4 + 3));
      node.frame = { lon: g.lon, lat: g.lat, height: g.height };
    }
    return node.frame;
  }

  #upload(node, r) {
    const cables = r.cables ? this.#uploadCables(r.cables) : null;
    this.#noteContent(node, r.tops);
    if (!r.vertexCount || !r.indexCount) {
      this.#recycle(r);
      if (!cables) { node.gpu = null; return; }
      // Cable cars only: ropes and pylons, no mesh, nothing solid.
      node.gpu = {
        vbuf: null, ibuf: null, bytes: cables.bytes, featureBase: 0, featureCount: 0,
        indexCount: 0, indexFormat: 'uint16', vertexBytes: 0, indexBytes: 0,
        origin: r.origin, east: r.east, north: r.north, up: r.up,
        boxMin: r.boxMin, boxSize: [r.boxMax[0] - r.boxMin[0], r.boxMax[1] - r.boxMin[1], r.boxMax[2] - r.boxMin[2]],
        encoding: r.encoding, mercator: null, cables, deckFaces: false,
      };
      node.solidFailed = true;
      this.bytes += cables.bytes;
      node.lastUsed = Math.max(node.lastUsed, this.frame);
      this.lru.add(node);
      this.cableNodes.add(node);
      return;
    }
    const device = this.device;
    // COPY_SRC: a collision copy can be read back from them (#loadSolid).
    const vbuf = device.createBuffer({
      label: `${this.spec.id}-v`, size: r.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    const ibuf = device.createBuffer({
      label: `${this.spec.id}-i`, size: r.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    device.queue.writeBuffer(vbuf, 0, r.vertices);
    device.queue.writeBuffer(ibuf, 0, r.indices);
    const featureCount = r.records ? r.records.length / 2 : 0;
    const featureBase = featureCount && this.features ? this.features.add(r.records) : 0;
    // Copied by the queue at once: the buffers can go back to be filled again.
    this.#recycle(r);
    const bytes = r.vertices.byteLength + r.indices.byteLength + featureCount * 8 + (cables?.bytes ?? 0);
    node.gpu = {
      vbuf, ibuf, bytes,
      featureBase, featureCount,
      indexCount: r.indexCount, indexFormat: r.indexFormat,
      vertexBytes: r.vertices.byteLength, indexBytes: r.indices.byteLength,
      origin: r.origin, east: r.east, north: r.north, up: r.up,
      boxMin: r.boxMin,
      boxSize: [r.boxMax[0] - r.boxMin[0], r.boxMax[1] - r.boxMin[1], r.boxMax[2] - r.boxMin[2]],
      encoding: r.encoding,
      mercator: null,       // filled in by the pass, per imagery zoom
      cables,               // ropes and pylons (passes/cables.js), or null
      deckFaces: false,     // its upward faces are bridge decks (set by the pass)
    };
    this.bytes += bytes;
    node.lastUsed = Math.max(node.lastUsed, this.frame);
    // Newly arrived counts as just used, so it is not dropped this frame.
    this.lru.add(node);
    if (cables) this.cableNodes.add(node);
    if (r.solid) this.#keepSolid(node, r);
    if (r.decks) this.#keepDecks(node, r);
  }

  /* A bridge layer's deck tops, with the frame they are in and where they
   * lie on the map (features/decks.js reads them). */
  #keepDecks(node, r) {
    const { keys, heights, step } = r.decks;
    const f = node.frame, mLon = 111320 * Math.cos((f.lat * Math.PI) / 180), mLat = 111132;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < keys.length; k++) {
      const x = ((keys[k] >>> 16) - 32768) * step, y = ((keys[k] & 0xffff) - 32768) * step;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    node.decks = {
      keys, heights, step, origin: r.origin, east: r.east, north: r.north, up: r.up,
      // West, south, east, north in degrees, a grid step round them.
      box: [f.lon + (x0 - step) / mLon, f.lat + (y0 - step) / mLat, f.lon + (x1 + step) / mLon, f.lat + (y1 + step) / mLat],
      error: node.geometricError, bytes: keys.byteLength + heights.byteLength,
    };
    this.deckNodes.add(node);
    this.#deckChanged(node.decks);
  }

  #deckChanged(d) {
    this.deckChanges.push(d.box);
    if (this.deckChanges.length > 512) this.deckChanges.splice(0, this.deckChanges.length - 512);
  }

  /* A result's buffers, once uploaded or not wanted, back to the decode
   * threads; a tile's triangles kept for collision stay here. */
  #recycle(r) {
    if (!r.solid) this.client.recycle(r.vertices, r.indices);
    if (r.records) this.client.recycle(r.records);
    if (r.cables) this.client.recycle(r.cables.ropes, r.cables.pylons, r.cables.members);
  }

  /*
   * Ropes and the pylons' steel members into one storage buffer, drawn the
   * same way (passes/cables.js); the pylons themselves are only counted.
   * The cables pass makes its bind group on first use.
   */
  #uploadCables({ ropes, pylons, members }) {
    const bytes = Math.max(32, ropes.byteLength + (members?.byteLength ?? 0));
    const buffer = this.device.createBuffer({
      label: `${this.spec.id}-cables`, size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, ropes);
    if (members?.byteLength) this.device.queue.writeBuffer(buffer, ropes.byteLength, members);
    // The same pieces on the CPU, ropes then the pylons' members: what a
    // flight starting or landing near them keeps clear of (solid.js).
    const lines = new Float32Array(ropes.length + (members?.length ?? 0));
    lines.set(ropes);
    if (members?.length) lines.set(members, ropes.length);
    return {
      buffer, bytes: bytes + lines.byteLength, bind: null, lines,
      ropes: ropes.length / 8, members: (members?.length ?? 0) / 8, pylons: pylons.length / 8,
    };
  }

  /* The drawn triangles again, on the CPU, with the grid that finds the few
   * near a point. The vertex bytes are the very ones uploaded for drawing. */
  #keepSolid(node, r) {
    const narrow = r.indexFormat === 'uint16';
    // Arrays straight from a decode, or buffers read back from the GPU.
    const vb = r.vertices.buffer ?? r.vertices, vo = r.vertices.byteOffset ?? 0;
    const ib = r.indices.buffer ?? r.indices, io = r.indices.byteOffset ?? 0;
    const solid = {
      vertices: new Uint16Array(vb, vo, r.vertices.byteLength >> 1),
      indices: narrow ? new Uint16Array(ib, io, r.indexCount) : new Uint32Array(ib, io, r.indexCount),
      triangles: r.indexCount / 3,
      cells: r.solid.cells,
      shift: 16 - Math.log2(r.solid.cells),
      cellStart: new Uint32Array(r.solid.cellStart),
      cellTris: new Uint32Array(r.solid.cellTris),
      stamps: null,          // per triangle, for gathering each once (see solid.js)
      bytes: r.vertices.byteLength + r.indices.byteLength + r.solid.cellStart.byteLength + r.solid.cellTris.byteLength,
    };
    node.solid = solid;
    this.solidBytes += solid.bytes;
    this.solidNodes.add(node);
  }

  #dropSolid(node) {
    if (!node.solid) return;
    this.solidBytes -= node.solid.bytes;
    node.solid = null;
    this.solidNodes.delete(node);
  }

  #release(node) {
    if (node.decks) {
      this.#deckChanged(node.decks);
      this.deckNodes.delete(node);
      node.decks = null;
    }
    if (node.gpu) {
      this.cableNodes.delete(node);
      this.lru.remove(node);
      node.gpu.vbuf?.destroy();
      node.gpu.ibuf?.destroy();
      node.gpu.cables?.buffer.destroy();
      if (node.gpu.featureCount && this.features) this.features.remove(node.gpu.featureBase, node.gpu.featureCount);
      this.bytes -= node.gpu.bytes;
      node.gpu = null;
      this.#hold(node, -1);
    }
    this.#dropSolid(node);
    if (node.state === READY) this.readyCount--;
    node.state = UNLOADED;
  }

  /**
   * Over budget: drop what went unused longest, deeper before shallower,
   * from the head of the order and never past this selection's marker, a
   * frame's worth at a time. When the view itself needs more than the budget
   * nothing unused is left: lower the next selection's detail instead (see
   * terrain/terrain.js, which works the same way).
   */
  #evict(selected) {
    if (!this.evicting && this.bytes <= this.budget) return;
    const start = performance.now();
    const target = this.budget * 0.9;
    this.evicting = true;
    const deadline = start + DROP_MS;
    for (let n = 0; n < DROPS_PER_FRAME && this.bytes > target && (n === 0 || performance.now() < deadline); n++) {
      const node = this.lru.stalest;
      if (!node) break;
      this.#release(node);
      this.dropped++;
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

  #relax() {
    if (this.detailScale >= 1 || this.bytes > this.budget * 0.7) return;
    const now = performance.now();
    if (now - this.pressureAt < RELAX_AFTER_MS) return;
    this.detailScale = Math.min(1, this.detailScale * RELAX);
    this.pressureAt = now;
    this.dirty = true;
  }

  /*
   * Housekeeping on a clock, from short lists rather than the whole tree:
   * collision copies far from the camera and outside the focus (and, over
   * their allowance, the farthest ones outside the focus) are let go four
   * times a second; every two seconds, parts of the tree and whole files
   * nothing is loaded from and no selection has passed through for a while
   * are let go, so touring the country does not keep every tile object or
   * file ever read.
   */
  #maintain() {
    const now = performance.now();
    if (now < this.solidCheckAt && now < this.forgetCheckAt) return;
    if (now >= this.solidCheckAt && this.view) {
      this.solidCheckAt = now + SOLID_CHECK_MS;
      this.#trimSolids();
    }
    if (now >= this.forgetCheckAt) {
      this.forgetCheckAt = now + FORGET_CHECK_MS;
      this.#forget(now);
    }
    this.timing.maintain += performance.now() - now;
  }

  #trimSolids() {
    let spare = null;
    for (const node of this.solidNodes) {
      node.distance = this.#distance(node);
      if (node.distance > SOLID_DROP && node.focusFrame !== this.frame && !this.#inFocus(node)) {
        this.#dropSolid(node);
        continue;
      }
      if (this.solidBytes > this.solidBudget && node.focusFrame !== this.frame) (spare ??= []).push(node);
    }
    if (!spare || this.solidBytes <= this.solidBudget) return;
    spare.sort(byDistanceDescending);
    for (const node of spare) {
      if (this.solidBytes <= this.solidBudget * 0.9) break;
      this.#dropSolid(node);
    }
  }

  /* Unused long enough to let go: nothing loaded at or below it, and not
   * walked through for FORGET_MS and FORGET_FRAMES selections (a still view
   * makes no selections, so nothing is let go while you stand and look). */
  #idle(node, now) {
    return node.resident === 0 && this.frame - node.lastUsed > FORGET_FRAMES &&
      now - this.#timeOf(node.lastUsed) > FORGET_MS;
  }

  /* When selection `f` was made. One older than the ring was made before
   * the oldest the ring holds, which is what it says then. */
  #timeOf(f) {
    const ring = this.selectionTimes;
    return this.frame - f < SELECTION_RING ? ring[f % SELECTION_RING] : ring[(this.frame + 1) % SELECTION_RING];
  }

  #forget(now) {
    let forgot = false;
    for (const node of this.externals) {
      if (node.state !== READY || !this.#idle(node, now)) continue;
      this.#close(node);
      node.index.subs.delete(node.slot);
      node.sub = null;
      node.state = UNLOADED;
      this.externals.delete(node);
      forgot = true;
    }
    for (const node of this.opened) {
      if (node.children && this.#idle(node, now)) { this.#close(node); forgot = true; }
    }
    if (!forgot) return;
    // Files opened from inside a forgotten one went with it.
    for (const node of this.externals) {
      for (let o = node.owner; o; o = o.owner) {
        if (o.state !== READY || !o.children) { this.externals.delete(node); break; }
      }
    }
  }

  /* Lets go of a tile's children and everything under them (nothing there
   * is loaded: see #idle). */
  #close(node) {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (!n.children) continue;
      for (const c of n.children) {
        stack.push(c);
        this.nodes--;
        if (c.external) {
          this.externals.delete(c);
          if (c.sub) c.index.subs.delete(c.slot);
        }
      }
      n.children = null;
      this.opened.delete(n);
    }
  }

  #refreshStats() {
    // Candidates beyond the kept few are all still to load.
    let queued = this.wantedCount - this.queue.length;
    for (let i = this.queueAt; i < this.queue.length; i++) if (this.queue[i].state === UNLOADED) queued++;
    const s = this.stats;
    s.drawn = this.enabled ? this.visible.length : 0;
    s.ready = this.readyCount;
    // Tiles held back or skipped while moving are still wanted.
    s.pending = this.inFlight + Math.max(0, queued) + this.deferredCount + this.skippedCount;
    s.bytes = this.bytes;
    s.solidBytes = this.solidBytes;
    s.focusTiles = this.focusNodes.length;
    s.focusPending = this.focusPending;
    s.triangles = Math.round(this.drawnTriangles);
    s.failed = this.failedCount;
    s.budget = this.budget;
    s.solidBudget = this.solidBudget;
    s.detail = this.detailScale;
    s.dropped = this.dropped;
    s.files = this.externals.size;
    s.nodes = this.nodes;
    s.deferred = this.deferredCount;
    s.skipped = this.skippedCount;
  }

  destroy() {
    this.client.cancelAll();
    const walk = (node) => { if (node.gpu) this.#release(node); node.children?.forEach(walk); };
    if (this.root) walk(this.root);
    this.visible.length = 0;
  }
}
