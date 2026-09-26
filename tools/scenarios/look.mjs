/* look.mjs — screenshots of the stand-in town from a few set places, for
 * judging how buildings look: tools/verify.mjs --scenario look --shot out.png
 * (LOOK=street,sunlit in the environment takes only those views)
 *
 * Nothing is measured; each view waits for its tiles and photos and is saved
 * as out-<view>.png at three quarters render scale. The views: a house from
 * the street, a wall from arm's length, a wall in the sun, a row of houses
 * from a little above, and the town from a hillside.
 */

import { houseInfo, HOUSE_HALF } from '../mock-buildings.mjs';
import { height } from '../mock-data.mjs';

const M_LAT = 111132;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

export async function run(page, { shot } = {}) {
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 400) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const settled = (q) => q.buildings.pending === 0 && q.imagery.loading === 0 && q.terrain.pending === 0;
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 180000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };
  const at = (h, east, north) => ({ lon: h.lon + east / mLon(h.lat), lat: h.lat + north / M_LAT });

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);
  await page.evaluate(() => { document.getElementById('readout').hidden = true; });
  await send('setting', { id: 'renderScale', value: 0.75 });

  // The stand-in town sits on a slope that falls to the west, so each view
  // looks east, up at the houses.
  const views = [
    // [name, house, metres east and north of it, height above the ground there, yaw, pitch]
    ['street', houseInfo(22, 0), -(HOUSE_HALF.east + 10), 0, 1.65, Math.PI / 2, 0.2],
    ['wall', houseInfo(22, 0), -(HOUSE_HALF.east + 2.2), 1.5, 1.65, Math.PI / 2 + 0.25, 0.35],
    // The south wall, which the sun (south-east, 42° up) lights.
    ['sunlit', houseInfo(22, 0), -3, -(HOUSE_HALF.north + 9), 1.65, 0.2, -0.02],
    ['row', houseInfo(20, 1), -60, -30, 25, 1.2, -0.1],
    ['town', houseInfo(18, 3), -200, -100, 150, 1.1, -0.25],
  ];
  // Seconds of the app's own clock: on a software GPU a frame can take a
  // second, and the tiles for a view are only asked for once it is drawn.
  const simWait = async (seconds) => {
    const t0 = (await probe()).simTime;
    await until((q) => q.simTime - t0 >= seconds, 300000, 300);
  };
  // LOOK=sunlit,row takes only those.
  const only = process.env.LOOK ? process.env.LOOK.split(',') : null;
  for (const [name, h, east, north, up, yaw, pitch] of views) {
    if (only && !only.includes(name)) continue;
    const p = at(h, east, north);
    await send('camera', { state: { lon: p.lon, lat: p.lat, height: height(p.lon, p.lat) + up, yaw, pitch, mode: 'fly' } });
    await simWait(1);
    await until(settled, 300000);
    await simWait(1);
    await until(settled, 300000);
    await snap(name);
    console.log(`  ... ${name}: house ${h.id}${h.tower ? ' (tower)' : ''}`);
  }
  return [{ name: 'views saved', ok: true, detail: views.map((v) => v[0]).join(', ') }];
}
