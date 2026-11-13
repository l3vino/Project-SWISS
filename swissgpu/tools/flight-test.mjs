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
 *   played; turns TURN.max at most; the view tilts up and down no faster
 *   than PITCH.rate at the natural pace, or the bell is PITCH.longer times
 *   longer for it (Stage 5.11b).
 *
 * Then the small tools it is made of against brute force, the plane's
 * round trip, the app's own bounds (a tile's grid of highest points, the
 * terrain's bound, a building layer's), named cases from the sketches the
 * flight was drawn from (over flat ground, the pace one bell whose peak is
 * halfway), a few thousand random flights from a metre to 500 km, and the
 * runtime (engine/flight/flight.js) driving a real Camera through a
 * stand-in of the app's world: a landing spot known at once, found on the
 * way, found late, never found; better ground at the place found on the
 * way; a place slow to load; Longest flight. In every one the camera
 * arrives exactly, never jumps, and keeps the plan's pace (5.10b: the clock
 * never slows).
 */

import { planFlight, planVerified, DEFAULT_SETTINGS, VIEW, ARC, PITCH } from '../js/engine/flight/plan.js';
import { PACE, DURATION, bell } from '../js/engine/flight/timing.js';
import { Flight, GROUND_EXACT, HOVER } from '../js/engine/flight/flight.js';
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

  /* How far a point is from the nearest box (each solid from the ground to
   * its top), metres: beside it, over it, or 0 inside it. */
  distance(x, y, z) {
    let best = Infinity;
    for (const b of this.boxes) {
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1), dz = Math.max(0, z - b.top);
      best = Math.min(best, Math.hypot(dx, dy, dz));
    }
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
  // Planned as the app plans (flight.js): the flown path checked before it flies (plan.js, VERIFY).
  const plan = planVerified({ from, to, bound, ground: ground ?? bound, settings, endPitch: from.pitch });
  stats.planMs.push(performance.now() - t0);
  if (plan?.verified) {
    stats.verified = stats.verified ?? { planned: 0, again: 0, short: 0, points: 0, first: 0, kinds: {} };
    stats.verified.planned++;
    if (plan.verified.tries > 0) {
      stats.verified.again++;
      stats.verified.first = Math.max(stats.verified.first, plan.verified.first);
      stats.verified.kinds[plan.kind] = (stats.verified.kinds[plan.kind] ?? 0) + 1;
      if (VERBOSE) console.log(`    planned again: ${name}: ${plan.kind}, ${plan.verified.first.toFixed(2)} m short at first`);
    }
    stats.verified.short = Math.max(stats.verified.short, plan.verified.worst);
    stats.verified.points += plan.verified.points;
  }
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
  // An arc ends facing the way it went (Stage 5.8b), every other flight the way it started.
  const endHeading = plan.kind === 'arc' ? plan.travel : to.heading;
  if (Math.abs(wrapAngle(pose.yaw - endHeading)) > 1e-9) problems.push(`ends facing ${(wrapAngle(pose.yaw - endHeading) / DEG).toExponential(2)}° off`);
  // Only an S, never a loop (Stage 5.8b, his words: "it is doing a circle to destination sometimes instead of the smooth S!").
  if (plan.kind === 'curve' && (plan.route.word === 'RR' || plan.route.word === 'LL')) problems.push(`a loop (${plan.route.word})`);
  // Short trips: one arc (Stage 5.8b: "small jumps should be like a parabola"), no level stretch at its top:
  // within 10° of level for 30% of the way at most (a 60° parabola: 10%; 5.7b's climb, level and descent: 74-96%);
  // with the view kept or not (5.11b: under 300 m it is kept).
  if (plan.kind === 'arc' || (plan.kind === 'hop' && plan.route.angles)) {
    let flat = 0, way = 0;
    for (let i = 1; i < plan.m; i++) {
      const d = Math.hypot(plan.x[i] - plan.x[i - 1], plan.y[i] - plan.y[i - 1]);
      way += d;
      if (Math.abs(Math.atan2(plan.h[i] - plan.h[i - 1], d)) < 10 * DEG) flat += d;
    }
    if (way > 0 && flat / way > 0.3) problems.push(`an arc within 10° of level for ${(100 * flat / way).toFixed(0)}% of the way`);
  }
  // From the air, in the open (Stage 5.8b: "start with a more curved approach (like the destination)"): it leaves level.
  if (plan.kind === 'curve' && plan.route.up?.level) {
    const a = Math.atan2(plan.h[2] - plan.h[0], Math.hypot(plan.x[2] - plan.x[0], plan.y[2] - plan.y[0]));
    if (a > 5 * DEG) problems.push(`a level start leaves at ${(a / DEG).toFixed(1)}°`);
  }
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
  // How fast the view tilts at the natural pace, measured here (Stage 5.11b, PITCH).
  plan.measuredTilt = fastestPitch / c;
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
  // Under 300 m: one arc, the view kept (Stage 5.11b, his words: "when hop is
  // close, don't turn the camera"; 5.10b turned the camera onto the arc).
  w = new World({ half: 300, height: flat(500) });
  for (const [label, x, y, most] of [['40 m behind', 0, -40, 8], ['150 m to the right', 150, 0, 8], ['290 m ahead', 0, 290, 10]]) {
    const near = check(`${label}: one arc, the view kept`, w, { from: walker(w, 0, 0, 0), to: end(w, x, y, EYE, 0, true), maxTime: most, glide: true });
    if (near) report('... a hop', near.kind === 'hop' && near.route.word === 'arc', `${near.kind} ${near.route.word}, ${near.duration.toFixed(1)} s`);
  }
  w = new World({ half: 3000, height: flat(500) });
  for (const [label, above, x, y] of [['2 km ahead from 150 m up', 150, 0, 2000], ['2.8 km to the right from 30 m up', 30, 2800, 0]]) {
    const air = check(`${label}: a level start curving up`, w, { from: flyer(w, 0, 0, above, 0), to: end(w, x, y, EYE, 0, true) });
    if (air) report('... leaves level', air.route.up?.level === true, air.route.up?.level ? 'level' : 'at an angle');
  }
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
  // (route.js, LEANS) or rises straight up first (plan.js, LIFT), an S all
  // the same, never backwards with the view kept.
  {
    const start = { x: -3856, y: -3339 }, span = Math.hypot(start.x, start.y);
    const plateau = (x, y) => 552 + 2225 * Math.min(1, Math.hypot(x, y) / span);
    w = new World({ cx: start.x / 2, cy: start.y / 2, half: 6000, n: 256, height: plateau });
    const steep = check('down from a high plateau into a deep valley, facing away', w,
      { from: flyer(w, start.x, start.y, 300, -2.2, -0.25), to: end(w, 0, 0, 300, -2.2, false) });
    report('... an S, and the view looks the way it goes, not back', steep?.kind === 'curve',
      steep ? `${steep.kind} ${steep.route.word}, climbing at ${(steep.design.up.angle / DEG).toFixed(0)}° lean ${steep.design.up.lean}, ` +
        `coming down at ${(steep.design.down.angle / DEG).toFixed(0)}° lean ${steep.design.down.lean}` +
        `${steep.route.lift ? `, straight up first ${Math.round(100 * steep.route.lift)}% of the way` : ''}, ${steep.duration.toFixed(1)} s` : 'no plan');
  }
  // His words on 5.10b: "on long S flights make the vertical curve less
  // sharp" (5.10b tilted the view at up to 100°/s where a climb bent over
  // into the cruise). In the open, the view tilts at most PITCH.rate at the
  // natural pace, with the bell made longer for it, PITCH.longer times at
  // most.
  {
    const open = new World({ half: 25000, n: 64, height: flat(500) });
    const tilts = [];
    for (const [label, from, to] of [
      ['a walker, 2 km ahead and to the right', walker(open, 0, 0, 0), end(open, 1400, 1400, EYE, 0, true)],
      ['a walker, 5 km behind', walker(open, 0, 0, 0), end(open, 500, -5000, EYE, 0, true)],
      ['flying 100 m up, 1 km ahead and to the right', flyer(open, 0, 0, 100, 0), end(open, 800, 600, 100, 0, false)],
      ['flying 300 m up, 5 km', flyer(open, 0, 0, 300, 0), end(open, 2000, 4500, 300, 0, false)],
      ['flying 300 m up, 20 km almost ahead', flyer(open, 0, 0, 300, 0), end(open, 1700, 19900, 300, 0, false)],
      ['a walker, 20 km ahead', walker(open, 0, 0, 0), end(open, 1700, 19900, EYE, 0, true)],
    ]) {
      const plan = check(`the tilt: ${label}`, open, { from, to, settings: { ...DEFAULT_SETTINGS, longest: 60 } });
      if (plan) tilts.push({ label, plan });
    }
    const slow = tilts.filter(({ plan }) => plan.measuredTilt <= PITCH.rate * 1.03 || plan.longer >= PITCH.longer - 1e-6);
    report('in the open the view tilts at most 25°/s at the natural pace, the bell 1.5 times longer at most', slow.length === tilts.length && tilts.length === 6 &&
      tilts.every(({ plan }) => plan.longer <= PITCH.longer + 1e-9),
      tilts.map(({ label, plan }) => `${label}: ${(plan.measuredTilt / DEG).toFixed(1)}°/s, climbing at ${(plan.route.up.angle / DEG).toFixed(0)}°` +
        `${plan.longer > 1.001 ? `, ${plan.longer.toFixed(2)} times longer` : ''}`).join('; ') + ' (5.10b: 20 to 105°/s)');
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
    // In the open, a walker leaves at a gentle angle and curves up into the
    // climb at 60° (his answers on 5.7b and 5.9b: "60°", "rising in a
    // curve"; route.js, CURVE), and the view turns onto the path while it
    // rises its first VIEW.height metres.
    w = new World({ half: 6000, n: 64, height: flat(500) });
    const open = check('a walker in the open, 2 km ahead and to the right', w, { from: walker(w, 0, 0, 0), to: end(w, 1400, 1400, EYE, 0, true) });
    if (open) {
      const a1 = climbAt(open, 1), a10 = climbAt(open, 10), a30 = climbAt(open, 30);
      let t = 0;
      for (; t < open.duration; t += 0.001) { open.at(t, pose); if (pose.height - open.h[0] >= VIEW.height) break; }
      report('... leaves the way it faces at about 30°, curves up into its 60° climb, and turns onto the path over its first 100 m up',
        open.route.leaves === 0 && a1 > 26 * DEG && a1 < 35 * DEG && a10 > a1 + 15 * DEG && Math.abs(a30 - 60 * DEG) < 3 * DEG && Math.abs(open.viewIn - t) < 0.01,
        `leaves heading ${deg(open.route.leaves)}, climbs at ${deg(a1)} 1 m up, ${deg(a10)} 10 m up and ${deg(a30)} 30 m up; the view on the path after ${open.viewIn.toFixed(2)} s, 100 m up after ${t.toFixed(2)} s`);
    }
    // Boxed in a courtyard 8 m across, its walls 20 m high: straight up.
    w = new World({ half: 3000, n: 64, height: flat(500), boxes: [
      { x0: -20, y0: 4, x1: 20, y1: 10, top: 520 }, { x0: -20, y0: -10, x1: 20, y1: -4, top: 520 },
      { x0: 4, y0: -4, x1: 10, y1: 4, top: 520 }, { x0: -10, y0: -4, x1: -4, y1: 4, top: 520 }] });
    const boxed = check('a walker in a courtyard, 2 km ahead', w, { from: walker(w, 0, 0, 0), to: end(w, 300, 2000, EYE, 0, true) });
    if (boxed) report('... rises straight up first', climbAt(boxed, 1) > 85 * DEG && climbAt(boxed, 15) > 85 * DEG,
      `climbs at ${deg(climbAt(boxed, 1))} 1 m up and ${deg(climbAt(boxed, 15))} 15 m up`);
    // A wall 25 m high 3 m ahead, open behind (Stage 5.12b, his words: "at the
    // start it checks 360 around to see where the least steep angle take off
    // is and choose that"): it turns its back on the wall and leaves as gently
    // as in the open, the view turning onto the path as it rises (5.11b
    // climbed straight at the wall, at over 70°).
    w = new World({ half: 3000, n: 64, height: flat(500), boxes: [{ x0: -40, y0: 3, x1: 40, y1: 8, top: 525 }] });
    const wall = check('a walker 3 m from a 25 m wall ahead, 2 km on', w, { from: walker(w, 0, 0, 0), to: end(w, 300, 2000, EYE, 0, true) });
    if (wall) report('... turns its back on the wall and leaves as gently as in the open',
      Math.abs(wrapAngle(wall.route.leaves - Math.PI)) <= 90 * DEG && climbAt(wall, 1) < 40 * DEG && wall.route.up.angle <= 60 * DEG + 1e-9,
      `leaves heading ${deg(wall.route.leaves)}, climbing at ${deg(climbAt(wall, 1))} 1 m up into ${deg(wall.route.up.angle)} (5.11b: at the wall, over 70°)`);
    // In a street 12 m wide between 25 m walls, facing one: along the street,
    // the gentlest way there is (still steeper than in the open).
    w = new World({ half: 3000, n: 64, height: flat(500), boxes: [{ x0: -300, y0: 6, x1: 300, y1: 12, top: 525 }, { x0: -300, y0: -12, x1: 300, y1: -6, top: 525 }] });
    const street = check('a walker in a 12 m street, facing a 25 m wall, 2 km on', w, { from: walker(w, 0, 0, 0), to: end(w, 300, 2000, EYE, 0, true) });
    if (street) report('... leaves along the street', Math.abs(Math.abs(wrapAngle(street.route.leaves)) - 90 * DEG) <= 20 * DEG && street.route.up.angle < 90 * DEG,
      `leaves heading ${deg(street.route.leaves)}, climbing at ${deg(street.route.up.angle)} (straight at the wall: 90°)`);
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
      // The pace: its top speed and its length, before either bell is made
      // longer for how fast the view tilts (Stage 5.11b, PITCH: clearing the
      // ridge takes a steeper climb, which tilts faster).
      const top = (p) => Math.max(...p.speed) * p.longer, length = (p) => p.duration / p.longer;
      report('... as fast over the ridge as over flat ground', Math.abs(length(over) / length(level) - 1) < 0.1 && top(over) / top(level) > 0.98,
        `${length(over).toFixed(1)} s and ${top(over).toFixed(0)} m/s at most, against ${length(level).toFixed(1)} s and ${top(level).toFixed(0)} m/s ` +
        `(climbing at ${(over.route.up.angle / DEG).toFixed(0)}° and ${(level.route.up.angle / DEG).toFixed(0)}°; played ${over.longer.toFixed(2)} and ${level.longer.toFixed(2)} times longer for the tilt)`);
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
/*
 * Each the kind its distance asks for (5.10b, his words: "if CLOSE, alway
 * go straight to the destination, while height follows a parabola, if not
 * close, always S shape, if not close and behind, still make S shape"): a
 * hop, the view kept, under ARC.distance (5.11b: "when hop is close, don't
 * turn the camera"), an S from there on, however far behind the place is
 * and however fast it must turn.
 */
{
  const rand = random(SEED + 2);
  const wrongKind = [], esses = { compress: [], lifted: 0, turn: 0, turnAt: '', tilt: [], longest: 0, tooLong: 0 }, samples = [];
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
    const plan = check(`random flight ${k} (${distance.toFixed(1)} m, ${flying ? `flying ${above.toFixed(0)} m up` : 'walking'})`, world, flightCase);
    if (!plan) continue;
    samples.push(plan.m);
    const want = distance < ARC.distance ? 'hop' : 'curve';
    if (plan.kind !== want) wrongKind.push(`${k} (${distance.toFixed(0)} m): ${plan.kind}`);
    if (plan.kind === 'curve') {
      esses.tilt.push({ tilt: plan.measuredTilt, longer: plan.longer, k });
      if (plan.longer >= PITCH.longer - 1e-6) esses.longest++;
      if (plan.longer > PITCH.longer + 1e-9) esses.tooLong++;
      esses.compress.push(plan.compress);
      if (plan.route.lift > 0) esses.lifted++;
      if (plan.peakTurnRate > esses.turn) { esses.turn = plan.peakTurnRate; esses.turnAt = `flight ${k}, x${plan.compress.toFixed(2)}`; }
    }
  }
  if (COUNT > 0) {
    const c = [...esses.compress].sort((a, b) => a - b), m = [...samples].sort((a, b) => a - b);
    report('every trip the kind its distance asks for: a hop, the view kept, under 300 m, an S from there on', wrongKind.length === 0,
      wrongKind.length ? `${wrongKind.length} not: ${wrongKind.slice(0, 8).join(', ')}` :
        `${c.length} S's: played x${c[Math.floor(c.length / 2)]?.toFixed(2)} median, x${c[Math.floor(0.9 * c.length)]?.toFixed(2)} 90th, ` +
        `x${c.at(-1)?.toFixed(2)} at most (the view turning ${(esses.turn / DEG).toFixed(0)}°/s at most as played, ${esses.turnAt}); ` +
        `${esses.lifted} rising straight up first (LIFT); flight samples ${m[Math.floor(m.length / 2)]} median, ${m.at(-1)} at most`);
    const tilt = esses.tilt.map((e) => e.tilt).sort((a, b) => a - b), tq = (p) => (tilt[Math.min(tilt.length - 1, Math.floor(p * tilt.length))] / DEG).toFixed(1);
    const fast = esses.tilt.filter((e) => e.tilt > PITCH.rate * 1.03 && e.longer < PITCH.longer - 1e-6);
    report('S flights tilt the view no faster than 25°/s at the natural pace, or are 1.5 times longer for it', esses.tooLong === 0 && fast.length === 0,
      `${tilt.length} S's: ${tq(0.5)}°/s median, ${tq(0.9)} 90th, ${tq(1)} at most; ${tilt.filter((t) => t <= PITCH.rate * 1.03).length} within 25°/s, ` +
      `${esses.longest} at the longest bell (the rough stand-in worlds' steep climbs and short trips)` +
      (fast.length ? `; too fast and not lengthened all the way: ${fast.slice(0, 6).map((e) => `${e.k} (${(e.tilt / DEG).toFixed(1)}°/s, x${e.longer.toFixed(2)})`).join(', ')}` : ''));
  }
  const sorted = (a) => [...a].sort((x, y) => x - y), at = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
  const d = sorted(stats.durations), ms = sorted(stats.planMs);
  console.log(`flights: ${stats.flights}; closest ${stats.closest.toFixed(2)} m; duration median ${at(d, 0.5).toFixed(1)} s, ` +
    `90th ${at(d, 0.9).toFixed(1)} s; planning median ${at(ms, 0.5).toFixed(2)} ms, 99th ${at(ms, 0.99).toFixed(1)} ms, worst ${ms.at(-1).toFixed(1)} ms; ` +
    `tilt at most ${(stats.steepest / DEG).toFixed(1)}° on the path and ${(stats.pitchRate / DEG).toFixed(1)}°/s, ` +
    `at most ${(stats.pitchOff / DEG).toFixed(2)}° off its slope (${(stats.bendOff / DEG).toFixed(2)}° sweeping through fast bends); ` +
    `the S's still middle at most ${(100 * stats.sShare).toFixed(2)}%; ` +
    `speed dips at most ${(100 * stats.speedDip).toFixed(2)}%; ${Object.entries(stats.kinds).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  // Checked before flying (Stage 5.12b, plan.js VERIFY): how many flown
  // paths passed nearer what is there than their own check allows, and were
  // planned again; and how near the ones flown still pass.
  const v = stats.verified;
  report('every flown path checked before it flies, and clear', v && v.planned === stats.flights && v.short <= 0,
    v ? `${v.planned} checked; ${v.again} planned again (${Object.entries(v.kinds).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}; ` +
      `passing up to ${v.first.toFixed(2)} m nearer than allowed at first); ${v.points} points short on the plans flown (${v.short.toFixed(2)} m at most)` : 'none checked');
}

/* ---- 5. the runtime ------------------------------------------------------------- */
/*
 * The app's world, stood in for: the ground is a gentle slope, a house
 * stands on the place, and the landing spot is "found" when the case says
 * (as the buildings there would load). A real Camera is flown at 60 frames
 * a second until the flight is over. Every case: there exactly, facing as
 * it started, never jumping (no frame moves much more than its neighbours),
 * on the path never turning faster than the turn limit, whatever moved the
 * end on the way, rising, flying and coming down without rising again
 * (Stage 5.7: a late change reshapes the way ahead, no little corrections),
 * on the plan's own pace all the way (5.10b, his words: "really try to
 * precalculate the path so that it doesn't jump velocity randomly": its
 * clock is real time, whatever has loaded), and never coming down faster
 * than three times the flight's peak pace, in heights a second over the
 * ground (5.11b: with only coarse bounds round the place, a hop's late way
 * down dropped 39 m in a tenth of a second, 6 m under the ground).
 */
{
  const lon0 = 7.75, lat0 = 46.02;
  const { meridian, primeVertical } = radiiAt(lat0);
  const mLat = meridian * DEG, mLon = primeVertical * Math.cos(lat0 * DEG) * DEG;
  const local = (lon, lat) => ({ x: (lon - lon0) * mLon, y: (lat - lat0) * mLat });
  const geo = (x, y) => ({ lon: lon0 + x / mLon, lat: lat0 + y / mLat });
  const world = new World({ half: 6000, height: (x, y) => 1600 + 0.05 * x + 0.02 * y,
    boxes: [{ x0: -6, y0: -5, x1: 6, y1: 5, top: 1610 }] });

  // `coarse`: the bound that many metres too high round the place, less
  // and less out to 300 m (only coarse tiles loaded there, as in the rig's
  // stand-in town when a 3 s hop set off: Stage 5.11b).
  const runCase = (name, { start, yaw = 0.4, pitch = -0.2, walk, above, spot = null, foundAt = 0, maxTime = 60, expect = {},
    lateGround = null, slowPlace = null, settings = DEFAULT_SETTINGS, instant = false, coarse = 0, world: plain = world, appears = null,
    retarget = null }) => {
    // Something not known when the flight set off: in its bound from `appears.at` seconds, there all along.
    const wld = appears?.world ?? plain;
    const camera = new Camera({ lon: start.lon, lat: start.lat, height: 0, yaw, pitch });
    const s0 = local(start.lon, start.lat);
    camera.apply({ lon: start.lon, lat: start.lat, height: wld.ground(s0.x, s0.y) + (walk ? EYE : above), yaw, pitch, roll: 0 });
    let clock = 0;
    // A new place picked mid-flight (flight.js, CONTINUE), as render.js picks it: arriving as the first would have.
    let switched = null;
    const flight = new Flight();
    const env = {
      bound: (lon, lat, r) => {
        const p = local(lon, lat), known = appears && clock < appears.at ? plain : wld;
        return known.bound(p.x, p.y, r) + coarse * Math.max(0, 1 - Math.hypot(p.x, p.y) / 300);
      },
      // The place's ground: a coarse guess too high by lateGround.offset
      // until lateGround.at seconds, then exact.
      groundAt: (lon, lat, out) => {
        const p = local(lon, lat), late = lateGround && clock < lateGround.at;
        out.height = wld.ground(p.x, p.y) + (late ? lateGround.offset : 0);
        out.rank = late ? 12 : GROUND_EXACT;
        return true;
      },
      exactGround: (lon, lat) => { const p = local(lon, lat); return wld.ground(p.x, p.y); },
      landingSpot: (to, h, w, out) => {
        const at = typeof foundAt === 'function' ? foundAt(flight) : clock >= foundAt;
        if (!at) return false;
        const at2 = switched ? retarget.spot ?? null : spot, g = at2 ? geo(at2.x, at2.y) : to, p = local(g.lon, g.lat);
        out.lon = g.lon; out.lat = g.lat; out.ground = wld.ground(p.x, p.y);
        // The room round it (render.js, LANDING_ROOM): as the case says, else roomy.
        out.room = at2?.room ?? 1.5;
        return true;
      },
      endZone: () => clock > 1,
      ready: () => (slowPlace && clock < slowPlace.until ? slowPlace.ready : 1),
      prefetch: () => {}, levelFor: () => 14,
    };
    const target = { lon: lon0, lat: lat0, label: name, covered: true,
      ground: wld.ground(0, 0) + (lateGround ? lateGround.offset : 0), rank: lateGround ? 12 : GROUND_EXACT,
      arrive: walk ? EYE : above, walk };
    flight.start(camera, target, env, settings, { instant });
    let T = flight.plan?.duration ?? 0;
    let closest = Infinity, fastest = 0, prev = null, prevStep = null, worstKick = 0, flown = 0, offPace = 0, dropPace = 0, nearest = Infinity, lastClimb = 0;
    let heightTurns = 0, dir = 0, last = camera.height;
    const dt = 1 / 60;
    while (flight.active && clock < maxTime) {
      if (retarget && !switched && clock >= retarget.at) {
        const g = geo(retarget.x, retarget.y);
        switched = { at: clock, before: prev && prevStep != null ? prevStep / dt : null, yaw: camera.yaw, pitch: camera.pitch, after: null, turn: 0, frames: 0,
          phase: flight.phase, kept: { walk: flight.walk, h1: flight.h1 }, climb: lastClimb };
        flight.start(camera, { lon: g.lon, lat: g.lat, label: name, covered: true, ground: wld.ground(retarget.x, retarget.y), rank: GROUND_EXACT,
          arrive: flight.walk ? EYE : flight.h1, walk: flight.walk }, env, settings, { carry: true });
        T = flight.plan?.duration ?? 0;
        flown = 0;
        switched.c = flight.carry?.c ?? 0;
        switched.blend = flight.carry?.blend ?? 0;
        switched.kind = flight.plan?.kind;
      }
      const flying = flight.phase === 'flight';
      flight.step(dt, camera, env);
      clock += dt;
      // The plan's clock against the time flown along it.
      if (flying) { flown += dt; offPace = Math.max(offPace, Math.abs(flight.t - Math.min(T, flown))); }
      const p = local(camera.lon, camera.lat), on = flight.phase === 'flight' && flight.pose.onPath === 1;
      closest = Math.min(closest, wld.clearance(p.x, p.y, camera.height));
      nearest = Math.min(nearest, wld.distance(p.x, p.y, camera.height));
      if (prev) {
        if (on && prev.on) fastest = Math.max(fastest, Math.abs(wrapAngle(camera.yaw - prev.yaw)) / dt);
        const step = Math.hypot(p.x - prev.x, p.y - prev.y, camera.height - prev.h);
        // A jump: a frame moving much more than the one before.
        if (prevStep != null && flight.active) worstKick = Math.max(worstKick, step - 1.5 * prevStep - 0.05);
        prevStep = step;
        // How fast it comes down, in heights a second over the ground (as PACE counts them).
        const drop = (prev.h - camera.height) / dt, over = Math.max(0, camera.height - wld.ground(p.x, p.y));
        if (drop > 0) dropPace = Math.max(dropPace, drop / (over + PACE.offset));
      }
      const d = camera.height - last;
      if (Math.abs(d) >= HEIGHT_TURN) {
        if (dir !== 0 && Math.sign(d) !== dir) heightTurns++;
        dir = Math.sign(d);
        last = camera.height;
      }
      // Going on after a new pick: the speed kept, the view turning smoothly.
      if (switched && prev && switched.frames < 60) {
        if (switched.frames === 0) switched.after = Math.hypot(p.x - prev.x, p.y - prev.y, camera.height - prev.h) / dt;
        const turn = Math.acos(Math.min(1, Math.cos(camera.pitch) * Math.cos(prev.pitch) * Math.cos(wrapAngle(camera.yaw - prev.yaw)) +
          Math.sin(camera.pitch) * Math.sin(prev.pitch))) / dt;
        switched.turn = Math.max(switched.turn, turn);
        switched.frames++;
      }
      if (prev) lastClimb = (camera.height - prev.h) / dt;
      prev = { on, yaw: camera.yaw, pitch: camera.pitch, x: p.x, y: p.y, h: camera.height };
      if (args.trace && name.includes(args.trace) && Math.round(clock / dt) % 3 === 0) {
        console.log(`    ${clock.toFixed(2).padStart(6)} s ${flight.phase.padEnd(6)} x ${p.x.toFixed(2).padStart(8)} y ${p.y.toFixed(2).padStart(8)} ` +
          `h ${(camera.height - wld.ground(p.x, p.y)).toFixed(2).padStart(7)} clear ${wld.clearance(p.x, p.y, camera.height).toFixed(2).padStart(7)} ` +
          `t ${flight.t.toFixed(2)} corr ${flight.corrections.length} confirmed ${flight.confirmed}`);
      }
    }
    const problems = [];
    const where = local(camera.lon, camera.lat), want = expect.spot ?? spot ?? { x: 0, y: 0 };
    if (flight.active) problems.push(`still flying after ${maxTime} s (${flight.phase})`);
    if (Math.hypot(where.x - want.x, where.y - want.y) > 1e-4) problems.push(`ends ${Math.hypot(where.x - want.x, where.y - want.y).toFixed(4)} m from the spot`);
    const wantHeight = expect.height ?? wld.ground(want.x, want.y) + (walk ? EYE : above);
    if (Math.abs(camera.height - wantHeight) > 1e-6) problems.push(`ends ${(camera.height - wantHeight).toFixed(3)} m off in height`);
    // An arc ends facing the way it went (Stage 5.8b): to the place, from the start.
    const endYaw = flight.endYaw !== yaw && Math.abs(wrapAngle(flight.endYaw - Math.atan2(-s0.x, -s0.y))) < 0.01 * DEG ? flight.endYaw : yaw;
    if (camera.yaw !== endYaw || camera.pitch !== pitch || camera.roll !== 0) problems.push(`ends turned (yaw ${camera.yaw - endYaw}, pitch ${camera.pitch - pitch}, roll ${camera.roll})`);
    if (closest < 1) problems.push(`came within ${closest.toFixed(2)} m of something`);
    // Beside the house too (Stage 5.12b, his answers: "Through a roof or
    // wall, Too close to a wall"): as near as a late change keeps at most.
    if (nearest < (expect.nearest ?? 1)) problems.push(`came within ${nearest.toFixed(2)} m of the house`);
    if (expect.glide != null && (flight.down?.from === 0.5 ? 'after' : flight.down ? 'overlapping' : 'none') !== expect.glide) {
      problems.push(`came down ${flight.down?.from === 0.5 ? 'after crossing' : flight.down ? 'while crossing' : 'without a glide'}`);
    }
    if (worstKick > 0) problems.push(`a frame jumped ${worstKick.toFixed(3)} m more than allowed`);
    if (fastest > TURN.rate * (flight.plan?.compress ?? 1) * 1.1 + 1e-6) problems.push(`turned at ${(fastest / DEG).toFixed(0)}°/s on the path`);
    // One top; picked again while coming down, the first flight's top, a
    // bottom as it pulls out, and the new flight's top.
    const turnsAllowed = switched && switched.climb < -0.5 ? 3 : 1;
    if (heightTurns > turnsAllowed) problems.push(`the height turned ${heightTurns} times (${turnsAllowed === 3 ? 'a top, a bottom and a top' : 'one top'} at most)`);
    if (expect.landed != null && flight.landed !== expect.landed) problems.push(flight.landed ? 'landed' : 'did not land');
    if (offPace > 1e-9) problems.push(`its clock ran ${offPace.toFixed(3)} s off the time flown`);
    // Never dropping much faster than the flight's own pace (Stage 5.11b:
    // a late change's way down squeezed into the last moments dropped 64 m
    // in half a second): three times its peak, as played.
    const dropMost = 3 * PACE.peak * (flight.plan?.compress ?? 1);
    if (dropPace > dropMost) problems.push(`came down at ${dropPace.toFixed(1)} heights a second (${dropMost.toFixed(1)} at most)`);
    if (expect.deferred != null && flight.deferred !== expect.deferred) {
      problems.push(flight.deferred ? 'came down from over the place' : 'came down on the way');
    }
    if (flight.guessed) problems.push('landed on a guess');
    if (retarget) {
      if (!switched) problems.push('never picked the new place');
      else {
        // The speed it had, kept across the pick (within 10%, or half a metre a second, when not slower to start with).
        const lost = switched.before != null ? switched.before - switched.after : 0;
        if (lost > 0.1 * switched.before + 0.5) problems.push(`slowed from ${switched.before.toFixed(1)} to ${switched.after.toFixed(1)} m/s at the new pick`);
        if (switched.turn > (expect.turn ?? 90 * DEG)) problems.push(`the view turned at ${(switched.turn / DEG).toFixed(0)}°/s after the new pick`);
        if (flight.walk !== switched.kept.walk || flight.h1 !== switched.kept.h1) problems.push('arrived otherwise than the first flight would have');
      }
    }
    if (expect.gaveUp != null && flight.gaveUp !== expect.gaveUp) problems.push(flight.gaveUp ? 'gave up, hovering' : 'did not give up');
    // The plan and finishing a late move of the end (flight.js, FINISH), and
    // over the place where the case says; an instant trip only settles: 5 s
    // and a last glide at most (SETTLE).
    const longest = instant ? 5 + 2.5 + dt : Math.min(settings.longest, T) + 2.05 + (expect.hoverExtra ?? 0);
    if (flight.elapsed > longest) problems.push(`flew ${flight.elapsed.toFixed(2)} s (plan ${T.toFixed(2)})`);
    if (expect.hovered === false && flight.hovered > 0) problems.push(`hovered ${flight.hovered.toFixed(2)} s over the place`);
    if (expect.hovered === true && !(flight.hovered > 0)) problems.push('never hovered over the place');
    // The watch (flight.js, WATCH) lifts the way only over what has come to stand in it.
    if ((flight.lifts > 0) !== (expect.lifts ?? Boolean(appears))) problems.push(flight.lifts ? `rose over something ${flight.lifts} times` : 'never rose over it');
    report(`runtime: ${name}`, problems.length === 0, problems.length ? problems.join('; ') :
      `${clock.toFixed(1)} s (plan ${T.toFixed(1)}${flight.hovered > 0 ? `, ${flight.hovered.toFixed(1)} s over the place` : ''}), ` +
      `closest ${closest.toFixed(2)} m, ${nearest.toFixed(2)} m from the house, down at ${dropPace.toFixed(2)} heights/s at most, plans ${flight.planMs.toFixed(2)} ms, ` +
      `${flight.corrections.length} late changes${flight.lifts ? ` (${flight.lifts} rising over what came to stand in the way)` : ''}` +
      `${flight.deferred ? ', down from over the place' : ''}${flight.landed ? ', landed' : ''}` +
      `${flight.verified?.tries ? `, planned ${flight.verified.tries + 1} times before it flew` : ''}` +
      (switched ? `; picked again at ${switched.at.toFixed(1)} s (${switched.phase}) at ${switched.before?.toFixed(1)} m/s (climbing ${switched.climb.toFixed(1)}), going on at ${switched.after?.toFixed(1)} m/s ` +
        `(a ${switched.kind}, clock c ${switched.c.toFixed(2)}, the rest given up over ${switched.blend.toFixed(2)} s), the view turning ${(switched.turn / DEG).toFixed(0)}°/s at most` : ''));
  };

  const at = (x, y) => geo(x, y);
  // Found with `left` seconds of the plan to go.
  const leftOf = (left) => (f) => f.plan && f.t > f.plan.duration - left;
  runCase('a landing spot known at once', { start: at(-400, -300), walk: true, spot: { x: -12, y: -5 }, foundAt: 0,
    expect: { landed: true, hovered: false } });
  runCase('a landing spot found on the way', { start: at(-1500, -900), walk: true, spot: { x: -12, y: -5 }, foundAt: 1.2,
    expect: { landed: true, hovered: false } });
  // Late, with time enough to reshape the way down (CORRECT.late) at the
  // flight's pace (CORRECT.pace): onto it on the way.
  runCase('a landing spot found 6 s before the end: down onto it on the way', { start: at(-300, -200), walk: true, spot: { x: -8, y: 6 },
    foundAt: leftOf(6), expect: { landed: true, hovered: false, deferred: false } });
  // Later: in 5.11b its way down would drop 29 m in the last second (56 m/s
  // 11 m up, 3.3 heights a second), there being no clear way down but over
  // the last step (this world's ground is known only to a few metres, and
  // the way was kept a metre over it right over the spot too), and it came
  // down from over the place. Right over the spot is open sky (Stage
  // 5.12b): down onto it on the way, at the flight's pace.
  runCase('a landing spot found 3.5 s before the end: down onto it on the way, at the flight\'s pace', { start: at(-300, -200),
    walk: true, spot: { x: -8, y: 6 }, foundAt: leftOf(3.5), expect: { landed: true, deferred: false, hovered: false } });
  // Only coarse bounds round the place (the rig's stand-in town, Stage
  // 5.11b): a 150 m hop's way down was clear only at its end, dropped 39 m
  // in a tenth of a second and went 6 m under the ground; now over the
  // place, then down. A longer flight comes down on the way, at its pace.
  runCase('a hop to a place with only coarse bounds round it: never under the ground', { start: at(-120, -90), walk: true,
    spot: { x: -8, y: 6 }, foundAt: 0.3, coarse: 40, expect: { landed: true, deferred: true, hoverExtra: HOVER.most + 1 } });
  runCase('a landing at a place with only coarse bounds round it, found on the way', { start: at(-1500, -900), walk: true,
    spot: { x: -12, y: -5 }, foundAt: 1.2, coarse: 40, expect: { landed: true, hovered: false, deferred: false } });
  // Later than that: over the place first, then down onto it (HOVER).
  runCase('a landing spot found 1.5 s before the end: over the place, then down onto it', { start: at(-300, -200), walk: true,
    spot: { x: -8, y: 6 }, foundAt: leftOf(1.5), expect: { landed: true, hoverExtra: HOVER.most + 1 } });
  // Never on a guess (Stage 5.8b): over the place, HOVER.above the ground or
  // HOVER.margin over the house, looking for HOVER.patience seconds, then left there.
  runCase('a landing spot never found: hovering over the place', { start: at(-300, -200), walk: true, foundAt: () => false,
    expect: { landed: false, hovered: true, gaveUp: true, spot: { x: 0, y: 0 },
      height: Math.max(world.ground(0, 0) + HOVER.above, world.bound(0, 0, HOVER.radius) + HOVER.margin), hoverExtra: HOVER.patience + 1 } });
  runCase('a landing spot found while hovering: down onto it', { start: at(-300, -200), walk: true, spot: { x: -8, y: 6 },
    foundAt: (f) => f.phase === 'wait' && f.hovered > 3, expect: { landed: true, hovered: true, hoverExtra: 3.5 + HOVER.most + 1 } });
  runCase('a short hop whose spot is found late', { start: at(-35, -30), walk: true, spot: { x: -8, y: 6 }, foundAt: leftOf(1.5),
    expect: { landed: true, hoverExtra: HOVER.most + 1 } });
  runCase('a walker\'s landing 50 m behind, found on the way', { start: at(0, 50), yaw: 0, pitch: -0.1, walk: true, spot: { x: -8, y: 6 },
    foundAt: 4, expect: { landed: true, hoverExtra: HOVER.most } });
  // Right beside the house, 1.6 m from its wall (Stage 5.12b): coming down,
  // never nearer the house than a metre, on the way or from over the place,
  // where the glide down is all the way across before it comes down.
  runCase('a landing spot 1.6 m from the house, found on the way', { start: at(-1500, -900), walk: true, spot: { x: -7.6, y: 0 },
    foundAt: 1.2, expect: { landed: true, hoverExtra: HOVER.most + 1 } });
  runCase('a landing spot 1.6 m from the house, found while over it', { start: at(-300, -200), walk: true,
    spot: { x: -7.6, y: 0 }, foundAt: (f) => f.phase === 'wait' && f.hovered > 1, expect: { landed: true, hovered: true, hoverExtra: 1.5 + HOVER.most + 1 } });
  // Over a 150 m tower 50 m wide, its spot 1.6 m beyond its far wall: across
  // and down together would come down 9 m before it is clear of the roof,
  // 0.8 m over it; all the way across first, then straight down.
  const tower = new World({ half: 6000, height: (x, y) => 1600 + 0.05 * x + 0.02 * y, boxes: [{ x0: -60, y0: -10, x1: -10, y1: 10, top: 1750 }] });
  runCase('a landing spot beside a 150 m tower, found while over it: across, then down', { start: at(-300, -200), walk: true, world: tower,
    spot: { x: -61.6, y: 0 }, foundAt: (f) => f.phase === 'wait' && f.hovered > 1, expect: { landed: true, hovered: true, glide: 'after',
      hoverExtra: 1.5 + HOVER.most + 1 } });
  runCase('a landing spot well away from the house, found while over it: across and down together', { start: at(-300, -200), walk: true,
    spot: { x: -30, y: 20 }, foundAt: (f) => f.phase === 'wait' && f.hovered > 1, expect: { landed: true, hovered: true, glide: 'overlapping',
      hoverExtra: 1.5 + HOVER.most + 1 } });
  runCase('3 km, 200 m up, no landing', { start: at(-2500, 1700), walk: false, above: 200, expect: { landed: false, hovered: false } });
  // A new place picked mid-flight (Stage 5.12b, his words: "if you click on
  // another result while in flyTo animation, remember the initial condition";
  // his answer: keep the speed): arriving as the first flight would have,
  // walking or as high up, facing the way it faced, going on from the speed
  // it had and the way it was going.
  runCase('a walker picks another place while climbing: lands walking there', { start: at(-1500, -900), walk: true,
    retarget: { at: 5, x: 700, y: 500 }, expect: { landed: true, spot: { x: 700, y: 500 }, hoverExtra: HOVER.most + 1 } });
  runCase('200 m up, another place picked in the cruise: arrives 200 m up there', { start: at(-2500, 1700), walk: false, above: 200,
    retarget: { at: 14, x: -1500, y: -1800 }, expect: { landed: false, spot: { x: -1500, y: -1800 } } });
  runCase('200 m up, another place picked coming down: pulls out and goes on', { start: at(-2500, 1700), walk: false, above: 200,
    retarget: { at: 24, x: 1200, y: -900 }, expect: { landed: false, spot: { x: 1200, y: -900 } } });
  runCase('a walker coming down picks a place 150 m on: a hop there, walking', { start: at(-1500, -900), walk: true, spot: { x: -8, y: 6 },
    retarget: { at: 25, x: 120, y: 90 }, expect: { landed: true, spot: { x: 120, y: 90 }, hoverExtra: HOVER.most + 1 } });
  // A tower 700 m tall and 50 m wide halfway along, 150 m higher than the
  // way passes there, not known until 4 s into the flight (Stage 5.12b,
  // WATCH): the way ahead rises over it, comes back down after it, and
  // arrives as planned, one top all the same.
  const late = new World({ half: 6000, height: (x, y) => 1600 + 0.05 * x + 0.02 * y,
    boxes: [{ x0: -6, y0: -5, x1: 6, y1: 5, top: 1610 }, { x0: -1275, y0: 825, x1: -1225, y1: 875, top: 1600 + 650 }] });
  runCase('a tower known only once on the way: over it', { start: at(-2500, 1700), walk: false, above: 200, appears: { world: late, at: 4 },
    expect: { landed: false, hovered: false, lifts: true } });
  runCase('... and nothing new on the way: never nudged', { start: at(-2500, 1700), walk: false, above: 200, expect: { landed: false, lifts: false } });
  runCase('better ground at the place on the way: the end follows it', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 1.5, offset: 80 }, expect: { landed: false } });
  runCase('better ground found on the way down', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 9, offset: 30 }, expect: { landed: false } });
  // Half of it loaded until the end: the flight keeps its pace all the same.
  runCase('the place slow to load: the flight keeps its pace', { start: at(-3000, 2000), walk: false, above: 150,
    slowPlace: { until: 60, ready: 0.5 }, expect: { landed: false, hovered: false } });
  runCase('Longest flight 4 s, with better ground on the way', { start: at(-4000, 2600), walk: false, above: 150,
    lateGround: { at: 1.0, offset: 80 }, settings: { ...DEFAULT_SETTINGS, longest: 4 }, expect: { landed: false } });
  // Fly to search results off: there at once on the coarse guess, then onto the exact ground.
  runCase('an instant trip settles onto better ground', { start: at(-3000, 2000), walk: false, above: 150, instant: true,
    lateGround: { at: 1.0, offset: 40 }, expect: { landed: false } });
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exitCode = failures ? 1 : 0;
