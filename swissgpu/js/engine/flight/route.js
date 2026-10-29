/* route.js — where a search flight goes, seen from above, and how it climbs.
 *
 * The shape (Stage 5.6, his words on 5.5: "one continuous double curved
 * line... like an S, where the really curvy parts are just at beginning and
 * end"): rise from where you are, along the way you face; curve towards the
 * place; hand over, round the middle of the flight, to a curve the other way;
 * curve back, so you arrive facing the way you faced; come down onto it.
 *
 * The turning is shaped in time, one profile for the whole S (Stage 5.7, his
 * words: "the tilt has to be constant, I notice that around the middle of the
 * path, it kind of visibly locks for a split second to looking straight"):
 * its rate rises along a smoothstep where the first curve begins (a little
 * way up the climb, TURN.startClimb of its σ, while the flight is slow),
 * holds, crosses over to the second curve's rate along one smoothstep centred
 * on the bell's middle, holds, and falls along a smoothstep to nothing where
 * the second ends (as far into the descent). The crossing passes through zero
 * at its steepest, so the view never stops turning between the curves and
 * the bank, which follows the rate, rolls through level at a steady pace
 * (5.6 eased each curve to rest at the middle: for 0.6–1.5 s the view stood
 * still and level there). Two angles, two rates: a 2 × 2 linear system
 * (sTurning). The bell is as long as the pace asks, or longer where the rates
 * or how fast they change would pass TURN.rate or TURN.accel, about where
 * motion sickness starts (18°/s and 15°/s², Applied Sciences 2020, 10:7808).
 * Since the flight is slow at its ends and fastest halfway (timing.js), the
 * curvature, the rate over the speed, is sharp near the ends and gentle in
 * the middle. A curve's size comes from the trip: its distance, its height
 * (the pace is in heights a second) and the angle to turn; a place straight
 * ahead is a straight line.
 *
 * Where it goes then follows from integrating the velocity (timing.js's
 * bell over σ, the climb's shape, the heading's schedule): the Design. For
 * both S (right first then left, or left first then right: never a loop,
 * Stage 5.8b) and each first angle on a scan (the heading at the middle is the start's
 * plus that angle), the total σ that leaves the end on the line through the
 * place along that middle heading is found, and where the miss across that
 * line changes sign, the angle is refined; the quickest design wins, and a
 * final Newton step closes it exactly. A flat stand-in for the ground is
 * used while designing (the start's ground, the end's, and a line between
 * them); plan.js lays the result over the real terrain, and paces it against
 * the same stand-in, so the turning in time is the designed one.
 *
 * The climb and the descent (Shape): each leaves (or meets) the ground at an
 * angle and leans into level flight across its whole height (Stage 5.11b,
 * his words: "on long S flights make the vertical curve less sharp"). Stage
 * 5.7, his words: "checks point A and B how much space it has around, so
 * that when possible, the path does not start straight 90 deg up. but at a
 * curve"; his answer: 60° when nothing is around. From the air, in the open,
 * a climb leaves level and curves up into its angle instead (Stage 5.8b), as
 * a descent curves down from the cruise, and both may be gentler, down to
 * 20°, where 60° would tilt the view too fast (5.11b, plan.js: PITCH); from
 * the ground in the open it leaves at about half its angle and curves up
 * into it (Stage 5.10b, his answer: "rising in a curve"). The planner gives
 * each end its own shape (plan.js).
 *
 * Headings are azimuths (clockwise from north), x east and y north; a
 * positive turn angle turns right.
 */

import { smoothstep, smoothstepArea } from '../../core/signal.js';
import { PACE, DURATION, bell, bellRate, bellInverse } from './timing.js';

const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

/*
 * rate        the fastest the path turns, radians a second (at the natural pace)
 * accel       the quickest its rate changes, radians a second squared
 * max         the most one curve turns
 * startClimb  the share of the climb's σ flown before the first curve begins
 *             (and of the descent's after the second ends), where it starts
 *             straight up; `startAngled` where it leaves at an angle (a
 *             climbing turn from early on: the flights 5.6 made in 20 s
 *             take 16)
 * step        first angles scanned, apart
 * rise        the share of its half the first curve takes to turn up to its
 *             rate (and the second to wind down at the end)
 * cross       the share of the shorter half, either side of the middle, over
 *             which the turning hands over from one curve to the other
 */
