/* plane.js — the airplane mode (Stage 5.9b; the jet itself: aircraft/jet.js).
 *
 * P takes you into a fighter's cockpit and out again. Its keys:
 *   W, S          stick forward and back: the nose down and up (the stick
 *                 goes to full in an eighth of a second and back to the
 *                 middle in a tenth)
 *   A, D          roll left and right, building up while held (Stage 5.10b,
 *                 his words: "airplane is WAYYY to sensitive in turning":
 *                 a key is all or nothing, so held it moves the stick over
 *                 Roll build-up seconds, to Roll rate at most; a tap is a
 *                 small correction); let go, the wings come back level
 *   scroll        the speed you ask for, PLANE.notch a notch, up to Mach 2;
 *                 the autothrottle flies it, as fast as the engine can get
 *                 there. Scrolled down to nothing, the engine is off: it
 *                 glides if you keep its speed up (the nose a little down),
 *                 and stalls if you let it get too slow (Stage 5.11b; the
 *                 jet itself says how: aircraft/jet.js)
 *   Left Shift    speed brake in the air (the throttle at idle), wheel
 *                 brakes on the ground
 *   mouse         looks round the cockpit; the view eases back
 *                 PLANE.look.hold seconds after the mouse stops
 *   double Space  bail out: on foot, falling, at the jet's speed (walk.js)
 *
 * From walking (or flying low), you sit in it on the ground, parked, the
 * engine idling: scroll up and it rolls; pull back at about 280 km/h and it
 * takes off. From flying higher, it flies on at your speed (at least
 * PLANE.least, 600 km/h, where it can pull properly; Mach 2 at most), the
 * way you look, its path along your view within ±30°.
 *
 * How it flies is set in Settings → Vehicles → Airplane (render.js passes
 * the values in `params` each step): the roll rate and its build-up, the
 * pitch rate, the engine's power (the speed changes quicker with more, his
 * answer: "realistic but quicker"), whether the autothrottle opens the
 * speed brake to slow down, the wing (the F-16's, or one with half as much
 * lift again and a 12 g structure), and which way the view looks
 * (`planeView`): along the flight path, where the jet really goes (Stage
 * 5.11b, his words on 5.10b: "the airplane pitch is wayyy to stange, it
 * looks up quick, but the actual plane pitch is slower": pulling, the nose
 * comes up within a tenth of a second and the path follows it a second
 * later), or along the nose, as from a real cockpit. On its wheels it
 * always looks along the nose, and eases between the two over
 * PLANE.viewBlend seconds as it lifts off and touches down.
 *
 * The world is solid as it is for walking and flying (unless Fly through
 * buildings is set): the ground where it is known accurately, buildings and
 * bridges. The airframe is a sphere PLANE.radius metres round for walls, its
 * wheels PLANE.eye under the eye. Touching the ground (or a roof, or a deck)
 * gently, wheels first (sinking under touch.sink m/s, wings within
 * touch.bank, the nose not under touch.pitch, under touch.speed), it lands
 * and rolls; anything else, or any wall, is a crash: it stops there
 * (`crashed`, render.js says so and takes you back to flying).
 */

import { KEY } from '../camera.js';
import { Jet } from '../aircraft/jet.js';
import { air } from '../aircraft/atmosphere.js';
import { groundSample } from '../terrain/ground.js';

const DEG = Math.PI / 180;

export const PLANE = {
  eye: 2.6,                        // the cockpit over the wheels, metres
  radius: 5,                       // the airframe, for walls
  stick: { rate: 8, back: 10 },    // a second: to full, back to the middle
  rollBack: 10,                    // a second: the roll stick back to the middle when let go
  least: 600 / 3.6,                // starting in the air: at least this fast, m/s
  parked: 4,                       // metres over the ground: lower, it starts on its wheels
  climb: 30 * DEG,                 // starting in the air: the path along the view, at most this steep
  notch: 25 / 3.6,                 // m/s a scroll notch adds to the speed asked
  most: 2,                         // Mach: the most speed asked
  touch: { sink: 3, bank: 10 * DEG, pitch: -3 * DEG, speed: 400 / 3.6 },
  edge: 0.5,                       // metres the ground may drop under the wheels before it rolls off
  look: { hold: 0.8, back: 0.6, yaw: 150 * DEG, pitch: 80 * DEG },
  viewBlend: 0.5,                  // seconds: the view eased between the nose and the path
};

const toward = (x, goal, rate, dt) => x + Math.max(-rate * dt, Math.min(rate * dt, goal - x));
const NO_TUNING = {};

