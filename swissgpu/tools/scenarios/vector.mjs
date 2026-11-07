/* vector.mjs — roads and rails from the vector tiles, for
 * tools/verify.mjs --scenario vector [--shot out.png]
 *
 * The stand-in tiles (mock-vector.mjs) carry a street grid, a tram, a
 * railway with a tunnel and a bridge, and a motorway round the stand-in
 * town. Checked: nothing is loaded from high up; over the town both zooms
 * load, only zooms 13 and 14 are asked for, tiles served gzipped without
 * saying so decode like the others, every tile lands in the page tables,
 * memory stays within its setting; the data view (Diagnostics → Roads and
 * rails) draws the lines on the ground in their kinds' colours, which shows
 * the whole path from the tile to the pixel works (page tables, the pool,
 * cells, references, segments); a smaller memory setting makes a new buffer
 * and the tiles come back; a shorter road distance asks for less; and going
 * up again lets them go unwanted. Screenshots go next to --shot.
 *
 * Roads on the ground (5.15b): each road's own width comes from the stand-in
 * identify service and matches nearly every segment; the terrain under the
 * streets is cut (the stand-in town lies on slopes), so where a street runs
 * across a slope, physics stands on level ground across it. Since 5.16b the
 * photo is the road where it shows one: over a street the stand-in photo
 * paints grey (mock-data.mjs ASPHALT), Layers → Roads leaves its colours as
 * they are (a grain, no painted band); where it shows tree crowns over a
 * street (CANOPY) and over the stand-in bridge's deck, the made surface
 * shows (Layers → Roads off changes those pixels). And the road comes off
 * the stand-in bridge at its deck's height.
 */

import { height, TOWN, townGrid, ASPHALT, CANOPY } from '../mock-data.mjs';
import { RAIL, TRAM_STREET } from '../mock-vector.mjs';
import { BRIDGE } from '../mock-buildings.mjs';

const M_LAT = 111132;
const M_LON = 111320 * Math.cos((46.17 * Math.PI) / 180);
const at = (e, n) => ({ lon: TOWN.west + e / M_LON, lat: TOWN.south + n / M_LAT });

