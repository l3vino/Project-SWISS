/* walk.js — on foot.
 *
 * A body on the ground with an eye near its top: WASD walks along the
 * heading, Ctrl runs, Space jumps, and keeps jumping while held. Gravity
 * pulls, air drag caps a long fall near a skydiver's terminal speed, slopes
 * steeper than you can climb stop you going up them and slide you down if
 * you stand on one.
 *
 * Buildings and bridges are solid (see features/solid.js): the body is an
 * upright cylinder that walls stop and slide along, that steps up kerbs and
 * stairs, stands on roofs, terraces and bridge decks, and bumps its head on
 * what hangs over it.
 *
 * Deliberately a kinematic character rather than a rigid body: a person does
 * not bounce, tumble or accumulate momentum on the flat, and the controls
 * should feel like a person.
 */

import { KEY } from '../camera.js';
import { DEG } from '../../core/math.js';

/* Belly-down skydiver, roughly 200 km/h. */
const TERMINAL_SPEED = 55;
/* How quickly you reach walking speed: on the ground in about a tenth of a
 * second, in the air barely at all, since there is nothing to push against. */
const GROUND_RESPONSE = 12;
const AIR_RESPONSE = 0.6;
/* Arriving somewhere new: how quickly the eye glides onto each better
 * estimate of the ground, and how long to wait for the final one before
 * standing on whatever is known. */
const ARRIVE_RESPONSE = 8;
const ARRIVE_SNAP = 30;
const ARRIVE_PATIENCE = 12;
/* Holding Space: the time on the ground between one landing and the next
 * take-off, about what a person needs to push off again. */
const REJUMP_DELAY = 0.12;

/* The body, for colliding with buildings: shoulders a little narrower than a
 * doorway is wide, and the highest ledge climbed without a jump, about a
 * kerb or a generous stair. */
export const BODY_RADIUS = 0.3;
export const STEP_HEIGHT = 0.4;

export class WalkController {
  constructor() {
    this.vEast = 0;
    this.vNorth = 0;
    this.vUp = 0;
    this.slide = 0;           // speed down a too-steep slope
    this.grounded = false;
    this.running = false;
    this.waiting = false;     // no ground data under us yet
    this.arriving = false;    // placed here, settling onto the ground
    this.arriveTime = 0;
    this.clearing = false;    // settled, waiting to be moved out of any building
    this.cleared = false;     // ... and done
    this.clearTime = 0;
    this.aboveGround = null;
    this.onStructure = false; // standing on a building or bridge, not the terrain
    this.takeoff = 0;         // feet height when the current jump or fall began
    this.peak = 0;            // highest the feet have been since
    this.lastJump = null;     // how high the last airborne spell rose, in metres
    this.jumpArmed = false;   // Space released since walking began
    this.groundTime = 0;      // seconds since the last landing
    this.jumps = 0;           // take-offs so far, for the probe
    this.contacts = [];       // wall push directions this step, x y pairs
    this.here = { height: 0, gradE: 0, gradN: 0 };
    this.ahead = { height: 0, gradE: 0, gradN: 0 };
    this.target = { lon: 0, lat: 0 };
    this.local = { x: 0, y: 0, z: 0 };
    this.goal = { x: 0, y: 0 };
  }

  /**
   * Taking over from flight: keep the position, drop the momentum, and fall
   * if there is air underneath. With `arrive`, the camera was placed here and
   * settles onto the ground instead, without a fall, then out of any
   * building it landed in.
   */
  enter({ arrive = false } = {}) {
    this.vEast = this.vNorth = this.vUp = this.slide = 0;
    this.grounded = false;
    this.takeoff = this.peak = -Infinity;
    this.jumpArmed = false;
    this.groundTime = 0;
    this.arriving = arrive;
    this.arriveTime = 0;
    this.clearing = false;
    this.cleared = false;
    this.clearTime = 0;
    this.clearedBy = null;    // metres moved to get clear of buildings, once known
  }

  get speed() { return Math.hypot(this.vEast, this.vNorth); }

  get falling() { return !this.grounded && this.vUp < -3; }

