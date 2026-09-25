/* fly.js — free flight.
 *
 * WASD moves in the local horizontal plane along the heading, and altitude
 * answers only to Space and Left Shift. Where the nose points never drags you
 * up or down, which is what makes level flight along a valley possible
 * without fighting the mouse. The ground is solid: you can skim it, not pass
 * through it. So are buildings and bridges, unless the setting says to fly
 * through them: walls stop you and you slide along them, roofs and decks
 * hold you up like ground, and gentle roofs lift you over as a hillside
 * would.
 */

import { KEY } from '../camera.js';
import { BODY_RADIUS, STEP_HEIGHT } from './walk.js';

/* Ctrl with a movement key. Flight speed spans five orders of magnitude, so a
 * multiplier works here where walking needs a realistic pair of speeds. */
const SPRINT_MULTIPLIER = 3;

export class FlyController {
  constructor() {
    this.sprinting = false;
    this.aboveGround = null;   // metres from eye to ground, when known
    this.sample = { height: 0, gradE: 0, gradN: 0 };
    this.local = { x: 0, y: 0, z: 0 };
    this.goal = { x: 0, y: 0 };
  }

  enter() { this.sprinting = false; }

  /**
   * One physics step.
   * @param solids  features/solid.js, gathered around the camera this frame,
   *                or null where nothing is solid
   */
  step(dt, keys, pressed, camera, ground, params, solids = null) {
    let f = 0, r = 0, u = 0;
    if (keys & KEY.FORWARD) f += 1;
    if (keys & KEY.BACK) f -= 1;
    if (keys & KEY.RIGHT) r += 1;
    if (keys & KEY.LEFT) r -= 1;
    if (keys & KEY.UP) u += 1;
    if (keys & KEY.DOWN) u -= 1;

    this.sprinting = (keys & KEY.SPRINT) !== 0 && (f !== 0 || r !== 0 || u !== 0);
    const solid = solids?.active && !params.flyThrough ? solids : null;
    const feetBefore = camera.height - params.eyeHeight;
    let stride = 0;

    if (f !== 0 || r !== 0 || u !== 0) {
      // Diagonals should not be faster than the axes.
      const planar = Math.hypot(f, r);
      if (planar > 1) { f /= planar; r /= planar; }
      const step = camera.speed * (this.sprinting ? SPRINT_MULTIPLIER : 1) * dt;
      // Heading in the local frame: forward is (sin yaw, cos yaw) in east and
      // north, right is its clockwise perpendicular.
      const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
      let dEast = (f * sy + r * cy) * step, dNorth = (f * cy - r * sy) * step;
      const dUp = u * step;
      if (solid && (dEast !== 0 || dNorth !== 0)) {
        // Walls between a step above the feet and the head, over the whole
        // height the body passes through this step.
        const at = solid.toLocal(camera.lon, camera.lat, feetBefore, this.local);
        const goal = this.goal;
        goal.x = at.x + dEast; goal.y = at.y + dNorth;
        const low = at.z + Math.min(0, dUp) + STEP_HEIGHT;
        const high = at.z + Math.max(0, dUp) + params.bodyHeight;
        solid.sweep(at, goal, BODY_RADIUS, low, high, null);
        dEast = goal.x - at.x; dNorth = goal.y - at.y;
      }
      stride = Math.hypot(dEast, dNorth);
      camera.translate(dEast, dNorth, dUp);
    }

    // Solid ground. Kept at eye height so switching to walking from a skim
    // lands you standing, not falling.
    let floor = -Infinity;
    if (ground.sample(camera.lon, camera.lat, this.sample)) floor = this.sample.height;
    if (solid) {
      const feet = camera.height - params.eyeHeight;
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      const base = solid.origin.height;
      // Anything standable up to a step above the higher of the feet before
      // and after, and up the slope a stride's worth: flying into a gentle
      // roof rides up it, as it would up a hillside.
      const reach = Math.max(feetBefore, feet) - base + STEP_HEIGHT + stride * Math.tan(params.maxSlope);
      const built = solid.floor(at.x, at.y, reach) + base;
      if (built > floor) floor = built;
      if (feet > feetBefore) {
        // Rising into something overhead stops at it.
        const over = solid.ceiling(at.x, at.y, feetBefore - base + params.bodyHeight - 0.05) + base;
        if (feet + params.bodyHeight > over) camera.setHeight(over - params.bodyHeight + params.eyeHeight);
      }
    }
    if (Number.isFinite(floor)) {
      if (camera.height < floor + params.eyeHeight) camera.setHeight(floor + params.eyeHeight);
      this.aboveGround = camera.height - floor;
    } else {
      this.aboveGround = null;
    }
  }
}
