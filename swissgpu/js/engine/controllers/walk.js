/* walk.js — on foot.
 *
 * A body on the ground with an eye near its top: WASD walks along the
 * heading, Ctrl with W runs, Shift sneaks, Space jumps, and keeps jumping
 * while held. Gravity pulls, the air holds you back as much as your body's
 * shape meets it, slopes steeper than you can climb stop you going up them
 * and slide you down if you stand on one.
 *
 * Buildings and bridges are solid (see features/solid.js): the body is an
 * upright cylinder that walls stop and slide along, that steps up kerbs and
 * stairs, stands on roofs, terraces and bridge decks, and bumps its head on
 * what hangs over it.
 *
 * Deliberately a kinematic character rather than a rigid body: a person does
 * not bounce or tumble, and the controls should feel like a person. They
 * follow Minecraft's (Java Edition) rules tick by tick, 20 ticks a second
 * (Stage 5.12b, his words: "there should be no momentum, during the jump you
 * cannot suddenly stop movement direction, but when finishing jump and
 * starting the next one, check if user was also pressing forward or other
 * keys... exactly like in minecraft"; his answer: Minecraft exactly), at a
 * person's speeds (walking 1.4 m/s, running 4.5; Minecraft's are 4.3 and
 * 5.6, everything scaled with them). Each tick (MC): the keys add speed, on
 * the ground as much as keeps your pace against the ground's friction (0.546
 * of the speed kept a tick: your pace, and a stop, within a quarter of a
 * second, most of the way in the first tenth), in the air a fifth of that
 * against the air's (0.91 a tick: a jump let go of keeps about a third of
 * its speed by the time it lands); a jump starts on a tick that begins on the
 * ground, so between two jumps with Space held there is always one ground
 * tick, where the keys held then decide (none: about half the speed goes
 * on; W: all of it); a running jump gets Minecraft's push forward (on
 * average 1.27 times the run). Between ticks the body moves at the tick's
 * speed, drawn smoothly every frame. The jump itself is a person's (Jump
 * height, real gravity).
 *
 * The air (Stage 5.12b, his words: "remember the character height and
 * width/length. based on surface area normal to direction, calculate how
 * much air resistance slows you down horizontally based on physics"): drag
 * ½ ρ v² Cd A against the way you move, A the body's area facing that way
 * (a box Height × Width × Depth: the front, the side and the top in
 * proportion to how much of the movement is forward, sideways and up),
 * Cd as measured on people (DRAG), ρ the standard atmosphere's at your
 * height, the body your Weight. Thrown from flying or the airplane (Stage
 * 5.10b, his words: "if I'm flying and switch to walking (so falling),
 * character keeps momentum forward"), only the drag slows you until you
 * land, not Minecraft's air rule (it would take 120 m/s away in two
 * seconds): at sea level, thrown forward at 120 m/s, about 67 m/s is left
 * after a second and 34 after three; falling upright tops out near 64 m/s
 * at sea level and 74 m/s at 3,000 m, as fast as freefliers fall feet or
 * head first. Walking and jumping, it is too small to notice, as in real
 * air.
 *
 * Sneaking (Shift, Minecraft's): 30% of your walking speed, eyes and body
 * lower (Minecraft's 1.27 of 1.62 and 1.5 of 1.8, eased in and out in a few
 * ticks), and on the ground you never step off an edge higher than a step:
 * moving towards one, you stop with your middle at it (where the feet
 * stand; a real body falls once that is over nothing) and slide along it.
 * On the terrain, whose cliffs are steep slopes rather than walls, ground
 * too steep to stand on is an edge too. Gravity still slides you off a
 * slope you already stand on that is too steep. Where there is no room to
 * stand up, you stay crouched, and as slow (Minecraft's pose).
 *
 * Only accurate ground is stood on (terrain/ground.js). Where none is known
 * yet, the walker holds still ("waiting for ground"), as at the edge of
 * loaded ground, rather than stand on a coarse stand-in and drop when detail
 * lands. One exception: falling from high above everything loaded, nothing
 * can be hit yet, so the fall carries on until it nears the terrain.
 */

