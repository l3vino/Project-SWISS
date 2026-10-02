/* flyto.js — a flight to a place, for search results, flown like an aircraft.
 *
 * Take-off. The camera sets off the way it faces, from rest, gathering speed
 * over the first second or two, and climbs: nose up while it climbs, and
 * from low down (below 50 m, where the houses are) steeply at first, then
 * more gently up to its cruising height, a share of the route's length
 * above the ground.
 *
 * The route is the shortest one that starts straight ahead along the start
 * heading and ends on a final straight along that same heading, turning no
 * tighter than a radius in between (a Dubins path, Dubins 1957): a take-off
 * run, a turn, a straight, a turn, and the final approach. So the camera
 * always leaves going forward and arrives facing the way it faced, and the
 * place, at the end of the final straight, is straight ahead on the way in.
 * A place within 2° of straight ahead is flown to along the line, the view
 * kept on the start heading, rather than through a swaying S-bend.
 * The route is worked out in a flat map of the earth centred on the place
 * (flight-path.js) and mapped back, so it works for any distance.
 *
 * The view looks where it flies, like a pilot's: the heading follows the
 * route, smoothed in time (it eases into and out of every turn rather than
 * snapping to the circle), the nose follows the climb or descent at 60% of
 * its angle around the start tilt, and the picture banks into the turns in
 * proportion to how fast it turns (up to 28°). Speed follows the height above
 * the ground, as in every map flight since van Wijk and Nuij's ("Smooth and
 * efficient zooming and panning", 2003), slowing in turns that would
 * otherwise turn the view faster than 30° a second; time runs through a
 * smooth start and stop, and the flight takes 5 to 16 seconds by distance,
 * longer when it has much turning to do. The last second blends the view
 * exactly onto the start angles, level.
 *
 * The height ends where it started relative to the ground, unless landing.
 * A walker lands, on the ground, standing; so does any flight ending below
 * 50 m, at its height. From take-off on, everything within 100 m of the
 * place is loaded in full detail (render.js moves the view's focus there),
 * and once its ground is known exactly and its buildings are in, the nearest
 * spot outside every building is found and the end of the route shifted to
 * it, over the rest of the cruise. Until then the approach holds 50 m above
 * the ground. The last 40 m before the spot are checked for buildings, and
 * the approach stays above any it would pass through until it is past them,
 * then comes straight down. If the place is reached before all that is
 * known, the flight hovers there until it is (12 s at most), glides across
 * to the spot and comes down onto it.
 *
 * The ground at the place is rarely known for sure at take-off (its tiles
 * are asked for then), so the estimate is refined as they land and glided
 * onto, and the flight stays clear of what is known of the ground under it.
 * An instant trip is the same with no travel. Moving the mouse on the way
 * turns your head, not the flight: the view follows the mouse and eases back
 * once it stops. A movement key hands control back where it is (the bank
 * then levels out by itself).
 */

import { DEG, radiiAt } from '../../core/math.js';
import { Plane, Route, Profile, Ease, smootherstep, smootherstepSlope, SMOOTHER_PEAK } from './flight-path.js';

/* How good an estimate of the ground at the destination is. An accurate
 * sample beats the place's own elevation (from the search service), which
 * beats the top of a fine tile, ranked by its level. */
export const GROUND_EXACT = 100;
export const GROUND_ELEVATION = 50;

/* Below this height above the ground, buildings are in the way (see the top
 * of this file). */
export const SAFE_HEIGHT = 50;
/* Metres around the place loaded in full detail during a landing flight. */
export const LANDING_FOCUS = 100;
/* Metres of the approach before the spot checked for buildings, how far
 * either side of the path, and how far above them it stays. */
export const APPROACH_LENGTH = 40;
export const APPROACH_HALF_WIDTH = 0.8;
const APPROACH_MARGIN = 3;

/* Closer than this, a short glide straight there, keeping the view. */
const DIRECT = 20;
const DIRECT_SECONDS = 2;
/* A place this close to straight ahead, with the start heading this close to
 * the line to it at both ends, is flown along that line with the view kept
 * on the start heading: off the direction of travel by this much at most,
 * which cannot be seen, where a correcting S-bend would sway the view. */
const STRAIGHT_AHEAD = 2 * DEG;
/* The route's straight parts as shares of the distance, within bounds,
 * metres; the turns' radii as wide as turning at MAX_TURN_RATE needs at the
 * natural speed for their height (TURN_SCREEN_SPEED), within these bounds. */
const TAKEOFF = { share: 0.06, min: 40, max: 1500 };
const FINAL = { share: 0.12, min: 60, max: 3000 };
const TURN_RADIUS = { share: 0.02, min: 40, max: 500 };
const RADIUS_CAP = 0.3;
const TURN_SCREEN_SPEED = 0.8;
/* Cruising height above the ground, climbs and descents no steeper than
 * these slopes (the steep ones below SAFE_HEIGHT), and the share of the
 * route they may take up between them. */
const CRUISE = { share: 0.3, min: 40, max: 300000 };
const CLIMB = Math.tan(35 * DEG);
const STEEP_CLIMB = Math.tan(55 * DEG);
const STEEP_DESCENT = Math.tan(60 * DEG);
const ROOM = 0.95;
/* Speed is in proportion to the height above the ground plus this, at most
 * this many times it a second; in the turns, slow enough for the view to
 * turn no faster than MAX_TURN_RATE. Changes of speed are spread over about
 * SPEED_SMOOTHING seconds. A flight takes a time growing with its length,
 * and longer if those limits need it, within bounds. */
