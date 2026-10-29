/* imagery.mjs — the clipmap under load, for tools/verify.mjs --scenario imagery.
 *
 * Settles at the spawn altitude and checks the level the clipmap chose against
 * the arithmetic; checks that blank placeholder tiles outside the covered
 * area were refused rather than drawn; then goes down to the ground, where
 * the stand-in service refuses zoom 20, and checks the clipmap stops asking
 * for it instead of hammering it. Screenshots go next to --shot.
 */

const EARTH = 40075016.686;

export async function run(page, { shot } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  // A software GPU can take many seconds per frame here; a slow screenshot is
  // not a failure of the app.
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 120000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };
  const settle = async (ms) => {
    const end = Date.now() + ms;
    let calm = 0, p;
    while (Date.now() < end) {
      p = await probe();
      calm = p.terrain.pending === 0 && p.imagery.loading === 0 ? calm + 1 : 0;
      if (calm >= 3) break;
      await wait(500);
    }
    return p;
  };

  /* 1. At altitude: the sharpest level is the one whose pixels match the
   * screen on the nearest ground. */
  let p = await settle(120000);
  const view = await page.evaluate(() => ({ h: document.documentElement.clientHeight }));
  const cam = p.camera;
  const pixelAngle = (2 * Math.tan(Math.PI / 6)) / view.h;
  const metresAtZ0 = (EARTH * Math.cos((cam.lat * Math.PI) / 180)) / 256;
  check('imagery streams in', p.imagery.resident > 20, `${p.imagery.resident} tiles resident, ${p.imagery.loading} loading`);
  check('only as sharp as the screen can show', p.imagery.top >= 13 && p.imagery.top <= 16,
    `sharpest zoom ${p.imagery.top} at ${Math.round(cam.height)} m ` +
    `(a pixel covers ${(metresAtZ0 / 2 ** p.imagery.top).toFixed(1)} m at that zoom, ` +
    `${(pixelAngle * 3000).toFixed(1)} m on ground 3 km below)`);
  check('blank tiles outside the coverage are refused', p.imagery.missing > 0,
    `${p.imagery.missing} tiles came back blank or refused and were not drawn`);
  await snap('altitude');

  await send('setting', { id: 'debugMode', value: 4 });
  await wait(1500);
  await snap('levels');
  await send('setting', { id: 'debugMode', value: 0 });

  /* 2. On the ground, where every level down to 20 is wanted. The stand-in
   * refuses 20, as a service without it would. */
  await send('camera', { state: { lon: 8.8, lat: 46.17, height: -300, yaw: 0.6, pitch: -0.12, mode: 'fly' } });
  // Flight lifts the camera onto the ground once the ground there is indexed;
  // only then does the clipmap know how close the ground is.
  for (let end = Date.now() + 60000; Date.now() < end; await wait(500)) {
    p = await probe();
    if (p.motion.aboveGround != null && p.motion.aboveGround < 3 && p.imagery.top > 16) break;
  }
  p = await settle(240000);
  check('a zoom the service lacks is switched off, not hammered', p.imagery.disabled.includes(20) && p.imagery.top === 19,
    `disabled ${JSON.stringify(p.imagery.disabled)}, sharpest now ${p.imagery.top}`);
  check('ground-level imagery streams in', p.imagery.resident > 100,
    `${p.imagery.resident} tiles resident at ${p.motion.aboveGround?.toFixed(1)} m above ground`);
  await snap('ground');

  await send('setting', { id: 'debugMode', value: 4 });
  await wait(1500);
  await snap('ground-levels');
  await send('setting', { id: 'debugMode', value: 0 });

  return results;
}
