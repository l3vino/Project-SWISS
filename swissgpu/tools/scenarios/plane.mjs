/* plane.mjs — the airplane mode (Stage 5.9b) in the app, for
 * tools/verify.mjs --scenario plane --shot out.png
 *
 * From 600 m over the stand-in valley east of Testdorf, flying north: P into
 * the cockpit, the wheel up 8 notches, a roll to the right and let go, a
 * pull, then P out again. Checks: in the airplane at 600 km/h at least; the
 * speed asked up 200 km/h; banked right by the roll, the wings back level
 * after it, flying on all the while with no keys held; climbing while
 * pulled; by default only the pointer (the crosshair as a dot, nothing drawn
 * over the view); Settings → Vehicles turning the rest of the display on
 * (clicked in the menu); P again back to flying, the display gone. Saved as
 * out-menu.png (the Vehicles tab) and out-hud.png (the whole display on).
 * Everything on the simulation's clock (a software GPU draws a few frames a
 * second, physics steps at most a tenth of a second a frame).
 */

import { height } from '../mock-data.mjs';

const KEY = { FORWARD: 1, LEFT: 2, BACK: 4, RIGHT: 8 };
const DEG = Math.PI / 180;

export async function run(page, { shot } = {}) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`  ... ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
  };
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe()).catch(() => null);
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 240000, every = 300) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) { const q = await probe(); if (q) { last = q; if (test(q)) return q; } await wait(every); }
    return last;
  };
  const simWait = async (seconds, each) => {
    let q = await until((r) => r.simTime != null);
    const t0 = q.simTime;
    do { await wait(200); const r = await probe(); if (r) { q = r; each?.(q); } } while (q.simTime - t0 < seconds);
    return q;
  };
  // The display: the cockpit's canvas shown or not, the crosshair the pointer (a dot) or not.
  const hud = () => page.evaluate(() => {
    const c = document.getElementById('crosshair').classList;
    return { drawn: !document.getElementById('cockpit').hidden, dot: c.contains('crosshair--plane') && !c.contains('crosshair--nopointer') };
  });

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);
  await page.evaluate(() => { document.getElementById('readout').hidden = true; });
  await send('setting', { id: 'renderScale', value: 0.75 });
  const lon = 8.9, lat = 46.19;
  await send('camera', { state: { lon, lat, height: height(lon, lat) + 600, yaw: 0, pitch: 0, mode: 'fly' } });
  await until((q) => q.physicsGround?.accurate && q.terrain.pending === 0, 240000);

  await send('mode', { mode: 'plane' });
  let q = await simWait(1);
  const start = { lat: q.camera.lat, height: q.camera.height, target: q.plane?.target ?? 0 };
  check('P: in the airplane, flying on at 600 km/h at least', q.motion?.mode === 'plane' && q.plane && q.plane.speed * 3.6 >= 599,
    `mode ${q.motion?.mode}, ${Math.round((q.plane?.speed ?? 0) * 3.6)} km/h, asked ${Math.round(start.target * 3.6)} km/h`);
  await send('speed', { notches: 8 });
  q = await simWait(0.3);
  check('the wheel asks for more speed', Math.round((q.plane.target - start.target) * 3.6) === 200,
    `asked ${Math.round(start.target * 3.6)} → ${Math.round(q.plane.target * 3.6)} km/h`);
  // The roll builds up while D is held (Stage 5.10b): 1.2 s banks about 50°.
  await send('keys', { mask: KEY.RIGHT });
  let most = 0;
  q = await simWait(1.2, (r) => { if (r.plane) most = Math.max(most, r.camera.roll ?? 0); });
  await send('keys', { mask: 0 });
  const before = { lon: q.camera.lon, lat: q.camera.lat, t: q.simTime, speed: q.plane?.speed ?? 0 };
  q = await simWait(4);
  check('a roll right banks, and the wings come back level', most > 30 * DEG && Math.abs(q.camera.roll) < 3 * DEG,
    `banked ${(most / DEG).toFixed(0)}°, ${(q.camera.roll / DEG).toFixed(1)}° after letting go`);
  // With no keys held it flies on: at least nine tenths of its speed's way.
  const flown = Math.hypot((q.camera.lon - before.lon) * 111320 * Math.cos(q.camera.lat * DEG), (q.camera.lat - before.lat) * 111132);
  const seconds = q.simTime - before.t;
  check('it flies on by itself', flown > 0.9 * before.speed * seconds,
    `${flown.toFixed(0)} m in ${seconds.toFixed(1)} s with no keys held, at ${Math.round(before.speed * 3.6)} km/h`);
  const h0 = q.camera.height;
  await send('keys', { mask: KEY.BACK });
  q = await simWait(2);
  await send('keys', { mask: 0 });
  check('pulling climbs', q.camera.height > h0 + 20 && (q.plane?.climb ?? 0) > 10,
    `${(q.camera.height - h0).toFixed(0)} m up in 2 s, climbing ${(q.plane?.climb ?? 0).toFixed(0)} m/s`);
  await wait(500);
  const h = await hud();
  check('by default only the pointer: a dot, nothing drawn over the view', h.dot && !h.drawn, JSON.stringify(h));
  // Settings → Vehicles → Airplane display: everything on, through the menu.
  await page.click('#gear');
  await wait(400);
  await page.click('.menu__tab[data-tab="vehicles"]');
  await wait(300);
  const items = ['planeLadder', 'planeMarker', 'planeSpeed', 'planeAltitude', 'planeHeading', 'planeThrottle', 'planeWarnings'];
  for (const id of items) await page.click(`button.toggle[aria-labelledby="setting-${id}"]`);
  const on = await page.$$eval('button.toggle[aria-checked="true"]', (els) => els.map((e) => e.getAttribute('aria-labelledby')));
  if (shot) {
    try { await page.screenshot({ path: shot.replace(/\.png$/, '-menu.png'), timeout: 180000 }); }
    catch (err) { console.warn(`screenshot skipped: ${err.message.split('\n')[0]}`); }
  }
  await page.keyboard.press('Escape');
  q = await simWait(0.5);
  await wait(800);
  const all = await hud();
  check('the Vehicles tab turns the rest of the display on', items.every((id) => on.includes(`setting-${id}`)) && all.drawn && all.dot,
    `${on.length} toggles on in the tab; ${JSON.stringify(all)}`);
  if (shot) {
    try { await page.screenshot({ path: shot.replace(/\.png$/, '-hud.png'), timeout: 180000 }); }
    catch (err) { console.warn(`screenshot skipped: ${err.message.split('\n')[0]}`); }
  }
  await send('mode', { mode: 'plane' });
  q = await simWait(0.5);
  await wait(500);
  const after = await hud();
  check('P again: back to flying, the display gone', q.motion?.mode === 'fly' && !after.drawn && !after.dot,
    `mode ${q.motion?.mode}, ${JSON.stringify(after)}`);
  return results;
}
