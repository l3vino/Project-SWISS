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
 * screen than the detail setting allows, requests go out nearest first, and
 * a memory budget drops what has been out of sight longest. The two ways a
 * tileset can refine are both honoured:
 *   ADD      children add detail to their parent, which stays drawn;
 *   REPLACE  children replace it, once every child in view has arrived.
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
 * are dropped, and asked for again if the walker comes back.
 */

import { regionSphere, boxRadius } from '../bounds.js';
import { mat4d, ecefToGeodetic, DEG } from '../../core/math.js';

const UNLOADED = 0, LOADING = 1, READY = 2, FAILED = 3;
const IDENTITY = mat4d.identity();
/* A failed request is tried again after this; a tile failing this often stops. */
const RETRY_MS = 8000;
const MAX_ATTEMPTS = 3;
/* External tilesets unused for this many selections are forgotten again. */
const FORGET_AFTER = 1200;
/* Tiles loaded within this many metres of the camera keep their triangles
 * for collision; copies beyond the second distance are let go. */
const SOLID_KEEP = 1500;
const SOLID_DROP = 2500;
/* Reach, as flags: on screen, and within the focus. */
const SEEN = 1, FOCUSED = 2;
/* The detail distance setting says how far out a tile with this geometric
 * error keeps splitting: about a building's finest level in swisstopo's sets,
 * so the setting reads as "full detail out to". */
const REFERENCE_ERROR = 5;

class TileNode {
  constructor(json, parent, baseUrl) {
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
    this.geometricError = json.geometricError ?? parent?.geometricError ?? 0;
    this.refine = String(json.refine ?? parent?.refine ?? 'REPLACE').toUpperCase();
    this.transform = json.transform
      ? mat4d.multiply(parent?.transform ?? IDENTITY, Float64Array.from(json.transform))
      : (parent?.transform ?? IDENTITY);
    this.volume = volumeOf(json.boundingVolume, this.transform);

    const uri = json.content?.uri ?? json.content?.url;   // `url` in pre-1.0 tilesets
    this.url = uri ? new URL(uri, baseUrl).href : null;
    this.external = Boolean(uri) && /\.json($|\?)/i.test(uri);
    this.children = (json.children || []).map((c) => new TileNode(c, this, baseUrl));

    this.state = this.url ? UNLOADED : READY;
    this.attempts = 0;
    this.retryAt = 0;
    this.lastUsed = 0;
    this.priority = 0;
    this.wantedFrame = -1;
    this.gpu = null;          // { vbuf, ibuf, indexCount, indexFormat, bytes, ... } once loaded
    this.solid = null;        // CPU triangles and collision grid, near the camera
    this.solidWanted = false; // a copy for collision has been asked for again
    this.solidFailed = false; // and could not be made: not asked for again
    this.frame = null;        // where decoded positions are expressed, once computed
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

export class Tileset {
  /**
   * @param spec      the adapter's feature entry: { id, tileset, attributes, ... }
   * @param features  where each building's record goes (feature-pool.js), or null
   * @param maxError  pixels of error a tile may show before it is refined
   * @param budgetMB  vertex and index memory kept for this layer
   */
  constructor({ device, pool, spec, features = null, uploads = null, maxError = 10, budgetMB = 256 }) {
    this.device = device;
    this.pool = pool;
    this.features = features;
    this.uploads = uploads;       // shared per-frame upload slice (engine/uploads.js)
    this.spec = spec;
    this.maxError = maxError;
    this.budget = budgetMB * 1048576;
    this.enabled = true;

    this.root = null;
    this.upAxis = 'Y';
    this.visible = [];
    this.focusNodes = [];     // what physics stands on and bumps into, around the focus
    this.focusPending = 0;    // tiles in the focus still on their way
    this.solidQueue = [];     // tiles in the focus waiting for a collision copy
    this.solidBytes = 0;
    this.wanted = [];
    this.wantedAt = 0;
    this.inFlight = 0;
    this.maxInFlight = Math.max(6, pool.size * 2);
    this.bytes = 0;
    this.frame = 0;
    this.dirty = true;
    this.viewVersion = -1;
    this.errorFactor = 1;
    this.view = null;
    this.status = 'loading';
    this.stats = { drawn: 0, ready: 0, pending: 0, bytes: 0, triangles: 0, failed: 0,
      solidBytes: 0, focusTiles: 0, focusPending: 0,
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
    if (budgetMB !== undefined && budgetMB > 0) this.budget = budgetMB * 1048576;
    if (enabled !== undefined) this.enabled = Boolean(enabled);
    if (detailDistance !== undefined) this.detailDistance = detailDistance > 0 ? detailDistance : null;
    if (maxDistance !== undefined) this.maxDistance = maxDistance > 0 ? maxDistance : Infinity;
    this.dirty = true;
  }

  /* ---- per frame ---------------------------------------------------------- */

  update(view) {
    if (!this.root) return;
    if (!this.enabled) {
      if (this.visible.length) { this.visible.length = 0; this.wanted.length = 0; }
      this.focusNodes.length = 0;
      this.focusPending = 0;
      this.#refreshStats();
      return;
    }
    if (view.version !== this.viewVersion || this.dirty) {
      this.viewVersion = view.version;
      this.dirty = false;
      this.#select(view);
      if (this.bytes + this.solidBytes > this.budget) this.#evict();
      if (this.frame % 60 === 0) this.#trimSolids(this.root);
      if (this.frame % 300 === 0) this.#forget(this.root);
    }
    this.#pump();
    this.#refreshStats();
  }

  #select(view) {
    this.frame++;
    this.view = view;
    this.errorFactor = this.detailDistance ? this.detailDistance / REFERENCE_ERROR
      : view.pixelsPerRadian / this.maxError;
    this.reachLimit = Math.min(view.horizon, this.maxDistance ?? Infinity);
    this.visible.length = 0;
    this.focusNodes.length = 0;
    this.focusPending = 0;
    this.wanted.length = 0;
    this.wantedAt = 0;
    this.drawnTriangles = 0;
    this.#visit(this.root);
    this.wanted.sort((a, b) => a.priority - b.priority);
  }

  #visit(node) {
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
      c.lastUsed = this.frame;
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
      c.lastUsed = this.frame;
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
          if (node.solid) this.focusNodes.push(node);
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
    if (node.wantedFrame === this.frame) { node.priority = Math.min(node.priority, priority); return; }
    node.wantedFrame = this.frame;
    node.priority = priority;
    this.wanted.push(node);
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
    while (this.inFlight < this.maxInFlight && this.wantedAt < this.wanted.length) {
      const node = this.wanted[this.wantedAt++];
      if (node.state !== UNLOADED || node.retryAt > now) continue;
      if (node.external) this.#loadExternal(node);
      else this.#loadContent(node);
    }
  }

  async #loadExternal(node) {
    node.state = LOADING;
    this.inFlight++;
    try {
      const json = await fetchJson(node.url);
      // The external root continues this tile's transform and refinement.
      node.children = [new TileNode(json.root, node, node.url)];
      node.state = READY;
    } catch (err) {
      this.#failed(node, err);
    } finally {
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
  }

  #dropSolid(node) {
    if (!node.solid) return;
    this.solidBytes -= node.solid.bytes;
    node.solid = null;
  }

