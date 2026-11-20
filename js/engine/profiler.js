/* profiler.js — where the render thread's time goes, frame by frame.
 *
 * A frame is split into named sections by laps: each lap charges the time
 * since the previous one to a section. Work measured inside a section and
 * reported separately (the time spent dropping tiles, say, inside the
 * terrain update) is carved out of it: charged to its own section and not
 * counted twice.
 *
 * The last couple of thousand frames are kept in a ring buffer, and reports
 * cover the last few seconds of them, whatever the frame rate: the real work
 * per frame (not the display's refresh interval), its percentiles, each
 * section's mean, 95th percentile and worst, and how many frames came late:
 * a frame the display waited for is what stutter looks like.
 */

const FRAMES = 2048;
const WINDOW_MS = 5000;

const percentile = (sorted, n, p) => sorted[Math.min(n - 1, Math.floor(n * p))] || 0;

export class Profiler {
  constructor(sections) {
    this.sections = sections;
    this.index = new Map(sections.map((s, i) => [s, i]));
    this.width = sections.length + 1;               // work, then each section
    this.ring = new Float32Array(FRAMES * this.width);
    this.intervals = new Float32Array(FRAMES);
    this.stamps = new Float64Array(FRAMES);         // when each frame began
    this.at = 0;
    this.count = 0;
    this.current = new Float32Array(sections.length);
    this.frameStart = 0;
    this.lapAt = 0;
    this.carved = 0;
    // Scratch for reports, allocated once.
    this.column = new Float32Array(FRAMES);
  }

  /** At the top of a frame. `interval` is the time since the last one, ms. */
  begin(interval) {
    this.current.fill(0);
    this.frameStart = this.lapAt = performance.now();
    this.carved = 0;
    this.intervals[this.at] = interval;
    this.stamps[this.at] = this.frameStart;
  }

  /** Charges the time since the last lap to `section`, less what was carved out of it. */
  lap(section) {
    const now = performance.now();
    const i = this.index.get(section);
    if (i !== undefined) this.current[i] += Math.max(0, now - this.lapAt - this.carved);
    this.carved = 0;
    this.lapAt = now;
  }

  /** Charges `ms` measured inside the current lap to `section` instead. */
  carve(section, ms) {
    const i = this.index.get(section);
    if (i === undefined || !(ms > 0)) return;
    this.current[i] += ms;
    this.carved += ms;
  }

  end() {
    const o = this.at * this.width;
    this.ring[o] = performance.now() - this.frameStart;
    this.ring.set(this.current, o + 1);
    this.at = (this.at + 1) % FRAMES;
    this.count = Math.min(FRAMES, this.count + 1);
  }

  /* Ring slots of the frames within the window, newest first. */
  #recent(windowMs) {
    const newest = (this.at - 1 + FRAMES) % FRAMES;
    const since = this.stamps[newest] - windowMs;
    let n = 0;
    while (n < this.count && this.stamps[(newest - n + FRAMES) % FRAMES] >= since) n++;
    return { newest, n: Math.max(1, Math.min(n, this.count)) };
  }

  /**
   * Over the last few seconds: work per frame (mean and percentiles), each
   * section's mean, 95th percentile and worst, and the frames that came
   * late: more than one and a half typical intervals after the one before,
   * which the display shows as a repeated frame.
   */
  report(windowMs = WINDOW_MS) {
    const out = { frames: 0, seconds: 0, work: 0, work50: 0, work95: 0, work99: 0, workMax: 0, late: 0, interval: 0,
      frame95: 0, frame99: 0, sections: {}, p95: {}, peaks: {} };
    if (!this.count) return out;
    const { newest, n } = this.#recent(windowMs);
    const col = this.column;
    const slot = (k) => (newest - k + FRAMES) % FRAMES;

    // Frame intervals: the typical one, lateness and percentiles.
    for (let k = 0; k < n; k++) col[k] = this.intervals[slot(k)];
    const iv = col.subarray(0, n).sort();
    const typical = iv[n >> 1] || 16.7;
    let late = 0;
    for (let k = 0; k < n; k++) if (iv[k] > typical * 1.5) late++;
    out.interval = typical;
    out.frame95 = percentile(iv, n, 0.95);
    out.frame99 = percentile(iv, n, 0.99);
    out.late = late;

    // Work, then each section.
    for (let s = 0; s < this.width; s++) {
      let sum = 0, max = 0;
      for (let k = 0; k < n; k++) {
        const v = this.ring[slot(k) * this.width + s];
        col[k] = v;
        sum += v;
        if (v > max) max = v;
      }
      const sorted = col.subarray(0, n).sort();
      if (s === 0) {
        out.work = sum / n;
        out.work50 = percentile(sorted, n, 0.5);
        out.work95 = percentile(sorted, n, 0.95);
        out.work99 = percentile(sorted, n, 0.99);
        out.workMax = max;
      } else {
        const name = this.sections[s - 1];
        out.sections[name] = sum / n;
        out.p95[name] = percentile(sorted, n, 0.95);
        out.peaks[name] = max;
      }
    }
    out.frames = n;
    out.seconds = (this.stamps[newest] - this.stamps[slot(n - 1)]) / 1000;
    return out;
  }
}
