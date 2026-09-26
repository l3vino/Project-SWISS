/* tileset.js — one 3D Tiles tileset, streamed by screen-space error.
 *
 * A tileset is a tree the data provider built: every tile has a bounding
 * volume, a geometric error (how wrong the picture is if this tile is drawn
 * instead of its children) and optionally content. Some tiles' content is
 * another tileset, loaded when that part of the tree is first needed, which
 * is how a whole country fits in a handful of small files.
 *
 * Walking it follows the same rules as the terrain quadtree and shares its
 * View (js/engine/view.js): only tiles in the frustum and before the horizon
 * are visited, a tile is refined while its error would cover more pixels on
 * screen than the detail setting allows, and requests go out nearest first,
 * a few dozen kept per selection (engine/topk.js). The two ways a tileset can
 * refine are both honoured:
 *   ADD      children add detail to their parent, which stays drawn;
 *   REPLACE  children replace it, once every child in view has arrived.
 *
 * Memory is a budget in least-recently-used order that is never scanned or
 * sorted (engine/lru.js): what went unused longest is dropped first, deeper
 * tiles before shallower ones, and when the view needs more than the budget
 * holds the next selection's detail is lowered a step rather than the whole
 * tree being searched again every frame. The swisstopo tree holds tens of
 * thousands of tiles per external file, so nothing here visits all of them:
 * housekeeping (letting go of collision copies far away, forgetting external
 * tilesets unused for a while) works from short lists on a clock.
 *
 * Tile content is decoded on the decode threads (js/formats/tile-content.js)
 * into twelve-byte vertices in a local east-north-up frame per tile; this
 * file only decides what is wanted and keeps the GPU buffers.
 *
 * Physics touches the same tiles. Around the view's focus (the walker) every
 * tile is loaded in full detail whether it is on screen or not, and tiles
 * near the camera keep a CPU copy of their triangles with a collision grid
 * (wasm/src/solid.c); `focusNodes` lists the ones physics should use, which
 * are exactly the ones that would be drawn there. Copies far from the camera
 * are dropped, and asked for again if the walker comes back. They have their
 * own allowance, apart from the video memory budget.
 */

import { regionSphere, boxRadius } from '../bounds.js';
import { LruList } from '../lru.js';
import { TopK } from '../topk.js';
import { mat4d, ecefToGeodetic, DEG } from '../../core/math.js';

const UNLOADED = 0, LOADING = 1, READY = 2, FAILED = 3;
const IDENTITY = mat4d.identity();
/* A failed request is tried again after this; a tile failing this often stops. */
const RETRY_MS = 8000;
const MAX_ATTEMPTS = 3;
/* External tilesets nothing was loaded from, unvisited for this long, are
 * forgotten again; looked for this often. */
const FORGET_MS = 30000;
const FORGET_CHECK_MS = 2000;
/* Tiles loaded within this many metres of the camera keep their triangles
 * for collision; copies beyond the second distance are let go, checked this
 * often. */
const SOLID_KEEP = 1500;
const SOLID_DROP = 2500;
const SOLID_CHECK_MS = 250;
/* Reach, as flags: on screen, and within the focus. */
const SEEN = 1, FOCUSED = 2;
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

class TileNode {
  constructor(json, parent, baseUrl) {
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
    // The external tile this one came from, if any: whoever forgets that
    // file needs to know whether anything under it is still in use.
    this.owner = parent ? (parent.external ? parent : parent.owner) : null;
    this.geometricError = json.geometricError ?? parent?.geometricError ?? 0;
    this.refine = String(json.refine ?? parent?.refine ?? 'REPLACE').toUpperCase();
    this.transform = json.transform
      ? mat4d.multiply(parent?.transform ?? IDENTITY, Float64Array.from(json.transform))
      : (parent?.transform ?? IDENTITY);
    this.volume = volumeOf(json.boundingVolume, this.transform);

    const uri = json.content?.uri ?? json.content?.url;   // `url` in pre-1.0 tilesets
    this.url = uri ? new URL(uri, baseUrl).href : null;
    this.external = Boolean(uri) && /\.json($|\?)/i.test(uri);

    this.state = this.url ? UNLOADED : READY;
    this.attempts = 0;
    this.retryAt = 0;
    this.lastUsed = 0;
    this.priority = 0;
    this.heapIndex = -1;      // place among a selection's kept candidates (topk.js)
    this.wantedFrame = -1;
    this.lruPrev = null;      // links in the memory budget's order (lru.js)
    this.lruNext = null;
    this.gpu = null;          // { vbuf, ibuf, indexCount, indexFormat, bytes, ... } once loaded
    this.solid = null;        // CPU triangles and collision grid, near the camera
    this.solidWanted = false; // a copy for collision has been asked for again
    this.solidFailed = false; // and could not be made: not asked for again
    this.focusFrame = -1;     // selection that last handed it to physics
    this.frame = null;        // where decoded positions are expressed, once computed
    this.resident = 0;        // on an external tile: content below it loaded or loading
    this.seenAt = 0;          // on an external tile: when a selection last came through

    this.children = (json.children || []).map((c) => new TileNode(c, this, baseUrl));
  }

