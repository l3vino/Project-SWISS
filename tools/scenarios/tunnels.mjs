/* tunnels.mjs — tunnels (Stages 5.17b, 5.17c; 5.17e), for
 * tools/verify.mjs --scenario tunnels [--shot out.png]
 *
 * The stand-in railway (mock-vector.mjs RAIL) runs through a 1.5 km
 * double-track tunnel (metres east 4000 to 5500, layer −1). Checked: one
 * tube is found for both tracks, its two ends portals and its length the
 * tunnel's; each portal's floor is the stand-in ground of its approach (the
 * line through it fitted back to the portal); the tube's mesh is built and
 * drawn, and the terrain tiles its bore reaches go through the cut pipeline;
 * every tube's floor stays under the ground past its mouths (5.17e) and the
 * tube starts where the ground covers it, the railway running on in an open
 * cutting to there (5.17f); looking at the west mouth from outside, the
 * opening shows the tunnel instead of the hillside (Layers → Tunnels off
 * brings the hillside back); from 300 m inside, the walls and the lamps fill the view, no sky;
 * Layers → Tunnels off draws none; inside, the eye adapts to the dark, and
 * back outside to daylight again, at its rates (5.18b). Screenshots go next
 * to --shot.
 */

import { height, TOWN } from '../mock-data.mjs';
import { RAIL } from '../mock-vector.mjs';

const M_LAT = 111132;
const M_LON = 111320 * Math.cos((46.17 * Math.PI) / 180);
const at = (e, n) => ({ lon: TOWN.west + e / M_LON, lat: TOWN.south + n / M_LAT });

