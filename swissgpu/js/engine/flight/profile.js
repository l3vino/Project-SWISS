/* profile.js — how high a search flight goes, seen from the side.
 *
 * It rises first, then flies, then comes down (Stage 5.5: "I really like the
 * approach of first reaching a decent height and then move forward with the
 * flight and same at the end"), and it never comes near anything: every
 * point of the route keeps a clearance above the highest thing anywhere in a
 * corridor round it, as far as anything is known (engine/flight/obstacles.js
 * answers "how high can anything here be": an upper bound, never an
 * estimate).
 *
 * Both the clearance and the corridor grow with the flight's distance (a
 * long flight passes high over everything; a hop of a few metres keeps a
 * couple of metres of air) and narrow towards both ends, where the flight
 * starts and ends where you are and where you asked to go. The lowest
 * allowed height is then made no steeper than HEIGHT.slope, so the climb
 * and descent it forces are flyable; the cruise is the highest of it, or
 * higher for comfort on long flights (HEIGHT.cruise: a tenth of the
 * distance above the higher end). Where the ends are below the lowest
 * allowed height, the flight goes straight up first and straight down last
 * (in plan.js). Between, the climb is a quarter of an ellipse along the
 * lead-in: straight up at first, leaning forward as it rises and level as it
 * reaches the cruise, its run HEIGHT.run times its rise; the descent the same
 * way round onto the arrival. Where something near the start or the end is
 * higher than that, the flight keeps above it, the corner between the two
 * rounded (smoothMax).
 *
 * Heights are metres above the ellipsoid; distances are along the route.
 */

import { runningMax, slopeLimitAbove, smoothMax } from '../../core/signal.js';

const DEG = Math.PI / 180;

/*
 * slope      the steepest climb or descent along the route (75°), where
 *            something in the way makes it so
 * run        the climb's (and descent's) horizontal run per metre of rise
 * clearance  air kept above the highest thing near the route: 2 m plus 3% of
 *            the distance, at most 300 m, and within half the distance to
 *            the nearer end plus 2 m
 * corridor   how far either side of the route counts as near it: 1% of the
 *            distance, at least 2 m, and within a quarter of the distance to
 *            the nearer end plus 2 m
 * cruise     the comfortable cruise above the higher end: 10% of the
 *            distance, at least 2 m, at most 300 km
 */
export const HEIGHT = {
  slope: Math.tan(75 * DEG),
  run: 0.6,
  clearance: { min: 2, share: 0.03, max: 300, ends: 0.5 },
  corridor: { min: 2, share: 0.01, ends: 0.25 },
  cruise: { min: 2, share: 0.1, max: 300e3 },
};

/** The clearance kept away from the ends of a flight of this distance. */
export function fullClearance(distance) {
  const c = HEIGHT.clearance;
  return Math.min(c.max, c.min + c.share * distance);
}

/**
 * The clearance kept `s` metres along a route `length` long: growing from
 * the clearance at the nearer end, `start` or `end` (HEIGHT.clearance.min
 * if not given; Stage 5.7: where the camera stands clear of everything by
 * less, from that, so a walker in the open leaves at an angle rather than
 * first rising straight up).
 */
export function clearanceAt(distance, length, s, start = HEIGHT.clearance.min, end = HEIGHT.clearance.min) {
  const c = HEIGHT.clearance, first = s <= length - s, fromEnd = first ? s : length - s;
  return Math.min(fullClearance(distance), (first ? start : end) + c.ends * fromEnd);
}

/** The corridor's half-width `s` metres along a route `length` long. */
export function corridorAt(distance, length, s) {
  const c = HEIGHT.corridor, fromEnd = Math.min(s, length - s);
  return Math.min(Math.max(c.min, c.share * distance), c.min + c.ends * fromEnd);
}

/**
 * The highest thing under each sample of a route (`under`, within the
 * `corridor` radius of each), and the lowest height the flight may pass
 * each at (`lowest`). `bound(x, y, r)` gives the
 * height nothing within r metres of (x, y) can be above. A sample's corridor
 * is at least half the spacing, so between samples nothing is missed, and
 * each sample also takes its neighbours' highest, since the flight passes
 * between them. `ends` { start, end }: the clearance at either end
 * (clearanceAt).
 */
