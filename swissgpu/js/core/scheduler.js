/* scheduler.js — whose turn it is on the decode threads.
 *
 * Every layer that loads tiles (terrain, the photos, each building layer, the
 * physics ground) is a client here. Each keeps its own candidates, most
 * urgent first, and starts its own jobs; the scheduler decides whose turn it
 * is and how many jobs may be out at once (the approach of Cesium's request
 * scheduler and 3DTilesRendererJS's download queue, with fairer sharing):
 *
 *   - at most PER_THREAD jobs per decode thread in flight, so a tile that
 *     becomes urgent waits behind a handful, not behind fifty; and at most a
 *     cap per host, 24, halved whenever the host answers 429 and raised by
 *     one per success (additive increase, multiplicative decrease, as TCP
 *     does since Jacobson 1988);
 *   - physics first: jobs a body or a landing waits for (the ground under
 *     the camera, collision copies, tiles in the focus) go before anything
 *     else, from every client;
 *   - then the view, shared between the clients by deficit round robin
 *     (Shreedhar and Varghese 1995): each turn earns a client its weight in
 *     cost units and each job spends its cost, so a layer of heavy jobs
 *     (Draco buildings) cannot crowd out one of light jobs (photos) and none
 *     is starved by another's long queue;
 *   - preloading last, with whatever is left.
 *
 * A job started outside a turn (a layer's root file, a collision grid after
 * its read-back, the next service after one had nothing) waits for a free
 * slot, so the limit holds for every job, not only for the ones handed out.
 *
 * Ten times a second the jobs in flight for a tile are checked: one whose
 * tile its layer no longer wants is called off, which aborts its download in
 * the decode thread or drops its result there. A failure worth retrying comes
 * back to its layer, which waits `retryDelay` (1, 2, then 4 s with jitter,
 * or what the server asked for, at most 60 s); after MAX_ATTEMPTS in a row
 * the item rests a minute before it is tried again, so a service that is
 * down is not hammered and a passing outage leaves no holes for good.
 *
 * Results come in buffers the decode threads want back (core/buffer-pool.js):
 * a layer done with one hands it to `recycle`, and once a frame they go back
 * in one message.
 */

import { isAbort } from './rpc.js';
import { Returns } from './buffer-pool.js';

export const PHYSICS = 0, VIEW = 1, PRELOAD = 2;
const CLASSES = 3;

const PER_THREAD = 4;
const PER_HOST = 24;
const MIN_PER_HOST = 2;
/* Cost units a turn earns per unit of a client's weight (about one job). */
const QUANTUM = 4;
const STALE_CHECK_MS = 100;

export const MAX_ATTEMPTS = 3;
/* How long an item rests after MAX_ATTEMPTS failures in a row. */
export const REST_MS = 60000;
const RETRY_BASE_MS = 1000;
const RETRY_AFTER_MAX_S = 60;

/**
 * Milliseconds to wait before attempt `attempt + 1`, after `attempt` failed:
 * what the server asked for, else 1, 2, 4 s… with "equal jitter" (Brooker,
 * "Exponential backoff and jitter", 2015): half fixed, half random, so many
 * failures at once do not all come back at once.
 */
export function retryDelay(attempt, retryAfter) {
  if (Number.isFinite(retryAfter)) return Math.min(RETRY_AFTER_MAX_S, Math.max(0, retryAfter)) * 1000;
  const wait = RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  return wait / 2 + Math.random() * (wait / 2);
}

/** The host part of a URL, which per-host limits are counted by. */
export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  return m ? m[1].toLowerCase() : '';
}

class Client {
  /**
   * @param pick   (cls) => starts the client's most urgent job of that class
   *               (through `run`) and returns true, or returns false when it
   *               has none that can start now
   * @param stale  (item, cls) => whether a job's item is no longer wanted;
   *               asked only about jobs started with an `item`
   */
  constructor(scheduler, name, { weight = 1, pick, stale = null }) {
    this.scheduler = scheduler;
    this.name = name;
    this.weight = weight;
    this.pick = pick;
    this.stale = stale;
    this.deficit = new Float64Array(CLASSES);
    this.active = 0;
    this.lastCost = 0;
    this.checkFailed = false;   // its staleness check threw (reported once)
    this.stats = { started: 0, cancelled: 0, stale: 0, retries: 0, failed: 0 };
  }

