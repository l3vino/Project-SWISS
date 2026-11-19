/* flight.mjs — flying low over ground that is still loading, for
 * tools/verify.mjs --scenario flight.
 *
 * The stand-in terrain (tools/mock-data.mjs) is an egg-crate of basins near
 * 300 m between ridges near 2,600 m, so the coarse tiles that arrive first
 * have surfaces far from a basin floor, the way the real Alps do. Before
 * Stage 4.1, physics stood on whatever tile was finest under the camera,
 * including those, and a camera flying along a valley was lifted to the
 * height of the peaks. Each check starts in a basin far from anything loaded:
 *  1. Placed low with no key held, the camera stays at its height while the
 *     terrain streams in level by level.
 *  2. Physics only ever stands on accurate ground: level 14 or finer, or the
 *     finest the service has there.
 *  3. Flying fast and low through ground that has not loaded, the camera
 *     never rises unless accurate ground rises under it, and the ground
 *     ahead is asked for before it is reached.
 *  4. Holding Up still climbs.
 *  5. A walker placed low over unloaded ground waits, then drops onto the
 *     accurate ground; it is never lifted onto a coarse one. Running
 *     backwards from there, away from everything the view has loaded in
 *     detail, it never meets an edge: the ground behind is asked for.
 *  6. A walker high above everything falls at once, accurate ground or not.
 *
 * Everything is measured on the simulation's clock: a software GPU draws a
 * few frames a second and physics steps at most a tenth of a second a frame.
 */

import { height as trueHeight } from '../mock-data.mjs';

const KEY = { FORWARD: 1, BACK: 4, UP: 16, SPRINT: 64 };
const EYE = 1.75 * 0.936;
const ACCURATE_LEVEL = 14;
const M_PER_DEG_LAT = 111_132;

/* Basin floors of the stand-in, far from the start at Locarno and from each other. */
const BASINS = {
  still: { lon: 7.6331, lat: 46.5453 },
  fast: { lon: 10.179, lat: 46.3726 },
  walk: { lon: 9.9669, lat: 45.8547 },
  fall: { lon: 7.6331, lat: 45.8547 },
};

