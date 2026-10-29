/* tiles.js — vector tiles round the camera, on the GPU, for roads and rails
 * drawn per pixel.
 *
 * Roads and railways are not geometry here: every pixel of the ground finds
 * its tile and its cell of that tile's grid and tests the few line segments
 * listed there (shaders/vector.wgsl; the method of Thöny, Billeter and
 * Pajarola, "Large-scale pixel-precise deferred vector maps", 2018). This
 * file keeps those tiles: which are wanted, loading them through the
 * scheduler on the decode threads (wasm/src/mvt.c makes each tile's block),
 * placing each block in one shared GPU buffer (pool.js), and two small page
 * tables that say, for a window of 8 × 8 tiles round the camera at each of
 * two zooms, where each tile's block is.
 *
 * Two zooms, because swisstopo's base.vt holds every road and every track
 * at both zoom 14 and zoom 13 (measured: the same kilometres per class),
 * zoom 13 at half the precision (0.8 m) but a quarter of the download for
 * the same ground. So zoom 14 near the camera, out to Full road detail
 * (1 km), and zoom 13 out to the Road distance (3 km); a pixel takes the
 * finer where it is here. And only where it is worth it: once even a wide
 * road would be under a pixel and a half there, the aerial photo shows it
 * as well as anything could, so flying high nothing is loaded at all; and
 * the finer zoom only while what needs its precision (rails 1.4 m apart,
 * markings) can still be told apart.
 *
 * Per frame this costs a few comparisons: tiles are chosen ten times a
 * second (or when the camera moves into another tile), the page tables are
 * written only when they change, and the only thing written every frame the
 * camera moves is the imagery anchor the pixels' map positions are relative
 * to (16 bytes). Tiles come round the way the others' do: called off when no
 * longer wanted, tried again later when a service fails, the least recently
 * wanted dropped first when the buffer is full (the Road and rail memory
 * setting). A tile with no lines at all (a glacier) takes no memory: its
 * page points at one shared empty block.
 *
 * Near the camera each road gets its own width (his answer: "Exact per
 * road"): the landscape model's width class, matched on a decode thread
 * (formats/road-widths.js) and written into the four spare bits of each
 * segment's attributes, on the CPU and the GPU; until then, and farther
 * out, its kind's width.
 *
 * The detail zoom's blocks are also kept here, on the CPU, for the terrain:
 * the roads, tracks, paths and railway beds near the camera are cut into the
 * terrain tiles as they are decoded (pieces.js, wasm/src/shape.c), out to
 * the Terrain under roads distance, so the detail zoom is loaded at least
 * that far (roadsSig, roadsFor; the terrain asks).
 */

import { mercX, mercY } from '../imagery/mercator.js';
import { VIEW, PRELOAD, hostOf } from '../../core/scheduler.js';
import { isAbort } from '../../core/rpc.js';
import { LruList } from '../lru.js';
import { GpuPool } from './pool.js';
import { VectorSource } from './source.js';
import { schemaTables, BLOCK } from '../../formats/vector-tile.js';
import { piecesFor, PIECE_FLOATS } from './pieces.js';
import { bridgeRuns, pinsFor, PIN_FLOATS } from './bridges.js';

const UNLOADED = 0, LOADING = 1, DECODED = 2, READY = 3, MISSING = 4;
const WINDOW = 8;                 // tiles per side of each zoom's page table
const BEFORE = 3;                 // of them before the camera's own tile
const LEVELS = 2;                 // 0: the detail zoom, 1: the overview zoom
const ABSENT = 0xffffffff;        // a page with no tile
const EMPTY = 0;                  // the page of a tile with nothing in it: the shared empty block
const PLAN_INTERVAL_MS = 100;
const POSTS_PER_FRAME = 6;
const STALE_MS = 600;
const MISSING_MOST = 4096;
const RECORDS_KEPT = 512;         // tile records beyond this are let go when nothing holds them
const RETRY_FULL_MS = 2000;       // the buffer was full: try again this much later
const KINDS = 64;
const HEAD_WORDS = 12;            // anchor, zoom, on, and the two windows
const KIND_WORDS = 8;             // VectorKind in vector.wgsl
const WIDTH_CLASSES = 16;
const INFO_WORDS = HEAD_WORDS + KINDS * KIND_WORDS + WIDTH_CLASSES;
/* How each material is drawn (vector.wgsl), by the adapter's names, and
 * which Layers switch it belongs to. */
const MATERIALS = { asphalt: 1, footway: 2, gravel: 3, track: 4, dirt: 5, steps: 6 };
const MATERIAL_LAYER = { asphalt: 'roads', gravel: 'roads', track: 'roads', footway: 'paths', dirt: 'paths', steps: 'paths' };
/* The `enabled` word's bits and a kind's flags (vector.wgsl). */
const ON = 1, LAYER_ROADS = 2, LAYER_PATHS = 4, REVEAL = 8;
const FAMILY_RAIL = 2;
const EARTH = 40075016.686;
/* What each zoom is worth having for, metres seen at a pixel and a half:
 * the detail zoom while 2 m can be told apart (rails, markings), the
 * overview while a wide road still covers that much. */
const USEFUL = [2.0, 12];
/* Metres a segment's grid cells reach beyond its widest drawing: about the
 * anti-aliasing reach at the distances each zoom is used at. */
const MARGIN = [2, 4];
/* A flight's arrival: tiles prepared round the place, and for how long they
 * count as wanted without the view asking for them. */
const PRELOAD_REACH = [600, 2000];
const PRELOAD_LIFE_MS = 30000;
/* Exact widths: one tile's job at a time (each makes its own calls, two at
 * a time); a failed one is tried again this much later; matched tiles
 * remembered this session (a byte a segment) so one dropped and loaded
 * again takes its widths at once. */
