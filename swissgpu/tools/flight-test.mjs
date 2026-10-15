/* flight-test.mjs — the search flight, checked without a browser.
 *
 *   node tools/flight-test.mjs [--count 2000] [--seed 1] [--verbose]
 *
 * Never loaded by the app. Plans flights through stand-in worlds whose
 * heights are known exactly (a height field with a pyramid of maxima for
 * its bound, boxes for buildings, straight ropes for cable cars), plays
 * every plan back at 500 Hz and checks what the flight promises (Stage 5.5):
 *
 *   never closer than a metre to anything (the ground, a roof, a rope);
 *   starts exactly where and how the camera is, ends exactly on the spot,
 *   facing the start heading, tilted as it was, level;
 *   the camera is the path (Stage 5.7): wherever the view is on it (all but
 *   its turn from your view at the start and back at the end), it looks the
 *   way it moves, within a degree, whenever it moves along more than up or
 *   down, and up and down along it, within VIEW_ALONG (VIEW.most at most),
 *   however fast that changes (a little more sweeping through fast bends);
 *   a hop keeps your view, turning it evenly onto the end's;
 *   an S (Stage 5.7): the heading turning all the way from the first curve's
 *   start to the second's end, through no turning only for an instant at the
 *   middle, where it turns the other way (5.6 stood still there);
 *   on the path, neither the path nor the view turns faster than TURN.rate,
 *   nor does the turning change faster than TURN.accel (a little over,
 *   measured between samples), both times how much the flight is played
 *   faster;
 *   one bell: starts and ends at rest, its pace (heights above the ground a
 *   second) no faster than the trip allows, never jumps; along the cruise,
 *   its speed in metres a second rises to one top and falls (Stage 5.7: no
 *   slowing down over a mountain); seen from the side, it rises, flies and
 *   comes down, never up and down again (no little height corrections);
 *   never banks more than the setting, curves and lean together; never
 *   takes longer than Longest flight, nor less than DURATION.least as
 *   played; turns TURN.max at most.
 *
 * Then the small tools it is made of against brute force, the plane's
 * round trip, the app's own bounds (a tile's grid of highest points, the
 * terrain's bound, a building layer's), named cases from the sketches the
 * flight was drawn from (over flat ground, the pace one bell whose peak is
 * halfway), a few thousand random flights from a metre to 500 km, and the
 * runtime (engine/flight/flight.js) driving a real Camera through a
 * stand-in of the app's world: a landing spot known at once, found on the
 * way, found late (the descent slows for it), never found; better ground
 * at the place found on the way; a place slow to load; Longest flight. In
 * every one the camera arrives exactly and never jumps.
 */

import { planFlight, DEFAULT_SETTINGS, VIEW } from '../js/engine/flight/plan.js';
import { PACE, DURATION, bell } from '../js/engine/flight/timing.js';
import { Flight, GROUND_EXACT, WAIT } from '../js/engine/flight/flight.js';
import { TURN, sTurned } from '../js/engine/flight/route.js';
import { runningMax, slopeLimitAbove, gaussianBlur, lastAtOrBelow, smoothstep, smoothstepArea, smootherstep, roundedAbove }
  from '../js/core/signal.js';
import { Plane, wrapAngle } from '../js/core/geo.js';
import { Camera } from '../js/engine/camera.js';
import { DEG, radiiAt } from '../js/core/math.js';
import { topsGrid, TOPS } from '../js/formats/tops.js';
import { Terrain, READY, UNLOADED, geometricError } from '../js/engine/terrain/terrain.js';
import { tileRect, tileAt } from '../js/engine/terrain/tiling.js';
import { Tileset, contentRecord } from '../js/engine/features/tileset.js';
import { buildIndex } from '../js/formats/tileset-index.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const COUNT = Number(args.count ?? 2000);
const SEED = Number(args.seed ?? 1);
const VERBOSE = Boolean(args.verbose);
const ONLY = args.only != null ? Number(args.only) : null;   // one random flight, with its inputs printed
const TIMELINE = Boolean(args.timeline);                     // ... and its height, slope, tilt and bank over time
const EYE = 1.75 * 0.936;
/* On the path, the view's tilt against the slope it moves along, measured
 * over 2 ms: within VIEW_ALONG.steady, and within VIEW_ALONG.bend where the
 * path bends up or down faster than VIEW_ALONG.fast (as played): the plan
 * smooths its slopes over a few samples (FLIGHT.headingBlur), so where a
 * climb bends from straight up into the cruise within a fraction of a
 * second the view sweeps through the bend a little ahead of it. */
const VIEW_ALONG = { steady: 8 * DEG, bend: 15 * DEG, fast: 60 * DEG };
/* Seen from the side, a rise or fall smaller than this is not a turn of the
 * height. Along the cruise (where it flies within LEVEL of level), the speed
 * may dip this share under its rise (or rise over its fall) between samples;
 * where it climbs or comes down, a step of σ covers up to PACE.zoom times
 * more metres the steeper it is, so its metres a second are not one bell
 * there by design. */
const HEIGHT_TURN = 0.1, SPEED_DIP = 0.02, LEVEL = 3 * DEG;

let failures = 0;
const report = (name, ok, detail) => {
  if (!ok) failures++;
  if (!ok || VERBOSE) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

/* mulberry32: a small, good, seedable random source. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- a world whose heights are known --------------------------------------- */

/*
 * A height field on a grid (bilinear between nodes, so a cell's highest
 * point is its highest corner), a pyramid of cell maxima for bounds, boxes
 * standing on it (buildings) and straight ropes over it. Coordinates are a
 * plane's: x east, y north, metres.
 */
class World {
  constructor({ cx = 0, cy = 0, half = 1000, n = 256, height = () => 0, boxes = [], ropes = [] }) {
    this.n = n;
    this.cell = (2 * half) / n;
    this.x0 = cx - half;
    this.y0 = cy - half;
    const N = n + 1;
    this.h = new Float64Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) this.h[j * N + i] = height(this.x0 + i * this.cell, this.y0 + j * this.cell);
    let level = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const h = this.h;
      level[j * n + i] = Math.max(h[j * N + i], h[j * N + i + 1], h[(j + 1) * N + i], h[(j + 1) * N + i + 1]);
    }
    this.levels = [level];
    for (let size = n; size > 1; size >>= 1) {
      const half2 = size >> 1, next = new Float64Array(half2 * half2);
      for (let j = 0; j < half2; j++) for (let i = 0; i < half2; i++) {
        next[j * half2 + i] = Math.max(level[2 * j * size + 2 * i], level[2 * j * size + 2 * i + 1],
          level[(2 * j + 1) * size + 2 * i], level[(2 * j + 1) * size + 2 * i + 1]);
      }
      this.levels.push(next);
      level = next;
    }
    this.boxes = boxes;
    this.ropes = ropes;
  }

  ground(x, y) {
    const n = this.n, N = n + 1;
    let u = (x - this.x0) / this.cell, v = (y - this.y0) / this.cell;
    u = Math.max(0, Math.min(n, u));
    v = Math.max(0, Math.min(n, v));
    const i = Math.min(n - 1, Math.floor(u)), j = Math.min(n - 1, Math.floor(v)), fu = u - i, fv = v - j, h = this.h;
    const a = h[j * N + i], b = h[j * N + i + 1], c = h[(j + 1) * N + i], d = h[(j + 1) * N + i + 1];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  }

  /* The highest ground within the square of half-size r (an upper bound). */
  groundBound(x, y, r) {
    const n = this.n, cl = (v) => Math.max(0, Math.min(n - 1, v));
    let i0 = cl(Math.floor((x - r - this.x0) / this.cell)), i1 = cl(Math.floor((x + r - this.x0) / this.cell));
    let j0 = cl(Math.floor((y - r - this.y0) / this.cell)), j1 = cl(Math.floor((y + r - this.y0) / this.cell));
    let L = 0;
    while ((i1 >> L) - (i0 >> L) > 1 || (j1 >> L) - (j0 >> L) > 1) L++;
    const size = n >> L, level = this.levels[L];
    let best = -Infinity;
    for (let j = j0 >> L; j <= j1 >> L; j++) for (let i = i0 >> L; i <= i1 >> L; i++) best = Math.max(best, level[j * size + i]);
    return best;
  }

  bound(x, y, r) {
    let best = this.groundBound(x, y, r);
    for (const b of this.boxes) {
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1);
      if (dx * dx + dy * dy <= r * r && b.top > best) best = b.top;
    }
    for (const rope of this.ropes) if (planDistance(rope, x, y).d <= r) best = Math.max(best, rope.z0, rope.z1);
    return best;
  }

  /* What is really under a point: ground, or a roof. */
  truth(x, y) {
    let h = this.ground(x, y);
    for (const b of this.boxes) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && b.top > h) h = b.top;
    return h;
  }

  /* Metres between a point and the nearest thing: what is under it, and
   * any rope it is right over or under (ropes are thin). */
  clearance(x, y, z) {
    let c = z - this.truth(x, y);
    for (const rope of this.ropes) {
      const { d, t } = planDistance(rope, x, y);
      if (d < 1) c = Math.min(c, Math.abs(z - (rope.z0 + (rope.z1 - rope.z0) * t)));
    }
    return c;
  }
}

function planDistance(rope, x, y) {
  const ex = rope.x1 - rope.x0, ey = rope.y1 - rope.y0, l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((x - rope.x0) * ex + (y - rope.y0) * ey) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = rope.x0 + ex * t - x, py = rope.y0 + ey * t - y;
  return { d: Math.sqrt(px * px + py * py), t };
}

/* ---- playing a plan back ----------------------------------------------------- */