export const TURN = { rate: 20 * DEG, accel: 15 * DEG, max: 250 * DEG, startClimb: 0.3, startAngled: 0.1, step: 4 * DEG, rise: 0.25, cross: 0.35 };

/* ---- the S's turning ------------------------------------------------------- */

/* A smoothstep's integral at its middle (0.09375), and from its middle to its end. */
const HALF_AREA = smoothstepArea(0.5);

/**
 * The turning of an S whose curves turn a1 (from its start to the bell's
 * middle) and a2 (from the middle to its end), over a bell T seconds long, the
 * first curve starting at the share e1 of it and the second ending at the
 * share e2 before its end, into `k`: { r1, r2 (signed rates, radians a
 * second), t1, mid, tEnd, rise1, rise2, w (the hand-over's half width),
 * hold1, hold2 }. The rates follow from the angles: the first half turns
 * r1 (rise1 / 2 + hold1 + 0.8125 w) + r2 0.1875 w, the second the mirror.
 * Returns false where either curve would turn the wrong way (one much larger
 * than the other).
 */
export function sTurning(a1, a2, T, e1, e2, k) {
  const D1 = T * (0.5 - e1), D2 = T * (0.5 - e2);
  const rise1 = TURN.rise * D1, rise2 = TURN.rise * D2, w = TURN.cross * Math.min(D1, D2);
  const q = 2 * HALF_AREA * w, P1 = D1 - rise1 / 2 - q, P2 = D2 - rise2 / 2 - q;
  const det = P1 * P2 - q * q;
  const r1 = (a1 * P2 - a2 * q) / det, r2 = (a2 * P1 - a1 * q) / det;
  k.r1 = r1; k.r2 = r2;
  k.t1 = T * e1; k.mid = T / 2; k.tEnd = T * (1 - e2);
  k.rise1 = rise1; k.rise2 = rise2; k.w = w;
  k.hold1 = D1 - rise1 - w; k.hold2 = D2 - rise2 - w;
  return !((Math.abs(a1) > 1e-9 && r1 * a1 < 0) || (Math.abs(a2) > 1e-9 && r2 * a2 < 0));
}

/** How much an S has turned at time t (radians, signed). */
export function sTurned(k, t) {
  const { r1, r2, t1, rise1, rise2, w, hold1, hold2 } = k;
  if (!(t > t1)) return 0;
  if (t < t1 + rise1) return r1 * rise1 * smoothstepArea((t - t1) / rise1);
  let base = r1 * (rise1 / 2 + hold1);
  const c0 = k.mid - w;
  if (t < c0) return r1 * (rise1 / 2 + (t - t1 - rise1));
  if (t < k.mid + w) return base + r1 * (t - c0) + (r2 - r1) * 2 * w * smoothstepArea((t - c0) / (2 * w));
  base += w * (r1 + r2);
  const f0 = k.tEnd - rise2;
  if (t < f0) return base + r2 * (t - k.mid - w);
  base += r2 * hold2;
  if (t < k.tEnd) { const z = (t - f0) / rise2; return base + r2 * rise2 * (z - smoothstepArea(z)); }
  return base + (r2 * rise2) / 2;
}

/** Its rate there (radians a second, signed). */
export function sRate(k, t) {
  const { r1, r2, t1, rise1, rise2, w } = k;
  if (!(t > t1) || !(t < k.tEnd)) return 0;
  if (t < t1 + rise1) return r1 * smoothstep((t - t1) / rise1);
  if (t < k.mid - w) return r1;
  if (t < k.mid + w) return r1 + (r2 - r1) * smoothstep((t - k.mid + w) / (2 * w));
  if (t < k.tEnd - rise2) return r2;
  return r2 * (1 - smoothstep((t - k.tEnd + rise2) / rise2));
}

/** How fast that changes (radians a second squared). */
export function sAccel(k, t) {
  const { r1, r2, t1, rise1, rise2, w } = k;
  if (!(t > t1) || !(t < k.tEnd)) return 0;
  const bump = (x, span) => (6 * x * (1 - x)) / span;
  if (t < t1 + rise1) return r1 * bump((t - t1) / rise1, rise1);
  if (t < k.mid - w) return 0;
  if (t < k.mid + w) return (r2 - r1) * bump((t - k.mid + w) / (2 * w), 2 * w);
  if (t < k.tEnd - rise2) return 0;
  return -r2 * bump((t - k.tEnd + rise2) / rise2, rise2);
}

