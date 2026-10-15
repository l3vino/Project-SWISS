/* plan.js — a whole search flight, worked out before it starts.
 *
 * Pure: no state of the app, nothing but numbers in and a plan out, so the
 * same code runs in the app and in the flight tests (tools/flight-test.mjs).
 *
 *   route.js    the design: rise, curve, hand over, curve back, come down;
 *               where it goes, the curves shaped in time on flat stand-in
 *               ground
 *   profile.js  never near anything: the lowest height allowed along it
 *   timing.js   how fast: one bell, in heights above the ground a second
 *
 * Two questions about the world go in: `bound`, the height nothing near a
 * point reaches above (what the flight keeps clear of), and `ground`, how
 * high what is there reaches as best known (the ground at both ends).
 *
 * planFlight first looks at the space round both ends (Stage 5.7, his words:
 * "checks point A and B how much space it has around, so that when possible,
 * the path does not start straight 90 deg up. but at a curve"): along the
 * way the flight leaves and the way it comes in, the gentlest angle that
 * keeps clear of what is near (60° with nothing there, his answer; straight
 * up only when boxed in). It guesses the cruise from what stands along the
 * line to the place, designs the flight (route.js) and lays the design over
 * the real world: the lowest height allowed along it (profile.js). Where the
 * design dips under that, it is not bent over the obstacle there, which made
 * the little rises and falls he saw over ridges ("make sure there are no
 * subtle little height corrections"): the whole cruise goes higher, or that
 * end leaves (or comes in) more steeply, and it is designed again
 * (fitDesign). So seen from the side a flight rises, flies level and comes
 * down, never up, down and up again (unimodal, the last resort).
 *
 * FlightPlan then measures the path in heights above a smooth line from the
 * ground at the start to the ground at the end (timing.js, σ), the stand-in
 * the design was made on, not above the real ground (his words: "Over the
 * mountains the speed does not have to slow down!": a 10 km flight over a
 * 1,000 m ridge slowed from 1,580 to 476 m/s right in its middle), resamples
 * it evenly in that measure and times it with one bell; between samples it
 * is read in σ, so speed and acceleration never jump. Where the laid-out
 * path turns faster than designed, the bell is lengthened until it does not.
 *
 * The camera is the path (his words: "camera always looks at center of path
 * in front (camera does not have a max turning speed)"): it looks exactly
 * along it, its heading and its slope (VIEW.most at most), however fast that
 * changes. Only while rising the first VIEW.height metres, the slow start,
 * does it turn from your view onto the path, and back onto your view over the
 * last VIEW.height metres. It banks with how fast the path turns (the Bank in
 * turns setting at TURN.rate), and leans towards the straight line from the
 * start to the end the farther it is from it (LEAN), the two blended into one
 * bank.
 *
 * Hops too short for curves keep your view and fly one arc, a parabola (his
 * words: "The small hops should be like a parabola, not up, straight, down").
 * A trip whose S cannot be designed, or would turn faster than GLIDE.squeeze
 * times TURN.rate to fit Longest flight, flies straight there instead,
 * rising and coming down straight at the ends; the camera still looks along
 * the path, and turns round the vertical while it looks straight up and
 * straight down there (his words: "the camera (that is following the center
 * of the path) is also looking down, you can just rotate/spin around the
 * path, so that final horizontal camera will be set, and only has to pitch").
 *
 * What the flight only learns on the way (where exactly a walker can land,
 * better ground at the place) moves the end of the path; the runtime reshapes
 * the part still ahead (flight.js).
 *
 * Coordinates are a Plane's (core/geo.js): x east, y north, metres; headings
 * are azimuths in the plane.
 */

import { Design, TURN, ANGLES, OPEN, shape } from './route.js';
import { HEIGHT, lowestAllowed, comfortHeight, heightProfile, fullClearance, corridorAt } from './profile.js';
import { PACE, bell, bellRate, bellAccel, bellInverse, segmentSigma, naturalDuration, allowedPeak } from './timing.js';
import { smootherstep, lastAtOrBelow, gaussianBlur, roundedAbove } from '../../core/signal.js';
import { wrapAngle } from '../../core/geo.js';

const DEG = Math.PI / 180;

/*
 * spacing     metres between route samples (for what is below), within
 *             minSamples..maxSamples
 * design      instants the design is laid out at
 * vertical    points for going straight up (or down) at an end
 * steep       points resolving a hop's or a glide's steep ends
 * perSigma    flight samples per unit of σ, within minFlight..maxFlight
 * fit         times a design may be made again to keep clear (fitDesign)
 * smooth      samples the headings' rates are blurred over, measuring the turns
 * headingBlur samples the headings and slopes are blurred over: a corner in
 *             the height (so in σ) would otherwise bend the rate of turn at
 *             one sample, a twitch of the view
 * round       where the height had to be pieced together from what it must
 *             clear (the last resorts: unimodal), its corners are rounded
 *             over this share of the samples (σ of a Gaussian, never under
 *             what it rounds: roundedAbove), so the camera, which looks
 *             along the path, never snaps up or down at a corner
 */
export const FLIGHT = {
  spacing: 2,
  minSamples: 64,
  maxSamples: 1024,
  design: 1024,
  vertical: 48,
  steep: 48,
  perSigma: 128,
  minFlight: 256,
  maxFlight: 4096,
  fit: 8,
  smooth: 1,
  headingBlur: 2,
  round: 0.04,
};

/* A hop shorter than `distance` metres, or than `heights` times the height
 * above the ground it starts at, has no room for curves: it flies one arc
 * straight there with the view kept as it was. So does a trip shorter than
 * `fallback` metres whose S cannot be designed (its climb and descent alone
 * would carry it past the place) or would turn faster than `squeeze` times
 * TURN.rate to fit Longest flight (30°/s); a longer one flies straight there
 * rising and coming down straight, the camera on the path (spinPlan), its
 * climb leaning into the cruise over `run` metres a metre of rise (the
 * camera tilts down along it: 0.6, as elsewhere, bent it over in a fifth of
 * a second). */
export const GLIDE = { distance: 30, heights: 2, fallback: 500, squeeze: 1.5, run: 2 };

/* The line drawn along the path (passes/path.js): at most `most` points;
 * `below` heights under the path (none: the tube runs along the camera's own
 * path and the view looks down its middle; the pass fades it out round the
 * eye); a tube `radius` heights thick (heights above the ground plus the
 * pace's offset, so it looks alike high up and low down). */
export const LINE = { most: 1024, below: 0, radius: 0.0035 };