  /* Collision copies far from the camera are let go. */
  #trimSolids(node) {
    if (node.solid && this.#distance(node) > SOLID_DROP) this.#dropSolid(node);
    for (const c of node.children) this.#trimSolids(c);
  }

  #release(node) {
    if (node.gpu) {
      node.gpu.vbuf.destroy();
      node.gpu.ibuf.destroy();
      if (node.gpu.featureCount && this.features) this.features.remove(node.gpu.featureBase, node.gpu.featureCount);
      this.bytes -= node.gpu.bytes;
      node.gpu = null;
    }
    this.#dropSolid(node);
    if (node.state === READY) this.readyCount--;
    node.state = UNLOADED;
  }

  /** Over budget: drop the content out of sight longest, deepest first among equals. */
  #evict() {
    const target = this.budget * 0.9;
    const candidates = [];
    const collect = (node) => {
      if (node.gpu && node.lastUsed < this.frame) candidates.push(node);
      for (const c of node.children) collect(c);
    };
    collect(this.root);
    candidates.sort((a, b) => a.lastUsed - b.lastUsed || b.depth - a.depth);
    for (const node of candidates) {
      if (this.bytes + this.solidBytes <= target) break;
      this.#release(node);
    }
  }

  /* External tilesets far out of use are dropped back to an unloaded tile, so
   * touring the country does not keep every file ever read. Returns whether
   * anything under `node` still holds GPU data or is loading. */
  #forget(node) {
    let busy = Boolean(node.gpu) || node.state === LOADING;
    for (const c of node.children) busy = this.#forget(c) || busy;
    if (node.external && node.state === READY && !busy && this.frame - node.lastUsed > FORGET_AFTER) {
      node.children = [];
      node.state = UNLOADED;
    }
    return busy;
  }

  #refreshStats() {
    let queued = 0;
    for (let i = this.wantedAt; i < this.wanted.length; i++) if (this.wanted[i].state === UNLOADED) queued++;
    const s = this.stats;
    s.drawn = this.enabled ? this.visible.length : 0;
    s.ready = this.readyCount;
    s.pending = this.inFlight + queued;
    s.bytes = this.bytes + this.solidBytes;
    s.solidBytes = this.solidBytes;
    s.focusTiles = this.focusNodes.length;
    s.focusPending = this.focusPending;
    s.triangles = Math.round(this.drawnTriangles);
    s.failed = this.failedCount;
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
