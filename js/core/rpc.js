/* rpc.js — the one message protocol every thread speaks.
 *
 * Wraps a Worker (or `self` inside one) so both sides look identical: `send`
 * for fire-and-forget, `request` for a correlated round trip. Payloads carry
 * their own transfer list, so ArrayBuffers and ImageBitmaps move without a
 * copy. Keys are single letters because every byte here is serialised on the
 * hot path: i=id, t=type, p=payload, e=error, x=error details.
 *
 * A request can be called off. Its `signal` aborting, or its timeout running
 * out, settles it at once on this side and tells the other side (`@cancel`),
 * where the handler was given an AbortSignal of its own: a download in
 * progress is aborted there, and a result finished anyway is not sent back.
 *
 * Errors keep what the caller needs to decide what to do next: a handler's
 * error may carry `status` (the HTTP status), `retry` (worth trying again)
 * and `retryAfter` (seconds the server asked to wait), and the error the
 * requester sees has them too.
 *
 * A thread that dies has to say so. An endpoint tracks readiness and failure
 * explicitly, because the alternative is a request that never settles and an
 * interface that waits forever with nothing to show.
 */

let nextId = 1;

/* What a cancelled request rejects with, recognisable by its name. */
export function abortError(message = 'cancelled') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export const isAbort = (err) => err?.name === 'AbortError';

/* The details an error carries across, if any. */
function detailsOf(err) {
  if (!err || typeof err !== 'object') return undefined;
  const { status, retry, retryAfter } = err;
  if (status === undefined && retry === undefined && retryAfter === undefined) return undefined;
  return { status, retry, retryAfter };
}

export class Endpoint {
  #settleReady;
  #breakReady;

  /** @param {Worker|DedicatedWorkerGlobalScope} port */
  constructor(port, label = 'peer') {
    this.port = port;
    this.label = label;
    this.handlers = new Map();
    this.pending = new Map();     // requests of ours awaiting a reply
    this.running = new Map();     // requests of theirs being handled: id -> AbortController
    this.dead = null;
    this.onfail = null;
    // Gets the transferables of a result nobody wants any more (its request
    // was called off while it was being made), for whoever can reuse them.
    this.discard = null;

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

  /** Register a handler: `fn(payload, signal)`. Returning a value answers a `request`. */
  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  send(type, payload, transfer) {
    if (this.dead) return;
    this.port.postMessage({ i: 0, t: type, p: payload }, transfer || []);
  }

  /**
   * A round trip. `timeout` (ms) and `signal` call it off: the promise then
   * rejects at once (an AbortError for the signal, a retryable error for the
   * timeout) and the other side is told to stop.
   */
  request(type, payload, transfer, { timeout = 0, signal = null } = {}) {
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(abortError());

    const id = nextId++;
    return new Promise((resolve, reject) => {
      let timer = 0;
      const onAbort = () => callOff(abortError());
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const callOff = (err) => {
        if (!this.pending.has(id)) return;
        settle();
        if (!this.dead) this.port.postMessage({ i: 0, t: '@cancel', p: id });
        reject(err);
      };
      if (timeout > 0) {
        timer = setTimeout(() => {
          const err = new Error(`${this.label} did not answer "${type}" within ${timeout} ms`);
          err.retry = true;
          callOff(err);
        }, timeout);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v) => { settle(); resolve(v); },
        reject: (e) => { settle(); reject(e); },
      });
      try {
        this.port.postMessage({ i: id, t: type, p: payload }, transfer || []);
      } catch (err) {
        settle();
        reject(err);
      }
    });
  }

  /** Terminal: no request will ever be answered again. */
  fail(error) {
    if (this.dead) return;
    this.dead = error;
    console.error(`[${this.label}] ${error.message}`);
    this.#breakReady(error);
    for (const slot of this.pending.values()) slot.reject(error);
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.onfail?.(error);
  }

  async #dispatch(msg) {
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === '@ready') { this.#settleReady(this); return; }

    if (msg.t === '@reply') {
      const slot = this.pending.get(msg.i);
      if (!slot) return;          // called off meanwhile: nobody is waiting
      if (msg.e === undefined) { slot.resolve(msg.p); return; }
      const err = new Error(msg.e);
      if (msg.x) Object.assign(err, msg.x);
      slot.reject(err);
      return;
    }

    if (msg.t === '@cancel') { this.running.get(msg.p)?.abort(); return; }

    const fn = this.handlers.get(msg.t);
    if (!fn) {
      if (msg.i) this.port.postMessage({ i: msg.i, t: '@reply', e: `no handler for "${msg.t}"` });
      return;
    }

    if (!msg.i) { // notification: nothing to answer
      try { await fn(msg.p, null); } catch (err) { console.error(`[${this.label}] ${msg.t}`, err); }
      return;
    }

    const controller = new AbortController();
    this.running.set(msg.i, controller);
    try {
      const out = await fn(msg.p, controller.signal);
      if (controller.signal.aborted) {
        // Nobody wants it: let go of what holds memory outside the heap, or
        // hand it to whoever can use it again.
        const items = out?.$transfer ?? [];
        for (const item of items) if (typeof item?.close === 'function') item.close();
        this.discard?.(items);
        return;
      }
      const transfer = out && out.$transfer ? out.$transfer : [];
      if (out) delete out.$transfer;
      this.port.postMessage({ i: msg.i, t: '@reply', p: out }, transfer);
    } catch (err) {
      if (controller.signal.aborted) return;
      this.port.postMessage({ i: msg.i, t: '@reply', e: String((err && err.message) || err), x: detailsOf(err) });
    } finally {
      this.running.delete(msg.i);
    }
  }

  close() {
    this.fail(new Error(`${this.label} was closed`));
    if (typeof this.port.terminate === 'function') this.port.terminate();
  }
}