const stats = { closest: Infinity, durations: [], planMs: [], flights: 0, viewOff: 0, accel: 0 };

/*
 * Plans a flight in `world` and checks it (see the top of the file).
 * Returns the plan, or null when it failed to plan.
 */
function check(name, world, { from, to, settings = DEFAULT_SETTINGS, maxPeak = Infinity, maxTime = Infinity, ground = null,
  maxCompress = Infinity, maxClimbShare = 1, glide }) {
  const bound = (x, y, r) => world.bound(x, y, r);
  const t0 = performance.now();
  const plan = planFlight({ from, to, bound, ground: ground ?? bound, settings, endPitch: from.pitch });
  stats.planMs.push(performance.now() - t0);
  if (!plan) { report(name, false, 'no plan'); return null; }
  const problems = [];
  const pose = {};
  const dt = 1 / 500, T = plan.duration, c = plan.compress;
  let closest = Infinity, top = -Infinity, fastestTurn = 0, fastestView = 0, viewAccel = 0, mostBank = 0, worstJump = 0;
  let viewOff = 0, viewOffAt = 0, mostHopTurn = 0, prev = null, rates = [];
  // The tilt: fastest (no limit: the camera is the path), steepest (on the
  // path, and anywhere), and how far off the path's slope on the path.
  let fastestPitch = 0, steepest = 0, steepestAnywhere = 0, pitchOff = 0, pitchOffAt = 0, bendOff = 0, bendOffAt = 0;
  const topSpeed = Math.max(...plan.speed);
  for (let k = 0; ; k++) {
    const t = Math.min(T, k * dt);
    plan.at(t, pose);
    closest = Math.min(closest, world.clearance(pose.x, pose.y, pose.height));
    top = Math.max(top, pose.height);
    mostBank = Math.max(mostBank, Math.abs(pose.roll));
    steepestAnywhere = Math.max(steepestAnywhere, Math.abs(pose.pitch));
    const on = pose.onPath === 1;
    if (on) steepest = Math.max(steepest, Math.abs(pose.pitch));
    if (plan.kind === 'hop') mostHopTurn = Math.max(mostHopTurn, Math.abs(wrapAngle(pose.yaw - from.heading)));
    if (prev) {
      const step = t - prev.t, both = on && prev.on;
      if (step > 0) {
        fastestTurn = Math.max(fastestTurn, Math.abs(wrapAngle(pose.heading - prev.heading)) / step);
        const rate = wrapAngle(pose.yaw - prev.yaw) / step;
        if (both) fastestView = Math.max(fastestView, Math.abs(rate));
        fastestPitch = Math.max(fastestPitch, Math.abs(pose.pitch - prev.pitch) / step);
        if (k % 5 === 0 && both) rates.push({ k, t, rate });
        const fx = pose.x - prev.x, fy = pose.y - prev.y, flat = Math.hypot(fx, fy), dh = pose.height - prev.height, up = Math.abs(dh);
        worstJump = Math.max(worstJump, Math.hypot(flat, up) / (topSpeed * step + 1e-9));
        // On the path, the view along the way it moves, wherever it moves
        // along, against the view halfway through the step (the step's chord
        // is the motion's direction there) ...
        if (both && flat > 1e-4 && flat > 0.2 * up) {
          const off = Math.abs(wrapAngle(prev.yaw + wrapAngle(pose.yaw - prev.yaw) / 2 - Math.atan2(fx, fy)));
          if (off > viewOff) { viewOff = off; viewOffAt = t; }
        }
        // ... and up and down along it (sweeping through fast bends).
        if (both && Math.hypot(flat, up) > 1e-5) {
          const slope = Math.max(-VIEW.most, Math.min(VIEW.most, Math.atan2(dh, flat)));
          const off = Math.abs((pose.pitch + prev.pitch) / 2 - slope);
          if (Math.abs(pose.pitch - prev.pitch) / step > VIEW_ALONG.fast * c) { if (off > bendOff) { bendOff = off; bendOffAt = t; } }
          else if (off > pitchOff) { pitchOff = off; pitchOffAt = t; }
        }
      }
    }
    prev = { t, on, x: pose.x, y: pose.y, heading: pose.heading, yaw: pose.yaw, height: pose.height, pitch: pose.pitch };
    if (t >= T) break;
  }
  // How fast the view's turning changes on the path: its rate over a
  // hundredth of a second, compared five hundredths apart (finer is the
  // samples' noise).
  let accelAt = 0;
  for (let i = 5; i < rates.length; i++) {
    if (rates[i].k - rates[i - 5].k !== 25) continue;
    const a = Math.abs(rates[i].rate - rates[i - 5].rate) / (rates[i].t - rates[i - 5].t);
    if (a > viewAccel) { viewAccel = a; accelAt = rates[i].t; }
  }
  // The plan's own samples, and between them, exactly.
  for (let i = 0; i < plan.m; i++) {
    closest = Math.min(closest, world.clearance(plan.x[i], plan.y[i], plan.h[i]));
    if (i > 0) {
      closest = Math.min(closest, world.clearance((plan.x[i] + plan.x[i - 1]) / 2, (plan.y[i] + plan.y[i - 1]) / 2,
        (plan.h[i] + plan.h[i - 1]) / 2));
    }
  }
  plan.at(0, pose);
  if (Math.hypot(pose.x - from.x, pose.y - from.y) > 1e-6 || Math.abs(pose.height - from.height) > 1e-6) problems.push('does not start at the camera');
  if (Math.abs(wrapAngle(pose.yaw - from.heading)) > 1e-9 || Math.abs(pose.pitch - from.pitch) > 1e-9 || Math.abs(pose.roll) > 1e-9) {
    problems.push(`starts turned (${(wrapAngle(pose.yaw - from.heading) / DEG).toFixed(4)}°, pitch ${pose.pitch}, roll ${pose.roll})`);
  }
  if (plan.speed[0] !== 0 || plan.speed[plan.m - 1] !== 0) problems.push('does not start and end at rest');
  plan.at(T, pose);
  const endOff = Math.hypot(pose.x - to.x, pose.y - to.y);
  if (endOff > 1e-6) problems.push(`ends ${endOff.toExponential(2)} m off`);
  if (Math.abs(pose.height - plan.endHeight) > 1e-6) problems.push(`ends ${(pose.height - plan.endHeight).toExponential(2)} m off in height`);
  if (to.exact && Math.abs(plan.endHeight - to.height) > 1e-9) problems.push('an exact end was moved');
  if (Math.abs(wrapAngle(pose.yaw - to.heading)) > 1e-9) problems.push(`ends facing ${(wrapAngle(pose.yaw - to.heading) / DEG).toExponential(2)}° off`);
  if (Math.abs(pose.pitch - from.pitch) > 1e-9 || Math.abs(pose.roll) > 1e-9) problems.push(`ends tilted (pitch ${pose.pitch - from.pitch}, roll ${pose.roll})`);
  if (closest < 1) problems.push(`comes within ${closest.toFixed(2)} m of something`);
  const turnLimit = TURN.rate * c * 1.05 + 1e-6, accelLimit = TURN.accel * c * c * 1.3 + 1e-6;
  if (fastestTurn > turnLimit) problems.push(`the path turns at ${(fastestTurn / DEG).toFixed(1)}°/s (limit ${(turnLimit / DEG).toFixed(1)})`);
  if (fastestView > turnLimit) problems.push(`the view turns at ${(fastestView / DEG).toFixed(1)}°/s (limit ${(turnLimit / DEG).toFixed(1)})`);
  if (viewAccel > accelLimit) {
    plan.at(accelAt, pose);
    problems.push(`the view's turning changes at ${(viewAccel / DEG).toFixed(1)}°/s² (limit ${(accelLimit / DEG).toFixed(1)}) ` +
      `at ${(100 * accelAt / T).toFixed(1)}% (piece ${pose.piece}, ${(pose.height - from.height).toFixed(1)} m up; ` +
      `plan says ${(plan.peakTurnAccel / DEG).toFixed(1)}°/s², x${c.toFixed(2)}, ${plan.route.word} ${plan.route.turns.map((a) => (a / DEG).toFixed(0))})`);
  }
  if (viewOff > 1 * DEG) {
    plan.at(viewOffAt, pose);
    problems.push(`looks ${(viewOff / DEG).toFixed(2)}° off the way it moves at ${(100 * viewOffAt / T).toFixed(2)}% (piece ${pose.piece}, ` +
      `${(pose.height - from.height).toFixed(1)} m up, m ${plan.m})`);
  }
  if (plan.kind === 'hop' && mostHopTurn > Math.abs(wrapAngle(to.heading - from.heading)) + 1e-9) problems.push(`a hop turned the view ${(mostHopTurn / DEG).toFixed(2)}°`);
  // The tilt (Stage 5.7): on the path, along its slope, never steeper than
  // VIEW.most; anywhere, never steeper than that or your own tilt.
  if (steepest > VIEW.most + 1e-6 || steepestAnywhere > Math.max(VIEW.most, Math.abs(from.pitch)) + 1e-6) {
    problems.push(`tilts ${(steepestAnywhere / DEG).toFixed(1)}° (${(steepest / DEG).toFixed(1)}° on the path)`);
  }
  for (const [off, at, most, where] of [[pitchOff, pitchOffAt, VIEW_ALONG.steady, ''], [bendOff, bendOffAt, VIEW_ALONG.bend, ' in a fast bend']]) {
    if (off <= most) continue;
    plan.at(at, pose);
    problems.push(`on the path, looks ${(off / DEG).toFixed(2)}° off its slope${where} at ${(100 * at / T).toFixed(2)}% (piece ${pose.piece}, ` +
      `${(pose.height - from.height).toFixed(1)} m up, ${plan.kind})`);
  }
  if (TIMELINE) {
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * T, q = {};
      plan.at(t, pose);
      plan.at(Math.max(0, t - 0.002), q);
      const slope = Math.atan2(pose.height - q.height, Math.hypot(pose.x - q.x, pose.y - q.y));
      console.log(`    t ${t.toFixed(2).padStart(6)} h ${pose.height.toFixed(1).padStart(8)} slope ${(slope / DEG).toFixed(1).padStart(6)} ` +
        `tilt ${(pose.pitch / DEG).toFixed(1).padStart(6)} yaw ${(pose.yaw / DEG).toFixed(1).padStart(7)} bank ${(pose.roll / DEG).toFixed(1).padStart(6)} piece ${pose.piece}`);
    }
    console.log(`    view onto the path over ${plan.viewIn.toFixed(2)} s, back over ${plan.viewOut.toFixed(2)} s; x${c.toFixed(2)}; ${plan.kind} ${plan.route.word}`);
  }
  // An S (Stage 5.7), as designed (route.js; laid over real ground, the
  // turning in time is the designed one): from the first curve's start to
  // the second's end the heading keeps turning: under 1% of its rate (that
  // half's) only for an instant at the middle, where it turns the other way
  // (or never, for a loop); there it is the middle heading.
  const [turn1, turn2] = plan.route.turns;
  let sShare = 0;
  if (plan.kind === 'curve' && Math.abs(turn1) > 1 * DEG && Math.abs(turn2) > 1 * DEG) {
    const d = plan.design, k = d.k, steps = 4000;
    let still = 0;
    for (let i = 0; i <= steps; i++) {
      const t = k.t1 + ((k.tEnd - k.t1) * i) / steps;
      still = Math.abs(d.rateAt(t)) < 0.01 * Math.abs(t < k.mid ? k.r1 : k.r2) && i > 0 && i < steps ? still + 1 : 0;
      sShare = Math.max(sShare, still / steps);
    }
    if (sShare > 0.01) problems.push(`not one S: the turning holds still for ${(100 * sShare).toFixed(1)}% of the time between its curves`);
    const middle = wrapAngle(sTurned(k, k.mid) - turn1);
    if (Math.abs(middle) > 1e-9) problems.push(`the middle heading is ${(middle / DEG).toExponential(2)}° off`);
  }
  // Seen from the side: up, along, down; never up and down again (Stage 5.7).
  let heightTurns = 0;
  for (let i = 1, dir = 0, last = plan.h[0]; i < plan.m; i++) {
    const d = plan.h[i] - last;
    if (Math.abs(d) < HEIGHT_TURN) continue;
    if (dir !== 0 && Math.sign(d) !== dir) heightTurns++;
    dir = Math.sign(d);
    last = plan.h[i];
  }
  if (heightTurns > 1) problems.push(`the height turns ${heightTurns} times (one top at most)`);
  // Its speed in metres a second along the cruise: up to one top, then down
  // (Stage 5.7: no slowing over a mountain).
  const cruising = [];
  for (let i = 0; i < plan.m; i++) if (Math.abs(plan.slope[i]) < LEVEL) cruising.push(plan.speed[i]);
  let fastestAt = 0, speedDip = 0;
  const cruiseTop = Math.max(1e-9, ...cruising);
  for (let i = 0; i < cruising.length; i++) if (cruising[i] > cruising[fastestAt]) fastestAt = i;
  for (let i = 1, most = 0; i <= fastestAt; i++) { most = Math.max(most, cruising[i - 1]); speedDip = Math.max(speedDip, (most - cruising[i]) / cruiseTop); }
  for (let i = cruising.length - 2, most = 0; i >= fastestAt; i--) { most = Math.max(most, cruising[i + 1]); speedDip = Math.max(speedDip, (most - cruising[i]) / cruiseTop); }
  if (speedDip > SPEED_DIP) problems.push(`along the cruise, its speed dips ${(100 * speedDip).toFixed(1)}% of its top`);
  if (glide != null && plan.glide !== glide) problems.push(plan.glide ? 'glided' : 'did not glide');
  // One bell: the pace the trip allows, no faster (as designed, before Longest flight).
  if ((1.875 * plan.sigma) / plan.natural > plan.pace * 1.0001) problems.push(`paced ${((1.875 * plan.sigma) / plan.natural).toFixed(2)} heights a second (allowed ${plan.pace.toFixed(2)})`);
  if (mostBank > settings.maxBank + 1e-9) problems.push(`banks ${(mostBank / DEG).toFixed(1)}° (setting ${(settings.maxBank / DEG).toFixed(0)})`);
  if (worstJump > 1.25) problems.push(`jumps ${worstJump.toFixed(2)} times its top speed`);
  if (T > settings.longest + 1e-6) problems.push(`takes ${T.toFixed(2)} s (longest ${settings.longest})`);
  if (T < Math.min(DURATION.least / settings.speed, settings.longest) - 1e-6) problems.push(`takes only ${T.toFixed(2)} s`);
  for (const a of plan.route.turns) if (Math.abs(a) > TURN.max + 1e-9) problems.push(`turns ${(a / DEG).toFixed(0)}°`);
  const peak = top - Math.max(from.height, to.height);
  if (peak > maxPeak) problems.push(`peaks ${peak.toFixed(1)} m above the higher end (at most ${maxPeak})`);
  if (T > maxTime) problems.push(`takes ${T.toFixed(2)} s (at most ${maxTime})`);
  if (plan.compress > maxCompress) problems.push(`played ${plan.compress.toFixed(2)}x (at most ${maxCompress})`);
  let up = 0;
  for (let i = 1; i < plan.m; i++) if (plan.piece[i] === -1) up = plan.time[i];
  if (up / T > maxClimbShare) problems.push(`${(100 * up / T).toFixed(0)}% of the time rising straight up (at most ${100 * maxClimbShare}%)`);
  stats.closest = Math.min(stats.closest, closest);
  stats.durations.push(T);
  stats.flights++;
  stats.viewOff = Math.max(stats.viewOff, viewOff);
  stats.accel = Math.max(stats.accel, viewAccel / (c * c));
  stats.pitchOff = Math.max(stats.pitchOff ?? 0, pitchOff);
  stats.bendOff = Math.max(stats.bendOff ?? 0, bendOff);
  stats.pitchRate = Math.max(stats.pitchRate ?? 0, fastestPitch / c);
  stats.steepest = Math.max(stats.steepest ?? 0, steepest);
  stats.sShare = Math.max(stats.sShare ?? 0, sShare);
  stats.speedDip = Math.max(stats.speedDip ?? 0, speedDip);
  stats.kinds = stats.kinds ?? {};
  stats.kinds[plan.kind] = (stats.kinds[plan.kind] ?? 0) + 1;
  report(name, problems.length === 0, problems.length ? problems.join('; ') :
    `${plan.kind} ${plan.route.word} ${Math.round(plan.length)} m for ${plan.distance.toFixed(1)} m, ` +
    `turns ${(plan.route.turns[0] / DEG).toFixed(0)}° and ${(plan.route.turns[1] / DEG).toFixed(0)}°, ` +
    `peak ${peak.toFixed(1)} m, closest ${closest.toFixed(2)} m, ${T.toFixed(2)} s (x${c.toFixed(2)}), ` +
    `view ${(fastestView / c / DEG).toFixed(1)}°/s, ${(viewAccel / (c * c) / DEG).toFixed(1)}°/s², ${(viewOff / DEG).toFixed(2)}° off the way, ` +
    `tilt ${(steepest / DEG).toFixed(0)}° at most, ${(fastestPitch / c / DEG).toFixed(1)}°/s, ${(pitchOff / DEG).toFixed(2)}° off the slope, ` +
    `bank ${(mostBank / DEG).toFixed(1)}°, pace ${((1.875 * plan.sigma) / T).toFixed(2)} h/s, speed dips ${(100 * speedDip).toFixed(1)}%`);
  return plan;
}

