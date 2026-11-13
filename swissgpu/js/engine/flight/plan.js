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
 * up only when boxed in; from the ground in the open, leaving at a gentle
 * angle and curving up into it; from the air in the open, level and curving
 * up, and from the air or into it as gently as the view's tilt needs:
 * PITCH). The way it leaves is looked for all round (Stage 5.12b, his words:
 * "at the start it checks 360 around to see where the least steep angle
 * take off is and choose that": TAKEOFF), the way you face where no way is
 * gentler. It guesses the cruise from what stands along the
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
 * path turns faster than designed, the bell is lengthened until it does not;
 * where the view tilts up or down faster than PITCH.rate, too, 1.5 times at
 * most (Stage 5.11b).
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
 * Trips under ARC.distance fly one arc straight to the place (Stage 5.8b, his
 * words: "small jumps should be like a parabola (continuous vertical
 * curvature)"; his answer: arriving at 60°), a parabola where there is room,
 * standing up into an arch where it must clear something, with your view
 * kept all the way, arriving facing the way you faced (Stage 5.11b, his
 * words: "when hop is close, don't turn the camera"; his answer: under 300 m;
 * until then the camera turned onto the arc and ended facing the way it
 * went, which only the last resort below still does). A
 * start in the open, well above everything near, leaves level and curves up
 * into its climb (route.js, the level Shape; his words: "start with a more
 * curved approach (like the destination)"); from the ground in the open it
 * leaves at a gentle angle and curves up into the climb (5.10b, CURVE). Every
 * trip from ARC.distance on is an S (5.10b, his words: "if not close, always
 * S shape, if not close and behind, still make S shape"): however fast it
 * must turn to fit Longest flight, and where no S can be designed it rises
 * straight up first and comes down straight last (LIFT), the S between.
 * (Until 5.10b such trips flew straight there, the view turning round the
 * vertical at the ends: his 5.7b idea, gone with "always S shape".)
 *
 * What the flight only learns on the way (where exactly a walker can land,
 * better ground at the place) moves the end of the path; the runtime reshapes
 * the part still ahead (flight.js).
 *
 * Coordinates are a Plane's (core/geo.js): x east, y north, metres; headings
 * are azimuths in the plane.
 */

import { Design, TURN, ANGLES, OPEN, CURVE, shape } from './route.js';
import { HEIGHT, lowestAllowed, comfortHeight, fullClearance, corridorAt } from './profile.js';
import { PACE, DURATION, bell, bellRate, bellAccel, bellInverse, segmentSigma, naturalDuration, allowedPeak } from './timing.js';
import { smoothstep, smootherstep, lastAtOrBelow, gaussianBlur, roundedAbove } from '../../core/signal.js';
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
 * turn        and at least one flight sample for every `turn` the route
 *             turns, round the vertical and up and down (5.10b): the view
 *             looks along the headings and slopes, blurred over headingBlur
 *             samples, while the camera moves along the positions, and the
 *             two drift apart with the turning between samples (an S turning
 *             236° each way, over 256 samples, looked 1.5° off the way it
 *             moved; over 768, 0.2°)
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
  turn: 1 * DEG,
};

/* A hop shorter than `distance` metres has no room for curves: it flies one
 * parabola straight there with the view kept as it was. (Until 5.10b a trip
 * shorter than a few times the height above the ground did too, and a trip
 * whose S could not be designed, or would turn too fast to fit Longest
 * flight, flew straight there, rising and coming down straight: 464 of the
 * 2,024 test flights. His words on 5.9b: "when I pick a destination, there
 * must always be an S shape, if CLOSE, alway go straight to the destination,
 * while height follows a parabola, if not close, always S shape, if not
 * close and behind, still make S shape".) */
export const GLIDE = { distance: 30 };

/* Where no S can be designed (the climb and the descent alone would carry
 * the flight past the place: a trip that is short against its height, or a
 * start boxed in under something tall), it rises straight up first (and
 * comes down straight last) these shares of the way to the cruise in turn,
 * the S between leaving straight up and coming in straight down. */
export const LIFT = { shares: [0.5, 0.8, 0.95] };

/* Short trips (Stage 5.8b, his words on 5.7b: "small jumps should be like a
 * parabola (continuous vertical curvature)"; up to 2.5 km a flight climbed at
 * 60° to a top only a tenth of the distance high, then flew level for 74-96%
 * of the way). Under `distance` metres a trip flies one arc straight to the
 * place, your view kept (arcPlan, keepView; 5.11b): a parabola arriving at
 * `angle` (his answer: 60°), its start as steep as the height between the
 * ends makes it, or level where the place is far below. With the camera on
 * the path (the last resort for a longer trip), where the view has to turn
 * round to face the place (more than `turn[0]` from where you look, all of
 * it by `turn[1]`), it leaves steeper, up to straight up, and turns while it
 * looks up. Between ±`steep` the arc is a graph of the height along the
 * way; steeper it stands up into an arch whose ends rise and come down
 * straight (hermiteArc). Where it would not clear what is in the way, both
 * ends steepen towards straight up, `steps` times, then the arch grows by
 * `grow` a time, `most` times. `points` along it; the view comes onto the
 * path while it rises `viewRise` of its way up (and back off over as much of
 * its way down), `least` seconds at least. */
export const ARC = { distance: 300, angle: 60 * DEG, steep: 75 * DEG, turn: [45 * DEG, 135 * DEG], steps: 6, grow: 1.4, most: 12,
  points: 480, viewRise: 0.5, least: 0.8 };

/* A start in the open (Stage 5.8b; route.js, the level Shape): at least
 * `above` metres over everything within `radius`, it leaves level and curves
 * up into the climb, where the gentlest angle that clears what is ahead is
 * below `steepest`. An end so high in the open, a start or an arrival, may
 * climb or come down less steeply than 60° (PITCH). */
export const AIR = { above: 15, radius: 30, steepest: 80 * DEG };

/* How fast the view tilts up and down (Stage 5.11b, his words: "on long S
 * flights make the vertical curve less sharp"; 5.10b's flights tilted it at
 * up to 100°/s where the climb bent over into the cruise): at most `rate`
 * at the trip's natural pace, where it can. An end in the air (AIR) climbs
 * (or comes down) at the steepest of ANGLES up to OPEN's 60° that keeps to
 * it at the pace the trip is planned with (airShape: the shapes' own tilt
 * rates over the bell, route.js), never less steeply than what is near asks
 * for; on the ground the climb stays the 60° he chose. What still tilts too
 * fast (a 60° climb from the street on a quick trip, one boxed in) makes
 * the bell longer, `longer` times at most (FlightPlan, #steady). */
export const PITCH = { rate: 25 * DEG, longer: 1.5 };

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
 * at least `least` seconds of the flight's natural time either way. Where an
 * arc's view turns round all the way to face the place, it tilts up first
 * over `tilt` of its way in (ARC.turn). */
export const VIEW = { most: 89 * DEG, height: 100, least: 2.5, tilt: 0.5 };

/* The space round an end (gentlestShape): looked at this many metres out
 * along the way the flight leaves (or comes in), as far as `share` of the
 * distance; a shape's start angle is taken `margin` steeper than a straight
 * line clearing it would need (the shape leans into level as it rises). */
export const SPACE = { steps: [2, 4, 8, 16, 32, 64, 128], share: 0.25, margin: 4 * DEG };

/* The way an S leaves (Stage 5.12b, his words: "in the flyTo, make sure that
 * at the start it checks 360 around to see where the least steep angle take
 * off is and choose that"): the gentlest climb (gentlestShape) along `steps`
 * headings all round. The least steep wins; the headings as gentle as that
 * make arcs round the circle, and of them the nearest the way you face, at
 * least `edge` inside it (its middle, if it is narrower): the S turns
 * towards the place as it climbs, and leaving along the edge of the open
 * way would turn it back over what closes it (a heading 15° past the end
 * of a wall 3 m away climbed at 70° once laid out, 30° past it at 60°). In
 * the open every way is as gentle, so it leaves the way you face, as
 * before, without looking round; facing a wall, it turns its back on it.
 * The view still starts where you look and turns onto the path as it rises
 * (VIEW). */
export const TAKEOFF = { steps: 72, edge: 30 * DEG };

/* The whole flown path checked before it flies (Stage 5.12b, his words:
 * "calculate collisions before starting animation, so you make sure the
 * camera does not traverse buildings and such things"; planVerified): at
 * `samples` of its points at most (the plan's own, evenly in σ, so densest
 * low down), each `margin` metres over everything within `radius` of it and
 * half the way to its neighbours (so nothing between two is missed), but
 * for right over either end (within `core` of it: where you stand, and the
 * spot's open column, which rise and come down straight where boxed in),
 * and less near the ends, as the plan keeps less there (keepNearEnds): no
 * more than the end itself is over what is near it, plus
 * HEIGHT.clearance.ends a metre away from it (profile.js, clearanceAt); and
 * where an end is under the bound (a coarse one, round a place not loaded
 * yet), the way may be as far under it there, less by as much a metre away.
 * Where it passes nearer, it is planned again round what is there made
 * `grow` metres wider and higher, each in turn, and the clearest flown. The
 * plan already keeps clear of the same bounds along its route; what this
 * catches is the flown path straying from the route between the route's
 * samples. */
export const VERIFY = { samples: 1024, radius: 0.5, margin: 1, core: 0.5, grow: [2, 6] };

/* A flight set off climbing (from.moving, from.slope: flight.js, CONTINUE)
 * steeper than `least` goes on up at that slope (climbLeaving); level or
 * coming down, it leaves as any start does, and the runtime gives up what it
 * had besides. */
export const LEAVE = { least: 3 * DEG };

/* The lean towards the straight line from the start to the end (Stage 5.6,
 * his words: "the further the camera is from that imaginary line, the more
 * the tilt is"): in proportion to how far the path is from the line, the
 * Bank in turns setting where it is farthest, or where it is `full` of the
 * distance from it if it never gets that far (a trip almost straight ahead
 * hardly leans). */
export const LEAN = { full: 0.25 };

/* An arrival not checked for buildings ends this far above anything within
 * this radius of it: above a tower rather than inside it. */
export const ARRIVAL = { radius: 1, margin: 1 };

/* Instants the tilt of a flight other than an S is measured at (FlightPlan, #steady). */
const TILT_SAMPLES = 2000;

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
 * leaving along `heading`: the first start angle (ANGLES, from `least` on)
 * a straight line from there clears what is near with, SPACE.margin to
 * spare, out to SPACE.share of the distance. fitDesign checks the real path
 * afterwards.
 */
function gentlestShape(bound, x, y, heading, h, clear, distance, least = OPEN.angle) {
  let need = -Infinity;
  const sx = Math.sin(heading), sy = Math.cos(heading), most = fullClearance(distance);
  for (const d of SPACE.steps) {
    if (d > SPACE.share * distance) break;
    const top = bound(x + d * sx, y + d * sy, corridorAt(distance, distance, d)) + Math.min(most, clear + HEIGHT.clearance.ends * d);
    need = Math.max(need, Math.atan2(top - h, d));
  }
  for (let a = least; a < ANGLES.length; a++) if (ANGLES[a] >= need + SPACE.margin) return shape(a, OPEN.lean);
  return shape(ANGLES.length - 1, OPEN.lean);
}

/*
 * A climb leaving at `slope` (radians): the first angle from index `least`
 * on at least that steep, leaving at the share of it that sets off at that
 * slope (route.js, Shape), found by halving; where the slope is the angle's
 * or steeper, the plain climb. A flight set off climbing (flight.js,
 * CONTINUE): its new way goes on up at the slope it climbed at.
 */
function climbLeaving(slope, least, leanIndex) {
  let a = least;
  while (a < ANGLES.length - 1 && ANGLES[a] < slope) a++;
  if (slope >= ANGLES[a] - 1e-9) return shape(a, leanIndex);
  let lo = 0, hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = 0.5 * (lo + hi);
    if (shape(a, leanIndex, mid).angleAt(0) < slope) lo = mid; else hi = mid;
  }
  return shape(a, leanIndex, 0.5 * (lo + hi));
}

/*
 * The way out of a start at (x, y), height h, facing `facing` (TAKEOFF):
 * { shape, heading }. Where nothing near reaches high enough to make any way
 * steeper than `least` (one look at the highest thing within reach), every
 * way is as gentle: the way you face.
 */
function gentlestWayOut(bound, x, y, facing, h, clear, distance, least) {
  const n = TAKEOFF.steps, step = (2 * Math.PI) / n;
  if (openAround(bound, x, y, h, clear, distance, least)) return { shape: gentlestShape(bound, x, y, facing, h, clear, distance, least), heading: facing };
  const shapes = new Array(n);
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    shapes[k] = gentlestShape(bound, x, y, facing + k * step, h, clear, distance, least);
    best = Math.min(best, shapes[k].angleIndex);
  }
  // The arcs of headings as gentle as the gentlest, as runs of steps round from the way you face.
  const gentle = (k) => shapes[((k % n) + n) % n].angleIndex === best;
  let first = 0;
  while (first < n && gentle(first)) first++;
  if (first === n) return { shape: shapes[0], heading: facing };   // all round: the way you face
  const edge = Math.round(TAKEOFF.edge / step);
  let pick = null, pickOff = Infinity;
  for (let k = first + 1; k <= first + n; k++) {
    if (!gentle(k) || gentle(k - 1)) continue;
    let length = 0;
    while (length < n && gentle(k + length)) length++;
    // In this arc (steps k .. k + length - 1): the step nearest the way you
    // face (step 0, or n), kept `edge` steps inside it, else its middle.
    const lo = k + Math.min(edge, (length - 1) / 2), hi = k + length - 1 - Math.min(edge, (length - 1) / 2);
    for (const facingAt of [0, n, 2 * n]) {
      const at = Math.round(Math.min(hi, Math.max(lo, facingAt)));
      const off = Math.abs(at - facingAt);
      if (off < pickOff) { pickOff = off; pick = at; }
    }
  }
  const k = ((pick % n) + n) % n;
  return { shape: shapes[k], heading: wrapAngle(facing + k * step) };
}

