/* clipmap.js — aerial imagery as a stack of windows centred under the camera.
 *
 * Each zoom level keeps a square window of tiles around you in one layer of a
 * texture array: the finest level covers a couple of hundred metres at 10 cm
 * a pixel, and each coarser level covers twice the distance at half the
 * detail, out to the edge of the terrain. That decouples imagery detail from
 * terrain tile size entirely, which is what makes 10 cm photos possible on
 * terrain tiles ten kilometres across.
 *
 * Windows are toroidal. A tile always lives in slot (x mod N, y mod N), so as
 * you move, the tiles entering one edge overwrite the ones that left the
 * other, and nothing else moves. Sampling wraps the same way, so hardware
 * filtering carries straight across the seam.
 *
 * The shader only trusts a slot that a residency table says holds exactly the
 * tile it needs; anything else falls through to the next coarser level. That
 * is why streaming shows blur rather than holes or stale tiles.
 *
 * Tiles are decoded from JPEG and block-compressed on the decode threads, by
 * the C core (wasm/src/bc.c): BC7 at 8 bits a pixel (sixteen shades per 4x4
 * block, no visible grain) or, on the Standard quality setting, BC1 at 4 bits
 * (four shades, which shows as speckle in trees and tiled roofs). Plain RGBA
 * would be 32. The render thread's whole share of a photo is then one small
 * copy into the texture, during its per-frame upload slice.
 */

import { mercX, mercY, worldPixels, xyzTileRect } from './mercator.js';
import { ImagerySource } from './source.js';

const TILE = 256;
const MAX_LEVELS = 16;
const BATCH = 8;                  // tiles placed per frame, at most
const POSTS_PER_FRAME = 8;        // requests sent to the decode threads per frame, at most
const EMPTY = 0xFFFFFFFF;
const LEVEL_BYTES = 32;
const UNIFORM_BYTES = MAX_LEVELS * LEVEL_BYTES + 32;
const EARTH_CIRCUMFERENCE = 40075016.686;
/* How far out a level is still sampled, as a multiple of the distance at
 * which its texels exactly match a screen pixel. The shader picks a level
 * from the short axis of a pixel's footprint on the ground, which is the same
 * width however low the view, and blends towards the next finer level; so a
 * level is used out to where the next coarser one matches: twice as far. */
const BLEND_REACH = 2;
/* A level whose first requests all come back empty is not served at all. */
const DISABLE_AFTER_MISSES = 16;
/* Windows sliding along under a moving camera are re-planned this often. */
const PLAN_INTERVAL_MS = 100;

const tileKey = (z, x, y) => z * 4398046511104 + x * 2097152 + y;