/* The view (see the top of the file): along the path, `most` up or down at
 * most (the camera's own limit: straight up or down along a vertical path);
 * turned from yours onto the path while rising the first `height` metres, or
 * the first half of the climb if it climbs less, and back over the last, for
 * at least `least` seconds of the flight's natural time either way. Where it
 * turns round the vertical at an end (spinPlan), `spin` of that time goes to
 * the turn and the rest to tilting. */
export const VIEW = { most: 89 * DEG, height: 100, least: 2.5, spin: 0.5 };

/* The space round an end (gentlestShape): looked at this many metres out
 * along the way the flight leaves (or comes in), as far as `share` of the
 * distance; a shape's start angle is taken `margin` steeper than a straight
 * line clearing it would need (the shape leans into level as it rises). */
export const SPACE = { steps: [2, 4, 8, 16, 32, 64, 128], share: 0.25, margin: 4 * DEG };

/* The lean towards the straight line from the start to the end (Stage 5.6,
 * his words: "the further the camera is from that imaginary line, the more
 * the tilt is"): in proportion to how far the path is from the line, the
 * Bank in turns setting where it is farthest, or where it is `full` of the
 * distance from it if it never gets that far (a trip almost straight ahead
 * hardly leans). */
export const LEAN = { full: 0.25 };

/* Late changes to the end (flight.js): they reshape the path from where the
 * flight is to its end, and from the descent on (or the last `share` of the
 * σ, at least), the flight waits for the place, if it must, from `hold` of
 * the way down on. */
export const END = { share: 0.25, hold: 0.6 };

/* An arrival not checked for buildings ends this far above anything within
 * this radius of it: above a tower rather than inside it. */
export const ARRIVAL = { radius: 1, margin: 1 };

/* Speed (a multiple of the natural pace), longest flight (seconds) and the
 * most bank (radians): the settings, as the General tab sets them. */
export const DEFAULT_SETTINGS = { speed: 1, longest: 30, maxBank: 15 * DEG };

/* Heights from a to b at one point, spaced evenly in the log of the height
 * above `g` (plus the pace's offset): `count` of them, a excluded, b included. */
function ratioSpaced(a, b, g, count) {
  const off = PACE.offset, lo = Math.max(0, a - g) + off, hi = Math.max(0, b - g) + off, out = [];
  for (let j = 1; j <= count; j++) out.push(a + (b - a) * ((lo * (hi / lo) ** (j / count) - lo) / (hi - lo || 1)));
  return out;
}

/* The 3D path before it is resampled: a list of points, a typed array per
 * field (distance along, position, height, heading, curvature, piece). */
class PointList {
  constructor(capacity) {
    this.n = 0;
    for (const f of ['s', 'x', 'y', 'h', 'heading', 'curvature']) this[f] = new Float64Array(capacity);
    this.piece = new Int8Array(capacity);
  }

  push(s, x, y, h, heading, curvature, piece) {
    const i = this.n++;
    this.s[i] = s; this.x[i] = x; this.y[i] = y; this.h[i] = h; this.heading[i] = heading;
    this.curvature[i] = curvature; this.piece[i] = piece;
  }
}

/* `n` points of a polyline evenly spaced by its distance along `s`:
 * { n, S, X, Y } (what lowestAllowed reads). */
function evenly(s, x, y, count, n) {
  const L = s[count - 1], S = new Float64Array(n), X = new Float64Array(n), Y = new Float64Array(n);
  for (let k = 0, i = 0; k < n; k++) {
    const target = n > 1 ? (L * k) / (n - 1) : 0;
    while (i < count - 2 && s[i + 1] < target) i++;
    const span = s[i + 1] - s[i], u = span > 0 ? Math.min(1, Math.max(0, (target - s[i]) / span)) : 0;
    S[k] = target;
    X[k] = x[i] + (x[i + 1] - x[i]) * u;
    Y[k] = y[i] + (y[i + 1] - y[i]) * u;
  }
  return { n, S, X, Y };
}

/* Reads a table along an increasing `s` (count values) at s0, linearly. */
function readAlong(s, table, count, s0) {
  const i = Math.min(count - 2, lastAtOrBelow(s, s0, count));
  const span = s[i + 1] - s[i], u = span > 0 ? Math.min(1, Math.max(0, (s0 - s[i]) / span)) : 0;
  return table[i] + (table[i + 1] - table[i]) * u;
}

/* A table read between samples k and k + 1, at v (0..1), on the uniform
 * Catmull-Rom spline through its samples (the ends mirrored). */
function spline(a, k, v, n) {
  const p1 = a[k], p2 = a[k + 1];
  const p0 = k > 0 ? a[k - 1] : 2 * p1 - p2, p3 = k + 2 < n ? a[k + 2] : 2 * p2 - p1;
  const v2 = v * v, v3 = v2 * v;
  return p1 + 0.5 * v * (p2 - p0) + v2 * (p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3) + v3 * (1.5 * (p1 - p2) + 0.5 * (p3 - p0));
}

/*
 * The space at an end, at height `height`: boxed in when anything within
 * HEIGHT.corridor.min reaches its height (the flight then first rises
 * straight up to clear it by HEIGHT.clearance.min: `height` is where that
 * ends), else free, with the clearance it has there (`clear`, at most
 * HEIGHT.clearance.min), from which the clearance kept grows (profile.js).
 */
function endSpace(bound, x, y, height) {
  const near = bound(x, y, HEIGHT.corridor.min), c = HEIGHT.clearance.min;
  if (near > height - 0.05) return { boxed: true, height: near + c, clear: c };
  return { boxed: false, height, clear: Math.min(c, height - near) };
}

/*
 * The gentlest climb out of (or descent into) an end at (x, y), height h,
 * leaving along `heading`: the first start angle (ANGLES) a straight line
 * from there clears what is near with, SPACE.margin to spare, out to
 * SPACE.share of the distance. fitDesign checks the real path afterwards.
 */
function gentlestShape(bound, x, y, heading, h, clear, distance) {
  let need = -Infinity;
  const sx = Math.sin(heading), sy = Math.cos(heading), most = fullClearance(distance);
  for (const d of SPACE.steps) {
    if (d > SPACE.share * distance) break;
    const top = bound(x + d * sx, y + d * sy, corridorAt(distance, distance, d)) + Math.min(most, clear + HEIGHT.clearance.ends * d);
    need = Math.max(need, Math.atan2(top - h, d));
  }
  for (let a = 0; a < ANGLES.length; a++) if (ANGLES[a] >= need + SPACE.margin) return shape(a, OPEN.lean);
  return shape(ANGLES.length - 1, OPEN.lean);
}