/* Whether nothing within gentlestShape's reach of (x, y) is high enough to
 * make a way out steeper than `least`: the highest thing within reach,
 * taken as standing at every distance looked at. */
function openAround(bound, x, y, h, clear, distance, least) {
  const most = fullClearance(distance), limit = ANGLES[least] - SPACE.margin;
  let reach = 0;
  for (const d of SPACE.steps) if (d <= SPACE.share * distance) reach = d;
  if (reach === 0) return true;
  const top = bound(x, y, reach + corridorAt(distance, distance, reach));
  for (const d of SPACE.steps) {
    if (d > reach) break;
    if (Math.atan2(top + Math.min(most, clear + HEIGHT.clearance.ends * d) - h, d) > limit) return false;
  }
  return true;
}

/*
 * An end in the air (PITCH): the steepest of its shapes, from OPEN's 60° down
 * to `gentlest` (what clears what is near), whose angle changes no faster
 * than PITCH.rate at the trip's pace, else the gentlest. Judged on the
 * straight way there (the design's σ: its climb, its descent, the cruise
 * over the distance, at the planned peak pace), so before it is designed:
 * an S's turns only make the bell longer, and the tilt slower.
 */
function airShape(p, distance, which, gentlest) {
  if (gentlest.angleIndex >= OPEN.angle) return gentlest;
  const off = PACE.offset, hu = p.cruise - p.g0 + off, hd = p.cruise - p.g1 + off;
  const cruise = distance / Math.max(1, p.cruise - Math.max(p.g0, p.g1) + off);
  for (let a = OPEN.angle; a >= gentlest.angleIndex; a--) {
    const s = shape(a, gentlest.leanIndex, gentlest.start);
    const up = which === 'up' ? s : p.up, down = which === 'down' ? s : p.down;
    const sigmaUp = hu > p.a0 ? Math.log(hu / p.a0) * up.perLog : 0, sigmaDown = hd > p.a1 ? Math.log(hd / p.a1) * down.perLog : 0;
    const total = sigmaUp + sigmaDown + cruise, T = Math.max((1.875 * total) / p.pace, DURATION.least);
    if (s.tiltRate(which === 'up' ? sigmaUp : sigmaDown, total, T) <= PITCH.rate) return s;
  }
  return gentlest;
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
 * @param from   { x, y, height, heading, pitch, moving, slope }: where the
 *               camera is and which way it faces; `moving`, set off at speed
 *               the way `heading` says, climbing at `slope` (a new place
 *               picked mid-flight: flight.js, CONTINUE): no look round for the
 *               way out, on up at that slope (LEAVE), and the view on the
 *               path from the start
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
  const toEnd = { ...to, height: arrive };
  const common = { from, to: toEnd, bound, distance, comfort, settings, endPitch, g0, g1 };
  if (glide === true || distance < GLIDE.distance) return hopPlan(common);
  if (glide == null && distance < ARC.distance) return arcPlan(common, { keepView: true });

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
  let lift = start.height, land = end.height;
  const steepest = ANGLES.length - 1;
  const ends = { start: start.clear, end: end.clear };
  // In the open, well above everything near: leave level and curve up
  // (route.js, the level Shape), unless what is ahead needs a steep start;
  // from the ground in the open, leave at a gentle angle and curve up into
  // the climb (CURVE.start; his answer on 5.9b: "rising in a curve"). Where
  // that does not keep clear, fitDesign makes it leave at its angle at once.
  // An end in the air may be gentler than 60° (PITCH).
  const airUp = !start.boxed && from.height - bound(from.x, from.y, AIR.radius) >= AIR.above;
  const airDown = !end.boxed && arrive - bound(to.x, to.y, AIR.radius) >= AIR.above;
  // Boxed in, it rises straight up first and leaves the way you face; set
  // off at speed (flight.js, CONTINUE), the way it is going; else the way
  // out is the gentlest all round (TAKEOFF).
  const out = start.boxed ? { shape: shape(steepest, OPEN.lean), heading: from.heading }
    : from.moving ? { shape: gentlestShape(bound, from.x, from.y, from.heading, lift, start.clear, distance, airUp ? 0 : OPEN.angle), heading: from.heading }
    : gentlestWayOut(bound, from.x, from.y, from.heading, lift, start.clear, distance, airUp ? 0 : OPEN.angle);
  let up = out.shape;
  if (airUp && up.angle < AIR.steepest) up = shape(up.angleIndex, up.leanIndex, 0);
  else if (!start.boxed && up.angleIndex === OPEN.angle) up = shape(up.angleIndex, up.leanIndex, CURVE.start);
  // Set off climbing (flight.js, CONTINUE): on up at the slope it climbs at,
  // as steep at least as what is near asks for.
  const climbing = !start.boxed && from.moving && (from.slope ?? 0) > LEAVE.least;
  if (climbing) up = climbLeaving(Math.min(ANGLES[steepest], from.slope), out.shape.angleIndex, out.shape.leanIndex);
  const p = { x0: from.x, y0: from.y, h0: out.heading, x1: to.x, y1: to.y, h1: to.heading, g0, g1,
    a0: Math.max(0, lift - g0) + off, a1: Math.max(0, land - g1) + off, cruise: Math.max(cruise, lift, land), pace: PACE.peak,
    up: up.angleIndex < OPEN.angle && !climbing ? shape(OPEN.angle, up.leanIndex, up.start) : up,
    down: end.boxed ? shape(steepest, OPEN.lean) : gentlestShape(bound, to.x, to.y, to.heading + Math.PI, land, end.clear, distance, airDown ? 0 : OPEN.angle) };
  const gentlestDown = p.down;
  if (p.down.angleIndex < OPEN.angle) p.down = shape(OPEN.angle, p.down.leanIndex);
  // The trip's pace (timing.js, allowedPeak): from the straight way there,
  // at 60° (so the pace is the same however gently an end in the air goes).
  const straight = new Design(p);
  p.pace = allowedPeak(straight.sigmaUp + straight.sigmaDown + distance / (p.cruise - Math.max(g0, g1) + off), distance);
  // The ends in the air as steep as the tilt allows (PITCH), each with the other's 60° for now.
  const upAir = airUp && !climbing && up.angleIndex < OPEN.angle ? airShape(p, distance, 'up', up) : p.up;
  const downAir = airDown && gentlestDown.angleIndex < OPEN.angle ? airShape(p, distance, 'down', gentlestDown) : p.down;
  p.up = upAir;
  p.down = downAir;

  let fit = fitDesign(p, bound, distance, ends), lifted = 0;
  // No S: straight up first (down last) a share of the way to the cruise,
  // the S between (LIFT). Never straight there (his words on 5.9b: "if not
  // close, always S shape").
  for (let i = 0; !fit && i < LIFT.shares.length; i++) {
    const share = lifted = LIFT.shares[i];
    lift = Math.max(start.height, from.height + share * (p.cruise - from.height));
    land = Math.max(end.height, arrive + share * (p.cruise - arrive));
    p.a0 = Math.max(0, lift - g0) + off;
    p.a1 = Math.max(0, land - g1) + off;
    p.up = shape(steepest, OPEN.lean);
    p.down = shape(steepest, OPEN.lean);
    fit = fitDesign(p, bound, distance, ends);
  }
  // Nothing at all (not one of the test flights): one arc straight there.
  if (!fit) return arcPlan(common);
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
    route: { word: design.word, turns: [design.turn1, design.turn2], length: L, up: p.up, down: p.down, lift: lifted, leaves: p.h0 },
  });
  // However fast it must turn to fit Longest flight, it stays an S (5.10b;
  // his words on 5.7b: "camera does not have a max turning speed").
  return plan;
}