export class Clipmap {
  constructor({ device, pool, registry, caps, uploads = null, window = 16, zMin = 10, quality = 'high', sharpness = 0.35 }) {
    this.device = device;
    this.pool = pool;
    this.slice = uploads;         // shared per-frame upload slice (engine/uploads.js)
    this.registry = registry;
    this.compressed = caps.bc;
    this.codec = quality === 'standard' ? 'bc1' : 'bc7';
    this.sharpness = sharpness;   // levels of blur added: 0 sharpest, more is softer
    this.window = window;
    this.zMinWanted = zMin;

    this.sources = [];
    this.enabled = false;
    this.anchor = { x: 0, y: 0 };
    this.stats = { resident: 0, loading: 0, missing: 0, top: 0, bytes: 0, disabled: [] };

    this.layout = device.createBindGroupLayout({
      label: 'imagery',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.sampler = device.createSampler({
      label: 'imagery',
      addressModeU: 'repeat', addressModeV: 'repeat',
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      maxAnisotropy: 16,
    });
    this.uniformData = new ArrayBuffer(UNIFORM_BYTES);
    this.uniformF32 = new Float32Array(this.uniformData);
    this.uniformU32 = new Uint32Array(this.uniformData);
    this.uniforms = device.createBuffer({
      label: 'imagery-levels', size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.queue = [];              // tiles worth requesting, best first
    this.pending = new Set();
    this.missing = new Map();     // key -> true, oldest first, bounded
    this.uploads = [];            // decoded tiles waiting for a batch
    this.inFlight = 0;
    this.maxInFlight = Math.max(8, pool.size * 3);
    this.paused = false;          // no new requests (diagnostics)
    // What the last plan was made for; numbers, compared without building a key.
    this.planTop = -1;
    this.planReach = -1;
    this.planNear = -1;
  }

  /** Stops sending requests (for diagnosing), or resumes. */
  pause(on) { this.paused = Boolean(on); }

  /* Makes the next update re-plan whatever the camera does. */
  #replan() { this.planTop = -1; }

  /** Reads the registry, compiles the encoder, allocates the texture. */
  async prepare() {
    this.sources = this.registry.all.map((a) => ImagerySource.from(a)).filter(Boolean);
    if (!this.sources.length) { this.#allocate(); return 'no imagery source'; }

    const top = Math.max(...this.sources.map((s) => s.maxLevel));
    const bottom = Math.max(this.zMinWanted, Math.min(...this.sources.map((s) => s.minLevel)));
    this.zMax = top;
    this.zMin = Math.max(bottom, top - MAX_LEVELS + 1);
    this.levelCount = this.zMax - this.zMin + 1;
    this.levels = Array.from({ length: this.levelCount }, (_, i) => ({
      z: this.zMin + i, ox: 0, oy: 0, active: false, hits: 0, misses: 0, disabled: false,
    }));

    this.blockBytes = this.codec === 'bc7' ? 16 : 8;
    this.#allocate();
    this.enabled = true;
    return `z${this.zMin}-${this.zMax}, ${this.window}x${this.window} tiles a level, ` +
      `${this.compressed ? this.codec.toUpperCase() : 'uncompressed'}, ${(this.stats.bytes / 1048576).toFixed(0)} MB`;
  }

  /** Imagery quality: 'high' is BC7, 'standard' BC1. Reloads the photos. */
  async setQuality(quality) {
    const codec = quality === 'standard' ? 'bc1' : 'bc7';
    if (codec === this.codec) return;
    this.codec = codec;
    this.blockBytes = codec === 'bc7' ? 16 : 8;
    if (!this.compressed || !this.enabled) return;
    this.#allocate();
    this.#replan();
  }

  /** Imagery sharpness: a level-of-detail bias, in zoom levels. */
  setSharpness(bias) { this.sharpness = Math.max(0, Number(bias) || 0); }

  /** Tiles per window side: the Imagery detail setting. Reallocates. */
  setWindow(n) {
    if (n === this.window) return;
    this.window = n;
    this.#allocate();
    this.#replan();
  }

  #allocate() {
    this.texture?.destroy();
    this.residency?.destroy();
    const n = this.window, layers = Math.max(1, this.levelCount || 1);
    const size = n * TILE;

    this.texture = this.device.createTexture({
      label: 'imagery-clipmap',
      size: [size, size, layers],
      format: this.compressed ? `${this.codec}-rgba-unorm-srgb` : 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        (this.compressed ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
    });
    this.stats.bytes = size * size * layers * (this.compressed ? this.blockBytes / 16 : 4);

    // The CPU keeps a mirror of what each slot holds; the GPU copy is what
    // the shader checks before trusting a texel.
    this.slots = new Uint32Array(layers * n * n * 2).fill(EMPTY);
    this.residency = this.device.createBuffer({
      label: 'imagery-residency', size: Math.max(16, this.slots.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.residency, 0, this.slots);

    this.bindGroup = this.device.createBindGroup({
      label: 'imagery',
      layout: this.layout,
      entries: [
        { binding: 0, resource: this.texture.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.uniforms } },
        { binding: 3, resource: { buffer: this.residency } },
      ],
    });
    for (const u of this.uploads) u.bitmap?.close();
    this.uploads.length = 0;
  }

  /**
   * Once per frame, before drawing.
   * @param view  { aboveGround, viewHeight, fovY, reach } — metres, pixels,
   *              radians, and how far the terrain is drawn, in metres.
   */
  update(camera, view) {
    if (!this.enabled) { this.#writeUniforms(); return; }

    const S = worldPixels(this.zMax);
    const mx = mercX(camera.lon), my = mercY(camera.lat);
    this.anchor.x = Math.floor(mx * S);
    this.anchor.y = Math.floor(my * S);

    /* The finest level worth having is the one whose texels match a screen
     * pixel on the nearest ground, straight below you. */
    const cosLat = Math.cos(camera.lat * Math.PI / 180);
    const metresPerPixelAtZ0 = (EARTH_CIRCUMFERENCE * cosLat) / TILE;
    const pixelAngle = (2 * Math.tan(view.fovY / 2)) / Math.max(1, view.viewHeight);
    const nearest = Math.max(1, view.aboveGround);
    let top = Math.ceil(Math.log2(metresPerPixelAtZ0 / (nearest * pixelAngle)));
    top = Math.min(top, this.zMax);
    for (const level of this.levels) if (level.disabled && level.z <= top) top = level.z - 1;
    top = Math.max(top, this.zMin);
    this.topIndex = top - this.zMin;

    /* Window placement: centred on the camera, one tile of slack. */
    const n = this.window;
    let moved = false;
    for (let i = 0; i < this.levelCount; i++) {
      const L = this.levels[i];
      const count = 2 ** L.z;
      const ox = Math.max(0, Math.min(count - n, Math.round(mx * count - n / 2)));
      const oy = Math.max(0, Math.min(count - n, Math.round(my * count - n / 2)));
      const active = i <= this.topIndex && !L.disabled;
      if (ox !== L.ox || oy !== L.oy || active !== L.active) moved = true;
      L.ox = ox; L.oy = oy; L.active = active;
    }

    // Re-plan when something that decides the plan changed: at once for the
    // levels in use or the reach, and for windows that slid along under a
    // moving camera, at most every few frames, since the queue left from
    // the last plan still holds the most urgent tiles.
    const reachKm = Math.round(view.reach / 1000), near = Math.round(Math.log2(nearest) * 2);
    const now = performance.now();
    const changed = this.topIndex !== this.planTop || reachKm !== this.planReach || near !== this.planNear;
    if (changed || (moved && !(now < this.plannedAt + PLAN_INTERVAL_MS))) {
      this.planTop = this.topIndex;
      this.planReach = reachKm;
      this.planNear = near;
      this.plannedAt = now;
      this.#plan(camera, view, mx, my, metresPerPixelAtZ0, pixelAngle, nearest);
    }

    if (!this.paused) this.#pump();
    this.#upload();
    this.#writeUniforms();
  }

  /**
   * Decide which tiles are worth fetching and in what order. A level is only
   * requested where it will actually be sampled: fine levels near you, coarse
   * levels out to the edge of the terrain, nothing beyond it. Only the part
   * of each window within that reach is looked at, and the candidate records
   * are reused from plan to plan, so a plan costs little even while flying.
   */
  #plan(camera, view, mx, my, metresPerPixelAtZ0, pixelAngle, nearest) {
    const n = this.window;
    const sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw);
    const pool = this.candidatePool ??= [];
    let used = 0;

    for (let i = 0; i <= this.topIndex; i++) {
      const L = this.levels[i];
      if (!L.active) continue;
      const count = 2 ** L.z;
      const tileMetres = metresPerPixelAtZ0 * TILE / count;
      // Beyond this distance a coarser level already matches the pixel size.
      const useful = (metresPerPixelAtZ0 / count) * BLEND_REACH / pixelAngle;
      const limit = i > 0 ? Math.min(useful, view.reach) : view.reach;

      // The tiles in the window within reach, clipped to what some source
      // covers at this zoom: an ocean away from any country with a service
      // is not a zoom level the service lacks.
      const span = Math.ceil(limit / tileMetres) + 1;
      const cx = Math.floor(mx * count), cyTile = Math.floor(my * count);
      let x0 = Math.max(L.ox, cx - span), x1 = Math.min(L.ox + n - 1, cx + span);
      let y0 = Math.max(L.oy, cyTile - span), y1 = Math.min(L.oy + n - 1, cyTile + span);
      let cover = null;
      for (const src of this.sources) {
        if (!src.serves(L.z)) continue;
        const r = src.adapter.rect;
        const c = [Math.floor(mercX(r.west) * count), Math.floor(mercX(r.east) * count),
                   Math.floor(mercY(r.north) * count), Math.floor(mercY(r.south) * count)];
        cover = cover ? [Math.min(cover[0], c[0]), Math.max(cover[1], c[1]), Math.min(cover[2], c[2]), Math.max(cover[3], c[3])] : c;
      }
      if (!cover) continue;
      x0 = Math.max(x0, cover[0]); x1 = Math.min(x1, cover[1]);
      y0 = Math.max(y0, cover[2]); y1 = Math.min(y1, cover[3]);

      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          // Offset of the tile centre from the camera, in metres east and north.
          const east = (tx + 0.5 - mx * count) * tileMetres;
          const north = -(ty + 0.5 - my * count) * tileMetres;
          const across = Math.max(0, Math.hypot(east, north) - tileMetres * 0.71);
          const distance = Math.hypot(across, nearest);
          if (i > 0 && distance > limit) continue;
          if (i === 0 && across > view.reach) continue;
          if (this.#holds(i, tx, ty)) continue;
          if (!this.#servedBySome(L.z, tx, ty, count)) continue;
          const key = tileKey(L.z, tx, ty);
          if (this.pending.has(key) || this.missing.has(key)) continue;
          const behind = east * sy + north * cy < -tileMetres;
          // Distance counted in this level's own tiles, so every level's
          // nearest ring comes before any level's far ring: the coarse tile
          // under you still arrives first, but the sharp tiles at your feet
          // no longer wait behind coarse ones two hundred kilometres away.
          // A slight lean towards coarse levels keeps a fallback under
          // everything early; what is behind you waits a little.
          const c = pool[used] ??= { i: 0, z: 0, x: 0, y: 0, key: 0, score: 0 };
          c.i = i; c.z = L.z; c.x = tx; c.y = ty; c.key = key;
          c.score = distance / tileMetres + i * 0.25 + (behind ? 2 : 0);
          used++;
        }
      }
    }
    const queue = this.queue;
    queue.length = used;
    for (let k = 0; k < used; k++) queue[k] = pool[k];
    queue.sort((a, b) => a.score - b.score);
    this.queueAt = 0;
  }

  /* Whether some source serves this exact tile: the union of coverage
   * rectangles above is only a bound when several countries are registered. */
  #servedBySome(z, x, y, count) {
    if (this.sources.length === 1) return true;
    for (const src of this.sources) {
      if (!src.serves(z)) continue;
      const r = src.adapter.rect;
      if (x >= Math.floor(mercX(r.west) * count) && x <= Math.floor(mercX(r.east) * count) &&
          y >= Math.floor(mercY(r.north) * count) && y <= Math.floor(mercY(r.south) * count)) return true;
    }
    return false;
  }

  #slotIndex(i, x, y) {
    const n = this.window;
    return ((i * n + (y % n)) * n + (x % n)) * 2;
  }

  #holds(i, x, y) {
    const s = this.#slotIndex(i, x, y);
    return this.slots[s] === x && this.slots[s + 1] === y;
  }

  #inWindow(i, x, y) {
    const L = this.levels[i];
    return L && x >= L.ox && y >= L.oy && x < L.ox + this.window && y < L.oy + this.window;
  }

  #pump() {
    // The queue is walked with a cursor, not shifted: its records are reused
    // by the next plan, so a job copies what it needs.
    const queue = this.queue;
    let posted = 0;
    while (this.inFlight < this.maxInFlight && this.queueAt < queue.length && posted < POSTS_PER_FRAME) {
      const c = queue[this.queueAt++];
      if (!this.#inWindow(c.i, c.x, c.y) || this.#holds(c.i, c.x, c.y)) continue;
      if (this.pending.has(c.key) || this.missing.has(c.key)) continue;
      const job = { i: c.i, z: c.z, x: c.x, y: c.y, key: c.key };
      this.pending.add(job.key);
      this.inFlight++;
      posted++;
      this.#load(job).finally(() => { this.inFlight--; this.pending.delete(job.key); });
    }
  }

  async #load(job) {
    const rect = xyzTileRect(job.z, job.x, job.y);
    const candidates = this.registry.providers('imagery', rect)
      .map(({ adapter }) => this.sources.find((s) => s.adapter === adapter))
      .filter((s) => s && s.serves(job.z));

    for (const source of candidates) {
      try {
        const codec = this.compressed ? this.codec : null;
        const result = await this.pool.run('imagery-tile',
          { url: source.urlFor(job.z, job.x, job.y), size: TILE, encode: codec }, { cost: 2, timeout: 20000 });
        if (result.missing) continue;
        this.levels[job.i].hits++;
        // The window moved on, or the quality changed while it was encoded.
        if (!this.#inWindow(job.i, job.x, job.y) || (result.codec ?? null) !== (this.compressed ? this.codec : null)) {
          result.bitmap?.close();
          return;
        }
        this.uploads.push({ ...job, bitmap: result.bitmap, blocks: result.blocks });
        return;
      } catch (err) {
        console.warn(`[imagery] ${job.z}/${job.x}/${job.y}: ${err.message}`);
      }
    }
    // Only an answer from a service counts against its zoom level.
    this.#markMissing(job, candidates.length > 0);
  }

