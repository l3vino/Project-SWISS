/* flight.js — a flight to a search result, as it happens.
 *
 * plan.js works a whole flight out from where the camera is to where it
 * should arrive, once, at the click; this file flies it (Stage 5.5: one plan,
 * no re-plans, no corrections in the air, so the speed never jumps):
 *
 *   start    from where the camera is, facing the way it faces. Under an
 *            overhang (a roof, a bridge, a rope), it first slides out to
 *            open sky (render.js finds where), then lifts.
 *   flight   along the plan: the camera looks along the path, its heading
 *            and its slope (down the middle of the tube drawn along it),
 *            banked into the curves and leaning towards the straight line
 *            between the ends (plan.js), and is set down exactly where and
 *            how it should arrive, facing the way it faced, tilted as it was. It
 *            does not check what it might touch on the way, for speed: the
 *            plan keeps clear of everything known, with a margin (his words,
 *            Stage 5.7: "only ignore collision checks (for performance)
 *            during the flight, never ignore collisions otherwise, only in
 *            flyTo flight").
 *   late     four times a second, what has loaded since may move the end:
 *            a landing (a walker, or a flight ending low) comes down where a
 *            body fits, outside every building, which is only known once the
 *            ground and buildings there have loaded; better ground at the
 *            place, or what stands there exactly, changes the arrival
 *            height. Each change reshapes only the part of the path still
 *            ahead (Stage 5.7, his words: "make sure there are no subtle
 *            little height corrections"): from where the flight is, along
 *            smootherstep curves in σ, so its height and its speed carry on
 *            as they were; sideways (and up) over the first half of what is
 *            left, down at the end, and both clear of what is there as the
 *            plan is (CORRECT): rising as it moves across where the moved
 *            way passes over something, and coming down only from where the
 *            way from there on is clear coming down (a landing beside a
 *            house the plan ended on comes down beside it, not through its
 *            roof). Whatever comes when the plan's clock has (nearly) run out
 *            is finished smoothly in a moment, across first, then down
 *            (FINISH).
 *   wait     if the place is not ready when the descent is well under way
 *            (plan.holdTime: the landing spot unknown, or too little of what
 *            the arrival will show loaded), the flight's clock slows down
 *            smoothly (WAIT) rather than arriving into gaps, for
 *            WAIT.longest seconds of delay at most, easing back included;
 *            then a landing comes down at the place itself.
 *   arrive   exactly on the spot and the start angles.
 *   settle   an instant trip (no flight) is there at once, on the best
 *            ground known; for SETTLE.longest seconds after, it follows
 *            better ground at the place as it loads, so it ends as high above
 *            the ground as asked. The mouse looks around meanwhile (render.js),
 *            and a movement key ends it.
 *
 * Moving the mouse turns the head, not the flight: the view follows the
 * mouse and eases back once it stops. A movement key cancels (render.js).
 *
 * The environment (`env`, from render.js) is everything the flight asks
 * about the world:
 *   bound(lon, lat, r)       the height nothing within r metres reaches above
 *   estimate(lon, lat, r)    how high what is within r metres reaches, as best known (the pace)
 *   groundAt(lon, lat, out)  the best ground known there: { height, rank }
 *   exactGround(lon, lat)    accurate ground there, or null (only measured)
 *   landingSpot(to, above, walk, out)  where a body fits near `to` (see render.js)
 *   endZone(to)              exact obstacles around `to`, once loaded: true when added
 *   ready(to)                how much of what the arrival will show has loaded, 0..1
 *   prefetch(lon, lat, level), levelFor(metres)  terrain columns along the way
 */

import { Plane, wrapAngle } from '../../core/geo.js';
import { smootherstep } from '../../core/signal.js';
import { planFlight, DEFAULT_SETTINGS, ARRIVAL } from './plan.js';
import { fullClearance } from './profile.js';

const DEG = Math.PI / 180;

/* A flight arriving lower than `below` metres over the ground lands; the
 * view's focus is moved `focus` metres round the place from take-off on, so
 * its ground and buildings load in time; arriving at once (no flight), it
 * hovers there `patience` seconds at most for its landing spot. */
