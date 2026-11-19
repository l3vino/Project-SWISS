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
 * distance above the higher end). How the flight climbs to it and comes
 * down is the design's (route.js, the Shapes); plan.js keeps the design
 * above the lowest allowed height everywhere (fitDesign), straight up first
 * and straight down last where an end is boxed in.
 *
 * Heights are metres above the ellipsoid; distances are along the route.
 */

import { runningMax, slopeLimitAbove } from '../../core/signal.js';

const DEG = Math.PI / 180;

/*
 * slope      the steepest climb or descent along the route (75°), where
 *            something in the way makes it so
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