export async function run(page, { shot, counts } = {}) {
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
  const wanted = (q) => q.vector.levels.reduce((n, l) => n + l.wanted, 0);
  // A few frames of the app's own clock: on a software GPU one frame can
  // take seconds, and a setting only shows once a frame has run with it.
  const frames = async () => {
    const t0 = (await probe()).simTime;
    return until((q) => q.simTime > t0 + 0.15, 180000, 300);
  };
  const calm = (q) => q.vector.loading === 0 && q.vector.ready > 0 && q.terrain.pending === 0;
  // Screenshots, and how many pixels of them are near some colours.
  const snap = async (suffix) => {
    let png = null;
    try { png = await page.screenshot({ timeout: 180000, path: shot ? shot.replace(/\.png$/, `-${suffix}.png`) : undefined }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
    return png;
  };
  const colours = (png, targets) => page.evaluate(async ([data, targets]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, img.width, img.height).data;
    const out = Object.fromEntries(Object.keys(targets).map((k) => [k, 0]));
    for (let i = 0; i < px.length; i += 4) {
      for (const [k, [r, gg, b]] of Object.entries(targets)) {
        if (Math.abs(px[i] - r) + Math.abs(px[i + 1] - gg) + Math.abs(px[i + 2] - b) < 70) out[k]++;
      }
    }
    return out;
  }, [png.toString('base64'), targets]);
  // The kinds' colours (swisstopo-transport.js), as the data view draws them.
  const KIND = { minor: [64, 224, 255], tram: [176, 128, 255], rail: [255, 255, 48] };
  const place = async (e, n, up, yaw, pitch) => {
    const p = at(e, n);
    await send('camera', { state: { lon: p.lon, lat: p.lat, height: height(p.lon, p.lat) + up, yaw, pitch, mode: 'fly' } });
  };

  await page.evaluate(() => { document.getElementById('readout').hidden = true; });
  await send('setting', { id: 'renderScale', value: 0.75 });

  /* 1. The start, kilometres up: no road is worth loading. */
  let p = await until((q) => q.terrain.pending === 0, 60000);
  check('none from high up', p.vector.source && wanted(p) === 0 && p.vector.ready === 0,
    `${p.vector.source}: ${wanted(p)} wanted, ${p.vector.ready} loaded at ${Math.round(p.motion.aboveGround ?? p.camera.height)} m above the ground`);

  /* 2. 150 m over the town where the tram street crosses the main street. */
  await place(1500, TRAM_STREET * 60, 150, 0, -1.25);
  p = await until(calm, 240000);
  const [detail, overview] = p.vector.levels;
  check('both zooms load', detail.ready > 0 && overview.ready > 0,
    `z${detail.z}: ${detail.ready} of ${detail.wanted} wanted, z${overview.z}: ${overview.ready} of ${overview.wanted}; ` +
    `${p.vector.segments} segments, decode ${p.vector.decodeMs.toFixed(1)} ms a tile`);
  const levels = Object.keys(counts.vectorByLevel).map(Number);
  check('only zooms 13 and 14 asked for', levels.length > 0 && levels.every((z) => z === 13 || z === 14),
    `requests by zoom ${JSON.stringify(counts.vectorByLevel)}`);
  check('gzipped tiles decode', counts.vectorGzipped > 0 && p.vector.missing === 0,
    `${counts.vectorGzipped} of ${counts.vector} served gzipped without saying so, ${p.vector.missing} given up`);
  const marked = p.vector.pages.map((l) => (l.pages.match(/[#o]/g) || []).length);
  check('every tile in the page tables', marked[0] === detail.ready && marked[1] === overview.ready,
    p.vector.pages.map((l) => `z${l.z} at ${l.origin}: ${l.pages}`).join(' · '));
  check('memory within its setting', p.vector.bytes > 0 && p.vector.bytes <= p.vector.budget,
    `${(p.vector.bytes / 1048576).toFixed(1)} of ${(p.vector.budget / 1048576).toFixed(0)} MB in ${p.vector.blocks} blocks`);

  /* 2b. Each road's own width, from the stand-in identify service. */
  p = await until((q) => q.vector.widths.tiles > 0 && q.vector.widths.jobs === 0 && q.vector.widths.waiting === 0, 240000);
  const w = p.vector.widths;
  check('each road its own width', w.tiles > 0 && counts.identify > 0 && w.matched > 0.9 * w.asked && w.failed === 0,
    `${w.tiles} tiles, ${counts.identify} identify calls, ${w.matched} of ${w.asked} segments matched, ${w.failed} failed`);

  /* 2c. The terrain cut under the streets: the north-south street whose
   * ground slopes most across it, stood on at its middle and 2 m either side. */
  p = await until((q) => q.terrain.shaping.tiles > 0 && q.terrain.reshapes === 0 && q.terrain.pending === 0, 240000);
  const sh = p.terrain.shaping;
  check('roads cut into the terrain', sh.tiles > 0 && sh.used > 0,
    `${sh.tiles} tiles cut (${sh.reshaped} again), ${sh.used} of ${sh.pieces} pieces, +${sh.addedTriangles} triangles, ${sh.ms.toFixed(1)} ms a tile, from level ${p.terrain.shapeLevel}`);
  const { cols, rows } = townGrid();
  let best = null;
  for (let i = 2; i < Math.min(cols, 40); i++) {
    if (i % 3 === 1 || i % 10 === 0 || i === Math.floor(cols / 2)) continue;   // the 4 m class's minor streets
    for (let j = 18; j < Math.min(rows, 26); j++) {
      const e = i * 60, n = j * 60 + 30;
      const a = at(e - 2, n), b = at(e + 2, n);
      const tilt = Math.abs(height(b.lon, b.lat) - height(a.lon, a.lat)) / 4;
      if (!best || tilt > best.tilt) best = { e, n, tilt };
    }
  }
  const groundAt = async (de) => {
    const q = at(best.e + de, best.n);
    await send('camera', { state: { lon: q.lon, lat: q.lat, height: height(q.lon, q.lat) + 2, yaw: 0, pitch: -0.2, mode: 'fly' } });
    const r = await until((x) => x.physicsGround?.accurate && Math.abs(x.camera.lon - q.lon) < 1e-9 && x.groundLevel >= x.terrain.shapeLevel &&
      x.terrain.reshapes === 0 && x.terrain.pending === 0, 120000, 400);
    return r.physicsGround?.height;
  };
  const hW = await groundAt(-2), hM = await groundAt(0), hE = await groundAt(2);
  const across = Math.abs(hE - hW) / 4;
  check('level across a street on a slope', best.tilt > 0.08 && across < 0.03,
    `street ${(best.e / 60).toFixed(0)} at ${best.n} m north: the ground ${(best.tilt * 100).toFixed(0)}% across, physics stands on ${(across * 100).toFixed(1)}% ` +
    `(${hW?.toFixed(2)} / ${hM?.toFixed(2)} / ${hE?.toFixed(2)} m)`);

  /* 2d. The roads from the photo: from 25 m over a street, Layers → Roads
   * on and off. Two screenshots compared: pixels changed (by more than 30
   * of 765 summed over the channels), changed a lot (90), and how far the
   * mean colour moved (per channel, of 255). */
  const compare = (pa, pb) => page.evaluate(async ([a, b]) => {
    const load = async (d) => { const img = new Image(); img.src = `data:image/png;base64,${d}`; await img.decode(); const c = new OffscreenCanvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
    const x = await load(a), y = await load(b);
    let changed = 0, strong = 0;
    const mean = [0, 0, 0];
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
      if (d > 30) changed++;
      if (d > 90) strong++;
      for (let k = 0; k < 3; k++) mean[k] += x[i + k] - y[i + k];
    }
    const total = x.length / 4;
    return { changed, strong, total, shift: (Math.abs(mean[0]) + Math.abs(mean[1]) + Math.abs(mean[2])) / (3 * total) };
  }, [pa.toString('base64'), pb.toString('base64')]);
  // And what they cost the terrain pass, on this software GPU (only the
  // ratio means anything: SwiftShader is not a graphics card).
  // The pass times are running means: timing is switched off and on (which
  // forgets them) and measured afresh over a few frames.
  const terrainGpu = async () => {
    await send('setting', { id: 'gpuTiming', value: false });
    await send('setting', { id: 'gpuTiming', value: true });
    for (let i = 0; i < 6; i++) await frames();
    return (await probe()).gpu?.passes?.terrain ?? NaN;
  };
  const roadsOnOff = async (e, n, name) => {
    await place(e, n, 25, 0, -1.3);
    await until(calm, 120000);
    await frames();
    const on = await snap(name);
    const gpuOn = await terrainGpu();
    await send('setting', { id: 'layerRoads', value: false });
    await send('setting', { id: 'layerPaths', value: false });
    await frames();
    const off = await snap(`${name}-bare`);
    const gpuOff = await terrainGpu();
    await send('setting', { id: 'layerRoads', value: true });
    await send('setting', { id: 'layerPaths', value: true });
    return on && off ? { ...(await compare(on, off)), gpuOn, gpuOff } : null;
  };
  const plainStreet = await roadsOnOff(ASPHALT.e, ASPHALT.n, 'roads');
  if (plainStreet) {
    const r = plainStreet;
    check('roads show the photo', r.shift < 3 && r.strong < 0.01 * r.total,
      `over a street the photo shows: mean colour moved ${r.shift.toFixed(2)} of 255, ${r.strong} pixels changed a lot, ` +
      `${r.changed} a little (the grain); terrain pass ${r.gpuOn.toFixed(1)} ms with roads, ${r.gpuOff.toFixed(1)} ms without (software GPU)`);
  }
  const underTrees = await roadsOnOff(CANOPY.e, (CANOPY.from + CANOPY.to) / 2, 'canopy');
  if (underTrees) {
    check('roads under trees are drawn', underTrees.changed > 2000,
      `${underTrees.changed} pixels change with Layers → Roads where the photo shows tree crowns over the street`);
  }

  /* 2e. And on the bridge's deck (the structures layer). */
  const bn = (BRIDGE.start.lat - TOWN.south) * M_LAT, be = (BRIDGE.start.lon - TOWN.west) * M_LON + BRIDGE.length / 2;
  const deck = at(be, bn);
  await send('camera', { state: { lon: deck.lon, lat: deck.lat, height: BRIDGE.top + 40, yaw: 0, pitch: -1.4, mode: 'fly' } });
  await until(calm, 120000);
  await frames();
  const deckRoads = await snap('deck');
  await send('setting', { id: 'layerRoads', value: false });
  await frames();
  const deckBare = await snap('deck-bare');
  await send('setting', { id: 'layerRoads', value: true });
  if (deckRoads && deckBare) {
    const n = (await compare(deckRoads, deckBare)).changed;
    check('roads drawn on a bridge deck', n > 500, `${n} pixels change with Layers → Roads over the bridge (tree crowns in its photo)`);
  }

  /* 2f. The road comes off the bridge at the deck's height (bridges.js,
   * shape.c's pins): the stand-in deck starts 0.3 m into the slope, under a
   * hill the road would otherwise climb; a metre before the joint, physics
   * stands on the road at the deck's top less the pin's 5 cm. At its far
   * end the deck stops 86 m over the ground, where the road goes on below:
   * too far off to meet, and that road is left on its ground. */
  {
    const west = (BRIDGE.start.lon - TOWN.west) * M_LON, eastEnd = west + BRIDGE.length;
    const stand = async (e) => {
      const p = at(e, bn);
      await send('camera', { state: { lon: p.lon, lat: p.lat, height: height(p.lon, p.lat) + 3, yaw: Math.PI / 2, pitch: -0.3, mode: 'fly' } });
      return until((q) => calm(q) && q.terrain.reshapes === 0 && q.physicsGround?.accurate && q.vector.bridges?.waiting === 0, 120000);
    };
    const q1 = await stand(west - 1);
    const joint = q1.physicsGround?.height, want = BRIDGE.top - 0.05;
    const q2 = await stand(eastEnd + 12);
    const below = q2.physicsGround?.height, ground = height(at(eastEnd + 12, bn).lon, at(eastEnd + 12, bn).lat);
    const b = q2.vector.bridges || {};
    check('roads come off bridges at the deck', b.pins > 0 && Math.abs(joint - want) < 0.1 && Math.abs(below - ground) < 3,
      `${b.pins} road ends pinned to decks on ${b.tiles} tiles; a metre before the deck the road is at ${joint?.toFixed(2)} m, the deck's top ` +
      `${BRIDGE.top.toFixed(2)} m; past the far end, 86 m up, the road below at ${below?.toFixed(2)} m on ground at ${ground.toFixed(2)} m`);
  }

  /* 3. The data view draws them: over the tram's street again. */
  await place(1500, TRAM_STREET * 60, 150, 0, -1.25);
  await until(calm, 120000);
  await frames();
  const plain = await snap('photo');
  await send('setting', { id: 'debugMode', value: 6 });
  await frames();
  const data = await snap('data');
  if (plain && data) {
    const before = await colours(plain, KIND), after = await colours(data, KIND);
    check('the data view draws streets and the tram', after.minor > 2000 && after.tram > 200 && after.minor > 20 * (before.minor + 1),
      `pixels in the streets' colour ${before.minor} → ${after.minor}, the tram's ${before.tram} → ${after.tram}`);
  }

  /* 4. Over the railway's tunnel portal: the tracks, dashed inside. */
  await place(RAIL.tunnel[0] - 40, RAIL.north - 2, 90, Math.PI / 2, -1.0);
  p = await until(calm, 240000);
  const rails = await snap('rail');
  if (rails) {
    const c = await colours(rails, KIND);
    check('the data view draws the railway', c.rail > 300, `${c.rail} pixels in the railway's colour`);
  }
  await send('setting', { id: 'debugMode', value: 0 });

  /* 5. Less memory: a new buffer, the tiles come back into it. */
  const readyBefore = p.vector.ready;
  await send('setting', { id: 'roadMemory', value: 32 });
  p = await until((q) => q.vector.budget === 32 * 1048576 && calm(q), 120000);
  check('a new memory setting refills', p.vector.budget === 32 * 1048576 && p.vector.ready >= Math.min(readyBefore, 1),
    `${p.vector.ready} tiles in ${(p.vector.budget / 1048576).toFixed(0)} MB (were ${readyBefore}), ${p.vector.evicted} dropped`);

  /* 6. A shorter road distance wants fewer overview tiles. */
  const wideWanted = p.vector.levels[1].wanted;
  await send('setting', { id: 'roadDistanceKm', value: 0.5 });
  await until((q) => q.vector.distance === 500, 20000);
  p = await frames();
  check('a shorter distance asks for less', p.vector.levels[1].wanted < wideWanted && p.vector.levels[1].wanted >= 1,
    `overview tiles wanted at 3 km: ${wideWanted}, at 0.5 km: ${p.vector.levels[1].wanted}`);
  await send('setting', { id: 'roadDistanceKm', value: 3 });
  await send('setting', { id: 'roadMemory', value: 64 });

  /* 7. Up again: nothing is wanted; what is loaded stays until room is needed. */
  p = await until(calm, 120000);
  const loaded = p.vector.ready;
  await place(1500, 1200, 9000, 0, -0.5);
  p = await until((q) => wanted(q) === 0, 60000);
  check('let go from high up', wanted(p) === 0 && p.vector.ready === loaded,
    `${wanted(p)} wanted, ${p.vector.ready} of ${loaded} still loaded at 9 km`);
  return results;
}
