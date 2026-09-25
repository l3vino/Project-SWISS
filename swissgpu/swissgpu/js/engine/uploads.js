/* uploads.js — handing arrived data to the GPU a little at a time.
 *
 * Tiles finish decoding whenever the decode threads get to them, often
 * several at once. Uploading each the moment it lands runs that work in
 * between frames, where it delays the next one: a burst of arrivals is a
 * dropped frame, which is what stutter is. Instead, each arrival waits here
 * and the render thread drains the queue once a frame, before drawing, for at
 * most a small slice of time. At least one job runs every frame, so progress
 * never stops however slow a single upload is.
 */

export class UploadQueue {
  /** @param budgetMs  milliseconds a frame may spend on uploads */
  constructor(budgetMs = 2) {
    this.budgetMs = budgetMs;
    this.jobs = [];
    this.deadline = 0;
    this.stats = { waiting: 0, ran: 0, ms: 0 };
  }

  /** Runs `fn` during a later frame's upload slice; resolves with its result. */
  schedule(fn) {
    return new Promise((resolve, reject) => {
      this.jobs.push(() => {
        try { resolve(fn()); } catch (err) { reject(err); }
      });
    });
  }

  /** Opens this frame's slice and runs queued jobs within it. */
  run() {
    const start = performance.now();
    this.deadline = start + this.budgetMs;
    let ran = 0;
    while (this.jobs.length && (ran === 0 || performance.now() < this.deadline)) {
      this.jobs.shift()();
      ran++;
    }
    this.stats.waiting = this.jobs.length;
    this.stats.ran = ran;
    this.stats.ms = performance.now() - start;
  }

  /** Whether this frame's slice has time left, for work paced elsewhere. */
  get hasTime() { return performance.now() < this.deadline; }
}
