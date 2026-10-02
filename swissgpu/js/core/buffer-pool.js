/* buffer-pool.js — buffers that go round instead of being thrown away.
 *
 * A decoded tile travels from a decode thread to the render thread in
 * transferred buffers. Once its contents are on the GPU the render thread
 * has no use for them, and rather than leave them to its garbage collector
 * it sends them back, transferred again, for the decode threads to fill
 * with the next tiles. Without that, every tile allocates fresh buffers on
 * one side and leaves the same amount for the collector on the other, and
 * on the render thread that memory outside the heap is what sets off full
 * collections while streaming (tools/bench-streaming.mjs, one flight: 61
 * full collections with fresh buffers, 10 with buffers reused).
 *
 * `BufferPool` (decode side) keeps spare buffers in power-of-two sizes from
 * 4 KB: a request is served by the smallest that fits, so at most half of a
 * buffer goes unused while it travels, and anything kept for good (a ground
 * index, a collision copy) is copied out exactly instead. `Returns` (render
 * side) gathers buffers that are done with and sends them back once a frame.
 */

const MIN_SHIFT = 12;           // 4 KB
const MAX_SHIFT = 26;           // 64 MB: larger buffers are not kept
const MB = 1048576;

/* The size class of `bytes`: the exponent of the smallest power of two that holds it. */
const classOf = (bytes) => Math.max(MIN_SHIFT, 32 - Math.clz32(Math.max(1, bytes) - 1));

export class BufferPool {
  /** @param limit  bytes of spare buffers kept at most; past that they are dropped */
  constructor(limit = 8 * MB) {
    this.limit = limit;
    this.spare = Array.from({ length: MAX_SHIFT + 1 }, () => []);
    this.kept = 0;
    this.stats = { taken: 0, reused: 0, given: 0, dropped: 0 };
  }

  /** A buffer of at least `bytes`, spare if there is one. */
  take(bytes) {
    const k = classOf(bytes);
    this.stats.taken++;
    const list = k <= MAX_SHIFT ? this.spare[k] : null;
    if (list?.length) {
      const buffer = list.pop();
      this.kept -= buffer.byteLength;
      this.stats.reused++;
      return buffer;
    }
    return new ArrayBuffer(k <= MAX_SHIFT ? 2 ** k : bytes);
  }

  /** Takes a buffer back, if it is one of the pool's sizes and there is room. */
  give(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
    const n = buffer.byteLength, k = classOf(n);
    if (k > MAX_SHIFT || 2 ** k !== n || this.kept + n > this.limit) { this.stats.dropped++; return; }
    this.spare[k].push(buffer);
    this.kept += n;
    this.stats.given++;
  }

  /**
   * A copy of a typed array (often a view into wasm memory) in a pooled
   * buffer, as a typed array of the same kind and length.
   */
  copy(source) {
    const Type = source.constructor;
    const view = new Type(this.take(source.byteLength), 0, source.length);
    view.set(source);
    return view;
  }
}

/** An exact copy of a typed array in a buffer of its own, for data that is kept. */
export const exactCopy = (source) => source.slice();

/**
 * Render side: what is done with goes back in one message a frame. `send`
 * gets the buffers (to transfer); views are given back by their buffer.
 */
export class Returns {
  constructor(send) {
    this.send = send;
    this.buffers = [];
    this.bytes = 0;
    this.sent = 0;
  }

  /** Typed arrays or buffers whose contents are no longer needed here. */
  give(...items) {
    for (const item of items) {
      const buffer = item instanceof ArrayBuffer ? item : item?.buffer;
      // Detached already, or given twice: nothing to send.
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0 || this.buffers.includes(buffer)) continue;
      this.buffers.push(buffer);
      this.bytes += buffer.byteLength;
    }
  }

  /** Once a frame. */
  flush() {
    if (!this.buffers.length) return;
    const buffers = this.buffers;
    this.buffers = [];
    this.sent += this.bytes;
    this.bytes = 0;
    this.send(buffers);
  }
}