  /** Whether one more job to `host` may start now. */
  canRun(host) { return this.scheduler.free(host); }

  /** Runs a job on a decode thread; see Scheduler.run. */
  run(type, payload, options) { return this.scheduler.run(this, type, payload, options); }

  /**
   * When to try a failed job again, for a failure worth retrying:
   * `retryDelay` after each one, and after MAX_ATTEMPTS in a row a rest of
   * REST_MS, after which the count starts over. `record.attempts` holds the
   * count (the tile itself, or a record the layer keeps for it); `label`
   * names it in the console. Returns { wait (ms), resting }.
   */
  retryIn(record, err, label) {
    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.attempts = 0;
      this.noteFailure();
      console.warn(`[${this.name}] ${label}: ${err.message}; trying again in ${REST_MS / 1000} s`);
      return { wait: REST_MS, resting: true };
    }
    this.stats.retries++;
    this.scheduler.stats.retries++;
    return { wait: retryDelay(record.attempts, err.retryAfter), resting: false };
  }

  /** A job given up on (for the session, or for a rest), for the panel. */
  noteFailure() { this.stats.failed++; this.scheduler.stats.failed++; }

  /** Calls off every job of this client in flight (a layer switched off). */
  cancelAll() { this.scheduler.cancel((job) => job.client === this); }

  /** Result arrays (or buffers) this layer is done with: back to the decode threads. */
  recycle(...items) { this.scheduler.returns.give(...items); }
}

export class Scheduler {
  constructor(pool, { perThread = PER_THREAD, perHost = PER_HOST } = {}) {
    this.pool = pool;
    this.perThread = perThread;
    this.perHost = perHost;
    this.clients = [];
    this.turn = new Int32Array(CLASSES);
    this.resume = new Uint8Array(CLASSES);   // a turn was cut short by a full house
    this.active = 0;
    this.jobs = new Set();
    this.waiting = [];            // jobs started outside a turn, waiting for a slot
    this.hosts = new Map();
    this.checkAt = 0;
    this.paused = false;
    this.returns = new Returns((buffers) => this.pool.recycle?.(buffers));
    // Totals since the start, and each host's cap; what is in flight is
    // read off `active`, `waiting` and `jobs` directly.
    this.stats = { started: 0, cancelled: 0, stale: 0, retries: 0, failed: 0, throttled: 0, hosts: {} };
  }

  /** Jobs that may be in flight at once. */
  get capacity() { return Math.max(1, this.pool.size) * this.perThread; }

  client(name, options) {
    const c = new Client(this, name, options);
    this.clients.push(c);
    return c;
  }