export const LANDING = { focus: 100, below: 50, patience: 12 };

/* Waiting for the place (see the top of the file): the clock slows to `rate`
 * at least, changing by `ease` a second at most, for `longest` seconds of
 * delay at most; the place is ready when its landing spot is known and
 * `ready` of what the arrival will show has loaded. */
export const WAIT = { rate: 0.15, ease: 1.2, longest: 5, ready: 0.9 };

/* How good an estimate of the ground at the destination is: accurate ground
 * beats the place's own elevation (from the search service), which beats
 * the top of a fine tile, ranked by its level. */
export const GROUND_EXACT = 100;
export const GROUND_ELEVATION = 50;

const REVIEW_EVERY = 0.25;        // seconds between looks at what has loaded
const SETTLED = 1e-3;             // metres: the end is where it should be
/* A late change of the end (see the top of the file) is spread over what is
 * left of the flight's σ: sideways and up over the first `across` of it,
 * down from the earliest of `samples` points after that from which the way
 * on keeps `margin` metres over everything within `radius` of it (the bound,
 * as the plan keeps clear). */
const CORRECT = { across: 0.5, samples: 64, radius: 0.5, margin: 1.05 };
/* What is left of a late change when the clock runs out (or less than
 * `least` seconds are left of it): finished in `least` seconds, plus a
 * second for every `perSecond` metres, `most` at most; started again if the
 * end moves more than `moved` metres meanwhile. */
const FINISH = { least: 0.4, perSecond: 25, most: 2, moved: 0.01 };
const LOOK = { hold: 0.8, back: 0.6, pitch: 85 * DEG };
const SLIDE = { speed: 4, least: 0.6 };         // m/s, and seconds at least
const PREFETCH_POINTS = 24;
/* An instant trip's settle onto better ground: for `longest` seconds, each
 * better height is glided to on the minimum-jerk curve (from where it is and
 * how fast it is going), in `least` seconds plus one for every `perSecond`
 * metres, `most` at most. */
const SETTLE = { longest: 5, least: 0.6, perSecond: 25, most: 2.5 };

/* A plan's position at σ `s`, between its samples (even in σ) in a straight line, into `out`. */
function planPoint(plan, s, out) {
  const f = Math.max(0, Math.min(plan.m - 1, s / Math.max(1e-12, plan.sigmaStep)));
  const k = Math.min(plan.m - 2, Math.floor(f)), v = f - k;
  out.x = plan.x[k] + (plan.x[k + 1] - plan.x[k]) * v;
  out.y = plan.y[k] + (plan.y[k + 1] - plan.y[k]) * v;
  out.h = plan.h[k] + (plan.h[k + 1] - plan.h[k]) * v;
  return out;
}