/* The design's height at each of its samples: the climb's and the descent's
 * shapes over the ground at their ends, the cruise between. */
function designHeights(design, path) {
  const off = PACE.offset, h = new Float64Array(path.n);
  for (let i = 0; i < path.n; i++) {
    const c = path.climbing[i];
    h[i] = c === 1 ? design.g0 + path.above[i] - off : c === 2 ? design.g1 + path.above[i] - off : design.cruise;
  }
  return h;
}

/*
 * Designs the flight and keeps it clear of everything without bending it
 * over what is in the way: where the design dips under the lowest allowed
 * height, the cruise goes up (in the cruise) or that end's shape gets
 * steeper (in its climb or descent), and it is designed again, FLIGHT.fit
 * times at most. Where it cannot be designed at all (the climb and the
 * descent alone carry it past the place), both ends' shapes cover less
 * ground. Returns { design, path, R, low, heights, clear } (the last tried
 * if none kept clear: the caller makes it rise and fall only once), or null.
 */
function fitDesign(p, bound, distance, ends) {
  let result = null;
  for (let round = 0; round < FLIGHT.fit; round++) {
    const design = Design.solve(p);
    if (!design) {
      const up = p.up.shorter(), down = p.down.shorter();
      if (!up && !down) return result;
      if (up) p.up = up;
      if (down) p.down = down;
      continue;
    }
    const path = design.sample(FLIGHT.design);
    const n = Math.round(Math.min(FLIGHT.maxSamples, Math.max(FLIGHT.minSamples, path.s[path.n - 1] / FLIGHT.spacing)));
    const R = evenly(path.s, path.x, path.y, path.n, n);
    const low = lowestAllowed(R, bound, distance, ends);
    const heights = designHeights(design, path);
    let climb = false, descent = false, top = -Infinity;
    for (let i = 0, j = 0; i < R.n; i++) {
      const h = readAlong(path.s, heights, path.n, R.S[i]);
      if (h >= low.lowest[i] - 0.05) continue;
      while (j < path.n - 1 && path.s[j + 1] <= R.S[i]) j++;
      const c = path.climbing[j];
      if (c === 1) climb = true;
      else if (c === 2) descent = true;
      else top = Math.max(top, low.lowest[i]);
    }
    result = { design, path, R, low, heights, clear: !climb && !descent && top === -Infinity };
    if (result.clear) return result;
    // The cruise over what is in its way; an end that cannot get steeper
    // reaches higher sooner with a higher cruise.
    let raise = top > -Infinity ? top + 0.5 : -Infinity;
    if (climb) { const s = p.up.steeper() ?? p.up.shorter(); if (s) p.up = s; else raise = Math.max(raise, p.cruise * 1.1); }
    if (descent) { const s = p.down.steeper() ?? p.down.shorter(); if (s) p.down = s; else raise = Math.max(raise, p.cruise * 1.1); }
    if (raise > p.cruise) p.cruise = raise;
  }
  return result;
}

/*
 * Heights that rise and fall only once (the last resort, where no design
 * kept clear): each at least what is allowed under it, never lower than
 * any before it up to the highest, nor than any after it beyond.
 */
function unimodal(h, lowest) {
  const n = h.length;
  let top = 0;
  for (let i = 0; i < n; i++) { if (lowest[i] > h[i]) h[i] = lowest[i]; if (h[i] > h[top]) top = i; }
  for (let i = 1; i <= top; i++) if (h[i] < h[i - 1]) h[i] = h[i - 1];
  for (let i = n - 2; i >= top; i--) if (h[i] < h[i + 1]) h[i] = h[i + 1];
  return h;
}

/*
 * A smooth shape (`base`, in place) raised to rise and fall only once over
 * `lowest` (unimodal), the raise's corners rounded without lowering it
 * anywhere (FLIGHT.round), and made to rise and fall only once again: the
 * last resorts keep clear without a corner the camera, which looks along
 * the path, would snap up or down at.
 */
function raiseSmoothly(base, lowest) {
  const n = base.length, raised = unimodal(Float64Array.from(base), lowest), lift = new Float64Array(n);
  for (let i = 0; i < n; i++) lift[i] = raised[i] - base[i];
  roundedAbove(lift, FLIGHT.round);
  for (let i = 0; i < n; i++) base[i] += lift[i];
  return unimodal(base, lowest);
}

/**
 * @param from   { x, y, height, heading, pitch }: where the camera is and
 *               which way it faces
 * @param to     { x, y, height, heading, exact }: where to arrive, facing
 *               which way; `exact` when the spot is known to be clear (a
 *               landing spot), else the arrival keeps above what is there
 * @param bound  (x, y, r) => the height nothing within r metres can be above
 * @param ground (x, y, r) => how high what is within r metres reaches, as best
 *               known (the bound, if not given)
 * @param endPitch  the view's tilt on arrival
 * @param glide     a hop straight there, the view kept (true), curves
 *                  (false), or whichever suits the distance (undefined, GLIDE)
 * @returns a FlightPlan, or null when there is nowhere to go
 */