  #host(name) {
    let h = this.hosts.get(name);
    if (!h) this.hosts.set(name, (h = { cap: this.perHost, active: 0 }));
    return h;
  }

  /** Whether one more job (to `host`, if given) may start now. */
  free(host) {
    if (this.active >= this.capacity) return false;
    if (!host) return true;
    const h = this.#host(host);
    return h.active < h.cap;
  }

  /**
   * Runs a job on the decode pool, counted against the limits until it
   * settles, cancellable through the staleness check.
   * @param item     what the job is for, handed to the client's `stale`
   * @param cls      PHYSICS, VIEW or PRELOAD: also the fetch priority
   * @param cost     the job's weight on a thread, and in the round robin
   * @param host     the host it fetches from
   */
  async run(client, type, payload, { item = null, cls = VIEW, cost = 1, host = '', timeout = 0, transfer } = {}) {
    // A full house: wait for a job to end and take over its slot.
    if (this.active >= this.capacity) await new Promise((take) => this.waiting.push(take));
    else this.active++;
    const controller = new AbortController();
    const job = { client, item, cls, controller };
    const h = host ? this.#host(host) : null;
    if (h) h.active++;
    client.active++;
    client.lastCost = cost;
    client.stats.started++;
    this.stats.started++;
    this.jobs.add(job);
    payload.priority = cls === PHYSICS ? 'high' : cls === PRELOAD ? 'low' : 'auto';
    try {
      const result = await this.pool.run(type, payload, { cost, transfer, timeout, signal: controller.signal });
      if (h && h.cap < this.perHost) h.cap++;
      return result;
    } catch (err) {
      if (isAbort(err)) {
        client.stats.cancelled++;
        this.stats.cancelled++;
      } else if (h && err.status === 429) {
        h.cap = Math.max(MIN_PER_HOST, Math.floor(h.cap / 2));
        this.stats.throttled++;
      }
      throw err;
    } finally {
      // The slot goes to a waiting job if there is one (and the pool has not
      // shrunk below what is out), else it is free.
      if (this.waiting.length && this.active <= this.capacity) this.waiting.shift()();
      else this.active--;
      if (h) h.active--;
      client.active--;
      this.jobs.delete(job);
    }
  }

  /** Calls off the jobs in flight that `which(job)` picks. */
  cancel(which) {
    for (const job of this.jobs) if (!job.controller.signal.aborted && which(job)) job.controller.abort();
  }

  /** Once a frame, after the layers' selections: hands out the free slots. */
  dispatch(now = performance.now()) {
    if (now >= this.checkAt) {
      this.checkAt = now + STALE_CHECK_MS;
      this.#dropStale();
    }
    // Slots freed by a pool that grew go to jobs waiting for one first.
    while (this.waiting.length && this.active < this.capacity) {
      this.active++;
      this.waiting.shift()();
    }
    if (!this.paused) {
      for (const c of this.clients) {
        while (this.active < this.capacity && this.#started(c, PHYSICS)) { /* as many as fit */ }
      }
      this.#share(VIEW);
      this.#share(PRELOAD);
    }
    for (const [name, h] of this.hosts) this.stats.hosts[name] = h.cap;
    this.returns.flush();
  }

  /*
   * Deficit round robin over the clients for one class. A client's turn adds
   * its quantum to its credit and it starts jobs while credit lasts; one
   * with nothing to start keeps no credit. When the slots run out mid-turn,
   * that turn resumes next frame without a new quantum.
   */
  #share(cls) {
    const n = this.clients.length;
    let idle = 0;
    while (this.active < this.capacity && idle < n) {
      const c = this.clients[this.turn[cls] % n];
      if (!this.resume[cls]) c.deficit[cls] += c.weight * QUANTUM;
      this.resume[cls] = 0;
      let started = false;
      while (c.deficit[cls] > 0) {
        if (this.active >= this.capacity) { this.resume[cls] = 1; return; }
        if (!this.#started(c, cls)) { c.deficit[cls] = 0; break; }
        c.deficit[cls] -= c.lastCost;
        started = true;
      }
      this.turn[cls] = (this.turn[cls] + 1) % n;
      idle = started ? 0 : idle + 1;
    }
  }

  /* Asks a client for a job; only a job actually started counts. */
  #started(c, cls) {
    const before = this.stats.started;
    return c.pick(cls) === true && this.stats.started > before;
  }

  /*
   * A job for no tile in particular (a layer's root file, a photo fetched
   * ahead into the cache) has nothing to be stale about and is never asked
   * about. A client whose check fails is reported once and left alone:
   * bookkeeping must not stop every frame.
   */
  #dropStale() {
    for (const job of this.jobs) {
      const client = job.client;
      if (job.item == null || !client.stale || job.controller.signal.aborted) continue;
      let stale = false;
      try {
        stale = client.stale(job.item, job.cls);
      } catch (err) {
        if (!client.checkFailed) console.warn(`[scheduler] ${client.name}: staleness check failed: ${err.message}`);
        client.checkFailed = true;
        continue;
      }
      if (!stale) continue;
      job.controller.abort();
      client.stats.stale++;
      this.stats.stale++;
    }
  }
}
