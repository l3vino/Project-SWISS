/* walk-test.mjs — the walker in Node: Minecraft's movement (Java Edition,
 * tick by tick at a person's speeds, Stage 5.12b), sneaking and its edges,
 * the crouch under a low ceiling, the air's drag on the body's own shape
 * (against the drag equation integrated finely, and against people's
 * measured drag and fall speeds), a flight's speed kept when you switch to
 * walking in the air, and lost to the air even while held waiting for the
 * ground (5.10b). Run: node tools/walk-test.mjs
 */

import { WalkController, MC, CROUCH, DRAG, BODY } from '../js/engine/controllers/walk.js';
import { FlyController } from '../js/engine/controllers/fly.js';
import { Camera, KEY } from '../js/engine/camera.js';
import { DEG } from '../js/core/math.js';
import { air } from '../js/engine/aircraft/atmosphere.js';

const GROUND = 500;
const LON = 7.5, LAT = 46.5;
const flat = {
  sample(lon, lat, out) { out.height = GROUND; out.gradE = out.gradN = 0; out.level = 20; out.accurate = true; return true; },
  highest: () => GROUND,
  settled: () => true,
};
const params = {
  walkSpeed: 1.4, runSpeed: 4.5, jumpHeight: 0.45, gravity: 9.81, maxSlope: 45 * DEG,
  eyeHeight: 1.75 * 0.936, bodyHeight: 1.75, bodyWidth: BODY.width, bodyDepth: BODY.depth, bodyMass: BODY.mass,
  flyThrough: false,
};
const DT = 1 / 120;

let failures = 0;
const report = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
};

/* A walker facing `yaw` with its eye `height` up, over `ground`, among `solids`. */
function walker({ height = GROUND + params.eyeHeight, ground = flat, solids = null, yaw = 0, velocity = null, p = params } = {}) {
  const camera = new Camera({ lon: LON, lat: LAT, height, yaw, pitch: 0 });
  const walk = new WalkController();
  walk.enter(velocity ? { velocity } : {});
  const s = { camera, walk, ground, solids, p, t: 0 };
  if (!velocity) step(s, 0);   // lands at once where it stands
  return s;
}
const step = (s, keys, pressed = 0) => { s.walk.step(DT, keys, pressed, s.camera, s.ground, s.p, s.solids); s.t += DT; };
const run = (s, seconds, keys, each) => {
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) { step(s, keys, i === 0 ? keys : 0); each?.(s); }
};
/* Holds `keys` with Space until the walker leaves the ground. */
const jump = (s, keys = 0) => { for (let i = 0; i < 40 && s.walk.grounded; i++) step(s, keys | KEY.UP, i === 0 ? KEY.UP : 0); };
const northOf = (s) => (s.camera.lat - LAT) * 111195;
const eastOf = (s) => (s.camera.lon - LON) * 111320 * Math.cos(LAT * DEG);
const feetOf = (s) => s.camera.height - s.walk.eye;