/* ---- 1. the small tools ------------------------------------------------------ */
{
  const rand = random(SEED);
  let ok = true;
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rand() * 60), r = Math.floor(rand() * 8), a = Float64Array.from({ length: n }, () => rand() * 100 - 50);
    const got = runningMax(a, r, new Float64Array(n));
    for (let i = 0; i < n; i++) {
      let want = -Infinity;
      for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) want = Math.max(want, a[j]);
      if (got[i] !== want) ok = false;
    }
    const inPlace = Float64Array.from(a);
    runningMax(inPlace, r);
    if (inPlace.some((v, i) => v !== got[i])) ok = false;
    const step = 0.5 + rand() * 3, slope = 0.2 + rand() * 4, lim = slopeLimitAbove(Float64Array.from(a), step, slope);
    for (let i = 0; i < n; i++) {
      let want = -Infinity;
      for (let j = 0; j < n; j++) want = Math.max(want, a[j] - slope * step * Math.abs(i - j));
      if (Math.abs(lim[i] - want) > 1e-9) ok = false;
    }
    const sigma = rand() * 3, blurred = gaussianBlur(a, sigma, new Float64Array(n), 3);
    if (sigma > 0) {
      const half = Math.ceil(3 * sigma);
      for (let i = 0; i < n; i++) {
        let acc = 0, sum = 0;
        for (let k = -half; k <= half; k++) {
          const w = Math.exp(-0.5 * (k / sigma) ** 2), j = i + k;
          sum += w;
          acc += w * (j < 0 || j >= n ? 3 : a[j]);
        }
        if (Math.abs(blurred[i] - acc / sum) > 1e-9) ok = false;
      }
    }
    const sorted = Float64Array.from(a).sort(), x = rand() * 120 - 60, at = lastAtOrBelow(sorted, x);
    let want = 0;
    for (let i = 0; i < n; i++) if (sorted[i] <= x) want = i;
    if (at !== want) ok = false;
  }
  let area = 0, worstArea = 0;
  for (let k = 0; k < 20000; k++) {
    const u = (k + 0.5) / 20000;
    area += smoothstep(u) / 20000;
    if (k % 1000 === 999) worstArea = Math.max(worstArea, Math.abs(area - smoothstepArea((k + 1) / 20000)));
  }
  const ends = smoothstep(0) === 0 && smoothstep(1) === 1 && smootherstep(0) === 0 && smootherstep(1) === 1 &&
    Math.abs(smoothstepArea(2) - 1.5) < 1e-12;
  report('running maximum, slope limit, blur and search agree with brute force', ok, '300 random arrays');
  // A wide blur is three box blurs: on a step and a ramp, within a percent
  // of the true Gaussian (edges held), and never outside the input's range.
  let worstWide = 0, outside = false;
  for (const sigma of [3.5, 9, 24, 60]) {
    const n = 800, src = Float64Array.from({ length: n }, (_, i) => (i < 300 ? 0 : 1) + Math.max(0, i - 500) / 300);
    const fast = gaussianBlur(src, sigma, new Float64Array(n), 'edge'), half = Math.ceil(3 * sigma);
    for (let i = 0; i < n; i++) {
      let acc = 0, sum = 0;
      for (let k = -half; k <= half; k++) {
        const w = Math.exp(-0.5 * (k / sigma) ** 2);
        sum += w;
        acc += w * src[Math.max(0, Math.min(n - 1, i + k))];
      }
      if (i > 3 * sigma && i < n - 3 * sigma) worstWide = Math.max(worstWide, Math.abs(fast[i] - acc / sum));
      if (fast[i] < -1e-9 || fast[i] > src[n - 1] + 1e-9) outside = true;
    }
  }
  report('a wide blur stays within a percent of a true Gaussian', worstWide < 0.01 && !outside,
    `at most ${worstWide.toFixed(4)} off over a step and a ramp`);
  report('smoothstep, its area and smootherstep', ends && worstArea < 1e-8, `area within ${worstArea.toExponential(1)}`);
  // Rounding corners (the planner's last resorts): never under the curve,
  // the ends exact, and its corners gone away from the ends (the largest
  // change of slope between neighbours shrinks). (One top is restored by the
  // planner after it: counted, not checked.)
  // A corner's sharpness: the largest change of slope between neighbours,
  // away from the ends (where the rounding fades out), against the largest
  // anywhere before.
  let under = 0, endsMoved = 0, turned = 0, keptSharp = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 100 + Math.floor(rand() * 400), top = Math.floor(rand() * n), h = new Float64Array(n);
    for (let i = 1; i < n; i++) h[i] = h[i - 1] + (i <= top ? 1 : -1) * (rand() < 0.3 ? 0 : rand() * 5);
    const before = Float64Array.from(h);
    roundedAbove(h, 0.02 + rand() * 0.05);
    for (let i = 0; i < n; i++) if (h[i] < before[i] - 1e-9) under++;
    if (h[0] !== before[0] || h[n - 1] !== before[n - 1]) endsMoved++;
    let peak = 0, sharpBefore = 0, sharpAfter = 0;
    for (let i = 0; i < n; i++) if (h[i] > h[peak]) peak = i;
    for (let i = 1; i < n; i++) if ((i <= peak && h[i] < h[i - 1] - 1e-9) || (i > peak && h[i] > h[i - 1] + 1e-9)) { turned++; break; }
    for (let i = 1; i < n - 1; i++) {
      sharpBefore = Math.max(sharpBefore, Math.abs(before[i + 1] - 2 * before[i] + before[i - 1]));
      if (i > 0.25 * n && i < 0.75 * n) sharpAfter = Math.max(sharpAfter, Math.abs(h[i + 1] - 2 * h[i] + h[i - 1]));
    }
    if (sharpAfter > 0.25 * sharpBefore) keptSharp++;
  }
  report('rounding corners never goes under the curve and keeps its ends', under === 0 && endsMoved === 0 && keptSharp === 0,
    `300 random curves: ${under} samples under, ${endsMoved} ends moved, ${keptSharp} with a corner over a quarter as sharp left ` +
    `in their middle half, ${turned} with a dip near an end (the planner restores one top)`);
}

