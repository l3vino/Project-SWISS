/* lod.mjs — terrain detail that follows the view, for tools/verify.mjs --scenario lod.
 *
 * Checks the quadtree against its own rules rather than against pictures:
 * the tile drawn under the eye is exactly as fine as the pixel budget asks,
 * nothing is requested that the service's availability says does not exist,
 * looking away draws less, a search pick lands you standing on the finest
 * ground there is (and on the coarser one where the finest is absent), a
 * place with no terrain at all is reached in flight with a notice, and a
 * small memory budget really is kept.
 *
 * The stand-in service (tools/mock-data.mjs) has level 18 only west of
 * 8.75° E, and says so in the metadata its level-10 tiles carry.
 */

import { FINEST_WEST_OF } from '../mock-data.mjs';

const EYE = 1.75 * 0.936;
const LEVEL_ZERO_ERROR = (6378137 * 2 * Math.PI * 0.25) / (65 * 2);
const geometricError = (z) => LEVEL_ZERO_ERROR / 2 ** z;

export async function run(page, { shot, counts } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 90000, every = 150) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const settle = (also = () => true) =>
    until((p) => p.terrain.pending === 0 && p.terrain.drawn > 0 && also(p), 120000, 400);
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 120000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };

  /* 1. At altitude, looking across the country: fine near, coarse far. */
  let p = await settle();
  const start = p.camera;
  check('coarser with distance', p.terrain.maxLevel - p.terrain.minLevel >= 3,
    `levels ${p.terrain.minLevel} to ${p.terrain.maxLevel} drawn, ${p.terrain.drawn} tiles`);
  await send('setting', { id: 'debugMode', value: 5 });
  await wait(1500);
  await snap('altitude-levels');
  await send('setting', { id: 'debugMode', value: 0 });
  const across = p.terrain.drawn;

  /* 2. Looking steeply down, the tile under the eye is in view, and exactly
   * as fine as the pixel budget asks. */
  await send('camera', { state: { ...start, pitch: -1.25 } });
  p = await settle((q) => q.camera.pitch < -1.2 && q.leaf);
  {
    const z = p.leaf.z, d = p.camera.height - p.leaf.maxHeight;
    const px = (geometricError(z) * p.errorFactor * 2) / d;    // errorFactor already divides by the 2 px budget
    check('detail under the eye matches the pixel budget', geometricError(z) * p.errorFactor <= d && z >= 10,
      `level ${z} under the eye at ${Math.round(d)} m: ${px.toFixed(2)} px of error (budget 2)`);
    check('the tiles\' own normals are used', p.leaf.normals === true, `server normals: ${p.leaf.normals}`);
  }

  /* 3. Looking away draws less: straight down sees a fraction of the view. */
  await send('camera', { state: { ...start, pitch: -1.55 } });
  p = await settle((q) => q.camera.pitch < -1.5);
  check('only what is in view is drawn', p.terrain.drawn < across * 0.5,
    `${across} tiles looking across the valley, ${p.terrain.drawn} looking straight down`);

  /* 4. A search pick where level 18 exists: standing on it. */
  const spawnAndStand = async (lon, lat) => {
    const t0 = (await probe()).simTime;
    await send('spawn', { lon, lat, elevation: null, label: 'test' });
    const q = await until((r) => r.motion.mode === 'walk' && r.motion.state === 'standing' &&
      Math.abs(r.camera.lon - lon) < 1e-9, 180000, 200);
    return { q, seconds: q.simTime - t0 };
  };
  const west = { lon: FINEST_WEST_OF - 0.05, lat: 46.2 };
  let { q, seconds } = await spawnAndStand(west.lon, west.lat);
  check('a pick lands you standing on the finest ground', q.motion.state === 'standing' &&
    q.leaf?.z === 18 && q.leaf.final && q.groundLevel === 18 && Math.abs(q.motion.aboveGround - EYE) < 0.02,
    `${q.motion.state} on level ${q.leaf?.z} (${q.leaf?.final ? 'final' : 'stand-in'}), physics on ${q.groundLevel}, ` +
    `eye ${q.motion.aboveGround?.toFixed(3)} m up, after ${seconds.toFixed(1)} s`);
  await wait(1500);
  await snap('ground');
  await send('setting', { id: 'debugMode', value: 5 });
  await wait(1500);
  await snap('ground-levels');
  await send('setting', { id: 'debugMode', value: 0 });

  /* 5. East of the line the service stops at 17, and its metadata says so. */
  const east = { lon: FINEST_WEST_OF + 0.1, lat: 46.2 };
  ({ q, seconds } = await spawnAndStand(east.lon, east.lat));
  check('where the finest level is absent, the next one is final', q.motion.state === 'standing' &&
    q.leaf?.z === 17 && q.leaf.final && Math.abs(q.motion.aboveGround - EYE) < 0.02,
    `${q.motion.state} on level ${q.leaf?.z} (${q.leaf?.final ? 'final' : 'stand-in'}), after ${seconds.toFixed(1)} s`);
  check('nothing requested that does not exist', counts ? counts.terrainMissing === 0 : true,
    counts ? `${counts.terrainMissing} requests answered "no such tile", ${counts.terrain} tiles served; ` +
      `per level ${JSON.stringify(counts.terrainByLevel)}` : 'no request counts');

  /* 6. A place with no terrain service: arrive flying, and say why. */
  await send('spawn', { lon: -74.006, lat: 40.7128, elevation: 10, label: 'New York' });
  q = await until((r) => Math.abs(r.camera.lon + 74.006) < 1e-6, 30000, 200);
  await wait(300);
  const notice = await page.evaluate(() => document.getElementById('toast')?.textContent || '');
  check('no terrain there: flying, with a notice', q.motion.mode === 'fly' && Math.abs(q.camera.height - 160) < 1 &&
    /No terrain/.test(notice), `${q.motion.mode} at ${Math.round(q.camera.height)} m, notice "${notice}"`);
  // Switzerland's tiles are all past the horizon from here, so none is drawn,
  // and no imagery is asked for where no service covers the ground.
  q = await until((r) => r.imagery.loading === 0 && r.terrain.pending === 0, 60000, 300);
  check('nothing drawn or fetched past the horizon', q.terrain.drawn === 0 && q.imagery.loading === 0,
    `${q.terrain.drawn} terrain tiles drawn, ${q.imagery.loading} imagery tiles wanted in New York`);

  /* 7. A small memory budget is kept: unused tiles go, what is in view stays. */
  await send('spawn', { lon: west.lon, lat: west.lat, elevation: null, label: 'back' });
  q = await until((r) => r.motion.state === 'standing' && Math.abs(r.camera.lon - west.lon) < 1e-9, 120000, 200);
  // A visit where no imagery exists must not have switched any zoom off:
  // only the one the stand-in refuses outright, 20, may be.
  check('imagery survives a visit to where there is none', q.imagery.disabled.every((z) => z >= 20) &&
    q.imagery.resident > 0, `disabled ${JSON.stringify(q.imagery.disabled)}, ${q.imagery.resident} tiles resident`);
  const before = q.terrain;
  await send('setting', { id: 'terrainMemory', value: 0.5 });
  await send('camera', { state: { ...q.camera, yaw: q.camera.yaw + 0.3 } });   // any change re-selects
  q = await until((r) => r.terrain.pending === 0 && r.terrain.ready < before.ready, 60000, 300);
  // Tiles in use this frame are never dropped, so the budget can only take
  // everything else; the check is that it does, and the view survives it.
  check('the memory budget is kept', q.terrain.ready < before.ready && q.terrain.bytes < before.bytes &&
    q.terrain.drawn > 0 && q.leaf?.z === 18,
    `${before.ready} tiles (${(before.bytes / 1048576).toFixed(2)} MB) before, ` +
    `${q.terrain.ready} (${(q.terrain.bytes / 1048576).toFixed(2)} MB) after a 0.5 MB budget, ` +
    `${q.terrain.drawn} drawn, level ${q.leaf?.z} underfoot`);
  await send('setting', { id: 'terrainMemory', value: 256 });

  return results;
}
