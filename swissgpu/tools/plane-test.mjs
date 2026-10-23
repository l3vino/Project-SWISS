/* plane-test.mjs — the airplane mode (Stage 5.9b, retuned in 5.10b and
 * 5.11b), in Node: the jet's performance against the numbers it is built to
 * (aircraft/jet.js), and the controller on flat ground: take-off, level
 * flight, rolling (gentle taps, the roll building up while held) and the
 * wings levelling, the pitch response with each wing and the view along the
 * flight path or the nose, the speed changes with each Engine and brakes
 * choice, the engine off (the brake down to the least flying speed, the
 * stall, the nose dropping, flying again; held back, stalled; the nose
 * lowered in time, a glide), a loop, a landing and a crash, the view it
 * gives the camera, and the display's pitch lines through a loop, a barrel
 * roll, a roll then a pull and a split-S (5.12b). Run: node tools/plane-test.mjs
 */

import { Jet, JET, stallSpeed } from '../js/engine/aircraft/jet.js';
import { air } from '../js/engine/aircraft/atmosphere.js';
import { PlaneController, PLANE } from '../js/engine/controllers/plane.js';
import { Camera, KEY, FOV_Y } from '../js/engine/camera.js';
import { DEG } from '../js/core/math.js';
import { ladderLines } from '../js/ui/cockpit.js';

const GROUND = 400;
const ground = {
  sample(lon, lat, out) { out.height = GROUND; out.gradE = out.gradN = 0; out.level = 20; out.accurate = true; return true; },
  highest: () => GROUND,
  settled: () => true,
};
// As render.js has them by default (Settings → Vehicles → Airplane, the Easy preset).
const ENGINES = { built: { power: 1, brakes: 1, autoBrake: false }, quick: { power: 1.5, brakes: 4, autoBrake: true } };
const WINGS = { built: { wing: 1, gMax: 9 }, strong: { wing: 1.5, gMax: 12 } };
const params = { eyeHeight: 1.64, bodyHeight: 1.75, flyThrough: false, maxSlope: 45 * DEG, planeLevel: true, planeRollBuild: 0.8,
  planeView: 'path', plane: { rollRate: 90 * DEG, pitchRate: 35 * DEG, ...ENGINES.quick, ...WINGS.strong } };
// The Realistic preset's: the F-16 as built, seen along its nose.
const realistic = { ...params, planeLevel: false, planeRollBuild: 0.2, planeView: 'nose', plane: { ...params.plane, rollRate: 180 * DEG, ...ENGINES.built, ...WINGS.built } };
const DT = 1 / 120;
let failures = 0;
const report = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
};
const kmh = (v) => Math.round(v * 3.6);

/* ---- the jet alone: performance ---- */
{
  const way = {};
  const level = (h, seconds, target) => {
    const j = new Jet();
    j.reset({ speed: 600 / 3.6, heading: 0, pitch: 0, height: h });
    j.target = target;
    let height = h;
    for (let t = 0; t < seconds; t += DT) { j.step(DT, { pitch: 0, roll: 0, brake: false }, height, way); height += way.up; }
    return { j, height };
  };
  const sl = level(300, 240, 2 * air(300).sound);
  report('top speed at sea level, afterburner', kmh(sl.j.speed) > 1450 && kmh(sl.j.speed) < 1700 && Math.abs(sl.height - 300) < 30,
    `${kmh(sl.j.speed)} km/h (Mach ${sl.j.mach.toFixed(2)}), held at ${sl.height.toFixed(0)} m`);
  const high = level(11000, 400, 2 * air(11000).sound);
  report('Mach 2 at 11 km', high.j.mach > 1.9 && high.j.mach <= 2.001, `Mach ${high.j.mach.toFixed(2)} (${kmh(high.j.speed)} km/h) after 400 s`);
  // The stall speed, level at sea level with the engine off (Stage 5.11b): as
  // built about 245 km/h, the stronger wing about 200 km/h.
  const stallsAt = (wing) => {
    const j = new Jet();
    j.tune(WINGS[wing]);
    j.reset({ speed: 330 / 3.6, heading: 0, pitch: 0, height: 0, target: 330 / 3.6 });
    j.target = 0;
    let height = 0;
    for (let t = 0; t < 120; t += DT) {
      j.step(DT, { pitch: 0, roll: 0, brake: false }, height, way);
      height += way.up;
      if (j.stalled) return j.speed;
    }
    return NaN;
  };
  const built = stallsAt('built'), strong = stallsAt('strong');
  report('it stalls at about 245 km/h as built, 200 with the stronger wing (level, sea level, the engine off)',
    Math.abs(kmh(built) - 245) <= 12 && Math.abs(kmh(strong) - 200) <= 12,
    `as built ${kmh(built)} km/h (${kmh(stallSpeed(air(0).density, built / air(0).sound, 1))} at the wing's peak), stronger ${kmh(strong)} km/h`);
}