/* ---- 2. the plane ------------------------------------------------------------- */
{
  const plane = new Plane(7.75, 46.02), rand = random(SEED + 1);
  let worst = 0, worstAz = 0;
  const p = { x: 0, y: 0 }, g = { lon: 0, lat: 0 };
  for (let k = 0; k < 2000; k++) {
    const lon = 7.75 + (rand() - 0.5) * 8, lat = 46.02 + (rand() - 0.5) * 6;
    plane.forward(lon, lat, p);
    plane.inverse(p.x, p.y, g);
    worst = Math.max(worst, Math.abs(g.lon - lon), Math.abs(g.lat - lat));
    const az = (rand() - 0.5) * 2 * Math.PI, h = plane.headingAt(lon, lat, az);
    worstAz = Math.max(worstAz, Math.abs(wrapAngle(plane.azimuthAt(p.x, p.y, h) - az)));
  }
  report('the plane maps there and back', worst < 1e-9 && worstAz < 1e-6,
    `positions within ${worst.toExponential(1)}°, headings within ${(worstAz / DEG).toExponential(1)}°`);
}

/* ---- 2b. what a flight keeps clear of ------------------------------------------- */
/*
 * The app's three bounds, through their own code with stand-ins for what
 * feeds them: a tile's grid of highest points (formats/tops.js) against
 * the triangles and ropes it was made from; the terrain's bound
 * (terrain/terrain.js) over a tree of tiles on a sloping plane, some of
 * them not loaded, against the plane's own highest point; and a building
 * layer's (features/tileset.js) over a small tileset, loaded and not.
 */
{
  const rand = random(SEED + 7);
  // Tile grids: every point of every triangle and rope at or under its cell.
  let worstUnder = Infinity, cellsChecked = 0;
  for (let trial = 0; trial < 40; trial++) {
    const positions = [], indices = [], ropes = [];
    for (let t = 0; t < 30; t++) {
      const cx = (rand() - 0.5) * 400, cy = (rand() - 0.5) * 300;
      for (let k = 0; k < 3; k++) positions.push(cx + (rand() - 0.5) * 60, cy + (rand() - 0.5) * 60, rand() * 80);
      indices.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    for (let r = 0; r < 5; r++) ropes.push((rand() - 0.5) * 500, (rand() - 0.5) * 400, 50 + rand() * 100, 0.02,
      (rand() - 0.5) * 500, (rand() - 0.5) * 400, 50 + rand() * 100, 0.4);
    const P = Float32Array.from(positions), cables = { ropes: Float32Array.from(ropes), members: new Float32Array(0) };
    const { cells, box } = topsGrid(P, Uint32Array.from(indices), cables);
    const cellOf = (x, y) => {
      const i = Math.max(0, Math.min(TOPS - 1, Math.floor(((x - box[0]) / (box[2] - box[0])) * TOPS)));
      const j = Math.max(0, Math.min(TOPS - 1, Math.floor(((y - box[1]) / (box[3] - box[1])) * TOPS)));
      return j * TOPS + i;
    };
    for (let t = 0; t < indices.length; t += 3) {
      for (let s = 0; s < 30; s++) {
        let a = rand(), b = rand();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const [p, q, r] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
        const x = P[p] + (P[q] - P[p]) * a + (P[r] - P[p]) * b, y = P[p + 1] + (P[q + 1] - P[p + 1]) * a + (P[r + 1] - P[p + 1]) * b;
        const z = P[p + 2] + (P[q + 2] - P[p + 2]) * a + (P[r + 2] - P[p + 2]) * b;
        worstUnder = Math.min(worstUnder, cells[cellOf(x, y)] - z);
        cellsChecked++;
      }
    }
    for (let k = 0; k < ropes.length; k += 8) {
      for (let s = 0; s <= 20; s++) {
        const u = s / 20, x = ropes[k] + (ropes[k + 4] - ropes[k]) * u, y = ropes[k + 1] + (ropes[k + 5] - ropes[k + 1]) * u;
        worstUnder = Math.min(worstUnder, cells[cellOf(x, y)] - (ropes[k + 2] + (ropes[k + 6] - ropes[k + 2]) * u));
        cellsChecked++;
      }
    }
  }
  report('a tile\'s grid of highest points is never under what it was made from', worstUnder >= -1e-4,
    `${cellsChecked} points of triangles and ropes, the closest ${worstUnder.toFixed(3)} m under its cell`);

  // The terrain's bound over a tree of tiles on a plane rising east and
  // falling north: a level-12 root, its four children, and some of theirs.
  const stub = { client: () => ({ run: async () => ({}), canRun: () => true, recycle() {}, retryIn: () => ({ wait: 1000 }) }) };
  const terrain = new Terrain({ device: null, scheduler: stub, registry: { all: [], providers: () => [] } });
  const plane = (lon, lat) => 1000 + 2000 * (lon - 8) - 3000 * (lat - 46.5);
  const rectMax = (r) => plane(r.east, r.south);
  const tile = (z, x, y, ready) => {
    const rect = tileRect(z, x, y), lo = plane(rect.west, rect.north), hi = plane(rect.east, rect.south);
    const tops = new Uint16Array(256);
    for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) {
      const cell = { west: rect.west + ((rect.east - rect.west) * i) / 16, east: rect.west + ((rect.east - rect.west) * (i + 1)) / 16,
        south: rect.south + ((rect.north - rect.south) * j) / 16, north: rect.south + ((rect.north - rect.south) * (j + 1)) / 16 };
      tops[j * 16 + i] = Math.min(32767, Math.ceil(((rectMax(cell) - lo) / (hi - lo)) * 32767));
    }
    return { z, x, y, rect, state: ready ? READY : UNLOADED, tops: ready ? tops : null, minHeight: lo, maxHeight: hi, children: null };
  };
  const at = tileAt(12, 8.1, 46.6), root = tile(12, at.x, at.y, true);
  root.children = [0, 1, 2, 3].map((i) => tile(13, 2 * at.x + (i & 1), 2 * at.y + (i >> 1), i !== 2));
  root.children[1].children = [0, 1, 2, 3].map((i) => tile(14, 2 * root.children[1].x + (i & 1), 2 * root.children[1].y + (i >> 1), i % 2 === 0));
  terrain.roots = [root];
  let low = 0, loose = 0, queries = 0;
  for (let k = 0; k < 4000; k++) {
    const r = root.rect, radius = rand() < 0.2 ? 0 : rand() * 600;
    const dLat = (radius * 1.01) / 110500, dLon = (radius * 1.01) / (111000 * Math.cos(46.6 * DEG));
    const lon = r.west + dLon + rand() * (r.east - r.west - 2 * dLon), lat = r.south + dLat + rand() * (r.north - r.south - 2 * dLat);
    if (!(lon - dLon > r.west && lon + dLon < r.east && lat - dLat > r.south && lat + dLat < r.north)) continue;
    const bound = terrain.upperBound(lon, lat, radius);
    const truth = rectMax({ west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat });
    queries++;
    if (!(bound >= truth - 1e-6)) low++;
    loose = Math.max(loose, bound - truth);
  }
  const outside = terrain.upperBound(root.rect.west - 0.01, root.rect.south + 0.01, 10);
  // Dropped for memory, a tile keeps its grid; one that never loaded has none.
  const tops = root.tops;
  root.state = UNLOADED;
  const dropped = terrain.upperBound((root.rect.west + root.rect.east) / 2, (root.rect.south + root.rect.north) / 2, 10);
  root.tops = null;
  const unloaded = terrain.upperBound((root.rect.west + root.rect.east) / 2, (root.rect.south + root.rect.north) / 2, 10);
  root.state = READY;
  root.tops = tops;
  report('the terrain\'s bound is never under the ground, and unknown where nothing is loaded',
    low === 0 && Number.isNaN(outside) && Number.isNaN(unloaded) && Number.isFinite(dropped) && loose < 1.5 * geometricError(12) + 60,
    `${queries} squares, ${low} under the plane, at most ${loose.toFixed(1)} m over it ` +
    `(the coarsest margin is ${(1.5 * geometricError(12)).toFixed(1)} m); off the tree ${outside}, root never loaded ${unloaded}, ` +
    `root dropped ${dropped.toFixed(0)} m (its grid kept)`);

  // A building layer: a root (ADD) over a replacing tile with four loaded
  // leaves, a file not read yet, and an adding tile whose own content is
  // loaded but whose child's is not.
  const R = (w, s, e, n, lo, hi) => ({ region: [w * DEG, s * DEG, e * DEG, n * DEG, lo, hi] });
  const json = { asset: { version: '1.0' }, geometricError: 100, root: { boundingVolume: R(8, 46, 8.04, 46.02, 400, 3000), geometricError: 50, refine: 'ADD',
    children: [
      { boundingVolume: R(8, 46, 8.02, 46.01, 400, 900), geometricError: 20, refine: 'REPLACE', content: { uri: 'a.b3dm' },
        children: [0, 1, 2, 3].map((q) => ({ boundingVolume: R(8 + (q & 1) * 0.01, 46 + (q >> 1) * 0.005, 8.01 + (q & 1) * 0.01,
          46.005 + (q >> 1) * 0.005, 400, 900), geometricError: 0, content: { uri: `a${q}.b3dm` } })) },
      { boundingVolume: R(8.02, 46, 8.04, 46.01, 400, 3000), geometricError: 20, content: { uri: 'b/tileset.json' } },
      { boundingVolume: R(8, 46.01, 8.04, 46.02, 400, 2000), geometricError: 20, refine: 'ADD', content: { uri: 'c.b3dm' },
        children: [{ boundingVolume: R(8, 46.01, 8.02, 46.02, 400, 1500), geometricError: 0, content: { uri: 'c0.b3dm' } }] },
    ] } };
  const index = buildIndex(json);
  const layerStub = { client: () => ({ run: async () => index, canRun: () => true, recycle() {}, cancelAll() {} }) };
  const layer = new Tileset({ device: null, scheduler: layerStub, spec: { id: 'test', tileset: 'https://example.invalid/tileset.json' } });
  await layer.load();
  // Each loaded tile: boxes standing on the 450 m floor of its region, in its own frame.
  const ix = layer.root.index, frames = new Map(), boxes = [];
  const slotOf = (uri) => { for (let i = 0; i < ix.tiles; i++) if (ix.urlOf(i)?.endsWith(`/${uri}`)) return i; return -1; };
  for (const uri of ['a0.b3dm', 'a1.b3dm', 'a2.b3dm', 'a3.b3dm', 'c.b3dm']) {
    const slot = slotOf(uri), b = ix.boxOf(slot, {});
    const frame = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2, height: 400 };
    const { meridian, primeVertical } = radiiAt(frame.lat);
    const kLat = meridian * DEG, kLon = primeVertical * Math.cos(frame.lat * DEG) * DEG;
    const positions = [], indices = [];
    for (let k = 0; k < 6; k++) {
      const lon = b.west + rand() * (b.east - b.west), lat = b.south + rand() * (b.north - b.south), h = 50 + rand() * 300;
      const x = (lon - frame.lon) * kLon, y = (lat - frame.lat) * kLat, n = positions.length / 3;
      positions.push(x - 10, y - 10, h, x + 10, y - 10, h, x, y + 10, h);
      indices.push(n, n + 1, n + 2);
      boxes.push({ x, y, kLon, kLat, frame, top: frame.height + h });
    }
    ix.contents.set(slot, contentRecord(frame, topsGrid(Float32Array.from(positions), Uint32Array.from(indices))));
    frames.set(slot, frame);
  }
  const cap = 1200;
  let wrong = 0, layerQueries = 0, unknownSeen = 0;
  for (let k = 0; k < 3000; k++) {
    const lon = 8 + rand() * 0.04, lat = 46 + rand() * 0.02, radius = rand() * 300;
    const h = layer.upperBound(lon, lat, radius, cap);
    const dLat = (radius * 1.01) / 110500, dLon = (radius * 1.01) / (111000 * Math.cos(lat * DEG));
    // What is really there: the boxes (20 m across) the square reaches, and,
    // where the square reaches what has not loaded, anything up to the cap.
    let truth = -Infinity;
    for (const b of boxes) {
      const qx0 = (lon - dLon - b.frame.lon) * b.kLon, qx1 = (lon + dLon - b.frame.lon) * b.kLon;
      const qy0 = (lat - dLat - b.frame.lat) * b.kLat, qy1 = (lat + dLat - b.frame.lat) * b.kLat;
      if (qx1 >= b.x - 10 && qx0 <= b.x + 10 && qy1 >= b.y - 10 && qy0 <= b.y + 10) truth = Math.max(truth, b.top);
    }
    const reachesB = lon + dLon >= 8.02 && lat - dLat <= 46.01;
    const reachesC0 = lon - dLon <= 8.02 && lat + dLat >= 46.01;
    if (reachesB || reachesC0) { truth = Math.max(truth, Math.min(reachesB ? 3000 : 1500, cap)); unknownSeen++; }
    layerQueries++;
    if (!(h >= truth - 1e-6)) wrong++;
  }
  layer.configure({ enabled: false });
  const off = layer.upperBound(8.01, 46.005, 50, cap);
  report('a building layer\'s bound covers what has loaded, and caps what has not',
    wrong === 0 && unknownSeen > 0 && off === -Infinity,
    `${layerQueries} squares (${unknownSeen} reaching content not loaded), ${wrong} under what is there; switched off: ${off}`);
}

