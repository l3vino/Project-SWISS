/* pool.js — one GPU buffer, handed out in pieces.
 *
 * Every vector tile's block (formats/vector-tile.js) lives in one storage
 * buffer, so a shader binds it once and finds any tile by its offset, and
 * a tile coming or going never creates or destroys a GPU object. Blocks
 * differ in size (an empty field: a few KB; Zürich HB at zoom 14: 439 KB),
 * so the buffer is carved up by a free list: offsets in steps of ALIGN,
 * best fit, freed pieces merged with free neighbours. A few dozen blocks are
 * in use at a time, so plain sorted arrays are quicker than anything
 * cleverer. (Stage 6 plans the same for terrain and building vertices; a
 * TLSF allocator is what to swap in once thousands of blocks share one.)
 */

const ALIGN = 256;

export class GpuPool {
  /** @param bytes  the buffer's size, rounded up to ALIGN */
  constructor(device, bytes, label = 'pool') {
    this.size = Math.max(ALIGN, Math.ceil(bytes / ALIGN) * ALIGN);
    this.buffer = device.createBuffer({ label, size: this.size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Free pieces, sorted by offset.
    this.freeAt = [0];
    this.freeSize = [this.size];
    this.used = 0;
    this.blocks = 0;
  }

  destroy() { this.buffer.destroy(); }

  /** Bytes a request of `bytes` takes. */
  static span(bytes) { return Math.max(ALIGN, Math.ceil(bytes / ALIGN) * ALIGN); }

  /** An offset with `bytes` free after it, or -1 if no piece is large enough. */
  alloc(bytes) {
    const need = GpuPool.span(bytes);
    let best = -1;
    for (let i = 0; i < this.freeAt.length; i++) {
      const s = this.freeSize[i];
      if (s >= need && (best < 0 || s < this.freeSize[best])) best = i;
    }
    if (best < 0) return -1;
    const at = this.freeAt[best];
    if (this.freeSize[best] === need) { this.freeAt.splice(best, 1); this.freeSize.splice(best, 1); }
    else { this.freeAt[best] += need; this.freeSize[best] -= need; }
    this.used += need;
    this.blocks++;
    return at;
  }

  /** Gives back what alloc(bytes) returned at `at`. */
  release(at, bytes) {
    const span = GpuPool.span(bytes);
    let i = 0;
    while (i < this.freeAt.length && this.freeAt[i] < at) i++;
    this.freeAt.splice(i, 0, at);
    this.freeSize.splice(i, 0, span);
    // Merge with the next piece, then with the previous.
    if (i + 1 < this.freeAt.length && this.freeAt[i] + this.freeSize[i] === this.freeAt[i + 1]) {
      this.freeSize[i] += this.freeSize[i + 1];
      this.freeAt.splice(i + 1, 1); this.freeSize.splice(i + 1, 1);
    }
    if (i > 0 && this.freeAt[i - 1] + this.freeSize[i - 1] === this.freeAt[i]) {
      this.freeSize[i - 1] += this.freeSize[i];
      this.freeAt.splice(i, 1); this.freeSize.splice(i, 1);
    }
    this.used -= span;
    this.blocks--;
  }

  /** The largest piece still free, bytes. */
  get largest() {
    let m = 0;
    for (const s of this.freeSize) if (s > m) m = s;
    return m;
  }
}