import { KEY } from '../camera.js';
import { DEG } from '../../core/math.js';
import { groundSample } from '../terrain/ground.js';
import { air } from '../aircraft/atmosphere.js';

/* Minecraft's movement (Java Edition; the constants as prismarine-physics
 * has them): a tick's length; the share of the speed kept at the end of a
 * tick on the ground (block slipperiness 0.6 × 0.91) and in the air; the
 * air's acceleration against the ground's (0.02 against 0.1, 0.026 against
 * 0.13 running); a running jump's push forward against a running tick's
 * acceleration (0.2 against 0.13 × 0.98); the keys' share while sneaking;
 * ticks between jumps while Space is held (where a low ceiling cuts a jump
 * short). */
export const MC = { tick: 1 / 20, ground: 0.6 * 0.91, air: 0.91, airShare: 0.2, boost: 0.2 / (0.13 * 0.98), sneak: 0.3, cooldown: 10 };
/* The sneaking pose against standing (Minecraft: eyes 1.27 of 1.62, the body
 * 1.5 of 1.8), eased half the way there each tick, as Minecraft's camera. */
export const CROUCH = { eye: 1.27 / 1.62, body: 1.5 / 1.8, halfLife: MC.tick };
/* Drag coefficients against the box's faces. Broadside (its front or side):
 * 1.0, which puts a standing adult facing the wind at about 0.8 m² of drag
 * area, as measured on people (about 0.74 m² of frontal area, Cd about 1).
 * Feet first: far more than the top's small area alone, the limbs and
 * clothes catching the air too; fitted to freefliers falling head or feet
 * first at about 260 km/h (72 m/s) at jump heights, about 3,000 m. */
export const DRAG = { broadside: 1.0, end: 2.4 };
/* Thrown fast (a flight's speed kept), no part of a step moves farther than
 * this, metres: a faster step is cut into equal parts, each checked against
 * the ground and the walls, so nothing is jumped over between two checks.
 * At most so many parts (1,000 m/s at 120 steps a second takes 5). */
const STRIDE_MOST = 2;
const STRIDES_MOST = 64;
/* Arriving somewhere new: how quickly the eye glides onto each better
 * estimate of the ground, and how long to wait for the final one before
 * standing on whatever is known. */
const ARRIVE_RESPONSE = 8;
const ARRIVE_SNAP = 30;
const ARRIVE_PATIENCE = 12;
/* Arriving over a roof (a flight's landing where no open ground was near, or
 * a walk resumed up there), the feet settle onto it, not onto the ground
 * inside: a built surface counts up to this far above the feet as placed. */
const ARRIVE_ROOF = 0.5;
/* Sneaking at an edge: how finely the part of a step that stays supported is
 * found (halvings: a 128th of the step). */
const EDGE_HALVINGS = 7;

/* The body, for colliding with buildings: shoulders a little narrower than a
 * doorway is wide, and the highest ledge climbed without a jump, about a
 * kerb or a generous stair. */
export const BODY_RADIUS = 0.3;
export const STEP_HEIGHT = 0.4;

/* The body's size and weight when the settings say nothing (Character →
 * Body): an adult's shoulders, chest and weight. */
export const BODY = { width: 0.45, depth: 0.28, mass: 75 };