export function planFlight({ from, to, bound, ground = bound, settings = DEFAULT_SETTINGS, endPitch = from.pitch ?? 0, glide }) {
  const dx = to.x - from.x, dy = to.y - from.y, distance = Math.sqrt(dx * dx + dy * dy);
  if (!(distance > 0.01)) return null;
  const off = PACE.offset;
  const arrive = to.exact ? to.height : Math.max(to.height, bound(to.x, to.y, ARRIVAL.radius) + ARRIVAL.margin);
  const comfort = comfortHeight(from.height, arrive, distance);
  const clearance = fullClearance(distance);
  const g0 = ground(from.x, from.y, 0), g1 = ground(to.x, to.y, 0);
  const above = Math.max(0, from.height - g0);
  const toEnd = { ...to, height: arrive };
  const common = { from, to: toEnd, bound, distance, comfort, settings, endPitch, g0, g1 };
  const gliding = glide ?? distance < Math.max(GLIDE.distance, GLIDE.heights * above);
  if (gliding) return hopPlan(common);

  // A first guess of the cruise, from the highest thing in a wide band along
  // the line between the ends.
  let cruise = comfort;
  const looks = 16, wide = (0.5 * distance) / looks + 0.3 * distance;
  for (let k = 0; k <= looks; k++) {
    const f = k / looks;
    cruise = Math.max(cruise, bound(from.x + dx * f, from.y + dy * f, wide) + clearance);
  }
  // The space at both ends: straight up first only where boxed in, else the
  // gentlest angle that clears what is near along the way out (and in).
  const start = endSpace(bound, from.x, from.y, from.height), end = endSpace(bound, to.x, to.y, arrive);
  const lift = start.height, land = end.height, steepest = ANGLES.length - 1;
  const ends = { start: start.clear, end: end.clear };
  const p = { x0: from.x, y0: from.y, h0: from.heading, x1: to.x, y1: to.y, h1: to.heading, g0, g1,
    a0: Math.max(0, lift - g0) + off, a1: Math.max(0, land - g1) + off, cruise: Math.max(cruise, lift, land), pace: PACE.peak,
    up: start.boxed ? shape(steepest, OPEN.lean) : gentlestShape(bound, from.x, from.y, from.heading, lift, start.clear, distance),
    down: end.boxed ? shape(steepest, OPEN.lean) : gentlestShape(bound, to.x, to.y, to.heading + Math.PI, land, end.clear, distance) };
  // The trip's pace (timing.js, allowedPeak): from the straight way there.
  const straight = new Design(p);
  p.pace = allowedPeak(straight.sigmaUp + straight.sigmaDown + distance / (p.cruise - Math.max(g0, g1) + off), distance);

  const fit = fitDesign(p, bound, distance, ends);
  if (!fit) return distance >= GLIDE.fallback ? spinPlan(common) : hopPlan(common);
  const { design, path, R, low, heights } = fit;
  // The last resort where nothing kept clear: rise and fall only once.
  if (!fit.clear) {
    const lowAt = new Float64Array(path.n);
    for (let i = 0; i < path.n; i++) lowAt[i] = readAlong(R.S, low.lowest, R.n, path.s[i]);
    raiseSmoothly(heights, lowAt);
  }

  // The design over the real world, and straight up first (down last) where
  // an end is boxed in.
  const L = path.s[path.n - 1];
  const pts = new PointList(path.n + 2 * FLIGHT.vertical + 2);
  const add = (i, h, piece) => pts.push(path.s[i], path.x[i], path.y[i], h, path.heading[i], piece == null ? path.curvature[i] : 0, piece ?? path.piece[i]);
  add(0, from.height, lift > from.height + 1e-6 ? -1 : null);
  if (lift > from.height + 1e-6) for (const h of ratioSpaced(from.height, lift, g0, FLIGHT.vertical)) add(0, h, -1);
  for (let i = 1; i < path.n - 1; i++) add(i, heights[i]);
  add(path.n - 1, land);
  if (land > arrive + 1e-6) for (const h of ratioSpaced(land, arrive, g1, FLIGHT.vertical)) add(path.n - 1, h, 5);
  pts.h[0] = from.height;
  pts.h[pts.n - 1] = arrive;

  const plan = new FlightPlan({
    from, to: toEnd, distance, points: pts, settings, endPitch, kind: 'curve', pace: p.pace, g0, g1,
    cruise: p.cruise, lift, land, design, samples: R, lowest: low.lowest,
    route: { word: design.word, turns: [design.turn1, design.turn2], length: L, up: p.up, down: p.down },
  });
  // Turning too fast to fit Longest flight (Flight speed aside): straight there.
  const speed = Math.max(0.05, settings.speed);
  if (plan.peakTurnRate / speed > GLIDE.squeeze * TURN.rate) return distance >= GLIDE.fallback ? spinPlan(common) : hopPlan(common);
  return plan;
}

/* Route samples along the straight line between two points. */
function straightSamples(from, to, distance) {
  const n = Math.round(Math.min(FLIGHT.maxSamples, Math.max(FLIGHT.minSamples, distance / FLIGHT.spacing)));
  const R = { n, S: new Float64Array(n), X: new Float64Array(n), Y: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    R.S[i] = distance * f;
    R.X[i] = from.x + (to.x - from.x) * f;
    R.Y[i] = from.y + (to.y - from.y) * f;
  }
  return R;
}

/*
 * A hop: straight there along one arc, a parabola over the line between
 * the ends (his words: "like a parabola, not up, straight, down"), its top
 * as high above that line as the comfortable cruise, or higher where
 * something near the way needs it (the lowest it may pass anywhere, over the
 * parabola's height there); the view kept, turned evenly onto the end's.
 * Boxed in at an end, it rises (or comes down) straight there first, and
 * where a parabola would leave steeper than SPACE's steepest angle, it falls
 * back on a climb, a level stretch and a descent.
 */
function hopPlan({ from, to, bound, distance, comfort, settings, endPitch, g0, g1 }) {
  const R = straightSamples(from, to, distance);
  const start = endSpace(bound, from.x, from.y, from.height), end = endSpace(bound, to.x, to.y, to.height);
  const low = lowestAllowed(R, bound, distance, { start: start.clear, end: end.clear });
  const h0 = start.height, h1 = end.height, heading = Math.atan2(to.x - from.x, to.y - from.y);
  // The parabola h0 + (h1 - h0) u + 4 K u (1 - u): K from the comfortable
  // top, and from everything it must clear.
  let K = Math.max(0, comfort - (h0 + h1) / 2);
  for (let i = 1; i < R.n - 1; i++) {
    const u = R.S[i] / distance, chord = h0 + (h1 - h0) * u, need = (low.lowest[i] - chord) / (4 * u * (1 - u));
    if (need > K) K = need;
  }
  const steep = Math.tan(ANGLES[ANGLES.length - 1] - SPACE.margin);
  const arc = Math.abs((h1 - h0 + 4 * K) / distance) <= steep && Math.abs((h1 - h0 - 4 * K) / distance) <= steep;
  const height = arc ? (s) => { const u = s / distance; return h0 + (h1 - h0) * u + 4 * K * u * (1 - u); } : null;
  // Too steep for one arc: a climb, the cruise and a descent, rising and
  // falling only once (unimodal) where something near the way pins the top.
  let at = height;
  if (!arc) {
    const profile = heightProfile(R, low.lowest, { start: h0, end: h1, leadIn: distance / 2, leadOut: distance / 2, floor: comfort, rounded: false });
    const once = raiseSmoothly(Float64Array.from(profile.shape), low.lowest);
    at = (s) => Math.max(profile.heightAt(s), readAlong(R.S, once, R.n, s));
  }
  // Points: evenly along, and finer near both ends, where the height above
  // the ground is least (σ, so the pace, changes fastest there).
  const middle = [];
  for (let k = 1; k < R.n - 1; k++) middle.push(R.S[k]);
  const first = Math.min(R.S[1], distance / 4);
  for (let j = 1; j < FLIGHT.steep; j++) {
    const d = first * (0.002 ** (1 - j / FLIGHT.steep));
    middle.push(d, distance - d);
  }
  middle.sort((a, b) => a - b);
  const pts = new PointList(middle.length + 2 * FLIGHT.vertical + 4);
  const add = (s, h, piece) => pts.push(s, from.x + (to.x - from.x) * (s / distance), from.y + (to.y - from.y) * (s / distance), h, heading, 0, piece);
  add(0, from.height, h0 > from.height + 1e-6 ? -1 : 2);
  if (h0 > from.height + 1e-6) for (const h of ratioSpaced(from.height, h0, g0, FLIGHT.vertical)) add(0, h, -1);
  let last = 0;
  for (const s of middle) {
    if (!(s > last + 1e-6 && s < distance - 1e-6)) continue;
    add(s, at(s), 2);
    last = s;
  }
  add(distance, h1, 2);
  if (h1 > to.height + 1e-6) for (const h of ratioSpaced(h1, to.height, g1, FLIGHT.vertical)) add(distance, h, 5);
  pts.h[0] = from.height;
  pts.h[pts.n - 1] = to.height;
  let top = -Infinity;
  for (let i = 0; i < pts.n; i++) top = Math.max(top, pts.h[i]);
  return new FlightPlan({
    from, to, distance, points: pts, settings, endPitch, kind: 'hop', g0, g1,
    pace: allowedPeak(distance / (Math.max(0, Math.max(from.height, to.height) - Math.max(g0, g1)) + PACE.offset), distance),
    cruise: Math.max(h0, h1, top), lift: h0, land: h1, design: null, samples: R, lowest: low.lowest,
    route: { word: arc ? 'arc' : 'hop', turns: [0, 0], length: distance },
  });
}

