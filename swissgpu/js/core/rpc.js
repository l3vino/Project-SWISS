/* rpc.js — the one message protocol every thread speaks.
 *
 * Wraps a Worker (or `self` inside one) so both sides look identical: `send`
 * for fire-and-forget, `request` for a correlated round trip. Payloads carry
 * their own transfer list, so ArrayBuffers and ImageBitmaps move without a
 * copy. Keys are single letters because every byte here is serialised on the
 * hot path: i=id, t=type, p=payload, e=error.
 *
 * A thread that dies has to say so. An endpoint tracks readiness and failure
 * explicitly, because the alternative is a request that never settles and an
 * interface that waits forever with nothing to show.
 */

let nextId = 1;

export class Endpoint {
  #settleReady;
  #breakReady;

  /** @param {Worker|DedicatedWorkerGlobalScope} port */
  constructor(port, label = 'peer') {
    this.port = port;
    this.label = label;
    this.handlers = new Map();
    this.pending = new Map();
    this.dead = null;
    this.onfail = null;

    this.ready = new Promise((resolve, reject) => {
      this.#settleReady = resolve;
      this.#breakReady = reject;
    });
    // On the failure path nothing may be awaiting `ready`; keep that from
    // surfacing as an unhandled rejection.
    this.ready.catch(() => {});

    port.onmessage = (ev) => this.#dispatch(ev.data);
    port.onmessageerror = () => this.fail(new Error(`${label} sent something unreadable`));

    // Only the parent side has onerror, and a worker whose script fails to load
    // reports it here and nowhere else.
    if ('onerror' in port) {
      port.onerror = (ev) => this.fail(new Error(
        ev.message
          ? `${label}: ${ev.message}${ev.lineno ? ` (line ${ev.lineno})` : ''}`
          : `${label} could not start: its script failed to load.`,
      ));
    }
  }

  /** Worker side: announce that this thread's module graph finished loading. */
  announce() { this.port.postMessage({ i: 0, t: '@ready' }); }

  /** Register a handler. Returning a value answers a `request`. */
  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  send(type, payload, transfer) {
    if (this.dead) return;
    this.port.postMessage({ i: 0, t: type, p: payload }, transfer || []);
  }

  request(type, payload, transfer, { timeout = 0 } = {}) {
    if (this.dead) return Promise.reject(this.dead);

    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = 0;
      if (timeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${this.label} did not answer "${type}" within ${timeout} ms`));
        }, timeout);
      }
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.port.postMessage({ i: id, t: type, p: payload }, transfer || []);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Terminal: no request will ever be answered again. */
  fail(error) {
    if (this.dead) return;
    this.dead = error;
    this.#breakReady(error);
    for (const slot of this.pending.values()) slot.reject(error);
    this.pending.clear();
    this.onfail?.(error);
  }

  async #dispatch(msg) {
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === '@ready') { this.#settleReady(this); return; }

    if (msg.t === '@reply') {
      const slot = this.pending.get(msg.i);
      if (!slot) return;
      this.pending.delete(msg.i);
      msg.e ? slot.reject(new Error(msg.e)) : slot.resolve(msg.p);
      return;
    }

    const fn = this.handlers.get(msg.t);
    if (!fn) {
      if (msg.i) this.port.postMessage({ i: msg.i, t: '@reply', e: `no handler for "${msg.t}"` });
      return;
    }

    if (!msg.i) { // notification: nothing to answer
      try { await fn(msg.p); } catch (err) { console.error(`[${this.label}] ${msg.t}`, err); }
      return;
    }

    try {
      const out = await fn(msg.p);
      const transfer = out && out.$transfer ? out.$transfer : [];
      if (out) delete out.$transfer;
      this.port.postMessage({ i: msg.i, t: '@reply', p: out }, transfer);
    } catch (err) {
      this.port.postMessage({ i: msg.i, t: '@reply', e: String((err && err.message) || err) });
    }
  }

  close() {
    this.fail(new Error(`${this.label} was closed`));
    if (typeof this.port.terminate === 'function') this.port.terminate();
  }
}
