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
 *            does not collide on the way, for speed (his words, Stage 5.7:
 *            "only ignore collision checks (for performance) during the
 *            flight, never ignore collisions otherwise, only in flyTo
 *            flight"): the plan keeps clear of everything known, with a
 *            margin, and the whole path flown is checked before it starts
 *            (Stage 5.12b, his words: "calculate collisions before starting
 *            animation": plan.js, VERIFY; planned again where it passes too
 *            near). Four times a second the way ahead is looked at again
 *            (WATCH): should anything stand in it now, the way rises over it
 *            and comes back down after it.
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
 *            (FINISH), never past where it is going. A landing's way down
 *            that only clears what is there in the last moments, dropping
 *            faster than the flight's own pace, is not made on the way: as
 *            for a spot found late, the flight arrives over the place and
 *            comes down from there (CORRECT, Stage 5.11b).
 *   pace     the plan's clock never slows: the flight keeps the pace it was
 *            planned with from the click to the arrival (Stage 5.10b, his
 *            words on 5.9b: "really try to precalculate the path so that it
 *            doesn't jump velocity randomly"; until then the descent slowed
 *            down, for 5 s at most, while the place was still loading).
 *   hover    a landing whose spot is still not known by then never comes
 *            down on a guess (Stage 5.8b, his words on 5.7b: "it sometimes
 *            lands inside of a building": 5.7b came down at the place
 *            itself, often the address's own house): the flight ends over
 *            the place instead, HOVER.above the ground or HOVER.margin above
 *            the highest thing known round it, and goes on looking for the
 *            spot for HOVER.patience seconds; found, it glides down onto it
 *            (across, then down: open sky is above a spot; the two overlap
 *            only where that keeps as clear of what is there as a late
 *            change does, else it is all the way across before it comes
 *            down: Stage 5.12b) and lands; not, it stays up there, flying
 *            (`hovering`, for render.js's notice).
 *   arrive   exactly on the spot and the start angles (an arc ends facing
 *            the way it went: plan.js).
 *   again    a new place picked mid-flight (CONTINUE) arrives as the first
 *            one would have, and the flight to it goes on from the speed
 *            and the way the camera is going.
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
import { planVerified, endsOver, keepNearEnds, DEFAULT_SETTINGS, ARRIVAL, VERIFY } from './plan.js';
import { fullClearance, HEIGHT } from './profile.js';
import { PACE, bell, bellInverse } from './timing.js';

const DEG = Math.PI / 180;

/* A flight arriving lower than `below` metres over the ground lands; the
 * view's focus is moved `focus` metres round the place from take-off on, so
 * its ground and buildings load in time; arriving at once (no flight), it
 * hovers there `patience` seconds at most for its landing spot. */
export const LANDING = { focus: 100, below: 50, patience: 12 };

/* A landing whose spot is not known (see the top of the file) flies to over
 * the place, `above` metres over the ground or `margin` over the highest
 * thing within `radius` (where its spot may be: render.js's FOCUS_RADIUS),
 * and waits there `patience` seconds at most; then down to the spot when
 * found, in `least` seconds plus one for every `perSecond` metres, `most`
 * at most. */
export const HOVER = { above: 30, margin: 10, radius: 60, patience: 15, least: 1.5, perSecond: 20, most: 6 };

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
 * as the plan keeps clear). A landing's spot found with less than `late`
 * seconds of the plan left does not reshape it (squeezed into so little, the
 * way down jumped and overshot): the flight arrives over the place, where it
 * was going while the spot was not known (HOVER), and comes down from there.
 * Nor does one whose way down would drop faster than `pace` heights a second
 * anywhere (over the spot's ground, plus PACE.offset, as the flight's own
 * pace counts them: twice its peak), measured at `paceSamples` instants of
 * what is left (Stage 5.11b: where the bound round the place is still
 * coarse, the way down is clear only at the very end, and a walker's 3 s hop
 * in the rig dropped 64 m in half a second, then overshot under the ground:
 * 11 m, 69 m in another run). Coming down onto a landing's spot, the way
 * keeps as far as the spot's room (render.js, LANDING_ROOM: 1.5 m where
 * there is room) from what is there, but for right over the spot (within
 * `radius` of it), which is open sky down to its ground (Stage 5.12b, his
 * answers: "Through a roof or wall, Too close to a wall"). */
const CORRECT = { across: 0.5, samples: 64, radius: 0.5, margin: 1.05, late: 2.5, pace: 2 * PACE.peak, paceSamples: 48 };
/* A new place picked mid-flight (Stage 5.12b, his words: "if you click on
 * another result while in flyTo animation, remember the initial condition
 * (example, if first animation started in midair at 360m and destination is
 * changed midflight, destination will still be at 360m height, if it started
 * in walking mode and changed destination midflight, it has to land in
 * walking mode)"; his answer: keep the speed). It arrives as the first flight
 * would have: as high over the ground, walking or not (render.js keeps
 * those), facing the way you faced. The flight to it goes on from where the
 * camera is, at the speed it has: the new route leaves the way it is going
 * (plan.js, from.moving: no look round for the gentlest way out, the view on
 * the path from the start); its clock is read so that it sets off at that
 * speed along the new path (#planTime: the bell's progress plus c times the
 * quintic H(u) = u - 6u³ + 8u⁴ - 3u⁵, which starts at speed, adds nothing by
 * the end and leaves nothing to stop there, monotone for c up to `most`);
 * and whatever else the old motion has (coming down where the new way
 * leaves level, say) is given up over the first `blend` seconds, at most
 * `share` of the flight, along the same quintic, halved while that way
 * passes nearer what is there than VERIFY keeps (`least` at the shortest).
 * The view turns from where it looked onto the new flight's over as long,
 * or longer by a second for every `turn` it has to turn, `share` of the
 * flight at most. Slower than `slow` m/s, it sets off from rest. */
const CONTINUE = { slow: 0.5, most: 2.4, blend: 1.5, share: 0.25, least: 0.2, samples: 16, turn: 45 * DEG };
const quintic = (u) => u * (1 + u * u * (-6 + u * (8 - 3 * u)));

/* The glide down from over the place onto a spot found there (HOVER): across
 * over the first `across` of it, down over the last `down`, the two
 * overlapping where that is clear (looked at `samples` points), else one
 * after the other. */
const DOWN = { across: 0.6, down: 0.6, samples: 32 };
/* The way ahead is looked at four times a second (see the top of the file),
 * at CORRECT.samples points, against what is there now: where it passes
 * into anything (under the bound within #keepFrom of it, more than near an
 * end under it allows: plan.js, keepNearEnds), it rises over it as high as
 * the plan keeps over things there (its clearance, growing from the ends as
 * profile.js has it, CORRECT.margin at least). Only while more
 * than FINISH.least seconds of the plan are left. The plan and its late
 * changes keep clear of all that is known, so only something that has come
 * to stand in the way is ever passed into, and the way is never nudged
 * where it merely passes nearer than its margin between two of the points
 * a late change was laid out at (his words on 5.6: "make sure there are no
 * subtle little height corrections"). */
/* What is left of a late change when the clock runs out (or less than
 * `least` seconds are left of it): finished in `least` seconds, plus a
 * second for every `perSecond` metres, `most` at most; started again if the
 * end moves more than `moved` metres meanwhile. Each of its cubics starts
 * as fast as the end was moving, but never so fast that it would pass its
 * goal (3 r / span at most, towards it; from rest if it was moving away):
 * it stops at the goal, never beyond it (Stage 5.11b: one started at 140 m/s
 * down and went 12 m past the spot, under the ground). */
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
    this.t = 0;                 // seconds into the plan
    this.overtime = 0;          // seconds since the plan's clock ran out (finishing a late move of the end)
    this.elapsed = 0;           // real seconds flown
    this.duration = 0;
    this.progress = 0;          // 0 to 1 of the way (in σ)
    this.heading = 0;           // azimuth looked along, for the readout and the rig
    this.landing = false;
    this.confirmed = false;     // a landing's spot is known
    this.guessed = false;       // (no longer: a landing is never made on a guess)
    this.hovering = false;      // a flight over, its landing's spot not known: over the place
    this.deferred = false;      // a landing's spot found too late to reshape the way there
    this.hovered = 0;           // seconds over the place, looking for it
    this.gaveUp = false;        // ... and none found: ended up there, flying
    this.endZoned = false;      // exact obstacles round the place are in the bounds
    this.ready = 1;             // how much of the place has loaded (env.ready; for the readouts)
    this.walk = false;
    this.instant = false;
    this.covered = true;
    this.label = '';
    this.cancelled = null;
    this.to = { lon: 0, lat: 0 };
    this.spot = { lon: 0, lat: 0, ground: 0, room: 0 };
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
    this.verified = null;       // the path's check before it flew (plan.js, planVerified)
    this.lifts = 0;             // times the way ahead rose over something on the way (WATCH)
    this.setOff = { x: 0, y: 0, h: 0 };  // where the plan set off (plane metres)
    // How the camera moves (plane metres and m/s, from its last step), and
    // what a flight set off at speed carries (CONTINUE).
    this.motion = { valid: false, x: 0, y: 0, h: 0, vx: 0, vy: 0, vh: 0 };
    this.going = null;
    this.carry = null;
    this.ends = {};                      // the ends as the watch reads them (plan.js, endsOver)
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
   *                  an overhang); carry: a new place picked mid-flight, the
   *                  way there going on from this one (CONTINUE)
   */
  start(camera, target, env, settings = DEFAULT_SETTINGS, { instant = false, slideTo = null, carry = false } = {}) {
    // Picked mid-flight: the first flight's end view, and how the camera goes now.
    let going = null;
    if (carry && this.active) {
      const m = this.motion;
      going = { yaw0: this.yaw0, pitch0: this.pitch0, view: { yaw: camera.yaw, pitch: camera.pitch, roll: camera.roll ?? 0 },
        speed: 0, azimuth: camera.yaw, up: 0 };
      if (m.valid && this.plane) {
        going.speed = Math.hypot(m.vx, m.vy);
        if (going.speed > 1e-6) going.azimuth = this.plane.azimuthAt(m.x, m.y, Math.atan2(m.vx, m.vy));
        going.up = m.vh;
      }
    }
    this.settings = settings;
    this.to.lon = target.lon; this.to.lat = target.lat;
    this.spot.lon = target.lon; this.spot.lat = target.lat; this.spot.ground = target.ground; this.spot.room = 0;
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
    this.endYaw = camera.yaw;
    this.confirmed = this.guessed = this.endZoned = false;
    this.hovering = this.gaveUp = this.deferred = false;
    this.hovered = 0;
    this.down = null;
    this.arrived = this.landed = false;
    this.cancelled = null;
    this.closest = Infinity;
    this.lookYaw = this.lookPitch = 0;
    this.lookIdle = Infinity;
    this.elapsed = this.overtime = 0;
    this.ready = 1;
    this.nextLook = REVIEW_EVERY;
    this.t = 0;
    this.progress = 0;
    this.duration = 0;
    this.plan = null;
    this.heading = camera.yaw;
    this.active = true;
    if (going) { this.yaw0 = going.yaw0; this.pitch0 = going.pitch0; this.endYaw = going.yaw0; }
    this.going = going && Math.hypot(going.speed, going.up) > CONTINUE.slow ? going : null;
    this.carry = null;
    this.motion.valid = false;
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
    const p = this.pose, g = this.going;
    this.plane.forward(camera.lon, camera.lat, p);
    const end = this.plane.forward(this.spot.lon, this.spot.lat, this.endXY);
    const t0 = performance.now();
    // Set off at speed (CONTINUE): the way it is going, across (straight up
    // or down, the way it looks).
    const heading = this.plane.headingAt(camera.lon, camera.lat, g && g.speed > CONTINUE.slow / 4 ? g.azimuth : camera.yaw);
    this.plan = planVerified({
      from: { x: p.x, y: p.y, height: camera.height, pitch: camera.pitch, heading, moving: Boolean(g), slope: g ? Math.atan2(g.up, g.speed) : 0 },
      to: { x: end.x, y: end.y, height: this.landing && !this.confirmed ? this.#hoverHeight(env) : this.spot.ground + this.h1, exact: this.#exactEnd(),
        heading: this.plane.headingAt(this.spot.lon, this.spot.lat, this.yaw0) },
      bound: this.bound, ground: this.ground, settings: this.settings, endPitch: this.pitch0,
    });
    this.planMs = performance.now() - t0;
    this.verified = this.plan?.verified ?? null;
    this.lifts = 0;
    this.setOff.x = p.x; this.setOff.y = p.y; this.setOff.h = camera.height;
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
    this.#carryOn(camera);
    // An arc ends facing the way it went (plan.js, arcPlan); every other
    // flight the way you faced.
    if (this.plan.kind === 'arc') this.endYaw = this.plane.azimuthAt(this.plan.endX, this.plan.endY, this.plan.endHeading);
    this.#want(env);
    this.#prefetch(env);
    this.phase = 'flight';
  }

  /*
   * Setting off at speed (CONTINUE): how the clock is read (c), and what the
   * old motion has besides the new path's way at its start (dv, plane m/s),
   * given up over `blend` seconds, the view turning over `turn` seconds.
   */
  #carryOn(camera) {
    const plan = this.plan, g = this.going;
    this.carry = null;
    if (!g || !(plan.duration > 0) || plan.m < 2 || !(plan.sigma > 0)) return;
    const hd = this.plane.headingAt(camera.lon, camera.lat, g.azimuth);
    const vx = g.speed * Math.sin(hd), vy = g.speed * Math.cos(hd), vh = g.up;
    // The new path's way at its start, and the metres a unit of σ there.
    let ux = plan.x[1] - plan.x[0], uy = plan.y[1] - plan.y[0], uh = plan.h[1] - plan.h[0];
    const len = Math.hypot(ux, uy, uh);
    if (!(len > 1e-9)) return;
    ux /= len; uy /= len; uh /= len;
    const T = plan.duration, perSigma = len / plan.sigmaStep, along = Math.max(0, vx * ux + vy * uy + vh * uh);
    const c = Math.min(CONTINUE.most, ((along / perSigma) * T) / plan.sigma);
    const speed0 = ((c * plan.sigma) / T) * perSigma;
    const cr = this.carry = { c, blend: Math.min(CONTINUE.blend, CONTINUE.share * T), turn: 0,
      dv: { x: vx - ux * speed0, y: vy - uy * speed0, h: vh - uh * speed0 }, view: g.view };
    while (cr.blend > CONTINUE.least && !this.#blendClear()) cr.blend /= 2;
    // The view: from where it looked onto the new flight's own.
    const q = plan.at(0, this.blendPose ??= {}), yaw = this.plane.azimuthAt(q.x, q.y, q.yaw);
    const angle = Math.acos(Math.max(-1, Math.min(1, Math.cos(g.view.pitch) * Math.cos(q.pitch) * Math.cos(wrapAngle(yaw - g.view.yaw)) +
      Math.sin(g.view.pitch) * Math.sin(q.pitch))));
    cr.turn = Math.max(cr.blend, Math.min(CONTINUE.share * T, angle / CONTINUE.turn));
  }

  /* Whether the way the camera goes while it gives up its old motion keeps
   * as clear of what is there as the new path does near its start (VERIFY,
   * keepNearEnds). */
  #blendClear() {
    const plan = this.plan, cr = this.carry, n = CONTINUE.samples, p = this.blendPose ??= {};
    const e = endsOver(this.bound, plan.x[0], plan.y[0], plan.h[0], plan.endX, plan.endY, plan.h[plan.m - 1], this.ends);
    for (let i = 1; i <= n; i++) {
      const t = (cr.blend * i) / n, d = cr.blend * quintic(t / cr.blend);
      plan.at(this.#planTime(t), p);
      const x = p.x + cr.dv.x * d, y = p.y + cr.dv.y * d, h = p.height + cr.dv.h * d;
      if (h < this.bound(x, y, VERIFY.radius) + keepNearEnds(e, x, y, VERIFY.margin)) return false;
    }
    return true;
  }

  /* The plan's own clock at flight time t (CONTINUE: set off at speed, its
   * progress the bell's plus c times the quintic), and that progress. */
  #planTime(t) {
    const c = this.carry?.c ?? 0, T = this.plan.duration;
    if (!(c > 0) || !(T > 0)) return t;
    return T * bellInverse(this.#progressAt(t));
  }

  #progressAt(t) {
    const T = this.plan.duration, u = T > 0 ? Math.min(1, Math.max(0, t / T)) : 1;
    return Math.min(1, bell(u) + (this.carry?.c ?? 0) * quintic(u));
  }

  /* How the camera moved this step (plane metres a second), for a flight
   * picked after it (CONTINUE). */
  #track(dt, camera) {
    const m = this.motion, q = this.plane?.forward(camera.lon, camera.lat, this.trackXY ??= { x: 0, y: 0 });
    if (!q) return;
    if (m.valid && dt > 0) { m.vx = (q.x - m.x) / dt; m.vy = (q.y - m.y) / dt; m.vh = (camera.height - m.h) / dt; }
    m.x = q.x; m.y = q.y; m.h = camera.height;
    m.valid = true;
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
    const arrived = this.#phase(dt, camera, env);
    this.#track(dt, camera);
    return arrived;
  }

  #phase(dt, camera, env) {
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
      // At once, no plan, or a flight over: over the place, until a
      // landing's spot is known (HOVER), then down onto it.
      this.hovered += dt;
      this.elapsed += dt;
      if (!this.landing) return this.#arrive(camera, env);
      if (this.confirmed) {
        if (!this.plan) return this.#arrive(camera, env);
        this.#startDown(camera);
        return false;
      }
      if (this.hovered >= HOVER.patience) return this.#giveUp(camera, env);
      this.#hover(camera, env, dt);
      return false;
    }
    if (this.phase === 'down') return this.#comeDown(dt, camera, env);
    return false;
  }

  /* ---- the end ------------------------------------------------------------- */

  /* What the flight should arrive at: the landing spot exactly, anything
   * else clear of what is there. */
  #exactEnd() { return this.landing && this.confirmed && !this.guessed; }

  #arrival(env) {
    if (this.landing && !this.confirmed) return this.#hoverHeight(env);
    const wanted = this.spot.ground + this.h1;
    if (this.#exactEnd()) return wanted;
    return Math.max(wanted, env.bound(this.spot.lon, this.spot.lat, ARRIVAL.radius) + ARRIVAL.margin);
  }

  /* Over the place while its landing spot is looked for (HOVER). */
  #hoverHeight(env) {
    return Math.max(this.ground1 + HOVER.above, env.bound(this.to.lon, this.to.lat, HOVER.radius) + HOVER.margin);
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
    this.#watch();
  }

  /*
   * The way ahead against what is there now (WATCH): where anything stands
   * in it, a late change rises from where the flight is to the first point
   * too near (as far as every point after it needs), keeps that over what
   * follows, and comes back down to the plan from where the way down is
   * clear (#clear), so the end stays where it was.
   */
  #watch() {
    const plan = this.plan;
    if (this.phase !== 'flight' || !plan || plan.duration - this.t < FINISH.least) return;
    const n = CORRECT.samples, s0 = this.pose.sigma, s1 = plan.sigma;
    if (!(s1 > s0)) return;
    // The ends as they are now: where the flight set off, and the end as moved.
    const e = endsOver(this.bound, this.setOff.x, this.setOff.y, this.setOff.h,
      plan.endX + this.aimed.x, plan.endY + this.aimed.y, plan.endHeight + this.aimed.h, this.ends);
    const p = this.planPoint ??= { x: 0, y: 0, h: 0 }, o = this.offset ??= { x: 0, y: 0, h: 0 };
    let first = -1;
    for (let i = 1; i < n && first < 0; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      planPoint(plan, s, p);
      this.offsetAt(s, o);
      const x = p.x + o.x, y = p.y + o.y, r = this.#keepFrom(x, y);
      if (r >= 0 && this.bound(x, y, r) + Math.min(0, keepNearEnds(e, x, y, 0)) > p.h + o.h) first = s;
    }
    if (first < 0) return;
    const c = { s0, mid: first, s1, dx: 0, dy: 0, up: 0, down: 0, from: first };
    // As far over what is there as the plan keeps there.
    const full = fullClearance(plan.distance);
    this.#clear(c, 0, (x, y) => keepNearEnds(e, x, y, Math.max(CORRECT.margin,
      Math.min(full, HEIGHT.clearance.min + HEIGHT.clearance.ends * Math.min(Math.hypot(x - e.x0, y - e.y0), Math.hypot(x - e.x1, y - e.y1))))));
    if (!(c.up > 0)) return;
    this.corrections.push(c);
    this.lifts++;
  }

  /* A landing's spot, once the ground and buildings there have loaded. */
  #confirm(env) {
    const spot = this.found;
    if (!env.landingSpot(this.to, this.h1, this.walk, spot)) return false;
    this.confirmed = true;
    this.spot.lon = spot.lon;
    this.spot.lat = spot.lat;
    this.spot.ground = this.ground1 = spot.ground;
    this.spot.room = spot.room ?? 0;
    this.rank = GROUND_EXACT;
    return true;
  }

  /* The spot found while over the place: across to above it, then down onto
   * it, along minimum-jerk curves (from rest to rest), overlapping where that
   * keeps clear (DOWN). */
  #startDown(camera) {
    this.down = { lon0: camera.lon, lat0: camera.lat, h0: camera.height, time: 0,
      span: Math.min(HOVER.most, HOVER.least + Math.hypot(camera.height - (this.spot.ground + this.h1)) / HOVER.perSecond),
      across: DOWN.across, from: 1 - DOWN.down };
    const p = this.plane.forward(camera.lon, camera.lat, this.endXY);
    const q = this.plane.forward(this.spot.lon, this.spot.lat, { x: 0, y: 0 });
    this.down.span = Math.min(HOVER.most, this.down.span + Math.hypot(q.x - p.x, q.y - p.y) / HOVER.perSecond);
    if (!this.#downClear(p, q, camera.height)) { this.down.across = 0.5; this.down.from = 0.5; }
    this.hovering = false;
    this.phase = 'down';
  }

  /* Whether the overlapping glide from (p, height h0) down onto the spot at
   * q keeps as clear of what is there as a late change (CORRECT). */
  #downClear(p, q, h0) {
    const d = this.down, goal = this.spot.ground + this.h1, n = DOWN.samples;
    for (let i = 1; i < n; i++) {
      const s = i / n, a = smootherstep(Math.min(1, s / d.across)), k = smootherstep(Math.max(0, (s - d.from) / (1 - d.from)));
      const x = p.x + (q.x - p.x) * a, y = p.y + (q.y - p.y) * a, h = h0 + (goal - h0) * k, r = this.#keepFrom(x, y);
      if (r >= 0 && h < this.bound(x, y, r) + CORRECT.margin) return false;
    }
    return true;
  }

  /* How far the way keeps from what is there at (x, y) (plane metres): a
   * landing's room once its spot is known, else CORRECT.radius; -1 right over
   * the spot (within CORRECT.radius of it), open sky down to its ground. */
  #keepFrom(x, y) {
    if (!(this.landing && this.confirmed)) return CORRECT.radius;
    const q = this.plane.forward(this.spot.lon, this.spot.lat, this.spotXY ??= { x: 0, y: 0 });
    if (Math.hypot(x - q.x, y - q.y) < CORRECT.radius) return -1;
    return Math.max(CORRECT.radius, this.spot.room);
  }

  #comeDown(dt, camera, env) {
    const d = this.down;
    d.time += dt;
    this.elapsed += dt;
    const s = Math.min(1, d.time / d.span);
    const across = smootherstep(Math.min(1, s / d.across)), down = smootherstep(Math.max(0, (s - d.from) / (1 - d.from)));
    const v = this.view;
    v.lon = d.lon0 + (this.spot.lon - d.lon0) * across;
    v.lat = d.lat0 + (this.spot.lat - d.lat0) * across;
    v.height = d.h0 + (this.spot.ground + this.h1 - d.h0) * down;
    v.yaw = camera.yaw;
    v.pitch = camera.pitch;
    v.roll = 0;
    camera.apply(v);
    if (s < 1) return false;
    this.endYaw = camera.yaw;
    this.pitch0 = camera.pitch;
    this.plan = null;
    return this.#arrive(camera, env);
  }

  /* None found: up there it stays, flying. */
  #giveUp(camera, env) {
    this.gaveUp = true;
    this.arrived = true;
    this.landed = false;
    this.progress = 1;
    this.active = false;
    this.phase = 'idle';
    return true;
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
    if (this.t >= T) this.overtime += dt;
    this.t = Math.min(T, this.t + dt);
    const p = this.pose, v = this.view, m = this.moved, mv = this.moving;
    plan.at(this.#planTime(this.t), p);
    // The late changes: reshaping what is left of the path while there is
    // enough of it, finished in a moment after that (from how fast the
    // offset was moving, so it carries on without a kink).
    if (T - this.t > FINISH.least) {
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
    // Set off at speed (CONTINUE): what it moved at besides, given up.
    const cr = this.carry;
    if (cr && this.t < cr.blend) {
      const d = cr.blend * quintic(this.t / cr.blend);
      p.x += cr.dv.x * d;
      p.y += cr.dv.y * d;
      p.height += cr.dv.h * d;
    }
    this.plane.inverse(p.x, p.y, this.geo);
    const ground = env.exactGround?.(this.geo.lon, this.geo.lat);
    if (ground != null) this.closest = Math.min(this.closest, p.height - ground);
    v.lon = this.geo.lon;
    v.lat = this.geo.lat;
    v.height = p.height;
    v.yaw = this.plane.azimuthAt(p.x, p.y, p.yaw);
    v.pitch = p.pitch;
    v.roll = p.roll;
    if (cr && this.t < cr.turn) {
      // ... and the view turned from where it looked onto the new flight's.
      const w = smootherstep(this.t / cr.turn), o = cr.view;
      v.yaw = wrapAngle(o.yaw + wrapAngle(v.yaw - o.yaw) * w);
      v.pitch = o.pitch + (v.pitch - o.pitch) * w;
      v.roll = o.roll + (v.roll - o.roll) * w;
    }
    this.#head(v, dt);
    camera.apply(v);
    this.heading = v.yaw;
    this.progress = p.progress;
    // There once the clock has run out and the end has stopped moving (or,
    // should the end keep moving, a little after that at most); a landing
    // whose spot is still not known waits over the place (HOVER).
    if (this.t >= T && (this.finish?.done || this.overtime > FINISH.most + 1)) {
      if (this.landing && (!this.confirmed || this.deferred)) {
        // Over the place: its spot still looked for, or found too late to
        // come down onto it on the way (CORRECT.late). Exactly on the end's
        // angles, as an arrival is.
        this.hovering = !this.confirmed;
        v.yaw = this.endYaw;
        v.pitch = this.pitch0;
        v.roll = 0;
        camera.apply(v);
        this.phase = 'wait';
        return false;
      }
      return this.#arrive(camera, env);
    }
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
    // Too late to reshape, or found so once: over the place, then down (HOVER).
    if (this.landing && (this.deferred || plan.duration - this.t < CORRECT.late)) { this.deferred = true; return; }
    const end = plan.sigma, mid = s + CORRECT.across * (end - s);
    const c = { s0: s, mid, s1: end, dx, dy, up: Math.max(0, dh), down: 0, from: mid };
    this.#clear(c, dh);
    // Its way down squeezed into too little of what is left: the same.
    if (this.landing && c.down < 0 && !this.#paced(c)) { this.deferred = true; return; }
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
  #clear(c, dh, margin = null) {
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
      const x = p.x + o.x + c.dx * a, y = p.y + o.y + c.dy * a, r = i < n ? this.#keepFrom(x, y) : -1;
      room[i] = r >= 0 ? this.bound(x, y, r) + (margin ? margin(x, y) : CORRECT.margin) : -Infinity;
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

  /*
   * Whether a late change's way down keeps to the flight's pace (CORRECT):
   * at CORRECT.paceSamples instants of what is left of the plan's clock, it
   * drops no faster than CORRECT.pace heights a second over the spot's
   * ground (plus PACE.offset), where it would be.
   */
  #paced(c) {
    const plan = this.plan, T = plan.duration, t0 = this.t, n = CORRECT.paceSamples;
    if (!(T > t0)) return true;
    const p = this.planPoint ??= { x: 0, y: 0, h: 0 }, o = this.offset ??= { x: 0, y: 0, h: 0 };
    const changeAt = (s) => c.up * smootherstep((s - c.s0) / Math.max(1e-12, c.mid - c.s0)) +
      c.down * smootherstep((s - c.from) / Math.max(1e-12, c.s1 - c.from));
    let last = changeAt(plan.sigma * this.#progressAt(t0));
    for (let i = 1; i <= n; i++) {
      const t = t0 + ((T - t0) * i) / n, s = plan.sigma * this.#progressAt(t), change = changeAt(s);
      planPoint(plan, s, p);
      this.offsetAt(s, o);
      const above = Math.max(0, p.h + o.h + change - this.spot.ground);
      if ((last - change) * n > CORRECT.pace * (above + PACE.offset) * (T - t0)) return false;
      last = change;
    }
    return true;
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
    const w = this.deferred ? this.aimed : this.wanted, m = this.moved, mv = this.moving;
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
    const w = this.deferred ? this.aimed : this.wanted, m = this.moved, mv = this.moving;
    f.goal.x = w.x; f.goal.y = w.y; f.goal.h = holding ? m.h : w.h;
    for (const c of ['x', 'y', 'h']) {
      f.r[c] = f.goal[c] - m[c];
      f.v[c] = mv[c];
    }
    const rest = Math.hypot(f.r.x, f.r.y, f.r.h);
    f.span = rest < SETTLED && Math.hypot(mv.x, mv.y, mv.h) < SETTLED ? 0 : Math.min(FINISH.most, FINISH.least + rest / FINISH.perSecond);
    // Never past the goal: from rest if moving away from it, else no faster
    // than reaches it without overshooting (a cubic ending at rest passes
    // its goal when it starts faster than 3 r / span).
    for (const c of ['x', 'y', 'h']) {
      const r = f.r[c], v = f.v[c];
      if (v * r < 0) f.v[c] = 0;
      else if (Math.abs(v) * f.span > 3 * Math.abs(r)) f.v[c] = (3 * r) / Math.max(1e-9, f.span);
    }
    f.time = 0;
    f.stages++;
  }

  /* Over the place with no flight (an instant trip whose spot is not known
   * yet): clear of everything. */
  #hover(camera, env, dt) {
    const v = this.view, goal = this.#hoverHeight(env);
    v.lon = this.to.lon;
    v.lat = this.to.lat;
    // Placed there at once (no flight): at the height; after a flight,
    // easing onto it as what stands there loads.
    v.height = !this.plan || !(dt > 0) ? goal : camera.height + (goal - camera.height) * (1 - Math.exp(-dt / 0.5));
    v.yaw = camera.yaw;
    v.pitch = camera.pitch;
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
    v.yaw = this.endYaw;
    v.pitch = this.pitch0;
    v.roll = 0;
    camera.apply(v);
    this.heading = this.endYaw;
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