export async function run(page) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`  ... ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
  };
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 180000, every = 150) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const simWait = async (seconds, each) => {
    const t0 = (await probe()).simTime;
    let q;
    do { await wait(120); q = await probe(); each?.(q); } while (q.simTime - t0 < seconds);
    return q;
  };
  /* Physics may stand on this level at this point: finer than 13, or the
   * finest the stand-in has (17 east of 8.75°, 18 west of it). */
  const accurateLevel = (z) => z >= ACCURATE_LEVEL;

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);

  /* 1 and 2. Placed low over a basin nothing has loaded yet, no key held. */
  const A = BASINS.still;
  const startA = trueHeight(A.lon, A.lat) + 100;
  await send('camera', { state: { lon: A.lon, lat: A.lat, height: startA, yaw: 0.6, pitch: -0.2, mode: 'fly' } });
  let highest = -Infinity, lowest = Infinity, coarseTop = -Infinity, coarseLevels = new Set();
  const physicsLevels = new Set();
  let q = await until((r) => {
    if (Math.abs(r.camera.lon - A.lon) > 1e-9) return false;
    highest = Math.max(highest, r.camera.height);
    lowest = Math.min(lowest, r.camera.height);
    if (r.leaf && r.leaf.z < ACCURATE_LEVEL) { coarseLevels.add(r.leaf.z); coarseTop = Math.max(coarseTop, r.leaf.maxHeight); }
    if (r.physicsGround) physicsLevels.add(r.physicsGround.level);
    return r.physicsGround?.accurate && r.leaf?.final && r.terrain.pending === 0;
  });
  check('placed low over ground still loading, the camera stays put',
    highest - startA < 0.01 && startA - lowest < 0.01 && q.physicsGround?.accurate,
    `started ${startA.toFixed(1)} m, stayed within ${highest.toFixed(1)}–${lowest.toFixed(1)} m while levels ` +
    `${[...coarseLevels].sort((a, b) => a - b).join(', ')} were drawn (their tops up to ${Math.round(coarseTop)} m); ` +
    `ground known ${q.physicsGround ? `${(q.camera.height - q.physicsGround.height).toFixed(1)} m below` : 'nowhere'}`);
  check('physics only stands on accurate ground', physicsLevels.size > 0 && [...physicsLevels].every(accurateLevel),
    `levels physics used: ${[...physicsLevels].sort((a, b) => a - b).join(', ') || 'none'}`);

  /* 3. Fast and low into ground that has not loaded. */
  const B = BASINS.fast;
  const startB = trueHeight(B.lon, B.lat) + 40;
  await send('setting', { id: 'flySpeed', value: 250 });
  await send('camera', { state: { lon: B.lon, lat: B.lat, height: startB, yaw: Math.PI / 2, pitch: -0.1, mode: 'fly' } });
  await until((r) => Math.abs(r.camera.lon - B.lon) < 1e-9, 30000, 100);
  const aheadBefore = (await probe()).lookAheads;
  let prev = null, lifts = 0, unexplained = [], samples = 0, known = 0, liftedBy = 0;
  const watch = (r) => {
    samples++;
    if (r.physicsGround?.accurate) known++;
    if (prev && r.camera.height > prev.camera.height + 0.05) {
      const onFloor = r.physicsGround?.accurate && r.motion.aboveGround != null && Math.abs(r.motion.aboveGround - EYE) < 0.1;
      if (onFloor) { lifts++; liftedBy = Math.max(liftedBy, r.camera.height - prev.camera.height); }
      else unexplained.push(`${prev.camera.height.toFixed(1)}→${r.camera.height.toFixed(1)} m at sim ${r.simTime.toFixed(1)} s`);
    }
    prev = r;
  };
  await send('keys', { mask: KEY.FORWARD });
  const flown = await simWait(8, watch);
  await send('keys', { mask: 0 });
  const travelled = Math.hypot((flown.camera.lon - B.lon) * 77000, (flown.camera.lat - B.lat) * 111000);
  check('flying fast through unloaded ground, the camera rises only onto accurate ground',
    unexplained.length === 0 && travelled > 1000,
    `${Math.round(travelled)} m at 250 m/s, ${lifts} lifts onto accurate ground (largest ${liftedBy.toFixed(1)} m), ` +
    `${unexplained.length} other rises${unexplained.length ? `: ${unexplained.slice(0, 3).join('; ')}` : ''}`);
  check('the ground ahead is asked for before it is reached', flown.lookAheads - aheadBefore >= 8 && known / samples > 0.6,
    `${flown.lookAheads - aheadBefore} columns ahead requested, accurate ground under the camera in ` +
    `${Math.round((100 * known) / Math.max(1, samples))}% of ${samples} samples`);

  /* 4. Up held climbs, floor or not. */
  const climbA = await probe();
  await send('keys', { mask: KEY.UP });
  const climbB = await simWait(0.5);
  await send('keys', { mask: 0 });
  const rate = (climbB.camera.height - climbA.camera.height) / (climbB.simTime - climbA.simTime);
  check('holding Up climbs at flight speed', Math.abs(rate - 250) < 25, `${rate.toFixed(0)} m/s at a flight speed of 250 m/s`);
  await send('setting', { id: 'flySpeed', value: 120 });

  /* 5. A walker placed low over unloaded ground. */
  const C = BASINS.walk;
  const groundC = trueHeight(C.lon, C.lat);
  const startC = groundC + 30;
  await send('camera', { state: { lon: C.lon, lat: C.lat, height: startC, yaw: 0, pitch: -0.1, mode: 'walk' } });
  let waited = false, walkHighest = -Infinity, states = new Set();
  q = await until((r) => {
    if (Math.abs(r.camera.lon - C.lon) > 1e-9) return false;
    walkHighest = Math.max(walkHighest, r.camera.height);
    states.add(r.motion.state);
    if (r.motion.state === 'waiting for ground') waited = true;
    return r.motion.state === 'standing' && r.physicsGround?.accurate;
  });
  check('a walker over unloaded ground waits, then drops onto accurate ground',
    walkHighest - startC < 0.01 && q.motion.state === 'standing' && Math.abs(q.motion.aboveGround - EYE) < 0.02 &&
    Math.abs(q.physicsGround.height - groundC) < 20,
    `${waited ? 'waited, then ' : ''}${[...states].join(' → ')}; never above ${walkHighest.toFixed(1)} m (placed at ` +
    `${startC.toFixed(1)}), standing on level ${q.physicsGround?.level} at ${q.physicsGround?.height.toFixed(1)} m, eye ` +
    `${q.motion.aboveGround?.toFixed(3)} m up`);

  /* 5b. Running backwards, away from everything the view has loaded in
   * detail: the ground behind is asked for, so the walker never meets an
   * edge. The view only refines what it sees, and it looks the other way. */
  const backA = await probe();
  let backWaits = 0;
  await send('keys', { mask: KEY.BACK | KEY.SPRINT });
  const backB = await simWait(15, (r) => { if (r.motion.state === 'waiting for ground') backWaits++; });
  await send('keys', { mask: 0 });
  const back = Math.hypot((backB.camera.lon - backA.camera.lon) * 77000, (backB.camera.lat - backA.camera.lat) * M_PER_DEG_LAT);
  const backSeconds = backB.simTime - backA.simTime;
  check('running backwards into ground the view never loaded, the walker keeps going',
    back > 0.8 * 4.5 * backSeconds && backWaits === 0,
    `${back.toFixed(1)} m in ${backSeconds.toFixed(1)} s (${(back / backSeconds).toFixed(2)} m/s, running is 4.5), ` +
    `${backWaits} samples waiting for ground, ${backB.groundColumns - backA.groundColumns} tiles asked for around the walker`);

  /* 6. A walker high above everything falls straight away. */
  const D = BASINS.fall;
  await send('camera', { state: { lon: D.lon, lat: D.lat, height: 5200, yaw: 0, pitch: -0.1, mode: 'walk' } });
  const fallA = await until((r) => Math.abs(r.camera.lon - D.lon) < 1e-9, 30000, 100);
  const fallB = await simWait(1);
  const dropped = fallA.camera.height - fallB.camera.height;
  const seconds = fallB.simTime - fallA.simTime;
  check('high above everything, a walker falls at once', dropped > 0.8 * 0.5 * 9.81 * seconds * seconds &&
    fallB.motion.state !== 'waiting for ground',
    `fell ${dropped.toFixed(1)} m in ${seconds.toFixed(2)} s (${fallB.motion.state}), highest terrain there ${Math.round(fallB.highest)} m, ` +
    `accurate ground ${fallB.physicsGround ? 'known' : 'not known yet'}`);
  await send('mode', { mode: 'fly' });
  return results;
}