const WIDTH_JOBS = 1;
const WIDTH_RETRY_MS = 15000;
const WIDTHS_KEPT = 256;
/* Milliseconds a frame may spend following bridge decks (bridges.js). */
const DECK_MS = 1;

const keyOf = (z, x, y) => z * 268435456 + y * 16384 + x;
/* The signature of roads not all here yet (roadsSig). */
export const ROADS_NOT_READY = 0;
const byScore = (a, b) => a.score - b.score;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function colourOf(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
}

/* The block every empty tile's page points at: a header and a grid of one
 * empty cell (formats/vector-tile.js). */
function emptyBlock() {
  const w = new Uint32Array(64);
  w[BLOCK.magic] = BLOCK.MAGIC; w[BLOCK.version] = BLOCK.VERSION; w[BLOCK.grid] = 1;
  w[BLOCK.cellsOff] = 64; w[BLOCK.refsOff] = 68; w[BLOCK.segmentsOff] = 80;
  w[BLOCK.linesOff] = 80; w[BLOCK.densityOff] = 80;
  new Float32Array(w.buffer)[BLOCK.metresPerUnit] = 1;
  w[BLOCK.extent] = 4096;
  return w;
}

export class VectorTiles {
  constructor({ device, scheduler, registry, uploads, budgetMB = 64, distanceKm = 3, detailKm = 1, shapeKm = 1.2 }) {
    this.device = device;
    this.registry = registry;
    this.uploads = uploads;
    this.client = scheduler.client('vector', { weight: 2, pick: (cls) => this.#pick(cls), stale: (t) => this.#stale(t) });
    this.sources = [];
    this.source = null;
    this.kinds = null;
    this.cover = null;
    this.enabled = false;
    this.paused = false;
    this.distance = distanceKm * 1000;
    this.detailDistance = detailKm * 1000;
    this.shapeDistance = shapeKm * 1000;
    this.budget = this.#fit(budgetMB);
    // What the terrain needs of a kind to shape the ground under it
    // (pieces.js), and the exact widths' half-widths by class; and a number
    // that changes whenever the detail zoom's blocks do.
    this.shapeKinds = [];
    this.halfWidths = new Float32Array(16);
    this.version = 0;
    this.layers = { roads: true, paths: true };
    // Exact widths: the adapter's service, the rules for matching, the
    // tiles waiting (nearest first), matched tiles' classes by tile key.
    this.widthSpec = null;
    this.widthRules = null;
    this.widthsOn = true;
    this.widthQueue = [];
    this.arrival = null;          // where a flight will arrive (preload): its widths are matched too
    this.widthJobs = 0;
    this.widthsMemo = new Map();
    // The bridge layers' decks (features/decks.js), set by the render thread:
    // where a road comes off a bridge, the terrain under it is pinned to the
    // deck (bridges.js). Detail tiles whose bridges to look at again.
    this.decks = null;
    this.deckDirty = new Set();
    this.deckBoxes = [];
    this.widthTotals = { tiles: 0, cached: 0, calls: 0, bytes: 0, matched: 0, asked: 0, failed: 0 };
    this.cpuBytes = 0;
    this.scratch = { data: new Float32Array(4096 * PIECE_FLOATS), count: 0 };
    this.coverScratch = [];

    this.tiles = new Map();
    this.lru = new LruList();
    this.queue = [];
    this.queueAt = 0;
    this.preQueue = [];
    this.preAt = 0;
    this.missing = new Set();
    this.posted = 0;
    this.plannedAt = -Infinity;
    this.planStamp = 0;
    this.origins = new Int32Array(LEVELS * 2).fill(-1);
    this.levels = [0, 0];               // the zoom of each level
    this.pages = new Uint32Array(LEVELS * WINDOW * WINDOW).fill(ABSENT);
    this.pagesDirty = true;
    this.infoWords = new Uint32Array(INFO_WORDS);
    this.infoFloats = new Float32Array(this.infoWords.buffer);
    this.headDirty = true;
    this.kindsDirty = true;
    this.totals = { decoded: 0, decodeMs: 0, full: 0, evicted: 0, empty: 0 };

    this.layout = device.createBindGroupLayout({
      label: 'vector',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.info = device.createBuffer({ label: 'vector-info', size: INFO_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pageBuffer = device.createBuffer({ label: 'vector-pages', size: this.pages.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Nothing to bind until there is a service: the empty block alone.
    this.#allocate(256);
  }

  /** Reads every adapter's vector service. */
  async prepare() {
    const jobs = this.registry.all.filter((a) => a.vector).map((a) => VectorSource.load(a, a.vector));
    this.sources = (await Promise.all(jobs)).filter((s) => s && s.schema);
    this.source = this.sources[0] ?? null;
    if (!this.source) return 'no vector source';
    // One schema decides the kinds for now: the first country's. Another
    // country's tiles would need theirs mapped onto the same kinds.
    this.kinds = schemaTables(this.source.schema).kinds;
    this.shapeKinds = this.kinds.map((k) => (k.shape ? { shape: true, half: k.width / 2, bench: k.bench, grade: k.grade, priority: k.priority } : null));
    const widths = this.source.schema.widthClasses?.widths ?? [];
    for (let i = 0; i < 16; i++) this.halfWidths[i] = (widths[i] ?? 0) / 2;
    // Matching widths: every drawn kind, never wider than it is listed for
    // (with a little room: the shader holds it to that anyway).
    this.widthSpec = this.source.spec.widths ?? null;
    if (this.widthSpec && this.source.schema.widthClasses) {
      const matchable = new Uint8Array(KINDS), widest = new Float32Array(KINDS);
      this.kinds.forEach((k, i) => { if (i < KINDS && k.material) { matchable[i] = 1; widest[i] = 2 * k.half + 0.5; } });
      const full = new Float32Array(16);
      for (let i = 0; i < 16; i++) full[i] = widths[i] ?? 0;
      this.widthRules = { matchable, widest, widths: full, classes: { ...this.source.schema.widthClasses.objektart } };
    }
    this.levels[0] = this.source.detailLevel;
    this.levels[1] = this.source.overviewLevel;
    // The tiles the source's country reaches into, per level.
    const r = this.source.adapter.rect;
    this.cover = this.levels.map((z) => {
      const n = 2 ** z;
      return { x0: Math.floor(mercX(r.west) * n), x1: Math.floor(mercX(r.east) * n),
        y0: Math.floor(mercY(r.north) * n), y1: Math.floor(mercY(r.south) * n) };
    });
    this.#allocate(this.budget);
    this.enabled = this.distance > 0;
    this.#writeKinds();
    return this.sources.map((s) => s.describe()).join(', ') + `, ${Math.round(this.budget / 1048576)} MB`;
  }

  /** Road distance, full detail distance, terrain shaping distance (m), memory (MB) and exact widths, from the settings. */
  configure({ distance, detailDistance, shapeDistance, budgetMB, exactWidths }) {
    if (exactWidths !== undefined) this.widthsOn = Boolean(exactWidths);
    if (distance !== undefined) this.distance = Math.max(0, distance);
    if (detailDistance !== undefined) this.detailDistance = Math.max(0, detailDistance);
    if (shapeDistance !== undefined) this.shapeDistance = Math.max(0, shapeDistance);
    if (budgetMB !== undefined && this.#fit(budgetMB) !== this.budget) {
      this.budget = this.#fit(budgetMB);
      if (this.source) this.#allocate(this.budget);
    }
    this.enabled = Boolean(this.source) && this.distance > 0;
    this.plannedAt = -Infinity;
    this.headDirty = true;
  }

  pause(on) { this.paused = Boolean(on); }

  /**
   * How far out the terrain cuts roads in (metres, 0 for not at all): the
   * detail zoom is loaded at least that far. Called every frame (the
   * terrain's reach follows its detail); only a real change replans.
   */
  setShapeDistance(m) {
    const d = Math.max(0, m || 0);
    if (Math.abs(d - this.shapeDistance) <= 0.05 * Math.max(d, this.shapeDistance)) return;
    this.shapeDistance = d;
    this.plannedAt = -Infinity;
  }

  /* Bytes for a memory setting, within what one binding may hold. */
  #fit(budgetMB) {
    return Math.min(budgetMB * 1048576, this.device.limits.maxStorageBufferBindingSize);
  }

  /* A fresh buffer, the empty block at its start: every tile placed in the
   * old one is gone (and is loaded again if still wanted). */
  #allocate(bytes) {
    this.pool?.destroy();
    this.pool = new GpuPool(this.device, bytes, 'vector-pool');
    this.pool.alloc(256);
    this.device.queue.writeBuffer(this.pool.buffer, 0, emptyBlock());
    for (const t of this.tiles.values()) {
      if (t.state === READY) { t.state = UNLOADED; t.offset = -1; this.lru.remove(t); this.#dropCpu(t); }
    }
    this.pages.fill(ABSENT);
    this.pagesDirty = true;
    this.bindGroup = this.device.createBindGroup({
      label: 'vector', layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.info } },
        { binding: 1, resource: { buffer: this.pageBuffer } },
        { binding: 2, resource: { buffer: this.pool.buffer } },
      ],
    });
  }

  /* Each kind as the shaders read it (VectorKind), and the width classes'
   * half-widths after them. Rails are not drawn yet (5.17b): where one runs
   * over a drawn road (a level crossing, a tram in the street) the photo
   * shows through, its rails with it. */
  #writeKinds() {
    const f = this.infoFloats, w = this.infoWords;
    for (let k = 0; k < KINDS; k++) {
      const kind = this.kinds?.[k];
      const c = kind ? colourOf(kind.colour) : [0, 0, 0];
      const o = HEAD_WORDS + k * KIND_WORDS;
      f[o] = c[0]; f[o + 1] = c[1]; f[o + 2] = c[2];
      // A railway is drawn (for now: its rails in a road it crosses) out to
      // the outer edges of its rails' heads.
      const rail = kind && !kind.material && kind.family === FAMILY_RAIL && kind.gauge > 0;
      f[o + 3] = kind ? kind.half : 0;
      f[o + 4] = !kind ? 0 : rail ? Math.min(kind.half, kind.gauge / 2 + 0.1) : Math.min(kind.half, kind.width / 2);
      w[o + 5] = kind ? MATERIALS[kind.material] ?? 0 : 0;
      const layer = kind ? MATERIAL_LAYER[kind.material] : null;
      w[o + 6] = (layer === 'roads' ? LAYER_ROADS : layer === 'paths' ? LAYER_PATHS : 0) | (rail ? REVEAL : 0);
      f[o + 7] = rail ? kind.gauge / 2 : 0;
    }
    const at = HEAD_WORDS + KINDS * KIND_WORDS;
    for (let i = 0; i < WIDTH_CLASSES; i++) f[at + i] = this.halfWidths[i];
    this.kindsDirty = true;
  }

  /** Layers → Roads, Paths and trails: whether each is drawn. */
  setLayers({ roads, paths }) {
    if (roads !== undefined) this.layers.roads = Boolean(roads);
    if (paths !== undefined) this.layers.paths = Boolean(paths);
    this.headDirty = true;
  }

  /**
   * Once a frame, after the imagery: the anchor and zoom its map positions
   * are given relative to, how far the ground is below, and the view.
   * @param p  { anchor: {x, y}, zRef, aboveGround (null: not known yet), viewHeight, fovY }
   */
  update(camera, p, now = performance.now()) {
    this.posted = 0;
    const w = this.infoWords;
    const on = this.enabled && Number.isFinite(p.zRef);
    const bits = on ? ON | (this.layers.roads ? LAYER_ROADS : 0) | (this.layers.paths ? LAYER_PATHS : 0) : 0;
    if (w[3] !== bits) { w[3] = bits; this.headDirty = true; }
    // The anchor always: the terrain's steep faces lay their grain from it too.
    if (p.anchor && (p.anchor.x !== w[0] || p.anchor.y !== w[1] || (Number.isFinite(p.zRef) && w[2] !== p.zRef))) {
      w[0] = p.anchor.x; w[1] = p.anchor.y;
      if (Number.isFinite(p.zRef)) w[2] = p.zRef;
      this.headDirty = true;
    }
    if (on) {
      const mx = mercX(camera.lon), my = mercY(camera.lat);
      let moved = false;
      for (let l = 0; l < LEVELS; l++) {
        const z = this.levels[l], n = 2 ** z;
        const ox = Math.floor(mx * n) - BEFORE, oy = Math.floor(my * n) - BEFORE;
        if (ox !== this.origins[l * 2] || oy !== this.origins[l * 2 + 1]) {
          this.origins[l * 2] = ox; this.origins[l * 2 + 1] = oy;
          const o = 4 + l * 4;
          w[o] = z; w[o + 1] = ox; w[o + 2] = oy; w[o + 3] = WINDOW;
          moved = true;
        }
      }
      if (moved) { this.#rebuildPages(); this.headDirty = true; }
      if (moved || !(now < this.plannedAt + PLAN_INTERVAL_MS)) {
        this.plannedAt = now;
        this.#plan(camera, p, mx, my, now);
      }
    }
    if (on) this.#refreshDecks();
    const q = this.device.queue;
    if (this.kindsDirty) { q.writeBuffer(this.info, 0, w); this.kindsDirty = this.headDirty = false; }
    else if (this.headDirty) { q.writeBuffer(this.info, 0, w, 0, HEAD_WORDS); this.headDirty = false; }
    if (this.pagesDirty) { q.writeBuffer(this.pageBuffer, 0, this.pages); this.pagesDirty = false; }
  }

  /*
   * Which tiles are wanted: at each zoom, those within its reach of the
   * camera, counted from the ground under it with the height above it (so a
   * camera high up wants fewer, and from a height where even wide roads are
   * under a pixel and a half, none). The overview tile under the camera
   * comes first, then the detail one, then outwards.
   */
  #plan(camera, p, mx, my, now) {
    const pixelAngle = (2 * Math.tan(p.fovY / 2)) / Math.max(1, p.viewHeight);
    // Not known yet (nothing loaded under the camera): as if the ground were
    // at sea level, which asks for less, never for more.
    const h = Math.max(1, p.aboveGround ?? camera.height);
    const cosLat = Math.cos((camera.lat * Math.PI) / 180);
    this.lru.mark();
    this.planStamp++;
    let used = 0;
    const queue = this.queue;
    for (let l = 0; l < LEVELS; l++) {
      const z = this.levels[l], n = 2 ** z;
      let reach = Math.min(l === 0 ? this.detailDistance : this.distance, USEFUL[l] / (1.5 * pixelAngle));
      // The terrain cuts roads into its tiles out to here, from these blocks.
      if (l === 0 && this.shapeDistance > reach) reach = this.shapeDistance;
      if (!(reach > h)) continue;
      const across = Math.sqrt(reach * reach - h * h);
      const tileMetres = (EARTH * cosLat) / n;
      const cx = mx * n, cy = my * n;
      const ox = this.origins[l * 2], oy = this.origins[l * 2 + 1];
      for (let ty = oy; ty < oy + WINDOW; ty++) {
        for (let tx = ox; tx < ox + WINDOW; tx++) {
          // Metres from the camera's ground point to the nearest of the tile.
          const dx = Math.max(tx - cx, 0, cx - (tx + 1)) * tileMetres;
          const dy = Math.max(ty - cy, 0, cy - (ty + 1)) * tileMetres;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > across || !this.#covered(l, tx, ty)) continue;
          const key = keyOf(z, tx, ty);
          if (this.missing.has(key)) continue;
          let t = this.tiles.get(key);
          if (!t) this.tiles.set(key, (t = this.#record(l, z, tx, ty, key)));
          t.wanted = this.planStamp;
          t.wantedAt = now;
          this.lru.touch(t);
          if (t.state !== UNLOADED || t.retryAt > now) continue;
          t.score = d / tileMetres + (l === 0 ? 0.6 : 0);
          queue[used++] = t;
        }
      }
    }
    queue.length = used;
    queue.sort(byScore);
    this.queueAt = 0;
    this.#planWidths(camera, mx, my, h, now);
    // Records of tiles nothing wants and nothing holds are let go.
    if (this.tiles.size > RECORDS_KEPT) {
      for (const [k, t] of this.tiles) {
        if (this.#wanted(t, now)) continue;
        if (t.state === UNLOADED || (t.state === READY && t.size === 0)) {
          this.lru.remove(t);
          this.tiles.delete(k);
        }
      }
    }
  }

  #record(level, z, x, y, key) {
    return { key, level, z, x, y, state: UNLOADED, offset: -1, size: 0, segments: 0, refs: 0, wanted: 0, wantedAt: 0,
      preloadUntil: 0, attempts: 0, retryAt: 0, score: 0, lruPrev: null, lruNext: null,
      // The detail zoom's block on the CPU (for the terrain), as pieces.js reads it,
      // and what was done to it since it came (0: nothing).
      cpu: null, stamp: 0, widthStamp: 0, deckStamp: 0, bridges: null, widths: 0, widthRetryAt: 0, widthsPlanned: 0 };
  }

  /* Whether the source's country reaches into a tile of a level at all. */
  #covered(level, x, y) {
    const c = this.cover[level];
    return x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
  }

  #wanted(t, now = performance.now()) {
    return t.wanted === this.planStamp || t.preloadUntil > now;
  }

  /* A job in flight for a tile no plan wants any more is called off. */
  #stale(t) {
    const now = performance.now();
    return !this.#wanted(t, now) && now - t.wantedAt > STALE_MS;
  }

  #pick(cls) {
    if (!this.enabled || this.paused || !this.source) return false;
    if (cls === PRELOAD) return this.#pickFrom(this.preQueue, 'preAt', PRELOAD);
    if (cls !== VIEW || this.posted >= POSTS_PER_FRAME) return false;
    if (this.#pickFrom(this.queue, 'queueAt', VIEW)) return true;
    return this.#pickWidths();
  }

  /* ---- exact widths -------------------------------------------------------- */

  /* The detail tiles within the widths' reach that have no exact widths
   * yet, nearest first: round the camera (horizontally, walking or flying
   * low), and round where a flight will arrive (preload), so a search
   * flight lands with them. */
  #planWidths(camera, mx, my, h, now) {
    const q = this.widthQueue;
    q.length = 0;
    const spec = this.widthSpec;
    if (!spec || !this.widthRules || !this.widthsOn) return;
    const z = this.levels[0], n = 2 ** z, tileMetres = (EARTH * Math.cos((camera.lat * Math.PI) / 180)) / n;
    const here = h <= spec.reach, there = this.arrival && this.arrival.until > now;
    if (!here && !there) return;
    const near = (px, py, t) => {
      const dx = Math.max(t.x - px, 0, px - (t.x + 1)) * tileMetres, dy = Math.max(t.y - py, 0, py - (t.y + 1)) * tileMetres;
      return Math.sqrt(dx * dx + dy * dy);
    };
    for (const t of this.tiles.values()) {
      if (t.level !== 0 || t.state !== READY || !t.cpu || (t.widths !== 0 && !(t.widths === 3 && t.widthRetryAt <= now))) continue;
      const d = Math.min(here ? near(mx * n, my * n, t) : Infinity, there ? near(this.arrival.mx * n, this.arrival.my * n, t) : Infinity);
      if (d > spec.reach) continue;
      t.score = d;
      t.widthsPlanned = this.planStamp;
      q.push(t);
    }
    q.sort(byScore);
  }

  #pickWidths() {
    const q = this.widthQueue;
    while (q.length && this.widthJobs < WIDTH_JOBS) {
      const t = q.shift();
      if (t.state !== READY || !t.cpu || (t.widths !== 0 && t.widths !== 3)) continue;
      if (!this.client.canRun(hostOf(this.widthSpec.identify))) { q.unshift(t); return false; }
      this.#loadWidths(t);
      return true;
    }
    return false;
  }

