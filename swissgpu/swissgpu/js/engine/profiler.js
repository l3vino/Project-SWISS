/* profiler.js — where the render thread's time goes, frame by frame.
 *
 * A frame is split into named sections by laps: each lap charges the time
 * since the previous one to a section. The last few hundred frames are kept
 * in a ring buffer, so the readout can show the real work per frame (not the
 * display's refresh interval), its 99th percentile, and how many frames came
 * late: a frame the display waited for is what stutter looks like.
 */

const FRAMES = 240;

export class Profiler {
  constructor(sections) {
    this.sections = sections;
    this.index = new Map(sections.map((s, i) => [s, i]));
    this.width = sections.length + 1;               // work, then each section
    this.ring = new Float32Array(FRAMES * this.width);
    this.intervals = new Float32Array(FRAMES);
    this.at = 0;
    this.count = 0;
    this.current = new Float32Array(sections.length);
    this.frameStart = 0;
    this.lapAt = 0;
  }

  /** At the top of a frame. `interval` is the time since the last one, ms. */
  begin(interval) {
    this.current.fill(0);
    this.frameStart = this.lapAt = performance.now();
    this.intervals[this.at] = interval;
  }

  /** Charges the time since the last lap to `section`. */
  lap(section) {
    const now = performance.now();
    const i = this.index.get(section);
    if (i !== undefined) this.current[i] += now - this.lapAt;
    this.lapAt = now;
  }

  end() {
    const o = this.at * this.width;
    this.ring[o] = performance.now() - this.frameStart;
    this.ring.set(this.current, o + 1);
    this.at = (this.at + 1) % FRAMES;
    this.count = Math.min(FRAMES, this.count + 1);
  }

  /**
   * Means over the kept frames, the 99th percentile of work, and how many
   * frames arrived late: more than one and a half typical intervals after
   * the one before, which the display shows as a repeated frame.
   */
  report() {
    const n = this.count;
    const out = { frames: n, work: 0, work99: 0, late: 0, sections: {}, peaks: {} };
    if (!n) return out;
    const works = new Float32Array(n);
    const intervals = new Float32Array(n);
    const sums = new Float64Array(this.sections.length);
    const peaks = new Float64Array(this.sections.length);
    for (let k = 0; k < n; k++) {
      const o = k * this.width;
      works[k] = this.ring[o];
      intervals[k] = this.intervals[k];
      for (let s = 0; s < sums.length; s++) {
        const v = this.ring[o + 1 + s];
        sums[s] += v;
        if (v > peaks[s]) peaks[s] = v;
      }
    }
    works.sort();
    const sortedIntervals = intervals.slice().sort();
    const typical = sortedIntervals[n >> 1] || 16.7;
    let late = 0;
    for (let k = 0; k < n; k++) if (intervals[k] > typical * 1.5) late++;
    out.work = works.reduce((a, b) => a + b, 0) / n;
    out.work99 = works[Math.min(n - 1, Math.floor(n * 0.99))];
    out.late = late;
    out.interval = typical;
    this.sections.forEach((s, i) => { out.sections[s] = sums[i] / n; out.peaks[s] = peaks[i]; });
    return out;
  }
}
