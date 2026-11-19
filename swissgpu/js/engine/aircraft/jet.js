/* jet.js — a fighter jet, flown (Stage 5.9b, his words: "add an airplane
 * mode with "P" as toggle, where if you press it you automatically go
 * forward, you adjust speed with scroll wheel (realistic speed increase, not
 * extreme, max mach 2 maybe?). A leans left and curves left like an airplne
 * does, D = A but to the right, S pitches up while W down. make it so it can
 * also glide when velocity is too low. make it really realistic"; his answer:
 * the wings level themselves when A and D are let go).
 *
 * The airframe and engine are an F-16's, as far as public numbers go (NASA
 * TP-1538 and Stevens & Lewis's model of it; Raymer's transonic drag rise,
 * as AeroSandbox's approximate_CD_wave has it): 12 t, 27.9 m² of wing; lift
 * linear to 15° and leaning off to its peak, 1.5, at 25° (the stall),
 * steeper near Mach 0.9 and flatter beyond Mach 1; past the peak it falls,
 * to half by 35° and to none at 90°, and the drag rises as a flat plate's
 * does; drag from the zero-lift drag, rising through Mach 1 to 1.23 times
 * its supersonic value at Mach 1.1, plus the induced drag; thrust 129 kN
 * with afterburner and 76 kN without at sea level, both falling with the
 * air's density (to the 0.65 and 0.75 power) and changing with the Mach
 * number; 6% of it at idle, none with the engine off. Measured with this
 * model: top speed 1,580 km/h (Mach 1.29) at sea level, Mach 2.0 at 11 km,
 * Mach 1.0 without afterburner; it stalls at about 245 km/h level at sea
 * level; with the engine off it glides 10.7 to 1 at its best, about 5.3°
 * down at 490 km/h, sinking 12.5 m/s; from 300 to 900 km/h in 17 s at sea
 * level; climbs 170 m/s; turns at 7.7 g sustained at 800 km/h. The wing can
 * be made stronger (`wing`: its lift times that, Settings → Vehicles →
 * Airplane, Easy: 1.5, and `gMax`: 12 g there).
 *
 * It flies as a point mass along its velocity, pulled by lift, drag, thrust
 * and gravity, and pointed by a fly-by-wire (as the real one is, the pilot
 * never moves the control surfaces directly):
 *   pitch   the stick asks for its share of the load the wing can give
 *           here, on top of what holds the flight path where it is, wings
 *           banked or not (up to 60° of bank, then less, so a knife edge
 *           falls): let go, it holds the climb or the dive; full stick back,
 *           the most the wing lifts at its peak (the thrust's own lift with
 *           it), within +9 (gMax) and -3 g; full forward, the least it lifts
 *           at its lowest angle. So it pulls round as physics has it: slow,
 *           the wing's lift limits the turn, which quickens with the speed
 *           (lift grows as its square) up to where the structure's limit is
 *           reached, the corner speed (about 750 km/h: as built 8.2 g there,
 *           22°/s in a level turn; the stronger wing 11.7 g, 31°/s), beyond
 *           which the g limit holds it and the turn widens again, as
 *           an F-16's does (about 10°/s at 280 km/h, 20°/s at 650-780 km/h,
 *           18°/s at 830 km/h, in its own charts). Until Stage 5.13b the
 *           stick asked for a pitch rate, 35°/s at full, which those two
 *           limits cut short at every speed, so a full pull turned as it
 *           does now; the stick between asked for the same rate at any speed
 *           (his words on 5.12b: "it also does not turn quicker when turning
 *           at high speed (...physics...)", answered by the roll below, the
 *           engine as built, which lets a hard turn bleed its speed towards
 *           the corner speed, and this).
 *           The stick never pulls the wing past its peak; the wing's angle
 *           follows within a tenth of a second (the short period, as the
 *           fly-by-wire damps it).
 *   stall   too slow to hold the path even at the wing's peak (Stage 5.11b,
 *           his answer: "realistic, so if user doesn't manouvre to glide, it
 *           stalls, if user does things correctly, it glides"; until then it
 *           sank slowly at the peak, mushing along): the wing stalls. The
 *           nose drops (to stall.break) and the jet falls until it has the
 *           speed to fly again, then holds the path it is on (a dive: pull
 *           out gently, or it stalls again); the stick held back keeps it
 *           stalled, deep (stall.deep), falling with the nose high; pushed,
 *           it flies again sooner. Lowering the nose before it is too slow
 *           keeps it gliding.
 *   roll    A and D ask for a roll rate in proportion to the speed (Stage
 *           5.13b, his words above: full aileron turns the wing tips along a
 *           helix of the same pitch at any speed, pb/2V, so the rate grows
 *           with the speed): the Jet's `rollRate` at JET.rollSpeed (600
 *           km/h), at most JET.rollMost (the F-16's flight computer asks for
 *           324°/s at the most, about 225°/s flown); let go, the wings roll
 *           back level (his answer), unless the stick is pulled or pushed (a
 *           turn held, a loop flown: the wings stay as they are) or the nose
 *           points near straight up or down. Rolls in about an eighth of a
 *           second's lag.
 *   yaw     coordinated: never any sideslip (the real one's rudder does it).
 *   engine  the scroll wheel sets either the speed asked or the throttle
 *           (`manual`, Stage 5.13b, his answer: "depends, make it a
 *           setting"). The speed asked: an autothrottle gives the thrust that
 *           speed needs, from idle through full dry thrust to full
 *           afterburner, the throttle moved at most JET.throttleRate a
 *           second; nothing asked, the engine is off (Stage 5.11b: until
 *           then it idled, which at the quick engine's power was 9% of the
 *           F-16's full dry thrust). The throttle (`lever`, 0 idle, 0.75 full
 *           dry thrust, 1 full afterburner): the engine gives what the lever
 *           says, and the speed is whatever thrust, drag and gravity make
 *           it. Either way the engine spools up and down over a second or
 *           so.
 *   brake   the speed brake (with the autothrottle, the throttle at idle).
 *           With `autoBrake` the autothrottle opens it itself to slow down,
 *           and with the engine off down to the least flying speed, JET.least
 *           times the stall speed; there it closes, and stays closed until
 *           the engine is on again.
 * The velocity and the lift's direction are vectors in the local east,
 * north, up frame, carried over the curve of the earth as it flies, so loops
 * and vertical climbs have no singular attitude. On the ground it rolls on
 * its wheels (plane.js says when it touches).
 */