/*
 * Straight there, the camera on the path (see the top of the file): straight
 * up from the start for `rise` metres (VIEW.height, or less on a short
 * climb), leaning into the cruise along a quarter ellipse, and the same down
 * at the end; the view turns round the vertical while it looks straight up
 * and straight down there. Where those stretches pass too quickly for the
 * turns (VIEW.least), they are made taller.
 */
function spinPlan({ from, to, bound, distance, comfort, settings, endPitch, g0, g1 }) {
  const R = straightSamples(from, to, distance);
  const heading = Math.atan2(to.x - from.x, to.y - from.y);
  const start = endSpace(bound, from.x, from.y, from.height), end = endSpace(bound, to.x, to.y, to.height);
  const ends = { start: HEIGHT.clearance.min, end: HEIGHT.clearance.min };
  let plan = null;
  for (let attempt = 0, scale = 1; attempt < 3; attempt++, scale *= 2) {
    const low = lowestAllowed(R, bound, distance, ends);
    let top = -Infinity;
    for (let i = 0; i < R.n; i++) top = Math.max(top, low.lowest[i]);
    const cruise = Math.max(comfort, top, start.height, end.height);
    const rise0 = Math.min(VIEW.height * scale, 0.5 * (cruise - start.height));
    const rise1 = Math.min(VIEW.height * scale, 0.5 * (cruise - end.height));
    const h0 = Math.max(start.height, from.height + rise0), h1 = Math.max(end.height, to.height + rise1);
    const profile = heightProfile(R, low.lowest, { start: h0, end: h1, leadIn: distance / 2, leadOut: distance / 2, floor: cruise,
      rounded: false, run: GLIDE.run });
    const heights = new Float64Array(R.n);
    for (let i = 0; i < R.n; i++) heights[i] = profile.shape[i];
    raiseSmoothly(heights, low.lowest);
    const middle = [];
    for (let k = 1; k < R.n - 1; k++) middle.push(R.S[k]);
    // The steep halves of the ellipses in fine steps.
    const up = profile.up, down = profile.down;
    for (let j = 1; j < FLIGHT.steep; j++) {
      const f = (j / FLIGHT.steep) ** 3;
      if (up > 0) middle.push(up * 0.5 * f);
      if (down > 0) middle.push(distance - down * 0.5 * f);
    }
    middle.sort((a, b) => a - b);
    const pts = new PointList(middle.length + 2 * FLIGHT.vertical + 4);
    const add = (s, h, piece) => pts.push(s, from.x + (to.x - from.x) * (s / distance), from.y + (to.y - from.y) * (s / distance), h, heading, 0, piece);
    add(0, from.height, -1);
    for (const h of ratioSpaced(from.height, profile.lift, g0, FLIGHT.vertical)) add(0, h, -1);
    let last = 0;
    for (const s of middle) {
      if (!(s > last + 1e-6 && s < distance - 1e-6)) continue;
      add(s, Math.max(profile.heightAt(s), readAlong(R.S, heights, R.n, s)), 2);
      last = s;
    }
    add(distance, profile.land, 2);
    for (const h of ratioSpaced(profile.land, to.height, g1, FLIGHT.vertical)) add(distance, h, 5);
    pts.h[0] = from.height;
    pts.h[pts.n - 1] = to.height;
    plan = new FlightPlan({
      from, to, distance, points: pts, settings, endPitch, kind: 'spin', g0, g1,
      pace: allowedPeak(distance / (Math.max(0, cruise - Math.max(g0, g1)) + PACE.offset), distance),
      cruise: profile.cruise, lift: profile.lift, land: profile.land, design: null, samples: R, lowest: low.lowest,
      route: { word: 'spin', turns: [0, 0], length: distance },
    });
    const least = VIEW.least / plan.compress;
    if (plan.spinIn >= least && plan.spinOut >= least) break;
  }
  return plan;
}

/**
 * Plans a few flights over flat ground, so the first real one runs on
 * compiled code (cold, a plan took 120 ms in the rig; warm, a few).
 */
export function warmUpPlanner() {
  const flat = () => 500;
  for (const [d, heading] of [[20, 1], [800, 2.5], [40000, -2]]) {
    planFlight({ from: { x: -d, y: d / 3, height: 520, heading, pitch: -0.2 },
      to: { x: 0, y: 0, height: 510, heading, exact: true }, bound: flat });
  }
}

/**
 * A flight: its path sampled evenly in σ (positions, heights, headings,
 * slopes, curvature), the bell's length, and `at(t)` to read it at any time.
 * Kinds: 'curve' (the S), 'hop' (one arc, the view kept), 'spin' (straight
 * there, turning round the vertical at the ends). Pieces: -1 straight up, 0
 * climbing before the first curve, 1 and 3 the curves, 4 after the second,
 * 5 straight down (a hop or a spin plan is all 2 between).
 */