export async function run(page, { shot } = {}) {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 500) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const frames = async () => {
    const t0 = (await probe()).simTime;
    return until((q) => q.simTime > t0 + 0.15, 180000, 300);
  };
  const snap = async (suffix) => {
    try { return await page.screenshot({ timeout: 180000, path: shot ? shot.replace(/\.png$/, `-${suffix}.png`) : undefined }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); return null; }
  };
  // The middle of a screenshot (a box `frac` of it each way): mean colour, and how many pixels differ from another's.
  const middle = (png, other = null, frac = 0.3) => page.evaluate(async ([a, b, frac]) => {
    const load = async (data) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height);
    };
    const A = await load(a), B = b ? await load(b) : null;
    const w = A.width, h = A.height, x0 = Math.floor(w * (0.5 - frac / 2)), x1 = Math.floor(w * (0.5 + frac / 2));
    const y0 = Math.floor(h * (0.5 - frac / 2)), y1 = Math.floor(h * (0.5 + frac / 2));
    let r = 0, g = 0, bl = 0, n = 0, changed = 0, bluish = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += A.data[i]; g += A.data[i + 1]; bl += A.data[i + 2]; n++;
      // Sky: brighter and bluer than anything inside a tunnel.
      if (A.data[i + 2] > 150 && A.data[i + 2] > A.data[i] + 15) bluish++;
      if (B && Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 40) changed++;
    }
    return { mean: [r / n, g / n, bl / n].map((v) => Math.round(v)), changed: changed / n, sky: bluish / n, pixels: n };
  }, [png.toString('base64'), other ? other.toString('base64') : null, frac]);

  await page.evaluate(() => { document.getElementById('readout').hidden = true; });
  await send('setting', { id: 'renderScale', value: 0.75 });
  await send('setting', { id: 'flyThrough', value: true });

  /* 1. Outside the west portal, between the tracks, looking in. */
  const n = RAIL.north - RAIL.spacing / 2;
  const westPortal = at(RAIL.tunnel[0], n), eastPortal = at(RAIL.tunnel[1], n);
  const outside = at(RAIL.tunnel[0] - 45, n);
  await send('camera', { state: { lon: outside.lon, lat: outside.lat, height: height(westPortal.lon, westPortal.lat) + 4, yaw: Math.PI / 2, pitch: -0.04, mode: 'fly' } });
  let p = await until((q) => q.tunnels?.tubes?.some((t) => t.family === 2 && t.mesh) && q.terrain.pending === 0, 480000, 1000);
  const tube = p.tunnels?.tubes?.find((t) => t.family === 2 && t.length > 1000);
  check('one tube for both tracks', tube && p.tunnels.tubes.filter((t) => t.family === 2 && t.length > 1000).length === 1 && tube.tracks === 2,
    tube ? `${tube.kind}, ${tube.length} m, ${tube.tracks} tracks; ${p.tunnels.tubes.length} tubes in all` : `none: ${JSON.stringify(p.tunnels)?.slice(0, 300)}`);
  check('both ends portals', tube && tube.ends.every((e) => e.type === 1) && Math.abs(tube.length - (RAIL.tunnel[1] - RAIL.tunnel[0])) < 25,
    tube ? tube.ends.map((e) => `${e.type} at ${e.lon.toFixed(5)},${e.lat.toFixed(5)}`).join(' → ') : '');
  // The road right in front of the portal (5.17d): the stand-in ground over the first 4 m out along the railway
  // (straight on), each taken back to the portal at the rise of the ground to 9 m out (Siegel's repeated median, each
  // point's median slope to the others and the median of those), their median.
  const fitted = (end, dir) => {
    const e0 = (end.lon - TOWN.west) * M_LON, n0 = (end.lat - TOWN.south) * M_LAT;
    const ground = (d) => { const q = at(e0 + dir * d, n0); return height(q.lon, q.lat); };
    const median = (v) => { v.sort((x, y) => x - y); const h = v.length >> 1; return v.length % 2 ? v[h] : 0.5 * (v[h - 1] + v[h]); };
    const ds = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 7, 9], hs = ds.map(ground);
    const each = ds.map((d, i) => median(ds.flatMap((e, j) => (j === i ? [] : [(hs[j] - hs[i]) / (e - d)]))));
    const k = Math.max(-0.3, Math.min(0.3, median(each)));
    return median(ds.slice(0, 8).map((d, i) => hs[i] - k * d));
  };
  const want = tube ? [fitted(tube.ends[0], tube.ends[0].lon < tube.ends[1].lon ? -1 : 1), fitted(tube.ends[1], tube.ends[1].lon > tube.ends[0].lon ? 1 : -1)] : [NaN, NaN];
  check('floor at the portals\' ground', tube?.floor && Math.abs(tube.floor[0] - want[0]) < 0.3 && Math.abs(tube.floor[1] - want[1]) < 0.3,
    tube?.floor ? `${tube.floor.map((h) => h.toFixed(2)).join(' → ')} m (the road in front ${want.map((h) => h.toFixed(2)).join(', ')}; ground at the portals ` +
      `${height(westPortal.lon, westPortal.lat).toFixed(2)}, ${height(eastPortal.lon, eastPortal.lat).toFixed(2)})` : 'no floor');
  check('mesh built and drawn', tube?.mesh && p.tunnels.drawn > 0,
    `${tube?.mesh?.triangles ?? 0} triangles (${((tube?.mesh?.bytes ?? 0) / 1024).toFixed(0)} KB), ${p.tunnels.drawn} drawn, ${p.tunnels.triangles} triangles; section ${JSON.stringify(tube?.section)}`);
  check('terrain opened at the portals', p.tunnels.portals.length >= 2 && p.tunnels.cutTiles > 0,
    `${p.tunnels.portals.length} portals, ${p.tunnels.cutTiles} terrain tiles drawn cut (${p.tunnels.cuts.segments} bore segments)`);
  // 5.17e: every tube starts at its mapped portal (where the road does), and its floor goes under the ground where
  // the ground asks (fit.js underGround): the stand-in's ground sags up to 8 m under the line between its portals
  // (the egg-crate's valley), so its floor dips, as far as its grade (4%) lets it from each portal; what of it that
  // leaves out of the ground is said.
  const fits = p.tunnels.tubes.filter((t) => t.fit), shifted = fits.filter((t) => t.fit.some((f) => f && f.collar !== 0));
  check('tubes from their portals, under the ground', tube?.fit && !shifted.length && tube.dipped > 1,
    `${fits.length} tubes fitted, ${shifted.length} not starting at their portals; the tunnel's floor dipped ${(tube?.dipped ?? 0).toFixed(2)} m ` +
    `under the line between its portals, ${(tube?.out ?? 0).toFixed(0)} m of it out of the ground within reach of its portals at its grade; ` +
    `its portals: ${(tube?.fit ?? []).map((f) => f && `face ${f.face} m, collar ${f.collar.toFixed(1)} m, concrete ${f.shell.toFixed(1)} m, the tube from ${(f.start ?? 0).toFixed(1)} m in (5.17f: where the ground covers it)`).join('; ')}`);

  /* 2. The opening from outside: the tunnel, not the hillside. Since 5.17f the tube starts where the ground covers
   * it, the railway running on to there in an open cutting (on the stand-in's egg-crate, where the ground leaves its
   * vault uncovered for its first 120 m, that far in): its mouth from 45 m in front of it, 10 m over the floor
   * there, looking at it. */
  const start0 = tube?.fit?.[0]?.start ?? 0;
  if (start0 > 1 && tube?.profile?.length) {
    const floorAt = (s) => {
      const f = tube.profile;
      let k = 0;
      while (k + 2 < f.length && f[k + 1][0] < s) k++;
      const [s0, h0] = f[k], [s1, h1] = f[Math.min(f.length - 1, k + 1)];
      return s1 > s0 ? h0 + ((h1 - h0) * Math.min(1, Math.max(0, (s - s0) / (s1 - s0)))) : h0;
    };
    const sc = start0 - 45, eye = floorAt(Math.max(0, sc)) + 10, mouth = at(RAIL.tunnel[0] + sc, n);
    await send('camera', { state: { lon: mouth.lon, lat: mouth.lat, height: eye, yaw: Math.PI / 2, pitch: Math.atan2(floorAt(start0) + 3 - eye, 45), mode: 'fly' } });
    await wait(1500);
    p = await until((q) => q.terrain.pending === 0, 240000, 1000);
  }
  await frames();
  const open = await snap('outside');
  await send('setting', { id: 'layerTunnels', value: false });
  p = await until((q) => q.tunnels.drawn === 0, 60000);
  await frames();
  const shut = await snap('outside-off');
  if (open && shut) {
    const m = await middle(open, shut, 0.4);
    check('the portal shows the tunnel', m.changed > 0.03,
      `${(m.changed * 100).toFixed(0)}% of the middle changes with Layers → Tunnels (mean ${m.mean.join(', ')})` +
      (start0 > 1 ? `; its mouth ${start0.toFixed(1)} m in, seen from 45 m in front of it` : ''));
  } else {
    check('the portal shows the tunnel', false, 'no screenshots');
  }
  check('Layers → Tunnels off draws none', p.tunnels.drawn === 0 && p.tunnels.cutTiles === 0,
    `${p.tunnels.drawn} drawn, ${p.tunnels.cutTiles} cut tiles`);

  /* 3. 300 m inside (or 180 m past its mouth, if that is further in), looking along: walls and lamps, no sky. */
  await send('setting', { id: 'layerTunnels', value: true });
  p = await until((q) => q.tunnels.tubes?.some((t) => t.family === 2 && t.mesh), 300000, 1000);
  const sIn = Math.min((RAIL.tunnel[1] - RAIL.tunnel[0]) - 100, Math.max(300, start0 + 180));
  const inside = at(RAIL.tunnel[0] + sIn, n);
  const floor = p.tunnels.tubes.find((t) => t.family === 2 && t.length > 1000)?.floor ?? [height(westPortal.lon, westPortal.lat), 0];
  // The floor there (kept under the ground, 5.17e: not the line between the portals), from the probe's profile.
  const prof = p.tunnels.tubes.find((t) => t.family === 2 && t.mesh)?.profile ?? [[0, floor[0]], [RAIL.tunnel[1] - RAIL.tunnel[0], floor[1]]];
  const k = Math.max(0, prof.findIndex((q) => q[0] >= sIn) - 1), qa = prof[k], qb = prof[Math.min(prof.length - 1, k + 1)];
  const along = qa[1] + ((qb[1] - qa[1]) * (sIn - qa[0])) / Math.max(1e-6, qb[0] - qa[0]);
  await send('camera', { state: { lon: inside.lon, lat: inside.lat, height: along + 2.5, yaw: Math.PI / 2, pitch: 0, mode: 'fly' } });
  p = await until((q) => q.tunnels.tubes?.some((t) => t.mesh?.inside), 120000, 500);
  const tin = p.tunnels.tubes.find((t) => t.mesh?.inside);
  check('inside the tube', tin, (tin ? `in the ${tin.kind} tube, ${p.tunnels.drawn} drawn` : 'not inside any') + ` (${sIn.toFixed(0)} m in)`);
  // 5.18b: the eye adapts to the tunnel's dark (tunnels.js EYE, render.js adaptEye): towards the light at the eye (16
  // times at most), at 1.2 stops a second of the simulation's time (this rig draws a frame in seconds: checked by the
  // rate over what time went by, or done).
  const stops = (g) => Math.log2(g);
  const adapting = (g0, t0, q, toward, rate) => {
    const left = toward - stops(g0), want = Math.sign(left) * Math.min(Math.abs(left), rate * (q.simTime - t0));
    return { got: stops(q.tunnels.eye.gain) - stops(g0), want };
  };
  const g0 = p.tunnels.eye?.gain, t0 = p.simTime;
  p = await until((q) => q.tunnels.eye?.gain > 12 || q.simTime - t0 > 2, 240000, 500);
  const dark = adapting(g0, t0, p, stops(Math.min(16, 1 / p.tunnels.eye.light)), 1.2);
  check('the eye adapts to the dark', dark.want > 0.5 && Math.abs(dark.got - dark.want) < 0.25,
    `gain ${g0?.toFixed(2)} → ${p.tunnels.eye?.gain?.toFixed(1)} in ${(p.simTime - t0).toFixed(1)} s: ${dark.got.toFixed(2)} stops (${dark.want.toFixed(2)} at 1.2 a second); ` +
    `the light at the eye ${p.tunnels.eye?.light?.toFixed(3)} of daylight's`);
  await frames();
  const in1 = await snap('inside');
  if (in1) {
    const m = await middle(in1, null, 0.9);
    check('walls, not sky', m.sky < 0.02 && m.mean.some((v) => v > 6),
      `${(m.sky * 100).toFixed(1)}% sky-blue, mean ${m.mean.join(', ')} over ${m.pixels} pixels`);
  } else {
    check('walls, not sky', false, 'no screenshot');
  }
  // Back out in daylight: the eye back to it, quicker than it went.
  await send('camera', { state: { lon: outside.lon, lat: outside.lat, height: height(westPortal.lon, westPortal.lat) + 4, yaw: Math.PI / 2, pitch: -0.04, mode: 'fly' } });
  // (From the first frame out in daylight: the move takes a frame or two to arrive.)
  const q1 = await until((q) => q.tunnels.eye?.light === 1, 60000, 200), g1 = q1.tunnels.eye?.gain, t1 = q1.simTime;
  p = await until((q) => q.tunnels.eye?.gain < 1.05 || q.simTime - t1 > 1, 120000, 300);
  const light = adapting(g1, t1, p, 0, 3);
  check('back in daylight, the eye with it', p.tunnels.eye?.light === 1 && light.want < -0.5 && Math.abs(light.got - light.want) < 0.25,
    `gain ${g1?.toFixed(1)} → ${p.tunnels.eye?.gain?.toFixed(2)} in ${(p.simTime - t1).toFixed(1)} s: ${light.got.toFixed(2)} stops (${light.want.toFixed(2)} at 3 a second)`);
  return results;
}
