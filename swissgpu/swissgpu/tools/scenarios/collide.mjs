/* collide.mjs — buildings and bridges are solid, for tools/verify.mjs --scenario collide.
 *
 * Runs against the stand-in town and bridge of tools/mock-buildings.mjs,
 * whose every house and deck is known exactly, so each check measures
 * against the model rather than a picture: where a wall stopped the walker,
 * how far an arrival inside a house was moved and whether it ended outside,
 * the height of the roof or deck stood on against the terrain below it.
 * Screenshots show a facade close up and the bridge from the side.
 */

import { houseInfo, HOUSE_HALF, BRIDGE, expectedStructureTriangles } from '../mock-buildings.mjs';
import { height } from '../mock-data.mjs';

const KEY = { FORWARD: 1 };
const EYE = 1.75 * 0.936;
const M_LAT = 111132;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

export async function run(page, { shot } = {}) {
  const results = [];
  // Printed as they happen too: this scenario takes a while on a software GPU.
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`  ... ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
  };
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 300) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const simWait = async (seconds) => {
    const t0 = (await probe()).simTime;
    let q;
    do { await wait(60); q = await probe(); } while (q.simTime - t0 < seconds);
    return q;
  };
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 120000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };
  /** Metres east and north of a house's centre. */
  const offset = (h, q) => ({ east: (q.camera.lon - h.lon) * mLon(h.lat), north: (q.camera.lat - h.lat) * M_LAT });
  const standing = (q) => q.motion.mode === 'walk' && q.motion.state === 'standing';
  const fmt = (v) => (v == null ? '?' : v.toFixed(2));

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0, 120000, 500);

  /* 1. In the street facing a house, ten metres from its south wall. */
  const H = houseInfo(22, 0);
  const street = { lon: H.lon, lat: H.lat - (HOUSE_HALF.north + 10) / M_LAT };
  let p = await probe();
  await send('camera', { state: { ...p.camera, yaw: 0, pitch: 0 } });
  await send('spawn', { lon: street.lon, lat: street.lat, elevation: null, label: 'street' });
  p = await until((q) => standing(q) && q.solid.clearedBy != null && q.solid.settled && q.buildings.pending === 0, 300000, 500);
  check('arrives in the street, left where it was put', standing(p) && p.solid.clearedBy === 0,
    `${p.motion.state}, moved ${fmt(p.solid.clearedBy)} m, ${p.solid.triangles} triangles within reach`);

  await send('setting', { id: 'renderScale', value: 1 });
  await send('camera', { state: { ...p.camera, pitch: 0.18 } });
  await until((q) => q.imagery.loading === 0 && q.buildings.pending === 0, 60000, 500);
  await snap('facade');
  await send('setting', { id: 'renderScale', value: 0.35 });
  await send('camera', { state: { ...p.camera, pitch: 0 } });

  /* 2. Walking straight at the wall stops a body's radius short of it. */
  await send('keys', { mask: KEY.FORWARD });
  await simWait(12);
  await send('keys', { mask: 0 });
  p = await until(standing, 60000, 200);
  const stop = offset(H, p);
  const gap = -stop.north - HOUSE_HALF.north;
  check('a wall stops you', gap > 0.25 && gap < 0.45 && Math.abs(stop.east) < 0.3,
    `stopped ${fmt(gap)} m from the wall, ${fmt(stop.east)} m off the line walked`);

  /* 3. Walking at it at 45° slides along it. */
  await send('camera', { state: { ...p.camera, yaw: Math.PI / 4 } });
  await send('keys', { mask: KEY.FORWARD });
  await simWait(3);
  await send('keys', { mask: 0 });
  p = await until(standing, 60000, 200);
  const slid = offset(H, p);
  const slidGap = -slid.north - HOUSE_HALF.north;
  check('walking into it at an angle slides along it', slid.east - stop.east > 1.5 && slidGap > 0.25 && slidGap < 0.45,
    `${fmt(slid.east - stop.east)} m along the wall, still ${fmt(slidGap)} m from it`);

  /* 4. Arriving inside the house moves you out to the nearest open ground. */
  await send('spawn', { lon: H.lon, lat: H.lat, elevation: null, label: 'inside' });
  p = await until((q) => standing(q) && q.solid.clearedBy != null, 300000, 500);
  const out = offset(H, p);
  const outside = Math.abs(out.east) > HOUSE_HALF.east + 0.25 || Math.abs(out.north) > HOUSE_HALF.north + 0.25;
  check('arriving inside a house puts you outside it', outside && p.solid.clearedBy > 4 && p.solid.clearedBy < 9,
    `moved ${fmt(p.solid.clearedBy)} m to ${fmt(out.east)} m east, ${fmt(out.north)} m north of its centre`);

  /* 5. Dropped onto a tower's flat roof, you stand on it. */
  const T = houseInfo(27, 0);
  await send('camera', { state: { lon: T.lon, lat: T.lat, height: T.eaves + 12, yaw: 0, pitch: -0.3, mode: 'fly' } });
  await until((q) => Math.abs(q.camera.lon - T.lon) < 1e-9 && q.solid.settled && q.buildings.pending === 0, 120000, 500);
  await send('mode', { mode: 'walk' });
  p = await until(standing, 120000, 200);
  const feet = p.camera.height - EYE;
  check('you can stand on a roof', p.solid.onStructure && Math.abs(feet - T.eaves) < 0.05 && p.solid.terrainBelow < T.eaves - 20,
    `feet ${fmt(feet - T.eaves)} m from the roof, ${fmt(feet - p.solid.terrainBelow)} m above the ground below`);

  /* 6. The bridge: drawn, and walked onto from the hillside it leaves. */
  const hillside = { lon: BRIDGE.start.lon - 3 / mLon(BRIDGE.start.lat), lat: BRIDGE.start.lat };
  await send('camera', { state: { ...p.camera, yaw: Math.PI / 2, pitch: 0 } });
  await send('spawn', { lon: hillside.lon, lat: hillside.lat, elevation: null, label: 'bridge' });
  p = await until((q) => standing(q) && q.solid.clearedBy != null && q.buildings.pending === 0, 300000, 500);
  const deckTile = p.buildingTiles.find((t) => t.layer.endsWith('/structures'));
  check('the bridge layer draws the bridge', deckTile && deckTile.triangles === expectedStructureTriangles(deckTile.url),
    deckTile ? `${deckTile.triangles} triangles, ${expectedStructureTriangles(deckTile.url)} expected` : 'no structures tile drawn');
  await send('keys', { mask: KEY.FORWARD });
  await simWait(20);
  await send('keys', { mask: 0 });
  p = await until(standing, 60000, 200);
  const along = (p.camera.lon - BRIDGE.start.lon) * mLon(BRIDGE.start.lat);
  const onDeck = p.camera.height - EYE - BRIDGE.top;
  check('walks out onto the bridge deck, the valley falling away below', p.solid.onStructure && along > 15 &&
    Math.abs(onDeck) < 0.05 && p.solid.terrainBelow < BRIDGE.top - 8,
    `${fmt(along)} m along, feet ${fmt(onDeck)} m from the deck, ${fmt(BRIDGE.top - p.solid.terrainBelow)} m above the ground`);

  const side = { lon: BRIDGE.start.lon + 60 / mLon(BRIDGE.start.lat), lat: BRIDGE.start.lat - 70 / M_LAT };
  await send('camera', { state: { ...side, height: BRIDGE.top + 6, yaw: 0, pitch: -0.12, mode: 'fly' } });
  await send('setting', { id: 'renderScale', value: 1 });
  await until((q) => q.imagery.loading === 0 && q.buildings.pending === 0 && q.terrain.pending === 0, 90000, 500);
  await snap('bridge');
  await send('setting', { id: 'structures', value: false });
  p = await until((q) => !q.buildingTiles.some((t) => t.layer.endsWith('/structures')), 30000);
  const hidden = !p.buildingTiles.some((t) => t.layer.endsWith('/structures'));
  await send('setting', { id: 'structures', value: true });
  p = await until((q) => q.buildingTiles.some((t) => t.layer.endsWith('/structures')), 60000);
  check('Layers → Bridges & structures turns them off and on', hidden && p.buildingTiles.some((t) => t.layer.endsWith('/structures')),
    `off: ${hidden ? 'gone' : 'still drawn'}, back on: ${p.buildingTiles.filter((t) => t.layer.endsWith('/structures')).length} tile`);
  await send('setting', { id: 'renderScale', value: 0.35 });

  /* 7. Flying into the house stops at its wall, unless flying through is on. */
  await send('setting', { id: 'flySpeed', value: 20 });
  const approach = { lon: H.lon, lat: H.lat - (HOUSE_HALF.north + 8) / M_LAT };
  const eye = Math.max(height(approach.lon, approach.lat) + EYE + 0.5, H.base + 3);
  await send('camera', { state: { ...approach, height: eye, yaw: 0, pitch: 0, mode: 'fly' } });
  await until((q) => Math.abs(q.camera.lat - approach.lat) < 1e-9 && q.solid.settled && q.buildings.pending === 0, 60000, 300);
  await send('keys', { mask: KEY.FORWARD });
  await simWait(2);
  await send('keys', { mask: 0 });
  p = await probe();
  const flew = offset(H, p);
  const flewGap = -flew.north - HOUSE_HALF.north;
  check('flying into a wall stops at it', flewGap > 0.2 && flewGap < 0.5, `stopped ${fmt(flewGap)} m from the wall`);
  await send('setting', { id: 'flyThrough', value: true });
  await send('keys', { mask: KEY.FORWARD });
  await simWait(1.5);
  await send('keys', { mask: 0 });
  p = await probe();
  const through = offset(H, p);
  check('with Fly through buildings on, it flies on through', through.north > -HOUSE_HALF.north + 2,
    `now ${fmt(through.north)} m north of the house's centre`);
  await send('setting', { id: 'flyThrough', value: false });
  await send('setting', { id: 'flySpeed', value: 120 });

  return results;
}
