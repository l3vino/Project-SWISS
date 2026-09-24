/* fly.js — free flight.
 *
 * WASD moves in the local horizontal plane along the heading, and altitude
 * answers only to Space and Left Shift. Where the nose points never drags you
 * up or down, which is what makes level flight along a valley possible
 * without fighting the mouse. The ground is solid: you can skim it, not pass
 * through it.
 */

import { KEY } from '../camera.js';

/* Ctrl with a movement key. Flight speed spans five orders of magnitude, so a
 * multiplier works here where walking needs a realistic pair of speeds. */
const SPRINT_MULTIPLIER = 3;

export class FlyController {
  constructor() {
    this.sprinting = false;
    this.aboveGround = null;   // metres from eye to ground, when known
    this.sample = { height: 0, gradE: 0, gradN: 0 };
  }

  enter() { this.sprinting = false; }

  step(dt, keys, pressed, camera, ground, params) {
    let f = 0, r = 0, u = 0;
    if (keys & KEY.FORWARD) f += 1;
    if (keys & KEY.BACK) f -= 1;
    if (keys & KEY.RIGHT) r += 1;
    if (keys & KEY.LEFT) r -= 1;
    if (keys & KEY.UP) u += 1;
    if (keys & KEY.DOWN) u -= 1;

    this.sprinting = (keys & KEY.SPRINT) !== 0 && (f !== 0 || r !== 0 || u !== 0);

    if (f !== 0 || r !== 0 || u !== 0) {
      // Diagonals should not be faster than the axes.
      const planar = Math.hypot(f, r);
      if (planar > 1) { f /= planar; r /= planar; }
      const step = camera.speed * (this.sprinting ? SPRINT_MULTIPLIER : 1) * dt;
      // Heading in the local frame: forward is (sin yaw, cos yaw) in east and
      // north, right is its clockwise perpendicular.
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      camera.translate((f * sy + r * cy) * step, (f * cy - r * sy) * step, u * step);
    }

    // Solid ground. Kept at eye height so switching to walking from a skim
    // lands you standing, not falling.
    if (ground.sample(camera.lon, camera.lat, this.sample)) {
      const floor = this.sample.height + params.eyeHeight;
      if (camera.height < floor) camera.setHeight(floor);
      this.aboveGround = camera.height - this.sample.height;
    } else {
      this.aboveGround = null;
    }
  }
}