/**
 * How far the flown path passes under what it should keep over (VERIFY):
 * the most metres short anywhere (0 if nowhere), and at how many points.
 */
export function verifyPlan(plan, bound) {
  const { m, x, y, h } = plan, n = Math.min(m, VERIFY.samples), step = (m - 1) / Math.max(1, n - 1);
  const ends = endsOver(bound, x[0], y[0], h[0], plan.endX, plan.endY, h[m - 1]);
  let worst = 0, points = 0;
  for (let i = 0; i < n; i++) {
    const k = Math.round(i * step), a = Math.round(Math.max(0, i - 1) * step), b = Math.round(Math.min(n - 1, i + 1) * step);
    const px = x[k], py = y[k];
    if (Math.hypot(px - ends.x0, py - ends.y0) < VERIFY.core || Math.hypot(px - ends.x1, py - ends.y1) < VERIFY.core) continue;
    const gap = Math.max(Math.hypot(x[a] - px, y[a] - py), Math.hypot(x[b] - px, y[b] - py));
    const low = Math.min(h[k], 0.5 * (h[k] + h[a]), 0.5 * (h[k] + h[b]));
    const short = bound(px, py, VERIFY.radius + 0.5 * gap) + keepNearEnds(ends, px, py, VERIFY.margin) - low;
    if (short > 0) { points++; if (short > worst) worst = short; }
  }
  return { worst, points };
}