/* ---- 3. named cases ------------------------------------------------------------ */
const flat = (h) => () => h;
const walker = (world, x, y, heading = 0, pitch = -0.1) => ({ x, y, height: world.ground(x, y) + EYE, heading, pitch, speed: 0 });
const flyer = (world, x, y, above, heading = 0, pitch = -0.3) => ({ x, y, height: world.ground(x, y) + above, heading, pitch, speed: 0 });
const end = (world, x, y, above, heading, exact) => ({ x, y, height: world.ground(x, y) + above, heading, exact });
{
  // The sketch: facing north, the place ahead and to the right, 100 m up.
  let w = new World({ half: 2500, height: flat(500) });
  check('the sketch: off ahead, hook right, straight, hook back, in facing north', w,
    { from: flyer(w, 0, 0, 100, 0), to: end(w, 800, 600, 100, 0, false) });
  w = new World({ half: 100, height: flat(500) });
  check('a hop of 10 m to the right glides there, low, the view kept', w,
    { from: walker(w, 0, 0, 0), to: end(w, 10, 0, EYE, 0, true), maxPeak: 6, maxTime: 5, glide: true });
  check('10 m behind glides back', w, { from: walker(w, 0, 0, 0), to: end(w, 0, -10, EYE, 0, true), maxTime: 5, glide: true });
  check('1 m ahead', w, { from: walker(w, 0, 0, 0), to: end(w, 0, 1, EYE, 0, true), maxTime: 3.5, glide: true });
  w = new World({ half: 300, height: flat(500) });
  check('40 m behind: two slow U-turns', w, { from: walker(w, 0, 0, 0), to: end(w, 0, -40, EYE, 0, true), maxTime: 30, glide: false });
  w = new World({ half: 600, height: flat(500), boxes: [{ x0: -10, y0: 90, x1: 10, y1: 110, top: 530 }] });
  check('200 m past a 30 m building, over it', w, { from: walker(w, 0, 0, 0), to: end(w, 0, 200, EYE, 0, true), maxTime: 16 });
  w = new World({ half: 1500, height: flat(500), boxes: [{ x0: 3, y0: -5, x1: 13, y1: 5, top: 525 }] });
  check('500 m, starting 3 m from a 25 m building', w, { from: walker(w, 0, 0, 0), to: end(w, 0, 500, EYE, 0, true) });
  // Zermatt to Saas-Fee: 17 km across the Mischabel, 4,500 m, flying 300 m up.
  const ridge = (x, y) => 1600 + 2900 * Math.exp(-(((x - 6900) * 0.6 + (y - 4900) * 0.8) ** 2) / (2 * 1800 ** 2));
  w = new World({ cx: 6900, cy: 4900, half: 26000, n: 512, height: ridge });
  check('Zermatt to Saas-Fee over the Mischabel', w, { from: flyer(w, 0, 0, 300, 0.2), to: end(w, 13800, 9800, 300, 0.2, false) });
  // Bellinzona to Lugano (21.6 km) while only coarse tiles are loaded: the
  // bound is 1,300 m over the real ground (a coarse level's margin), the
  // estimate the ground itself. The pace follows the estimate: played at
  // about the setting's speed, not 18 times faster with most of it spent
  // rising straight up as when the pace followed the bound.
  {
    const valley = (x, y) => 250 + 1500 * Math.exp(-((x - 4000) ** 2) / (2 * 3000 ** 2)) * (0.5 + 0.5 * Math.sin(y / 2500));
    const truth = new World({ cx: 0, cy: -10000, half: 26000, n: 512, height: valley });
    const coarse = { bound: (x, y, r) => truth.bound(x, y, r) + 1300, ground: (x, y) => truth.ground(x, y) };
    const from = { x: 0, y: 0, height: truth.ground(0, 0) + 600, heading: 2.8, pitch: -0.2, speed: 0 };
    const to = { x: 2500, y: -21450, height: truth.ground(2500, -21450) + 600, heading: 2.8, exact: false };
    check('Bellinzona to Lugano, known coarsely: paced by what is there', { ...truth, bound: coarse.bound, clearance: (x, y, z) => truth.clearance(x, y, z) },
      { from, to, ground: coarse.ground, maxCompress: 2.2, maxClimbShare: 0.35 });
  }
  // A rope 40 m up across the way, 200 m out: over it, never through it.
  w = new World({ half: 1000, height: flat(500), ropes: [{ x0: -300, y0: 200, z0: 540, x1: 300, y1: 210, z1: 545 }] });
  check('under a cable car', w, { from: walker(w, 0, 0, 0), to: end(w, 0, 420, EYE, 0, true) });
  // Down from a high plateau into a deep valley 5 km off, facing away (the
  // rig's stand-in town to Testdorf): a gentle climb and the 2.4 km descent
  // alone would carry the flight past the place, so it climbs more steeply
  // (route.js, LEANS) or glides facing the way it goes (plan.js, GLIDE),
  // never backwards with the view kept.
  {
    const start = { x: -3856, y: -3339 }, span = Math.hypot(start.x, start.y);
    const plateau = (x, y) => 552 + 2225 * Math.min(1, Math.hypot(x, y) / span);
    w = new World({ cx: start.x / 2, cy: start.y / 2, half: 6000, n: 256, height: plateau });
    const steep = check('down from a high plateau into a deep valley, facing away', w,
      { from: flyer(w, start.x, start.y, 300, -2.2, -0.25), to: end(w, 0, 0, 300, -2.2, false) });
    report('... and the view looks the way it goes, not back', Boolean(steep) && steep.kind !== 'hop',
      steep ? (steep.kind === 'spin' ? `straight there, turning round the vertical at the ends, ${steep.duration.toFixed(1)} s`
        : `${steep.route.word}, climbing at ${(steep.design.up.angle / DEG).toFixed(0)}° lean ${steep.design.up.lean}, ` +
          `coming down at ${(steep.design.down.angle / DEG).toFixed(0)}° lean ${steep.design.down.lean}, ${steep.duration.toFixed(1)} s`) : 'no plan');
  }
  // His words: "relatively slowly at the beginning, max speed halfway and
  // then relatively slow at the end". Over flat ground, 20 km almost
  // straight ahead from 300 m up: the pace the eye sees (the ground passing
  // in heights above it, up and down counted as a zoom) rises from rest to
  // one peak halfway and falls back to rest, measured from the positions.
  w = new World({ half: 25000, n: 64, height: flat(500) });
  const long = check('20 km almost straight ahead', w, { from: flyer(w, 0, 0, 300, 0), to: end(w, 1700, 19900, 300, 0, false) });
  if (long) {
    const pose = {}, dt = 0.01, T = long.duration, pace = [];
    let prev = null;
    for (let t = 0; t <= T + 1e-9; t += dt) {
      long.at(Math.min(T, t), pose);
      if (prev) {
        const flat = Math.hypot(pose.x - prev.x, pose.y - prev.y), rise = pose.height - prev.height;
        const above = (pose.height + prev.height) / 2 - 500 + PACE.offset;
        pace.push({ t: t - dt / 2, v: Math.sqrt(flat * flat + (rise / PACE.zoom) ** 2) / dt / above });
      }
      prev = { x: pose.x, y: pose.y, height: pose.height };
    }
    let peak = pace[0], dips = 0;
    for (const p of pace) if (p.v > peak.v) peak = p;
    // One bell: rising to the peak and falling after it, give or take noise.
    for (let i = 1; i < pace.length; i++) {
      const rising = pace[i].t < peak.t, d = pace[i].v - pace[i - 1].v;
      if ((rising && d < -0.01 * peak.v) || (!rising && d > 0.01 * peak.v)) dips++;
    }
    const edge = Math.max(...pace.filter((p) => p.t < 0.05 * T || p.t > 0.95 * T).map((p) => p.v));
    const share = peak.t / T;
    report('one bell: slow at the ends, fastest halfway', Math.abs(share - 0.5) <= 0.05 && dips === 0 && edge < 0.15 * peak.v,
      `peak ${peak.v.toFixed(2)} heights a second at ${(100 * share).toFixed(1)}% of ${T.toFixed(1)} s; ` +
      `at most ${edge.toFixed(2)} in the first and last 5%; ${dips} dips`);
    // The bell itself: progress at a share of the time is exactly smootherstep's.
    let worst = 0;
    for (let k = 0; k <= 100; k++) { long.at((k / 100) * T, pose); worst = Math.max(worst, Math.abs(pose.progress - bell(k / 100))); }
    report('the bell is the minimum-jerk curve', worst < 1e-12, `within ${worst.toExponential(1)}`);
  }
  // Stage 5.7: how it leaves and arrives, over a ridge, and hops.
  {
    const pose = {}, q = {};
    // The angle it climbs at, `rise` metres over its start, measured over 2 ms.
    const climbAt = (plan, rise) => {
      let t = 0;
      for (; t < plan.duration; t += 0.0005) { plan.at(t, pose); if (pose.height - plan.h[0] >= rise) break; }
      plan.at(Math.max(0, t - 0.002), q);
      return Math.atan2(pose.height - q.height, Math.hypot(pose.x - q.x, pose.y - q.y));
    };
    const deg = (a) => `${(a / DEG).toFixed(1)}°`;
    // In the open, a walker leaves at 60° (his answer) and the view turns
    // onto the path while it rises its first VIEW.height metres.
    w = new World({ half: 6000, n: 64, height: flat(500) });
    const open = check('a walker in the open, 2 km ahead and to the right', w, { from: walker(w, 0, 0, 0), to: end(w, 1400, 1400, EYE, 0, true) });
    if (open) {
      const a1 = climbAt(open, 1), a10 = climbAt(open, 10);
      let t = 0;
      for (; t < open.duration; t += 0.001) { open.at(t, pose); if (pose.height - open.h[0] >= VIEW.height) break; }
      report('... leaves at 60°, and turns onto the path over its first 100 m up',
        Math.abs(a1 - 60 * DEG) < 2 * DEG && Math.abs(a10 - 60 * DEG) < 3 * DEG && Math.abs(open.viewIn - t) < 0.01,
        `climbs at ${deg(a1)} 1 m up and ${deg(a10)} 10 m up; the view on the path after ${open.viewIn.toFixed(2)} s, 100 m up after ${t.toFixed(2)} s`);
    }
    // Boxed in a courtyard 8 m across, its walls 20 m high: straight up.
    w = new World({ half: 3000, n: 64, height: flat(500), boxes: [
      { x0: -20, y0: 4, x1: 20, y1: 10, top: 520 }, { x0: -20, y0: -10, x1: 20, y1: -4, top: 520 },
      { x0: 4, y0: -4, x1: 10, y1: 4, top: 520 }, { x0: -10, y0: -4, x1: -4, y1: 4, top: 520 }] });
    const boxed = check('a walker in a courtyard, 2 km ahead', w, { from: walker(w, 0, 0, 0), to: end(w, 300, 2000, EYE, 0, true) });
    if (boxed) report('... rises straight up first', climbAt(boxed, 1) > 85 * DEG && climbAt(boxed, 15) > 85 * DEG,
      `climbs at ${deg(climbAt(boxed, 1))} 1 m up and ${deg(climbAt(boxed, 15))} 15 m up`);
    // A wall 25 m high 3 m ahead (the way out): steeper than in the open.
    w = new World({ half: 3000, n: 64, height: flat(500), boxes: [{ x0: -40, y0: 3, x1: 40, y1: 8, top: 525 }] });
    const wall = check('a walker 3 m from a 25 m wall ahead, 2 km on', w, { from: walker(w, 0, 0, 0), to: end(w, 300, 2000, EYE, 0, true) });
    if (wall) report('... leaves more steeply than in the open', climbAt(wall, 1) > 70 * DEG, `climbs at ${deg(climbAt(wall, 1))} 1 m up`);
    // Over a ridge 1,000 m high across the middle of a 10 km trip, as fast
    // as over flat ground (his words: "Over the mountains the speed does not
    // have to slow down!"; 5.6 slowed from 1,580 to 476 m/s over it).
    const hill = (x, y) => 500 + 1000 * Math.exp(-((y - 5000) ** 2) / (2 * 600 ** 2));
    w = new World({ cx: 0, cy: 5000, half: 8000, n: 256, height: hill });
    const over = check('10 km ahead over a 1,000 m ridge', w,
      { from: { x: 0, y: 0, height: 800, heading: 0, pitch: -0.2 }, to: { x: 0, y: 10000, height: 800, heading: 0, exact: false } });
    const level = check('... and over flat ground', new World({ cx: 0, cy: 5000, half: 8000, n: 64, height: flat(500) }),
      { from: { x: 0, y: 0, height: 800, heading: 0, pitch: -0.2 }, to: { x: 0, y: 10000, height: 800, heading: 0, exact: false } });
    if (over && level) {
      const top = (p) => Math.max(...p.speed);
      report('... as fast over the ridge as over flat ground', Math.abs(over.duration / level.duration - 1) < 0.02 && top(over) / top(level) > 0.98,
        `${over.duration.toFixed(1)} s and ${top(over).toFixed(0)} m/s at most, against ${level.duration.toFixed(1)} s and ${top(level).toFixed(0)} m/s`);
    }
    // Hops (his words: "The small hops should be like a parabola, not up,
    // straight, down"): one arc, the view kept.
    w = new World({ half: 300, n: 64, height: flat(500) });
    for (const [x, y, label] of [[25, 0, '25 m to the right'], [0, -20, '20 m behind'], [12, 12, '17 m ahead and to the right']]) {
      const hop = check(`a hop ${label}`, w, { from: walker(w, 0, 0, 0), to: end(w, x, y, EYE, 0, true), glide: true });
      if (!hop) continue;
      let top = -Infinity, near = 0;
      for (let i = 0; i < hop.m; i++) top = Math.max(top, hop.h[i]);
      const steps = 400;
      for (let i = 0; i <= steps; i++) { hop.at((i / steps) * hop.duration, pose); if (pose.height > top - 0.02 * (top - hop.h[0])) near++; }
      report(`... one arc`, hop.route.word === 'arc' && near / (steps + 1) < 0.2 && climbAt(hop, 0.2) < 45 * DEG,
        `${hop.route.word}, leaving at ${deg(climbAt(hop, 0.2))}, ${(top - hop.h[0]).toFixed(1)} m up, within 2% of its top ${(100 * near / (steps + 1)).toFixed(0)}% of the time`);
    }
  }
}