/**
 * The shortest bell (seconds) an S fits in without passing TURN.rate or
 * TURN.accel: its rates scale as 1/T and their changes as 1/T², so one
 * evaluation at T = 1 says. Infinity where it turns a curve the wrong way.
 */
export function sSpan(a1, a2, e1, e2, k = {}) {
  if (!sTurning(a1, a2, 1, e1, e2, k)) return Infinity;
  const rate = Math.max(Math.abs(k.r1), Math.abs(k.r2));
  const accel = Math.max(1.5 * Math.abs(k.r1) / k.rise1, 1.5 * Math.abs(k.r2) / k.rise2, k.w > 0 ? (1.5 * Math.abs(k.r2 - k.r1)) / (2 * k.w) : 0);
  return Math.max(rate / TURN.rate, Math.sqrt(accel / TURN.accel));
}

/* ---- the climb and the descent ------------------------------------------------ */

/*
 * A Shape: the climb's angle with the horizontal at a share v of its σ
 * starts at `angle` and leans towards level along a smoothstep of v^lean,
 * level as it reaches the cruise (the descent is the same, backwards).
 * ANGLES run from 60° (nothing near: his answer) to 90° (boxed in), and
 * below 60° down to 20° for an end in the air (plan.js, PITCH); a higher
 * lean holds the start's angle longer and covers less ground (LEANS, for
 * trips where the climb and the descent alone would carry the flight past
 * the place). A step of σ moves the camera q(γ) heights, where q weighs going
 * up or down as van Wijk and Nuij weigh zooming against panning (PACE.zoom,
 * ρ): q = 1 / sqrt(cos²γ + sin²γ / ρ²). Tabled per shape: the log of the
 * height gained (∫ sin γ q), the horizontal metres per σ per metre of
 * height (cos γ q), and how fast its angle changes per share of its σ (for
 * how fast the view tilts: tiltRate). Ground covered per metre of rise from
 * the street to 200 m (to 2 km): 60° lean 2 1.7 (2.2), lean 3 1.3 (1.7),
 * lean 5 1.0 (1.3); 90° lean 1 1.3 (1.9), lean 5 0.3 (0.4).
 */
export const ANGLES = [20, 30, 45, 60, 70, 80, 90].map((a) => a * DEG);
export const LEANS = [1, 2, 3, 5];
/* The shape with nothing near: 60°, lean 1, easing into level across the
 * whole climb (Stage 5.11b, his words: "on long S flights make the vertical
 * curve less sharp"; lean 2, held at 60° for the first half and bent over
 * to level in the second, tilted the view at up to 100°/s at its knee). */
export const OPEN = { angle: 3, lean: 0 };
const CLIMB_STEPS = 256;

/*
 * A start that curves up: it leaves at the share s of the steepest angle it
 * reaches and curves up to that over the first CURVE.rise of its σ, leaning
 * into level as any climb does: (1 - smoothstep(v^lean)) (s + (1 - s)
 * smoothstep(v / rise)), scaled so its steepest is the shape's angle. From
 * the air, well above everything near, it leaves level, s 0 (Stage 5.8b,
 * his words: "check if in the start of the flight it can start with a more
 * curved approach (like the destination)"; until 5.11b the level start rose
 * over the first half of its σ and bent over to level in the second, as
 * sharply as it had risen); from the ground, at CURVE.start (5.10b, his
 * answer: rising in a curve, "leaves at a gentle angle and curves up into
 * the climb, like the landing"). plan.js chooses: `start` 1 is the plain
 * climb (its angle at once), 0 leaves level, CURVE.start curves up; a
 * flight set off climbing (a new place picked mid-flight, Stage 5.12b)
 * leaves at the share that sets off at the slope it climbs at.
 */
export const CURVE = { start: 0.42, rise: 0.3 };
const STARTS = [1, 0, CURVE.start];