const SPEED_OFFSET = 40;
const MAX_SCREEN_SPEED = 2;
/* A flight that would need longer than DURATION.max goes faster on its
 * straight parts, never in its turns: at most this many times faster. */
const MAX_STRETCH = 20;
const MAX_TURN_RATE = 50 * DEG;
const SPEED_SMOOTHING = 0.35;
const DURATION = { base: 4, perDecade: 3, reference: 150, min: 5, max: 20 };
/* Speed builds up over the first 18% of the time and dies down over the last 22%. */
const EASE = new Ease(0.18, 0.22);
/* The view: the share of the climb angle the nose follows, its limits, the
 * bank, smoothing (seconds), and the blends from and onto the start angles. */
const PITCH_FOLLOW = 0.6;
const PITCH_MIN = -80 * DEG;
const PITCH_MAX = 75 * DEG;
const MAX_BANK = 28 * DEG;
const BANK_RATE = 20 * DEG;        // turning this fast banks tanh(1) = 76% of the way
const SMOOTH = { yaw: 0.35, pitch: 0.3, roll: 0.2 };
const START_BLEND = 0.6;
const END_BLEND = { seconds: 1, share: 0.15 };
const TABLE_RATE = 60;             // view samples per second of flight
const ROUTE_SAMPLES = { min: 2048, max: 65536, perRadius: 4 };
/* Coming down: a critically damped spring on how far the flight is held
 * above its planned path (natural frequency, 1/s), changing at most this
 * many metres a second faster or slower than the hold itself asks, and
 * when it counts as down. */
const HOLD_STIFFNESS = 3;
const HOLD_MAX_RATE = 15;
const TOUCH = { height: 0.03, rate: 0.2 };
/* Near the ground, the height is kept over the ground right under the
 * camera rather than over the blend between the two ends: fully below the
 * first height, not at all above the second; changes eased this fast (s). */
const LOCAL_GROUND = { low: 5, high: 30 };
const LOCAL_EASE = 0.1;
/* Seconds hovering over the place for its ground and buildings, at most. */
const HOVER_PATIENCE = 12;
/* Gliding sideways to the landing spot: metres a second, within these times. */
const SHIFT_RATE = 15;
const SHIFT_SECONDS = { min: 0.6, max: 2.5 };
/* The destination's ground is refined from this share of the flight on. */
const REFINE_FROM = 0.5;
/* Seconds: gliding onto a refined ground estimate; rising for, and settling
 * back from, the clearance over the ground passed. */
const GROUND_EASE = 0.25;
const LIFT_UP = 0.2;
const LIFT_DOWN = 0.6;
/* Metres kept between the flight and the ground it passes over (less near
 * the end of a landing). */
const CLEARANCE = 20;
/* After arriving, better ground still on its way is waited for this long at most. */
const SETTLE_SECONDS = 5;
const SUBSTEP = 1 / 120;
/* Looking around on the way: the head turn holds this long after the mouse
 * stops, then eases back at this pace (seconds to about a third), and never
 * tilts the view past the vertical. */
const LOOK_HOLD = 0.8;
const LOOK_RETURN = 0.6;
const LOOK_PITCH = 85 * DEG;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function bearing(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
}

/* Catmull-Rom through evenly spaced samples, at fractional index u. */
function sample(a, u) {
  const n = a.length;
  if (n === 1) return a[0];
  const i = clamp(Math.floor(u), 0, n - 2), f = clamp(u - i, 0, 1);
  const p0 = a[Math.max(i - 1, 0)], p1 = a[i], p2 = a[i + 1], p3 = a[Math.min(i + 2, n - 1)];
  return p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
}

/* Gaussian blur in place, sigma in samples, the ends held. */
function blur(a, sigma) {
  if (!(sigma >= 0.5)) return;
  const n = a.length, r = Math.ceil(3 * sigma), w = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let k = -r; k <= r; k++) sum += (w[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma)));
  const src = Float64Array.from(a);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = -r; k <= r; k++) v += w[k + r] * src[clamp(i + k, 0, n - 1)];
    a[i] = v / sum;
  }
}

/* The largest value within ±r samples of each, in O(n). */
function dilate(a, r) {
  const n = a.length;
  if (r < 1) return;
  const src = Float64Array.from(a), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0, j = 0; i < n; i++) {
    for (; j < n && j <= i + r; j++) {
      while (tail > head && src[q[tail - 1]] <= src[j]) tail--;
      q[tail++] = j;
    }
    while (q[head] < i - r) head++;
    a[i] = src[q[head]];
  }
}