  #markMissing(job, refused) {
    this.missing.set(job.key, true);
    if (this.missing.size > 20000) this.missing.delete(this.missing.keys().next().value);
    if (!refused) return;
    const L = this.levels[job.i];
    L.misses++;
    if (!L.disabled && L.hits === 0 && L.misses >= DISABLE_AFTER_MISSES) {
      L.disabled = true;
      console.info(`[imagery] zoom ${L.z} returned nothing ${L.misses} times; not requesting it again`);
      this.stats.disabled = this.levels.filter((l) => l.disabled).map((l) => l.z);
      this.#replan();
    }
  }

  /**
   * Places arrived tiles into their slots: a batch at most, and only while
   * this frame's upload slice has time left, though one always goes so
   * streaming never stalls. Compressed tiles arrive as finished blocks and
   * are a single copy each.
   */
  #upload() {
    const device = this.device, n = this.window;
    let placed = 0;
    while (placed < BATCH && this.uploads.length && (!placed || !this.slice || this.slice.hasTime)) {
      const u = this.uploads.shift();
      // Something newer may have claimed the slot, or the window moved on.
      if (!this.#inWindow(u.i, u.x, u.y) || this.#holds(u.i, u.x, u.y)) { u.bitmap?.close(); continue; }
      const origin = [(u.x % n) * TILE, (u.y % n) * TILE, u.i];
      if (u.blocks) {
        device.queue.writeTexture({ texture: this.texture, origin }, u.blocks,
          { bytesPerRow: 64 * this.blockBytes, rowsPerImage: 64 }, [TILE, TILE, 1]);
      } else {
        device.queue.copyExternalImageToTexture({ source: u.bitmap }, { texture: this.texture, origin }, [TILE, TILE]);
        u.bitmap.close();
      }
      // Only now does the shader get told the slot holds this tile.
      const s = this.#slotIndex(u.i, u.x, u.y);
      this.slots[s] = u.x;
      this.slots[s + 1] = u.y;
      device.queue.writeBuffer(this.residency, s * 4, this.slots, s, 2);
      placed++;
    }
  }

  #writeUniforms() {
    const f = this.uniformF32, u = this.uniformU32, n = this.window;
    const base = (MAX_LEVELS * LEVEL_BYTES) / 4;
    // Counting resident tiles walks every slot of every level: for the
    // readout only, so four times a second is plenty.
    const now = performance.now();
    const count = !(now < this.countedAt + 250);
    if (count) this.countedAt = now;
    let resident = 0;

    if (this.enabled) {
      for (let i = 0; i < this.levelCount; i++) {
        const L = this.levels[i], o = (i * LEVEL_BYTES) / 4;
        const scale = 2 ** (this.zMax - L.z);          // reference pixels per level texel
        // Window corner relative to the anchor: exact in doubles, small in floats.
        f[o + 0] = L.ox * TILE * scale - this.anchor.x;
        f[o + 1] = L.oy * TILE * scale - this.anchor.y;
        f[o + 2] = (L.ox % n) * TILE;
        f[o + 3] = (L.oy % n) * TILE;
        u[o + 4] = L.ox;
        u[o + 5] = L.oy;
        f[o + 6] = 1 / scale;
        u[o + 7] = L.active ? 1 : 0;
        if (count && L.active) {
          for (let y = L.oy; y < L.oy + n; y++) for (let x = L.ox; x < L.ox + n; x++) if (this.#holds(i, x, y)) resident++;
        }
      }
    }
    f[base + 0] = this.zMax ?? 0;
    f[base + 1] = this.zMin ?? 0;
    u[base + 2] = this.levelCount ?? 0;
    u[base + 3] = this.topIndex ?? 0;
    u[base + 4] = n;
    f[base + 5] = n * TILE;
    u[base + 6] = this.enabled ? 1 : 0;
    f[base + 7] = this.sharpness;
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformData);

    if (count) this.stats.resident = resident;
    // Everything wanted and not yet drawable: queued, on the wire, or decoded
    // and waiting for its encode batch.
    this.stats.loading = this.queue.length - (this.queueAt ?? 0) + this.inFlight + this.uploads.length;
    this.stats.missing = this.missing.size;
    this.stats.top = (this.zMin ?? 0) + (this.topIndex ?? 0);
  }

  destroy() {
    this.texture?.destroy();
    this.residency?.destroy();
    this.uniforms.destroy();
    for (const u of this.uploads) u.bitmap?.close();
  }
}