export class Shape {
  constructor(angleIndex, leanIndex, start = 1) {
    this.angleIndex = angleIndex;
    this.leanIndex = leanIndex;
    this.start = start;
    this.level = start === 0;
    this.curved = start < 1;
    this.angle = ANGLES[angleIndex];
    this.lean = LEANS[leanIndex];
    this.peak = 1;
    if (this.curved) {
      let most = 0;
      for (let i = 0; i <= 1024; i++) most = Math.max(most, this.#rise(i / 1024));
      this.peak = most;
    }
    const q = (g) => 1 / Math.sqrt(Math.cos(g) ** 2 + (Math.sin(g) / PACE.zoom) ** 2);
    const rise = (v) => { const g = this.angleAt(v); return Math.sin(g) * q(g); };
    this.log = new Float64Array(CLIMB_STEPS + 1);
    this.flat = new Float64Array(CLIMB_STEPS + 1);
    this.tilt = new Float64Array(CLIMB_STEPS + 1);
    for (let i = 0; i <= CLIMB_STEPS; i++) {
      const v = i / CLIMB_STEPS, g = this.angleAt(v), h = 0.5 / CLIMB_STEPS;
      this.tilt[i] = (this.angleAt(v + h) - this.angleAt(v - h)) / (Math.min(1, v + h) - Math.max(0, v - h));
      this.flat[i] = Math.cos(g) * q(g);
      if (i > 0) {
        // Simpson over each step.
        const a = (i - 1) / CLIMB_STEPS, m = (a + v) / 2;
        this.log[i] = this.log[i - 1] + ((v - a) / 6) * (rise(a) + 4 * rise(m) + rise(v));
      }
    }
    // The climb's σ per unit of the log of the height it gains.
    this.perLog = 1 / this.log[CLIMB_STEPS];
  }

  /* The lean times the rise, unscaled. */
  #rise(x) {
    const s = this.start;
    return (1 - smoothstep(x ** this.lean)) * (s + (1 - s) * smoothstep(Math.min(1, x / CURVE.rise)));
  }

  /** The climb's angle with the horizontal at a share v of its σ. */
  angleAt(v) {
    const x = Math.max(0, Math.min(1, v));
    if (!this.curved) return this.angle * (1 - smoothstep(x ** this.lean));
    return (this.angle * this.#rise(x)) / this.peak;
  }

  /** The log of the height (above the ground, plus the offset) gained at a share v of its σ, per unit of σ. */
  logAt(v) { return readTable(this.log, v); }

  /**
   * The fastest its angle changes, radians a second, flown as a climb
   * `sigma` long at the start of a bell over `total` in T seconds (a
   * descent at its end is the same, mirrored).
   */
  tiltRate(sigma, total, T) {
    if (!(sigma > 0) || !(total > 0) || !(T > 0)) return 0;
    let most = 0;
    for (let i = 0; i <= CLIMB_STEPS; i += 2) {
      const r = Math.abs(this.tilt[i]) * bellRate(bellInverse(((i / CLIMB_STEPS) * sigma) / total));
      if (r > most) most = r;
    }
    return (most * total) / (T * sigma);
  }

  /** A steeper shape for clearing what is near: one gentler than the open
   * one (an end in the air) the next angle up, curved as it is; else leaving
   * at its angle at once (from a curved start), else the next angle (null at
   * 90°). */
  steeper() {
    if (this.angleIndex < OPEN.angle) return shape(this.angleIndex + 1, this.leanIndex, this.start);
    if (this.curved) return shape(this.angleIndex, this.leanIndex);
    return this.angleIndex + 1 < ANGLES.length ? shape(this.angleIndex + 1, this.leanIndex) : null;
  }

  /** A shape covering less ground: one gentler than the open one the next
   * angle up, curved as it is; else leaving at its angle at once (from a
   * curved start), else the next lean, then the next angle (null at the
   * last). */
  shorter() {
    if (this.angleIndex < OPEN.angle) return shape(this.angleIndex + 1, this.leanIndex, this.start);
    if (this.curved) return shape(this.angleIndex, this.leanIndex);
    if (this.leanIndex + 1 < LEANS.length) return shape(this.angleIndex, this.leanIndex + 1);
    return this.angleIndex + 1 < ANGLES.length ? shape(this.angleIndex + 1, this.leanIndex) : null;
  }
}

const readTable = (table, v) => {
  const f = Math.min(1, Math.max(0, v)) * CLIMB_STEPS, i = Math.min(CLIMB_STEPS - 1, Math.floor(f));
  return table[i] + (table[i + 1] - table[i]) * (f - i);
};

const SHAPES = new Map();
/** The shape with ANGLES[a] and LEANS[l], leaving at the share `start` of
 * its angle (1, 0 level, or CURVE.start, made once; true is level; any
 * other share, from 0 to 1, made each time: a flight set off climbing). */
export function shape(a = OPEN.angle, l = OPEN.lean, start = 1) {
  const share = start === true ? 0 : start === false ? 1 : start;
  const which = STARTS.indexOf(share);
  if (which < 0) {
    if (!(share >= 0 && share <= 1)) throw new Error(`a climb leaves at a share of its angle from 0 to 1, not ${share}`);
    return new Shape(a, l, share);
  }
  const key = a * 16 + l + which * 256;
  let s = SHAPES.get(key);
  if (!s) SHAPES.set(key, (s = new Shape(a, l, share)));
  return s;
}

/* ---- the design ---------------------------------------------------------------- */

/*
 * Steps of the velocity integral: coarse while scanning, fine for the one
 * kept; Newton's last steps for that one, and how close it must close
 * (metres, plus this share of the distance).
 */
const SCAN_STEPS = 32, SCAN_TOLERANCE = 1e-4, SCAN_HALVINGS = 18, FINAL_STEPS = 1024, NEWTON = 8, CLOSE = 1e-7;

/**
 * A flight's design on flat stand-in ground (see the top of the file): the
 * curves, the length of everything in σ, the bell's length, and where it
 * ends. Made by Design.solve; `sample(n)` lays it out.
 */
export class Design {
  /**
   * @param p { x0, y0, h0, x1, y1, h1 (the end heading), g0, g1 (the ground
   *          at both ends), a0, a1 (the heights there above it, plus the
   *          offset), cruise (metres), pace (heights a second at the peak),
   *          up, down (the climb's and the descent's Shape; the open one if
   *          not given) }
   */
  constructor(p) {
    Object.assign(this, p);
    this.up = p.up ?? shape();
    this.down = p.down ?? shape();
    // How far the end's heading is off the start's, -π..π (schedule).
    this.headingOff = Math.atan2(Math.sin(p.h1 - p.h0), Math.cos(p.h1 - p.h0));
    this.setCruise(p.cruise);
  }

