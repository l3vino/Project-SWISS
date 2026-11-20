/* tower.mjs — tall buildings are solid at any height, for tools/verify.mjs
 * --scenario tower.
 *
 * Stage 5.7, his words: "in Basel at the 2 skyscrapers, and at a certain
 * height, I just fazed through them in normal flight". Physics only touched
 * the world within 150 m of the ground, and the Roche towers stand 178 and
 * 205 m. The stand-in town (tools/mock-buildings.mjs) has one tower that tall
 * (SKYSCRAPER); flying level at it 180 m above its base, from 200 m south of
 * it, at 60 m/s, must stop at its wall, and the focus round the camera must
 * have grown with the speed (render.js, FOCUS_LEAD).
 */

import { houseInfo, HOUSE_HALF, SKYSCRAPER } from '../mock-buildings.mjs';

const KEY = { FORWARD: 1 };
const M_LAT = 111132;

export async function run(page) {
  const results = [];
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
  const fmt = (v) => (v == null ? '?' : v.toFixed(2));

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0, 120000, 500);
  await send('setting', { id: 'renderScale', value: 0.35 });
  await send('setting', { id: 'flySpeed', value: 60 });
  const S = houseInfo(SKYSCRAPER.i, SKYSCRAPER.j);
  const from = { lon: S.lon, lat: S.lat - (HOUSE_HALF.north + 200) / M_LAT };
  await send('camera', { state: { ...from, height: S.base + 180, yaw: 0, pitch: 0, mode: 'fly' } });
  await until((q) => Math.abs(q.camera.lat - from.lat) < 1e-9 && q.buildings.pending === 0, 120000, 300);
  await send('keys', { mask: KEY.FORWARD });
  await simWait(6);
  await send('keys', { mask: 0 });
  const p = await probe();
  const gap = -(p.camera.lat - S.lat) * M_LAT - HOUSE_HALF.north;
  check('flying into it 180 m up stops at its wall', gap > 0.1 && gap < 1,
    `stopped ${fmt(gap)} m from the wall (not stopping, it would end some 150 m beyond it), height ${fmt(p.camera.height - S.base)} m over its base`);
  check('physics touches the world round it, as far as 2 s of flight', p.solid.touch === 120,
    `focus radius ${p.solid.touch} m (120 expected at 60 m/s)`);
  await send('setting', { id: 'flySpeed', value: 120 });
  return results;
}
