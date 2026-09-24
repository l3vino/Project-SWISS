/* walk.js — on foot.
 *
 * A point on the ground with an eye above it: WASD walks along the heading,
 * Ctrl runs, Space jumps. Gravity pulls, air drag caps a long fall near a
 * skydiver's terminal speed, slopes steeper than you can climb stop you going
 * up them and slide you down if you stand on one.
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
    this.aboveGround = null;
    this.takeoff = 0;         // feet height when the current jump or fall began
    this.peak = 0;            // highest the feet have been since
    this.lastJump = null;     // how high the last airborne spell rose, in metres
    this.here = { height: 0, gradE: 0, gradN: 0 };
    this.ahead = { height: 0, gradE: 0, gradN: 0 };
    this.target = { lon: 0, lat: 0 };
  }

  /**
   * Taking over from flight: keep the position, drop the momentum, and fall
   * if there is air underneath. With `arrive`, the camera was placed here and
   * settles onto the ground instead, without a fall.
   */
  enter({ arrive = false } = {}) {
    this.vEast = this.vNorth = this.vUp = this.slide = 0;
    this.grounded = false;
    this.takeoff = this.peak = -Infinity;
    this.arriving = arrive;
    this.arriveTime = 0;
  }

  get speed() { return Math.hypot(this.vEast, this.vNorth); }

  get falling() { return !this.grounded && this.vUp < -3; }

  /*
   * While arriving, the eye follows the best ground known so far: coarse
   * tiles first, then finer ones as they stream in. It stands only once the
   * tile drawn under it is as detailed as the view asks for and indexed, so
   * it never lands on a coarse stand-in and then drops when detail arrives.
   */
  #arrive(dt, camera, ground, p) {
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
      this.arriving = false;
      this.waiting = false;
      this.grounded = true;
      this.aboveGround = p.eyeHeight;
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

  step(dt, keys, pressed, camera, ground, p) {
    if (this.arriving) { this.#arrive(dt, camera, ground, p); return; }

    // Nothing known underfoot: hold still rather than fall through the world.
    if (!ground.sample(camera.lon, camera.lat, this.here)) {
      this.waiting = true;
      this.aboveGround = null;
      return;
    }
    this.waiting = false;
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

    /* ---- jump: on the press, not while held ---- */
    if ((pressed & KEY.UP) && this.grounded) {
      this.vUp = Math.sqrt(2 * p.gravity * p.jumpHeight);
      this.grounded = false;
      this.takeoff = this.peak = feet;
    }

    /* ---- too steep to stand on: slide down it ---- */
    let moveEast = this.vEast * dt, moveNorth = this.vNorth * dt;
    const grade = Math.hypot(this.here.gradE, this.here.gradN);
    const angle = Math.atan(grade);
    if (this.grounded && angle > p.maxSlope && grade > 0) {
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

    /* ---- walls: no walking up what is too steep ---- */
    if (moveEast !== 0 || moveNorth !== 0) {
      camera.offsetLonLat(moveEast, moveNorth, this.target);
      if (!ground.sample(this.target.lon, this.target.lat, this.ahead)) {
        // The edge of what is loaded. Stop at it rather than step into nothing.
        moveEast = moveNorth = 0;
        this.vEast = this.vNorth = 0;
      } else if (this.grounded) {
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
    if (moveEast !== 0 || moveNorth !== 0) {
      camera.translate(moveEast, moveNorth, 0);
      if (!ground.sample(camera.lon, camera.lat, this.here)) {
        camera.translate(-moveEast, -moveNorth, 0);
        return;
      }
    }

    /* ---- vertical ---- */
    const floor = this.here.height;
    if (this.grounded) {
      // Follow the ground down a slope instead of launching off every dip,
      // but a real drop (a ledge, a cliff) means you are in the air.
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
      if (feet > this.peak) this.peak = feet;
      if (feet <= floor) {
        feet = floor;
        this.vUp = 0;
        this.grounded = true;
        if (Number.isFinite(this.takeoff)) this.lastJump = this.peak - this.takeoff;
      }
    }

    camera.setHeight(feet + p.eyeHeight);
    this.aboveGround = camera.height - floor;
  }
}