/**
 * The ends of a way (x0, y0, h0 to x1, y1, h1, plane metres) as keepNearEnds
 * reads them: each with how far it is over what is near it (HEIGHT.corridor.min
 * round it; under it, less than 0).
 */
export function endsOver(bound, x0, y0, h0, x1, y1, h1, out = {}) {
  const near = HEIGHT.corridor.min;
  out.x0 = x0; out.y0 = y0; out.over0 = h0 - bound(x0, y0, near);
  out.x1 = x1; out.y1 = y1; out.over1 = h1 - bound(x1, y1, near);
  return out;
}

/**
 * How far over the bound a way keeps at (x, y) (metres, less than 0 where it
 * may be under it): `most`; near either end no more than the end is over
 * what is near it, plus HEIGHT.clearance.ends a metre away (as the plan
 * keeps: profile.js, clearanceAt); where an end is under the bound, as far
 * under it as the end, less by as much a metre away.
 */
export function keepNearEnds(ends, x, y, most) {
  const per = HEIGHT.clearance.ends;
  const d0 = Math.hypot(x - ends.x0, y - ends.y0), d1 = Math.hypot(x - ends.x1, y - ends.y1);
  const keep = Math.min(most, Math.max(0, ends.over0) + per * d0, Math.max(0, ends.over1) + per * d1);
  const under = Math.max(0, -ends.over0 - per * d0, -ends.over1 - per * d1);
  return keep - under;
}