export function lowestAllowed(samples, bound, distance, ends = null) {
  const { n, S, X, Y } = samples, length = S[n - 1], gap = n > 1 ? S[1] - S[0] : 0;
  const under = new Float64Array(n), lowest = new Float64Array(n), corridor = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    corridor[i] = Math.max(corridorAt(distance, length, S[i]), 0.5 * gap);
    lowest[i] = under[i] = bound(X[i], Y[i], corridor[i]);
  }
  runningMax(lowest, 1);
  for (let i = 0; i < n; i++) lowest[i] += clearanceAt(distance, length, S[i], ends?.start, ends?.end);
  if (gap > 0) slopeLimitAbove(lowest, gap, HEIGHT.slope);
  return { under, lowest, corridor };
}

/** The comfortable cruise for a flight between these heights. */
export function comfortHeight(startHeight, endHeight, distance) {
  const c = HEIGHT.cruise;
  return Math.max(startHeight, endHeight) + Math.min(c.max, Math.max(c.min, c.share * distance));
}

/* A quarter ellipse from 0 to 1 over 0..1: straight up at 0, level at 1. */
export const ellipse = (u) => (u >= 1 ? 1 : u <= 0 ? 0 : Math.sqrt(u * (2 - u)));

/** Where along a quarter ellipse (0..1 of its run) it has risen a share e of its rise. */
export const ellipseAt = (e) => (e >= 1 ? 1 : e <= 0 ? 0 : 1 - Math.sqrt(1 - e * e));

/** The run a climb `rise` metres high takes (`run` metres a metre of rise). */
export function climbRun(rise, run = HEIGHT.run) {
  return run * Math.max(0, rise);
}

/**
 * The height along the route: a quarter ellipse up from `lift` over at
 * most `leadIn` metres, the cruise, and one down to `land` over at most
 * `leadOut`, and never below `lowest`: where that is higher (something near
 * an end), the height follows it, the corners rounded over a band a twentieth
 * of the climb wide (smoothMax never goes below either), less towards the
 * ends so the ends stay exact. `start` and `end` are where the flight begins
 * and ends; `floor` holds the cruise up. Returns { height (at each sample),
 * shape (the climbs and the cruise alone, at each sample), heightAt(s)
 * (anywhere along, `lowest` read between samples), lift, land, cruise, top,
 * up, down }: where the climbs start and end (from and to there, the flight
 * goes straight up or down), the highest lowest allowed height, and the
 * climbs' runs.
 */
export function heightProfile(samples, lowest, { start, end, leadIn, leadOut, floor, rounded = true, run = HEIGHT.run }) {
  const { n, S } = samples, length = S[n - 1];
  const lift = Math.max(start, lowest[0]), land = Math.max(end, lowest[n - 1]);
  let top = -Infinity;
  for (let i = 0; i < n; i++) if (lowest[i] > top) top = lowest[i];
  const cruise = Math.max(top, floor, lift, land);
  const up = Math.min(leadIn, climbRun(cruise - lift, run));
  const down = Math.min(leadOut, climbRun(cruise - land, run));
  const round = 0.05 * (cruise - Math.min(lift, land)) + 0.1;
  const gap = n > 1 ? length / (n - 1) : 1;
  // Not `rounded` (Stage 5.7): the plain higher of the two, which the caller
  // makes rise and fall only once (plan.js, unimodal).
  const alone = (s) => {
    let h = cruise;
    if (up > 0 && s < up) h = lift + (cruise - lift) * ellipse(s / up);
    if (down > 0 && length - s < down) h = Math.min(h, land + (cruise - land) * ellipse((length - s) / down));
    return h;
  };
  const shape = (s, low) => {
    const h = alone(s);
    if (!rounded) return h > low ? h : low;
    const k = round * Math.min(1, Math.min(s, length - s) / (4 * round));
    return smoothMax(h, low, k);
  };
  const heightAt = (s) => {
    const c = Math.max(0, Math.min(length, s));
    const f = gap > 0 ? c / gap : 0, i = Math.min(n - 2, Math.max(0, Math.floor(f))), u = Math.min(1, f - i);
    const low = n > 1 ? lowest[i] + (lowest[i + 1] - lowest[i]) * u : lowest[0];
    return shape(c, low);
  };
  const height = new Float64Array(n), pure = new Float64Array(n);
  for (let i = 0; i < n; i++) { height[i] = shape(S[i], lowest[i]); pure[i] = alone(S[i]); }
  // No room for a climb: straight up (or down) the whole way, at the start
  // (end), so the route starts (ends) at the cruise.
  return { height, shape: pure, heightAt, lift: up > 0 ? lift : height[0], land: down > 0 ? land : height[n - 1], cruise, top, up, down };
}