  /** Has something to draw, or nothing to wait for. */
  get settled() { return !this.url || this.state === READY || this.state === FAILED; }
}

/**
 * A bounding volume as a sphere for culling plus what distance needs.
 * Regions ignore the tile transform, as the specification says; boxes and
 * spheres are carried through it.
 */
function volumeOf(bv = {}, transform) {
  const center = new Float64Array(3);
  if (bv.region) {
    const [w, s, e, n, minH, maxH] = bv.region;
    const rect = { west: w / DEG, south: s / DEG, east: e / DEG, north: n / DEG };
    return { kind: 'region', rect, minHeight: minH, maxHeight: maxH, center,
      radius: regionSphere(rect, minH, maxH, center) };
  }
  if (bv.box) {
    const b = bv.box;
    mat4d.transformPoint(transform, b[0], b[1], b[2], center);
    const axes = new Float64Array(9);
    for (let i = 0; i < 3; i++) {
      const v = mat4d.transformVector(transform, b[3 + i * 3], b[4 + i * 3], b[5 + i * 3]);
      axes.set(v, i * 3);
    }
    return { kind: 'box', center, axes, radius: boxRadius(axes) };
  }
  if (bv.sphere) {
    const s = bv.sphere;
    mat4d.transformPoint(transform, s[0], s[1], s[2], center);
    const scale = Math.max(Math.hypot(transform[0], transform[1], transform[2]),
      Math.hypot(transform[4], transform[5], transform[6]), Math.hypot(transform[8], transform[9], transform[10]));
    return { kind: 'sphere', center, radius: s[3] * scale };
  }
  // No volume: never culled, always as near as can be.
  return { kind: 'none', center, radius: Infinity };
}

/* Farthest first, for letting collision copies go. */
const byDistanceDescending = (a, b) => b.distance - a.distance;

