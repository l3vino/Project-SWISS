/* feature-pool.js — every loaded building's record, in one GPU buffer.
 *
 * Each building tile brings eight bytes per building (see appearance.js).
 * Rather than a small buffer and a bind group per tile, they share one
 * storage buffer: a tile takes a run of slots when it is uploaded and gives
 * them back when it is dropped, and the shader finds its buildings at the
 * run's start, which the pass puts in the tile's uniform block. One binding
 * for every tile, so drawing a tile costs no extra state change.
 *
 * Runs are handed out first-fit from a sorted free list that merges
 * neighbours when they are returned. When nothing fits, the buffer doubles
 * and its contents are copied over on the GPU; `version` changes so the pass
 * knows to rebind.
 */

const RECORD_BYTES = 8;

export class FeaturePool {
  constructor(device, initialRecords = 1 << 16) {
    this.device = device;
    this.capacity = initialRecords;
    this.free = [[0, initialRecords]];   // [start, count], sorted by start
    this.used = 0;
    this.version = 0;
    this.buffer = this.#create(initialRecords);
  }

  #create(records) {
    return this.device.createBuffer({
      label: 'building-features', size: records * RECORD_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
  }

  /** Stores a tile's records; returns where they start, in records. */
  add(records) {
    const count = Math.max(1, records.length / 2);
    let start = this.#take(count);
    if (start < 0) {
      this.#grow(count);
      start = this.#take(count);
    }
    this.device.queue.writeBuffer(this.buffer, start * RECORD_BYTES, records);
    this.used += count;
    return start;
  }

  /** Gives a tile's run back. */
  remove(start, records) {
    const count = Math.max(1, records);
    this.used -= count;
    const f = this.free;
    let i = 0;
    while (i < f.length && f[i][0] < start) i++;
    f.splice(i, 0, [start, count]);
    // Merge with the neighbour after, then the one before.
    if (i + 1 < f.length && f[i][0] + f[i][1] === f[i + 1][0]) { f[i][1] += f[i + 1][1]; f.splice(i + 1, 1); }
    if (i > 0 && f[i - 1][0] + f[i - 1][1] === f[i][0]) { f[i - 1][1] += f[i][1]; f.splice(i, 1); }
  }

  get bytes() { return this.capacity * RECORD_BYTES; }

  #take(count) {
    const f = this.free;
    for (let i = 0; i < f.length; i++) {
      if (f[i][1] < count) continue;
      const start = f[i][0];
      if (f[i][1] === count) f.splice(i, 1);
      else { f[i][0] += count; f[i][1] -= count; }
      return start;
    }
    return -1;
  }

  #grow(atLeast) {
    let capacity = this.capacity * 2;
    while (capacity - this.capacity < atLeast) capacity *= 2;
    const next = this.#create(capacity);
    const encoder = this.device.createCommandEncoder({ label: 'building-features-grow' });
    encoder.copyBufferToBuffer(this.buffer, 0, next, 0, this.capacity * RECORD_BYTES);
    this.device.queue.submit([encoder.finish()]);
    // Freed once the copy, and any frame still reading it, is done.
    this.buffer.destroy();
    // The new space joins the free list, merged with a free run at the end.
    const last = this.free[this.free.length - 1];
    if (last && last[0] + last[1] === this.capacity) last[1] += capacity - this.capacity;
    else this.free.push([this.capacity, capacity - this.capacity]);
    this.capacity = capacity;
    this.buffer = next;
    this.version++;
  }
}