/* ---------------- Minecraft's movement ---------------- */
{
  // On the ground: your pace in a quarter of a second, stopped in a quarter (Minecraft's 0.546 a tick).
  const s = walker();
  let reached = null, stopped = null, t0 = s.t;
  run(s, 1, KEY.FORWARD, (z) => { if (reached == null && z.walk.vNorth > 0.95 * params.walkSpeed) reached = z.t - t0; });
  const pace = s.walk.vNorth; t0 = s.t;
  run(s, 1, 0, (z) => { if (stopped == null && z.walk.vNorth < 0.05 * params.walkSpeed) stopped = z.t - t0; });
  report('walking: up to pace and stopped as in Minecraft', Math.abs(pace - params.walkSpeed) < 1e-4 && reached <= 0.3 && stopped <= 0.3,
    `${pace.toFixed(3)} m/s, 95% of it after ${reached?.toFixed(2)} s, under 5% ${stopped?.toFixed(2)} s after letting go`);
}
{
  // Sprint-jumping, W, Ctrl and Space held: the running jump's push forward on every take-off.
  const s = walker();
  run(s, 1, KEY.FORWARD | KEY.SPRINT);
  const runPace = s.walk.vNorth, n0 = northOf(s), t0 = s.t, j0 = s.walk.jumps;
  run(s, 6, KEY.FORWARD | KEY.SPRINT | KEY.UP);
  const average = (northOf(s) - n0) / (s.t - t0), ratio = average / runPace;
  report('sprint-jumping: faster than running, as in Minecraft', ratio > 1.15 && ratio < 1.3 && s.walk.jumps - j0 >= 9,
    `${average.toFixed(2)} m/s on average over ${s.walk.jumps - j0} jumps, ${ratio.toFixed(2)} times the run ` +
    `(Minecraft 1.27 with its 0.60 s jump; this ${params.jumpHeight} m one lasts 0.61 s)`);
}
{
  // A running jump with every key let go once in the air: no sudden stop,
  // the air takes 9% a tick (Minecraft's 0.91), about a third of the run left by landing.
  const s = walker();
  run(s, 1, KEY.FORWARD | KEY.SPRINT);
  jump(s, KEY.FORWARD | KEY.SPRINT);
  const takeoff = s.walk.vNorth;
  let last = takeoff, worst = 1, ticks = 0, landed = null, first = null;
  for (let i = 0; i < 120 && !s.walk.grounded; i++) {
    step(s, 0);
    const v = s.walk.vNorth;
    // A tick takes a share of the speed at once; between ticks only the drag, a hair a step.
    if (v < 0.99 * last) { ticks++; if (ticks === 1) first = v; else worst = Math.min(worst, v / last); }
    last = v;
    if (s.walk.grounded) landed = v;
  }
  report('a running jump let go of: the speed fades through the air, never stops', worst > 0.905 && landed / params.runSpeed > 0.25 && landed / params.runSpeed < 0.45,
    `${takeoff.toFixed(2)} m/s taking off (the push forward), ${first?.toFixed(2)} after the take-off tick (the ground's), ` +
    `then at least ${(worst * 100).toFixed(1)}% kept a tick, ${landed?.toFixed(2)} m/s landing (${(landed / params.runSpeed * 100).toFixed(0)}% of the run)`);
}
{
  // Hopping with Space held, W let go: the one ground tick between two jumps
  // decides, with nothing held about half the speed goes there (W held: none, above).
  const s = walker();
  run(s, 1, KEY.FORWARD | KEY.SPRINT);
  run(s, 1.2, KEY.FORWARD | KEY.SPRINT | KEY.UP);
  const after = [];
  for (let i = 0; i < 3; i++) { run(s, 0.6, KEY.UP); after.push(s.walk.speed); }
  report('hopping without W: slower at every landing, as in Minecraft', after[0] > 0.5 && after[0] < 1.5 && after[2] < 0.1,
    `${after.map((v) => v.toFixed(2)).join(', ')} m/s after 0.6, 1.2 and 1.8 s`);
}
{
  // A standing jump, then W in the air: the air's fifth of the ground's push.
  const s = walker();
  jump(s);
  let most = 0, airborne = 0;
  run(s, 0.8, KEY.FORWARD, (z) => { if (!z.walk.grounded) { airborne += DT; most = Math.max(most, z.walk.vNorth); } });
  const share = most / params.walkSpeed;
  report('air control: W in the air adds speed slowly', share > 0.5 && share < 0.8,
    `${most.toFixed(2)} m/s by landing, ${(share * 100).toFixed(0)}% of the pace, ${airborne.toFixed(2)} s in the air`);
}
{
  // The jump's height is a person's (Jump height), whatever the ticks.
  const s = walker();
  jump(s);
  run(s, 1, 0);
  report('a jump rises as high as asked', Math.abs(s.walk.lastJump - params.jumpHeight) < 0.005,
    `${s.walk.lastJump.toFixed(3)} m (asked ${params.jumpHeight})`);
}
{
  // Diagonals (W and D) no faster than W alone (Stage 5.11b, his words: "way
  // to quick diagonally"): on the ground, and falling off a 20 m ledge, where
  // the air's own limit is the pace's 0.2 × 0.454 / 0.09 = 1.009 times.
  const s = walker();
  let walking = 0;
  run(s, 1, KEY.FORWARD | KEY.RIGHT, (z) => { walking = Math.max(walking, z.walk.speed); });
  const f = walker({ height: GROUND + 20, yaw: 0.3 });
  let falling = 0, airborne = 0;
  run(f, 2.5, KEY.FORWARD | KEY.RIGHT | KEY.SPRINT, (z) => { if (!z.walk.grounded) { airborne += DT; falling = Math.max(falling, z.walk.speed); } });
  const limit = (MC.airShare * (1 - MC.ground)) / (1 - MC.air);
  report('diagonals as fast as straight on', walking <= params.walkSpeed * (1 + 1e-9) && walking > 0.99 * params.walkSpeed &&
    falling <= params.runSpeed * limit + 1e-9 && falling > 0.9 * params.runSpeed && airborne > 1.5,
    `walking ${walking.toFixed(3)} m/s (pace ${params.walkSpeed}), running off a ledge ${falling.toFixed(3)} m/s at most in ${airborne.toFixed(1)} s ` +
    `of air (pace ${params.runSpeed}, the air's limit ${(params.runSpeed * limit).toFixed(2)}; 5.10b: ${2 * params.runSpeed})`);
}
{
  // Flying, W with Space no faster than W alone.
  const speeds = [];
  for (const keys of [KEY.FORWARD, KEY.FORWARD | KEY.UP, KEY.FORWARD | KEY.RIGHT | KEY.UP, KEY.BACK | KEY.LEFT | KEY.DOWN]) {
    const camera = new Camera({ lon: LON, lat: LAT, height: GROUND + 300, yaw: 0, pitch: 0, speed: 50 });
    const fly = new FlyController();
    fly.enter();
    fly.step(DT, keys, 0, camera, flat, params);
    const v = fly.velocity;
    speeds.push(Math.hypot(v.east, v.north, v.up));
  }
  report('flying: diagonals as fast as straight on, up and down too', speeds.every((v) => Math.abs(v - 50) < 1e-6),
    `${speeds.map((v) => v.toFixed(2)).join(', ')} m/s (W; W with Space; W, D and Space; S, A and Shift; speed 50; 5.10b: 50, 70.7, 70.7, 70.7)`);
}