export class Tileset {
  /**
   * @param spec      the adapter's feature entry: { id, tileset, attributes, ... }
   * @param features  where each building's record goes (feature-pool.js), or null
   * @param maxError  pixels of error a tile may show before it is refined
   * @param budgetMB  video memory kept for this layer's tiles; collision
   *                  copies get half as much again, separately
   */
  constructor({ device, pool, spec, features = null, uploads = null, maxError = 10, budgetMB = 256 }) {
    this.device = device;
    this.pool = pool;
    this.features = features;
    this.uploads = uploads;       // shared per-frame upload slice (engine/uploads.js)
    this.spec = spec;
    this.maxError = maxError;
    this.budget = budgetMB * MB;
    this.solidBudget = Math.max(32 * MB, this.budget / 2);
    this.enabled = true;
    this.paused = false;          // no new requests (diagnostics)

    this.root = null;
    this.upAxis = 'Y';
    this.visible = [];
    this.focusNodes = [];     // what physics stands on and bumps into, around the focus
    this.focusPending = 0;    // tiles in the focus still on their way
    this.solidQueue = [];     // tiles in the focus waiting for a collision copy
    this.solidNodes = new Set();   // tiles holding a collision copy
    this.solidBytes = 0;
    this.externals = new Set();    // external tiles whose file is loaded
    this.wanted = new TopK(WANTED_KEPT);
    this.wantedCount = 0;
    this.queue = [];
    this.queueAt = 0;
    this.inFlight = 0;
    this.maxInFlight = Math.max(6, pool.size * 2);
    this.bytes = 0;
    this.frame = 0;
    this.now = 0;             // performance.now() at the latest selection
    this.dirty = true;
    this.viewVersion = -1;
    this.errorFactor = 1;
    this.view = null;
    this.status = 'loading';

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
      encodings: { plain: 0, quantized: 0, meshopt: 0, draco: 0 } };
    this.readyCount = 0;
    this.failedCount = 0;
    this.drawnTriangles = 0;
  }

  /** Reads the root tileset. Resolves to a line for the console, or throws. */
  async load() {
    const json = await fetchJson(this.spec.tileset);
    this.upAxis = String(json.asset?.gltfUpAxis ?? 'Y').toUpperCase();
    if (json.extensionsRequired?.length) {
      console.warn(`[${this.spec.id}] tileset requires ${json.extensionsRequired.join(', ')}; drawing what can be read`);
    }
    this.root = new TileNode(json.root, null, this.spec.tileset);
    this.status = 'ready';
    return `${this.spec.id}: 3D Tiles ${json.asset?.version ?? '?'}, root error ${json.root?.geometricError ?? '?'} m`;
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
    if (enabled !== undefined) this.enabled = Boolean(enabled);
    if (detailDistance !== undefined) this.detailDistance = detailDistance > 0 ? detailDistance : null;
    if (maxDistance !== undefined) this.maxDistance = maxDistance > 0 ? maxDistance : Infinity;
    // New settings start from full detail; pressure, if any, shows again.
    this.detailScale = 1;
    this.dirty = true;
  }

  /** Stops sending requests (for diagnosing), or resumes. */
  pause(on) { this.paused = Boolean(on); }

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
    if (!this.paused) this.#pump();
    this.#refreshStats();
  }

  #select(view) {
    this.frame++;
    this.view = view;
    this.now = performance.now();
    // Everything loaded counts as unused until this selection touches it.
    this.lru.mark();
    const factor = this.detailDistance ? this.detailDistance / REFERENCE_ERROR
      : view.pixelsPerRadian / this.maxError;
    this.errorFactor = factor * this.detailScale;
    this.reachLimit = Math.min(view.horizon, this.maxDistance ?? Infinity);
    this.visible.length = 0;
    this.focusNodes.length = 0;
    this.focusPending = 0;
    this.wantedCount = 0;
    this.drawnTriangles = 0;
    this.#visit(this.root);
    this.wanted.drainSorted(this.queue);
    this.queueAt = 0;
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

  #visitNode(node) {
    node.lastUsed = this.frame;
    // A file the walk still passes through stays, on screen or not: turning
    // round should not mean reading it again.
    if (node.external) node.seenAt = this.now;
    const d = this.#distance(node);
    const reach = this.#reach(node, d);
    if (!reach) return;

    // Content that is itself a tileset has nothing of its own to draw: its
    // root is the real child. It is opened whenever this part of the tree is
    // reached, whatever its own error, the way Cesium treats it; the parent
    // that led here already decided the detail is wanted.
    if (node.external) {
      if (node.state !== READY) {
        this.#request(node, d);
        if (reach & FOCUSED) this.focusPending++;
        return;
      }
      for (const c of node.children) this.#visit(c);
      return;
    }

    const refine = node.geometricError * this.errorFactor > d;
    if (!refine || !node.children.length) { this.#show(node, d, reach); return; }

    if (node.refine === 'ADD') {
      this.#show(node, d, reach);
      for (const c of node.children) this.#visit(c);
      return;
    }

    // REPLACE: children take over once every one in reach can stand in.
    let ready = true;
    for (const c of node.children) {
      this.#use(c);
      const dc = this.#distance(c);
      const inReach = this.#reach(c, dc) !== 0;
      if (!c.settled) this.#request(c, inReach ? dc : 1e6 + dc * 4);
      if (inReach && !this.#canStandIn(c, 0)) ready = false;
    }
    if (!ready && node.url && node.state === READY) { this.#show(node, d, reach); return; }
    for (const c of node.children) this.#visit(c);
  }

  /* On screen (in the frustum and before the horizon), in the focus, both or
   * neither. */
  #reach(node, d) {
    const view = this.view, vol = node.volume;
    let r = 0;
    if (d <= this.reachLimit && view.sphereVisible(vol.center, vol.radius)) r |= SEEN;
    if (view.focus && view.focusDistance(vol) <= view.focus.radius) r |= FOCUSED;
    return r;
  }

  /* Whether a tile can take its parent's place yet: its own content has
   * arrived, or it has none (or is a tileset) and its children in view can
   * stand in for it in turn. Looks a few levels down at most; empty tiles are
   * rarely stacked deeper than that. What it finds missing on the way is
   * requested, so waiting always makes progress. */
  #canStandIn(node, depth) {
    if (node.url && !node.external) return node.settled;
    if (node.external && node.state !== READY) return node.state === FAILED;
    if (depth >= 3) return true;
    for (const c of node.children) {
      this.#use(c);
      const dc = this.#distance(c);
      if (!this.#reach(c, dc)) continue;
      if (!c.settled) this.#request(c, dc);
      if (!this.#canStandIn(c, depth + 1)) return false;
    }
    return true;
  }

  /**
   * Draws a tile's content if it is here and on screen, hands it to physics
   * if it is in the focus, and asks for whatever is missing.
   */
  #show(node, d, reach) {
    if (!node.url || node.external) return;
    const focused = (reach & FOCUSED) !== 0;
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
    this.#request(node, d);
  }

  /* A tile in the focus whose collision copy was let go: decode it again,
   * which normally comes straight from the browser's cache. */
  #wantSolid(node) {
    if (node.solidWanted) return;
    node.solidWanted = true;
    this.solidQueue.push(node);
  }

  #request(node, priority) {
    if (node.state !== UNLOADED) return;
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

  #distance(node) {
    const v = node.volume, view = this.view;
    if (v.kind === 'region') return view.regionDistance(v.rect, v.minHeight, v.maxHeight);
    if (v.kind === 'box') return view.boxDistance(v.center, v.axes);
    if (v.kind === 'sphere') return view.sphereDistance(v.center, v.radius);
    return 0;
  }

  /* ---- loading ------------------------------------------------------------ */

  #pump() {
    const now = performance.now();
    // Collision copies first: someone is standing next to them.
    while (this.inFlight < this.maxInFlight && this.solidQueue.length) {
      const node = this.solidQueue.shift();
      if (node.gpu && !node.solid) this.#loadSolid(node);
      else node.solidWanted = false;
    }
    const q = this.queue;
    while (this.inFlight < this.maxInFlight && this.queueAt < q.length) {
      const node = q[this.queueAt++];
      if (node.state !== UNLOADED || node.retryAt > now) continue;
      if (node.external) this.#loadExternal(node);
      else this.#loadContent(node);
    }
  }

  /* Counts loaded or loading content against every external tile above it,
   * which is what keeps a file in use from being forgotten. */
  #hold(node, delta) {
    for (let o = node.owner; o; o = o.owner) o.resident += delta;
  }

  async #loadExternal(node) {
    node.state = LOADING;
    this.inFlight++;
    this.#hold(node, 1);
    try {
      const json = await fetchJson(node.url);
      // The external root continues this tile's transform and refinement.
      node.children = [new TileNode(json.root, node, node.url)];
      node.state = READY;
      node.seenAt = performance.now();
      this.externals.add(node);
    } catch (err) {
      this.#failed(node, err);
    } finally {
      this.#hold(node, -1);
      this.inFlight--;
      this.dirty = true;
    }
  }

  #decode(node, solid) {
    return this.pool.run('feature-tile', {
      url: node.url,
      transform: Array.from(node.transform),
      upAxis: this.upAxis,
      frame: this.#frameOf(node),
      attributes: this.spec.attributes || {},
      solid,
    }, { cost: 6, timeout: 30000 });
  }

  async #loadContent(node) {
    node.state = LOADING;
    this.inFlight++;
    this.#hold(node, 1);
    try {
      const result = await this.#decode(node, this.#distance(node) < SOLID_KEEP);
      if (result.missing) { node.state = FAILED; this.failedCount++; return; }
      // To the GPU during a frame's upload slice, not the moment it lands.
      if (this.uploads) await this.uploads.schedule(() => this.#upload(node, result));
      else this.#upload(node, result);
      node.state = READY;
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

  async #loadSolid(node) {
    this.inFlight++;
    try {
      const result = await this.#decode(node, true);
      // Released while this was on its way: nothing to attach it to.
      if (!result.solid) node.solidFailed = true;
      else if (node.gpu && !node.solid) this.#keepSolid(node, result);
    } catch (err) {
      console.warn(`[${this.spec.id}] collision copy of ${node.url}: ${err.message}`);
    } finally {
      node.solidWanted = false;
      this.inFlight--;
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

  #failed(node, err) {
    node.attempts++;
    if (node.attempts >= MAX_ATTEMPTS) {
      node.state = FAILED;
      this.failedCount++;
      console.warn(`[${this.spec.id}] giving up on ${node.url}: ${err.message}`);
    } else {
      node.state = UNLOADED;
      node.retryAt = performance.now() + RETRY_MS;
      console.warn(`[${this.spec.id}] ${node.url}: ${err.message}; retrying`);
    }
  }

  /* The local frame a tile's positions are decoded into: at its volume's
   * centre, on the ground-level height of a region. */
  #frameOf(node) {
    if (node.frame) return node.frame;
    const v = node.volume;
    if (v.kind === 'region') {
      node.frame = { lon: (v.rect.west + v.rect.east) / 2, lat: (v.rect.south + v.rect.north) / 2, height: v.minHeight };
    } else {
      const g = ecefToGeodetic(v.center);
      node.frame = { lon: g.lon, lat: g.lat, height: g.height };
    }
    return node.frame;
  }

  #upload(node, r) {
    if (!r.vertexCount || !r.indexCount) { node.gpu = null; return; }
    const device = this.device;
    const vbuf = device.createBuffer({
      label: `${this.spec.id}-v`, size: r.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ibuf = device.createBuffer({
      label: `${this.spec.id}-i`, size: r.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vbuf, 0, r.vertices);
    device.queue.writeBuffer(ibuf, 0, r.indices);
    const featureCount = r.records ? r.records.length / 2 : 0;
    const featureBase = featureCount && this.features ? this.features.add(r.records) : 0;
    const bytes = r.vertices.byteLength + r.indices.byteLength + featureCount * 8;
    node.gpu = {
      vbuf, ibuf, bytes,
      featureBase, featureCount,
      indexCount: r.indexCount, indexFormat: r.indexFormat,
      origin: r.origin, east: r.east, north: r.north, up: r.up,
      boxMin: r.boxMin,
      boxSize: [r.boxMax[0] - r.boxMin[0], r.boxMax[1] - r.boxMin[1], r.boxMax[2] - r.boxMin[2]],
      encoding: r.encoding,
      mercator: null,       // filled in by the pass, per imagery zoom
    };
    this.bytes += bytes;
    node.lastUsed = Math.max(node.lastUsed, this.frame);
    // Newly arrived counts as just used, so it is not dropped this frame.
    this.lru.add(node);
    if (r.solid) this.#keepSolid(node, r);
  }

  /* The drawn triangles again, on the CPU, with the grid that finds the few
   * near a point. The vertex bytes are the very ones uploaded for drawing. */
  #keepSolid(node, r) {
    const narrow = r.indexFormat === 'uint16';
    const solid = {
      vertices: new Uint16Array(r.vertices),
      indices: narrow ? new Uint16Array(r.indices, 0, r.indexCount) : new Uint32Array(r.indices, 0, r.indexCount),
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
    if (node.gpu) {
      this.lru.remove(node);
      node.gpu.vbuf.destroy();
      node.gpu.ibuf.destroy();
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
   * collision copies far from the camera (and, over their allowance, the
   * farthest ones outside the focus) are let go four times a second; every
   * two seconds, external tilesets nothing is loaded from and no selection
   * has passed through for a while are forgotten, so touring the country
   * does not keep every file ever read.
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
      if (node.distance > SOLID_DROP) { this.#dropSolid(node); continue; }
      if (this.solidBytes > this.solidBudget && node.focusFrame !== this.frame) (spare ??= []).push(node);
    }
    if (!spare || this.solidBytes <= this.solidBudget) return;
    spare.sort(byDistanceDescending);
    for (const node of spare) {
      if (this.solidBytes <= this.solidBudget * 0.9) break;
      this.#dropSolid(node);
    }
  }

  #forget(now) {
    let forgot = false;
    for (const node of this.externals) {
      if (node.state !== READY || node.resident > 0 || now - node.seenAt < FORGET_MS) continue;
      node.children = [];
      node.state = UNLOADED;
      this.externals.delete(node);
      forgot = true;
    }
    if (!forgot) return;
    // Files opened from inside a forgotten one went with it.
    for (const node of this.externals) {
      for (let o = node.owner; o; o = o.owner) {
        if (o.state !== READY) { this.externals.delete(node); break; }
      }
    }
  }

  #refreshStats() {
    // Candidates beyond the kept few are all still to load.
    let queued = this.wantedCount - this.queue.length;
    for (let i = this.queueAt; i < this.queue.length; i++) if (this.queue[i].state === UNLOADED) queued++;
    const s = this.stats;
    s.drawn = this.enabled ? this.visible.length : 0;
    s.ready = this.readyCount;
    s.pending = this.inFlight + Math.max(0, queued);
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
  }

  destroy() {
    const walk = (node) => { if (node.gpu) this.#release(node); node.children.forEach(walk); };
    if (this.root) walk(this.root);
    this.visible.length = 0;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}
