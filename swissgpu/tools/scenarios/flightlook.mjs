/* flightlook.mjs — screenshots of a search flight, for judging how its path
 * and the destination's name look: tools/verify.mjs --scenario flightlook --shot out.png
 *
 * From 300 m over the stand-in valley east of Testdorf, facing north (the
 * place is to the west) and looking down a little, a flight there: since
 * Stage 5.6 an S, banked left into the first curve and right into the
 * second, the camera flying down the middle of the path's tube (until 5.5 a
 * glide facing its way). Saved as out-<share>.png at a few shares of the
 * flight's σ (SHARES in the environment takes others), at three quarters
 * render scale, with the GPU time of the path and the name. The first, as it
 * lifts off still facing north, has the place off the screen to the left:
 * the name and the distance stand beside a chip with a chevron at the left
 * edge (Stage 5.7; the chip since 5.8b). Checks only
 * that the path, its beads and the name were drawn, and that the flight
 * arrived.
 */

import { height } from '../mock-data.mjs';

export async function run(page, { shot } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });
  // A frame of the software GPU can outlast the probe's 2 s answer time:
  // then it is simply asked again.
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe()).catch(() => null);
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 300) => {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      const q = await probe();
      if (q) { last = q; if (test(q)) return q; }
      await wait(every);
    }
    return last;
  };
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 180000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);
  await page.evaluate(() => { document.getElementById('readout').hidden = true; });
  await send('setting', { id: 'renderScale', value: 0.75 });
  const lon = 8.9, lat = 46.19;
  await send('camera', { state: { lon, lat, height: height(lon, lat) + 300, yaw: 0, pitch: -0.2, mode: 'fly' } });
  await until((q) => q.physicsGround?.accurate && q.terrain.pending === 0 && q.imagery.loading === 0, 240000);
  await send('flyto', { lon: 8.85, lat: 46.19, elevation: 400, label: 'Testdorf, Ticino' });

  const shares = (process.env.SHARES || '0.02,0.12,0.3,0.5,0.75,0.88').split(',').map(Number);
  const seen = { points: 0, beads: 0, label: '', labelSize: null, alpha: 0 };
  for (const share of shares) {
    const q = await until((r) => !r.flight?.active || r.flight.progress >= share, 1500000, 100);
    if (!q.flight?.active) break;
    if (q.path?.drawn) { seen.points = Math.max(seen.points, q.path.points); seen.beads = Math.max(seen.beads, q.path.beads); }
    if (q.label?.drawn) { seen.label = q.label.text; seen.labelSize = q.label.size; seen.alpha = Math.max(seen.alpha, q.label.alpha); }
    await snap(String(Math.round(share * 100)));
    if (share === shares[0]) {
      const p = q.flight.plan;
      console.log(`  plan: ${p?.word}, ${Math.round(p?.distance)} m (route ${Math.round(p?.length)} m), turns ${p?.turns.map((a) => Math.round(a)).join('° and ')}°, ` +
        `${p?.duration.toFixed(1)} s (x${p?.compress.toFixed(2)}), cruise ${Math.round(p?.cruise)} m`);
    }
    console.log(`  at ${Math.round(100 * q.flight.progress)}% of the way (${q.flight.t.toFixed(1)} of ${q.flight.duration.toFixed(1)} s): ` +
      `${Math.round(q.camera.height - (q.physicsGround?.height ?? 0))} m up, path ${q.path?.drawn ? `${q.path.points} points, ${q.path.beads} beads, ` +
      `opacity ${q.path.alpha.toFixed(2)}` : 'not drawn'}, name ${q.label?.drawn ? `"${q.label.text}" at ${q.label.alpha.toFixed(2)}` : 'not drawn'}` +
      `${q.gpu ? `; GPU ${q.gpu.frame.toFixed(0)} ms a frame, the path ${(q.gpu.passes.path ?? 0).toFixed(1)} ms, the name ${(q.gpu.passes.label ?? 0).toFixed(1)} ms` : ''}`);
  }
  const end = await until((r) => r.flight && !r.flight.active, 1500000, 300);
  check('the path, its beads and the destination\'s name were drawn', seen.points > 1 && seen.beads > 0 && seen.label.startsWith('Testdorf'),
    `${seen.points} points, ${seen.beads} beads; "${seen.label}" (${seen.labelSize?.join(' x ') ?? '–'} px), opacity up to ${seen.alpha.toFixed(2)}`);
  check('the flight arrived', end.flight?.arrived === true, `${end.flight?.elapsed?.toFixed(1)} s flown (planned ${end.flight?.duration?.toFixed(1)} s)`);
  await snap('arrived');
  return results;
}