/* ---- the controller ---- */
const setup = ({ height = GROUND + PLANE.eye, speed = 0, grounded = true, pitch = 0 } = {}) => {
  const camera = new Camera({ lon: 7.5, lat: 46.5, height, yaw: 0, pitch, speed });
  const plane = new PlaneController();
  plane.enter({ camera, grounded, speed, aboveGround: height - GROUND });
  // Slower than getting in allows (PLANE.least): a landing's approach.
  if (!grounded && speed < PLANE.least) plane.jet.reset({ speed, heading: 0, pitch, height, target: speed });
  return { camera, plane };
};
const run = (s, seconds, keys, each, tuned = params) => {
  for (let i = 0, n = Math.round(seconds / DT); i < n; i++) {
    const k = typeof keys === 'function' ? keys(i * DT, s) : keys;
    s.plane.step(DT, k, 0, s.camera, ground, tuned, null);
    if (s.plane.crashed) return;
    each?.(i * DT, s);
  }
};
{
  // Take-off: parked, the speed asked 350 km/h, pulled at 270 km/h, and in
  // the air pulled on into a 10° climb, then let go (it holds the climb).
  const s = setup();
  s.plane.adjustSpeed(14, s.camera.height);
  let liftoff = null, roll = 0;
  const start = s.camera.lat;
  const pilot = (t, z) => {
    const j = z.plane.jet;
    if (j.onGround) return j.speed * 3.6 > 270 ? KEY.BACK : 0;
    return j.pathAngle < 10 * DEG ? KEY.BACK : 0;
  };
  run(s, 40, pilot, (t, z) => {
    if (liftoff == null && !z.plane.jet.onGround) { liftoff = t; roll = (z.camera.lat - start) * 111195; }
  });
  report('take-off: parked, rolls, lifts off when pulled', liftoff != null && liftoff < 25 && s.camera.height > GROUND + 50,
    `asked ${kmh(s.plane.jet.target)} km/h; lifted after ${liftoff?.toFixed(1)} s and ${roll.toFixed(0)} m, now ${(s.camera.height - GROUND).toFixed(0)} m up`);
}
{
  // Level flight, then a roll to the right held 1 s and let go: the wings come back level; the view banks with them.
  const s = setup({ height: 3000, speed: 800 / 3.6, grounded: false });
  run(s, 5, 0);
  const h0 = s.camera.height;
  // Along the flight path (Easy): level; along the nose (Realistic): up by the wing's angle.
  const n = setup({ height: 3000, speed: 800 / 3.6, grounded: false });
  run(n, 5, 0, null, realistic);
  report('... level flight: the view level along the path (Easy), up by the wing\'s angle along the nose (Realistic)',
    Math.abs(s.camera.pitch - s.plane.jet.pathAngle) < 0.1 * DEG && Math.abs(n.camera.pitch - n.plane.jet.pathAngle - n.plane.jet.alpha) < 0.5 * DEG &&
    n.plane.jet.alpha > 1 * DEG,
    `path view ${(s.camera.pitch / DEG).toFixed(2)}° (path ${(s.plane.jet.pathAngle / DEG).toFixed(2)}°); nose view ${(n.camera.pitch / DEG).toFixed(1)}°, alpha ${(n.plane.jet.alpha / DEG).toFixed(1)}°`);
  let most = 0, viewRoll = 0;
  run(s, 1, KEY.RIGHT, (t, z) => { most = Math.max(most, z.plane.jet.bank); viewRoll = z.camera.roll; });
  run(s, 4, 0);
  report('roll right 1 s, let go: the wings level themselves', most > 40 * DEG && most < 80 * DEG && Math.abs(s.plane.jet.bank) < 1 * DEG && Math.abs(s.camera.height - h0) < 60,
    `banked ${(most / DEG).toFixed(0)}° (the view ${(viewRoll / DEG).toFixed(0)}°), ${(s.plane.jet.bank / DEG).toFixed(1)}° 4 s after, height ${(s.camera.height - h0).toFixed(0)} m off`);
}
{
  // His words on 5.9b: "airplane is WAYYY to sensitive in turning". A key is
  // all or nothing: a tap must be a small correction, the roll building up
  // while the key is held.
  const banks = [0.1, 0.3, 0.5].map((hold) => {
    const s = setup({ height: 3000, speed: 700 / 3.6, grounded: false });
    run(s, 2, 0);
    let most = 0;
    run(s, hold + 1.5, (t) => (t < hold ? KEY.LEFT : 0), (t, z) => { most = Math.max(most, Math.abs(z.plane.jet.bank)); });
    return most / DEG;
  });
  report('taps of A are small corrections', banks[0] < 3 && banks[1] < 10 && banks[2] < 20,
    `0.1 s → ${banks[0].toFixed(1)}°, 0.3 s → ${banks[1].toFixed(1)}°, 0.5 s → ${banks[2].toFixed(1)}° (5.9b: 14°, 44°, 79°)`);
}
{
  // "a bit too slow when pitching up and down": from level at 600 km/h (the
  // least getting in while flying), a pull to a 10° and a 20° climb.
  const s = setup({ height: 1500, speed: 600 / 3.6, grounded: false });
  run(s, 2, 0);
  let t10 = null, t20 = null;
  run(s, 3, KEY.BACK, (t, z) => {
    const g = z.plane.jet.pathAngle / DEG;
    if (t10 == null && g >= 10) t10 = t;
    if (t20 == null && g >= 20) t20 = t;
  });
  report('pulling from 600 km/h: a 10° climb within 0.8 s', t10 != null && t10 < 0.8 && t20 != null && t20 < 1.5,
    `10° after ${t10?.toFixed(2)} s, 20° after ${t20?.toFixed(2)} s (5.9b, getting in at 425 km/h: 1.48 and 2.81 s)`);
}
{
  // His words on 5.10b: "the airplane pitch is wayyy to stange, it looks up
  // quick, but the actual plane pitch is slower. make pitch faster". From
  // 600 km/h at 1,500 m, 1.5 s of full stick: how fast the path turns up,
  // and how fast the view does, Easy (the view along the path, the stronger
  // wing) against as built along the nose (5.10b's only way).
  const pull = (tuned) => {
    const s = setup({ height: 1500, speed: 600 / 3.6, grounded: false });
    run(s, 2, 0, null, tuned);
    let path = 0, view = 0, lead = 0, last = null, stalled = false;
    run(s, 1.5, KEY.BACK, (t, z) => {
      const g = z.plane.jet.pathAngle, p = z.camera.pitch;
      if (last && t > 0.2) { path = Math.max(path, (g - last.g) / DT); view = Math.max(view, (p - last.p) / DT); }
      lead = Math.max(lead, p - g);
      stalled ||= z.plane.jet.stalled;
      last = { g, p };
    }, tuned);
    return { path: path / DEG, view: view / DEG, lead: lead / DEG, stalled, load: s.plane.jet.load };
  };
  const easy = pull(params), built = pull(realistic);
  report('pulling: the path turns up faster, and the view along it turns with it (Easy)',
    easy.path > 1.4 * built.path && Math.abs(easy.view - easy.path) < 1 && easy.lead < 0.5 && built.lead > 5 && !easy.stalled && !built.stalled,
    `Easy: the path up to ${easy.path.toFixed(1)}°/s, the view ${easy.view.toFixed(1)}°/s, the view ${easy.lead.toFixed(1)}° ahead of the path at most, ${easy.load.toFixed(1)} g; ` +
    `as built along the nose: the path ${built.path.toFixed(1)}°/s, the nose ${built.view.toFixed(1)}°/s, up to ${built.lead.toFixed(1)}° ahead of the path, ${built.load.toFixed(1)} g`);
}
{
  // The engine off (Stage 5.11b, his words: "when you turn the airplane motor
  // off, it takes wayyy wayyy wayyyyyyy too long to slow down, it doesn't
  // even fall when speed is too low"; his answer: "realistic, so if user
  // doesn't manouvre to glide, it stalls, if user does things correctly, it
  // glides"). Level at 2,000 m from 900 km/h, nothing asked, the stick let
  // go: the quick engine's brake slows it to the least flying speed and
  // closes; slower still it stalls, the nose drops, it falls until it flies
  // again, and holds the dive it is in.
  const s = setup({ height: 2000, speed: 900 / 3.6, grounded: false });
  s.plane.jet.target = 0;
  const least = () => JET.least * s.plane.jet.stallSpeed(s.camera.height);
  let leastAt = 0, atLeast = null, closed = null, stalledAt = null, stalledHigh = 0, stallSpeed0 = 0, deepest = 0, flies = null, flyPath = 0, flyHigh = 0, thrust = 0;
  // Until 5 s after it flies again (then on in that dive, it would reach the ground).
  for (let t = 0; t < 120 && !(flies != null && t > flies + 5) && !s.plane.crashed; t += DT) {
    run(s, DT, 0);
    const j = s.plane.jet;
    if (t > 10) thrust = Math.max(thrust, j.thrust);
    if (atLeast == null && j.speed <= least()) { atLeast = t; leastAt = j.speed; }
    if (atLeast != null && closed == null && !j.braking) closed = t;
    if (stalledAt == null && j.stalled) { stalledAt = t; stallSpeed0 = j.speed; stalledHigh = s.camera.height; }
    if (stalledAt != null && flies == null) deepest = Math.min(deepest, j.pathAngle);
    if (stalledAt != null && flies == null && !j.stalled) { flies = t; flyPath = j.pathAngle; flyHigh = s.camera.height; }
  }
  const j = s.plane.jet;
  report('the engine off: no thrust, braked to the least flying speed, then the brake closes', thrust < 1 && atLeast != null && atLeast < 30 && closed != null && closed - atLeast < 0.5,
    `thrust ${thrust.toFixed(2)} N after 10 s; 900 → ${kmh(leastAt)} km/h (the least flying speed, ${JET.least} times the stall speed) in ${atLeast?.toFixed(1)} s, the brake closed then`);
  report('... left level, too slow it stalls: the nose drops, it falls, flies again and holds the dive', stalledAt != null && deepest < -10 * DEG &&
    flies != null && flies - stalledAt < 10 && !j.stalled && Math.abs(j.pathAngle - flyPath) < 2 * DEG && !s.plane.crashed,
    `stalled ${stalledAt?.toFixed(1)} s after the engine went off, at ${kmh(stallSpeed0)} km/h; flying again ${(flies - stalledAt).toFixed(1)} s later at ` +
    `${(flyPath / DEG).toFixed(0)}° down, ${(stalledHigh - flyHigh).toFixed(0)} m lower; 5 s on ${(j.pathAngle / DEG).toFixed(0)}° at ${kmh(j.speed)} km/h`);
}
{
  // Stalled with the stick held back: it stays stalled, deep, falling with
  // the nose high; let go, it flies again.
  const s = setup({ height: 3000, speed: 300 / 3.6, grounded: false });
  s.plane.jet.target = 0;
  for (let t = 0; t < 60 && !s.plane.jet.stalled; t += DT) run(s, DT, 0);
  const first = s.plane.jet.stalled;
  let held = 0, steps = 0, sink = 0, nose = Infinity;
  run(s, 10, KEY.BACK, (t, z) => {
    steps++;
    if (z.plane.jet.stalled) held++;
    if (t > 5) { sink = Math.max(sink, -z.plane.jet.v[2]); nose = Math.min(nose, Math.asin(z.plane.jet.forward[2]) - z.plane.jet.pathAngle); }
  });
  let again = null;
  run(s, 20, 0, (t, z) => { if (again == null && !z.plane.jet.stalled) again = t; });
  report('held back, it stays stalled, falling nose-high; let go, it flies again', first && held === steps && sink > 30 && nose > 30 * DEG && again != null,
    `stalled ${held} of ${steps} steps, sinking ${sink.toFixed(0)} m/s, the nose ${(nose / DEG).toFixed(0)}° above the way it falls; let go, flying again after ${again?.toFixed(1)} s`);
}
{
  // The nose lowered in time, it glides: at 5,000 m, the engine off at
  // 600 km/h; once braked to the least flying speed, a push to 15° down
  // until 500 km/h, then up to 6° down (about the best glide) and let go: it
  // holds that path, and settles into a glide.
  const s = setup({ height: 5000, speed: 600 / 3.6, grounded: false });
  s.plane.jet.target = 0;
  let step = 0, stalled = false, at = null;
  const marks = [];
  run(s, 120, (t, z) => {
    const j = z.plane.jet;
    if (step === 0 && !j.braking && !j.brakeArmed) { at = j.speed; step = 1; }
    if (step === 1) { if (j.pathAngle > -15 * DEG) return KEY.FORWARD; step = 2; }
    if (step === 2) { if (j.speed * 3.6 < 500) return 0; step = 3; }
    // Let go a degree early: the stick takes a tenth of a second back to the middle.
    if (step === 3) { if (j.pathAngle < -7 * DEG) return KEY.BACK; step = 4; }
    return 0;
  }, (t, z) => {
    const j = z.plane.jet;
    stalled ||= j.stalled;
    if ([60, 90, 120].some((m) => Math.abs(t + DT - m) < DT / 2)) marks.push(`${(t + DT).toFixed(0)} s ${kmh(j.speed)} km/h, sinking ${(-j.v[2]).toFixed(1)} m/s`);
  });
  const j = s.plane.jet, sink = -j.v[2];
  report('the nose lowered in time, it glides: never stalls, and settles', step === 4 && !stalled && !s.plane.crashed && Math.abs(j.pathAngle + 6 * DEG) < 1.5 * DEG &&
    sink > 10 && sink < 25,
    `braked to ${kmh(at)} km/h, then 15° down to 500 km/h and up to ${(j.pathAngle / DEG).toFixed(1)}°: ${marks.join('; ')}`);
}
{
  // Speed changes (his answer: "realistic but quicker"): level at 1,500 m,
  // the speed asked 450 → 850 → 450 km/h, within 10 km/h of it.
  const times = {};
  for (const [name, engine] of Object.entries(ENGINES)) {
    const s = setup({ height: 1500, speed: 450 / 3.6, grounded: false });
    const tuned = { ...params, plane: { ...params.plane, ...engine } };
    const to = (kmh) => {
      s.plane.jet.target = kmh / 3.6;
      for (let t = 0; t < 200; t += DT) {
        s.plane.step(DT, 0, 0, s.camera, ground, tuned, null);
        if (Math.abs(s.plane.jet.speed * 3.6 - kmh) < 10) return t;
      }
      return Infinity;
    };
    times[name] = [to(850), to(450)];
  }
  report('speed changes quick: up and down within 20 s', times.quick[0] < 12 && times.quick[1] < 20,
    `quick: 450 → 850 km/h in ${times.quick[0].toFixed(1)} s, back in ${times.quick[1].toFixed(1)} s; as built ${times.built[0].toFixed(1)} s and ${times.built[1].toFixed(0)} s (5.9b: 18.3 s, and over 2 minutes)`);
}
{
  // A loop: full stick back from 900 km/h with the afterburner; comes round, upright again.
  const s = setup({ height: 3000, speed: 900 / 3.6, grounded: false });
  s.plane.jet.target = 2 * air(3000).sound;
  let inverted = false, round = false;
  run(s, 40, (t, z) => (round ? 0 : KEY.BACK), (t, z) => {
    if (z.plane.jet.up[2] < -0.5) inverted = true;
    if (inverted && !round && z.plane.jet.pathAngle > 0 && z.plane.jet.up[2] > 0.9) round = true;
  });
  report('a loop comes round', inverted && round && !s.plane.crashed, `over the top ${inverted}, round ${round}, ${kmh(s.plane.jet.speed)} km/h`);
}
{
  // A landing: from 60 m up at 280 km/h, sinking gently.
  const s = setup({ height: GROUND + 60, speed: 280 / 3.6, grounded: false, pitch: -3 * DEG });
  s.plane.jet.target = 270 / 3.6;
  let touched = null;
  run(s, 60, (t, z) => (z.plane.jet.onGround ? KEY.DOWN : (z.camera.height - GROUND < 12 && z.plane.jet.v[2] < -2.5 ? KEY.BACK : 0)), (t, z) => {
    if (touched == null && z.plane.jet.onGround) touched = { t, v: z.plane.jet.speed };
  });
  report('a gentle landing rolls out and stops', touched != null && !s.plane.crashed && s.plane.jet.speed < 1,
    touched ? `down after ${touched.t.toFixed(1)} s at ${kmh(touched.v)} km/h, stopped, ${s.plane.crashed ? 'crashed' : 'on its wheels'}` : 'never touched');
}
{
  // A dive into the ground at 600 km/h: a crash.
  const s = setup({ height: GROUND + 300, speed: 600 / 3.6, grounded: false, pitch: -30 * DEG });
  run(s, 20, 0);
  report('diving into the ground is a crash', Boolean(s.plane.crashed), s.plane.crashed ? `crashed at ${kmh(s.plane.crashed.speed)} km/h` : 'did not crash');
}
{
  // The head: the mouse turns it, it comes back onto the nose.
  const s = setup({ height: 3000, speed: 700 / 3.6, grounded: false });
  run(s, 1, 0);
  const yaw0 = s.camera.yaw;
  s.plane.look(60 * DEG, 0);
  run(s, DT, 0);
  const turned = s.camera.yaw - yaw0;
  run(s, 4, 0);
  report('looking round the cockpit, then back to the nose', Math.abs(turned - 60 * DEG) < 2 * DEG && Math.abs(s.camera.yaw - yaw0) < 1 * DEG,
    `turned ${(turned / DEG).toFixed(1)}°, ${((s.camera.yaw - yaw0) / DEG).toFixed(2)}° off the nose 4 s later`);
}