import { air } from './atmosphere.js';

const DEG = Math.PI / 180;
export const G = 9.80665;
const EARTH = 6371000;

/* A table: linear between the points, flat beyond them. */
function table(xs, ys) {
  return (x) => {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) return ys[i - 1] + ((ys[i] - ys[i - 1]) * (x - xs[i - 1])) / (xs[i] - xs[i - 1]);
    }
    return ys[ys.length - 1];
  };
}

export const JET = {
  mass: 12000,                     // kg
  wing: 27.87,                     // m²
  liftSlope: 4.0,                  // CL per radian, low speed, up to `linear`
  linear: 15 * DEG,
  liftMax: 1.5,                    // the peak, at alphaMax (Stevens & Lewis's F-16 tables: a normal force of 1.65 at 25°)
  alphaMax: 25 * DEG,              // the stall's angle
  alphaMin: -10 * DEG,
  // Past the peak: the lift falls to `half` of it by `drop` beyond, then to
  // none at 90°; the drag rises by `plate` times the growth of the angle's
  // sine squared (a flat plate's normal force, 1.85 at 90°: Hoerner). The
  // stall (see the top of the file): the nose drops to `break`, held back
  // it stays at `deep`, pushed it comes down to `push`; it flies again under
  // the peak by `margin`, at `fly` times the speed it stalls at for the load
  // that holds the path.
  stall: { drop: 10 * DEG, half: 0.5, plate: 1.85, break: 12 * DEG, deep: 40 * DEG, push: 3 * DEG, margin: 3 * DEG, fly: 1.1 },
  least: 1.3,                      // the least flying speed, times the stall speed (the engine-off brake's floor)
  machLift: table([0, 0.6, 0.9, 1.05, 1.3, 2.0, 2.5], [1, 1.04, 1.15, 1.05, 0.85, 0.62, 0.55]),
  drag0: table([0, 0.82, 0.95, 1.05, 1.1, 1.2, 1.5, 2.0, 2.5], [0.0175, 0.0175, 0.026, 0.0455, 0.0501, 0.044, 0.041, 0.0387, 0.0385]),
  induced: table([0, 0.85, 1.2, 2.0], [0.124, 0.124, 0.2, 0.32]),
  brakeDrag: 0.06,                 // the speed brake, as built (times the Jet's `brakes`)
  afterburner: (h, M, ratio) => 129000 * ratio ** 0.65 * (1 + 0.06 * M + 0.02 * M * M),
  military: (h, M, ratio) => 76000 * ratio ** 0.75 * (1 - 0.1 * M),
  idle: 0.06,                      // of military thrust
  spoolUp: 1.2, spoolDown: 0.8,    // seconds, the engine's lag
  throttleRate: 1.5,               // the autothrottle's hand, a second
  holdTime: 2,                     // seconds the autothrottle takes to close a speed error
  autoBrake: 15 / 3.6,             // with the Jet's `autoBrake`: the speed brake out this far over the speed asked
  gMax: 9, gMin: -3,
  pathHold: 0.6,                   // a second: how firmly a let-go stick holds the path angle
  alphaLag: 0.07,
  rollRate: 90 * DEG,              // at full roll at rollSpeed (the Jet's `rollRate`; the real one 180°/s and more)
  rollSpeed: 600 / 3.6,            // m/s: where the roll rate is the Jet's `rollRate`; in proportion to the speed
  rollMost: 240 * DEG,             // the most it rolls, however fast
  rollLag: 0.12,
  level: { rate: 2, most: 60 * DEG, vertical: 75 * DEG },   // wings back to level: per second, at most, not above this path angle
  // On the wheels: rolling and braking friction, nose wheel steering (the
  // tightest radius, and the most turn rate it gives), and the most the
  // nose comes up before the tail touches.
  ground: { rolling: 0.02, braking: 0.45, radius: 12, steer: 12 * DEG, rotation: 12 * DEG },
};

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Lift coefficient at angle of attack `a` and Mach `M`, the wing's lift times `k`. */
export function liftAt(a, M, k = 1) {
  const J = JET, S = J.stall, f = J.machLift(M) * k;
  const lin = J.liftSlope * J.linear;
  let cl;
  if (a <= J.linear) cl = J.liftSlope * a;
  else if (a <= J.alphaMax) cl = lin + ((J.liftMax - lin) * (a - J.linear)) / (J.alphaMax - J.linear);
  else if (a <= J.alphaMax + S.drop) cl = J.liftMax * (1 - (1 - S.half) * smoothstep((a - J.alphaMax) / S.drop));
  else cl = J.liftMax * S.half * Math.cos(((Math.min(a, Math.PI / 2) - J.alphaMax - S.drop) * (Math.PI / 2)) / (Math.PI / 2 - J.alphaMax - S.drop));
  return cl * f;
}