/* ---------------- sneaking ---------------- */
{
  // Shift: 30% of the walking pace, the eye at Minecraft's 1.27 of 1.62, no running.
  const s = walker();
  run(s, 1, KEY.FORWARD | KEY.DOWN);
  const pace = s.walk.vNorth, eye = s.camera.height - GROUND;
  const r = walker();
  run(r, 1, KEY.FORWARD | KEY.SPRINT | KEY.DOWN);
  run(s, 0.5, 0);
  const up = s.camera.height - GROUND;
  report('sneaking: slower and lower, no running', Math.abs(pace - MC.sneak * params.walkSpeed) < 1e-4 &&
    Math.abs(eye - CROUCH.eye * params.eyeHeight) < 1e-3 && Math.abs(r.walk.vNorth - pace) < 1e-9 && Math.abs(up - params.eyeHeight) < 1e-3,
    `${pace.toFixed(3)} m/s (30% of ${params.walkSpeed}), the eye ${eye.toFixed(3)} m (standing ${params.eyeHeight.toFixed(3)}), ` +
    `with Ctrl ${r.walk.vNorth.toFixed(3)} m/s, the eye back to ${up.toFixed(3)} m after letting go`);
}
{
  // Edges (his words: "if he holds shift, user can't fall off of edges"): a
  // 2 m drop 3 m ahead; sneaking stops with the middle at it, walking falls.
  const cliff = (drop) => ({ ...flat, sample(lon, lat, out) {
    out.height = (lat - LAT) * 111195 < 3 ? GROUND : GROUND - drop; out.gradE = out.gradN = 0; out.level = 20; out.accurate = true; return true;
  } });
  const result = [];
  for (const keys of [KEY.FORWARD | KEY.DOWN, KEY.FORWARD]) {
    const s = walker({ ground: cliff(2) });
    let lowest = Infinity;
    run(s, 12, keys, (z) => { lowest = Math.min(lowest, feetOf(z) - GROUND); });
    result.push({ on: northOf(s), lowest, stops: s.walk.edgeStops });
  }
  const [sneak, walk] = result;
  report('sneaking stops at an edge; walking falls off it', sneak.on > 2.99 && sneak.on <= 3 && sneak.lowest > -1e-6 && walk.lowest < -1.99,
    `sneaking ${sneak.on.toFixed(3)} m on (the edge at 3), feet never lower than ${sneak.lowest.toFixed(2)} m (${sneak.stops} steps cut); ` +
    `walking ${walk.on.toFixed(2)} m on, down ${(-walk.lowest).toFixed(2)} m`);
  // Into it diagonally: slides along it; a 0.3 m step down is no edge.
  const d = walker({ ground: cliff(2) });
  run(d, 14, KEY.FORWARD | KEY.RIGHT | KEY.DOWN);
  const t = walker({ ground: cliff(0.3) });
  run(t, 12, KEY.FORWARD | KEY.DOWN);
  report('... sliding along it, and down a step', northOf(d) > 2.99 && northOf(d) <= 3 && eastOf(d) > 2 && northOf(t) > 4.5,
    `diagonally ${northOf(d).toFixed(3)} m north and ${eastOf(d).toFixed(2)} m east along it; down a 0.3 m step: ${northOf(t).toFixed(2)} m on`);
}
{
  // The terrain's cliffs are steep slopes, not walls: a 70° one from 3 m ahead.
  const T = Math.tan(70 * DEG);
  const slope = { ...flat, sample(lon, lat, out) {
    const n = (lat - LAT) * 111195;
    out.height = n < 3 ? GROUND : GROUND - (n - 3) * T; out.gradE = 0; out.gradN = n < 3 ? 0 : -T; out.level = 20; out.accurate = true; return true;
  } };
  const s = walker({ ground: slope }), w = walker({ ground: slope });
  let lowest = Infinity, down = Infinity;
  run(s, 12, KEY.FORWARD | KEY.DOWN, (z) => { lowest = Math.min(lowest, feetOf(z) - GROUND); });
  run(w, 6, KEY.FORWARD, (z) => { down = Math.min(down, feetOf(z) - GROUND); });
  report('sneaking stops at the top of a cliff in the terrain', northOf(s) > 2.99 && northOf(s) <= 3 && lowest > -1e-6 && down < -10,
    `sneaking ${northOf(s).toFixed(3)} m on (its top at 3), walking down ${(-down).toFixed(0)} m of it`);
}
/* A flat-topped building, metres from the walker's start (x east, y north), and an optional low ceiling. */
function building({ roof = null, ceiling = null }) {
  const c = new Camera({ lon: LON, lat: LAT, height: GROUND, yaw: 0, pitch: 0 }), o = c.offsetLonLat(1, 1, {});
  const mLon = 1 / (o.lon - LON), mLat = 1 / (o.lat - LAT), within = (b, x, y) => b && x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  return {
    active: true,
    origin: { lon: LON, lat: LAT, height: GROUND },
    toLocal(lon, lat, height, out) { out.x = (lon - LON) * mLon; out.y = (lat - LAT) * mLat; out.z = height - GROUND; return out; },
    floor: (x, y, zMax) => (within(roof, x, y) && roof.z <= zMax + 1e-4 ? roof.z : -Infinity),
    ceiling: (x, y, zMin) => (within(ceiling, x, y) && ceiling.z >= zMin ? ceiling.z : Infinity),
    sweep: (from, to) => to,
  };
}
{
  // A roof 6 m up whose edge is 3 m ahead.
  const solids = building({ roof: { x0: -10, x1: 10, y0: -10, y1: 3, z: 6 } });
  const s = walker({ height: GROUND + 6 + params.eyeHeight, solids }), w = walker({ height: GROUND + 6 + params.eyeHeight, solids });
  let lowest = Infinity, down = Infinity;
  run(s, 12, KEY.FORWARD | KEY.DOWN, (z) => { lowest = Math.min(lowest, feetOf(z) - GROUND); });
  run(w, 6, KEY.FORWARD, (z) => { down = Math.min(down, feetOf(z) - GROUND); });
  report('sneaking stops at a roof\'s edge', northOf(s) > 2.99 && northOf(s) <= 3.001 && lowest > 6 - 1e-6 && Math.abs(down) < 1e-6,
    `sneaking ${northOf(s).toFixed(3)} m on (the edge at 3), feet never under ${lowest.toFixed(2)} m; walking off it, down to ${down.toFixed(2)} m`);
}
{
  // Shift let go under a ceiling 1.6 m up (lower than the body, 1.75): crouched and slow until out from under it.
  const solids = building({ ceiling: { x0: -10, x1: 10, y0: 0.5, y1: 4, z: 1.6 } });
  const s = walker({ solids });
  run(s, 4, KEY.FORWARD | KEY.DOWN);
  run(s, 2, KEY.FORWARD);
  const under = { eye: s.camera.height - GROUND, pace: s.walk.vNorth, at: northOf(s), state: s.walk.crouched };
  run(s, 8, KEY.FORWARD);
  const out = { eye: s.camera.height - GROUND, pace: s.walk.vNorth, at: northOf(s) };
  report('no room to stand up: crouched until out from under it', under.state && Math.abs(under.eye - CROUCH.eye * params.eyeHeight) < 1e-3 &&
    Math.abs(under.pace - MC.sneak * params.walkSpeed) < 1e-4 && out.at > 4 && Math.abs(out.eye - params.eyeHeight) < 1e-3 && Math.abs(out.pace - params.walkSpeed) < 1e-4,
    `Shift let go ${under.at.toFixed(2)} m in: the eye ${under.eye.toFixed(3)} m at ${under.pace.toFixed(2)} m/s; ` +
    `out at ${out.at.toFixed(2)} m: ${out.eye.toFixed(3)} m at ${out.pace.toFixed(2)} m/s`);
}