export class PlaneController {
  constructor() {
    this.jet = new Jet();
    this.stick = 0;
    this.rollStick = 0;               // -1 left .. 1 right, built up while A or D is held
    this.crashed = null;           // { speed } when it hit something
    this.aboveGround = null;
    this.waiting = false;          // on its wheels with no ground known under them
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.lookIdle = Infinity;
    this.viewMode = 'path';        // 'path' or 'nose' (params.planeView)
    this.noseShare = 1;            // how much of the wing's angle the view shows: 1 along the nose, 0 along the path
    this.here = groundSample();
    this.ahead = groundSample();
    this.air = {};
    this.way = { east: 0, north: 0, up: 0 };
    this.local = { x: 0, y: 0, z: 0 };
    this.goal = { x: 0, y: 0 };
    this.contacts = [];
    this.f = new Float64Array(3);
    this.u = new Float64Array(3);
    this.r = new Float64Array(3);
    this.controls = { pitch: 0, roll: 0, brake: false, level: true };
    this.pose = { lon: 0, lat: 0, height: 0, yaw: 0, pitch: 0, roll: 0 };
  }

  /** Looking round the cockpit, the head turned off the nose. */
  get looking() { return Math.abs(this.lookYaw) + Math.abs(this.lookPitch) > 2 * DEG; }

  /** The jet's velocity, metres a second east, north and up (walking takes it over: a bail-out). */
  get velocity() { return { east: this.jet.v[0], north: this.jet.v[1], up: this.jet.v[2] }; }

  /**
   * In the cockpit: parked when `grounded` (walking on the ground, or flying
   * under PLANE.parked metres over it), else flying on at `speed` (m/s, at
   * least PLANE.least) the way the camera looks.
   */
  enter({ camera, grounded = false, speed = 0, aboveGround = null } = {}) {
    this.crashed = null;
    this.stick = 0;
    this.rollStick = 0;
    this.lookYaw = this.lookPitch = 0;
    this.lookIdle = Infinity;
    if (!camera) return;
    const parked = grounded || (aboveGround != null && aboveGround < PLANE.parked);
    this.noseShare = parked || this.viewMode === 'nose' ? 1 : 0;
    if (parked) {
      this.jet.reset({ speed: 0, heading: camera.yaw, pitch: 0, onGround: true, target: 0, height: camera.height });
    } else {
      const most = PLANE.most * air(camera.height, this.air).sound;
      const v = Math.min(most, Math.max(PLANE.least, speed));
      const pitch = Math.max(-PLANE.climb, Math.min(PLANE.climb, camera.pitch));
      // The speed asked on whole notches, so the wheel steps through round numbers.
      const target = Math.min(most, Math.max(PLANE.least, Math.round(v / PLANE.notch) * PLANE.notch));
      this.jet.reset({ speed: v, heading: camera.yaw, pitch, onGround: false, target, height: camera.height });
    }
  }

  /** Scroll: the speed asked, PLANE.notch a notch, from nothing (idle) to Mach PLANE.most. */
  adjustSpeed(notches, height) {
    const most = PLANE.most * air(height, this.air).sound;
    const t = this.jet.target <= 0 && notches > 0 ? Math.min(this.jet.speed, most) : this.jet.target;
    this.jet.target = Math.max(0, Math.min(most, Math.round((t + notches * PLANE.notch) / PLANE.notch) * PLANE.notch));
  }

  /** The mouse moved: the head turns, held while it moves, back onto the nose after. */
  look(dYaw, dPitch) {
    this.lookYaw = Math.max(-PLANE.look.yaw, Math.min(PLANE.look.yaw, this.lookYaw + dYaw));
    this.lookPitch = Math.max(-PLANE.look.pitch, Math.min(PLANE.look.pitch, this.lookPitch + dPitch));
    this.lookIdle = 0;
  }

  /**
   * One physics step.
   * @param solids  features/solid.js, gathered around the camera this frame, or null
   */
  step(dt, keys, pressed, camera, ground, params, solids = null) {
    if (this.crashed) return;
    const pull = ((keys & KEY.BACK) ? 1 : 0) - ((keys & KEY.FORWARD) ? 1 : 0);
    const roll = ((keys & KEY.RIGHT) ? 1 : 0) - ((keys & KEY.LEFT) ? 1 : 0);
    this.stick = toward(this.stick, pull, pull !== 0 ? PLANE.stick.rate : PLANE.stick.back, dt);
    // The roll stick: out over the build-up while held, back quickly when
    // let go, and through the middle at once when the other key is pressed.
    const build = params.planeRollBuild ?? 0.8;
    const r = this.rollStick;
    if (roll === 0 || r * roll < 0) this.rollStick = toward(r, 0, PLANE.rollBack, dt);
    else this.rollStick = build > 0.01 ? toward(r, roll, 1 / build, dt) : roll;
    this.jet.tune(params.plane ?? NO_TUNING);
    const controls = this.controls;
    controls.pitch = this.stick;
    controls.roll = Math.abs(this.rollStick) < 1e-4 ? 0 : this.rollStick;
    controls.brake = (keys & KEY.DOWN) !== 0;
    controls.level = params.planeLevel !== false;
    this.viewMode = params.planeView === 'nose' ? 'nose' : 'path';
    const jet = this.jet, solid = solids?.active && !params.flyThrough ? solids : null;
    jet.target = Math.min(jet.target, PLANE.most * air(camera.height, this.air).sound);
    if (jet.onGround) this.#rolling(dt, controls, camera, ground, solid);
    else this.#flying(dt, controls, camera, ground, solid);
    if (!this.crashed) this.#view(dt, camera);
  }