  /* The climb and the descent for a cruise height, and tables of both
   * (horizontal metres per σ along each). */
  setCruise(cruise) {
    const off = PACE.offset, up = this.up, down = this.down;
    this.cruise = cruise;
    const hu = cruise - this.g0 + off, hd = cruise - this.g1 + off;
    this.sigmaUp = hu > this.a0 ? Math.log(hu / this.a0) * up.perLog : 0;
    this.sigmaDown = hd > this.a1 ? Math.log(hd / this.a1) * down.perLog : 0;
    this.upFlat ??= new Float64Array(CLIMB_STEPS + 1);
    this.downFlat ??= new Float64Array(CLIMB_STEPS + 1);
    for (let i = 0; i <= CLIMB_STEPS; i++) {
      this.upFlat[i] = this.a0 * Math.exp(this.sigmaUp * up.log[i]) * up.flat[i];
      this.downFlat[i] = this.a1 * Math.exp(this.sigmaDown * down.log[i]) * down.flat[i];
    }
  }

  /* Horizontal metres per unit of σ at σ = s of a design `total` long. */
  flat(s, total) {
    const su = this.sigmaUp, sd = this.sigmaDown;
    if (s < su) return readTable(this.upFlat, s / su);
    if (s > total - sd) return readTable(this.downFlat, (total - s) / sd);
    const w = (s - su) / Math.max(1e-12, total - su - sd);
    return this.cruise - (this.g0 + (this.g1 - this.g0) * w) + PACE.offset;
  }

  /* Height above the ground plus the offset at σ = s (the climb's shape), null on the cruise. */
  above(s, total) {
    const su = this.sigmaUp, sd = this.sigmaDown;
    if (s < su) return this.a0 * Math.exp(su * this.up.logAt(s / su));
    if (s > total - sd) return this.a1 * Math.exp(sd * this.down.logAt((total - s) / sd));
    return null;
  }

  /* Where the curves keep clear of, at either end: the share of the bell
   * before the first begins and after the second ends. A shape rising
   * straight up waits until it leans as far forward as the gentlest
   * vertical one does at startClimb (the flight is sampled evenly in σ, and
   * near its slow start a curve shaped in time would fall between too few
   * samples); one leaving at an angle turns from startAngled on. */
  #ends(total) {
    const at = (s) => (s.angle >= ANGLES[ANGLES.length - 1] ? TURN.startClimb ** (1 / s.lean) : TURN.startAngled);
    const startUp = at(this.up), startDown = at(this.down);
    return [Math.min(0.35, bellInverse((startUp * this.sigmaUp) / total)), Math.min(0.35, bellInverse((startDown * this.sigmaDown) / total))];
  }