  /*
   * While arriving, the eye follows the best ground known so far: coarse
   * tiles first, then finer ones as they stream in. It stands only once the
   * tile drawn under it is as detailed as the view asks for and indexed, so
   * it never lands on a coarse stand-in and then drops when detail arrives.
   * Where buildings are solid, it then waits for the render thread to move
   * it clear of them (`clearing`), and settles again wherever that is.
   */
  #arrive(dt, camera, ground, p, solids) {
    this.arriveTime += dt;
    if (!ground.sample(camera.lon, camera.lat, this.here)) {
      this.waiting = true;
      this.aboveGround = null;
      return;
    }
    const eye = this.here.height + p.eyeHeight;
    const close = Math.abs(camera.height - eye) < 0.25;
    if ((close && ground.settled(camera.lon, camera.lat)) || this.arriveTime > ARRIVE_PATIENCE) {
      camera.setHeight(eye);
      this.waiting = false;
      this.aboveGround = p.eyeHeight;
      if (solids && !this.cleared) {
        this.clearing = true;
        this.clearTime += dt;
        return;
      }
      this.arriving = false;
      this.clearing = false;
      this.grounded = true;
      return;
    }
    // A first estimate far off is jumped to rather than dived towards; the
    // small corrections as finer tiles land are glided.
    const gap = eye - camera.height;
    camera.setHeight(Math.abs(gap) > ARRIVE_SNAP ? eye
      : camera.height + gap * (1 - Math.exp(-ARRIVE_RESPONSE * dt)));
    this.waiting = false;
    this.aboveGround = camera.height - this.here.height;
  }

  /**
   * One physics step.
   * @param solids  features/solid.js, gathered around the camera this frame,
   *                or null where nothing is solid
   */
  step(dt, keys, pressed, camera, ground, p, solids = null) {
    if (this.arriving) { this.#arrive(dt, camera, ground, p, solids); return; }

    // Nothing known underfoot: hold still rather than fall through the world.
    if (!ground.sample(camera.lon, camera.lat, this.here)) {
      this.waiting = true;
      this.aboveGround = null;
      return;
    }
    this.waiting = false;
    const solid = solids?.active ? solids : null;
    let feet = camera.height - p.eyeHeight;

    /* ---- where you want to go ---- */
    let f = 0, r = 0;
    if (keys & KEY.FORWARD) f += 1;
    if (keys & KEY.BACK) f -= 1;
    if (keys & KEY.RIGHT) r += 1;
    if (keys & KEY.LEFT) r -= 1;
    const planar = Math.hypot(f, r);
    if (planar > 1) { f /= planar; r /= planar; }

    this.running = (keys & KEY.SPRINT) !== 0 && planar > 0;
    const pace = this.running ? p.runSpeed : p.walkSpeed;
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
    const wantEast = (f * sy + r * cy) * pace;
    const wantNorth = (f * cy - r * sy) * pace;

    const k = 1 - Math.exp(-(this.grounded ? GROUND_RESPONSE : AIR_RESPONSE) * dt);
    this.vEast += (wantEast - this.vEast) * k;
    this.vNorth += (wantNorth - this.vNorth) * k;

    /* ---- jump: on a press, and again after every landing while held ---- */
    // Holding Space bounces like a person would: a moment on the ground to
    // push off again, then up. The Space that switched into walking has to
    // be let go once first, or a double-tap on the ground would also jump.
    if (!(keys & KEY.UP)) this.jumpArmed = true;
    if (this.grounded) this.groundTime += dt;
    const held = (keys & KEY.UP) !== 0 && this.jumpArmed && this.groundTime >= REJUMP_DELAY;
    if (this.grounded && ((pressed & KEY.UP) || held)) {
      this.vUp = Math.sqrt(2 * p.gravity * p.jumpHeight);
      this.grounded = false;
      this.jumpArmed = true;
      this.jumps++;
      this.takeoff = this.peak = feet;
    }

    /* ---- too steep to stand on: slide down it ---- */
    let moveEast = this.vEast * dt, moveNorth = this.vNorth * dt;
    const grade = Math.hypot(this.here.gradE, this.here.gradN);
    const angle = Math.atan(grade);
    if (this.grounded && !this.onStructure && angle > p.maxSlope && grade > 0) {
      // Friction that exactly holds you at the steepest walkable slope, so
      // the setting decides both where climbing stops and where sliding
      // starts. Just past it the slide is slow; on a cliff it is not.
      const push = p.gravity * (Math.sin(angle) - Math.tan(p.maxSlope) * Math.cos(angle));
      this.slide = Math.max(0, this.slide + push * dt);
      moveEast -= (this.here.gradE / grade) * this.slide * dt;
      moveNorth -= (this.here.gradN / grade) * this.slide * dt;
    } else {
      this.slide *= Math.exp(-8 * dt);
    }

    /* ---- slopes: no walking up what is too steep ---- */
    if (moveEast !== 0 || moveNorth !== 0) {
      camera.offsetLonLat(moveEast, moveNorth, this.target);
      if (!ground.sample(this.target.lon, this.target.lat, this.ahead)) {
        // The edge of what is loaded. Stop at it rather than step into nothing.
        moveEast = moveNorth = 0;
        this.vEast = this.vNorth = 0;
      } else if (this.grounded && !this.onStructure) {
        const g = Math.hypot(this.ahead.gradE, this.ahead.gradN);
        const uphill = moveEast * this.ahead.gradE + moveNorth * this.ahead.gradN;
        if (g > 0 && Math.atan(g) > p.maxSlope && uphill > 0 && this.ahead.height > feet) {
          // Keep only the part of the step that runs along the slope.
          const ue = this.ahead.gradE / g, un = this.ahead.gradN / g;
          const into = moveEast * ue + moveNorth * un;
          moveEast -= into * ue; moveNorth -= into * un;
          const vInto = this.vEast * ue + this.vNorth * un;
          if (vInto > 0) { this.vEast -= vInto * ue; this.vNorth -= vInto * un; }
        }
      }
    }

    /* ---- buildings: walls stop you, and you slide along them ---- */
    if (solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      const goal = this.goal;
      goal.x = at.x + moveEast; goal.y = at.y + moveNorth;
      this.contacts.length = 0;
      // Walls count from a step above the feet to the top of the head.
      solid.sweep(at, goal, BODY_RADIUS, at.z + STEP_HEIGHT, at.z + p.bodyHeight, this.contacts);
      moveEast = goal.x - at.x;
      moveNorth = goal.y - at.y;
      // Speed into a wall is lost; along it, kept.
      for (let i = 0; i < this.contacts.length; i += 2) {
        const nx = this.contacts[i], ny = this.contacts[i + 1];
        const into = this.vEast * nx + this.vNorth * ny;
        if (into < 0) { this.vEast -= into * nx; this.vNorth -= into * ny; }
      }
    }

    if (moveEast !== 0 || moveNorth !== 0) {
      camera.translate(moveEast, moveNorth, 0);
      if (!ground.sample(camera.lon, camera.lat, this.here)) {
        camera.translate(-moveEast, -moveNorth, 0);
        return;
      }
    }

    /* ---- vertical ---- */
    // The floor is the terrain, or whatever built surface is higher and no
    // more than a step above the feet: a roof you landed on, a bridge deck,
    // a stair you walked into.
    let floor = this.here.height;
    let ceiling = Infinity;
    this.onStructure = false;
    if (solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      const base = solid.origin.height;
      const built = solid.floor(at.x, at.y, at.z + STEP_HEIGHT) + base;
      if (built > floor) { floor = built; this.onStructure = true; }
      if (!this.grounded && this.vUp > 0) {
        ceiling = solid.ceiling(at.x, at.y, at.z + p.bodyHeight - 0.05) + base;
      }
    }

    if (this.grounded) {
      // Follow the ground down a slope instead of launching off every dip,
      // but a real drop (a ledge, a cliff, a roof's edge) means you are in
      // the air.
      const stride = Math.hypot(moveEast, moveNorth);
      const stick = Math.max(0.3, stride * Math.tan(p.maxSlope + 10 * DEG));
      if (feet - floor <= stick) { feet = floor; this.vUp = 0; }
      else { this.grounded = false; this.takeoff = this.peak = feet; }
    }
    if (!this.grounded) {
      // Gravity, less drag growing with the square of speed, which settles
      // at terminal speed instead of accelerating forever.
      const drag = p.gravity * (this.vUp / TERMINAL_SPEED) ** 2 * (this.vUp < 0 ? 1 : -1);
      const accel = -p.gravity + drag;
      // Position from the start-of-step velocity plus half the acceleration:
      // exact for constant acceleration, so a jump peaks at the height asked
      // for rather than half a step's worth of velocity short of it.
      feet += this.vUp * dt + 0.5 * accel * dt * dt;
      this.vUp += accel * dt;
      if (feet + p.bodyHeight > ceiling) {
        // Head against something: stop rising and fall back.
        feet = ceiling - p.bodyHeight;
        this.vUp = Math.min(this.vUp, 0);
      }
      if (feet > this.peak) this.peak = feet;
      if (feet <= floor) {
        feet = floor;
        this.vUp = 0;
        this.grounded = true;
        this.groundTime = 0;
        if (Number.isFinite(this.takeoff)) this.lastJump = this.peak - this.takeoff;
      }
    }

    camera.setHeight(feet + p.eyeHeight);
    this.aboveGround = camera.height - floor;
  }
}