export class WalkController {
  constructor() {
    this.vEast = 0;           // the speed moved at this tick, metres a second
    this.vNorth = 0;
    this.vUp = 0;
    this.slide = 0;           // speed down a too-steep slope
    this.grounded = false;
    this.running = false;
    this.sneaking = false;    // Shift held: crouched, and never off an edge
    this.crouched = false;    // in the crouching pose (Shift, or no room to stand up): slow, no running
    this.crouch = 0;          // 0 standing .. 1 the sneaking pose
    this.eye = null;          // the eye's height over the feet now (null: not walked yet)
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
    this.jumpQueued = false;  // a press waiting for the next tick
    this.cooldown = 0;        // ticks until the next jump while Space is held
    this.jumps = 0;           // take-offs so far, for the probe
    this.thrown = false;      // in the air with a flight's speed: only the drag slows it
    this.tickClock = MC.tick; // seconds into the current tick (a whole one: the next step starts a tick)
    this.tickInertia = MC.ground;  // what the current tick keeps of its speed at its end
    this.edgeStops = 0;       // steps cut short at an edge while sneaking, for the probe
    this.contacts = [];       // wall push directions this step, x y pairs
    this.here = groundSample();
    this.ahead = groundSample();
    this.edge = groundSample();
    this.target = { lon: 0, lat: 0 };
    this.spot = { lon: 0, lat: 0 };
    this.local = { x: 0, y: 0, z: 0 };
    this.goal = { x: 0, y: 0 };
    this.air = {};
  }

  /**
   * Taking over from flight: keep the position and the flight's `velocity`
   * ({ east, north, up }, metres a second: all of it, across and up or down,
   * Stage 5.13b, his words: "if I'm flying and go into walk mode, also
   * consider vertical momentum"; a double tap of Space hands on what you
   * did before the taps, fly.js), and rise and fall with it if there is air
   * underneath, slowed by the air's drag only until you land (`thrown`).
   * With `arrive`, the camera was placed here and settles onto the ground
   * instead, without a fall, then out of any building it landed in.
   */
  enter({ arrive = false, velocity = null } = {}) {
    this.vEast = this.vNorth = this.vUp = this.slide = 0;
    this.thrown = false;
    if (velocity && !arrive) {
      this.vEast = velocity.east;
      this.vNorth = velocity.north;
      this.vUp = velocity.up;
      this.thrown = true;
    }
    this.grounded = false;
    // Standing up: the camera is the eye, and the feet a standing eye below.
    this.crouch = 0;
    this.crouched = this.sneaking = false;
    this.eye = null;
    this.takeoff = this.peak = -Infinity;
    this.jumpArmed = false;
    this.jumpQueued = false;
    this.cooldown = 0;
    this.tickClock = MC.tick;
    this.tickInertia = this.thrown ? 1 : MC.air;
    this.arriving = arrive;
    this.arriveTime = 0;
    this.clearing = false;
    this.cleared = false;
    this.clearTime = 0;
    this.clearedBy = null;    // metres moved to get clear of buildings, once known
  }

  get speed() { return Math.hypot(this.vEast, this.vNorth); }

  get falling() { return !this.grounded && this.vUp < -3; }

  /* The eye's and the body's heights now, for a pose between standing and sneaking. */
  eyeHeight(p) { return p.eyeHeight * (1 - (1 - CROUCH.eye) * this.crouch); }
  bodyHeight(p) { return p.bodyHeight * (1 - (1 - CROUCH.body) * this.crouch); }