  #loadWidths(t) {
    t.widths = 1;
    this.widthJobs++;
    const cpu = t.cpu;
    const header = new Uint32Array(cpu.block.buffer, cpu.block.byteOffset, 16);
    const at = header[BLOCK.segmentsOff], count = header[BLOCK.segmentCount];
    const segments = cpu.block.slice(at, at + count * BLOCK.SEGMENT_WORDS * 4).buffer;
    const metres = new Float32Array(header.buffer, header.byteOffset, 16)[BLOCK.metresPerUnit];
    this.client.run('road-widths', {
      z: t.z, x: t.x, y: t.y, segments, count, extent: header[BLOCK.extent], metres,
      rules: this.widthRules, spec: this.widthSpec, source: this.source.adapter.id,
    }, { item: t, cls: VIEW, cost: 2, host: hostOf(this.widthSpec.identify), timeout: 120000, transfer: [segments] })
      .then((r) => {
        const w = this.widthTotals;
        w.calls += r.calls ?? 0; w.bytes += r.bytes ?? 0; w.matched += r.matched ?? 0; w.asked += r.asked ?? 0;
        if (r.cached) w.cached++;
        if (t.state !== READY || t.cpu !== cpu) { t.widths = 0; return; }
        this.#memoWidths(t.key, r.codes);
        return this.uploads.schedule(() => this.#applyWidths(t, r.codes));
      })
      .catch((err) => {
        if (t.widths === 1) t.widths = 3;
        t.widthRetryAt = performance.now() + WIDTH_RETRY_MS;
        if (isAbort(err)) { t.widthRetryAt = 0; return; }
        this.widthTotals.failed++;
        if (!err.retry) console.warn(`[vector] widths for ${t.z}/${t.x}/${t.y}: ${err.message}`);
      })
      .finally(() => { this.widthJobs--; });
  }