export class Flight {
  constructor() {
    this.active = false;
    this.arrived = false;       // reached the place
    this.landed = false;        // came down onto its landing spot (a walker walks on)
    this.phase = 'idle';        // slide, flight, wait, settle, idle
    this.t = 0;                 // seconds into the plan (its own clock, which may slow)
    this.rate = 1;              // the plan's clock against real time
    this.waited = 0;            // seconds of delay so far, waiting for the place
    this.elapsed = 0;           // real seconds flown
    this.duration = 0;
    this.progress = 0;          // 0 to 1 of the way (in σ)
    this.heading = 0;           // azimuth looked along, for the readout and the rig
    this.landing = false;
    this.confirmed = false;     // a landing's spot is known
    this.guessed = false;       // ... or was given up on and taken as the place
    this.endZoned = false;      // exact obstacles round the place are in the bounds
    this.ready = 1;             // how much of the place has loaded (env.ready)
    this.walk = false;
    this.instant = false;
    this.covered = true;
    this.label = '';
    this.cancelled = null;
    this.to = { lon: 0, lat: 0 };
    this.spot = { lon: 0, lat: 0, ground: 0 };
    this.ground1 = 0;
    this.rank = -1;
    this.h1 = 0;
    this.yaw0 = 0;
    this.pitch0 = 0;
    this.settings = DEFAULT_SETTINGS;
    this.plan = null;
    this.plane = null;
    this.bound = null;
    this.cruise = 0;
    this.planMs = 0;
    this.closest = Infinity;    // nearest the camera came to accurate ground, metres (measured only)
    this.nextLook = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookIdle = Infinity;
    this.slide = null;
    // An instant trip's settle: seconds so far, the height's speed, and the glide under way.
    this.settle = { time: 0, speed: 0, from: 0, goal: 0, v0: 0, t: 0, span: 0 };
    // The end: where the plan ends, where it should end now (wanted, metres
    // east, north and up of the plan's end), the corrections reshaping the
    // path still ahead towards it and what they add up to at the end
    // (aimed), and the offset they give where the flight is now (moved).
    this.wanted = { x: 0, y: 0, h: 0 };
    this.aimed = { x: 0, y: 0, h: 0 };
    this.corrections = [];
    this.moved = { x: 0, y: 0, h: 0 };
    this.moving = { x: 0, y: 0, h: 0 };
    this.finish = null;         // finishing the end's move after the clock ran out
    this.pose = { index: 0, x: 0, y: 0, height: 0, heading: 0, speed: 0, along: 0, piece: 0, sigma: 0, progress: 0,
      yaw: 0, roll: 0, pitch: 0, onPath: 0 };
    this.view = { lon: 0, lat: 0, height: 0, yaw: 0, pitch: 0, roll: 0 };   // what the camera is given
    this.geo = { lon: 0, lat: 0 };
    this.endXY = { x: 0, y: 0 };
    this.found = { lon: 0, lat: 0, ground: 0 };
    this.estimate = { height: 0, rank: -1 };
  }

  /**
   * @param camera  where it starts
   * @param target  { lon, lat, label, covered, ground, rank, arrive, walk }:
   *                the best ground known at the place and how good it is
   *                (GROUND_EXACT, GROUND_ELEVATION, a tile level, or below),
   *                whether terrain covers it, the height above the ground to
   *                arrive at, and whether to land there walking
   * @param env     the world, as the top of the file lists it
   * @param settings  { speed, longest, maxBank } (plan.js, DEFAULT_SETTINGS)
   * @param options   instant: be there at once; slideTo: { lon, lat,
   *                  distance } to slide to before lifting (out from under
   *                  an overhang)
   */
  start(camera, target, env, settings = DEFAULT_SETTINGS, { instant = false, slideTo = null } = {}) {
    this.settings = settings;
    this.to.lon = target.lon; this.to.lat = target.lat;
    this.spot.lon = target.lon; this.spot.lat = target.lat; this.spot.ground = target.ground;
    this.ground1 = target.ground;
    this.rank = target.rank;
    this.covered = target.covered !== false;
    this.walk = Boolean(target.walk) && this.covered;
    this.h1 = Math.max(0, target.arrive);
    this.landing = this.covered && this.h1 < LANDING.below;
    this.instant = Boolean(instant);
    this.label = target.label || '';
    this.yaw0 = camera.yaw;
    this.pitch0 = camera.pitch;
    this.confirmed = this.guessed = this.endZoned = false;
    this.arrived = this.landed = false;
    this.cancelled = null;
    this.closest = Infinity;
    this.lookYaw = this.lookPitch = 0;
    this.lookIdle = Infinity;
    this.waited = this.elapsed = 0;
    this.rate = 1;
    this.ready = 1;
    this.nextLook = REVIEW_EVERY;
    this.t = 0;
    this.progress = 0;
    this.duration = 0;
    this.plan = null;
    this.heading = camera.yaw;
    this.active = true;
    this.plane = new Plane(target.lon, target.lat);
    this.bound = (x, y, r) => {
      this.plane.inverse(x, y, this.geo);
      return env.bound(this.geo.lon, this.geo.lat, r);
    };
    this.ground = env.estimate ? (x, y, r) => {
      this.plane.inverse(x, y, this.geo);
      return env.estimate(this.geo.lon, this.geo.lat, r);
    } : this.bound;
    if (this.landing) this.#confirm(env);
    if (slideTo && !this.instant) {
      this.slide = { lon0: camera.lon, lat0: camera.lat, lon1: slideTo.lon, lat1: slideTo.lat, time: 0,
        duration: Math.max(SLIDE.least, (slideTo.distance ?? 0) / SLIDE.speed) };
      this.phase = 'slide';
      return;
    }
    this.#begin(camera, env);
  }