  /**
   * The schedule for a first angle `a1`, the second turning the `s2` way
   * round, and a total σ, into `out`: { ok, a1, a2, T, and the S's turning
   * (sTurning) }. The bell is as long as the pace asks, or longer where the
   * turning would be too quick.
   */
  schedule(a1, s2, total, out) {
    const c = this.h0 + a1;
    let a2 = (this.h1 - c) % TWO_PI;
    if (a2 < 0) a2 += TWO_PI;
    if (s2 < 0 && a2 > 0) a2 -= TWO_PI;
    // Turning less first than the end's heading is off the start's, the
    // second curve turns the rest of that the short way (5.10b): the
    // scan's first angles, where an S that is all but straight is found (a
    // place a degree or two off straight ahead had no S the other way, and
    // flew one arc instead).
    const off = this.headingOff;
    if (s2 < 0 && off > 0 && a2 + TWO_PI <= off + 1e-9) a2 += TWO_PI;
    else if (s2 > 0 && off < 0 && a2 - TWO_PI >= off - 1e-9) a2 -= TWO_PI;
    out.a1 = a1;
    out.a2 = a2;
    out.ok = Math.abs(a2) <= TURN.max && Math.abs(a1) <= TURN.max + 1e-12 && total > 0;
    if (!out.ok) return out;
    const [e1, e2] = this.#ends(total);
    const span = sSpan(a1, a2, e1, e2, out);
    if (!Number.isFinite(span)) { out.ok = false; return out; }
    const T = Math.max((1.875 * total) / this.pace, DURATION.least, span * (1 + 1e-9));
    out.T = T;
    out.ok = sTurning(a1, a2, T, e1, e2, out);
    return out;
  }

  /** How fast the design turns at its time t (radians a second). */
  rateAt(t) { return sRate(this.k, t); }

  /** How fast that changes (radians a second squared). */
  accelAt(t) { return sAccel(this.k, t); }

