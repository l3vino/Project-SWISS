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
 *
 * Only accurate ground is solid (terrain/ground.js). While the terrain under
 * you is still streaming in, the first tiles to arrive are coarse stand-ins,
 * and over mountains their surface can be kilometres above the real valley
 * floor. With no accurate ground known there is no floor: you may be under
 * the stand-in for a moment, but it never lifts you.
 *
 * Switching to walking takes this flight's velocity on (walk.js, enter),
 * vertical too (Stage 5.13b, his words: "if I'm flying and go into walk
 * mode, also consider vertical momentum"). A double tap of Space is itself
 * two presses of fly-up, so it hands on what you were doing before the taps
 * (tapVelocity; his answer: "the climb before the taps"): the climb you
 * held Space for just before them, else the vertical speed before the
 * first, never the taps' own climb at full flying speed.
 */

import { KEY } from '../camera.js';
import { BODY_RADIUS, STEP_HEIGHT } from './walk.js';
import { groundSample } from '../terrain/ground.js';

/* A double tap's presses are looked for this far back (seconds: the page's
 * double tap is 0.3 s at most); Space held at least `held` seconds is a
 * climb you meant, and counts if the first tap came within `gap` seconds of
 * letting it go. */
const TAP = { window: 0.5, held: 0.3, gap: 0.35 };

/* Ctrl with a movement key. Flight speed spans five orders of magnitude, so a
 * multiplier works here where walking needs a realistic pair of speeds. */
export const SPRINT_MULTIPLIER = 3;

export class FlyController {
  constructor() {
    this.sprinting = false;
    this.aboveGround = null;   // metres from eye to ground, when known
    // How fast the last step moved, metres a second east, north and up: what
    // walking takes over when you switch to it in the air (walk.js, enter).
    this.velocity = { east: 0, north: 0, up: 0 };
    // Space's presses (when, on this controller's clock, and the vertical
    // speed just before each), and the last climb it was held for (TAP).
    this.clock = 0;
    this.presses = [];
    this.held = { since: null, released: -Infinity, up: 0 };
    this.tapped = { east: 0, north: 0, up: 0 };
    this.sample = groundSample();
    this.local = { x: 0, y: 0, z: 0 };
    this.goal = { x: 0, y: 0 };
  }

  enter() {
    this.sprinting = false;
    this.velocity.east = this.velocity.north = this.velocity.up = 0;
    this.presses.length = 0;
    this.held.since = null;
    this.held.released = -Infinity;
  }

  /**
   * The velocity a double tap of Space hands on to walking (see the top of
   * the file): across as it moves now; up or down as before the taps.
   */
  tapVelocity() {
    const out = this.tapped, h = this.held;
    out.east = this.velocity.east;
    out.north = this.velocity.north;
    let first = null;
    for (let i = 0; i < this.presses.length; i++) {
      const p = this.presses[i];
      if (p.at >= this.clock - TAP.window && (!first || p.at < first.at)) first = p;
    }
    // No press of the taps seen yet (both came between two steps): no climb, a descent kept.
    let up = first ? first.up : Math.min(0, this.velocity.up);
    if (first && first.at >= h.released && first.at - h.released <= TAP.gap) up = h.up;
    out.up = up;
    return out;
  }

  /**
   * One physics step.
   * @param solids  features/solid.js, gathered around the camera this frame,
   *                or null where nothing is solid
   */
  step(dt, keys, pressed, camera, ground, params, solids = null) {
    // Space's presses and holds, for a double tap's switch to walking (tapVelocity).
    this.clock += dt;
    if (pressed & KEY.UP) {
      this.presses.push({ at: this.clock, up: this.velocity.up });
      if (this.presses.length > 3) this.presses.shift();
    }
    const space = (keys & KEY.UP) !== 0, hold = this.held;
    if (space && hold.since == null) hold.since = this.clock;
    else if (!space && hold.since != null) {
      if (this.clock - hold.since >= TAP.held) { hold.released = this.clock; hold.up = this.velocity.up; }
      hold.since = null;
    }

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
    let stride = 0, movedEast = 0, movedNorth = 0;

    if (f !== 0 || r !== 0 || u !== 0) {
      // Diagonals no faster than the axes, up and down included: W with
      // Space goes as fast as W alone, 0.71 of it forward and 0.71 up (until
      // Stage 5.11b only W, A, S and D were held to one, so climbing while
      // moving was 1.41 times as fast).
      const held = Math.hypot(f, r, u);
      if (held > 1) { f /= held; r /= held; u /= held; }
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
      movedEast = dEast;
      movedNorth = dNorth;
      camera.translate(dEast, dNorth, dUp);
    }

    // Solid ground, where it is known accurately. Kept at eye height so
    // switching to walking from a skim lands you standing, not falling.
    let floor = -Infinity;
    if (ground.sample(camera.lon, camera.lat, this.sample) && this.sample.accurate) floor = this.sample.height;
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
    if (dt > 0) {
      this.velocity.east = movedEast / dt;
      this.velocity.north = movedNorth / dt;
      this.velocity.up = (camera.height - params.eyeHeight - feetBefore) / dt;
    }
  }
}