  #jump(feet, p, camera) {
    this.vUp = Math.sqrt(2 * p.gravity * p.jumpHeight);
    this.grounded = false;
    this.jumpArmed = true;
    this.jumpQueued = false;
    this.cooldown = MC.cooldown;
    this.jumps++;
    this.takeoff = this.peak = feet;
    // Minecraft's running jump: a push forward, the way you face.
    if (this.running) {
      const push = MC.boost * p.runSpeed * (1 - MC.ground);
      this.vEast += push * Math.sin(camera.yaw);
      this.vNorth += push * Math.cos(camera.yaw);
    }
  }

  /*
   * While arriving, the eye stays where it was put (the saved height when a
   * walking session resumes, the placement's guess otherwise) until accurate
   * ground is indexed under it: estimates from coarser tiles are ignored,
   * since over mountains they can be kilometres off and would only lift the
   * eye and drop it again. Then it glides onto the ground, or jumps if the
   * guess was far off, and stands once the tile drawn under it is as
   * detailed as the view asks for and indexed. Where buildings are solid, it
   * then waits for the render thread to move it clear of them (`clearing`),
   * and settles again wherever that is.
   */
  #arrive(dt, camera, ground, p, solids) {
    this.arriveTime += dt;
    const eyeOver = this.eyeHeight(p);
    this.eye = eyeOver;
    if (!ground.sample(camera.lon, camera.lat, this.here) || !this.here.accurate) {
      this.waiting = true;
      this.aboveGround = null;
      return;
    }
    let floor = this.here.height;
    if (solids?.active) {
      const at = solids.toLocal(camera.lon, camera.lat, camera.height - eyeOver, this.local);
      const built = solids.floor(at.x, at.y, at.z + ARRIVE_ROOF) + solids.origin.height;
      if (built > floor) floor = built;
    }
    const eye = floor + eyeOver;
    const close = Math.abs(camera.height - eye) < 0.25;
    if ((close && ground.settled(camera.lon, camera.lat)) || this.arriveTime > ARRIVE_PATIENCE) {
      camera.setHeight(eye);
      this.waiting = false;
      this.aboveGround = eyeOver;
      if (solids && !this.cleared) {
        this.clearing = true;
        this.clearTime += dt;
        return;
      }
      this.arriving = false;
      this.clearing = false;
      this.grounded = true;
      this.tickInertia = MC.ground;
      return;
    }
    // A first estimate far off is jumped to rather than dived towards; the
    // small corrections as finer tiles land are glided.
    const gap = eye - camera.height;
    camera.setHeight(Math.abs(gap) > ARRIVE_SNAP ? eye
      : camera.height + gap * (1 - Math.exp(-ARRIVE_RESPONSE * dt)));
    this.waiting = false;
    this.aboveGround = camera.height - floor;
  }

  /**
   * One physics step.
   * @param solids  features/solid.js, gathered around the camera this frame,
   *                or null where nothing is solid
   */
  step(dt, keys, pressed, camera, ground, p, solids = null) {
    if (this.arriving) { this.#arrive(dt, camera, ground, p, solids); return; }
    // The air here, once a step (its density hardly changes within one).
    air(camera.height, this.air);
    const reach = Math.hypot(this.vEast, this.vNorth, this.vUp) * dt;
    const n = reach > STRIDE_MOST ? Math.min(STRIDES_MOST, Math.ceil(reach / STRIDE_MOST)) : 1;
    // A press acts once, on the first part.
    for (let i = 0; i < n; i++) this.#move(dt / n, keys, i === 0 ? pressed : 0, camera, ground, p, solids);
  }

  /*
   * The start of a Minecraft tick: what the last one keeps of its speed (its
   * friction, decided by where it began), a jump if the tick begins on the
   * ground with Space held (or pressed since the last tick), and the keys'
   * acceleration, the ground's or the air's (thrown: towards your pace only,
   * never taking away what a flight gave you unless you press against it).
   */
  #tick(keys, camera, feet, p, f, r) {
    this.vEast *= this.tickInertia;
    this.vNorth *= this.tickInertia;
    // Where the tick begins decides its rules, a jump's tick the ground's.
    const ground = this.grounded;
    const space = (keys & KEY.UP) !== 0;
    if (space) { if (this.cooldown > 0) this.cooldown--; } else this.cooldown = 0;
    if (ground && this.jumpArmed && (space || this.jumpQueued) && this.cooldown === 0) this.#jump(feet, p, camera);
    this.jumpQueued = false;
    const pace = this.running ? p.runSpeed : p.walkSpeed;
    const share = this.crouched ? MC.sneak : 1;
    const accel = pace * (1 - MC.ground) * share * (ground ? 1 : MC.airShare);
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
    const ue = f * sy + r * cy, un = f * cy - r * sy, push = Math.hypot(ue, un);
    if (push > 0) {
      if (this.thrown && !ground) {
        // Thrown: speed added towards where you press, up to your pace that way.
        const along = (this.vEast * ue + this.vNorth * un) / push;
        const add = Math.min(accel * push, Math.max(0, pace * share * push - along));
        this.vEast += (ue / push) * add;
        this.vNorth += (un / push) * add;
      } else {
        this.vEast += ue * accel;
        this.vNorth += un * accel;
      }
    }
    this.tickInertia = ground ? MC.ground : this.thrown ? 1 : MC.air;
  }

  /* The drag's rate, 1/s per m/s of speed: ½ ρ Cd A / m with the body's area
   * facing the way (vE, vN, vU) goes, a box Height × Width × Depth facing the
   * way the camera does. */
  #dragRate(vE, vN, vU, yaw, p) {
    const speed = Math.hypot(vE, vN, vU);
    if (!(speed > 1e-6)) return 0;
    const h = this.bodyHeight(p), w = p.bodyWidth ?? BODY.width, d = p.bodyDepth ?? BODY.depth;
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const forward = Math.abs(vE * sy + vN * cy), across = Math.abs(vE * cy - vN * sy), up = Math.abs(vU);
    const cdA = (DRAG.broadside * (h * w * forward + h * d * across) + DRAG.end * w * d * up) / speed;
    return (0.5 * (this.air.density ?? 1.225) * cdA) / (p.bodyMass ?? BODY.mass);
  }

  /* Whether the body, moved (east, north) metres with its feet at `feet`,
   * would stand where the steps below stand it (its middle): on a built
   * floor no more than a step below the feet, or on accurate terrain no more
   * than a step below that is not too steep to stand on. */
  #supported(east, north, feet, camera, ground, solid, p) {
    const low = feet - STEP_HEIGHT;
    if (solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      if (solid.floor(at.x + east, at.y + north, at.z + STEP_HEIGHT) + solid.origin.height >= low) return true;
    }
    camera.offsetLonLat(east, north, this.spot);
    const g = this.edge;
    return ground.sample(this.spot.lon, this.spot.lat, g) && g.accurate && g.height >= low &&
      Math.atan(Math.hypot(g.gradE, g.gradN)) <= p.maxSlope;
  }

  /* The share of the move (east, north) that keeps the body supported, the
   * largest found in EDGE_HALVINGS halvings (as Minecraft backs off an edge
   * in 0.05-block steps). */
  #reach(east, north, feet, camera, ground, solid, p) {
    if (east === 0 && north === 0) return 0;
    if (this.#supported(east, north, feet, camera, ground, solid, p)) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < EDGE_HALVINGS; i++) {
      const mid = (lo + hi) / 2;
      if (this.#supported(east * mid, north * mid, feet, camera, ground, solid, p)) lo = mid; else hi = mid;
    }
    return lo;
  }

  #move(dt, keys, pressed, camera, ground, p, solids) {
    // The pose first: the eye eases down while sneaking, back up after
    // (unless there is no room to stand up), the feet staying put.
    const solid = solids?.active ? solids : null;
    const wasEye = this.eye ?? this.eyeHeight(p);
    let feet = camera.height - wasEye;
    this.sneaking = (keys & KEY.DOWN) !== 0;
    let goal = this.sneaking ? 1 : 0;
    if (!this.sneaking && this.crouch > 0 && solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      if (solid.ceiling(at.x, at.y, at.z + this.bodyHeight(p) - 0.05) + solid.origin.height < feet + p.bodyHeight) goal = 1;
    }
    this.crouched = goal === 1;
    this.crouch += (goal - this.crouch) * (1 - Math.pow(0.5, dt / CROUCH.halfLife));
    if (Math.abs(goal - this.crouch) < 1e-4) this.crouch = goal;
    const eye = this.eyeHeight(p), body = this.bodyHeight(p);
    this.eye = eye;

    // Nothing accurate known underfoot: hold still rather than stand on a
    // stand-in or fall through the world. Unless falling from above the
    // highest the terrain here can be: then there is nothing to hit yet.
    const known = ground.sample(camera.lon, camera.lat, this.here) && this.here.accurate;
    const clearAir = !known && !this.grounded && feet > ground.highest(camera.lon, camera.lat);
    if (!known && !clearAir) {
      this.waiting = true;
      this.aboveGround = null;
      // Held in the air while the ground loads (switching from flying over
      // ground not known yet): the air still takes the flight's speed away
      // as it would across, so nothing is kept to shoot off with once the
      // ground arrives (Stage 5.10b, his words: "when flying normally and
      // going to walk mode, count air resistance!").
      if (!this.grounded) {
        const slow = 1 / (1 + this.#dragRate(this.vEast, this.vNorth, 0, camera.yaw, p) * this.speed * dt);
        this.vEast *= slow;
        this.vNorth *= slow;
      }
      camera.setHeight(feet + eye);
      return;
    }
    this.waiting = false;

    /* ---- where you want to go ---- */
    let f = 0, r = 0;
    if (keys & KEY.FORWARD) f += 1;
    if (keys & KEY.BACK) f -= 1;
    if (keys & KEY.RIGHT) r += 1;
    if (keys & KEY.LEFT) r -= 1;
    // Diagonals no faster than straight on: two keys make one unit of push.
    const held = Math.hypot(f, r);
    if (held > 1) { f /= held; r /= held; }
    // Running is Ctrl with W (Minecraft's sprint: forward only, never crouched).
    this.running = (keys & KEY.SPRINT) !== 0 && f > 0 && !this.crouched;

    /* ---- Minecraft's ticks ---- */
    if (!(keys & KEY.UP)) this.jumpArmed = true;
    if (pressed & KEY.UP) this.jumpQueued = true;
    // Each time a tick's length has gone by (and on the first step).
    this.tickClock += dt;
    if (this.tickClock >= MC.tick) {
      this.tickClock %= MC.tick;
      this.#tick(keys, camera, feet, p, f, r);
    }

    /* ---- too steep to stand on: slide down it ---- */
    let moveEast = this.vEast * dt, moveNorth = this.vNorth * dt;
    const grade = Math.hypot(this.here.gradE, this.here.gradN);
    const angle = Math.atan(grade);
    const steep = this.grounded && !this.onStructure && angle > p.maxSlope && grade > 0;
    if (steep) {
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
    // In clear air there is no ground to check against, near or ahead.
    if (known && (moveEast !== 0 || moveNorth !== 0)) {
      camera.offsetLonLat(moveEast, moveNorth, this.target);
      if (!ground.sample(this.target.lon, this.target.lat, this.ahead) || !this.ahead.accurate) {
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

    /* ---- sneaking: never off an edge ---- */
    // Minecraft's back-off: the move along each way on its own as far as the
    // body stays supported, then both together; the speed cut short is lost.
    // Not on a slope too steep to stand on: that slides you whatever you do.
    const guard = this.sneaking && this.grounded && !steep;
    if (guard && (moveEast !== 0 || moveNorth !== 0) &&
        !this.#supported(moveEast, moveNorth, feet, camera, ground, solid, p)) {
      const se = this.#reach(moveEast, 0, feet, camera, ground, solid, p);
      const sn = this.#reach(0, moveNorth, feet, camera, ground, solid, p);
      let e = moveEast * se, nn = moveNorth * sn;
      const both = this.#reach(e, nn, feet, camera, ground, solid, p);
      e *= both; nn *= both;
      if (Math.abs(e) < Math.abs(moveEast) - 1e-9) this.vEast = 0;
      if (Math.abs(nn) < Math.abs(moveNorth) - 1e-9) this.vNorth = 0;
      moveEast = e; moveNorth = nn;
      this.edgeStops++;
    }

    /* ---- buildings: walls stop you, and you slide along them ---- */
    if (solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      const goal2 = this.goal;
      goal2.x = at.x + moveEast; goal2.y = at.y + moveNorth;
      this.contacts.length = 0;
      // Walls count from a step above the feet to the top of the head.
      solid.sweep(at, goal2, BODY_RADIUS, at.z + STEP_HEIGHT, at.z + body, this.contacts);
      moveEast = goal2.x - at.x;
      moveNorth = goal2.y - at.y;
      // Speed into a wall is lost; along it, kept.
      for (let i = 0; i < this.contacts.length; i += 2) {
        const nx = this.contacts[i], ny = this.contacts[i + 1];
        const into = this.vEast * nx + this.vNorth * ny;
        if (into < 0) { this.vEast -= into * nx; this.vNorth -= into * ny; }
      }
      // A wall turned the move: sneaking, never onto nothing even so.
      if (guard && this.contacts.length > 0 && (moveEast !== 0 || moveNorth !== 0) &&
          !this.#supported(moveEast, moveNorth, feet, camera, ground, solid, p)) {
        moveEast = moveNorth = 0;
        this.edgeStops++;
      }
    }

    if (moveEast !== 0 || moveNorth !== 0) {
      camera.translate(moveEast, moveNorth, 0);
      if (known && (!ground.sample(camera.lon, camera.lat, this.here) || !this.here.accurate)) {
        camera.translate(-moveEast, -moveNorth, 0);
        camera.setHeight(feet + eye);
        return;
      }
    }

    /* ---- vertical ---- */
    // The floor is the terrain, or whatever built surface is higher and no
    // more than a step above the feet: a roof you landed on, a bridge deck,
    // a stair you walked into. In clear air, only a built one.
    let floor = known ? this.here.height : -Infinity;
    let ceiling = Infinity;
    this.onStructure = false;
    if (solid) {
      const at = solid.toLocal(camera.lon, camera.lat, feet, this.local);
      const base = solid.origin.height;
      const built = solid.floor(at.x, at.y, at.z + STEP_HEIGHT) + base;
      if (built > floor) { floor = built; this.onStructure = true; }
      if (!this.grounded && this.vUp > 0) {
        ceiling = solid.ceiling(at.x, at.y, at.z + body - 0.05) + base;
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
      // Gravity, less the drag against the way the body goes (all of it,
      // across too): ½ ρ v² Cd A over the body's weight.
      const k = this.#dragRate(this.vEast, this.vNorth, this.vUp, camera.yaw, p);
      const drag = k * Math.hypot(this.vEast, this.vNorth, this.vUp);
      const accel = -p.gravity - drag * this.vUp;
      // Across, the drag is exact over the step for a steady speed (it
      // never reverses a slow drift).
      const slow = 1 / (1 + drag * dt);
      this.vEast *= slow;
      this.vNorth *= slow;
      // Position from the start-of-step velocity plus half the acceleration:
      // exact for constant acceleration, so a jump peaks at the height asked
      // for rather than half a step's worth of velocity short of it.
      feet += this.vUp * dt + 0.5 * accel * dt * dt;
      this.vUp += accel * dt;
      if (feet + body > ceiling) {
        // Head against something: stop rising and fall back.
        feet = ceiling - body;
        this.vUp = Math.min(this.vUp, 0);
      }
      if (feet > this.peak) this.peak = feet;
      if (feet <= floor) {
        feet = floor;
        this.vUp = 0;
        this.grounded = true;
        this.thrown = false;
        if (Number.isFinite(this.takeoff)) this.lastJump = this.peak - this.takeoff;
      }
    }

    camera.setHeight(feet + eye);
    this.aboveGround = Number.isFinite(floor) ? camera.height - floor : null;
  }
}
