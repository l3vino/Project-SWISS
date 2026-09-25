/* perf.mjs — where the render thread's time goes, for tools/verify.mjs --scenario perf.
 *
 * Flies low over the stand-in town, streaming terrain, photos and buildings
 * as it goes, and reports the profiler's split of each frame's work. On a
 * software GPU the drawing sections mostly measure the rasteriser, so the
 * numbers to watch are the streaming ones: uploads, terrain, buildings,
 * imagery, and the worst frames. The checks only guard the budgets that the
 * code sets itself: no upload slice overruns, nothing queued forever.
 */

import { AREA } from '../mock-buildings.mjs';

export async function run(page) {
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 400) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const simWait = async (seconds) => {
    const t0 = (await probe()).simTime;
    let q;
    do { await wait(100); q = await probe(); } while (q.simTime - t0 < seconds);
    return q;
  };

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);
  const start = { lon: AREA.west + 0.002, lat: (AREA.south + AREA.north) / 2, height: 2950, yaw: Math.PI / 2, pitch: -0.35, mode: 'fly' };
  await send('camera', { state: start });
  await send('setting', { id: 'flySpeed', value: 60 });
  await until((q) => q.buildings.pending === 0 && q.imagery.loading === 0 && q.terrain.pending === 0, 180000);

  const before = await probe();
  await send('keys', { mask: 1 });
  const flying = await simWait(8);
  await send('keys', { mask: 0 });
  const p = flying.profile;
  const fmt = (v) => v.toFixed(2);
  const split = Object.entries(p.sections).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
  console.log(`  ... work ${fmt(p.work)} ms mean, ${fmt(p.work99)} ms 99th, ${p.late} late of ${p.frames}; ${split}`);
  const peaks = Object.entries(p.peaks).map(([k, v]) => `${k} ${fmt(v)}`).join(', ');
  console.log(`  ... worst single frame per section: ${peaks}`);
  console.log(`  ... uploads: ${JSON.stringify(flying.uploads)}; flew ${((flying.camera.lon - before.camera.lon) * 77000).toFixed(0)} m`);
  check('the upload slice keeps to its budget', flying.uploads.ms < 2 + 25,
    `last slice ${fmt(flying.uploads.ms)} ms for ${flying.uploads.ran} jobs, ${flying.uploads.waiting} waiting`);
  const settled = await until((q) => q.uploads.waiting === 0 && q.buildings.pending === 0 && q.terrain.pending === 0, 180000);
  check('nothing is left waiting to upload', settled.uploads.waiting === 0,
    `${settled.uploads.waiting} uploads waiting once streaming settled`);
  await send('setting', { id: 'flySpeed', value: 120 });
  return results;
}