{
  // The display's pitch lines through rolls and loops (Stage 5.12b, his
  // words: "plane ui messes up when airplane does barrel rolls or rols and
  // then pulls up/down"), at 60 frames a second on a 1600 × 900 screen: from
  // one frame to the next, no line moves across itself more than the view's
  // own turn moves a point there (θ (f² + r²) / f for a turn θ, r from the
  // middle, f the focal length). 5.11b drew them round the nose's heading.
  const W = 1600, H = 900, f = H / (2 * Math.tan(FOV_Y / 2)), FRAME = 1 / 60;
  const axes = (v) => {
    const cp = Math.cos(v.pitch), F = [Math.sin(v.yaw) * cp, Math.cos(v.yaw) * cp, Math.sin(v.pitch)];
    const n = Math.hypot(F[0], F[1]) || 1, r0 = F[1] / n, r1 = -F[0] / n;
    const u0 = r1 * F[2], u1 = -r0 * F[2], u2 = r0 * F[1] - r1 * F[0], c = Math.cos(v.roll), s = Math.sin(v.roll);
    return { F, U: [u0 * c + r0 * s, u1 * c + r1 * s, u2 * c], R: [r0 * c - u0 * s, r1 * c - u1 * s, -u2 * s] };
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const buffer = [];
  const lines = (v, memory, fixed) => buffer.slice(0, ladderLines(v, W, H, buffer, memory, fixed)).map((l) => ({ ...l }));
  /* A line's move across itself between frames a and b, against what the view's turn there allows
   * (the same line: the same pitch, on the same side of straight up or down, or for 5.11b's one-sided ladder any). */
  const worstMove = (a, b, theta, worst, sided = true) => {
    for (const l of b) for (const m of a) {
      if (m.e !== l.e || (sided && Math.abs(Math.atan2(Math.sin(l.az - m.az), Math.cos(l.az - m.az))) > Math.PI / 2)) continue;
      const across = Math.abs((l.x - m.x) * -m.uy + (l.y - m.y) * m.ux);
      const r = Math.max(Math.hypot(l.x - W / 2, l.y - H / 2), Math.hypot(m.x - W / 2, m.y - H / 2));
      const allowed = (theta * (f * f + r * r)) / f + 2;
      if (across - allowed > worst.over) Object.assign(worst, { over: across - allowed, across, allowed });
      if (across > worst.most) worst.most = across;
    }
  };
  const manoeuvre = (name, keys, seconds) => {
    const s = setup({ height: 3000, speed: 700 / 3.6, grounded: false });
    s.plane.jet.target = 700 / 3.6;
    let prev = null, steepest = 0;
    const memory = { turn: null };
    const worst = { over: -Infinity, across: 0, allowed: 0, most: 0 }, old = { over: -Infinity, across: 0, allowed: 0, most: 0 };
    for (let t = 0; t < seconds && !s.plane.crashed; t += FRAME) {
      run(s, FRAME, keys(t));
      const v = s.plane.report(s.camera, {});
      steepest = Math.max(steepest, Math.abs(v.pitch));
      const now = { axes: axes(v), lines: lines(v, memory), old: lines(v, null, v.heading) };
      if (prev) {
        const a = prev.axes, b = now.axes;
        const theta = Math.acos(Math.max(-1, Math.min(1, (dot(a.F, b.F) + dot(a.U, b.U) + dot(a.R, b.R) - 1) / 2)));
        worstMove(prev.lines, now.lines, theta, worst);
        worstMove(prev.old, now.old, theta, old, false);
      }
      prev = now;
    }
    return { name, worst, old, steepest, crashed: Boolean(s.plane.crashed) };
  };
  const flown = [
    manoeuvre('a loop', () => KEY.BACK, 14),
    manoeuvre('a loop a little banked', (t) => (t < 0.12 ? KEY.RIGHT : KEY.BACK), 14),
    manoeuvre('a loop banked more', (t) => (t < 0.3 ? KEY.RIGHT : KEY.BACK), 14),
    manoeuvre('a loop banked still more', (t) => (t < 0.45 ? KEY.RIGHT : KEY.BACK), 14),
    manoeuvre('a barrel roll', () => KEY.BACK | KEY.RIGHT, 8),
    manoeuvre('a roll to 90° then a pull', (t) => (t < 1.2 ? KEY.RIGHT : KEY.BACK), 7.2),
    manoeuvre('a split-S', (t) => (t < 2.2 ? KEY.RIGHT : KEY.BACK), 10),
    manoeuvre('a roll going straight up', (t) => (t < 3.6 ? KEY.BACK : t < 6 ? KEY.RIGHT : 0), 6),
  ];
  for (const m of flown) {
    report(`the display through ${m.name}: the pitch lines turn with the view`, !m.crashed && m.worst.over <= 0,
      `${m.worst.most.toFixed(0)} px a frame at most across themselves (the view's own turn allowing ${m.worst.allowed.toFixed(0)} px where it came closest), ` +
      `pitched ${(m.steepest / DEG).toFixed(0)}° at most; round the nose's heading (5.11b) ${m.old.most.toFixed(0)} px`);
  }
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exitCode = failures ? 1 : 0;