/** The angle of attack that gives lift coefficient `cl` at Mach `M` (liftAt's inverse up to the peak, within the limits). */
export function alphaFor(cl, M, k = 1) {
  const J = JET, c = cl / (J.machLift(M) * k), lin = J.liftSlope * J.linear;
  const a = c <= lin ? c / J.liftSlope : J.linear + ((c - lin) * (J.alphaMax - J.linear)) / (J.liftMax - lin);
  return Math.max(J.alphaMin, Math.min(J.alphaMax, a));
}

/** Drag coefficient at angle of attack `a` with lift coefficient `cl` (from liftAt) and Mach `M`, the wing's lift times `k`. */
export function dragAt(a, cl, M, k = 1) {
  const J = JET, i = J.induced(M);
  if (a <= J.alphaMax) return J.drag0(M) + i * cl * cl;
  const peak = J.liftMax * J.machLift(M) * k, s = Math.sin(Math.min(a, Math.PI / 2)), s0 = Math.sin(J.alphaMax);
  return J.drag0(M) + i * peak * peak + J.stall.plate * (s * s - s0 * s0);
}

/** The speed at which the wing's peak holds `load` g at `density` and Mach `M` (the stall speed, 1 g). */
export function stallSpeed(density, M, k = 1, load = 1) {
  return Math.sqrt((2 * load * JET.mass * G) / (density * JET.wing * liftAt(JET.alphaMax, M, k)));
}

/* Thrust at a throttle position: 0 idle, up to 0.75 full dry thrust, up to 1
 * full afterburner; `power` times the F-16's engine (running: off, none). */
function thrustAt(throttle, h, M, ratio, power = 1) {
  const mil = power * JET.military(h, M, ratio), idle = JET.idle * mil;
  if (throttle <= 0.75) return idle + ((mil - idle) * throttle) / 0.75;
  return mil + ((power * JET.afterburner(h, M, ratio) - mil) * (throttle - 0.75)) / 0.25;
}