export class FlightPlan {
  constructor({ from, to, distance, points, settings, endPitch, kind, pace, g0, g1, cruise, lift, land, design, samples, lowest, route }) {
    this.distance = distance;
    this.pace = pace;              // the trip's peak pace, heights a second (timing.js, allowedPeak)
    this.settings = settings;
    this.kind = kind;
    this.glide = kind !== 'curve';
    this.travel = Math.atan2(to.x - from.x, to.y - from.y);
    this.design = design;
    this.route = route;
    this.samples = samples;
    this.lowest = lowest;
    this.profile = { cruise, lift, land };
    this.startHeading = from.heading;
    this.startPitch = from.pitch ?? 0;
    this.endPitch = endPitch;
    this.endHeading = to.heading;
    this.endHeight = to.height;
    this.endX = to.x;
    this.endY = to.y;
    this.g0 = g0;
    this.g1 = g1;
    this.#build(points, from, to);
    this.#time();
    this.#views();
  }

  /* The path in 3D, sampled evenly in σ (against the line from the ground at
   * the start to the ground at the end: see the top of the file). */
  #build(P, from, to) {
    const off = PACE.offset, nP = P.n, sig = new Float64Array(nP), L = Math.max(1e-9, P.s[nP - 1]);
    const ref = new Float64Array(nP);
    for (let i = 0; i < nP; i++) ref[i] = this.g0 + (this.g1 - this.g0) * Math.min(1, Math.max(0, P.s[i] / L));
    for (let i = 1; i < nP; i++) {
      sig[i] = sig[i - 1] + segmentSigma(Math.hypot(P.x[i] - P.x[i - 1], P.y[i] - P.y[i - 1]), P.h[i] - P.h[i - 1],
        Math.max(0, P.h[i - 1] - ref[i - 1]) + off, Math.max(0, P.h[i] - ref[i]) + off);
    }
    const sigma = sig[nP - 1];
    const m = Math.round(Math.min(FLIGHT.maxFlight, Math.max(FLIGHT.minFlight, sigma * FLIGHT.perSigma)));
    const x = new Float64Array(m), y = new Float64Array(m), h = new Float64Array(m), heading = new Float64Array(m);
    const curvature = new Float64Array(m), ground = new Float64Array(m), along = new Float64Array(m), piece = new Int8Array(m);
    for (let k = 0, i = 0; k < m; k++) {
      const target = (sigma * k) / (m - 1);
      while (i < nP - 2 && sig[i + 1] < target) i++;
      const j = i + 1, span = sig[j] - sig[i], u = span > 0 ? Math.min(1, Math.max(0, (target - sig[i]) / span)) : 0;
      // Across the ground on a cubic leaving and arriving along the headings
      // there (the design's own directions), so a long route's few points
      // still turn smoothly between them, the way it heads.
      const ex = P.x[j] - P.x[i], ey = P.y[j] - P.y[i], chord = Math.sqrt(ex * ex + ey * ey);
      const h00 = (1 + 2 * u) * (1 - u) * (1 - u), h10 = u * (1 - u) * (1 - u), h01 = u * u * (3 - 2 * u), h11 = u * u * (u - 1);
      x[k] = h00 * P.x[i] + h01 * P.x[j] + chord * (h10 * Math.sin(P.heading[i]) + h11 * Math.sin(P.heading[j]));
      y[k] = h00 * P.y[i] + h01 * P.y[j] + chord * (h10 * Math.cos(P.heading[i]) + h11 * Math.cos(P.heading[j]));
      h[k] = P.h[i] + (P.h[j] - P.h[i]) * u;
      heading[k] = P.heading[i] + (P.heading[j] - P.heading[i]) * u;
      curvature[k] = P.curvature[i] + (P.curvature[j] - P.curvature[i]) * u;
      ground[k] = ref[i] + (ref[j] - ref[i]) * u;
      along[k] = P.s[i] + (P.s[j] - P.s[i]) * u;
      piece[k] = u < 0.5 ? P.piece[i] : P.piece[j];
    }
    x[0] = from.x; y[0] = from.y; h[0] = from.height;
    x[m - 1] = to.x; y[m - 1] = to.y; h[m - 1] = to.height;
    gaussianBlur(heading.slice(), FLIGHT.headingBlur, heading, 'edge');
    heading[0] = P.heading[0];
    heading[m - 1] = P.heading[nP - 1];
    // The path's slope (the view looks up and down along it), blurred as
    // the headings are, VIEW.most at most.
    const rawSlope = new Float64Array(m), slope = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1), fx = x[b] - x[a], fy = y[b] - y[a];
      rawSlope[k] = Math.atan2(h[b] - h[a], Math.sqrt(fx * fx + fy * fy));
    }
    gaussianBlur(rawSlope, FLIGHT.headingBlur, slope, 'edge');
    for (let k = 0; k < m; k++) slope[k] = Math.max(-VIEW.most, Math.min(VIEW.most, slope[k]));
    // The lean (LEAN): how far each sample is from the straight line from the
    // start to the end (positive to the right of the way from one to the
    // other), turned into a bank towards the line as the camera faces there,
    // as a share of the farthest (or of LEAN.full of the distance).
    const lx = to.x - from.x, ly = to.y - from.y, ll = Math.sqrt(lx * lx + ly * ly) || 1;
    const nx = ly / ll, ny = -lx / ll, lean = new Float64Array(m);
    let farthest = LEAN.full * ll;
    for (let k = 0; k < m; k++) {
      const e = (x[k] - from.x) * nx + (y[k] - from.y) * ny;
      farthest = Math.max(farthest, Math.abs(e));
      lean[k] = -e * (nx * Math.cos(heading[k]) - ny * Math.sin(heading[k]));
    }
    for (let k = 0; k < m; k++) lean[k] = Math.max(-1, Math.min(1, lean[k] / farthest));
    lean[0] = lean[m - 1] = 0;
    // Metres a unit of σ is along each step, and across the ground.
    const step = sigma / Math.max(1, m - 1), perSigma = new Float64Array(m), flatPerSigma = new Float64Array(m);
    for (let k = 0; k < m - 1; k++) {
      const ex = x[k + 1] - x[k], ey = y[k + 1] - y[k], ez = h[k + 1] - h[k];
      perSigma[k] = step > 0 ? Math.sqrt(ex * ex + ey * ey + ez * ez) / step : 0;
      flatPerSigma[k] = step > 0 ? Math.sqrt(ex * ex + ey * ey) / step : 0;
    }
    perSigma[m - 1] = perSigma[m - 2] ?? 0;
    flatPerSigma[m - 1] = flatPerSigma[m - 2] ?? 0;
    // How fast the heading turns per unit of σ, and how fast that changes:
    // from the headings themselves (the view follows them), smoothed over a
    // few samples, since the design was laid out at instants and resampled.
    const raw = new Float64Array(m), turnPerSigma = new Float64Array(m), change = new Float64Array(m), turnChange = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
      raw[k] = step > 0 ? (heading[b] - heading[a]) / ((b - a) * step) : 0;
    }
    gaussianBlur(raw, FLIGHT.smooth, turnPerSigma, 0);
    for (let k = 0; k < m; k++) {
      const a = Math.max(0, k - 1), b = Math.min(m - 1, k + 1);
      change[k] = step > 0 ? (turnPerSigma[b] - turnPerSigma[a]) / ((b - a) * step) : 0;
    }
    gaussianBlur(change, FLIGHT.smooth, turnChange, 0);
    // Where late changes to the end start reshaping it at the latest (and
    // waiting for the place can start): the descent (where the height falls
    // below the cruise for good, or the piece after the second curve), and
    // the last END.share at least.
    const top = this.profile.cruise;
    let downAt = m - 1;
    for (let k = m - 1; k > 0 && h[k] < top - 0.05 * Math.max(0, top - to.height); k--) downAt = k;
    let afterAt = m - 1;
    for (let k = 0; k < m; k++) if (piece[k] >= 4) { afterAt = k; break; }
    const endFrom = Math.min((sigma * Math.min(downAt, afterAt)) / Math.max(1, m - 1), (1 - END.share) * sigma);
    let length = 0;
    for (let k = 0; k < m - 1; k++) length += perSigma[k] * step;
    Object.assign(this, {
      m, x, y, h, heading, curvature, ground, along, piece, sigma, sigmaStep: step,
      perSigma, flatPerSigma, turnPerSigma, turnChange, endFrom, length, slope, lean,
    });
  }

  /* The bell's length: the pace, the curves (timing.js), the settings. */
  #time() {
    const { m, sigma, turnPerSigma, turnChange } = this;
    const u = new Float64Array(m);
    for (let k = 0; k < m; k++) u[k] = bellInverse(k / Math.max(1, m - 1));
    this.u = u;
    // The fastest the path turns, and its turning changes, for a bell T long.
    const turns = (T) => {
      let rate = 0, accel = 0;
      const r = sigma / T;
      for (let k = 0; k < m; k++) {
        const e = bellRate(u[k]), a = bellAccel(u[k]);
        rate = Math.max(rate, Math.abs(turnPerSigma[k]) * r * e);
        accel = Math.max(accel, Math.abs(turnChange[k] * r * r * e * e + (turnPerSigma[k] * sigma * a) / (T * T)));
      }
      return { rate, accel };
    };
    // The design's own length, or longer where the laid-out path turns
    // faster than designed (the rate within a little of the design's: the
    // curves are laid over a resampled path).
    let natural = Math.max(this.design?.T ?? 0, naturalDuration(sigma, this.pace, null));
    if (this.kind === 'curve') {
      const { rate, accel } = turns(natural);
      natural = Math.max(natural, (natural * rate) / (TURN.rate * 1.02), natural * Math.sqrt(accel / TURN.accel));
    }
    const settings = this.settings;
    let T = natural / Math.max(0.05, settings.speed);
    if (T > settings.longest) T = settings.longest;
    this.natural = natural;
    this.duration = T;
    this.compress = natural / T;
    // Times and speeds at the samples.
    const time = new Float64Array(m), speed = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      time[k] = T * u[k];
      speed[k] = this.perSigma[k] * (sigma / T) * bellRate(u[k]);
    }
    speed[0] = 0;
    speed[m - 1] = 0;
    time[m - 1] = T;
    this.time = time;
    this.speed = speed;
    const peaks = this.kind === 'curve' ? turns(T) : { rate: 0, accel: 0 };
    this.peakTurnRate = peaks.rate;
    this.peakTurnAccel = peaks.accel;
    this.peakPace = (1.875 * sigma) / T;
    this.holdTime = T * bellInverse((this.endFrom + END.hold * (sigma - this.endFrom)) / Math.max(sigma, 1e-12));
  }

  /*
   * How the view comes onto the path and back (see the top of the file):
   * `viewIn` and `viewOut`, the seconds at the start and the end over which
   * it turns, while the flight rises its first VIEW.height metres (or half
   * its climb) and comes down its last, VIEW.least of natural time at least,
   * at most 0.45 of the flight each. A spin plan turns while it rises and
   * comes down straight: `spinIn` and `spinOut`, the seconds of those
   * stretches.
   */
  #views() {
    const T = this.duration, c = this.compress, { m, h, time } = this;
    this.viewIn = this.viewOut = this.spinIn = this.spinOut = 0;
    if (this.kind === 'hop' || !(T > 0)) return;
    if (this.kind === 'spin') {
      let a = 0, b = m - 1;
      while (a < m - 1 && this.piece[a] === -1) a++;
      while (b > 0 && this.piece[b] === 5) b--;
      this.spinIn = this.viewIn = Math.min(0.45 * T, time[a]);
      this.spinOut = this.viewOut = Math.min(0.45 * T, T - time[b]);
      const turnIn = Math.abs(wrapAngle(this.travel - this.startHeading)), turnOut = Math.abs(wrapAngle(this.endHeading - this.travel));
      // The spins' fastest turning (smootherstep: 1.875 times the mean).
      this.peakTurnRate = Math.max(turnIn / Math.max(1e-6, VIEW.spin * this.spinIn), turnOut / Math.max(1e-6, VIEW.spin * this.spinOut)) * 1.875;
      return;
    }
    const least = Math.min(0.45 * T, VIEW.least / c), top = this.profile.cruise;
    const riseIn = Math.min(VIEW.height, 0.5 * Math.max(0, top - h[0]));
    const riseOut = Math.min(VIEW.height, 0.5 * Math.max(0, top - h[m - 1]));
    let a = 0, b = m - 1;
    while (a < m - 1 && h[a] - h[0] < riseIn) a++;
    while (b > 0 && h[b] - h[m - 1] < riseOut) b--;
    this.viewIn = Math.min(0.45 * T, Math.max(least, time[a]));
    this.viewOut = Math.min(0.45 * T, Math.max(least, T - time[b]));
  }

  /**
   * The flight at time t (seconds), into `out`: { index, x, y, height,
   * heading (the way it moves), speed (m/s), along, piece, sigma, progress
   * (0..1 of σ), yaw (the way it looks, a heading in the plane), pitch,
   * roll, onPath (1 where the view is exactly the path's, less while it
   * turns between yours and the path's) }.
   */
  at(t, out) {
    const T = this.duration, m = this.m;
    const u = t <= 0 || !(T > 0) ? 0 : t >= T ? 1 : t / T;
    const progress = bell(u), f = progress * (m - 1);
    const k = Math.min(m - 2, Math.floor(f)), v = Math.min(1, f - k);
    out.index = k;
    // Between samples on a Catmull-Rom spline (even steps in σ): the velocity
    // and the view's rate of turn carry on smoothly across samples.
    out.x = spline(this.x, k, v, m);
    out.y = spline(this.y, k, v, m);
    out.height = spline(this.h, k, v, m);
    out.heading = spline(this.heading, k, v, m);
    out.along = this.along[k] + (this.along[k + 1] - this.along[k]) * v;
    out.piece = this.piece[v < 0.5 ? k : k + 1];
    const s = progress * this.sigma, rate = T > 0 ? (this.sigma / T) * bellRate(u) : 0;
    out.sigma = s;
    out.progress = progress;
    out.speed = this.perSigma[k] * rate;
    const slope = Math.max(-VIEW.most, Math.min(VIEW.most, spline(this.slope, k, v, m)));
    const s0 = this.startPitch, s1 = this.endPitch, h0 = this.startHeading, h1 = this.endHeading;
    const tc = u * T;
    out.roll = 0;
    out.onPath = 1;
    if (this.kind === 'hop') {
      // The view kept, turned evenly onto the end's.
      const w = smootherstep(u);
      out.yaw = u >= 1 ? h1 : h0 + wrapAngle(h1 - h0) * w;
      out.pitch = s0 + (s1 - s0) * w;
      out.onPath = 0;
      return out;
    }
    if (this.kind === 'spin') {
      // Up: tilt onto the path (straight up), then turn round it to face the
      // way it goes; along it; down: turn round it to face your way, then
      // tilt onto your view.
      const tin = this.spinIn, tout = this.spinOut, travel = this.travel;
      out.yaw = travel;
      out.pitch = slope;
      if (tc < tin) {
        const half = (1 - VIEW.spin) * tin;
        if (tc < half) { out.yaw = h0; out.pitch = s0 + (slope - s0) * smootherstep(tc / half); }
        else out.yaw = h0 + wrapAngle(travel - h0) * smootherstep((tc - half) / (tin - half));
        out.onPath = smootherstep(tc / tin);
      } else if (tc > T - tout) {
        const into = tc - (T - tout), half = VIEW.spin * tout;
        if (into < half) out.yaw = travel + wrapAngle(h1 - travel) * smootherstep(into / half);
        else { out.yaw = h1; out.pitch = slope + (s1 - slope) * smootherstep((into - half) / (tout - half)); }
        out.onPath = smootherstep((T - tc) / tout);
      }
      if (u >= 1) { out.yaw = h1; out.pitch = s1; }
      if (u <= 0) { out.yaw = h0; out.pitch = s0; }
      return out;
    }
    // Along the path, turned from your view while rising its first metres
    // and back onto it while coming down its last.
    let yaw = out.heading, pitch = slope;
    const wIn = this.viewIn > 0 ? smootherstep(tc / this.viewIn) : 1;
    const wOut = this.viewOut > 0 ? smootherstep((T - tc) / this.viewOut) : 1;
    if (wIn < 1) { yaw = h0 + wrapAngle(yaw - h0) * wIn; pitch = s0 + (pitch - s0) * wIn; }
    if (wOut < 1) { yaw = h1 + wrapAngle(yaw - h1) * wOut; pitch = s1 + (pitch - s1) * wOut; }
    out.yaw = u >= 1 ? h1 : u <= 0 ? h0 : yaw;
    out.pitch = u >= 1 ? s1 : u <= 0 ? s0 : pitch;
    out.onPath = Math.min(wIn, wOut);
    // The bank, from how fast the path turns now, and the lean towards the
    // straight line between the ends (LEAN), as shares of the Bank in turns
    // setting, added the way tanh adds (the sum of tanh⁻¹ of both): each
    // alone is itself, together they add up and never pass the setting;
    // brought in and out with the view.
    const turn = (this.turnPerSigma[k] + (this.turnPerSigma[k + 1] - this.turnPerSigma[k]) * v) * rate;
    const near = 1 - 1e-9;
    const b = Math.max(-near, Math.min(near, turn / (TURN.rate * this.compress)));
    const l = Math.max(-near, Math.min(near, this.lean[k] + (this.lean[k + 1] - this.lean[k]) * v));
    out.roll = ((this.settings.maxBank * (b + l)) / (1 + b * l)) * out.onPath;
    return out;
  }

  /**
   * Points along the path for drawing it (passes/path.js): at most
   * LINE.most, evenly in σ (so as far apart on the screen high up as low
   * down), LINE.below heights under the path, with the time the flight passes
   * each, the tube's radius there, and σ along (where a late change of the
   * end moves each: flight.js, offsetAt). { n, x, y, h, t, radius, sigma,
   * step } (plane metres, heights, seconds; step: σ from one point to the
   * next).
   */
  line() {
    const { m, x, y, h, ground, time, sigma } = this, off = PACE.offset;
    const every = Math.max(1, Math.ceil((m - 1) / (LINE.most - 2)));
    const n = Math.floor((m - 1) / every) + 1 + ((m - 1) % every ? 1 : 0);
    const X = new Float64Array(n), Y = new Float64Array(n), H = new Float64Array(n), Tm = new Float64Array(n);
    const radius = new Float32Array(n), along = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const k = Math.min(m - 1, j * every), above = Math.max(0, h[k] - ground[k]) + off, s = (sigma * k) / Math.max(1, m - 1);
      X[j] = x[k];
      Y[j] = y[k];
      H[j] = h[k] - LINE.below * above;
      Tm[j] = time[k];
      radius[j] = LINE.radius * above;
      along[j] = s;
    }
    return { n, x: X, y: Y, h: H, t: Tm, radius, sigma: along, step: (sigma * every) / Math.max(1, m - 1) };
  }

  /** The sample at or before time t. */
  indexAt(t) {
    return Math.min(this.m - 2, lastAtOrBelow(this.time, t, this.m));
  }
}
