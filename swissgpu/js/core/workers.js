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
 * A pool that routes each job to the least-loaded worker.
 *
 * Load is tracked as accumulated cost in a Float64Array rather than a queue
 * length, because tile jobs are wildly uneven: one 40 KB terrain tile is worth
 * many small image decodes, and counting jobs would pile them onto one thread.
 */
export class WorkerPool {
  /** All threads start in parallel; one slow start does not delay the rest. */
  static async create(moduleUrl, size, namePrefix = 'worker') {
    const workers = await Promise.all(
      Array.from({ length: size }, (_, i) => spawnWorker(moduleUrl, `${namePrefix}-${i}`)));
    return new WorkerPool(workers);
  }

  constructor(workers) {
    this.workers = workers;
    this.size = workers.length;
    this.load = new Float64Array(this.size);
  }

  get spawnMode() { return this.workers[0]?.spawnMode ?? 'none'; }

  /** Index of the thread with the least outstanding cost. */
  pick() {
    let best = 0;
    for (let i = 1; i < this.size; i++) if (this.load[i] < this.load[best]) best = i;
    return best;
  }

  async run(type, payload, { cost = 1, transfer, timeout = 0 } = {}) {
    const i = this.pick();
    this.load[i] += cost;
    try {
      return await this.workers[i].request(type, payload, transfer, { timeout });
    } finally {
      this.load[i] -= cost;
    }
  }

  broadcast(type, payload) {
    for (const w of this.workers) w.send(type, payload);
  }

  all(type, payload, options) {
    return Promise.all(this.workers.map((w) => w.request(type, payload, undefined, options)));
  }

  destroy() { for (const w of this.workers) w.close(); }
}

/**
 * How many decode threads to run.
 *
 * More is not better: this pipeline is bound by network round trips and by the
 * single GPU queue, so past a handful of threads the extra workers only add
 * memory and scheduler pressure. Leave headroom for the main thread, the
 * render thread, and the browser's own compositor.
 */
export function suggestedCodecThreads() {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(5, cores - 3));
}