/* The throttle position for a thrust (thrustAt's inverse, 0..1). */
function throttleFor(thrust, h, M, ratio, power = 1) {
  const mil = power * JET.military(h, M, ratio), idle = JET.idle * mil, ab = power * JET.afterburner(h, M, ratio);
  if (thrust <= idle) return 0;
  if (thrust <= mil) return (0.75 * (thrust - idle)) / (mil - idle);
  return Math.min(1, 0.75 + (0.25 * (thrust - mil)) / (ab - mil));
}

/* A vector of the local east, north, up frame carried into the next one
 * (transport): the frame tilts by tE, tN radians (the old horizontal gains a
 * little of the new up) and north turns (cos c, sin s: azimuths a little less). */
function carry(w, tE, tN, c, s) {
  const e = w[0], n = w[1], u = w[2];
  const e1 = e - u * tE, n1 = n - u * tN;
  w[0] = e1 * c + n1 * s;
  w[1] = -e1 * s + n1 * c;
  w[2] = u + e * tE + n * tN;
}

export class Jet {
  constructor() {
    this.v = new Float64Array(3);        // velocity, m/s, east north up
    this.lift = new Float64Array([0, 0, 1]);   // the lift's direction: across the velocity, the wings' up
    this.alpha = 0;
    this.roll = 0;                       // roll rate, rad/s, positive right
    this.thrust = 0;
    this.throttle = 0;
    this.target = 0;                     // the speed asked, m/s (0: idle)
    this.load = 1;                       // g along the lift
    this.onGround = false;
    this.air = {};
    this.mach = 0;
    this.braking = false;
    this.forward = new Float64Array([0, 1, 0]);   // the nose, east north up
    this.up = new Float64Array([0, 0, 1]);        // the cockpit's up
    this.heading = 0;                    // on the wheels: the way it points, an azimuth
    this.pathRef = null;                 // the path angle a let-go stick holds
    this.stalled = false;                // the wing stalled (see the top of the file)
    this.brakeArmed = true;              // with the engine off, the autothrottle may still open the speed brake
    // How it is set up (tune): the engine's and the speed brake's strength
    // against the F-16's, the roll and pitch rates at full stick, whether
    // the autothrottle opens the speed brake to slow down, the wing's lift
    // against the F-16's and the most load it takes.
    this.power = 1;
    this.brakes = 1;
    this.rollRate = JET.rollRate;
    this.autoBrake = false;
    // The scroll wheel's: the speed asked (the autothrottle flies it) or the
    // throttle lever itself (`manual`, the lever 0 idle .. 1 full afterburner).
    this.manual = false;
    this.lever = 0;
    this.wingLift = 1;
    this.gMax = JET.gMax;
  }

  /** Sets any of { power, brakes, rollRate, autoBrake, wing, gMax, throttleMode } (assignments only: called every step). */
  tune(o) {
    if (o.power != null) this.power = o.power;
    if (o.brakes != null) this.brakes = o.brakes;
    if (o.rollRate != null) this.rollRate = o.rollRate;
    if (o.autoBrake != null) this.autoBrake = o.autoBrake;
    if (o.throttleMode != null) this.#setManual(o.throttleMode === 'throttle');
    if (o.wing != null) this.wingLift = o.wing;
    if (o.gMax != null) this.gMax = o.gMax;
  }

