/* walk.mjs — a scripted walk, for tools/verify.mjs --scenario walk.
 *
 * Exercises everything walking depends on, through the real input path where
 * that is safe: pointer lock, a double-tapped Space, W held down. Ctrl+W goes
 * through the console handle instead, because a browser may treat a
 * synthesised Ctrl+W as "close this tab" and end the run.
 *
 * Every check compares against the drawn surface, via the probe's height
 * above ground, never against the synthetic height field: the walker stands on
 * the rendered triangles, which is the whole point.
 *
 * Speeds and durations are measured against the simulation's own clock. A
 * software GPU renders a few frames a second, each physics step is capped at
 * a tenth of a second, and wall-clock time would make every check wrong.
 */

const KEY = { FORWARD: 1, UP: 16, SPRINT: 64 };
const EYE = 1.75 * 0.936;
const M_PER_DEG_LAT = 111_132;

export async function run(page) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  // Ceilings are generous on purpose: a software GPU can take a second a
  // frame, and each wait returns the moment its condition holds anyway.
  const until = async (test, ms = 60000, every = 100) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  /** Wait until the simulation itself has advanced by `seconds`. */
  const simWait = async (seconds) => {
    const t0 = (await probe()).simTime;
    let q;
    do { await wait(40); q = await probe(); } while (q.simTime - t0 < seconds);
    return q;
  };
  /** Speed between two snapshots, in metres per simulated second. */
  const speedBetween = (a, b) => metresBetween(a.camera, b.camera) / (b.simTime - a.simTime);
  const metresBetween = (a, b) => Math.hypot(
    (b.lat - a.lat) * M_PER_DEG_LAT,
    (b.lon - a.lon) * M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180));

  await until((p) => p.terrain.ready > 0 && p.terrain.pending === 0, 30000, 500);

  /* 1. Flight cannot pass through the ground. */
  const start = { lon: 8.8, lat: 46.17 };
  await send('camera', { state: { ...start, height: -300, yaw: 0, pitch: -0.2, mode: 'fly' } });
  let p = await until((q) => q.motion.aboveGround != null);
  check('flight stops at the ground', Math.abs(p.motion.aboveGround - EYE) < 0.05,
    `eye ${p.motion.aboveGround?.toFixed(3)} m above the surface, expected ${EYE.toFixed(3)}`);

  /* 2. Real input: take the pointer, then double-tap Space. */
  await page.mouse.click(400, 400);
  await wait(300);
  const locked = await page.evaluate(() => document.pointerLockElement !== null);
  check('pointer lock', locked, locked ? 'acquired' : 'not available; falling back to the console handle');
  const tapSpace = async () => {
    if (locked) await page.keyboard.press('Space');
    else { await send('keys', { mask: KEY.UP }); await wait(40); await send('keys', { mask: 0 }); }
  };
  await tapSpace(); await wait(90); await tapSpace();
  if (!locked) await send('mode', {});
  p = await until((q) => q.motion.mode === 'walk', 20000);
  check('double-tap Space switches to walking', p.motion.mode === 'walk', `mode ${p.motion.mode}`);

  p = await until((q) => q.motion.state === 'standing');
  check('stands on the drawn surface', p.motion.state === 'standing' && Math.abs(p.motion.aboveGround - EYE) < 0.02,
    `${p.motion.state}, eye ${p.motion.aboveGround?.toFixed(3)} m above it`);

  /* 3. Walk north with W: measure speed over a second of steady walking. */
  if (locked) await page.keyboard.down('KeyW'); else await send('keys', { mask: KEY.FORWARD });
  const walkA = await simWait(0.6);            // past the first tenth of a second of acceleration
  const walkB = await simWait(1.2);
  if (locked) await page.keyboard.up('KeyW'); else await send('keys', { mask: 0 });
  const walked = speedBetween(walkA, walkB);
  check('walks at 1.4 m/s', walkB.motion.state === 'walking' && Math.abs(walked - 1.4) < 0.03,
    `${walkB.motion.state}, ${walked.toFixed(3)} m/s over ${(walkB.simTime - walkA.simTime).toFixed(2)} s`);
  check('stays on the ground while walking', Math.abs(walkB.motion.aboveGround - EYE) < 0.02,
    `eye ${walkB.motion.aboveGround.toFixed(3)} m above it`);
  p = await until((q) => q.motion.state === 'standing');
  check('stops when W is released', p.motion.state === 'standing', p.motion.state);

  /* 4. Run with Ctrl held. */
  await send('keys', { mask: KEY.FORWARD | KEY.SPRINT });
  const runA = await simWait(0.6);
  const runB = await simWait(1.2);
  await send('keys', { mask: 0 });
  const ran = speedBetween(runA, runB);
  check('runs at 4.5 m/s with Ctrl', runB.motion.state === 'running' && Math.abs(ran - 4.5) < 0.08,
    `${runB.motion.state}, ${ran.toFixed(3)} m/s over ${(runB.simTime - runA.simTime).toFixed(2)} s`);
  await until((q) => q.motion.state === 'standing');

  /* 5. Jump with a quick tap, shorter than a frame here. */
  await wait(400);   // well clear of the double-tap window
  const jumpsBefore = (await probe()).lastJump;
  if (locked) await page.keyboard.press('Space');
  else { await send('keys', { mask: KEY.UP }); await send('keys', { mask: 0 }); }
  p = await until((q) => q.lastJump !== jumpsBefore && q.motion.state === 'standing', 60000, 40);
  check('a quick tap jumps 45 cm and lands', p.lastJump != null && Math.abs(p.lastJump - 0.45) < 0.01 && p.motion.state === 'standing',
    `rose ${p.lastJump == null ? 'nothing' : (p.lastJump * 100).toFixed(1) + ' cm'}, then ${p.motion.state}`);

  /* 5b. Space held down keeps jumping, with a moment on the ground between
   * landings, and stops once it is let go. A jump is 0.61 s in the air and
   * 0.12 s on the ground, so 2.5 s held is four take-offs, give or take a
   * frame at either end. */
  const bounceFrom = await probe();
  await send('keys', { mask: KEY.UP });
  const bounced = await simWait(2.5);
  await send('keys', { mask: 0 });
  p = await until((q) => q.motion.state === 'standing', 60000, 40);
  const jumped = bounced.jumps - bounceFrom.jumps;
  const settled = await simWait(1.0);
  check('holding Space keeps jumping, and stops when released',
    jumped >= 3 && jumped <= 5 && settled.jumps === p.jumps && Math.abs(p.lastJump - 0.45) < 0.01,
    `${jumped} jumps in ${(bounced.simTime - bounceFrom.simTime).toFixed(2)} s held, ` +
    `${settled.jumps - p.jumps} after release, last rose ${(p.lastJump * 100).toFixed(1)} cm`);

  /* 6. Slopes: with the limit at 3°, almost anything is too steep. */
  await send('setting', { id: 'maxSlope', value: 3 });
  p = await probe();
  const slope = p.slope;
  if (slope > 4) {
    const standing = p.camera;
    const slid = await simWait(1.5);
    check('slides off ground too steep to stand on',
      metresBetween(standing, slid.camera) > 0.3 && slid.camera.height < standing.height,
      `${slope.toFixed(1)}° slope, slid ${metresBetween(standing, slid.camera).toFixed(2)} m, ` +
      `dropped ${(standing.height - slid.camera.height).toFixed(2)} m`);

    await send('camera', { state: { ...slid.camera, yaw: slid.uphill, mode: 'walk' } });
    await wait(200);
    const foot = (await probe()).camera;
    await send('keys', { mask: KEY.FORWARD });
    await simWait(1.5);
    await send('keys', { mask: 0 });
    const climbed = (await probe()).camera.height - foot.height;
    check('cannot walk up a slope steeper than the limit', climbed < 0.15,
      `height changed by ${climbed.toFixed(2)} m walking straight uphill`);
  } else {
    check('slope checks', true, `skipped: ground here is only ${slope.toFixed(1)}°`);
  }
  await send('setting', { id: 'maxSlope', value: 45 });

  /* 7. Back to flight, climb, then fall with real gravity. */
  await wait(400);
  await tapSpace(); await wait(90); await tapSpace();
  if (!locked) await send('mode', {});
  p = await until((q) => q.motion.mode === 'fly', 20000);
  check('double-tap Space switches back to flight', p.motion.mode === 'fly', `mode ${p.motion.mode}`);

  const climbA = await probe();
  await send('keys', { mask: KEY.UP });
  const climbB = await simWait(1.0);
  await send('keys', { mask: 0 });
  const climbRate = (climbB.motion.aboveGround - climbA.motion.aboveGround) / (climbB.simTime - climbA.simTime);
  check('climbs at flight speed', Math.abs(climbRate - 120) < 12,
    `${climbRate.toFixed(0)} m/s upward at a flight speed of 120 m/s`);

  p = await probe();
  const high = p.motion.aboveGround;
  await send('mode', { mode: 'walk' });
  const t0 = (await probe()).simTime;
  let sawFalling = false;
  p = await until((q) => { if (q.motion.state === 'falling') sawFalling = true; return q.motion.state === 'standing'; }, 300000, 40);
  const seconds = p.simTime - t0;
  // Fall time with quadratic drag and a 55 m/s terminal speed.
  const vt = 55, g = 9.81;
  const expected = (vt / g) * Math.acosh(Math.exp((g * (high - EYE)) / (vt * vt)));
  check('falls under gravity with air drag and lands',
    sawFalling && p.motion.state === 'standing' && Math.abs(seconds - expected) < 0.25,
    `fell ${(high - EYE).toFixed(0)} m in ${seconds.toFixed(2)} s, physics predicts ${expected.toFixed(2)} s`);

  return results;
}
