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
 * Tiles are decoded from JPEG on the codec threads, handed over as
 * ImageBitmaps without a copy, and compressed to BC1 by a compute shader as
 * they arrive: 4 bits a pixel in video memory instead of 32.
 */

import { mercX, mercY, worldPixels, xyzTileRect } from './mercator.js';
import { ImagerySource } from './source.js';

const TILE = 256;
const MAX_LEVELS = 16;
const BATCH = 8;                  // tiles encoded per frame, at most
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

const tileKey = (z, x, y) => z * 4398046511104 + x * 2097152 + y;

export class Clipmap {
  constructor({ device, pool, registry, caps, window = 16, zMin = 10 }) {
    this.device = device;
    this.pool = pool;
    this.registry = registry;
    this.compressed = caps.bc;
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
    this.planKey = '';
  }

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

    if (this.compressed) await this.#createEncoder();
    this.#allocate();
    this.enabled = true;
    return `z${this.zMin}-${this.zMax}, ${this.window}x${this.window} tiles a level, ` +
      `${this.compressed ? 'BC1' : 'uncompressed'}, ${(this.stats.bytes / 1048576).toFixed(0)} MB`;
  }

  /** Tiles per window side: the Imagery detail setting. Reallocates. */
  setWindow(n) {
    if (n === this.window) return;
    this.window = n;
    this.#allocate();
    this.planKey = '';
  }

  async #createEncoder() {
    const url = new URL('../shaders/bc1.wgsl', import.meta.url);
    const module = this.device.createShaderModule({ code: await (await fetch(url)).text(), label: 'bc1' });
    const info = await module.getCompilationInfo();
    for (const m of info.messages) if (m.type === 'error') throw new Error(`bc1.wgsl:${m.lineNum}: ${m.message}`);
    this.encoder = await this.device.createComputePipelineAsync({
      label: 'bc1', layout: 'auto', compute: { module, entryPoint: 'encode' },
    });
    this.staging = this.device.createTexture({
      label: 'imagery-staging', size: [TILE, TILE, BATCH], format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.blocks = this.device.createBuffer({
      label: 'imagery-blocks', size: BATCH * 4096 * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.encoderBind = this.device.createBindGroup({
      layout: this.encoder.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.staging.createView({ dimension: '2d-array' }) },
        { binding: 1, resource: { buffer: this.blocks } },
      ],
    });
  }

  #allocate() {
    this.texture?.destroy();
    this.residency?.destroy();
    const n = this.window, layers = Math.max(1, this.levelCount || 1);
    const size = n * TILE;

    this.texture = this.device.createTexture({
      label: 'imagery-clipmap',
      size: [size, size, layers],
      format: this.compressed ? 'bc1-rgba-unorm-srgb' : 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST |
        (this.compressed ? 0 : GPUTextureUsage.RENDER_ATTACHMENT),
    });
    this.stats.bytes = size * size * layers * (this.compressed ? 0.5 : 4);

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
    for (const u of this.uploads) u.bitmap.close();
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

    // Re-plan only when something that decides the plan changed.
    const planKey = `${this.topIndex}|${Math.round(view.reach / 1000)}|${Math.round(Math.log2(nearest) * 2)}`;
    if (moved || planKey !== this.planKey) {
      this.planKey = planKey;
      this.#plan(camera, view, mx, my, metresPerPixelAtZ0, pixelAngle, nearest);
    }

    this.#pump();
    this.#upload();
    this.#writeUniforms();
  }

  /**
   * Decide which tiles are worth fetching and in what order. A level is only
   * requested where it will actually be sampled: fine levels near you, coarse
   * levels out to the edge of the terrain, nothing beyond it.
   */
  #plan(camera, view, mx, my, metresPerPixelAtZ0, pixelAngle, nearest) {
    const n = this.window;
    const sy = Math.sin(camera.yaw), cy = Math.cos(camera.yaw);
    const candidates = [];

    for (let i = 0; i <= this.topIndex; i++) {
      const L = this.levels[i];
      if (!L.active) continue;
      const count = 2 ** L.z;
      const tileMetres = metresPerPixelAtZ0 * TILE / count;
      // Beyond this distance a coarser level already matches the pixel size.
      const useful = (metresPerPixelAtZ0 / count) * BLEND_REACH / pixelAngle;
      const limit = Math.min(useful, view.reach);

      // Tile ranges some source covers at this zoom. Tiles outside every one
      // are not asked for at all: an ocean away from any country with a
      // service is not a zoom level the service lacks.
      const covered = [];
      for (const s of this.sources) {
        if (!s.serves(L.z)) continue;
        const r = s.adapter.rect;
        covered.push(Math.floor(mercX(r.west) * count), Math.floor(mercX(r.east) * count),
                     Math.floor(mercY(r.north) * count), Math.floor(mercY(r.south) * count));
      }
      if (!covered.length) continue;

      for (let ty = L.oy; ty < L.oy + n; ty++) {
        for (let tx = L.ox; tx < L.ox + n; tx++) {
          let served = false;
          for (let k = 0; k < covered.length && !served; k += 4) {
            served = tx >= covered[k] && tx <= covered[k + 1] && ty >= covered[k + 2] && ty <= covered[k + 3];
          }
          if (!served) continue;
          // Offset of the tile centre from the camera, in metres east and north.
          const east = (tx + 0.5 - mx * count) * tileMetres;
          const north = -(ty + 0.5 - my * count) * tileMetres;
          const across = Math.max(0, Math.hypot(east, north) - tileMetres * 0.71);
          const distance = Math.hypot(across, nearest);
          if (i > 0 && distance > limit) continue;
          if (i === 0 && across > view.reach) continue;

          const key = tileKey(L.z, tx, ty);
          if (this.#holds(i, tx, ty) || this.pending.has(key) || this.missing.has(key)) continue;
          const behind = east * sy + north * cy < -tileMetres;
          // Distance counted in this level's own tiles, so every level's
          // nearest ring comes before any level's far ring: the coarse tile
          // under you still arrives first, but the sharp tiles at your feet
          // no longer wait behind coarse ones two hundred kilometres away.
          // A slight lean towards coarse levels keeps a fallback under
          // everything early; what is behind you waits a little.
          candidates.push({ i, z: L.z, x: tx, y: ty, key,
            score: distance / tileMetres + i * 0.25 + (behind ? 2 : 0) });
        }
      }
    }
    candidates.sort((a, b) => a.score - b.score);
    this.queue = candidates;
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
    while (this.inFlight < this.maxInFlight && this.queue.length) {
      const job = this.queue.shift();
      if (!this.#inWindow(job.i, job.x, job.y) || this.#holds(job.i, job.x, job.y)) continue;
      if (this.pending.has(job.key) || this.missing.has(job.key)) continue;
      this.pending.add(job.key);
      this.inFlight++;
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
        const result = await this.pool.run('imagery-tile',
          { url: source.urlFor(job.z, job.x, job.y), size: TILE }, { cost: 1, timeout: 20000 });
        if (result.missing) continue;
        this.levels[job.i].hits++;
        if (!this.#inWindow(job.i, job.x, job.y)) { result.bitmap.close(); return; }
        this.uploads.push({ ...job, bitmap: result.bitmap });
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
      this.planKey = '';
    }
  }

  /** Encode and place up to one batch of arrived tiles. */
  #upload() {
    if (!this.uploads.length) return;
    const device = this.device;
    const batch = [];
    while (batch.length < BATCH && this.uploads.length) {
      const u = this.uploads.shift();
      // Something newer may have claimed the slot, or the window moved on.
      if (!this.#inWindow(u.i, u.x, u.y) || this.#holds(u.i, u.x, u.y)) { u.bitmap.close(); continue; }
      batch.push(u);
    }
    if (!batch.length) return;

    const n = this.window;
    if (this.compressed) {
      batch.forEach((u, k) => {
        device.queue.copyExternalImageToTexture({ source: u.bitmap }, { texture: this.staging, origin: [0, 0, k] }, [TILE, TILE]);
        u.bitmap.close();
      });
      const encoder = device.createCommandEncoder({ label: 'imagery-encode' });
      const pass = encoder.beginComputePass({ label: 'bc1' });
      pass.setPipeline(this.encoder);
      pass.setBindGroup(0, this.encoderBind);
      pass.dispatchWorkgroups(8, 8, batch.length);
      pass.end();
      batch.forEach((u, k) => {
        encoder.copyBufferToTexture(
          { buffer: this.blocks, offset: k * 32768, bytesPerRow: 512, rowsPerImage: 64 },
          { texture: this.texture, origin: [(u.x % n) * TILE, (u.y % n) * TILE, u.i] },
          [TILE, TILE, 1]);
      });
      device.queue.submit([encoder.finish()]);
    } else {
      for (const u of batch) {
        device.queue.copyExternalImageToTexture({ source: u.bitmap },
          { texture: this.texture, origin: [(u.x % n) * TILE, (u.y % n) * TILE, u.i] }, [TILE, TILE]);
        u.bitmap.close();
      }
    }

    // Only now does the shader get told the slot holds this tile.
    for (const u of batch) {
      const s = this.#slotIndex(u.i, u.x, u.y);
      this.slots[s] = u.x;
      this.slots[s + 1] = u.y;
      device.queue.writeBuffer(this.residency, s * 4, this.slots, s, 2);
    }
  }

  #writeUniforms() {
    const f = this.uniformF32, u = this.uniformU32, n = this.window;
    const base = (MAX_LEVELS * LEVEL_BYTES) / 4;
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
        if (L.active) {
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
    this.device.queue.writeBuffer(this.uniforms, 0, this.uniformData);

    this.stats.resident = resident;
    // Everything wanted and not yet drawable: queued, on the wire, or decoded
    // and waiting for its encode batch.
    this.stats.loading = this.queue.length + this.inFlight + this.uploads.length;
    this.stats.missing = this.missing.size;
    this.stats.top = (this.zMin ?? 0) + (this.topIndex ?? 0);
    this.stats.disabled = this.levels ? this.levels.filter((l) => l.disabled).map((l) => l.z) : [];
  }

  destroy() {
    this.texture?.destroy();
    this.residency?.destroy();
    this.uniforms.destroy();
    this.staging?.destroy();
    this.blocks?.destroy();
    for (const u of this.uploads) u.bitmap.close();
  }
}