  #memoWidths(key, codes) {
    this.widthsMemo.delete(key);
    this.widthsMemo.set(key, codes);
    if (this.widthsMemo.size > WIDTHS_KEPT) this.widthsMemo.delete(this.widthsMemo.keys().next().value);
  }

  /* A tile's width classes into its segments' spare bits (28-31), on the
   * CPU and the GPU (the segments only: a few hundred kilobytes at most). */
  #applyWidths(t, codes) {
    if (t.state !== READY || !t.cpu) { t.widths = 0; return; }
    const block = t.cpu.block;
    const header = new Uint32Array(block.buffer, block.byteOffset, 16);
    const at = header[BLOCK.segmentsOff], count = header[BLOCK.segmentCount];
    if (codes.length !== count) { t.widths = 2; return; }
    const words = new Uint32Array(block.buffer, block.byteOffset + at, count * BLOCK.SEGMENT_WORDS);
    let h = 2166136261, any = 0;
    for (let i = 0; i < count; i++) {
      const o = i * BLOCK.SEGMENT_WORDS + 6;
      words[o] = (words[o] & 0x0fffffff) | ((codes[i] & 15) << 28);
      h = Math.imul(h ^ codes[i], 16777619);
      any |= codes[i];
    }
    if (t.size > 0) this.device.queue.writeBuffer(this.pool.buffer, t.offset + at, block.buffer, block.byteOffset + at, count * BLOCK.SEGMENT_WORDS * 4);
    t.widths = 2;
    this.widthTotals.tiles++;
    // What the terrain cuts in changes with the widths.
    t.widthStamp = any ? (h >>> 0) || 1 : 0;
    if (this.#restamp(t)) this.version++;
  }

  /* A detail tile's stamp from what was done to it since it came: its
   * widths and its bridges' pins (0: nothing). Whether it changed. */
  #restamp(t) {
    const w = t.widthStamp ?? 0, d = t.deckStamp ?? 0;
    const stamp = !w && !d ? 0 : (Math.imul(Math.imul(2166136261 ^ w, 16777619) ^ d, 16777619) >>> 0) || 1;
    if (stamp === t.stamp) return false;
    t.stamp = stamp;
    return true;
  }

  /* ---- bridges ----------------------------------------------------------- */

  /* Where decks came or went, the detail tiles there look at their bridges
   * again; then as many as a millisecond allows do (bridges.js). A tile
   * whose pins change is cut into the terrain again (its stamp). */
  #refreshDecks() {
    const decks = this.decks;
    if (!decks || !this.source) return;
    const z = this.levels[0], n = 2 ** z;
    for (const r of decks.changes(this.deckBoxes)) {
      const x0 = Math.floor(mercX(r[0]) * n), x1 = Math.floor(mercX(r[2]) * n);
      const y0 = Math.floor(mercY(r[3]) * n), y1 = Math.floor(mercY(r[1]) * n);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const t = this.tiles.get(keyOf(z, x, y));
          if (t && t.cpu && (t.bridges === null || t.bridges.length)) this.deckDirty.add(t);
        }
      }
    }
    if (!this.deckDirty.size) return;
    const until = performance.now() + DECK_MS;
    for (const t of this.deckDirty) {
      if (performance.now() > until) break;
      this.deckDirty.delete(t);
      if (t.state !== READY || !t.cpu) continue;
      t.bridges ??= bridgeRuns(t.cpu);
      const was = t.deckStamp ?? 0;
      if (!t.bridges.length) { t.cpu.pins = t.cpu.gaps = null; t.deckStamp = 0; }
      else {
        const { pins, gaps, sig } = pinsFor(t.cpu, t.bridges, decks);
        t.cpu.pins = pins;
        t.cpu.gaps = gaps;
        t.deckStamp = sig;
      }
      if (t.deckStamp !== was && this.#restamp(t)) this.version++;
    }
  }

  /* Starts the first tile of a queue that can start now. */
  #pickFrom(queue, at, cls) {
    const now = performance.now();
    while (this[at] < queue.length) {
      const t = queue[this[at]];
      if (t.state !== UNLOADED || t.retryAt > now || (cls === VIEW && t.wanted !== this.planStamp)) { this[at]++; continue; }
      const url = this.source.urlFor(t.z, t.x, t.y);
      if (!this.client.canRun(hostOf(url))) return false;
      this[at]++;
      if (cls === VIEW) this.posted++;
      this.#load(t, url, cls);
      return true;
    }
    return false;
  }

  #load(t, url, cls) {
    t.state = LOADING;
    const schema = this.source.schema;
    this.client.run('vector-tile', { url, z: t.z, x: t.x, y: t.y, schema, margin: MARGIN[t.level] },
      { item: t, cls, cost: 1, host: hostOf(url), timeout: 30000 })
      .then((result) => {
        if (t.state !== LOADING) { if (result?.block) this.client.recycle(result.block); return; }
        if (result.missing) { this.#missing(t); return; }
        t.attempts = 0;
        t.state = DECODED;
        this.totals.decoded++;
        this.totals.decodeMs += ((result.stats?.ms ?? 0) - this.totals.decodeMs) * 0.1;
        this.uploads.schedule(() => this.#place(t, result)).catch((err) => {
          console.warn(`[vector] tile ${t.z}/${t.x}/${t.y} could not be placed: ${err.message}`);
          if (t.state === DECODED) t.state = UNLOADED;
        });
      })
      .catch((err) => {
        if (t.state === LOADING) t.state = UNLOADED;
        if (isAbort(err)) return;
        if (err.retry) {
          const { wait } = this.client.retryIn(t, err, `tile ${t.z}/${t.x}/${t.y}`);
          t.retryAt = performance.now() + wait;
        } else {
          // A tile that cannot be read is no better on a second try.
          console.warn(`[vector] tile ${t.z}/${t.x}/${t.y}: ${err.message}`);
          this.client.noteFailure();
          this.#missing(t);
        }
      });
  }

  /* Not there, or not readable: never asked for again this session. */
  #missing(t) {
    t.state = MISSING;
    this.missing.add(t.key);
    if (this.missing.size > MISSING_MOST) this.missing.delete(this.missing.values().next().value);
    this.tiles.delete(t.key);
  }

  /* An arrived tile, during the frame's upload slice: into the buffer,
   * making room by dropping what has gone unwanted longest. */
  #place(t, result) {
    const block = result.block;
    if (t.state !== DECODED) { if (block) this.client.recycle(block); return; }
    t.segments = result.stats?.segments ?? 0;
    t.refs = result.stats?.refs ?? 0;
    if (!block) {
      // Nothing in it: the shared empty block, no memory of its own.
      t.offset = EMPTY;
      t.size = 0;
      t.state = READY;
      this.totals.empty++;
      if (!this.tiles.has(t.key)) this.tiles.set(t.key, t);
      this.#setPage(t, EMPTY);
      if (t.level === 0) this.version++;
      return;
    }
    const size = result.size;
    let at = this.pool.alloc(size);
    while (at < 0) {
      const victim = this.lru.stalest;
      if (!victim) break;
      // Kept for an arrival: not a candidate, look further.
      if (this.#wanted(victim)) { this.lru.touch(victim); continue; }
      this.#evict(victim);
      at = this.pool.alloc(size);
    }
    if (at < 0) {
      // Full of what is wanted: the farthest wait until something goes.
      t.state = UNLOADED;
      t.retryAt = performance.now() + RETRY_FULL_MS;
      this.totals.full++;
      this.client.recycle(block);
      return;
    }
    this.device.queue.writeBuffer(this.pool.buffer, at, block.buffer, block.byteOffset, size);
    // The detail zoom's blocks are kept here too, for the terrain: copied
    // to their exact size (the buffer they came in is a pooled one, up to
    // twice that), which goes back to be filled again.
    if (t.level === 0) {
      t.cpu = { block: block.slice(0, size), z: t.z, x: t.x, y: t.y, id: 0, pins: null, gaps: null };
      this.cpuBytes += size;
      t.widths = 0;
      t.stamp = t.widthStamp = t.deckStamp = 0;
      // Its bridges are looked at on the next frames (#refreshDecks).
      t.bridges = null;
      if (this.decks) this.deckDirty.add(t);
      this.version++;
    }
    this.client.recycle(block);
    t.offset = at;
    t.size = size;
    t.state = READY;
    this.lru.add(t);
    if (!this.tiles.has(t.key)) this.tiles.set(t.key, t);
    this.#setPage(t, at / 4);
    // Matched before this session dropped it: its widths at once.
    const codes = t.level === 0 ? this.widthsMemo.get(t.key) : null;
    if (codes) this.#applyWidths(t, codes);
  }

  #dropCpu(t) {
    if (!t.cpu) return;
    this.cpuBytes -= t.cpu.block.byteLength;
    t.cpu = null;
    t.widths = 0;
    t.stamp = t.widthStamp = t.deckStamp = 0;
    t.bridges = null;
    this.deckDirty.delete(t);
    this.version++;
  }

  #evict(t) {
    if (t.state !== READY) return;
    if (t.size > 0) this.pool.release(t.offset, t.size);
    this.#dropCpu(t);
    this.lru.remove(t);
    this.#setPage(t, ABSENT);
    t.state = UNLOADED;
    t.offset = -1;
    t.size = 0;
    this.totals.evicted++;
  }

  /* A tile's entry in its zoom's page table, if it lies in the window. */
  #setPage(t, value) {
    const ox = this.origins[t.level * 2], oy = this.origins[t.level * 2 + 1];
    const i = t.x - ox, j = t.y - oy;
    if (i < 0 || j < 0 || i >= WINDOW || j >= WINDOW || this.levels[t.level] !== t.z) return;
    this.pages[t.level * WINDOW * WINDOW + j * WINDOW + i] = value;
    this.pagesDirty = true;
  }

  #rebuildPages() {
    for (let l = 0; l < LEVELS; l++) {
      const z = this.levels[l], ox = this.origins[l * 2], oy = this.origins[l * 2 + 1];
      for (let j = 0; j < WINDOW; j++) {
        for (let i = 0; i < WINDOW; i++) {
          const t = this.tiles.get(keyOf(z, ox + i, oy + j));
          this.pages[l * WINDOW * WINDOW + j * WINDOW + i] = t && t.state === READY ? t.offset / 4 : ABSENT;
        }
      }
    }
    this.pagesDirty = true;
  }

  /**
   * Prepares the tiles round a place a flight will arrive at (preload
   * class); adds to `counts` { have, need }.
   */
  preload(lon, lat, counts = null) {
    if (!this.enabled || !this.source) return 0;
    const now = performance.now(), mx = mercX(lon), my = mercY(lat);
    // The exact widths there are matched too, once its tiles are in (#planWidths).
    this.arrival = { mx, my, until: now + PRELOAD_LIFE_MS };
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const jobs = this.preQueue;
    jobs.length = 0;
    let have = 0, need = 0;
    for (let l = 0; l < LEVELS; l++) {
      const z = this.levels[l], n = 2 ** z, tileMetres = (EARTH * cosLat) / n;
      const reach = Math.min(PRELOAD_REACH[l], l === 0 ? this.detailDistance : this.distance);
      const span = Math.ceil(reach / tileMetres);
      const cx = Math.floor(mx * n), cy = Math.floor(my * n);
      for (let ty = cy - span; ty <= cy + span; ty++) {
        for (let tx = cx - span; tx <= cx + span; tx++) {
          const dx = Math.max(tx - mx * n, 0, mx * n - (tx + 1)) * tileMetres;
          const dy = Math.max(ty - my * n, 0, my * n - (ty + 1)) * tileMetres;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > reach || !this.#covered(l, tx, ty)) continue;
          const key = keyOf(z, tx, ty);
          if (this.missing.has(key)) continue;
          let t = this.tiles.get(key);
          if (!t) this.tiles.set(key, (t = this.#record(l, z, tx, ty, key)));
          t.preloadUntil = now + PRELOAD_LIFE_MS;
          this.lru.touch(t);
          if (t.state === READY) { have++; continue; }
          need++;
          if (t.state === UNLOADED) { t.score = d / tileMetres + (l === 0 ? 0.6 : 0); jobs.push(t); }
        }
      }
    }
    jobs.sort(byScore);
    this.preAt = 0;
    if (counts) { counts.have += have; counts.need += need; }
    return jobs.length;
  }

  /* ---- for the terrain ------------------------------------------------------ */

  /* The detail zoom's tiles over a rectangle in degrees, into `out`: their
   * records, or null for a tile that has nothing (outside the country, not
   * there at all). False if one is not here yet. */
  #covering(rect, out) {
    out.length = 0;
    if (!this.source || !this.cover) return false;
    const z = this.levels[0], n = 2 ** z;
    // Just inside the east and south edges: a tile ending on a tile line
    // does not reach into the next.
    const x0 = Math.floor(mercX(rect.west) * n), x1 = Math.floor(mercX(rect.east) * n - 1e-9);
    const y0 = Math.floor(mercY(rect.north) * n), y1 = Math.floor(mercY(rect.south) * n - 1e-9);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = keyOf(z, x, y);
        if (!this.#covered(0, x, y) || this.missing.has(key)) { out.push(null); continue; }
        const t = this.tiles.get(key);
        if (!t || t.state !== READY || (t.size > 0 && !t.cpu)) return false;
        out.push(t.size > 0 ? t : null);
      }
    }
    return true;
  }

  /**
   * What the roads over a terrain tile's rectangle (degrees) are, as a
   * number: ROADS_NOT_READY while one of the detail tiles over it is not
   * here, else one that changes only when what is cut in would (a tile's
   * exact widths arriving; not a tile dropped and loaded again). Cheap: no
   * pieces are made.
   */
  roadsSig(rect) {
    if (!this.enabled || this.shapeDistance <= 0) return ROADS_NOT_READY;
    const tiles = this.coverScratch;
    if (!this.#covering(rect, tiles)) return ROADS_NOT_READY;
    let h = 2166136261;
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      h = Math.imul(h ^ (t ? t.key % 4294967296 : i + 1), 16777619);
      h = Math.imul(h ^ (t ? t.stamp : 0x9e3779b9), 16777619);
    }
    return (h >>> 0) || 1;
  }

  /**
   * Whether roads over a rectangle are on their way: a detail tile over it
   * wanted and not here yet. Exact widths are not waited for (since Stage
   * 5.16b): a tile is cut with its kinds' widths at once, and cut again when
   * the exact ones move an edge far enough (terrain.js #accept).
   */
  roadsPending(rect) {
    if (!this.enabled || !this.source || this.shapeDistance <= 0) return false;
    const z = this.levels[0], n = 2 ** z, now = performance.now();
    const x0 = Math.floor(mercX(rect.west) * n), x1 = Math.floor(mercX(rect.east) * n - 1e-9);
    const y0 = Math.floor(mercY(rect.north) * n), y1 = Math.floor(mercY(rect.south) * n - 1e-9);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = this.tiles.get(keyOf(z, x, y));
        if (t && t.state !== READY && this.#wanted(t, now)) return true;
      }
    }
    return false;
  }

  /**
   * The pieces to cut into a terrain tile (pieces.js): { pieces, sig }, the
   * pieces a fresh Float32Array (null if there are none) that can be handed
   * to a decode thread, the signature as roadsSig gives it. Null while the
   * roads there are not all here.
   */
  roadsFor(rect) {
    const sig = this.roadsSig(rect);
    if (sig === ROADS_NOT_READY) return null;
    const out = this.scratch;
    out.count = 0;
    const tiles = this.coverScratch;
    for (let i = 0; i < tiles.length; i++) {
      if (!tiles[i]) continue;
      tiles[i].cpu.id = i;
      piecesFor([tiles[i].cpu], rect, this.shapeKinds, this.halfWidths, out);
    }
    return { pieces: out.count ? out.data.slice(0, out.count * PIECE_FLOATS) : null, sig };
  }

  /** The numbers, for the panel and the probe (twice a second, not every frame). */
  get stats() {
    const levels = [];
    for (let l = 0; l < LEVELS; l++) levels.push({ z: this.levels[l], ready: 0, empty: 0, loading: 0, wanted: 0 });
    let ready = 0, loading = 0, segments = 0, refs = 0;
    for (const t of this.tiles.values()) {
      const v = levels[t.level];
      if (t.wanted === this.planStamp) v.wanted++;
      if (t.state === READY) {
        ready++; v.ready++; segments += t.segments; refs += t.refs;
        if (t.size === 0) v.empty++;
      } else if (t.state === LOADING || t.state === DECODED) { loading++; v.loading++; }
    }
    return {
      enabled: this.enabled, source: this.source ? this.source.describe() : null, levels, ready, loading, segments, refs,
      missing: this.missing.size, bytes: this.pool.used - 256, budget: this.pool.size, largestFree: this.pool.largest,
      blocks: this.pool.blocks - 1, records: this.tiles.size, cpuBytes: this.cpuBytes, version: this.version,
      widths: { ...this.widthTotals, waiting: this.widthQueue.length, jobs: this.widthJobs, on: this.widthsOn && Boolean(this.widthRules) },
      bridges: this.#bridgeStats(),
      distance: this.distance, detailDistance: this.detailDistance, shapeDistance: this.shapeDistance, ...this.totals,
    };
  }

  /* Detail tiles with bridges joined to their decks, and their pins and gaps. */
  #bridgeStats() {
    let tiles = 0, pins = 0, gaps = 0, runs = 0;
    for (const t of this.tiles.values()) {
      if (!t.cpu) continue;
      runs += t.bridges?.length ?? 0;
      if (!t.cpu.pins) continue;
      tiles++;
      pins += t.cpu.pins.length / PIN_FLOATS;
      gaps += t.cpu.gaps?.size ?? 0;
    }
    return { tiles, runs, pins, gaps, waiting: this.deckDirty.size, on: Boolean(this.decks?.active) };
  }

  /** The page tables as the GPU has them, for the probe: per zoom, rows of # (a tile), o (empty), . (none). */
  pagesReport() {
    const out = [];
    for (let l = 0; l < LEVELS; l++) {
      let rows = '';
      for (let j = 0; j < WINDOW; j++) {
        for (let i = 0; i < WINDOW; i++) {
          const v = this.pages[l * WINDOW * WINDOW + j * WINDOW + i];
          rows += v === ABSENT ? '.' : v === EMPTY ? 'o' : '#';
        }
        if (j + 1 < WINDOW) rows += '/';
      }
      out.push({ z: this.levels[l], origin: [this.origins[l * 2], this.origins[l * 2 + 1]], pages: rows });
    }
    return out;
  }
}