  /* The highest surface under the wheels: the ground where known accurately,
   * or a roof or a deck a little above the wheels at most. -Infinity: none known. */
  #floor(camera, ground, solid, reach) {
    let floor = -Infinity;
    if (ground.sample(camera.lon, camera.lat, this.here) && this.here.accurate) floor = this.here.height;
    if (solid) {
      const wheels = camera.height - PLANE.eye;
      const at = solid.toLocal(camera.lon, camera.lat, wheels, this.local);
      const built = solid.floor(at.x, at.y, at.z + reach) + solid.origin.height;
      if (built > floor) floor = built;
    }
    return floor;
  }

  /* Buildings and bridges against the airframe along a step: true if it touched one. */
  #walls(camera, solid, way) {
    if (!solid || (way.east === 0 && way.north === 0)) return false;
    const at = solid.toLocal(camera.lon, camera.lat, camera.height, this.local), goal = this.goal;
    goal.x = at.x + way.east;
    goal.y = at.y + way.north;
    this.contacts.length = 0;
    const low = at.z + Math.min(0, way.up) - PLANE.eye + 0.5, high = at.z + Math.max(0, way.up) + 1;
    solid.sweep(at, goal, PLANE.radius, low, high, this.contacts);
    return this.contacts.length > 0;
  }

  #crash(camera, floor) {
    this.crashed = { speed: this.jet.speed };
    const v = this.jet.v;
    v[0] = v[1] = v[2] = 0;
    if (Number.isFinite(floor) && camera.height < floor + PLANE.eye) camera.setHeight(floor + PLANE.eye);
  }

  #flying(dt, controls, camera, ground, solid) {
    const jet = this.jet, way = this.way;
    jet.step(dt, controls, camera.height, way);
    if (this.#walls(camera, solid, way)) { this.#crash(camera, -Infinity); return; }
    camera.translate(way.east, way.north, way.up);
    jet.transport(way.east, way.north, camera.lat);
    const floor = this.#floor(camera, ground, solid, 0.5);
    if (!Number.isFinite(floor)) { this.aboveGround = null; return; }
    this.aboveGround = camera.height - floor;
    if (camera.height - PLANE.eye > floor) return;
    // Touching: gently, on the wheels, it lands; otherwise it crashes.
    const T = PLANE.touch, v = jet.v, gE = this.here.gradE || 0, gN = this.here.gradN || 0;
    const n = Math.sqrt(gE * gE + gN * gN + 1);
    const sink = -(v[0] * -gE + v[1] * -gN + v[2]) / n;
    const nose = Math.asin(Math.max(-1, Math.min(1, jet.forward[2]))) - Math.atan(gE * jet.forward[0] + gN * jet.forward[1]);
    if (sink <= T.sink && Math.abs(jet.bank) <= T.bank && nose >= T.pitch && jet.speed <= T.speed) {
      const h = Math.atan2(v[0], v[1]);
      jet.touchDown(gE * Math.sin(h) + gN * Math.cos(h));
      camera.setHeight(floor + PLANE.eye);
      this.aboveGround = PLANE.eye;
    } else {
      this.#crash(camera, floor);
    }
  }

  #rolling(dt, controls, camera, ground, solid) {
    const jet = this.jet, way = this.way;
    if (!ground.sample(camera.lon, camera.lat, this.here) || !this.here.accurate) {
      // No ground known under the wheels yet: held where it is.
      this.waiting = true;
      this.aboveGround = null;
      return;
    }
    this.waiting = false;
    const slope = this.here.gradE * Math.sin(jet.heading) + this.here.gradN * Math.cos(jet.heading);
    const lifted = jet.stepGround(dt, controls, camera.height, slope, way);
    if (this.#walls(camera, solid, way)) {
      // Into a wall: at walking pace it only stops; faster, a crash.
      if (jet.speed > 15) { this.#crash(camera, this.here.height); return; }
      jet.v[0] = jet.v[1] = jet.v[2] = 0;
      way.east = way.north = way.up = 0;
    }
    camera.translate(way.east, way.north, 0);
    const floor = this.#floor(camera, ground, solid, 0.5);
    if (lifted) {
      jet.liftOff();
      camera.setHeight(camera.height + way.up);
    } else if (Number.isFinite(floor) && floor < camera.height - PLANE.eye - PLANE.edge) {
      // Off an edge (a roof's, a cliff's): in the air.
      jet.liftOff();
    } else if (Number.isFinite(floor)) {
      camera.setHeight(floor + PLANE.eye);
    }
    this.aboveGround = Number.isFinite(floor) ? camera.height - floor : null;
  }

  /* The view: along the flight path or the nose (see the top of the file),
   * turned by the head, as the camera's yaw, pitch and roll. */
  #view(dt, camera) {
    const f = this.f, u = this.u, r = this.r;
    const goal = this.viewMode === 'nose' || this.jet.onGround ? 1 : 0;
    this.noseShare += (goal - this.noseShare) * (1 - Math.exp(-dt / PLANE.viewBlend));
    this.jet.aim(this.noseShare, f, u);
    if (this.lookYaw !== 0 || this.lookPitch !== 0) {
      this.lookIdle += dt;
      if (this.lookIdle > PLANE.look.hold) {
        const k = Math.exp(-dt / PLANE.look.back);
        this.lookYaw *= k;
        this.lookPitch *= k;
        if (Math.abs(this.lookYaw) + Math.abs(this.lookPitch) < 1e-4) this.lookYaw = this.lookPitch = 0;
      }
      // The head: round the cockpit's up (to the right for a positive
      // yaw, as the camera turns), then up round its right.
      rotate(f, u, -this.lookYaw);
      cross(f, u, r);
      rotate(f, r, this.lookPitch);
      cross(r, f, u);
    }
    const yaw = Math.atan2(f[0], f[1]);
    const pitch = Math.max(-89.9 * DEG, Math.min(89.9 * DEG, Math.asin(Math.max(-1, Math.min(1, f[2])))));
    // The camera's roll: from its own level up (right = forward × up) to the cockpit's up.
    const cp = Math.cos(pitch), fx = Math.sin(yaw) * cp, fy = Math.cos(yaw) * cp, fz = Math.sin(pitch);
    let rx = fy, ry = -fx;
    const rn = Math.sqrt(rx * rx + ry * ry) || 1;
    rx /= rn; ry /= rn;
    const lx = ry * fz, ly = -rx * fz, lz = rx * fy - ry * fx;
    const roll = Math.atan2(u[0] * rx + u[1] * ry, u[0] * lx + u[1] * ly + u[2] * lz);
    const pose = this.pose;
    pose.lon = camera.lon;
    pose.lat = camera.lat;
    pose.height = camera.height;
    pose.yaw = yaw;
    pose.pitch = pitch;
    pose.roll = roll;
    camera.apply(pose);
  }

  /** What the airplane's display shows (ui/cockpit.js), into `out`. */
  report(camera, out = {}) {
    const j = this.jet, a = air(camera.height, this.air);
    out.speed = j.speed;
    out.target = j.target;
    out.mach = j.speed / a.sound;
    out.altitude = camera.height;
    out.above = this.aboveGround;
    out.climb = j.v[2];
    out.heading = Math.atan2(j.forward[0], j.forward[1]);
    out.load = j.load;
    out.alpha = j.alpha;
    out.throttle = j.throttle;
    out.afterburner = j.afterburning;
    out.brake = j.braking;
    out.onGround = j.onGround;
    out.waiting = this.waiting;
    out.vEast = j.v[0];
    out.vNorth = j.v[1];
    out.vUp = j.v[2];
    out.yaw = camera.yaw;
    out.pitch = camera.pitch;
    out.roll = camera.roll;
    out.looking = this.looking;
    out.stall = j.stalled;
    return out;
  }
}

/* Turns a (in place) round the unit axis n by angle t (right-handed). */
function rotate(a, n, t) {
  const c = Math.cos(t), s = Math.sin(t), d = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
  const x = n[1] * a[2] - n[2] * a[1], y = n[2] * a[0] - n[0] * a[2], z = n[0] * a[1] - n[1] * a[0];
  a[0] = a[0] * c + x * s + n[0] * d * (1 - c);
  a[1] = a[1] * c + y * s + n[1] * d * (1 - c);
  a[2] = a[2] * c + z * s + n[2] * d * (1 - c);
}

/* a × b, made unit length, into `out` (which may not be a or b). */
function cross(a, b, out) {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  const n = Math.sqrt(x * x + y * y + z * z) || 1;
  out[0] = x / n; out[1] = y / n; out[2] = z / n;
  return out;
}