  /* Plans from where the camera is now, once. */
  #begin(camera, env) {
    if (this.instant) {
      this.plan = null;
      this.duration = 0;
      this.phase = 'wait';
      return;
    }
    const p = this.pose;
    this.plane.forward(camera.lon, camera.lat, p);
    const end = this.plane.forward(this.spot.lon, this.spot.lat, this.endXY);
    const t0 = performance.now();
    this.plan = planFlight({
      from: { x: p.x, y: p.y, height: camera.height, pitch: camera.pitch, heading: this.plane.headingAt(camera.lon, camera.lat, camera.yaw) },
      to: { x: end.x, y: end.y, height: this.spot.ground + this.h1, exact: this.#exactEnd(),
        heading: this.plane.headingAt(this.spot.lon, this.spot.lat, this.yaw0) },
      bound: this.bound, ground: this.ground, settings: this.settings, endPitch: this.pitch0,
    });
    this.planMs = performance.now() - t0;
    this.t = 0;
    this.moved.x = this.moved.y = this.moved.h = 0;
    this.moving.x = this.moving.y = this.moving.h = 0;
    this.aimed.x = this.aimed.y = this.aimed.h = 0;
    this.corrections.length = 0;
    this.finish = null;
    if (!this.plan) {
      this.phase = 'wait';
      return;
    }
    this.duration = this.plan.duration;
    this.cruise = this.plan.profile.cruise;
    this.#want(env);
    this.#prefetch(env);
    this.phase = 'flight';
  }

  /** The mouse moved during the flight: turn the head by these angles. */
  look(dYaw, dPitch) {
    if (!this.active) return;
    this.lookYaw = wrapAngle(this.lookYaw + dYaw);
    this.lookPitch += dPitch;
    this.lookIdle = 0;
  }

  /** Hands control back where the flight is; `reason` is kept for the probe. */
  cancel(reason = 'cancelled') {
    if (this.active) this.cancelled = reason;
    this.active = false;
  }

  /**
   * Moves the camera along the flight. Returns true on the step it reaches
   * the place; `landed` then says it came down onto its landing spot.
   */
  step(dt, camera, env) {
    if (!this.active) return false;
    this.nextLook -= dt;
    if (this.nextLook <= 0) {
      this.nextLook = REVIEW_EVERY;
      this.#review(env);
    }
    if (this.phase === 'flight') return this.#fly(dt, camera, env);
    if (this.phase === 'settle') return this.#settle(dt, camera, env);
    if (this.phase === 'slide') {
      const sl = this.slide;
      sl.time += dt;
      this.elapsed += dt;
      const k = smootherstep(sl.time / sl.duration), v = this.view;
      v.lon = sl.lon0 + (sl.lon1 - sl.lon0) * k;
      v.lat = sl.lat0 + (sl.lat1 - sl.lat0) * k;
      v.height = camera.height;
      v.yaw = this.yaw0;
      v.pitch = this.pitch0;
      v.roll = 0;
      camera.apply(v);
      if (k >= 1) this.#begin(camera, env);
      return false;
    }
    if (this.phase === 'wait') {
      // At once, or no plan: over the place, until a landing's spot is known.
      this.waited += dt;
      if (this.landing && !this.confirmed && this.waited >= LANDING.patience) this.#guess(env);
      if (!this.landing || this.confirmed) return this.#arrive(camera, env);
      this.#hover(camera, env);
    }
    return false;
  }

  /* ---- the end ------------------------------------------------------------- */

  /* What the flight should arrive at: the landing spot exactly, anything
   * else clear of what is there. */
  #exactEnd() { return this.landing && this.confirmed && !this.guessed; }

  #arrival(env) {
    const wanted = this.spot.ground + this.h1;
    if (this.#exactEnd()) return wanted;
    return Math.max(wanted, env.bound(this.spot.lon, this.spot.lat, ARRIVAL.radius) + ARRIVAL.margin);
  }

  /* Where the end should be now, against where the plan ends. */
  #want(env) {
    const plan = this.plan;
    if (!plan) return;
    const end = this.plane.forward(this.spot.lon, this.spot.lat, this.endXY);
    this.wanted.x = end.x - plan.endX;
    this.wanted.y = end.y - plan.endY;
    this.wanted.h = this.#arrival(env) - plan.endHeight;
  }

  /* Four times a second: what has loaded since. */
  #review(env) {
    if (this.landing && !this.confirmed) this.#confirm(env);
    if (!this.landing && this.covered) {
      this.#refineGround(env);
      if (!this.endZoned && env.endZone?.(this.to)) this.endZoned = true;
    }
    this.ready = env.ready ? env.ready(this.to) : 1;
    this.#want(env);
  }

  /* The place is ready: its landing spot known, and enough of it loaded. */
  #isReady() {
    return (!this.landing || this.confirmed) && this.ready >= WAIT.ready;
  }

  /* A landing's spot, once the ground and buildings there have loaded. */
  #confirm(env) {
    const spot = this.found;
    if (!env.landingSpot(this.to, this.h1, this.walk, spot)) return false;
    this.confirmed = true;
    this.spot.lon = spot.lon;
    this.spot.lat = spot.lat;
    this.spot.ground = this.ground1 = spot.ground;
    this.rank = GROUND_EXACT;
    return true;
  }

  /* Waited long enough: down at the place itself, on the best ground known. */
  #guess(env) {
    this.confirmed = this.guessed = true;
    this.spot.lon = this.to.lon;
    this.spot.lat = this.to.lat;
    if (env.groundAt(this.to.lon, this.to.lat, this.estimate)) this.spot.ground = this.ground1 = this.estimate.height;
  }

  /* Better ground at the place than the flight knew (not for a landing,
   * whose spot is exact): how much it moved, metres. */
  #refineGround(env) {
    if (this.landing || !this.covered) return 0;
    if (!env.groundAt(this.to.lon, this.to.lat, this.estimate) || !(this.estimate.rank > this.rank)) return 0;
    this.rank = this.estimate.rank;
    const moved = Math.abs(this.estimate.height - this.spot.ground);
    this.spot.ground = this.ground1 = this.estimate.height;
    return moved;
  }

  /* ---- flying ------------------------------------------------------------- */

  #fly(dt, camera, env) {
    const plan = this.plan, T = plan.duration;
    this.elapsed += dt;
    // The clock: slowed smoothly while the place is not ready, late on, as
    // long as the delay, with the easing back to come, stays within WAIT.
    const comeBack = ((1 - this.rate) ** 2 * WAIT.ease) / 2;
    const hold = this.t >= plan.holdTime && this.t < T && !this.#isReady() && this.waited + comeBack < WAIT.longest;
    const target = hold ? WAIT.rate : 1;
    const step = dt / WAIT.ease;
    this.rate += Math.max(-step, Math.min(step, target - this.rate));
    if (this.rate < 1) this.waited += dt * (1 - this.rate);
    if (!hold && this.waited > 0 && this.landing && !this.confirmed && this.t >= plan.holdTime) {
      this.#guess(env);
      this.#want(env);
    }
    this.t = Math.min(T, this.t + dt * this.rate);
    const p = this.pose, v = this.view, m = this.moved, mv = this.moving;
    plan.at(this.t, p);
    // The late changes: reshaping what is left of the path while there is
    // enough of it, finished in a moment after that (from how fast the
    // offset was moving, so it carries on without a kink).
    const left = (T - this.t) / Math.max(1e-6, this.rate);
    if (this.t < T && left > FINISH.least) {
      this.#correct(p.sigma);
      const x = m.x, y = m.y, h = m.h;
      this.offsetAt(p.sigma, m);
      if (dt > 0) { mv.x = (m.x - x) / dt; mv.y = (m.y - y) / dt; mv.h = (m.h - h) / dt; }
    } else {
      this.#finishing(dt);
    }
    p.x += m.x;
    p.y += m.y;
    p.height += m.h;
    this.plane.inverse(p.x, p.y, this.geo);
    const ground = env.exactGround?.(this.geo.lon, this.geo.lat);
    if (ground != null) this.closest = Math.min(this.closest, p.height - ground);
    v.lon = this.geo.lon;
    v.lat = this.geo.lat;
    v.height = p.height;
    v.yaw = this.plane.azimuthAt(p.x, p.y, p.yaw);
    v.pitch = p.pitch;
    v.roll = p.roll;
    this.#head(v, dt);
    camera.apply(v);
    this.heading = v.yaw;
    this.progress = p.progress;
    // There once the clock has run out and the end has stopped moving (or,
    // should the end keep moving, a little after that at most).
    if (this.t >= T && (this.finish?.done || this.elapsed > T + this.waited + FINISH.most + 1)) return this.#arrive(camera, env);
    return false;
  }

  /*
   * A late change of the end (see the top of the file): what the end should
   * move by beyond what the changes already under way add up to, spread from
   * σ `s` (where the flight is) to the plan's end along smootherstep curves:
   * nothing moves where the flight is, nor how fast it moves there.
   * { s0, mid, s1 (σ: from, across by, to), dx, dy (across), up (risen
   * while moving across), down (then, from σ `from` to the end) }.
   */
  #correct(s) {
    const w = this.wanted, a = this.aimed, plan = this.plan;
    const dx = w.x - a.x, dy = w.y - a.y, dh = w.h - a.h;
    if (Math.abs(dx) + Math.abs(dy) + Math.abs(dh) < SETTLED) return;
    const end = plan.sigma, mid = s + CORRECT.across * (end - s);
    const c = { s0: s, mid, s1: end, dx, dy, up: Math.max(0, dh), down: 0, from: mid };
    this.#clear(c, dh);
    this.corrections.push(c);
    a.x = w.x; a.y = w.y; a.h = w.h;
  }

  /*
   * Keeps a late change clear of what is there (CORRECT): looks along the
   * way ahead, moved, at CORRECT.samples points; rises as it moves across
   * as much as the lowest pass needs; and comes down (by `dh` less what it
   * rose) from the earliest point from the middle on from which the way to
   * the end is clear coming down, or over the last step if there is none.
   */
  #clear(c, dh) {
    const n = CORRECT.samples, plan = this.plan;
    const sigma = this.clearSigma ??= new Float64Array(n + 1), base = this.clearBase ??= new Float64Array(n + 1);
    const room = this.clearRoom ??= new Float64Array(n + 1), across = this.clearAcross ??= new Float64Array(n + 1);
    const p = this.planPoint ??= { x: 0, y: 0, h: 0 }, o = this.offset ??= { x: 0, y: 0, h: 0 };
    let up = c.up, first = n;
    for (let i = 0; i <= n; i++) {
      const s = c.s0 + ((c.s1 - c.s0) * i) / n, a = smootherstep((s - c.s0) / Math.max(1e-12, c.mid - c.s0));
      planPoint(plan, s, p);
      this.offsetAt(s, o);
      sigma[i] = s;
      across[i] = a;
      base[i] = p.h + o.h;
      room[i] = i < n ? this.bound(p.x + o.x + c.dx * a, p.y + o.y + c.dy * a, CORRECT.radius) + CORRECT.margin : -Infinity;
      if (a > 0.01) up = Math.max(up, (room[i] - base[i]) / a);
      if (s >= c.mid && first === n) first = i;
    }
    c.up = up;
    c.down = dh - up;
    if (!(c.down < 0)) return;
    const clearFrom = (j) => {
      for (let i = j + 1; i < n; i++) {
        const k = smootherstep((sigma[i] - sigma[j]) / Math.max(1e-12, c.s1 - sigma[j]));
        if (base[i] + up * across[i] + c.down * k < room[i]) return false;
      }
      return true;
    };
    let j = first;
    while (j < n - 1 && !clearFrom(j)) j++;
    c.from = sigma[j];
  }

  /** What the late changes add to the plan at σ `s` (plane metres east, north and up), into `out`. */
  offsetAt(s, out) {
    out.x = out.y = out.h = 0;
    for (const c of this.corrections) {
      const across = smootherstep((s - c.s0) / Math.max(1e-12, c.mid - c.s0));
      out.x += c.dx * across;
      out.y += c.dy * across;
      out.h += c.up * across + c.down * smootherstep((s - c.from) / Math.max(1e-12, c.s1 - c.from));
    }
    return out;
  }

  /*
   * What is left of a late change once the clock has (nearly) run out:
   * finished on cubics that start as the end was moving and stop dead
   * (FINISH): across first, the height eased to rest, then down; started
   * again if the end moves meanwhile.
   */
  #finishing(dt) {
    const w = this.wanted, m = this.moved, mv = this.moving;
    const holding = w.h < m.h && Math.hypot(w.x - m.x, w.y - m.y) >= 0.3;
    let f = this.finish;
    if (!f || Math.abs(f.x - w.x) + Math.abs(f.y - w.y) + Math.abs(f.h - w.h) > FINISH.moved) {
      f = this.finish = { x: w.x, y: w.y, h: w.h, done: false, stages: 0, time: 0, span: 0, goal: {}, r: {}, v: {} };
      this.#finishStage(f, holding);
    }
    f.time += dt;
    const s = f.span > 0 ? Math.min(1, f.time / f.span) : 1, d = f.span;
    const h00 = 2 * s * s * s - 3 * s * s + 1, h10 = s * s * s - 2 * s * s + s;
    for (const c of ['x', 'y', 'h']) {
      const next = f.goal[c] - (h00 * f.r[c] - h10 * d * f.v[c]);
      mv[c] = dt > 0 ? (next - m[c]) / dt : 0;
      m[c] = next;
    }
    if (s < 1) return;
    // Across is done; what is left is a move down, now.
    if (Math.abs(w.h - m.h) > SETTLED && f.stages < 2) this.#finishStage(f, false);
    else f.done = true;
  }

  /* Starts finishing what is left of the end's move from where it is and
   * how fast it is going: all of it, or, when `holding`, across only, the
   * height eased to rest where it is. */
  #finishStage(f, holding) {
    const w = this.wanted, m = this.moved, mv = this.moving;
    f.goal.x = w.x; f.goal.y = w.y; f.goal.h = holding ? m.h : w.h;
    for (const c of ['x', 'y', 'h']) {
      f.r[c] = f.goal[c] - m[c];
      f.v[c] = mv[c];
    }
    const rest = Math.hypot(f.r.x, f.r.y, f.r.h);
    f.span = rest < SETTLED && Math.hypot(mv.x, mv.y, mv.h) < SETTLED ? 0 : Math.min(FINISH.most, FINISH.least + rest / FINISH.perSecond);
    f.time = 0;
    f.stages++;
  }

  /* Over the place with no flight (an instant trip whose spot is not known
   * yet): clear of everything. */
  #hover(camera, env) {
    const v = this.view;
    v.lon = this.to.lon;
    v.lat = this.to.lat;
    v.height = Math.max(this.spot.ground + this.h1, env.bound(this.to.lon, this.to.lat, 2) + fullClearance(0));
    v.yaw = this.yaw0;
    v.pitch = this.pitch0;
    v.roll = 0;
    camera.apply(v);
  }

  /* Adds the head turn to the view, holding it while the mouse moves and
   * easing it back after. */
  #head(v, dt) {
    if (this.lookYaw === 0 && this.lookPitch === 0) return;
    this.lookIdle += dt;
    if (this.lookIdle > LOOK.hold) {
      const k = Math.exp(-dt / LOOK.back);
      this.lookYaw *= k;
      this.lookPitch *= k;
      if (Math.abs(this.lookYaw) + Math.abs(this.lookPitch) < 1e-4) this.lookYaw = this.lookPitch = 0;
    }
    v.yaw = wrapAngle(v.yaw + this.lookYaw);
    v.pitch = Math.max(-LOOK.pitch, Math.min(LOOK.pitch, v.pitch + this.lookPitch));
  }

  /* Terrain along the way, at the detail that brings its bound within a
   * quarter of the clearance, at low priority. */
  #prefetch(env) {
    const plan = this.plan;
    if (!plan || !env.prefetch) return;
    const level = env.levelFor(fullClearance(plan.distance) / 4), R = plan.samples;
    const step = Math.max(1, Math.floor(R.n / PREFETCH_POINTS));
    for (let i = 0; i < R.n; i += step) {
      this.plane.inverse(R.X[i], R.Y[i], this.geo);
      env.prefetch(this.geo.lon, this.geo.lat, level);
    }
  }

  /* There: exactly on the spot and the start angles. */
  #arrive(camera, env) {
    const first = !this.arrived;
    this.arrived = true;
    const v = this.view;
    v.lon = this.spot.lon;
    v.lat = this.spot.lat;
    v.height = this.plan ? this.plan.endHeight + this.wanted.h : this.#arrival(env);
    v.yaw = this.yaw0;
    v.pitch = this.pitch0;
    v.roll = 0;
    camera.apply(v);
    this.heading = this.yaw0;
    this.progress = 1;
    this.landed = this.landing;
    if (this.instant && !this.landing && this.covered && this.rank < GROUND_EXACT) {
      // There at once on ground only guessed: settle onto better ground.
      const st = this.settle;
      st.time = st.speed = st.v0 = st.t = st.span = 0;
      st.from = st.goal = v.height;
      this.phase = 'settle';
      return first;
    }
    this.active = false;
    this.phase = 'idle';
    return first;
  }

  /* After an instant trip: the height follows better ground at the place
   * (#review refines it four times a second) until it is exact and reached,
   * or SETTLE.longest has gone by (a glide under way still ends). Each new
   * height is reached on the minimum-jerk curve, starting at the speed it has:
   * p0 + Δ·(10s³ − 15s⁴ + 6s⁵) + v0·D·(s − 6s³ + 8s⁴ − 3s⁵), no acceleration
   * at either end. Only the height: the mouse turns the view. */
  #settle(dt, camera, env) {
    const st = this.settle;
    st.time += dt;
    this.elapsed += dt;
    const goal = this.#arrival(env);
    if (st.time < SETTLE.longest && Math.abs(goal - st.goal) > FINISH.moved) {
      st.from = camera.height;
      st.goal = goal;
      st.v0 = st.speed;
      st.t = 0;
      st.span = Math.min(SETTLE.most, SETTLE.least + Math.abs(goal - st.from) / SETTLE.perSecond);
    }
    st.t += dt;
    const s = st.span > 0 ? Math.min(1, st.t / st.span) : 1;
    const height = st.from + (st.goal - st.from) * smootherstep(s) + st.v0 * st.span * (s - s * s * s * (6 - s * (8 - 3 * s)));
    st.speed = dt > 0 ? (height - camera.height) / dt : 0;
    const v = this.view;
    v.lon = camera.lon;
    v.lat = camera.lat;
    v.height = height;
    v.yaw = camera.yaw;
    v.pitch = camera.pitch;
    v.roll = camera.roll ?? 0;
    camera.apply(v);
    if (s >= 1 && (this.rank >= GROUND_EXACT || st.time >= SETTLE.longest)) {
      this.active = false;
      this.phase = 'idle';
    }
    return false;
  }
}