/* Linear interpolation in a table sampled at increasing `xs`. */
function lookup(xs, ys, x) {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const f = (x - xs[lo]) / Math.max(1e-300, xs[hi] - xs[lo]);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

export class FlyTo {
  constructor() {
    this.active = false;
    this.arrived = false;       // reached the place, maybe still settling or landing
    this.landed = false;        // came down onto its spot (a walker walks from there)
    this.phase = 'idle';        // flight, settle, hover, shift, land
    this.progress = 0;          // 0 to 1 along the route
    this.t = 0;                 // seconds into the flight
    this.duration = 0;
    this.heading = 0;           // direction of travel, radians from north
    this.lastStretch = false;   // on the final straight, along the start heading
    this.turns = false;         // flown as a route with turns, not a glide
    this.landing = false;
    this.confirmed = false;     // a landing's spot is known
    this.label = '';
    this.from = { lon: 0, lat: 0 };
    this.to = { lon: 0, lat: 0 };
    this.spot = { lon: 0, lat: 0, ground: 0 };
    this.shiftFrom = { lon: 0, lat: 0 };
    this.last = { lon: 0, lat: 0 };
    this.geo = { lon: 0, lat: 0 };
    this.next = { lon: 0, lat: 0 };
    this.seg = { x: 0, y: 0, heading: 0, curvature: 0 };
    this.alt = { height: 0, slope: 0 };
    this.estimate = { height: 0, rank: -1 };
    this.pose = { lon: 0, lat: 0, height: 0, yaw: 0, pitch: 0, roll: 0 };
    // Building tops along the last metres of the approach, above the spot's
    // ground, and the height to keep from each distance in.
    this.tops = new Float32Array(APPROACH_LENGTH + 1);
    this.clearance = new Float32Array(APPROACH_LENGTH + 1);
    this.radii = { meridian: 0, primeVertical: 0 };
    this.route = null;
    this.plane = null;
    this.profile = null;
    this.tau = null;
  }

  /**
   * @param camera       where it starts
   * @param target       { lon, lat, label, covered, ground, rank, arrive, walk }:
   *                     the best ground height known at the destination and
   *                     how good it is (GROUND_EXACT, GROUND_ELEVATION, a tile
   *                     level, or below), whether any terrain covers it, the
   *                     height above the ground to end at, and whether to land
   *                     there walking
   * @param startGround  ground height under the camera now
   * @param options      instant: be there at once
   */
  start(camera, target, startGround, { instant = false } = {}) {
    this.from.lon = camera.lon; this.from.lat = camera.lat;
    this.to.lon = target.lon; this.to.lat = target.lat;
    // The path starts exactly where the camera is, even if the ground under
    // it is only estimated, and from above it.
    this.ground0 = Math.min(startGround, camera.height);
    this.ground1 = this.groundTarget = target.ground;
    this.rank = target.rank;
    this.covered = target.covered !== false;
    this.walk = Boolean(target.walk) && this.covered;
    this.h0 = camera.height - this.ground0;
    this.h1 = Math.max(0, target.arrive);
    this.instant = Boolean(instant);
    this.landing = this.covered && this.h1 < SAFE_HEIGHT;
    this.yaw0 = camera.yaw;
    this.pitch0 = camera.pitch;
    this.roll0 = camera.roll || 0;
    this.spot.lon = target.lon; this.spot.lat = target.lat; this.spot.ground = target.ground;
    this.confirmed = false;
    this.guessed = false;
    this.lateShift = false;
    this.offsetFrom = this.offsetTo = Infinity;
    this.tops.fill(-Infinity);
    this.clearance.fill(0);
    this.obstacle = 0;
    this.lift = 0;
    // Held above the planned path by this much (an instant trip is at the
    // place at once, held over it until its spot is known).
    this.excess = this.instant && this.landing ? SAFE_HEIGHT - this.h1 : 0;
    this.excessRate = 0;
    this.lastWant = this.excess;
    this.lastPlanned = this.instant ? this.h1 : this.h0;
    this.local = 0;
    this.settle = 0;
    this.hoverTime = 0;
    this.t = 0;
    this.progress = 0;
    this.heading = camera.yaw;
    this.last.lon = camera.lon; this.last.lat = camera.lat;
    this.label = target.label || '';
    this.arrived = false;
    this.landed = false;
    this.cancelled = null;
    this.lastStretch = false;
    this.lookYaw = this.lookPitch = 0;
    this.lookIdle = Infinity;
    this.active = true;
    this.#plan();
    this.#enter('flight');
  }

  /** The mouse moved during the flight: turn the head by these angles. */
  look(dYaw, dPitch) {
    if (!this.active) return;
    this.lookYaw = wrap(this.lookYaw + dYaw);
    this.lookPitch += dPitch;
    this.lookIdle = 0;
  }

  /* Adds the head turn to the view, holding it while the mouse moves and
   * easing it back after. */
  #head(pose, dt) {
    if (this.lookYaw === 0 && this.lookPitch === 0) return;
    this.lookIdle += dt;
    if (this.lookIdle > LOOK_HOLD) {
      const k = Math.exp(-dt / LOOK_RETURN);
      this.lookYaw *= k;
      this.lookPitch *= k;
      if (Math.abs(this.lookYaw) + Math.abs(this.lookPitch) < 1e-4) this.lookYaw = this.lookPitch = 0;
    }
    pose.yaw = wrap(pose.yaw + this.lookYaw);
    pose.pitch = clamp(pose.pitch + this.lookPitch, -LOOK_PITCH, LOOK_PITCH);
  }

  /** Hands control back where the flight is; `reason` is kept for the probe. */
  cancel(reason = 'cancelled') {
    if (this.active) this.cancelled = reason;
    this.active = false;
  }

  /* ---- planning --------------------------------------------------------- */

  #plan() {
    const plane = this.plane = new Plane(this.to.lon, this.to.lat);
    const S = plane.forward(this.from.lon, this.from.lat, { x: 0, y: 0 });
    const d = this.distance = Math.hypot(S.x, S.y);
    this.turns = !this.instant && d >= DIRECT;
    this.straight = false;
    this.tau = null;
    if (!this.turns) {
      this.route = new Route(S.x, S.y, 0, 0, 0, 0);
      this.length = this.route.length;
      this.#shape();
      this.duration = this.instant || this.length <= 0 ? 0 : DIRECT_SECONDS;
      return;
    }
    // The start heading in the plane: where a metre along it lands. At the
    // centre of the plane, north is north.
    const { meridian, primeVertical } = radiiAt(this.from.lat, this.radii);
    const lat = this.from.lat + Math.cos(this.yaw0) / meridian / DEG;
    const lon = this.from.lon + Math.sin(this.yaw0) / (primeVertical * Math.cos(this.from.lat * DEG)) / DEG;
    const A = plane.forward(lon, lat, { x: 0, y: 0 });
    let h0 = Math.atan2(A.y - S.y, A.x - S.x), h1 = Math.PI / 2 - this.yaw0;
    const ahead = Math.atan2(-S.y, -S.x);
    this.straight = Math.abs(wrap(ahead - h0)) < STRAIGHT_AHEAD && Math.abs(wrap(ahead - h1)) < STRAIGHT_AHEAD;
    if (this.straight) h0 = h1 = ahead;
    const takeoff = clamp(TAKEOFF.share * d, TAKEOFF.min, TAKEOFF.max);
    const final = clamp(FINAL.share * d, FINAL.min, FINAL.max);
    const least = clamp(TURN_RADIUS.share * d, TURN_RADIUS.min, TURN_RADIUS.max);
    const most = Math.max(least, RADIUS_CAP * d);
    // Each turn as wide as its height asks (see #shape: turns are flown at
    // the heights of the ends, at least SAFE_HEIGHT).
    const radius = (h) => clamp((TURN_SCREEN_SPEED * (Math.max(h, SAFE_HEIGHT) + SPEED_OFFSET)) / MAX_TURN_RATE, least, most);
    this.route = new Route(S.x, S.y, h0, 0, 0, h1, {
      takeoff, final, radius: radius(this.h0), radius2: radius(this.landing ? SAFE_HEIGHT : this.h1),
    });
    this.length = this.route.length;
    this.#shape();
    this.#pace();
    this.#views();
  }

  /*
   * Pace along the route, seconds per metre at the fastest allowed. Two
   * limits: the ground streaming past at MAX_SCREEN_SPEED (speed in
   * proportion to the height above it plus SPEED_OFFSET, along the slope,
   * as in van Wijk and Nuij), smooth by construction; and in the turns no
   * faster than MAX_TURN_RATE allows, which starts and stops at their edges.
   * The turn limit is eased in time: as a function of when each point is
   * reached, widened by two smoothing times either way and blurred, so the
   * speed comes down before a turn and back up after it; relaxed where the
   * flight's own start and stop make it slower anyway; and joined to the
   * other limit by a smooth maximum. Its running sum, `tau`, maps progress
   * to distance. The duration is what the limits need (the ease's top speed
   * is EASE.peak times its average) or what the route's length suggests,
   * whichever is longer, settled over a few rounds as the times shift. A
   * flight that would need longer than DURATION.max raises the first limit
   * (the straights go faster, by up to MAX_STRETCH) until it fits.
   */
  #pace() {
    const L = this.length, r = Math.min(this.route.radius, this.route.radius2);
    const N = clamp(Math.ceil((L * ROUTE_SAMPLES.perRadius) / r), ROUTE_SAMPLES.min, ROUTE_SAMPLES.max);
    const ds = L / (N - 1);
    if (!this.paceTable || this.paceTable.length !== N) {
      this.paceTable = new Float64Array(N);
      this.tauTable = new Float64Array(N);
      this.times = new Float64Array(N);
      this.screen = new Float64Array(N);
      this.turning = new Float64Array(N);
      this.eased = new Float64Array(N);
    }
    // Kept from flight to flight; `tau` is null for a flight without a route.
    this.tau = this.tauTable;
    const pace = this.paceTable, screen = this.screen, turning = this.turning, times = this.times;
    const eased = this.eased;
    const alt = this.alt, seg = this.seg, dg = this.ground1 - this.ground0;
    for (let i = 0; i < N; i++) {
      const s = i * ds;
      this.profile.at(s, alt);
      this.route.at(s, seg);
      const slope = alt.slope + (dg * smootherstepSlope(s / L)) / L;
      screen[i] = Math.sqrt(1 + slope * slope) / ((Math.max(0, alt.height) + SPEED_OFFSET) * MAX_SCREEN_SPEED);
      turning[i] = Math.abs(seg.curvature) / MAX_TURN_RATE;
      pace[i] = Math.max(screen[i], turning[i]);
    }
    this.ds = ds;
    this.#sum();
    const suggested = DURATION.base + DURATION.perDecade * Math.log10(1 + L / DURATION.reference);
    const duration = () => clamp(Math.max(suggested, EASE.peak * this.tau[N - 1]), DURATION.min, DURATION.max);
    for (let round = 0; round < 3; round++) {
      const T = duration(), M = Math.max(2, Math.ceil(T * TABLE_RATE) + 1), step = T / (M - 1);
      const grid = new Float64Array(M), at = Float64Array.from({ length: M }, (_, j) => j * step);
      const total = this.tau[N - 1], sigma = SPEED_SMOOTHING / step;
      for (let i = 0; i < N; i++) times[i] = T * EASE.inverse(this.tau[i] / total);
      for (let j = 0; j < M; j++) {
        // Where the ease is slower than its top speed, the turn needs less.
        grid[j] = lookup(times, turning, at[j]) * (EASE.rate(at[j] / T) / EASE.peak);
      }
      dilate(grid, Math.round(2 * sigma));
      blur(grid, sigma);
      for (let i = 0; i < N; i++) eased[i] = lookup(at, grid, times[i]) ** 4;
      // The share of the screen limit's pace kept: 1, or less to fit.
      const seconds = (k) => {
        let sum = 0, previous = 0;
        for (let i = 0; i < N; i++) {
          const q = (k * k * k * k * screen[i] ** 4 + eased[i]) ** 0.25;
          if (i > 0) sum += 0.5 * (previous + q) * ds;
          previous = q;
        }
        return sum;
      };
      let keep = 1;
      const most = DURATION.max / EASE.peak;
      if (seconds(1) > most) {
        let lo = 1 / MAX_STRETCH, hi = 1;
        if (seconds(lo) >= most) hi = lo;
        for (let k = 0; k < 30 && hi > lo; k++) {
          const mid = (lo + hi) / 2;
          if (seconds(mid) > most) hi = mid; else lo = mid;
        }
        keep = hi;
      }
      this.stretch = 1 / keep;
      for (let i = 0; i < N; i++) pace[i] = (keep ** 4 * screen[i] ** 4 + eased[i]) ** 0.25;
      this.#sum();
    }
    this.duration = duration();
    this.needed = EASE.peak * this.tau[N - 1];
  }

  /* The running sum of the pace: seconds (at the fastest allowed) to each sample. */
  #sum() {
    const pace = this.paceTable, tau = this.tau, ds = this.ds;
    tau[0] = 0;
    for (let i = 1; i < pace.length; i++) tau[i] = tau[i - 1] + 0.5 * (pace[i - 1] + pace[i]) * ds;
  }

  /*
   * The height above the ground along the route. The turns are flown low, at
   * the heights of the two ends (but over SAFE_HEIGHT), as an aircraft turns
   * onto its course after take-off and onto its approach before landing:
   * the climb to cruise and the descent from it are on the straight between
   * them, each a smootherstep no steeper than CLIMB. Below SAFE_HEIGHT the
   * climb at the start and the landing at the end are steep, on the
   * take-off run and the final straight. Where the straight is too short
   * for the cruise, the cruise is lowered; where it is too short for even
   * the change between the two ends' heights, that change is spread over
   * the whole route.
   */
  #shape() {
    const L = this.length, h0 = this.h0, h1 = this.h1;
    const p = this.profile = new Profile(this.instant ? h1 : h0);
    this.descentFrom = 0;
    this.cruise = Math.max(h0, h1);
    if (this.instant || L <= 0) return;
    if (!this.turns) { p.add(0, L, h1 - h0); return; }
    const lowStart = h0 < SAFE_HEIGHT, lowEnd = this.landing;
    const from = lowStart ? SAFE_HEIGHT : h0;          // the height of the first turn
    const to = lowEnd ? SAFE_HEIGHT : h1;              // and of the second
    let steepUp = lowStart ? (SMOOTHER_PEAK * (SAFE_HEIGHT - h0)) / STEEP_CLIMB : 0;
    let steepDown = lowEnd ? (SMOOTHER_PEAK * (SAFE_HEIGHT - h1)) / STEEP_DESCENT : 0;
    // A route too short for both steep parts: squeezed in, steeper.
    const squeeze = Math.min(1, (ROOM * L) / Math.max(1e-9, steepUp + steepDown));
    steepUp *= squeeze;
    steepDown *= squeeze;
    if (lowStart) p.add(0, steepUp, SAFE_HEIGHT - h0);
    if (lowEnd) p.add(L - steepDown, steepDown, h1 - SAFE_HEIGHT);
    // The straight between the turns, clear of the steep parts.
    const m = this.route.marks;
    const a = Math.max(m[1], steepUp), b = Math.min(m[2], L - steepDown);
    const room = ROOM * Math.max(0, b - a);
    const gentle = (rise) => (SMOOTHER_PEAK * Math.abs(rise)) / CLIMB;
    let cruise = Math.max(from, to, clamp(CRUISE.share * (b - a), CRUISE.min, CRUISE.max));
    if (gentle(cruise - from) + gentle(cruise - to) > room) {
      const fits = ((room * CLIMB) / SMOOTHER_PEAK + from + to) / 2;
      cruise = Math.max(from, to, Math.min(cruise, fits));
    }
    if (gentle(cruise - from) + gentle(cruise - to) <= room + 1e-6) {
      // A short level stretch after the first turn and before the second,
      // a turn's radius at most, so a long flight is not held down for long.
      const up = gentle(cruise - from), down = gentle(cruise - to);
      const slack = (b - a - up - down) / 2;
      const level1 = Math.min(slack, 0.05 * (b - a), this.route.radius);
      const level2 = Math.min(slack, 0.05 * (b - a), this.route.radius2);
      p.add(a + level1, up, cruise - from);
      p.add(b - level2 - down, down, to - cruise);
      this.descentFrom = b - level2 - down;
    } else {
      // Not even the change between the ends fits between the turns.
      const lo = lowStart ? steepUp : 0, hi = lowEnd ? L - steepDown : L;
      p.add(lo, Math.max(1e-6, hi - lo), to - from);
      this.descentFrom = lo;
    }
    if (lowEnd) this.descentFrom = Math.min(this.descentFrom, L - steepDown);
    this.cruise = cruise;
  }

  /* Metres along the route at a share `p` of its time in pace. */
  #along(p) {
    if (!this.tau) return p * this.length;
    const tau = this.tau, n = tau.length, want = p * tau[n - 1];
    if (want <= 0) return 0;
    if (want >= tau[n - 1]) return this.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tau[mid] <= want) lo = mid; else hi = mid;
    }
    const f = (want - tau[lo]) / Math.max(1e-300, tau[hi] - tau[lo]);
    return (lo + f) * this.ds;
  }

  /* The true heading of the route `s` metres along, from where it is and a
   * metre on, in the local east and north. */
  #trueHeading(s) {
    const back = s + 1 > this.length;
    const a = back ? s - 1 : s, b = back ? s : s + 1;
    this.route.at(a, this.seg);
    this.plane.inverse(this.seg.x, this.seg.y, this.geo);
    this.route.at(b, this.seg);
    this.plane.inverse(this.seg.x, this.seg.y, this.next);
    const { meridian, primeVertical } = radiiAt(this.geo.lat, this.radii);
    let dLon = this.next.lon - this.geo.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const east = dLon * DEG * primeVertical * Math.cos(this.geo.lat * DEG);
    const north = (this.next.lat - this.geo.lat) * DEG * meridian;
    return Math.atan2(east, north);
  }

  /*
   * The view along the flight, sampled TABLE_RATE times a second: heading
   * along the route, smoothed; nose following the climb, smoothed; bank from
   * how fast the smoothed heading turns, smoothed again.
   */
  #views() {
    const T = this.duration, n = Math.max(2, Math.ceil(T * TABLE_RATE) + 1), step = T / (n - 1);
    const yaw = this.yawTable = new Float64Array(n);
    const pitch = this.pitchTable = new Float64Array(n);
    const roll = this.rollTable = new Float64Array(n);
    const climb = new Float64Array(n);
    const L = this.length, dg = this.ground1 - this.ground0, finalFrom = L - this.route.final;
    this.finalTime = T;
    let previous = this.yaw0;
    for (let j = 0; j < n; j++) {
      const s = this.#along(EASE.at(j / (n - 1)));
      const h = this.straight ? this.yaw0 : previous + wrap(this.#trueHeading(s) - previous);
      yaw[j] = previous = h;
      this.profile.at(s, this.alt);
      climb[j] = Math.atan(this.alt.slope + (dg * smootherstepSlope(s / L)) / L);
      if (s >= finalFrom && this.finalTime === T) this.finalTime = j * step;
    }
    blur(yaw, SMOOTH.yaw / step);
    blur(climb, SMOOTH.pitch / step);
    for (let j = 0; j < n; j++) {
      const a = Math.max(0, j - 1), b = Math.min(n - 1, j + 1);
      const rate = (yaw[b] - yaw[a]) / ((b - a) * step);
      roll[j] = MAX_BANK * Math.tanh(rate / BANK_RATE);
      pitch[j] = clamp(this.pitch0 + PITCH_FOLLOW * climb[j], PITCH_MIN, PITCH_MAX);
    }
    blur(roll, SMOOTH.roll / step);
  }

  /* ---- flying ----------------------------------------------------------- */

  /* The view at the current time: from the tables, blended in from the
   * start angles and onto them at the end. */
  #orient(pose) {
    const t = this.t, T = this.duration;
    if (!this.turns || !(T > 0)) {
      pose.yaw = this.yaw0;
      pose.pitch = this.pitch0;
      pose.roll = this.roll0 * (1 - smootherstep(t / START_BLEND));
      return;
    }
    const u = (t / T) * (this.yawTable.length - 1);
    let yaw = sample(this.yawTable, u), pitch = sample(this.pitchTable, u), roll = sample(this.rollTable, u);
    const ws = smootherstep(t / Math.min(START_BLEND, 0.25 * T));
    yaw = this.yaw0 + ws * wrap(yaw - this.yaw0);
    pitch = this.pitch0 + ws * (pitch - this.pitch0);
    roll = this.roll0 + ws * (roll - this.roll0);
    const span = Math.min(END_BLEND.seconds, END_BLEND.share * T);
    const we = smootherstep((t - (T - span)) / span);
    yaw += we * wrap(this.yaw0 - yaw);
    pitch += we * (this.pitch0 - pitch);
    roll *= 1 - we;
    pose.yaw = wrap(yaw);
    pose.pitch = pitch;
    pose.roll = roll;
  }

  /* How much of the move to the landing spot is done (see #confirm). */
  #offsetShare() {
    if (!this.confirmed || !Number.isFinite(this.offsetFrom)) return 0;
    if (!(this.offsetTo > this.offsetFrom)) return 1;
    return smootherstep((this.t - this.offsetFrom) / (this.offsetTo - this.offsetFrom));
  }

  /*
   * A landing's spot, once the ground at the place is known exactly and its
   * buildings are in: then also the buildings along the end of the approach,
   * and when to move the end of the route over to the spot (over the rest
   * of the cruise, or the rest of the flight if that is all there is).
   */
  #confirm(env) {
    if (!env.landingSpot(this.to, this.h1, this.walk, this.spot)) return false;
    this.confirmed = true;
    this.groundTarget = this.spot.ground;
    this.rank = GROUND_EXACT;
    this.obstacle = 0;
    this.clearance.fill(0);
    if (env.approachTops?.(this.spot, this.yaw0, this.tops)) {
      let keep = 0;
      for (let k = 0; k < this.tops.length; k++) {
        if (this.tops[k] > -Infinity) keep = Math.max(keep, this.tops[k] + APPROACH_MARGIN);
        this.clearance[k] = keep;
      }
      this.obstacle = keep;
    }
    if (this.phase === 'flight') {
      const T = this.duration, t = this.t;
      if (T - t < 0.6) {
        this.lateShift = true;       // no time left to blend: glide over after arriving
      } else {
        this.offsetFrom = t;
        this.offsetTo = Math.min(T - 0.3, Math.max(t + 1.5, this.finalTime ?? T));
      }
    }
    return true;
  }

  /*
   * The hold (see HOLD_STIFFNESS): how far above the planned path the
   * flight is kept, following `want` metres. Where the hold is the height to
   * keep while the path goes on down, it grows as fast as the path falls,
   * and that rate, `feed`, is passed on, so it is followed exactly; a hold
   * let go or taken up is moved to smoothly. Never below the path: the
   * planned path already ends on the ground.
   */
  #vertical(dt, want, feed) {
    const K = HOLD_STIFFNESS, from = this.lastWant;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP)), h = dt / n;
    for (let i = 1; i <= n; i++) {
      const target = from + ((want - from) * i) / n;
      this.excessRate += (K * K * (target - this.excess) + 2 * K * (feed - this.excessRate)) * h;
      this.excessRate = feed + clamp(this.excessRate - feed, -HOLD_MAX_RATE, HOLD_MAX_RATE);
      this.excess += this.excessRate * h;
      if (this.excess < 0) { this.excess = 0; this.excessRate = Math.max(0, this.excessRate); }
    }
    this.lastWant = want;
  }

  /*
   * Near the ground, how far the ground right under `at` is from `blend`,
   * the ground the flight is planned over: where it is known exactly, all
   * of it below LOCAL_GROUND.low of planned height, none above .high.
   */
  #local(dt, env, at, planned, blend) {
    const near = 1 - smootherstep((planned - LOCAL_GROUND.low) / (LOCAL_GROUND.high - LOCAL_GROUND.low));
    let want = 0;
    if (near > 0 && env.groundAt(at.lon, at.lat, this.estimate) && this.estimate.rank >= GROUND_EXACT) {
      want = (this.estimate.height - blend) * near;
    }
    this.local = this.instant ? want : this.local + (want - this.local) * (1 - Math.exp(-dt / LOCAL_EASE));
    return this.local;
  }

  /* Better ground at the destination, as its tiles land: glided onto. */
  #refine(dt, env, allowed) {
    if (allowed && !this.confirmed && this.rank < GROUND_EXACT &&
        env.groundAt(this.to.lon, this.to.lat, this.estimate) && this.estimate.rank > this.rank) {
      this.groundTarget = this.estimate.height;
      this.rank = this.estimate.rank;
    }
    this.ground1 += (this.groundTarget - this.ground1) * (1 - Math.exp(-dt / GROUND_EASE));
  }

  /* Clear of what is known of the ground under a point of the flight, by
   * CLEARANCE, or by half the planned height above it when that is lower. */
  #clear(dt, env, lon, lat, height, planned) {
    const floor = env.floorAt(lon, lat);
    const margin = Math.min(CLEARANCE, 0.5 * Math.max(0, planned));
    const need = floor == null ? 0 : Math.max(0, floor + margin - height);
    this.lift += (need - this.lift) * (1 - Math.exp(-dt / (need > this.lift ? LIFT_UP : LIFT_DOWN)));
  }

  #enter(phase) {
    this.phase = phase;
    this.phaseTime = 0;
  }

  /**
   * Moves the camera along the flight. Returns true on the step it reaches
   * the destination; `active` stays true while it settles or lands there,
   * and `landed` says it came down onto its spot.
   * @param env  { floorAt(lon, lat): metres or null, the highest ground known
   *             under a point; groundAt(lon, lat, out): writes { height, rank }
   *             of the best ground known there, false if none;
   *             landingSpot(to, above, walk, out): writes { lon, lat, ground }
   *             of the nearest spot near `to` where a body `above` metres
   *             over the ground (standing on it when `walk`) is outside every
   *             building, false while the ground or buildings there are
   *             still loading; approachTops(spot, heading, out): writes, for
   *             each metre back from the spot against the heading, the
   *             highest building top within APPROACH_HALF_WIDTH of the path,
   *             metres above the spot's ground (-Infinity: none), false if
   *             nothing is known }
   */
  step(dt, camera, env) {
    if (!this.active) return false;
    this.phaseTime += dt;
    const pose = this.pose;
    let reached = false;

    if (this.phase === 'flight') {
      const T = this.duration;
      this.t = Math.min(T, this.t + dt);
      const x = T > 0 ? this.t / T : 1;
      const p = EASE.at(x);
      const s = this.#along(p);
      this.progress = p;
      this.lastStretch = this.turns && x < 1 && s > this.length - this.route.final;
      this.route.at(s, this.seg);
      this.plane.inverse(this.seg.x, this.seg.y, this.geo);
      if (this.landing && !this.confirmed) this.#confirm(env);
      this.#refine(dt, env, x >= REFINE_FROM);
      const w = this.#offsetShare();
      pose.lon = this.geo.lon + (this.spot.lon - this.to.lon) * w;
      pose.lat = this.geo.lat + (this.spot.lat - this.to.lat) * w;
      this.profile.at(s, this.alt);
      const planned = this.alt.height;
      if (this.landing && !this.instant) {
        // Held up until the spot is known, and over buildings near it.
        const holding = this.turns && s >= this.descentFrom;
        const floor = !holding ? -Infinity : !this.confirmed ? SAFE_HEIGHT
          : this.clearance[clamp(Math.round(this.length - s), 0, APPROACH_LENGTH)];
        const feed = floor > planned && dt > 0 ? -(planned - this.lastPlanned) / dt : 0;
        this.#vertical(dt, Math.max(0, floor - planned), feed);
      }
      this.lastPlanned = planned;
      const L = this.length;
      const blend = this.ground0 + (this.ground1 - this.ground0) * smootherstep(L > 0 ? s / L : 1);
      const base = blend + this.#local(dt, env, pose, planned, blend);
      const above = planned + this.excess;
      this.#clear(dt, env, pose.lon, pose.lat, base + above, planned);
      pose.height = base + above + this.lift;
      this.#orient(pose);
      if (x >= 1) {
        reached = true;
        this.arrived = true;
        this.lastStretch = false;
        if (!this.landing) this.#enter('settle');
        else if (!this.confirmed) this.#enter('hover');
        else if (this.lateShift) this.#startShift();
        else this.#enter('land');
      }
    } else if (this.phase === 'settle') {
      // Done once the ground there is known exactly and glided onto, or when
      // there is nothing to wait for.
      this.settle += dt;
      this.#refine(dt, env, true);
      const path = this.ground1 + this.h1;
      this.#clear(dt, env, this.to.lon, this.to.lat, path, this.h1);
      pose.lon = this.to.lon; pose.lat = this.to.lat; pose.height = path + this.lift;
      this.#level(pose);
      const settled = this.rank >= GROUND_EXACT && Math.abs(this.groundTarget - this.ground1) < 0.5 && this.lift < 0.5;
      if (!this.covered || settled || this.settle >= SETTLE_SECONDS) this.active = false;
    } else if (this.phase === 'hover') {
      // Over the place until its ground and buildings are in, then across to
      // the nearest spot outside them. Waiting too long, it comes down on
      // the best guess, and the walk takes it from there.
      this.hoverTime += dt;
      this.#refine(dt, env, true);
      if (!this.#confirm(env) && this.hoverTime >= HOVER_PATIENCE) {
        this.confirmed = true;
        this.guessed = true;
        this.spot.lon = this.to.lon; this.spot.lat = this.to.lat; this.spot.ground = this.ground1;
      }
      this.#vertical(dt, this.excess, 0);
      this.#place(pose, this.to, dt, env);
      if (this.confirmed) this.#startShift();
    }
    if (this.phase === 'shift') {
      const k = this.shiftTime > 0 ? smootherstep(this.phaseTime / this.shiftTime) : 1;
      this.#vertical(dt, this.shiftExcess, 0);
      this.#refine(dt, env, false);
      const at = this.next;
      at.lon = this.shiftFrom.lon + (this.spot.lon - this.shiftFrom.lon) * k;
      at.lat = this.shiftFrom.lat + (this.spot.lat - this.shiftFrom.lat) * k;
      this.#place(pose, at, dt, env);
      if (k >= 1) this.#enter('land');
    } else if (this.phase === 'land') {
      this.#refine(dt, env, false);
      if (this.instant) { this.excess = this.excessRate = this.lastWant = 0; this.lift = 0; this.ground1 = this.groundTarget; }
      this.#vertical(dt, 0, 0);
      this.#place(pose, this.spot, dt, env);
      if (this.excess < TOUCH.height && Math.abs(this.excessRate) < TOUCH.rate && this.lift < 0.05) {
        // Down: exactly the planned height over the ground under the spot.
        pose.height -= this.excess + this.lift;
        this.landed = true;
        this.active = false;
      }
    }

    this.#head(pose, dt);
    // The direction actually travelled, for the readout and the rig.
    const dLat = pose.lat - this.last.lat, dLon = (pose.lon - this.last.lon) * Math.cos(pose.lat * DEG);
    if (dLat * dLat + dLon * dLon > 1e-16) this.heading = bearing(this.last, pose);
    this.last.lon = pose.lon;
    this.last.lat = pose.lat;
    camera.apply(pose);
    return reached;
  }

  /* Hovering, gliding across and coming down: at `at`, held over the
   * arrival height above the ground there, level and on the start angles. */
  #place(pose, at, dt, env) {
    pose.lon = at.lon;
    pose.lat = at.lat;
    const base = this.ground1 + this.#local(dt, env, at, this.h1, this.ground1);
    const above = this.h1 + this.excess;
    this.#clear(dt, env, at.lon, at.lat, base + above, this.h1);
    pose.height = base + above + this.lift;
    this.#level(pose);
  }

  #level(pose) {
    pose.yaw = this.yaw0;
    pose.pitch = this.pitch0;
    pose.roll = 0;
  }

  /* Across to the spot at the height it is at, then down: from the end of
   * the route, wherever the flight got to with the move over to the spot. */
  #startShift() {
    const share = this.#offsetShare();
    this.shiftFrom.lon = this.to.lon + (this.spot.lon - this.to.lon) * share;
    this.shiftFrom.lat = this.to.lat + (this.spot.lat - this.to.lat) * share;
    this.shiftExcess = this.excess;
    const { meridian, primeVertical } = radiiAt(this.spot.lat, this.radii);
    const metres = Math.hypot((this.spot.lon - this.shiftFrom.lon) * primeVertical * Math.cos(this.spot.lat * DEG) * DEG,
      (this.spot.lat - this.shiftFrom.lat) * meridian * DEG);
    this.shiftTime = this.instant || metres < 0.3 ? 0 : clamp(metres / SHIFT_RATE, SHIFT_SECONDS.min, SHIFT_SECONDS.max);
    this.#enter('shift');
  }
}