/**
 * planFlight, its flown path checked (verifyPlan), and planned again round
 * what is there made wider and higher where it passes too near (VERIFY):
 * the clearest plan, with `verified` { worst, points, tries } on it (as
 * found on the plan kept; `first`, the worst on the first), or null.
 */
export function planVerified(args) {
  let plan = planFlight(args);
  if (!plan) return null;
  let check = verifyPlan(plan, args.bound), tries = 0;
  const first = check.worst;
  const ground = args.ground ?? args.bound;
  for (const g of VERIFY.grow) {
    if (!(check.worst > 0)) break;
    tries++;
    const again = planFlight({ ...args, ground, bound: (x, y, r) => args.bound(x, y, r + g) + g });
    if (!again) continue;
    const next = verifyPlan(again, args.bound);
    if (next.worst < check.worst) { plan = again; check = next; }
  }
  plan.verified = { worst: check.worst, points: check.points, tries, first };
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
 * Boxed in at an end, or where a parabola would leave steeper than SPACE's
 * steepest angle, it flies arcPlan's arc instead, rising (coming down)
 * straight at a boxed end, the view kept all the same (Stage 5.8b: 5.7b
 * rose straight up first, or fell back on a climb, a level stretch and a
 * descent).
 */
function hopPlan({ from, to, bound, distance, comfort, settings, endPitch, g0, g1 }) {
  const R = straightSamples(from, to, distance);
  const start = endSpace(bound, from.x, from.y, from.height), end = endSpace(bound, to.x, to.y, to.height);
  if (start.boxed || end.boxed) return arcPlan({ from, to, bound, distance, settings, endPitch, g0, g1 }, { keepView: true });
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
  // Too steep for one parabola: one arc all the same (Stage 5.8b: no more
  // climb, level and descent), the view kept.
  if (!arc) return arcPlan({ from, to, bound, distance, settings, endPitch, g0, g1 }, { keepView: true });
  const at = (s) => { const u = s / distance; return h0 + (h1 - h0) * u + 4 * K * u * (1 - u); };
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
    route: { word: 'arc', turns: [0, 0], length: distance },
  });
}

/* Even in t along an arc, closer near its ends, where it turns most. */
const arcT = (k, n) => (1 - Math.cos((Math.PI * k) / (n - 1))) / 2;

/*
 * One arc over the straight line between two points `D` metres apart, seen
 * from the side (x along the line, h up): a cubic Hermite curve from (0, h0)
 * leaving at angle a0 to (D, h1) arriving at a1 (the way it moves: negative
 * coming down). Each end's tangent is `size` times D over its cosine: the
 * curve runs evenly along x and is the graph of a cubic, a parabola where
 * tan a0 + tan a1 = 2 (h1 - h0) / D. At an end that is `held` (steepened to
 * clear something, or to turn the view round), the cosine is never taken
 * under cos ARC.steep, so steeper than that the end stands up into an arch
 * rising (coming down) straight, however high, rather than shooting up.
 * Its curvature is continuous all along. Returns (t, out) => out { x, h }.
 */
function hermiteArc(D, h0, h1, a0, a1, size, held0 = true, held1 = true) {
  const c = Math.cos(ARC.steep), free = Math.cos(89.5 * DEG);
  const l0 = (size * D) / Math.max(Math.cos(a0), held0 ? c : free), l1 = (size * D) / Math.max(Math.cos(a1), held1 ? c : free);
  const m0x = l0 * Math.cos(a0), m0h = l0 * Math.sin(a0), m1x = l1 * Math.cos(a1), m1h = l1 * Math.sin(a1);
  return (t, out) => {
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = 3 * t2 - 2 * t3, h11 = t3 - t2;
    out.x = D * h01 + m0x * h10 + m1x * h11;
    out.h = h0 * h00 + h1 * h01 + m0h * h10 + m1h * h11;
    return out;
  };
}

