/* buildings.mjs — 3D buildings end to end, for tools/verify.mjs --scenario buildings.
 *
 * The stand-in building service (tools/mock-buildings.mjs) serves a small
 * town the way swissBUILDINGS3D is organised: nested tilesets, REPLACE
 * refinement from coarse boxes to gabled houses, and the detailed tiles
 * spread over plain, meshopt-compressed and Draco-compressed glTF. One house
 * per tile is marked underground.
 *
 * Checked against the service's own numbers rather than pictures: every tile
 * drawn holds exactly the triangles its houses have, minus the underground
 * one, whatever its encoding; close up, detailed tiles have replaced the
 * coarse ones; the layer switch works both ways. The screenshots show the
 * rest: houses standing on the terrain, and roofs coloured by the stand-in
 * aerial photo, whose clay-red footprints must land exactly on them.
 */

import { AREA, expectedTriangles } from '../mock-buildings.mjs';

export async function run(page, { shot } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 300) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 120000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };
  const calm = (q) => q.terrain.pending === 0 && q.buildings.pending === 0 && q.imagery.loading === 0;

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0, 120000, 500);

  /* 1. Standing in the street south of town, facing north. A search pick
   * keeps the heading, so set it first. */
  const start = await probe();
  await send('camera', { state: { ...start.camera, yaw: 0 } });
  const street = { lon: (AREA.west + AREA.east) / 2 + 0.0004, lat: AREA.south - 0.002 };
  await send('spawn', { lon: street.lon, lat: street.lat, elevation: null, label: 'town' });
  let p = await until((q) => q.motion.state === 'standing' && Math.abs(q.camera.lon - street.lon) < 1e-9, 180000);
  p = await until((q) => q.buildings.drawn > 0 && calm(q), 300000, 500);

  check('buildings stream in', p.buildings.drawn > 0 && p.buildings.triangles > 0,
    `${p.buildings.drawn} tiles, ${p.buildings.triangles} triangles, ${p.buildings.pending} still loading`);
  const enc = p.buildings.encodings;
  check('plain, meshopt and Draco tiles all decode', enc.plain > 0 && enc.meshopt > 0 && enc.draco > 0,
    `decoded ${JSON.stringify(enc)}`);

  // The bridge of the structures layer is checked by the collide scenario.
  const houseTiles = p.buildingTiles.filter((t) => t.layer.endsWith('/buildings'));
  const wrong = [];
  for (const t of houseTiles) {
    const want = expectedTriangles(t.url);
    if (!want || want.drawn !== t.triangles) wrong.push(`${t.url.split('/v1/')[1]}: ${t.triangles} (want ${want?.drawn})`);
  }
  check('every tile draws its houses, less the underground one', houseTiles.length > 0 && !wrong.length,
    wrong.length ? wrong.slice(0, 4).join('; ') : `${houseTiles.length} tiles, triangle counts exact`);
  const detailed = houseTiles.filter((t) => expectedTriangles(t.url)?.detailed);
  check('up close, detailed tiles have replaced the coarse ones', detailed.length >= 4,
    `${detailed.length} detailed and ${houseTiles.length - detailed.length} coarse tiles drawn`);
  check('no tile failed', p.buildings.failed === 0, `${p.buildings.failed} failed`);
  await snap('street');

  /* 2. From above the middle of town, looking steeply down: roofs should be
   * clay red from the photo, edge to edge, with none of it on the ground. */
  const above = { lon: street.lon, lat: (AREA.south + AREA.north) / 2 - 0.004,
    height: p.camera.height + 160, yaw: 0, pitch: -1.15, mode: 'fly' };
  await send('camera', { state: above });
  p = await until((q) => Math.abs(q.camera.lat - above.lat) < 1e-9 && q.buildings.drawn > 0 && calm(q), 300000, 500);
  check('seen from above, the town is drawn', p.buildings.drawn > 0,
    `${p.buildings.drawn} tiles, ${p.buildings.triangles} triangles`);
  await snap('above');

  /* 3. The layer switch, both ways. */
  const houses = (q) => q.buildingTiles.filter((t) => t.layer.endsWith('/buildings')).length;
  await send('setting', { id: 'buildings', value: false });
  p = await until((q) => houses(q) === 0, 30000);
  const off = houses(p);
  await send('setting', { id: 'buildings', value: true });
  p = await until((q) => houses(q) > 0, 60000);
  check('Layers → Buildings turns them off and on', off === 0 && houses(p) > 0,
    `off: ${off} tiles drawn, back on: ${houses(p)}`);

  return results;
}
