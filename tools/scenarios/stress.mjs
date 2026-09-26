/* stress.mjs — memory pressure while flying, for tools/verify.mjs --scenario stress.
 *
 * Gives terrain and buildings far less memory than the view needs and flies
 * over the stand-in town, turning, which is the situation that used to turn
 * into a full scan and sort of every loaded tile on every frame. Checks:
 *   - memory stays within the budgets: when the view needs more, detail is
 *     lowered instead (the readout shows it);
 *   - dropping tiles and housekeeping stay cheap, frame after frame;
 *   - detail comes back once the budget is raised again;
 *   - "pause streaming" stops new requests, and resuming picks up again.
 */

import { AREA } from '../mock-buildings.mjs';

const MB = 1048576;
const FLOOR = 0.201;   // detail's lowest step (terrain.js, tileset.js), with a margin

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
  const simWait = async (seconds, each) => {
    const t0 = (await probe()).simTime;
    let q;
    do { await wait(150); q = await probe(); each?.(q); } while (q.simTime - t0 < seconds);
    return q;
  };

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);
  const start = { lon: AREA.west - 0.01, lat: (AREA.south + AREA.north) / 2, height: 700, yaw: Math.PI / 2, pitch: -0.3, mode: 'fly' };
  await send('camera', { state: start });
  await send('setting', { id: 'buildingDetailKm', value: 2 });
  await until((q) => q.buildings.pending === 0 && q.terrain.pending === 0 && q.buildings.drawn > 0, 180000);
  const full = await probe();

  /* 1. Budgets well below what this view needs. */
  // What is loaded includes tiles kept from earlier views, so the budget
  // has to be well below it to be below what the view itself needs.
  const terrainMB = Math.max(0.25, (full.terrain.bytes / MB) * 0.1);
  const buildingMB = Math.max(0.25, (full.buildings.bytes / MB) * 0.4);
  await send('setting', { id: 'terrainMemory', value: terrainMB });
  await send('setting', { id: 'buildingMemory', value: buildingMB });
  await send('setting', { id: 'flySpeed', value: 60 });
  // Over the budget is only allowed with detail already at its floor (a
  // fifth): below that the engine would rather use more memory than show
  // nothing.
  let worstTerrain = 0, worstBuildings = 0, lowest = { terrain: 1, buildings: 1 };
  const over = (layer) => (layer.detail > FLOOR ? layer.bytes / Math.max(1, layer.budget) : 0);
  const watch = (q) => {
    worstTerrain = Math.max(worstTerrain, over(q.terrain));
    worstBuildings = Math.max(worstBuildings, over(q.buildings));
    lowest.terrain = Math.min(lowest.terrain, q.terrain.detail);
    lowest.buildings = Math.min(lowest.buildings, q.buildings.detail);
  };
  // Fly across the town, turning, with mouse-look messages as a mouse sends them.
  await page.evaluate(() => {
    globalThis.__look = setInterval(() => globalThis.swissgpu.send('look', { dx: 4, dy: 0 }), 8);
    globalThis.swissgpu.send('keys', { mask: 1 });
  });
  // The first second only settles onto the new budgets.
  await simWait(1);
  worstTerrain = worstBuildings = 0;
  const flying = await simWait(8, watch);
  await page.evaluate(() => { clearInterval(globalThis.__look); globalThis.swissgpu.send('keys', { mask: 0 }); });
  const p = flying.profile;
  // Stopped, and a moment for the last drops: now within the budget, or with
  // detail at its floor.
  const settled = await simWait(2);
  console.log(`  ... full view ${(full.terrain.bytes / MB).toFixed(2)} MB terrain, ${(full.buildings.bytes / MB).toFixed(2)} MB buildings; ` +
    `budgets ${terrainMB.toFixed(2)} and ${buildingMB.toFixed(2)} MB`);
  console.log(`  ... work ${p.work.toFixed(2)} ms mean, 95th ${p.work95.toFixed(2)}; evict ${p.sections.evict.toFixed(3)} mean / ` +
    `${p.peaks.evict.toFixed(2)} worst; maintain ${p.sections.maintain.toFixed(3)} / ${p.peaks.maintain.toFixed(2)}; ` +
    `terrain ${p.sections.terrain.toFixed(2)} / ${p.peaks.terrain.toFixed(2)}; buildings ${p.sections.buildings.toFixed(2)} / ${p.peaks.buildings.toFixed(2)}`);
  // Tiles keep arriving while detail steps down, and on a software GPU a
  // frame (and so a step) takes most of a second, so what counts is where it
  // settles: within the budget, or over it only with detail at its floor
  // (the budget here is below what even the floor needs, on purpose).
  check('memory settles within the budgets, or detail at its floor',
    over(settled.terrain) <= 1.02 && over(settled.buildings) <= 1.02,
    `stopped with ${(settled.terrain.bytes / MB).toFixed(2)} MB terrain at detail ${(settled.terrain.detail * 100).toFixed(0)}%, ` +
    `${(settled.buildings.bytes / MB).toFixed(2)} MB buildings at ${(settled.buildings.detail * 100).toFixed(0)}%; ` +
    `in flight at most ${(worstTerrain * 100).toFixed(0)}% and ${(worstBuildings * 100).toFixed(0)}% of the budgets above the floor`);
  check('detail is lowered instead of thrashing', lowest.terrain < 1 && lowest.buildings < 1 && flying.terrain.drawn > 0,
    `terrain detail down to ${(lowest.terrain * 100).toFixed(0)}%, buildings ${(lowest.buildings * 100).toFixed(0)}%, ` +
    `${flying.terrain.drawn} terrain tiles still drawn`);
  // On a software GPU a frame takes most of a second, so a window holds few
  // frames and one garbage collection can be its worst: the means say more.
  check('dropping tiles and housekeeping stay cheap', p.sections.evict < 1 && p.sections.maintain < 1 && p.peaks.evict < 10,
    `evict ${p.sections.evict.toFixed(2)} ms a frame on average, worst ${p.peaks.evict.toFixed(2)}; ` +
    `maintain ${p.sections.maintain.toFixed(2)} ms, worst ${p.peaks.maintain.toFixed(2)} (${p.frames} frames)`);

  /* 2. Room again: detail comes back. */
  await send('setting', { id: 'terrainMemory', value: 256 });
  await send('setting', { id: 'buildingMemory', value: 256 });
  const back = await until((q) => q.terrain.detail === 1 && q.buildings.detail === 1 && q.terrain.pending === 0, 60000, 300);
  check('detail comes back with room to spare', back.terrain.detail === 1 && back.buildings.detail === 1,
    `terrain detail ${(back.terrain.detail * 100).toFixed(0)}%, buildings ${(back.buildings.detail * 100).toFixed(0)}%`);

  /* 3. Pause streaming: nothing new is asked for; resume picks up. */
  await send('pause-streaming', { on: true });
  await send('camera', { state: { ...start, lon: start.lon + 0.2, height: 900 } });   // somewhere new
  await simWait(2);
  const paused = await probe();
  await simWait(1.5);
  const stillPaused = await probe();
  check('pausing stops new requests', stillPaused.terrain.loading === 0,
    `${paused.terrain.loading} then ${stillPaused.terrain.loading} terrain tiles on their way, ${stillPaused.terrain.pending} wanted`);
  await send('pause-streaming', { on: false });
  const resumed = await until((q) => q.terrain.loading > 0 || q.terrain.pending === 0, 30000, 100);
  check('resuming loads again', resumed.terrain.loading > 0 || resumed.terrain.pending === 0,
    `${resumed.terrain.loading} loading, ${resumed.terrain.pending} wanted`);
  await until((q) => q.terrain.pending === 0, 120000);
  await send('setting', { id: 'flySpeed', value: 120 });
  await send('setting', { id: 'buildingDetailKm', value: 0.5 });
  return results;
}