/* ---------------- the air ---------------- */
/* The drag equation integrated finely (RK4, 4,000 steps a second), as the
 * reference: dv/dt = -½ ρ(h) Cd A(v) |v| v / m - g up, A the body's box
 * facing the way it goes (walk.js). Returns the speed and distance at `at` seconds. */
function reference({ height, yaw = 0, v, at, p = params }) {
  const h0 = p.bodyHeight, w = p.bodyWidth, d = p.bodyDepth, sy = Math.sin(yaw), cy = Math.cos(yaw), out = {}, gas = {};
  const accel = (s, k) => {
    const [e, n, u, z] = s, speed = Math.hypot(e, n, u);
    if (!speed) { k[0] = k[1] = 0; k[2] = -p.gravity; k[3] = u; k[4] = 0; k[5] = 0; return; }
    const cdA = (DRAG.broadside * (h0 * w * Math.abs(e * sy + n * cy) + h0 * d * Math.abs(e * cy - n * sy)) + DRAG.end * w * d * Math.abs(u)) / speed;
    const rate = (0.5 * air(z, gas).density * cdA) / p.bodyMass;
    k[0] = -rate * speed * e; k[1] = -rate * speed * n; k[2] = -rate * speed * u - p.gravity; k[3] = u; k[4] = e; k[5] = n;
  };
  let s = [v[0], v[1], v[2], height, 0, 0];
  const dt = 1 / 4000, k1 = [], k2 = [], k3 = [], k4 = [], t = [];
  const add = (a, k, f) => a.map((x, i) => x + f * k[i]);
  const times = [...at].sort((a, b) => a - b);
  for (let i = 0, n = Math.round(times[times.length - 1] / dt); i <= n; i++) {
    for (const when of times) if (out[when] == null && i * dt >= when - dt / 2) out[when] = { speed: Math.hypot(s[0], s[1], s[2]), across: Math.hypot(s[0], s[1]), far: Math.hypot(s[4], s[5]), height: s[3] };
    accel(s, k1); accel(add(s, k1, dt / 2), k2); accel(add(s, k2, dt / 2), k3); accel(add(s, k3, dt), k4);
    s = s.map((x, j) => x + (dt / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t.length = 0;
  }
  return out;
}
/* The walker thrown with `v` (east, north, up) from `height` over nothing, against the reference at `at` seconds. */
function thrown({ height, yaw = 0, v, at, p = params }) {
  const deep = { sample(lon, lat, out) { out.height = -10000; out.gradE = out.gradN = 0; out.accurate = true; out.level = 20; return true; }, highest: () => -10000, settled: () => true };
  const s = walker({ height, yaw, ground: deep, velocity: { east: v[0], north: v[1], up: v[2] }, p });
  const got = {}, x0 = s.camera.lon, y0 = s.camera.lat, times = [...at].sort((a, b) => a - b);
  const mLon = 111320 * Math.cos(LAT * DEG), mLat = 111195;
  for (let i = 1, n = Math.round(times[times.length - 1] / DT); i <= n; i++) {
    step(s, 0);
    for (const when of times) if (got[when] == null && i * DT >= when - DT / 2) {
      got[when] = { speed: Math.hypot(s.walk.vEast, s.walk.vNorth, s.walk.vUp), across: s.walk.speed, far: Math.hypot((s.camera.lon - x0) * mLon, (s.camera.lat - y0) * mLat), height: s.camera.height };
    }
  }
  return { got, want: reference({ height, yaw, v, at, p }) };
}
const off = (a, b) => Math.abs(a / b - 1);
{
  // Thrown forward at 120 m/s (a flight's speed) at sea level and at 3,000 m;
  // sideways (facing east, moving north), the narrower side meets the air.
  const cases = [
    ['forward at sea level', { height: 100, v: [0, 120, 0] }],
    ['forward at 3,000 m', { height: 3000, v: [0, 120, 0] }],
    ['sideways at 3,000 m', { height: 3000, yaw: Math.PI / 2, v: [0, 120, 0] }],
    ['forward at 1,000 m/s, 3,000 m', { height: 3000, v: [0, 1000, 0] }],
  ];
  for (const [name, c] of cases) {
    const { got, want } = thrown({ ...c, at: [1, 3] });
    const worst = Math.max(off(got[1].across, want[1].across), off(got[3].across, want[3].across), off(got[3].far, want[3].far));
    report(`the drag on the body's shape, ${name}`, worst < 0.01,
      `${got[1].across.toFixed(1)} m/s across after 1 s and ${got[3].across.toFixed(1)} after 3 s, ${got[3].far.toFixed(0)} m on ` +
      `(the drag equation: ${want[1].across.toFixed(1)}, ${want[3].across.toFixed(1)}, ${want[3].far.toFixed(0)} m; ${(worst * 100).toFixed(2)}% off at most)`);
  }
  // Falling upright from 5,000 m: feet first, the top and the limbs meet the air.
  const { got, want } = thrown({ height: 5000, v: [0, 0, 0], at: [10, 30] });
  const worst = Math.max(off(got[10].speed, want[10].speed), off(got[30].speed, want[30].speed), off(5000 - got[30].height, 5000 - want[30].height));
  report('the drag on the body\'s shape, falling upright from 5,000 m', worst < 0.01,
    `${got[10].speed.toFixed(1)} m/s after 10 s and ${got[30].speed.toFixed(1)} after 30 s, ${(5000 - got[30].height).toFixed(0)} m down ` +
    `(the drag equation: ${want[10].speed.toFixed(1)}, ${want[30].speed.toFixed(1)}, ${(5000 - want[30].height).toFixed(0)} m; ${(worst * 100).toFixed(2)}% off at most)`);
}
{
  // Against people: a standing adult facing the wind has about 0.74 m² of
  // frontal area at a Cd about 1 (about 0.8 m² of drag area); falling feet
  // first, freefliers fall at about 260 km/h (72 m/s) at jump heights.
  const front = DRAG.broadside * params.bodyHeight * params.bodyWidth;
  const terminal = (h, p = params) => Math.sqrt((2 * p.bodyMass * p.gravity) / (air(h).density * DRAG.end * p.bodyWidth * p.bodyDepth));
  const falls = [];
  for (const [h, p] of [[0, params], [3000, params], [3000, { ...params, bodyMass: 150 }], [3000, { ...params, bodyWidth: 0.6 }]]) {
    const deep = { sample(lon, lat, out) { out.height = -10000; out.gradE = out.gradN = 0; out.accurate = true; out.level = 20; return true; }, highest: () => -10000, settled: () => true };
    const s = walker({ height: h + 2500, ground: deep, velocity: { east: 0, north: 0, up: 0 }, p });
    let at = null;
    for (let i = 0; i < 120 * 90 && at == null; i++) { step(s, 0); if (s.camera.height <= h + 1.6) at = -s.walk.vUp; }
    falls.push({ at, want: terminal(h, p) });
  }
  const [sea, high, heavy, wide] = falls;
  // Falling from thinner air above, a body passes a height a little faster than its terminal speed there.
  report('the drag against people\'s', front > 0.7 && front < 0.9 && high.at > 0.95 * 72 && high.at < 1.08 * 72 &&
    falls.every((f) => f.at >= f.want * 0.995 && f.at < f.want * 1.03),
    `facing the way: ${front.toFixed(2)} m² of drag area; falling upright ${sea.at.toFixed(1)} m/s at sea level and ${high.at.toFixed(1)} m/s ` +
    `(${(high.at * 3.6).toFixed(0)} km/h) at 3,000 m, 150 kg ${heavy.at.toFixed(1)} m/s, 0.6 m wide ${wide.at.toFixed(1)} m/s ` +
    `(terminal speeds ${falls.map((f) => f.want.toFixed(1)).join(', ')})`);
}
{
  // From flying at 120 m/s forward, 100 m up, switching to walking: the speed
  // is kept (not Minecraft's air, which would take it in two seconds), only
  // the drag slows it; then the ground stops it as in Minecraft.
  const camera = new Camera({ lon: LON, lat: LAT, height: GROUND + 100, yaw: 0, pitch: 0, speed: 120 });
  const fly = new FlyController();
  fly.enter();
  for (let i = 0; i < 12; i++) fly.step(DT, KEY.FORWARD, 0, camera, flat, params);
  const walk = new WalkController();
  walk.enter({ velocity: fly.velocity });
  const s = { camera, walk, ground: flat, solids: null, p: params, t: 0 };
  const lat0 = camera.lat, h0 = camera.height;
  let at3 = null, landedAt = null, landSpeed = 0, stoppedAt = null;
  run(s, 12, KEY.FORWARD, (z) => {
    if (at3 == null && z.t >= 3 - DT / 2) at3 = (camera.lat - lat0) * 111195;
    if (landedAt == null && walk.grounded) { landedAt = z.t; landSpeed = walk.vNorth; }
    if (landedAt != null && stoppedAt == null && walk.vNorth < 1.05 * params.walkSpeed) stoppedAt = z.t - landedAt;
  });
  const want = reference({ height: h0 - params.eyeHeight, v: [0, fly.velocity.north, 0], at: [3] })[3].far;
  report('flying to walking keeps the speed, slowed by the drag only', fly.velocity.north > 119 && off(at3, want) < 0.01 && landedAt > 2,
    `flying ${fly.velocity.north.toFixed(1)} m/s; ${at3?.toFixed(0)} m forward in the first 3 s (the drag equation: ${want.toFixed(0)} m), ` +
    `down after ${landedAt?.toFixed(1)} s at ${landSpeed.toFixed(1)} m/s`);
  report('... and the ground stops it as in Minecraft', stoppedAt != null && stoppedAt < 0.6, `back to walking pace ${stoppedAt?.toFixed(2)} s after landing`);
}
{
  // Switching to walking over ground not known yet (his words on 5.9b: "when
  // flying normally and going to walk mode, count air resistance!"): held
  // in the air 4 s while it loads, the walker still loses its speed to the
  // air, so it does not shoot off when the ground arrives (5.9b kept all of
  // 120 m/s and covered 101 m in the first second after).
  let t = 0;
  const loading = {
    sample(lon, lat, out) { out.height = GROUND; out.gradE = out.gradN = 0; out.level = 20; out.accurate = t >= 4; return true; },
    highest: () => GROUND + 2000,
    settled: () => true,
  };
  const camera = new Camera({ lon: LON, lat: LAT, height: GROUND + 300, yaw: 0, pitch: 0 });
  const walk = new WalkController();
  walk.enter({ velocity: { east: 0, north: 120, up: 0 } });
  let held = 0, lat4 = null;
  for (; t < 5; t += DT) {
    walk.step(DT, 0, 0, camera, loading, params);
    if (walk.waiting) held += DT;
    if (lat4 == null && t >= 4) lat4 = camera.lat;
  }
  const after = (camera.lat - lat4) * 111195;
  report('held in the air while the ground loads, the air still slows you', held > 3.9 && walk.vNorth < 50 && after < 60,
    `held ${held.toFixed(1)} s, then ${walk.vNorth.toFixed(1)} m/s and ${after.toFixed(0)} m in the first second (5.9b: 120 m/s, 101 m)`);
}
{
  // Vertical momentum into walking (Stage 5.13b, his words: "if I'm flying
  // and go into walk mode, also consider vertical momentum"; his answer:
  // "the climb before the taps"). Flying at 50 m/s: keys held for so many
  // seconds (a press at their start), then switched to walking with F (the
  // velocity as it is) or with a double tap of Space (fly.js, tapVelocity).
  const flight = () => {
    const camera = new Camera({ lon: LON, lat: LAT, height: GROUND + 400, yaw: 0, pitch: 0, speed: 50 });
    const fly = new FlyController();
    fly.enter();
    let last = 0;
    const hold = (keys, seconds) => {
      const n = Math.max(1, Math.round(seconds / DT));
      for (let i = 0; i < n; i++) {
        fly.step(DT, keys, i === 0 ? keys & ~last : 0, camera, flat, params);
      }
      last = keys;
    };
    return { camera, fly, hold };
  };
  // The double tap: Space twice, 0.15 s apart (pressed 0.05 s each), anything else still held.
  const taps = (hold, others = 0) => { hold(others | KEY.UP, 0.05); hold(others, 0.1); hold(others | KEY.UP, DT); };
  // Walking from there with `velocity`: how far up it goes, and how fast it falls after 1 s.
  const ride = (camera, velocity) => {
    const walk = new WalkController();
    walk.enter({ velocity: { ...velocity } });
    const h0 = camera.height;
    let peak = h0, v1 = null;
    for (let t = 0; t < 4; t += DT) {
      walk.step(DT, 0, 0, camera, flat, params);
      peak = Math.max(peak, camera.height);
      if (v1 == null && t >= 1) v1 = walk.vUp;
    }
    return { up0: velocity.up, rise: peak - h0, v1 };
  };
  let f = flight();
  f.hold(KEY.UP, 1);
  const byF = ride(f.camera, f.fly.velocity);
  f = flight();
  f.hold(0, 1);
  taps(f.hold);
  const hover = ride(f.camera, f.fly.tapVelocity());
  f = flight();
  f.hold(KEY.UP, 1);
  f.hold(0, 0.1);
  taps(f.hold);
  const climbing = ride(f.camera, f.fly.tapVelocity());
  f = flight();
  f.hold(KEY.DOWN, 1);
  taps(f.hold, KEY.DOWN);
  const descending = ride(f.camera, f.fly.tapVelocity());
  report('flying up, F to walking: the climb carries on', Math.abs(byF.up0 - 50) < 0.5 && byF.rise > 90 && byF.rise < 128,
    `up at ${byF.up0.toFixed(1)} m/s, a second later ${byF.v1.toFixed(1)} m/s, it rises ${byF.rise.toFixed(1)} m more (128 m without the air)`);
  report('... a double tap from a hover: the taps\' own climb not kept', hover.up0 === 0 && hover.rise < 0.01,
    `up at ${hover.up0.toFixed(1)} m/s, rising ${hover.rise.toFixed(2)} m (the second tap climbs at 50 m/s)`);
  report('... a double tap just after climbing: the climb kept', Math.abs(climbing.up0 - 50) < 0.5 && climbing.rise > 90,
    `up at ${climbing.up0.toFixed(1)} m/s, it rises ${climbing.rise.toFixed(1)} m more`);
  report('... a double tap while coming down: the descent kept', Math.abs(descending.up0 + 50) < 0.5 && descending.rise < 0.01,
    `down at ${(-descending.up0).toFixed(1)} m/s, ${(-descending.v1).toFixed(1)} m/s a second later`);
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exitCode = failures ? 1 : 0;