/*
 * A tall arch, for what only a climb much higher than the trip is long
 * clears (where the S cannot be designed either): straight up from (0, h0)
 * to `b`, over the top on a quintic Hermite curve leaving and arriving
 * straight up and down with no curvature there (so none jumps where it
 * meets the straight stretches), its top 0.625 D over `b` and about 0.6 D
 * round, and straight down to (D, h1). t runs along the three by length.
 */
function tallArch(D, h0, h1, b) {
  const lambda = 2 * D, up = Math.max(0, b - h0), down = Math.max(0, b - h1), over = 2.25 * D, total = up + over + down;
  const t1 = up / total, t2 = (up + over) / total;
  return (t, out) => {
    if (t <= t1) { out.x = 0; out.h = h0 + up * (t1 > 0 ? t / t1 : 1); return out; }
    if (t >= t2) { out.x = D; out.h = b - down * (t2 < 1 ? (t - t2) / (1 - t2) : 1); return out; }
    const u = (t - t1) / (t2 - t1), u3 = u * u * u;
    out.x = D * u3 * (10 - 15 * u + 6 * u * u);
    out.h = b + lambda * (u - 2 * u3 + u3 * u);
    return out;
  };
}

/*
 * The arc that keeps clear of what is along the way (`low`, at the samples
 * R): as asked (an end `held` or free: hermiteArc), or with both ends
 * steepened towards straight up (ARC.steps), then a tall arch (tallArch)
 * standing on straight stretches ARC.grow times longer each time from half
 * the distance, ARC.most times. { f, a0, a1, size (above 1: a tall arch),
 * clear }.
 */
function fitArc(D, h0, h1, a0, a1, R, low, held0, held1) {
  const N = ARC.points, X = new Float64Array(N), H = new Float64Array(N), at = { x: 0, h: 0 };
  const clears = (f) => {
    for (let k = 0; k < N; k++) { f(arcT(k, N), at); X[k] = at.x; H[k] = at.h; }
    for (let i = 1, k = 0; i < R.n - 1; i++) {
      const x = R.S[i];
      while (k < N - 2 && X[k + 1] < x) k++;
      const span = X[k + 1] - X[k];
      const h = span > 1e-9 ? H[k] + (H[k + 1] - H[k]) * Math.min(1, Math.max(0, (x - X[k]) / span)) : Math.max(H[k], H[k + 1]);
      if (h < low.lowest[i] - 0.05) return false;
    }
    return true;
  };
  let f = hermiteArc(D, h0, h1, a0, a1, 1, held0, held1);
  if (clears(f)) return { f, a0, a1, size: 1, clear: true };
  for (let j = 1; j <= ARC.steps; j++) {
    const e = j / ARC.steps, b0 = a0 + (Math.PI / 2 - a0) * e, b1 = a1 - (Math.PI / 2 + a1) * e;
    f = hermiteArc(D, h0, h1, b0, b1, 1);
    if (clears(f)) return { f, a0: b0, a1: b1, size: 1, clear: true };
  }
  let size = 1;
  for (let j = 0, lift = 0.5 * D; j < ARC.most; j++, lift *= ARC.grow) {
    size = 2 + j;
    f = tallArch(D, h0, h1, Math.max(h0, h1) + lift);
    if (clears(f)) return { f, a0: Math.PI / 2, a1: -Math.PI / 2, size, clear: true };
  }
  return { f, a0: Math.PI / 2, a1: -Math.PI / 2, size, clear: false };
}

/*
 * A short trip (ARC): one arc straight to the place. It arrives at ARC.angle
 * where it can, and leaves as a parabola through both ends would: steeper to
 * a place above, gentler to one below, level where the place is far below
 * (it drops onto it, arriving steeper). Boxed in at an end, that end is
 * straight up (or down). With `keepView` (every trip under ARC.distance, and
 * a hop too steep for its parabola), the view is kept and turned evenly onto
 * the end's (a 'hop'); without (the last resort for a longer trip), the
 * camera is on the path, leaving steeper, up to straight up, where the view
 * has to turn round to face the place, and ends facing the way it went.
 * Where only a climb much higher than the trip is long clears what is in
 * the way, it rises straight up, over a round top and straight down
 * (tallArch): an S there flew a 200 m loop for 33 m.
 */
