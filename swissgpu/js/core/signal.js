/* signal.js — small tools for numbers sampled along a line.
 *
 * Pure functions with no state of the app, shared by anything that shapes a
 * curve from samples (the search flight, engine/flight/, uses all of them).
 *
 * smoothstep        0 to 1 over 0..1, flat at both ends (first derivative)
 * smoothstepArea    its integral from 0: how far a smoothstep ramp in speed
 *                   has carried you
 * smootherstep      Perlin's, flat to the second derivative at both ends
 * runningMax        the largest value within ±radius samples of each, in
 *                   O(n) whatever the radius (Lemire, "Streaming maximum-
 *                   minimum filter using no more than three comparisons per
 *                   element", 2006)
 * slopeLimitAbove   raises samples until no two neighbours differ by more
 *                   than a slope allows, never lowering any: the lowest
 *                   curve above the samples that is that steep at most
 * gaussianBlur      a Gaussian kernel, with a value taken for outside (or
 *                   the nearest end's); wide ones as three box blurs, in
 *                   O(n) whatever the width (Kovesi, "Fast almost-Gaussian
 *                   filtering", 2010)
 * roundedAbove      a curve's corners rounded without going under it
 *                   anywhere, its ends kept exactly
 * lastAtOrBelow     binary search in an increasing table
 */

/** 0 to 1 over 0..1 with zero slope at both ends. */
export function smoothstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/** The integral of smoothstep from 0 to x: 0.5 at 1, growing by 1 a unit after. */
export function smoothstepArea(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 0.5 + (x - 1);
  return x * x * x * (1 - x / 2);
}

/** 0 to 1 over 0..1 with zero slope and curvature at both ends. */
export function smootherstep(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * x * (x * (6 * x - 15) + 10);
}

/**
 * The largest value of `src` within `radius` samples either side of each, into
 * `out` (which may be `src` itself). A monotone deque of candidates: each
 * sample enters and leaves it once.
 */
export function runningMax(src, radius, out = src) {
  const n = src.length;
  if (radius < 1 || n === 0) {
    if (out !== src) out.set(src);
    return out;
  }
  const at = new Int32Array(n), value = new Float64Array(n);
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < n; i++) {
    // Everything up to radius ahead has entered (read before `out` is
    // written, so working in place is safe: `next` runs ahead of `i`).
    const last = Math.min(n - 1, i + radius);
    for (; next <= last; next++) {
      const v = src[next];
      while (tail > head && value[tail - 1] <= v) tail--;
      at[tail] = next;
      value[tail] = v;
      tail++;
    }
    while (at[head] < i - radius) head++;
    out[i] = value[head];
  }
  return out;
}

/**
 * Raises samples `step` apart until no neighbour is lower than another by
 * more than `slope` times the step, in place: one pass each way, which is
 * exact (the result is the lowest such curve on or above the input).
 */
export function slopeLimitAbove(a, step, slope) {
  const drop = slope * step;
  for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1] - drop) a[i] = a[i - 1] - drop;
  for (let i = a.length - 2; i >= 0; i--) if (a[i] < a[i + 1] - drop) a[i] = a[i + 1] - drop;
  return a;
}

/**
 * A Gaussian blur of `src` into `out` (not the same array), sigma in samples,
 * reading `outside` beyond either end, or with 'edge' the end sample itself.
 */
export function gaussianBlur(src, sigma, out, outside = 0) {
  const n = src.length;
  if (!(sigma > 0) || n === 0) {
    out.set(src);
    return out;
  }
  const edge = outside === 'edge';
  if (sigma > 3) return boxBlur3(src, sigma, out, edge ? 0 : outside, edge);
  const half = Math.ceil(3 * sigma), kernel = new Float64Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) sum += kernel[k + half] = Math.exp(-0.5 * (k / sigma) ** 2);
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      const v = j < 0 ? (edge ? src[0] : outside) : j >= n ? (edge ? src[n - 1] : outside) : src[j];
      acc += kernel[k + half] * v;
    }
    out[i] = acc;
  }
  return out;
}

/* Three box blurs whose widths add up to a Gaussian's spread (the two odd
 * widths around the ideal, as many of each as fit sigma best). */
function boxBlur3(src, sigma, out, outside, edge) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const narrow = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  const tmp = new Float64Array(src.length);
  boxPass(src, narrow > 0 ? (lower - 1) / 2 : (upper - 1) / 2, out, outside, edge);
  boxPass(out, narrow > 1 ? (lower - 1) / 2 : (upper - 1) / 2, tmp, outside, edge);
  boxPass(tmp, narrow > 2 ? (lower - 1) / 2 : (upper - 1) / 2, out, outside, edge);
  return out;
}

/* The mean over ±r samples, by a running sum. */
function boxPass(src, r, out, outside, edge) {
  const n = src.length, w = 2 * r + 1;
  const at = (j) => (j < 0 ? (edge ? src[0] : outside) : j >= n ? (edge ? src[n - 1] : outside) : src[j]);
  let acc = 0;
  for (let j = -r; j <= r; j++) acc += at(j);
  for (let i = 0; i < n; i++) {
    out[i] = acc / w;
    acc += at(i + r + 1) - at(i - r);
  }
}

/**
 * Rounds the corners of the samples `h` (in place) without going under them
 * anywhere and keeping both ends exactly: each becomes the Gaussian-weighted
 * mean, over ±3σ, of the highest within reach of the samples under its
 * kernel, so every sample the kernel weighs is at least the one it replaces.
 * σ is `share` of the samples, falling to nothing towards the ends (a tenth
 * of the samples to the nearer end at most, so it changes slowly enough for
 * that to hold). Where σ shrinks near an end, a curve still rising there can
 * come out with a small dip before it: a caller that needs one top restores
 * it (engine/flight/plan.js, raiseSmoothly). O(n · σ).
 */
export function roundedAbove(h, share) {
  const n = h.length, most = share * n, lean = 0.1;
  if (!(most >= 0.5) || n < 5) return h;
  const sigmaAt = (i) => Math.min(most, lean * Math.min(i, n - 1 - i));
  const highest = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.ceil((3 * sigmaAt(i)) / (1 - 3 * lean));
    let m = -Infinity;
    for (let j = Math.max(0, i - r), last = Math.min(n - 1, i + r); j <= last; j++) if (h[j] > m) m = h[j];
    highest[i] = m;
  }
  for (let i = 0; i < n; i++) {
    const sg = sigmaAt(i);
    if (sg < 0.25) continue;
    const r = Math.floor(3 * sg);
    let acc = 0, sum = 0;
    for (let j = i - r; j <= i + r; j++) {
      const d = (j - i) / sg, w = Math.exp(-0.5 * d * d);
      acc += w * highest[j];
      sum += w;
    }
    h[i] = acc / sum;
  }
  return h;
}

/** The last index of an increasing table whose value is at most x (0 below the first). */
export function lastAtOrBelow(table, x, count = table.length) {
  let lo = 0, hi = count - 1;
  if (x >= table[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}
