/* uploads.js — handing arrived data to the GPU a little at a time.
 *
 * Tiles finish decoding whenever the decode threads get to them, often
 * several at once. Uploading each the moment it lands runs that work in
 * between frames, where it delays the next one: a burst of arrivals is a
 * dropped frame, which is what stutter is. Instead, each arrival waits here
 * and the render thread drains the queue once a frame, before drawing, for at
 * most a small slice of time. At least one job runs every frame, so progress
 * never stops however slow a single upload is.
 *
 * The slice is a share of the frame, not a fixed time: two milliseconds is
 * little at 60 frames a second and most of a frame at 400. It follows the
 * typical frame interval, a quarter of it, between a floor and the ceiling
 * the queue was made with.
 */

const SHARE = 0.25;
const FLOOR_MS = 0.4;

export class UploadQueue {
  /** @param budgetMs  milliseconds a frame may spend on uploads, at most */
  constructor(budgetMs = 2) {
    this.budgetMs = budgetMs;
    this.sliceMs = budgetMs;
    this.interval = 16.7;         // smoothed frame interval, ms
    this.jobs = [];
    this.head = 0;                // jobs before this have run; compacted now and then
    this.deadline = 0;
    this.stats = { waiting: 0, ran: 0, ms: 0, slice: budgetMs };
  }

  /** Runs `fn` during a later frame's upload slice; resolves with its result. */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.jobs.push(() => {
        try { resolve(fn()); } catch (err) { reject(err); }
      });
    });
  }

  /**
   * Opens this frame's slice and runs queued jobs within it.
   * @param intervalMs  time since the previous frame began, if known
   */
  run(intervalMs = 0) {
    if (intervalMs > 0 && intervalMs < 1000) this.interval += (intervalMs - this.interval) * 0.1;
    this.sliceMs = Math.min(this.budgetMs, Math.max(FLOOR_MS, this.interval * SHARE));
    const start = performance.now();
    this.deadline = start + this.sliceMs;
    let ran = 0;
    const jobs = this.jobs;
    while (this.head < jobs.length && (ran === 0 || performance.now() < this.deadline)) {
      const job = jobs[this.head];
      jobs[this.head++] = null;
      job();
      ran++;
    }
    // Shifting one at a time moves the whole array each time; drop the
    // finished front in one go instead, once it is worth it.
    if (this.head === jobs.length) { jobs.length = 0; this.head = 0; }
    else if (this.head > 256) { jobs.splice(0, this.head); this.head = 0; }
    this.stats.waiting = jobs.length - this.head;
    this.stats.ran = ran;
    this.stats.ms = performance.now() - start;
    this.stats.slice = this.sliceMs;
  }

  /** Whether this frame's slice has time left, for work paced elsewhere. */
  get hasTime() { return performance.now() < this.deadline; }
}