  /* The scroll wheel's job changed: the lever where the autothrottle had the
   * throttle, or the speed asked as fast as it goes now (on the wheels,
   * standing, nothing: the engine off). */
  #setManual(on) {
    if (on === this.manual) return;
    this.manual = on;
    if (on) this.lever = this.throttle;
    else this.target = this.speed > 1 ? this.speed : 0;
  }

  /** The speed it stalls at in level flight, here (m/s). */
  stallSpeed(height) {
    const a = air(height, this.air);
    return stallSpeed(a.density, this.speed / a.sound, this.wingLift);
  }

  get speed() { const v = this.v; return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
  /** The flight path's angle with the horizontal, radians. */
  get pathAngle() { const s = this.speed; return s > 1e-6 ? Math.asin(Math.max(-1, Math.min(1, this.v[2] / s))) : 0; }
  /** Which way it goes, an azimuth. */
  get track() { return Math.atan2(this.v[0], this.v[1]); }
  get afterburning() { return this.throttle > 0.75 + 1e-3; }

  /**
   * Flying (or standing) as given: `speed` m/s along `heading`, its path
   * `pitch` radians up, wings level, the speed asked kept; on the wheels
   * when `onGround`.
   */
  reset({ speed = 0, heading = 0, pitch = 0, onGround = false, target = speed, height = 0 }) {
    const ch = Math.cos(pitch);
    const dir = [Math.sin(heading) * ch, Math.cos(heading) * ch, Math.sin(pitch)];
    for (let i = 0; i < 3; i++) this.v[i] = dir[i] * Math.max(0, speed);
    // Level wings: the lift across the way it goes, in the vertical plane.
    const up = [-dir[0] * dir[2], -dir[1] * dir[2], 1 - dir[2] * dir[2]];
    const n = Math.hypot(up[0], up[1], up[2]) || 1;
    for (let i = 0; i < 3; i++) this.lift[i] = up[i] / n;
    this.heading = heading;
    this.alpha = 0;
    this.roll = 0;
    this.onGround = onGround;
    this.target = target;
    this.load = 1;
    this.pathRef = pitch;
    this.stalled = false;
    this.brakeArmed = true;
    // The engine as level flight at that speed needs it, at once (not
    // spooling up from idle in the air), the lever there too; idle on the
    // ground, off with nothing asked (the speed asked) or the lever at idle
    // (the throttle).
    const a = air(height, this.air), M = speed / a.sound, q = 0.5 * a.density * speed * speed;
    let level = 0;
    if (!onGround && q > 1) {
      const cl = (JET.mass * G) / (q * JET.wing);
      this.alpha = alphaFor(cl, M, this.wingLift);
      const drag = q * JET.wing * (JET.drag0(M) + JET.induced(M) * cl * cl);
      level = throttleFor(drag + JET.mass * G * Math.sin(pitch), height, M, a.ratio, this.power);
    }
    this.lever = level;
    const running = this.manual || target > 0;
    this.throttle = running ? level : 0;
    this.thrust = running ? thrustAt(this.throttle, height, M, a.ratio, this.power) : 0;
    this.mach = M;
    this.#attitude();
  }

  /** The bank: the lift's lean from the vertical plane through the way it goes, radians, positive right. */
  get bank() {
    const v = this.v, s = this.speed;
    if (!(s > 1e-6)) return 0;
    const f0 = v[0] / s, f1 = v[1] / s, f2 = v[2] / s;
    let u0 = -f0 * f2, u1 = -f1 * f2, u2 = 1 - f2 * f2;
    const n = Math.sqrt(u0 * u0 + u1 * u1 + u2 * u2);
    if (n < 1e-6) return 0;
    u0 /= n; u1 /= n; u2 /= n;
    // right = forward × up
    const r0 = f1 * u2 - f2 * u1, r1 = f2 * u0 - f0 * u2, r2 = f0 * u1 - f1 * u0;
    const l = this.lift;
    return Math.atan2(l[0] * r0 + l[1] * r1 + l[2] * r2, l[0] * u0 + l[1] * u1 + l[2] * u2);
  }

  /**
   * One step in the air: `controls` { pitch (-1 push .. 1 pull), roll (-1
   * left .. 1 right, 0 let go), brake, level (false: a let-go roll holds the
   * bank, as a real fly-by-wire does) }, `height` metres above sea level.
   * Moves nothing: returns the step's way, metres east, north and up, in
   * `out` (plane.js moves the camera, and checks what it hits).
   */
  step(dt, controls, height, out) {
    const J = JET, m = J.mass, v = this.v, l = this.lift;
    const a = air(height, this.air);
    const V = Math.max(1e-3, this.speed);
    const M = V / a.sound;
    this.mach = M;
    const q = 0.5 * a.density * V * V;
    const fx = v[0] / V, fy = v[1] / V, fz = v[2] / V;
    const gamma = Math.asin(Math.max(-1, Math.min(1, fz)));
    const k = this.wingLift, S = J.stall;
    // The speed brake: asked for, or opened by the autothrottle (with
    // `autoBrake`; the throttle idles then) to slow down well over the speed
    // asked, or with the engine off down to the least flying speed, where it
    // closes until the engine is on again.
    let auto = false;
    if (this.manual) this.brakeArmed = true;
    else if (this.autoBrake && this.target > 0) {
      auto = V > this.target + J.autoBrake;
      this.brakeArmed = true;
    } else if (this.autoBrake) {
      if (V <= J.least * stallSpeed(a.density, M, k)) this.brakeArmed = false;
      auto = this.brakeArmed;
    }
    this.braking = Boolean(controls.brake) || auto;

    // Pitch: the load that holds the path (smoothly less beyond 60° of
    // bank, through none at a knife edge), plus what the stick asks for;
    // let go, the path angle it had then is held (a gentle correction back
    // to it, JET.pathHold a second). Stalled, the path is held from wherever
    // it is once it flies again.
    const bank = this.bank, cb = Math.cos(bank), stick = controls.pitch, held = Math.abs(stick) > 0.01;
    if (held || this.pathRef == null || this.stalled) this.pathRef = gamma;
    const back = held ? 0 : (J.pathHold * (this.pathRef - gamma) * V) / G;
    const need = Math.cos(gamma) * (Math.abs(cb) >= 0.5 ? 1 / cb : 4 * cb);
    const hold = need + back * Math.max(0, cb);
    // The stick's share of the way from holding the path to the most (or
    // the least) the wing gives here, the thrust's own lift with it, within
    // the structure's limits (see the top of the file: the turn quickens
    // with the speed up to the corner speed).
    const T0 = this.thrust, qS = q * J.wing;
    const most = Math.min(this.gMax, (qS * liftAt(J.alphaMax, M, k) + T0 * Math.sin(J.alphaMax)) / (m * G));
    const least = Math.max(J.gMin, (qS * liftAt(J.alphaMin, M, k) + T0 * Math.sin(J.alphaMin)) / (m * G));
    const pull = stick >= 0 ? stick * Math.max(0, most - hold) : stick * Math.max(0, hold - least);
    const want = Math.max(J.gMin, Math.min(this.gMax, hold + pull));
    // The stall (see the top of the file): too slow to hold the path even at
    // the wing's peak, the thrust's own lift added; flying again under the
    // peak by the margin, at stall.fly times the speed that holds the path
    // at the peak.
    if (this.stalled) {
      if (this.alpha < J.alphaMax - S.margin && V >= S.fly * stallSpeed(a.density, M, k, Math.max(0, need))) this.stalled = false;
    } else if (q > 1 && hold * m * G > q * J.wing * liftAt(J.alphaMax, M, k) + T0 * Math.sin(J.alphaMax)) {
      this.stalled = true;
    }
    // The angle of attack: for that load, the thrust's own lift taken off
    // (the stick never pulls the wing past its peak); stalled, the nose
    // down to the break, or held back deep, or pushed lower.
    let alphaWant;
    if (this.stalled) alphaWant = stick >= 0 ? S.break + (S.deep - S.break) * stick : S.break + (S.break - S.push) * stick;
    else alphaWant = q > 1 ? alphaFor((want * m * G - T0 * Math.sin(this.alpha)) / (q * J.wing), M, k) : J.alphaMax * Math.sign(want);
    this.alpha += (alphaWant - this.alpha) * (1 - Math.exp(-dt / J.alphaLag));
    const cl = liftAt(this.alpha, M, k);
    let L = q * J.wing * cl;
    // The structure's limits: never more load than the fly-by-wire allows.
    L = Math.max(J.gMin * m * G, Math.min(this.gMax * m * G, L));
    const cd = dragAt(this.alpha, cl, M, k) + (this.braking ? J.brakeDrag * this.brakes : 0);
    const D = q * J.wing * cd;

    // Roll: a rate asked for, in proportion to the speed (see the top of the
    // file), or the wings back to level, followed with a lag.
    const authority = Math.min(J.rollMost, (this.rollRate * V) / J.rollSpeed);
    // Let go (and not pulling or pushing: over the top of a loop the wings
    // stay as the loop has them), the wings come back level.
    let rollWant;
    if (controls.roll !== 0) rollWant = controls.roll * authority;
    else if (controls.level !== false && Math.abs(controls.pitch) < 0.05 && Math.abs(gamma) < J.level.vertical) {
      rollWant = Math.max(-J.level.most, Math.min(J.level.most, -J.level.rate * bank));
    } else rollWant = 0;
    this.roll += (rollWant - this.roll) * (1 - Math.exp(-dt / J.rollLag));

    // The engine: the lever's thrust (the throttle), or the thrust the asked
    // speed needs, the autothrottle moving the throttle towards it; the
    // engine following.
    const sinG = fz;
    let throttleWant;
    if (this.manual) throttleWant = this.lever;
    else if (this.braking || this.target <= 0) throttleWant = 0;
    else {
      const thrustNeed = D + m * G * sinG + (m * (this.target - V)) / J.holdTime;
      throttleWant = throttleFor(thrustNeed, height, M, a.ratio, this.power);
    }
    const step = this.manual ? 1 : J.throttleRate * dt;
    this.throttle += Math.max(-step, Math.min(step, throttleWant - this.throttle));
    // Nothing asked of the autothrottle: the engine is off, and runs down to nothing.
    const thrustWant = this.manual || this.target > 0 ? thrustAt(this.throttle, height, M, a.ratio, this.power) : 0;
    const lag = thrustWant > this.thrust ? J.spoolUp : J.spoolDown;
    this.thrust += (thrustWant - this.thrust) * (1 - Math.exp(-dt / lag));

    // Forces: thrust along the nose (the velocity turned up by alpha in the
    // wings' plane), lift across, drag back, gravity down.
    const ca = Math.cos(this.alpha), sa = Math.sin(this.alpha), T = this.thrust;
    const along = T * ca - D, across = L + T * sa;
    const ax = (along * fx + across * l[0]) / m;
    const ay = (along * fy + across * l[1]) / m;
    const az = (along * fz + across * l[2]) / m - G;
    this.load = across / (m * G);
    v[0] += ax * dt;
    v[1] += ay * dt;
    v[2] += az * dt;
    // The lift's direction: across the new velocity (Gram-Schmidt), rolled about it.
    this.#across();
    this.#rollBy(this.roll * dt);
    this.#attitude();
    out.east = v[0] * dt;
    out.north = v[1] * dt;
    out.up = v[2] * dt;
    return out;
  }

  /**
   * One step on the wheels, on ground sloping `slope` (rise per metre along
   * the way it rolls): rolling and braking friction, nose wheel steering
   * with `controls.roll`, the nose raised with the stick for the take-off,
   * the engine as in the air. Returns the way in `out`, and whether it lifted off.
   */
  stepGround(dt, controls, height, slope, out) {
    const J = JET, m = J.mass, v = this.v;
    const a = air(height, this.air);
    let V = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    const M = V / a.sound;
    this.mach = M;
    const q = 0.5 * a.density * V * V;
    this.braking = Boolean(controls.brake);
    this.stalled = false;
    // The nose up (to the tail's limit) while the stick is pulled, down when let go.
    const nose = controls.pitch > 0 ? J.ground.rotation * controls.pitch : 0;
    this.alpha += (nose - this.alpha) * (1 - Math.exp(-dt / 0.6));
    const cl = liftAt(this.alpha, M, this.wingLift), L = q * J.wing * cl;
    const D = q * J.wing * (J.drag0(M) + J.induced(M) * cl * cl + (this.braking ? J.brakeDrag * this.brakes : 0));
    const cosS = 1 / Math.sqrt(1 + slope * slope), sinS = slope * cosS;
    // The engine.
    let throttleWant = 0;
    if (this.manual) throttleWant = this.lever;
    else if (!this.braking && this.target > 0) {
      const need = D + m * G * sinS + (m * (this.target - V)) / J.holdTime + J.ground.rolling * m * G;
      throttleWant = throttleFor(need, height, M, a.ratio, this.power);
    }
    const step = this.manual ? 1 : J.throttleRate * dt;
    this.throttle += Math.max(-step, Math.min(step, throttleWant - this.throttle));
    const thrustWant = this.manual || this.target > 0 ? thrustAt(this.throttle, height, M, a.ratio, this.power) : 0;
    this.thrust += (thrustWant - this.thrust) * (1 - Math.exp(-dt / (thrustWant > this.thrust ? J.spoolUp : J.spoolDown)));
    const T = this.thrust;
    const normal = Math.max(0, m * G * cosS - L - T * Math.sin(this.alpha));
    const friction = (this.braking ? J.ground.braking : J.ground.rolling) * normal;
    // Along the way it points.
    let accel = (T * Math.cos(this.alpha) - D - m * G * sinS) / m;
    const stop = friction / m;
    if (V > 0.05) accel -= stop;
    else accel = Math.max(0, accel - stop);
    V = Math.max(0, V + accel * dt);
    // Steering: the nose wheel's radius at walking speeds, a rate limit above.
    if (controls.roll !== 0 && V > 0.05) this.heading += controls.roll * Math.min(V / J.ground.radius, J.ground.steer) * dt;
    const s = Math.sin(this.heading), c = Math.cos(this.heading);
    v[0] = V * s * cosS;
    v[1] = V * c * cosS;
    v[2] = V * sinS;
    this.roll = 0;
    this.load = (L + T * Math.sin(this.alpha)) / (m * G * cosS);
    // Wings level, the lift up across the way it rolls.
    this.lift[0] = -s * sinS; this.lift[1] = -c * sinS; this.lift[2] = cosS;
    this.#attitude();
    out.east = v[0] * dt;
    out.north = v[1] * dt;
    out.up = v[2] * dt;
    return this.load > 1 && V > 1;
  }

  /** Touching down gently: on the wheels along the ground's way, the speed across kept. */
  touchDown(slope) {
    const V = Math.hypot(this.v[0], this.v[1]);
    this.heading = Math.atan2(this.v[0], this.v[1]);
    const cosS = 1 / Math.sqrt(1 + slope * slope), sinS = slope * cosS;
    this.v[0] = V * Math.sin(this.heading) * cosS;
    this.v[1] = V * Math.cos(this.heading) * cosS;
    this.v[2] = V * sinS;
    this.onGround = true;
    this.roll = 0;
  }

  /** Lifting off: in the air, climbing gently along the way it rolled. */
  liftOff() {
    this.onGround = false;
    this.#across();
  }

  /**
   * Carries the velocity and the lift's direction over the earth's curve as
   * the local frame moves `east` and `north` metres at latitude `lat`
   * (degrees): the frame's up tilts towards the way it moved, and north
   * turns towards the pole (meridians converge).
   */
  transport(east, north, lat) {
    const tE = east / EARTH, tN = north / EARTH, turn = (east * Math.tan(lat * DEG)) / EARTH;
    const c = Math.cos(turn), s = Math.sin(turn);
    carry(this.v, tE, tN, c, s);
    carry(this.lift, tE, tN, c, s);
    this.heading += turn;
    this.#across();
    this.#attitude();
  }

  /* The lift's direction made exactly across the velocity, unit length (kept as it was where the velocity is none). */
  #across() {
    const v = this.v, l = this.lift, V = this.speed;
    if (!(V > 1e-6)) return;
    const f0 = v[0] / V, f1 = v[1] / V, f2 = v[2] / V, d = l[0] * f0 + l[1] * f1 + l[2] * f2;
    let x = l[0] - d * f0, y = l[1] - d * f1, z = l[2] - d * f2;
    let n = Math.sqrt(x * x + y * y + z * z);
    if (n < 1e-6) { x = -f0 * f2; y = -f1 * f2; z = 1 - f2 * f2; n = Math.sqrt(x * x + y * y + z * z) || 1; }
    l[0] = x / n; l[1] = y / n; l[2] = z / n;
  }

  /* Rolls the lift's direction about the velocity by `angle` (positive: right wing down). */
  #rollBy(angle) {
    if (angle === 0) return;
    const v = this.v, l = this.lift, V = this.speed;
    if (!(V > 1e-6)) return;
    const f0 = v[0] / V, f1 = v[1] / V, f2 = v[2] / V;
    // right = forward × lift
    const r0 = f1 * l[2] - f2 * l[1], r1 = f2 * l[0] - f0 * l[2], r2 = f0 * l[1] - f1 * l[0];
    const c = Math.cos(angle), s = Math.sin(angle);
    l[0] = l[0] * c + r0 * s; l[1] = l[1] * c + r1 * s; l[2] = l[2] * c + r2 * s;
  }

  /* The nose and the cockpit's up. */
  #attitude() { this.aim(1, this.forward, this.up); }

  /**
   * A way to look and its up, into F and U: the velocity turned up by
   * `share` of the wing's angle in the wings' plane (1: the nose and the
   * cockpit's up; 0: along the flight path, the wings' up).
   */
  aim(share, F, U) {
    const v = this.v, l = this.lift, V = this.speed;
    let f0, f1, f2;
    if (V > 1e-3) { f0 = v[0] / V; f1 = v[1] / V; f2 = v[2] / V; }
    else { f0 = Math.sin(this.heading); f1 = Math.cos(this.heading); f2 = 0; }
    const a = share * this.alpha, ca = Math.cos(a), sa = Math.sin(a);
    F[0] = f0 * ca + l[0] * sa; F[1] = f1 * ca + l[1] * sa; F[2] = f2 * ca + l[2] * sa;
    U[0] = l[0] * ca - f0 * sa; U[1] = l[1] * ca - f1 * sa; U[2] = l[2] * ca - f2 * sa;
  }
}
