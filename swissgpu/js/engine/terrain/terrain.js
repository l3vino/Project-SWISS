/* terrain.js — deciding which tiles exist on the GPU right now.
 *
 * Step 1a streams a single detail level in a ring around the camera. That is
 * deliberately not the final scheme: the quadtree with screen-space-error
 * refinement lands in 1b. What this does establish is everything the quadtree
 * will sit on top of, namely routing through the registry, a bounded number of
 * requests in flight, a negative cache for tiles that do not exist, and GPU
 * buffers that are released the moment a tile leaves the set.
 */

import { tileAt, tileRect, tileKey, tilesX, tilesY } from './tiling.js';
import { rectIntersects } from '../../adapters/adapter.js';
import { TerrainSource } from './source.js';
import { VERTEX_STRIDE } from './format.js';

const PENDING = 0, READY = 1, MISSING = 2;

export class Terrain {
  constructor({ device, pool, registry, level = 10, radius = 6 }) {
    this.device = device;
    this.pool = pool;
    this.registry = registry;
    this.level = level;
    this.radius = radius;

    this.sources = new Map();   // adapter id -> TerrainSource
    this.tiles = new Map();     // key -> record
    this.visible = [];          // records with geometry, rebuilt when the set changes
    this.inFlight = 0;
    this.maxInFlight = Math.max(4, pool.size * 2);
    this.queue = [];
    this.centre = null;
    this.bytes = 0;
    this.stats = { ready: 0, pending: 0, missing: 0, bytes: 0 };
  }

  /**
   * Ask every registered service what it actually offers, once, before any
   * tile is requested. Doing this up front is what lets tile selection below
   * stay synchronous.
   */
  async prepare() {
    const jobs = this.registry.all
      .filter((adapter) => adapter.terrain)
      .map(async (adapter) => {
        const source = await TerrainSource.load(adapter, adapter.terrain);
        if (source) this.sources.set(adapter.id, source);
      });
    await Promise.all(jobs);
    return [...this.sources.values()].map((s) => s.describe());
  }

  configure({ level, radius }) {
    let changed = false;
    if (level !== undefined && level !== this.level) { this.level = level; changed = true; }
    if (radius !== undefined && radius !== this.radius) { this.radius = radius; changed = true; }
    if (changed) { this.#clear(); this.centre = null; }
  }

  /**
   * Called every frame but only does work when the camera has crossed into a
   * new tile. Tile selection at a fixed level cannot change otherwise, and
   * rebuilding the wanted set sixty times a second to get the same answer is
   * the kind of waste that never shows up in a profile as one big number.
   */
  update(camera) {
    const here = tileAt(this.level, camera.lon, camera.lat);
    if (!this.centre || here.x !== this.centre.x || here.y !== this.centre.y) {
      this.centre = here;
      this.#rebuild(here);
    }
    this.#pump();
  }

  #rebuild(centre) {
    const z = this.level, r = this.radius;
    const nx = tilesX(z), ny = tilesY(z);
    const wanted = new Set();
    const candidates = [];

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = centre.x + dx, y = centre.y + dy;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;

        const rect = tileRect(z, x, y);
        // Ask who serves this rectangle rather than assuming a country. A tile
        // on the border is offered to every adapter that reaches it, best first.
        const providers = this.registry.providers('terrain', rect)
          .map(({ adapter }) => this.sources.get(adapter.id))
          .filter((source) => source && source.serves(z));
        if (!providers.length) continue;

        const key = tileKey(z, x, y);
        wanted.add(key);
        if (!this.tiles.has(key)) {
          candidates.push({ key, z, x, y, rect, providers, dist: dx * dx + dy * dy });
        }
      }
    }

    for (const [key, tile] of this.tiles) {
      if (!wanted.has(key)) { this.#release(tile); this.tiles.delete(key); }
    }

    // Nearest first: what is under you matters more than what is at the edge.
    candidates.sort((a, b) => a.dist - b.dist);
    this.queue = candidates;
    this.#refreshVisible();
  }

  #pump() {
    while (this.inFlight < this.maxInFlight && this.queue.length) {
      const job = this.queue.shift();
      if (this.tiles.has(job.key)) continue;
      const record = { ...job, state: PENDING, vbuf: null, ibuf: null };
      this.tiles.set(job.key, record);
      this.inFlight++;
      this.#load(record).finally(() => { this.inFlight--; });
    }
  }

  async #load(record) {
    for (const source of record.providers) {
      if (!rectIntersects(source.adapter.rect, record.rect)) continue;
      const url = source.urlFor(record.z, record.x, record.y);
      try {
        const result = await this.pool.run('terrain-tile', { url, rect: record.rect },
          { cost: 4, timeout: 20000 });
        if (result.missing) continue;   // this source has no tile here: try the next
        if (!this.tiles.has(record.key)) return;  // evicted while in flight
        this.#upload(record, result);
        return;
      } catch (err) {
        console.warn(`[terrain] ${record.z}/${record.x}/${record.y} from ${source.adapter.id}: ${err.message}`);
      }
    }
    record.state = MISSING;   // nobody has it; never ask again
    this.#refreshVisible();
  }

  #upload(record, r) {
    const device = this.device;
    const vbuf = device.createBuffer({
      label: `tile-v-${record.z}/${record.x}/${record.y}`,
      size: r.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    const ibuf = device.createBuffer({
      label: `tile-i-${record.z}/${record.x}/${record.y}`,
      size: Math.ceil(r.indices.byteLength / 4) * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vbuf, 0, r.vertices);
    device.queue.writeBuffer(ibuf, 0, r.indices);

    record.vbuf = vbuf;
    record.ibuf = ibuf;
    record.indexCount = r.indexCount;
    record.indexFormat = r.indexIsU32 ? 'uint32' : 'uint16';
    record.origin = r.origin;               // [x, y, z] absolute ECEF, doubles
    record.minHeight = r.minHeight;
    record.maxHeight = r.maxHeight;
    record.radiusMetres = r.radius;
    record.vertexCount = r.vertices.byteLength / VERTEX_STRIDE;
    record.bytes = r.vertices.byteLength + r.indices.byteLength;
    record.state = READY;

    this.bytes += record.bytes;
    this.#refreshVisible();
  }

  #release(tile) {
    tile.vbuf?.destroy();
    tile.ibuf?.destroy();
    if (tile.bytes) this.bytes -= tile.bytes;
    tile.vbuf = tile.ibuf = null;
  }

  #clear() {
    for (const tile of this.tiles.values()) this.#release(tile);
    this.tiles.clear();
    this.queue.length = 0;
    this.#refreshVisible();
  }

  #refreshVisible() {
    this.visible = [];
    let ready = 0, pending = 0, missing = 0;
    for (const tile of this.tiles.values()) {
      if (tile.state === READY) { this.visible.push(tile); ready++; }
      else if (tile.state === PENDING) pending++;
      else missing++;
    }
    this.stats = { ready, pending, missing, bytes: this.bytes };
  }

  destroy() { this.#clear(); }
}