  /* Where a schedule over σ `total` ends, relative to the start, into `out`, in `steps` midpoint steps. */
  travel(k, total, steps, out) {
    const T = k.T, dt = T / steps, h0 = this.h0;
    let x = 0, y = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * dt, u = t / T;
      const v = this.flat(total * bell(u), total) * (total / T) * bellRate(u) * dt;
      const h = h0 + sTurned(k, t);
      x += v * Math.sin(h);
      y += v * Math.cos(h);
    }
    out.x = x;
    out.y = y;
    return out;
  }

  /**
   * The quickest design from the start to the end with these shapes: scans
   * both S (right then left, left then right) and the first angle, then
   * closes the best exactly.
   * Returns a Design with { word, turn1, turn2, total, T } set, or null (the
   * climb and the descent alone carry it past the place, say).
   */
  static solve(p) {
    const d = new Design(p);
    const dx = p.x1 - p.x0, dy = p.y1 - p.y0, D = Math.hypot(dx, dy);
    const k = {}, at = { x: 0, y: 0 };
    const least = d.sigmaUp + d.sigmaDown;
    // The miss along and across the middle heading's line (the start's
    // heading plus the first angle) for a first angle, at a total σ.
    const miss = (a1, s2, total, steps, out) => {
      d.schedule(a1, s2, total, k);
      if (!k.ok) return null;
      d.travel(k, total, steps, at);
      const c = p.h0 + a1, sc = Math.sin(c), cc = Math.cos(c), rx = at.x - dx, ry = at.y - dy;
      out.along = rx * sc + ry * cc;
      out.across = rx * cc - ry * sc;
      out.T = k.T;
      return out;
    };
    // The total σ that leaves the end on the line through the place (the
    // miss along it zero), from a guess; null when even the least overshoots.
    const m = { along: 0, across: 0, T: 0 };
    const tol = SCAN_TOLERANCE * (1 + D);
    const fit = (a1, s2, guess, steps) => {
      // Bracketed from the guess (the last angle's): below it, the least
      // must not overshoot; above it, doubling until it does.
      let g = Math.max(least * 1.0001 + 1e-9, guess ?? least + D / Math.max(1, d.cruise - Math.max(p.g0, p.g1) + PACE.offset));
      const fg = miss(a1, s2, g, steps, m)?.along;
      if (fg == null) return null;
      if (Math.abs(fg) < tol) return g;
      let lo, flo, hi, fhi;
      if (fg > 0) {
        hi = g; fhi = fg; lo = least;
        flo = miss(a1, s2, lo, steps, m)?.along;
        if (flo == null || flo > 0) return null;
      } else {
        lo = g; flo = fg; hi = g * 1.5 + 1;
        fhi = miss(a1, s2, hi, steps, m)?.along;
        for (let it = 0; it < 40 && fhi != null && fhi < 0; it++) { lo = hi; flo = fhi; hi = hi * 2 + 1; fhi = miss(a1, s2, hi, steps, m)?.along; }
        if (fhi == null || fhi < 0) return null;
      }
      // Illinois (a safeguarded secant).
      let side = 0;
      for (let it = 0; it < 40; it++) {
        const s = (lo * fhi - hi * flo) / (fhi - flo);
        const fs = miss(a1, s2, s, steps, m)?.along;
        if (fs == null) return null;
        if (Math.abs(fs) < tol || hi - lo < 1e-12 * hi) return s;
        if (fs * fhi > 0) { hi = s; fhi = fs; if (side === -1) flo /= 2; side = -1; }
        else { lo = s; flo = fs; if (side === 1) fhi /= 2; side = 1; }
      }
      return (lo + hi) / 2;
    };
    const found = [];
    const steps = Math.ceil(TURN.max / TURN.step);
    const r = { along: 0, across: 0, T: 0 };
    let prev = { a1: 0, total: 0, across: 0, a2: 0, ok: false }, cur = { a1: 0, total: 0, across: 0, a2: 0, ok: false };
    const lo = { a1: 0, total: 0, across: 0, a2: 0 }, hi = { a1: 0, total: 0, across: 0, a2: 0 }, mid = { a1: 0, total: 0, across: 0, a2: 0 };
    const keep = (o, a1, total, across, a2) => { o.a1 = a1; o.total = total; o.across = across; o.a2 = a2; return o; };
    // Only an S: the second curve turns the other way round from the first
    // (Stage 5.8b, his words on 5.7b: "it is doing a circle to destination
    // sometimes instead of the smooth S!"; a place behind took a loop, RR or
    // LL, in 25 of 108 test trips, straying 89-137% of the distance off the
    // line; as an S, 13-36%).
    for (const s1 of [1, -1]) {
      {
        const s2 = -s1;
        const word = `${s1 > 0 ? 'R' : 'L'}${s2 > 0 ? 'R' : 'L'}`;
        let guess;
        prev.ok = false;
        for (let i = 0; i <= steps; i++) {
          const a1 = s1 * Math.min(TURN.max, i * TURN.step);
          const total = fit(a1, s2, guess, SCAN_STEPS);
          if (total == null || !miss(a1, s2, total, SCAN_STEPS, r)) { prev.ok = false; continue; }
          guess = total;
          keep(cur, a1, total, r.across, k.a2);
          cur.ok = true;
          if (prev.ok && (prev.across <= 0) !== (cur.across <= 0) && Math.abs(cur.a2 - prev.a2) < 1) {
            // Refine the angle by halves, the total σ fitted each time.
            keep(lo, prev.a1, prev.total, prev.across, prev.a2);
            keep(hi, cur.a1, cur.total, cur.across, cur.a2);
            for (let it = 0; it < SCAN_HALVINGS; it++) {
              const a = (lo.a1 + hi.a1) / 2, t = fit(a, s2, (lo.total + hi.total) / 2, SCAN_STEPS);
              if (t == null || !miss(a, s2, t, SCAN_STEPS, r)) break;
              keep(mid, a, t, r.across, k.a2);
              if ((mid.across <= 0) === (lo.across <= 0)) keep(lo, mid.a1, mid.total, mid.across, mid.a2);
              else keep(hi, mid.a1, mid.total, mid.across, mid.a2);
            }
            const best = Math.abs(lo.across) < Math.abs(hi.across) ? lo : hi;
            if (miss(best.a1, s2, best.total, SCAN_STEPS, r)) found.push({ word, s2, a1: best.a1, total: best.total, T: r.T });
          }
          const swap = prev; prev = cur; cur = swap;
        }
      }
    }
    if (!found.length) return null;
    found.sort((a, b) => a.T - b.T);
    // The quickest that closes with the fine integral (the coarse one is a
    // little off): Newton on the first angle and the total σ.
    for (const f of found) {
      const done = Design.#close(d, f, miss, D);
      if (done) return done;
    }
    return null;
  }

  static #close(d, f, miss, D) {
    let a1 = f.a1, total = f.total;
    const m = { along: 0, across: 0, T: 0 }, ma = { along: 0, across: 0, T: 0 }, mt = { along: 0, across: 0, T: 0 };
    for (let it = 0; it < NEWTON; it++) {
      if (!miss(a1, f.s2, total, FINAL_STEPS, m)) return null;
      if (Math.hypot(m.along, m.across) < CLOSE * (1 + D)) break;
      const da = 1e-6, dt = 1e-6 * Math.max(1, total);
      if (!miss(a1 + da, f.s2, total, FINAL_STEPS, ma) || !miss(a1, f.s2, total + dt, FINAL_STEPS, mt)) return null;
      // Jacobian of (along, across) in (a1, total).
      const j11 = (ma.along - m.along) / da, j12 = (mt.along - m.along) / dt;
      const j21 = (ma.across - m.across) / da, j22 = (mt.across - m.across) / dt;
      const det = j11 * j22 - j12 * j21;
      if (!(Math.abs(det) > 1e-18)) return null;
      const stepA = (m.along * j22 - m.across * j12) / det, stepT = (m.across * j11 - m.along * j21) / det;
      a1 -= Math.max(-0.2, Math.min(0.2, stepA));
      total = Math.max(d.sigmaUp + d.sigmaDown, total - stepT);
    }
    if (!miss(a1, f.s2, total, FINAL_STEPS, m) || Math.hypot(m.along, m.across) > 1e-3 * (1 + D)) return null;
    d.word = f.word;
    d.s2 = f.s2;
    d.total = total;
    d.schedule(a1, f.s2, total, d.k = {});
    d.turn1 = d.k.a1;
    d.turn2 = d.k.a2;
    d.T = d.k.T;
    return d;
  }

  /**
   * The design laid out at `n` instants evenly in time: position (closing
   * exactly on the end: the last bit of miss spread along the way),
   * horizontal distance along, heading, curvature (radians a metre), σ, the
   * height above the ground plus the offset where it climbs or descends (0
   * on the cruise, `climbing` 0 there), and the piece: 0 climbing before the
   * first curve, 1 in it (up to the middle), 3 in the second, 4 after.
   */
  sample(n) {
    const T = this.T, total = this.total, k = this.k, dt = T / (n - 1);
    const t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n), s = new Float64Array(n);
    const sigma = new Float64Array(n), heading = new Float64Array(n), curvature = new Float64Array(n);
    const above = new Float64Array(n), climbing = new Uint8Array(n), piece = new Int8Array(n);
    let px = this.x0, py = this.y0, along = 0;
    const SUB = 4;
    for (let i = 0; i < n; i++) {
      const ti = i * dt;
      if (i > 0) {
        for (let j = 0; j < SUB; j++) {
          const tm = (i - 1 + (j + 0.5) / SUB) * dt, u = tm / T;
          const v = this.flat(total * bell(u), total) * (total / T) * bellRate(u) * (dt / SUB);
          const h = this.h0 + sTurned(k, tm);
          px += v * Math.sin(h);
          py += v * Math.cos(h);
          along += v;
        }
      }
      const u = ti / T, sg = total * bell(u);
      t[i] = ti; x[i] = px; y[i] = py; s[i] = along; sigma[i] = sg;
      heading[i] = this.h0 + sTurned(k, ti);
      // Curvature: the rate of turn over the horizontal speed.
      const rate = this.rateAt(ti);
      const speed = this.flat(sg, total) * (total / T) * bellRate(u);
      curvature[i] = speed > 1e-9 ? rate / speed : 0;
      const a = this.above(sg, total);
      above[i] = a ?? 0;
      climbing[i] = a == null ? 0 : sg < this.sigmaUp ? 1 : 2;
      piece[i] = ti < k.t1 ? 0 : ti < k.mid ? 1 : ti < k.tEnd ? 3 : 4;
    }
    const ex = this.x1 - x[n - 1], ey = this.y1 - y[n - 1];
    if (along > 0) for (let i = 0; i < n; i++) { x[i] += (ex * s[i]) / along; y[i] += (ey * s[i]) / along; }
    x[n - 1] = this.x1; y[n - 1] = this.y1;
    return { n, t, x, y, s, sigma, heading, curvature, above, climbing, piece, closure: Math.hypot(ex, ey) };
  }
}