function arcPlan({ from, to, bound, distance, settings, endPitch, g0, g1 }, { keepView = false } = {}) {
  const D = distance, R = straightSamples(from, to, D);
  const start = endSpace(bound, from.x, from.y, from.height), end = endSpace(bound, to.x, to.y, to.height);
  const low = lowestAllowed(R, bound, D, { start: start.clear, end: end.clear });
  const travel = Math.atan2(to.x - from.x, to.y - from.y), h0 = from.height, h1 = to.height;
  // The parabola arriving at ARC.angle leaves at tan a0 = tan ARC.angle +
  // 2 (h1 - h0) / D; where that would point down, it leaves level instead
  // and arrives at tan a1 = 2 (h1 - h0) / D.
  let s0 = Math.tan(ARC.angle) + (2 * (h1 - h0)) / D, s1 = -Math.tan(ARC.angle);
  if (s0 < 0) { s1 = (2 * (h1 - h0)) / D; s0 = 0; }
  let a0 = Math.atan(s0), a1 = Math.atan(s1), held0 = false, held1 = false;
  if (!keepView) {
    const turn = Math.abs(wrapAngle(travel - from.heading));
    const round = smoothstep(Math.max(0, Math.min(1, (turn - ARC.turn[0]) / (ARC.turn[1] - ARC.turn[0]))));
    if (round > 0) { a0 += (Math.PI / 2 - a0) * round; held0 = true; }
  }
  if (start.boxed) { a0 = Math.PI / 2; held0 = true; }
  if (end.boxed) { a1 = -Math.PI / 2; held1 = true; }
  const fit = fitArc(D, h0, h1, a0, a1, R, low, held0, held1);
  const pts = new PointList(ARC.points), at = { x: 0, h: 0 }, ux = (to.x - from.x) / D, uy = (to.y - from.y) / D;
  let top = -Infinity, last = 0;
  for (let k = 0; k < ARC.points; k++) {
    fit.f(arcT(k, ARC.points), at);
    const x = Math.min(D, Math.max(last, at.x));
    last = x;
    pts.push(x, from.x + ux * x, from.y + uy * x, at.h, travel, 0, 2);
    top = Math.max(top, at.h);
  }
  pts.h[0] = from.height;
  pts.h[pts.n - 1] = to.height;
  // The pace: the arc's own σ, against the line from the ground at the start
  // to the ground at the end (as FlightPlan measures it), so the trip takes
  // as long as paceCap allows for its distance, or its σ at PACE.peak if less.
  const off = PACE.offset;
  let sigma = 0;
  for (let i = 1; i < pts.n; i++) {
    const r0 = g0 + ((g1 - g0) * pts.s[i - 1]) / D, r1 = g0 + ((g1 - g0) * pts.s[i]) / D;
    sigma += segmentSigma(pts.s[i] - pts.s[i - 1], pts.h[i] - pts.h[i - 1], Math.max(0, pts.h[i - 1] - r0) + off, Math.max(0, pts.h[i] - r1) + off);
  }
  return new FlightPlan({
    from, to: keepView ? to : { ...to, heading: travel }, distance: D, points: pts, settings, endPitch, kind: keepView ? 'hop' : 'arc',
    g0, g1, pace: allowedPeak(sigma, D), cruise: top, lift: h0, land: h1, design: null, samples: R, lowest: low.lowest,
    route: { word: 'arc', turns: [0, 0], length: D, angles: [fit.a0, fit.a1], size: fit.size, clear: fit.clear },
  });
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

/* How much a route's points turn in all, radians: round the vertical (their
 * headings) and up and down (the slope between them), summed along it. */
function turning(P) {
  let sum = 0, last = null;
  for (let i = 1; i < P.n; i++) {
    sum += Math.abs(P.heading[i] - P.heading[i - 1]);
    const ds = P.s[i] - P.s[i - 1], dh = P.h[i] - P.h[i - 1];
    if (Math.abs(ds) + Math.abs(dh) < 1e-9) continue;
    const slope = Math.atan2(dh, ds);
    if (last !== null) sum += Math.abs(slope - last);
    last = slope;
  }
  return sum;
}

/**
 * A flight: its path sampled evenly in σ (positions, heights, headings,
 * slopes, curvature), the bell's length, and `at(t)` to read it at any time.
 * Kinds: 'curve' (the S), 'arc' (one arc straight there, the camera on it),
 * 'hop' (one arc, the view kept). Pieces: -1 straight up, 0 climbing before
 * the first curve, 1 and 3 the curves, 4 after the second, 5 straight down
 * (an arc or a hop is all 2 between).
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
    this.moving = Boolean(from.moving);   // set off at speed: the view on the path from the start
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
    this.#steady();
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
    const m = Math.round(Math.min(FLIGHT.maxFlight, Math.max(FLIGHT.minFlight, sigma * FLIGHT.perSigma, turning(P) / FLIGHT.turn)));
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
    let length = 0;
    for (let k = 0; k < m - 1; k++) length += perSigma[k] * step;
    Object.assign(this, {
      m, x, y, h, heading, curvature, ground, along, piece, sigma, sigmaStep: step,
      perSigma, flatPerSigma, turnPerSigma, turnChange, length, slope, lean,
    });
  }

  /* The bell's length: the pace, the curves (timing.js), at least
   * `atLeast` (#steady), the settings. */
  #time(atLeast = 0) {
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
    if (this.kind === 'arc') {
      // Time for the view to come onto the arc (#views): ARC.least, up to
      // VIEW.least where it turns round all the way, within 0.45 of it.
      const turn = Math.abs(wrapAngle(this.travel - this.startHeading)) / Math.PI;
      natural = Math.max(natural, (ARC.least + (VIEW.least - ARC.least) * turn) / 0.45);
    }
    if (this.kind === 'curve') {
      const { rate, accel } = turns(natural);
      natural = Math.max(natural, (natural * rate) / (TURN.rate * 1.02), natural * Math.sqrt(accel / TURN.accel));
    }
    natural = Math.max(natural, atLeast);
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
  }

  /*
   * How the view comes onto the path and back (see the top of the file):
   * `viewIn` and `viewOut`, the seconds at the start and the end over which
   * it turns, while the flight rises its first VIEW.height metres (or half
   * its climb) and comes down its last, VIEW.least of natural time at least,
   * at most 0.45 of the flight each.
   */
  #views() {
    const T = this.duration, c = this.compress, { m, h, time } = this;
    this.viewIn = this.viewOut = this.tiltFirst = 0;
    if (this.kind === 'hop' || !(T > 0)) return;
    if (this.kind === 'arc') {
      // On the path once the arc has risen ARC.viewRise of its way up, off
      // it from where it has as far left to come down, ARC.least at least;
      // where the view turns round to face the place, it tilts up first
      // (VIEW.tilt of the way in, where it turns round all the way).
      const turn = Math.abs(wrapAngle(this.travel - this.startHeading));
      const top = this.profile.cruise, least = Math.min(0.45 * T, ARC.least / c);
      const leastIn = Math.min(0.45 * T, (ARC.least + (VIEW.least - ARC.least) * (turn / Math.PI)) / c);
      let a = 0, b = m - 1;
      while (a < m - 1 && h[a] - h[0] < ARC.viewRise * Math.max(0, top - h[0])) a++;
      while (b > 0 && h[b] - h[m - 1] < ARC.viewRise * Math.max(0, top - h[m - 1])) b--;
      this.viewIn = this.moving ? 0 : Math.min(0.45 * T, Math.max(leastIn, time[a]));
      this.viewOut = Math.min(0.45 * T, Math.max(least, T - time[b]));
      this.tiltFirst = this.moving ? 0 : VIEW.tilt * smoothstep(Math.max(0, Math.min(1, (turn - ARC.turn[0]) / (ARC.turn[1] - ARC.turn[0]))));
      return;
    }
    const least = Math.min(0.45 * T, VIEW.least / c), top = this.profile.cruise;
    const riseIn = Math.min(VIEW.height, 0.5 * Math.max(0, top - h[0]));
    const riseOut = Math.min(VIEW.height, 0.5 * Math.max(0, top - h[m - 1]));
    let a = 0, b = m - 1;
    while (a < m - 1 && h[a] - h[0] < riseIn) a++;
    while (b > 0 && h[b] - h[m - 1] < riseOut) b--;
    this.viewIn = this.moving ? 0 : Math.min(0.45 * T, Math.max(least, time[a]));
    this.viewOut = Math.min(0.45 * T, Math.max(least, T - time[b]));
  }

  /*
   * How fast the view tilts (PITCH): the fastest it does at the natural pace
   * (`tiltRate`, radians a second), sampled as it looks; where that is over
   * PITCH.rate, the bell is made longer, by `longer`, PITCH.longer at most
   * (a flight Longest flight already holds to its length is played faster
   * for it, so as played it tilts as fast as before).
   */
  #steady() {
    this.longer = 1;
    this.tiltRate = this.#tilt();
    if (this.kind === 'hop' || !(this.duration > 0)) return;
    // Aimed a little under the limit: between its samples it tilts a little faster.
    const first = this.natural, aim = 0.97 * PITCH.rate;
    for (let pass = 0; pass < 4 && this.tiltRate > aim * 1.01; pass++) {
      const next = Math.min(first * PITCH.longer, (this.natural * this.tiltRate) / aim);
      if (!(next > this.natural * 1.001)) break;
      this.#time(next);
      this.#views();
      this.longer = this.natural / first;
      this.tiltRate = this.#tilt();
    }
  }

  /* The fastest the view tilts at the natural pace, radians a second. An S
   * exactly, at its samples: the slope's rate along σ times σ's rate in the
   * bell, through the turns from your tilt onto the path and back (see at);
   * anything else measured over TILT_SAMPLES even instants. */
  #tilt() {
    const T = this.duration, c = this.compress;
    if (!(T > 0)) return 0;
    if (this.kind !== 'curve') {
      const pose = this.tiltPose ??= {};
      let last = 0, most = 0;
      for (let i = 0; i <= TILT_SAMPLES; i++) {
        this.at((T * i) / TILT_SAMPLES, pose);
        if (i > 0) most = Math.max(most, Math.abs(pose.pitch - last));
        last = pose.pitch;
      }
      return (most * TILT_SAMPLES) / (T * c);
    }
    const { m, slope, time, sigma, sigmaStep } = this, tin = this.viewIn, tout = this.viewOut;
    const s0 = this.startPitch, s1 = this.endPitch;
    let most = 0;
    for (let k = 1; k < m - 1; k++) {
      const t = time[k], u = t / T;
      const at = Math.max(-VIEW.most, Math.min(VIEW.most, slope[k]));
      const clamped = Math.abs(slope[k]) >= VIEW.most;
      let p = at, rate = clamped ? 0 : ((slope[k + 1] - slope[k - 1]) / (2 * sigmaStep)) * (sigma / T) * bellRate(u);
      if (tin > 0 && t < tin) {
        const x = t / tin, w = smootherstep(x);
        rate = rate * w + (p - s0) * (30 * x * x * (1 - x) * (1 - x)) / tin;
        p = s0 + (p - s0) * w;
      }
      if (tout > 0 && t > T - tout) {
        const x = (T - t) / tout, w = smootherstep(x);
        rate = rate * w - (p - s1) * (30 * x * x * (1 - x) * (1 - x)) / tout;
      }
      most = Math.max(most, Math.abs(rate));
    }
    return most / c;
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
    if (this.kind === 'arc') {
      // Along the arc: its heading is the way to the place, its slope the
      // view's. Turned from your view onto it on the way up (tilting first
      // where it turns round), and back onto your tilt on the way down,
      // still facing the way it goes (the end's heading).
      const tin = this.viewIn, tout = this.viewOut, travel = this.travel, f = this.tiltFirst;
      let yaw = travel, pitch = slope, wIn = 1, wOut = 1;
      if (tin > 0 && tc < tin) {
        wIn = smootherstep(tc / tin);
        const wYaw = f > 0 ? smootherstep(Math.max(0, (tc / tin - f) / (1 - f))) : wIn;
        pitch = s0 + (slope - s0) * wIn;
        yaw = h0 + wrapAngle(travel - h0) * wYaw;
      }
      if (tout > 0 && tc > T - tout) {
        wOut = smootherstep((T - tc) / tout);
        pitch = s1 + (pitch - s1) * wOut;
      }
      out.yaw = u <= 0 ? h0 : u >= 1 ? h1 : yaw;
      out.pitch = u <= 0 ? s0 : u >= 1 ? s1 : pitch;
      out.onPath = Math.min(wIn, wOut);
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
