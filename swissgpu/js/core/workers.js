/* workers.js — dynamic worker spawning and load-balanced dispatch.
 *
 * Workers are spawned from Blob URLs, as small as a Blob can be: the blob's
 * entire body is one dynamic import of an absolute URL. That keeps the worker
 * source in a normal, readable module file whose own relative imports still
 * resolve correctly, which they would not if the module body itself lived in
 * the blob, where relative specifiers resolve against `blob:` and fail.
 *
 * The blob URL is revoked only once the worker reports back. A module worker
 * fetches its script graph in parallel, long after the constructor returns, so
 * revoking on the next line races the fetch and the worker never starts. A
 * classic worker survives that; a module worker does not.
 *
 * `moduleUrl` must be absolute, or relative to this file. Callers should pass
 * `new URL('./path.js', import.meta.url)` so it resolves against them instead.
 */

import { Endpoint } from './rpc.js';

const READY_TIMEOUT_MS = 6000;

// Downgraded permanently the first time a blob-spawned worker refuses to start,
// so one failure costs one timeout rather than one per thread.
let spawnMode = 'blob';

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function connect(worker, name, blobUrl) {
  const endpoint = new Endpoint(worker, name);
  try {
    await withTimeout(endpoint.ready, READY_TIMEOUT_MS,
      `${name} did not report ready within ${READY_TIMEOUT_MS} ms`);
    return endpoint;
  } catch (err) {
    worker.terminate();
    throw err;
  } finally {
    // Safe now: the script graph has been fetched, or the attempt is over.
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

export async function spawnWorker(moduleUrl, name) {
  const abs = new URL(moduleUrl, import.meta.url).href;

  if (spawnMode === 'blob') {
    const blob = new Blob([`import(${JSON.stringify(abs)});`], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const endpoint = await connect(new Worker(blobUrl, { type: 'module', name }), name, blobUrl);
      endpoint.spawnMode = 'blob';
      return endpoint;
    } catch (blobError) {
      // Blob-hosted module workers are blocked by some policies and browsers.
      // Loading the module directly is equivalent, just not dynamic.
      spawnMode = 'direct';
      console.warn(`[workers] blob spawning unavailable, using direct module URLs. ${blobError.message}`);
    }
  }

  const endpoint = await connect(new Worker(abs, { type: 'module', name }), name, null);
  endpoint.spawnMode = 'direct';
  return endpoint;
}

/**
 * A pool that routes each job to the least-loaded worker, and can grow and
 * shrink while in use.
 *
 * Load is tracked as accumulated cost rather than a queue length, because
 * tile jobs are wildly uneven: one 40 KB terrain tile is worth many small
 * image decodes, and counting jobs would pile them onto one thread.
 *
 * A worker taken out of the pool finishes what it was given and is closed
 * when its last job settles. New workers get the pool's `setup` message
 * (the wasm module, for the decode threads) before their first job.
 */
export class WorkerPool {
  /** All threads start in parallel; one slow start does not delay the rest. */
  static async create(moduleUrl, size, namePrefix = 'worker', setup = null) {
    const pool = new WorkerPool(moduleUrl, namePrefix, setup);
    await pool.resize(size);
    if (!pool.size) throw new Error(`no ${namePrefix} thread could be started`);
    return pool;
  }

  constructor(moduleUrl, namePrefix, setup) {
    this.moduleUrl = moduleUrl;
    this.namePrefix = namePrefix;
    this.setup = setup;           // { type, payload, timeout } sent to every new worker
    this.slots = [];              // { endpoint, load, jobs }
    this.spawned = 0;
    this.target = 0;
    this.resizing = Promise.resolve();
  }

  get size() { return this.slots.length; }
  get workers() { return this.slots.map((s) => s.endpoint); }
  get spawnMode() { return this.slots[0]?.endpoint.spawnMode ?? spawnMode; }
  /** Jobs out on any thread. */
  get jobs() { let n = 0; for (const s of this.slots) n += s.jobs; return n; }

  /**
   * Grows or shrinks to `size` threads. Growing starts the new ones in
   * parallel and adds each once it is set up; shrinking takes the newest out
   * at once (no new jobs) and closes each when its jobs are done.
   */
  resize(size) {
    this.target = Math.max(1, Math.round(size));
    this.resizing = this.resizing.then(() => this.#resize()).catch((err) => {
      console.warn(`[workers] resizing the ${this.namePrefix} pool: ${err.message}`);
    });
    return this.resizing;
  }

  async #resize() {
    while (this.slots.length > this.target) this.#retire(this.slots.pop());
    const missing = this.target - this.slots.length;
    if (missing <= 0) return;
    const started = await Promise.allSettled(Array.from({ length: missing }, async () => {
      const endpoint = await spawnWorker(this.moduleUrl, `${this.namePrefix}-${this.spawned++}`);
      if (this.setup) {
        try {
          await endpoint.request(this.setup.type, this.setup.payload, undefined, { timeout: this.setup.timeout ?? 15000 });
        } catch (err) {
          endpoint.close();
          throw err;
        }
      }
      return endpoint;
    }));
    for (const r of started) {
      if (r.status !== 'fulfilled') { console.warn(`[workers] ${r.reason?.message ?? r.reason}`); continue; }
      // Asked to shrink again meanwhile: not needed after all.
      if (this.slots.length >= this.target) { r.value.close(); continue; }
      this.slots.push({ endpoint: r.value, load: 0, jobs: 0 });
    }
  }

  #retire(slot) {
    slot.retired = true;
    if (slot.jobs === 0) slot.endpoint.close();
  }

  /** The thread with the least outstanding cost. */
  pick() {
    let best = this.slots[0];
    for (let i = 1; i < this.slots.length; i++) if (this.slots[i].load < best.load) best = this.slots[i];
    return best;
  }

  async run(type, payload, { cost = 1, transfer, timeout = 0, signal = null } = {}) {
    const slot = this.pick();
    if (!slot) throw new Error(`the ${this.namePrefix} pool has no threads`);
    slot.load += cost;
    slot.jobs++;
    try {
      return await slot.endpoint.request(type, payload, transfer, { timeout, signal });
    } finally {
      slot.load -= cost;
      slot.jobs--;
      if (slot.retired && slot.jobs === 0) slot.endpoint.close();
    }
  }

  broadcast(type, payload) {
    for (const s of this.slots) s.endpoint.send(type, payload);
  }

  /**
   * Buffers the caller is done with, back to the threads (transferred) to be
   * filled again (core/buffer-pool.js); each batch to the next thread in turn.
   */
  recycle(buffers) {
    const live = this.slots.filter((s) => !s.retired);
    if (!live.length || !buffers.length) return;
    const slot = live[(this.recycled = (this.recycled ?? 0) + 1) % live.length];
    slot.endpoint.send('recycle', { buffers }, buffers);
  }

  all(type, payload, options) {
    return Promise.all(this.slots.map((s) => s.endpoint.request(type, payload, undefined, options)));
  }

  destroy() {
    for (const s of this.slots) s.endpoint.close();
    this.slots.length = 0;
  }
}

/**
 * How many decode threads to run by default: half the logical cores less
 * one, at least two and at most eight (7 on a 16-thread CPU).
 *
 * More is not better: the pipeline is bound by network round trips and by
 * the single GPU queue, so past that the extra workers only add memory and
 * scheduler pressure. The rest is left for the page, the render thread, the
 * browser's own compositor and GPU process, and everything else running.
 */
export function suggestedCodecThreads(cores = navigator.hardwareConcurrency || 4) {
  return Math.max(2, Math.min(8, Math.floor(cores / 2) - 1));
}