/* ---- 4. random flights ---------------------------------------------------------- */
{
  const rand = random(SEED + 2);
  const log = (a, b) => Math.exp(Math.log(a) + rand() * (Math.log(b) - Math.log(a)));
  for (let k = 0; k < COUNT; k++) {
    const distance = log(1, 500e3), angle = rand() * 2 * Math.PI;
    const from = { x: distance * Math.sin(angle), y: distance * Math.cos(angle) };
    const half = 1.3 * distance + 200, base = 200 + rand() * 1500;
    const bumps = Array.from({ length: 3 + Math.floor(rand() * 6) }, () => ({
      x: (rand() - 0.5) * 2 * distance, y: (rand() - 0.5) * 2 * distance,
      h: rand() * Math.min(4000, 0.3 * distance), s: (0.05 + rand() * 0.4) * distance + 1,
    }));
    const height = (x, y) => base + bumps.reduce((sum, b) => sum + b.h * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s)), 0);
    const pre = new World({ cx: from.x / 2, cy: from.y / 2, half, height });
    const near = (x, y, r) => Math.hypot(x - from.x, y - from.y) < r || Math.hypot(x, y) < r;
    const boxes = [], ropes = [];
    for (let b = 0; b < Math.floor(rand() * 30); b++) {
      const size = Math.min(40, 3 + rand() * 0.2 * distance), t = rand();
      const cx = from.x * t + (rand() - 0.5) * 0.5 * distance, cy = from.y * t + (rand() - 0.5) * 0.5 * distance;
      const box = { x0: cx - size / 2, y0: cy - size / 2, x1: cx + size / 2, y1: cy + size / 2 };
      // Kept off both ends, the way a landing spot is clear.
      const gap = (x, y) => Math.hypot(Math.max(box.x0 - x, 0, x - box.x1), Math.max(box.y0 - y, 0, y - box.y1));
      if (gap(from.x, from.y) < 2.5 || gap(0, 0) < 2.5) continue;
      box.top = pre.groundBound((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, size) + 3 + rand() * 60;
      boxes.push(box);
    }
    for (let r = 0; r < Math.floor(rand() * 3); r++) {
      const t = rand(), cx = from.x * t, cy = from.y * t, a = rand() * Math.PI, l = 50 + rand() * 0.5 * distance;
      const rope = { x0: cx - l * Math.cos(a), y0: cy - l * Math.sin(a), x1: cx + l * Math.cos(a), y1: cy + l * Math.sin(a) };
      if (planDistance(rope, from.x, from.y).d < 30 || planDistance(rope, 0, 0).d < 30) continue;
      rope.z0 = pre.groundBound(rope.x0, rope.y0, 1) + 10 + rand() * 300;
      rope.z1 = pre.groundBound(rope.x1, rope.y1, 1) + 10 + rand() * 300;
      ropes.push(rope);
    }
    const world = new World({ cx: from.x / 2, cy: from.y / 2, half, height, boxes, ropes });
    const flying = rand() < 0.4, above = flying ? log(5, 2000) : EYE;
    const heading = rand() * 2 * Math.PI, pitch = (rand() - 0.6) * 1.4;
    const settings = { speed: 0.25 * (1 + Math.floor(rand() * 16)), longest: 2 + Math.floor(rand() * 29), maxBank: rand() * 90 * DEG };
    const flightCase = {
      from: { x: from.x, y: from.y, height: world.ground(from.x, from.y) + above, heading, pitch, speed: 0 },
      // The end heading as a far place's meridians give it: a few degrees off.
      to: end(world, 0, 0, above, heading + (rand() - 0.5) * 6 * DEG * Math.min(1, distance / 500e3), !flying),
      settings,
    };
    if (ONLY != null && k !== ONLY) continue;
    if (ONLY != null) console.log(JSON.stringify({ ...flightCase, boxes, ropes }));
    check(`random flight ${k} (${distance.toFixed(1)} m, ${flying ? `flying ${above.toFixed(0)} m up` : 'walking'})`, world, flightCase);
  }
  const sorted = (a) => [...a].sort((x, y) => x - y), at = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  const d = sorted(stats.durations), ms = sorted(stats.planMs);
  console.log(`flights: ${stats.flights}; closest ${stats.closest.toFixed(2)} m; duration median ${at(d, 0.5).toFixed(1)} s, ` +
    `90th ${at(d, 0.9).toFixed(1)} s; planning median ${at(ms, 0.5).toFixed(2)} ms, 99th ${at(ms, 0.99).toFixed(1)} ms, worst ${ms.at(-1).toFixed(1)} ms; ` +
    `tilt at most ${(stats.steepest / DEG).toFixed(1)}° on the path and ${(stats.pitchRate / DEG).toFixed(1)}°/s, ` +
    `at most ${(stats.pitchOff / DEG).toFixed(2)}° off its slope (${(stats.bendOff / DEG).toFixed(2)}° sweeping through fast bends); ` +
    `the S's still middle at most ${(100 * stats.sShare).toFixed(2)}%; ` +
    `speed dips at most ${(100 * stats.speedDip).toFixed(2)}%; ${Object.entries(stats.kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
}

/* ---- 5. the runtime ------------------------------------------------------------- */
/*
 * The app's world, stood in for: the ground is a gentle slope, a house
 * stands on the place, and the landing spot is "found" when the case says
 * (as the buildings there would load). A real Camera is flown at 60 frames
 * a second until the flight is over. Every case: there exactly, facing as
 * it started, never jumping (no frame moves much more than its neighbours),
 * on the path never turning faster than the turn limit, and, whatever moved
 * the end on the way, rising, flying and coming down without rising again
 * (Stage 5.7: a late change reshapes the way ahead, no little corrections).
 */
{
  const lon0 = 7.75, lat0 = 46.02;
  const { meridian, primeVertical } = radiiAt(lat0);
  const mLat = meridian * DEG, mLon = primeVertical * Math.cos(lat0 * DEG) * DEG;
  const local = (lon, lat) => ({ x: (lon - lon0) * mLon, y: (lat - lat0) * mLat });
  const geo = (x, y) => ({ lon: lon0 + x / mLon, lat: lat0 + y / mLat });
  const world = new World({ half: 6000, height: (x, y) => 1600 + 0.05 * x + 0.02 * y,
    boxes: [{ x0: -6, y0: -5, x1: 6, y1: 5, top: 1610 }] });

  const runCase = (name, { start, yaw = 0.4, pitch = -0.2, walk, above, spot = null, foundAt = 0, maxTime = 60, expect = {},
    lateGround = null, slowPlace = null, settings = DEFAULT_SETTINGS, instant = false }) => {
    const camera = new Camera({ lon: start.lon, lat: start.lat, height: 0, yaw, pitch });
    const s0 = local(start.lon, start.lat);
    camera.apply({ lon: start.lon, lat: start.lat, height: world.ground(s0.x, s0.y) + (walk ? EYE : above), yaw, pitch, roll: 0 });
    let clock = 0;
    const flight = new Flight();
    const env = {
      bound: (lon, lat, r) => { const p = local(lon, lat); return world.bound(p.x, p.y, r); },
      // The place's ground: a coarse guess too high by lateGround.offset
      // until lateGround.at seconds, then exact.
      groundAt: (lon, lat, out) => {
        const p = local(lon, lat), late = lateGround && clock < lateGround.at;
        out.height = world.ground(p.x, p.y) + (late ? lateGround.offset : 0);
        out.rank = late ? 12 : GROUND_EXACT;
        return true;
      },
      exactGround: (lon, lat) => { const p = local(lon, lat); return world.ground(p.x, p.y); },
      landingSpot: (to, h, w, out) => {
        const at = typeof foundAt === 'function' ? foundAt(flight) : clock >= foundAt;
        if (!at) return false;
        const g = spot ? geo(spot.x, spot.y) : to, p = local(g.lon, g.lat);
        out.lon = g.lon; out.lat = g.lat; out.ground = world.ground(p.x, p.y);
        return true;
      },
      endZone: () => clock > 1,
      ready: () => (slowPlace && flight.t < flight.plan.holdTime + slowPlace.after ? slowPlace.ready : 1),
      prefetch: () => {}, levelFor: () => 14,
    };
    const target = { lon: lon0, lat: lat0, label: name, covered: true,
      ground: world.ground(0, 0) + (lateGround ? lateGround.offset : 0), rank: lateGround ? 12 : GROUND_EXACT,
      arrive: walk ? EYE : above, walk };
    flight.start(camera, target, env, settings, { instant });
    const T = flight.plan?.duration ?? 0;
    let closest = Infinity, fastest = 0, prev = null, prevStep = null, worstKick = 0, slowest = 1;
    let heightTurns = 0, dir = 0, last = camera.height;
    const dt = 1 / 60;
    while (flight.active && clock < maxTime) {
      flight.step(dt, camera, env);
      clock += dt;
      slowest = Math.min(slowest, flight.rate);
      const p = local(camera.lon, camera.lat), on = flight.phase === 'flight' && flight.pose.onPath === 1;
      closest = Math.min(closest, world.clearance(p.x, p.y, camera.height));
      if (prev) {
        if (on && prev.on) fastest = Math.max(fastest, Math.abs(wrapAngle(camera.yaw - prev.yaw)) / dt);
        const step = Math.hypot(p.x - prev.x, p.y - prev.y, camera.height - prev.h);
        // A jump: a frame moving much more than the one before.
        if (prevStep != null && flight.active) worstKick = Math.max(worstKick, step - 1.5 * prevStep - 0.05);
        prevStep = step;
      }
      const d = camera.height - last;
      if (Math.abs(d) >= HEIGHT_TURN) {
        if (dir !== 0 && Math.sign(d) !== dir) heightTurns++;
        dir = Math.sign(d);
        last = camera.height;
      }
      prev = { on, yaw: camera.yaw, x: p.x, y: p.y, h: camera.height };
    }
    const problems = [];
    const where = local(camera.lon, camera.lat), want = expect.spot ?? spot ?? { x: 0, y: 0 };
    if (flight.active) problems.push(`still flying after ${maxTime} s (${flight.phase})`);
    if (Math.hypot(where.x - want.x, where.y - want.y) > 1e-4) problems.push(`ends ${Math.hypot(where.x - want.x, where.y - want.y).toFixed(4)} m from the spot`);
    const wantHeight = expect.height ?? world.ground(want.x, want.y) + (walk ? EYE : above);
    if (Math.abs(camera.height - wantHeight) > 1e-6) problems.push(`ends ${(camera.height - wantHeight).toFixed(3)} m off in height`);
    if (camera.yaw !== yaw || camera.pitch !== pitch || camera.roll !== 0) problems.push(`ends turned (yaw ${camera.yaw - yaw}, pitch ${camera.pitch - pitch}, roll ${camera.roll})`);
    if (closest < 1) problems.push(`came within ${closest.toFixed(2)} m of something`);
    if (worstKick > 0) problems.push(`a frame jumped ${worstKick.toFixed(3)} m more than allowed`);
    if (fastest > TURN.rate * (flight.plan?.compress ?? 1) * 1.1 + 1e-6) problems.push(`turned at ${(fastest / DEG).toFixed(0)}°/s on the path`);
    if (heightTurns > 1) problems.push(`the height turned ${heightTurns} times (one top at most)`);
    if (expect.landed != null && flight.landed !== expect.landed) problems.push(flight.landed ? 'landed' : 'did not land');
    if (expect.waited === true && !(flight.waited > 0.1)) problems.push('never slowed down for the place');
    if (expect.waited === false && flight.waited > 0) problems.push(`slowed down for ${flight.waited.toFixed(2)} s`);
    if (flight.waited > WAIT.longest + dt) problems.push(`waited ${flight.waited.toFixed(2)} s`);
    if (expect.guessed != null && flight.guessed !== expect.guessed) problems.push(flight.guessed ? 'gave up on the spot' : 'did not give up on the spot');
    // The plan, the wait, and finishing a late move of the end (flight.js,
    // FINISH); an instant trip only settles: 5 s and a last glide at most (SETTLE).
    const longest = instant ? 5 + 2.5 + dt : Math.min(settings.longest, T) + flight.waited + 2.05;
    if (flight.elapsed > longest) problems.push(`flew ${flight.elapsed.toFixed(2)} s (plan ${T.toFixed(2)}, waited ${flight.waited.toFixed(2)})`);
    report(`runtime: ${name}`, problems.length === 0, problems.length ? problems.join('; ') :
      `${clock.toFixed(1)} s (plan ${T.toFixed(1)}, hold from ${flight.plan?.holdTime.toFixed(1)}), slowed to ${slowest.toFixed(2)} for ${flight.waited.toFixed(2)} s, ` +
      `closest ${closest.toFixed(2)} m, plans ${flight.planMs.toFixed(2)} ms, ${flight.corrections.length} late changes${flight.landed ? ', landed' : ''}`);
  };

  const at = (x, y) => geo(x, y);
  // Found just after the descent's wait would start: what that wait is for.
  const late = (f) => f.plan && f.t > f.plan.holdTime + 0.5;
  runCase('a landing spot known at once', { start: at(-400, -300), walk: true, spot: { x: -12, y: -5 }, foundAt: 0,
    expect: { landed: true, waited: false } });
  runCase('a landing spot found on the way', { start: at(-1500, -900), walk: true, spot: { x: -12, y: -5 }, foundAt: 1.2,
    expect: { landed: true, waited: false } });
  runCase('a landing spot found late: the descent slows for it', { start: at(-300, -200), walk: true, spot: { x: -8, y: 6 }, foundAt: late,
    expect: { landed: true, waited: true } });
  // On the house that stands there: a metre over its roof (plan.js, ARRIVAL).
  runCase('a landing spot never found: down at the place after the wait', { start: at(-300, -200), walk: true, foundAt: () => false,
    expect: { landed: true, waited: true, guessed: true, spot: { x: 0, y: 0 }, height: world.bound(0, 0, 1) + 1 } });
  runCase('a short hop whose spot is found late', { start: at(-35, -30), walk: true, spot: { x: -8, y: 6 }, foundAt: late,
    expect: { landed: true } });
  runCase('a walker\'s landing 50 m behind, found on the way', { start: at(0, 50), yaw: 0, pitch: -0.1, walk: true, spot: { x: -8, y: 6 },
    foundAt: 4, expect: { landed: true } });
  runCase('3 km, 200 m up, no landing', { start: at(-2500, 1700), walk: false, above: 200, expect: { landed: false, waited: false } });
  runCase('better ground at the place on the way: the end follows it', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 1.5, offset: 80 }, expect: { landed: false } });
  runCase('better ground found on the way down', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 9, offset: 30 }, expect: { landed: false } });
  runCase('the place slow to load: the descent slows, then goes on', { start: at(-3000, 2000), walk: false, above: 150,
    slowPlace: { after: 1.5, ready: 0.5 }, expect: { landed: false, waited: true } });
  runCase('Longest flight 4 s, with better ground on the way', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 1.0, offset: 80 }, settings: { ...DEFAULT_SETTINGS, longest: 4 }, expect: { landed: false } });
  // Fly to search results off: there at once on the coarse guess, then onto the exact ground.
  runCase('an instant trip settles onto better ground', { start: at(-3000, 2000), walk: false, above: 150, instant: true,
    lateGround: { at: 1.0, offset: 40 }, expect: { landed: false } });
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exitCode = failures ? 1 : 0;
