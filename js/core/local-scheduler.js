/* local-scheduler.js — a thread's own jobs, run on that thread (5.19a).
 *
 * The same client interface as core/scheduler.js (a client with run, canRun, cancelAll and recycle, and a `pick`
 * asked for its next job whenever one may start), for a model that lives on a thread of its own and has the C core
 * there: workers/tunnels.js runs the tunnels' jobs where they are asked for, nothing copied to another thread and
 * back. A job waiting on the network does not hold the thread, so up to `most` are out at once, `perHost` to any one
 * host; one that computes runs to its end before the next starts (the thread is otherwise idle). Several clients take
 * turns (since 5.18d: the tunnels and the railways' profiles), each calling off only its own jobs.
 */

import { VIEW } from './scheduler.js';
import { abortError, isAbort } from './rpc.js';

export class LocalScheduler {
  /**
   * @param jobs  { type: (payload, signal) => result or a promise of one }
   */
  constructor(jobs, { most = 8, perHost = 4 } = {}) {
    this.jobs = jobs;
    this.most = most;
    this.perHost = perHost;
    this.active = 0;
    this.hosts = new Map();          // host → jobs out to it
    this.controllers = new Set();    // one per job out, to call it off
    this.pickers = [];               // each client's pick, in the order they came
    this.turn = 0;                   // whose turn it is to start a job
    this.dispatching = false;
    this.stats = { started: 0, failed: 0, cancelled: 0 };
  }

  /** A client (core/scheduler.js Client's interface); `pick(cls)` starts its next job through `run`. */
  client(name, { pick }) {
    this.pickers.push(pick);
    const mine = new Set();          // its jobs out
    return {
      name,
      canRun: (host) => this.canRun(host),
      run: (type, payload, options) => this.run(type, payload, options, mine),
      cancelAll: () => { for (const c of mine) c.abort(abortError()); },
      recycle: () => {},
    };
  }

  canRun(host = '') {
    return this.active < this.most && (!host || (this.hosts.get(host) ?? 0) < this.perHost);
  }

  /** Starts jobs while a client has one that can start, the clients taking turns. */
  dispatch() {
    if (this.dispatching || !this.pickers.length) return;
    this.dispatching = true;
    try {
      for (let idle = 0; this.active < this.most && idle < this.pickers.length;) {
        const pick = this.pickers[this.turn++ % this.pickers.length];
        if (pick(VIEW)) idle = 0; else idle++;
      }
    } finally {
      this.dispatching = false;
    }
  }

  /**
   * Runs a job here; `host` counts it against that host, `timeout` (ms) calls it off (a retryable error); `mine`: the
   * asking client's jobs out. (core/scheduler.js's `cls`, `cost` and `transfer` mean nothing on one thread.)
   */
  async run(type, payload, { host = '', timeout = 0 } = {}, mine = null) {
    const job = this.jobs[type];
    if (!job) throw new Error(`no job '${type}' on this thread`);
    const controller = new AbortController();
    this.controllers.add(controller);
    mine?.add(controller);
    this.active++;
    if (host) this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1);
    this.stats.started++;
    let timer = 0;
    try {
      if (timeout > 0) timer = setTimeout(() => controller.abort(timedOut(type, timeout)), timeout);
      const result = await job(payload, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
      return result;
    } catch (err) {
      if (isAbort(err)) this.stats.cancelled++; else this.stats.failed++;
      throw err;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      mine?.delete(controller);
      this.active--;
      if (host) this.hosts.set(host, this.hosts.get(host) - 1);
      // A slot is free: the next job (after the caller has seen this one's end).
      queueMicrotask(() => this.dispatch());
    }
  }

  /** Calls off every job out, every client's. */
  cancelAll() {
    for (const c of this.controllers) c.abort(abortError());
  }
}

/* A job out longer than it may be: worth trying again (as rpc.js's timeouts are). */
function timedOut(type, ms) {
  const err = new Error(`${type} took longer than ${ms} ms`);
  err.retryable = true;
  return err;
}
