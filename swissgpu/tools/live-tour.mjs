/* live-tour.mjs — the real app against the live swisstopo services.
 *
 *   xvfb-run -a node tools/live-tour.mjs [--seconds 90] [--terrain-mb 48] [--building-mb 48]
 *                                        [--root <app folder>] [--scale 0.2] [--threads N]
 *                                        [--flights "lon,lat;lon,lat"] [--walk]
 *                                        [--search "Lugano;Zermatt"] [--scope national|global]
 *                                        [--plane] [--plane-low <metres>]
 *                                        [--retarget "lon,lat@seconds"] [--shot out.png]
 *
 * Never loaded by the app, and it needs the network. Serves the app locally,
 * starts it at Bellinzona with the given memory budgets, flies forward at
 * 150 m/s turning with mouse-look messages at 250 Hz, and every ten seconds
 * prints the render thread's cost per section (mean / 95th / worst, ms), what
 * is drawn and loaded, and memory against budget; then the requests per host
 * and any warnings. `--root` points it at another copy of the app, to compare
 * two versions on the same flight. `--threads` sets the decode threads (a
 * desktop's eight, say: more jobs out at once, preloading with the spare
 * slots); `--flights` first flies to each place as a search pick does, with
 * its preloading, real network latency and all, and reports each arrival;
 * with `--walk` the camera starts walking, so each flight lands on the ground
 * beside the place and the buildings there get collision copies. `--search`
 * does what a person does: types each text into the search box, waits for
 * the suggestions from the real search services and clicks the first.
 * `--plane` flies the airplane (P) instead of the camera: from 1,200 m over
 * the Magadino plain towards the lake, about 375 km/h more asked with a quick
 * run of twelve wheel notches, a pull into a 20° climb to 3,500 m, levelled
 * off, then a tap to the right every 15 s (the wings level themselves), and
 * it reports the jet each ten seconds with the rest; a crash is reported,
 * and ends it. With
 * `--plane-low`, it starts that many metres over Bellinzona's floor and
 * flies on level with nothing pressed (pulling only under 100 m), so its
 * collision focus, 4 s ahead (Stage 5.11b), loads round the town: the
 * focus's radius is reported with the rest. `--retarget` picks another
 * place that many seconds into the first flight (Stage 5.12b: it arrives as
 * the first would have, going on from the speed it had): the speed just
 * before and after the pick, and how the clock and the blend went on, are
 * reported with that flight. `--shot` saves a screenshot (out-0.png, ...) a
 * few seconds after each arrival, and reports whether the camera ended clear
 * of the buildings there.
 * Behind a proxy, HTTPS_PROXY is passed on to the browser. On a software GPU
 * the frame rate is the rasterizer's; the CPU sections are what to compare.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url));
const SECONDS = Number(args.seconds || 90);
const TMB = Number(args['terrain-mb'] || 48), BMB = Number(args['building-mb'] || 48);
const SCALE = Number(args.scale || 0.2);
const THREADS = Number(args.threads || 0);
const FLIGHTS = (args.flights || '').split(';').filter(Boolean).map((p) => p.split(',').map(Number));
const WALK = process.argv.includes('--walk');
const SEARCHES = (args.search || '').split(';').filter(Boolean);
const SCOPE = args.scope || '';
const PLANE = process.argv.includes('--plane');
const PLANE_LOW = args['plane-low'] != null ? Number(args['plane-low']) : null;
const SHOT = args.shot || null;
const RETARGET = args.retarget ?(([place, at]) => ({ place: place.split(',').map(Number), at: Number(at) }))(args.retarget.split('@')) : null;
let retargeted = null;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ||
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.wgsl': 'text/plain', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try { const body = await readFile(join(ROOT, path || 'index.html')); res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface',
  ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : [])] });
const context = await browser.newContext({ viewport: { width: 960, height: 600 }, ignoreHTTPSErrors: true });
const hosts = new Map();
context.on('request', (r) => { try { const h = new URL(r.url()).host; hosts.set(h, (hosts.get(h) || 0) + 1); } catch {} });
await context.addInitScript(([s, c]) => {
  localStorage.setItem('swissgpu.settings.v2', s);
  localStorage.setItem('swissgpu.session.v1', JSON.stringify({ camera: JSON.parse(c) }));
}, [JSON.stringify({ renderScale: SCALE, terrainMemory: TMB, buildingMemory: BMB, buildingDetailKm: 1.5, decodeThreads: THREADS }),
    JSON.stringify({ lon: 9.0249, lat: 46.1907, height: WALK ? 260 : 600, yaw: 0.9, pitch: -0.15, mode: WALK ? 'walk' : 'fly' })]);
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${origin}/index.html`);
const probe = () => page.evaluate(() => globalThis.swissgpu?.probe()).catch(() => null);
/* The camera's speed since the last probe that asked (metres a second of simulated time). */
let speedFrom = null;
const speedOf = (q) => {
  const at = { lon: q.camera.lon, lat: q.camera.lat, h: q.camera.height, t: q.simTime };
  const from = speedFrom;
  speedFrom = at;
  if (!from || !(at.t > from.t)) return null;
  const n = (at.lat - from.lat) * 111195, e = (at.lon - from.lon) * 111195 * Math.cos(at.lat * Math.PI / 180);
  return Math.hypot(e, n, at.h - from.h) / (at.t - from.t);
};
const wait = (ms) => page.waitForTimeout(ms);
for (let i = 0; i < 120; i++) { const q = await probe(); if (q && q.terrain.drawn > 0) break; await wait(500); }
await wait(15000);
const trips = [...FLIGHTS.map((f) => ({ flight: f })), ...SEARCHES.map((text) => ({ text }))];
if (SCOPE) await page.click(`.scope[data-scope="${SCOPE}"]`).catch(() => {});
for (const trip of trips) {
  const start = Date.now();
  const [lon, lat] = trip.flight ?? [NaN, NaN];
  if (trip.text) {
    await page.fill('#search-input', '');
    await page.click('#search-input');
    await page.keyboard.type(trip.text, { delay: 40 });
    const shown = await page.waitForSelector('.search__result', { timeout: 20000 }).then(() => true, () => false);
    if (!shown) { console.log(`search "${trip.text}": no suggestions within 20 s`); continue; }
    const label = await page.textContent('.search__result').catch(() => '?');
    await page.click('.search__result');
    console.log(`search "${trip.text}": clicked "${String(label).trim().replace(/\s+/g, ' ').slice(0, 80)}"`);
  } else {
    await page.evaluate(([x, y]) => globalThis.swissgpu.send('flyto', { lon: x, lat: y, label: 'live flight' }), [lon, lat]);
  }
  // Watched four times a second: the plan, the slowest planning, how close
  // to the exact ground, the phases, how ready the place was as the flight
  // arrived (it never waits for it: 5.10b), and the frames (late ones, the
  // slowest work).
  let q = null, plan = null, slowest = 0, lowest = Infinity, peak = -Infinity, ready = null;
  let late = 0, work99 = 0, workMax = 0, frame99 = 0, frames = 0;
  const peaks = {};   // each section's slowest frame in flight, ms
  const phases = new Set();
  const started = await probe();
  // Up to ten minutes of wall time: a calm flight of half a minute takes
  // a few minutes on a software GPU.
  // A frame of the software GPU can outlast the probe's 2 s answer time:
  // asked again, up to ten times in a row.
  let misses = 0, last = null;
  for (let i = 0; i < 2400; i++) {
    await wait(250);
    q = await probe();
    if (!q) {
      if (++misses > 10) break;
      q = last;
      continue;
    }
    misses = 0;
    last = q;
    if (RETARGET && !retargeted) speedOf(q);
    const f = q?.flight;
    // Another place picked mid-flight (--retarget): the speed just before and after, from the probes' positions.
    if (RETARGET && !retargeted && f?.active && f.phase === 'flight' && f.t >= RETARGET.at) {
      retargeted = { at: f.t, before: speedOf(q), from: { ...q.camera }, sim: q.simTime, after: null, carried: null };
      await page.evaluate(([x, y]) => globalThis.swissgpu.send('flyto', { lon: x, lat: y, label: 'picked again' }), RETARGET.place);
    } else if (retargeted && retargeted.after == null && f?.active && q.simTime > retargeted.sim + 0.05) {
      retargeted.after = speedOf(q);
      retargeted.carried = f.carried;
    }
    if (f) {
      phases.add(f.phase);
      if (f.plan) plan = f.plan;
      slowest = Math.max(slowest, f.planMs ?? 0);
      if (f.active && f.phase === 'flight') ready = f.ready;
      // Each probe's report covers the last five seconds: the worst of them.
      if (f.active && q.profile) {
        late = Math.max(late, q.profile.late);
        work99 = Math.max(work99, q.profile.work99);
        workMax = Math.max(workMax, q.profile.workMax);
        frame99 = Math.max(frame99, q.profile.frame99);
        frames = Math.max(frames, q.profile.frames);
        for (const [name, ms] of Object.entries(q.profile.peaks ?? {})) peaks[name] = Math.max(peaks[name] ?? 0, ms);
      }
      if (f.active && q.physicsGround?.accurate) {
        lowest = Math.min(lowest, q.camera.height - q.physicsGround.height);
        peak = Math.max(peak, q.camera.height - q.physicsGround.height);
      }
    }
    if ((f && !f.active && f.arrived) || logs.some((l) => /pageerror|Rendering stopped|\[render\]/.test(l))) break;
  }
  if (WALK) for (let i = 0; i < 60 && q && !(q.flight?.landed && q.camera.mode === 'walk'); i++) { await wait(1000); q = await probe(); }
  // Where it ended against the buildings there (Stage 5.12b): the physics'
  // own verdict a moment after the arrival, what the arrival watch did, and
  // a screenshot with `--shot`.
  if (SHOT) {
    await wait(5000);
    const after = await probe();
    const s = after?.solid;
    console.log(`  ended: ${after?.motion?.mode} ${after?.motion?.state}, clear of buildings ${s?.clear}, ` +
      `on a roof or deck ${s?.onStructure}, moved ${s?.clearedBy?.toFixed?.(2) ?? '–'} m clear after landing, the watch ${JSON.stringify(s?.watch)}, ` +
      `${s?.tiles ?? '?'} collision tiles (${s?.triangles ?? '?'} triangles) round it, eye ${(after?.camera?.height - (after?.physicsGround?.height ?? NaN)).toFixed(2)} m over the ground; ` +
      // What the landing spot search had round the place (Stage 5.13b: 5.12b's could miss a house you stood beside).
      `the landing search had ${after?.flight?.search?.triangles ?? '?'} triangles in ${after?.flight?.search?.tiles ?? '?'} tiles`);
    const file = SHOT.replace(/\.png$/, `-${trips.indexOf(trip)}.png`);
    await page.screenshot({ path: file, timeout: 120000 }).then(() => console.log(`  screenshot ${file}`), (e) => console.log(`  screenshot failed: ${e.message.split('\n')[0]}`));
  }
  const f = q?.flight, ground0 = started?.physicsGround?.height ?? started?.camera.height;
  console.log(`flight to ${trip.text ?? `${lon},${lat}`}: ${f?.arrived ? 'arrived' : 'not arrived'}${WALK ? (f?.landed ? ', landed walking' : ', not landed') : ''} ` +
    `after ${((Date.now() - start) / 1000).toFixed(0)} s; collision read-backs ${q?.buildings?.readbacks ?? '?'}; ` +
    `photos prepared ahead ${q?.imagery?.prefetched ?? '?'} (${q?.imagery?.fromStaged ?? '?'} used); ` +
    `jobs ${q?.requests?.active}/${q?.requests?.capacity} on ${q?.requests?.threads} threads, ` +
    `stale ${q?.requests?.stale}, cancelled ${q?.requests?.cancelled}; ${logs.length} warnings/errors so far`);
  if (plan) {
    console.log(`  plan ${plan.word}, ${Math.round(plan.distance)} m (route ${Math.round(plan.length)} m), turns ${plan.turns.map((a) => Math.round(a)).join('° and ')}°, ` +
      `cruise ${Math.round(plan.cruise)} m (${Math.round(plan.cruise - ground0)} m over the start's ground), ${plan.duration.toFixed(1)} s ` +
      `(x${plan.compress.toFixed(2)} of ${plan.natural.toFixed(1)} s), the view turning at most ${plan.peakTurnRate.toFixed(0)}°/s ` +
      `(${plan.peakTurnAccel.toFixed(0)}°/s²) and tilting at most ${plan.tiltRate?.toFixed(0)}°/s at its own pace` +
      `${plan.longer > 1.001 ? ` (its bell ${plan.longer.toFixed(2)} times longer for it)` : ''}` +
      `${plan.up ? `, climbing at ${Math.round(plan.up.angle)}°${plan.up.start === 0 ? ' from level' : ''} and coming down at ${Math.round(plan.down.angle)}°` : ''}, ` +
      `peak pace ${plan.peakPace.toFixed(2)} heights/s; phases ${[...phases].join(' ')}; ` +
      `${plan.liftShare ? `straight up first ${Math.round(100 * plan.liftShare)}% of the way to the cruise, ` : ''}${plan.samples} samples; ` +
      `the place ${ready == null ? '–' : `${Math.round(100 * ready)}%`} ready as it arrived, flown ${f?.elapsed?.toFixed(1)} s; ` +
      `lowest over the exact ground ${Number.isFinite(lowest) ? lowest.toFixed(1) : '–'} m, highest ` +
      `${Number.isFinite(peak) ? peak.toFixed(0) : '–'} m; slowest plan ${slowest.toFixed(1)} ms; ${f?.obstacleCalls} bound questions; ` +
      // Checked before it flew (Stage 5.12b, plan.js VERIFY) and watched on the way (flight.js WATCH).
      `checked before flying: ${f?.verified ? `${f.verified.worst > 0 ? `${f.verified.worst.toFixed(2)} m too near at ${f.verified.points} points` : 'clear'}` +
        `${f.verified.tries ? `, planned again ${f.verified.tries} times (first ${f.verified.first.toFixed(2)} m too near)` : ''}` : '–'}, ` +
      `lifted on the way ${f?.lifts ?? '–'} times${f?.room ? `, the spot's room ${f.room.toFixed(2)} m` : ''}${f?.glide ? `, the glide down ${f.glide}` : ''}; ` +
      `ended ${Math.round(q.camera.height - (q.physicsGround?.height ?? NaN))} m over the ground${f?.guessed ? ', spot guessed' : ''}; ` +
      `exact zones ${f?.zoneMs ? `start ${f.zoneMs.start.toFixed(1)}, end ${f.zoneMs.end.toFixed(1)}, landing spot ${f.zoneMs.spot.toFixed(1)} ms` : '–'}; ` +
      `slowest steps ${f?.slowest ? Object.entries(f.slowest).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') + ' ms' : '–'}; ` +
      `label ${JSON.stringify(q.label?.timings ?? null)}`);
    if (retargeted) {
      const c = retargeted.carried;
      console.log(`  picked again ${retargeted.at.toFixed(1)} s into the first flight: ${retargeted.before?.toFixed(1) ?? '–'} m/s just before, ` +
        `${retargeted.after?.toFixed(1) ?? '–'} m/s just after (probe to probe, simulated time); ` +
        `${c ? `the clock c ${c.c.toFixed(2)}, the rest given up over ${c.blend.toFixed(2)} s, the view onto the new flight over ${c.turn.toFixed(2)} s` : 'set off from rest'}; ` +
        `arriving ${f?.walk ? 'walking' : `${Math.round(f?.arrive ?? NaN)} m over the ground`}`);
    }
    const d = f?.destination;
    if (d) console.log(`  at the arrival: terrain ${d.terrain.have}/${d.terrain.have + d.terrain.need}, buildings ${d.buildings.have}/` +
      `${d.buildings.have + d.buildings.need}, photos ${d.imagery.have}/${d.imagery.have + d.imagery.need} of what its view draws`);
    console.log(`  frames in flight (worst 5 s window): ${late} late, work 99th ${work99.toFixed(1)} ms, worst ${workMax.toFixed(1)} ms, ` +
      `interval 99th ${frame99.toFixed(1)} ms (${frames} frames a window); slowest sections: ` +
      Object.entries(peaks).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ') + ' ms');
  }
}
if (PLANE) {
  // Bellinzona's floor is about 240 m above the sea there.
  await page.evaluate((h) => globalThis.swissgpu.send('camera', { state: { lon: 9.0249, lat: 46.1907, height: h, yaw: 245 * Math.PI / 180, pitch: 0, mode: 'fly' } }),
    PLANE_LOW != null ? 240 + PLANE_LOW : 1200);
  await wait(3000);
  // Twelve notches in a quick run, as a wheel turned on gives them (each one
  // bigger than the last since Stage 5.13b: about 375 km/h more asked).
  await page.evaluate(() => {
    globalThis.swissgpu.send('mode', { mode: 'plane' });
    for (let i = 0; i < 12; i++) globalThis.swissgpu.send('speed', { notches: 1 });
  });
} else {
  await page.evaluate(() => {
    globalThis.__look = setInterval(() => globalThis.swissgpu.send('look', { dx: 3, dy: (Math.random() - 0.5) * 2 }), 4);
    globalThis.swissgpu.send('setting', { id: 'flySpeed', value: 150 });
    globalThis.swissgpu.send('keys', { mask: 1 });
  });
}
// The airplane's pilot, on the simulation's clock: climb to 3,500 m at 20°,
// level off, then a short roll to the right every 15 s.
const KEYS = { FORWARD: 1, BACK: 4, RIGHT: 8 };
const pilot = { phase: 'climb0', mask: -1, tap: 0, next: 0, crashed: false, fastest: 0, highest: 0 };
const steer = async (q) => {
  const p = q.plane, t = q.simTime;
  if (!p) { if (q.motion?.mode === 'fly' && pilot.phase !== 'climb0') pilot.crashed = true; return; }
  pilot.fastest = Math.max(pilot.fastest, p.speed);
  pilot.highest = Math.max(pilot.highest, p.altitude);
  const sine = p.climb / Math.max(1, p.speed);
  let mask = 0;
  if (PLANE_LOW != null) { if (p.above != null && p.above < 100 && p.climb < 0) mask = KEYS.BACK; }
  else if (p.above != null && p.above < 400 && p.climb < 0) mask = KEYS.BACK;
  else if (pilot.phase === 'climb') {
    if (p.altitude >= 3500) pilot.phase = 'level';
    else if (sine < Math.sin(20 * Math.PI / 180)) mask = KEYS.BACK;
  } else if (pilot.phase === 'level') {
    if (p.climb > 5) mask = KEYS.FORWARD;
    else { pilot.phase = 'cruise'; pilot.next = t + 5; }
  } else if (pilot.phase === 'cruise') {
    if (t >= pilot.next) { pilot.tap = t + 0.4; pilot.next = t + 15; }
    if (t < pilot.tap) mask = KEYS.RIGHT;
  }
  if (mask !== pilot.mask) { pilot.mask = mask; await page.evaluate((m) => globalThis.swissgpu.send('keys', { mask: m }), mask); }
};
const t0 = Date.now();
const lines = [];
let last = null, printed = 0;
while (Date.now() - t0 < SECONDS * 1000 && !pilot.crashed) {
  await wait(PLANE ? 250 : 10000);
  const q = await probe();
  if (!q) continue;
  if (PLANE) {
    if (q.motion?.mode === 'plane' && pilot.phase === 'climb0') pilot.phase = 'climb';
    await steer(q);
    if (Date.now() - printed < 10000 && !pilot.crashed) continue;
    printed = Date.now();
  }
  const p = q.profile, T = q.terrain, B = q.buildings;
  const sec = (k) => (p.sections[k] == null ? '' : `${k} ${p.sections[k].toFixed(2)}/${(p.p95?.[k] ?? NaN).toFixed(2)}/${p.peaks[k].toFixed(1)}`);
  const jet = q.plane ? ` plane ${Math.round(q.plane.speed * 3.6)} km/h M${q.plane.mach.toFixed(2)} ${q.plane.above != null ? Math.round(q.plane.above) : '–'} m above, climbing ${q.plane.climb.toFixed(0)} m/s, ` +
    `${(q.plane.load ?? 0).toFixed(1)} g, bank ${((q.camera.roll ?? 0) * 180 / Math.PI).toFixed(0)}°, ${pilot.phase}${q.plane.stall ? ' STALL' : ''}, focus ${Math.round(q.solid?.touch ?? 0)} m |` : (PLANE ? ` mode ${q.motion?.mode}${pilot.crashed ? ' (crashed)' : ''} |` : '');
  lines.push(`t ${((Date.now() - t0) / 1000).toFixed(0)}s sim ${(q.simTime ?? 0).toFixed(0)}s alt ${q.camera.height.toFixed(0)} m${jet} frames ${p.frames} work ${p.work.toFixed(2)} 99th ${p.work99.toFixed(1)} | ` +
    ['terrain', 'buildings', 'evict', 'maintain', 'uploads', 'imagery', 'requests', 'draw'].map(sec).filter(Boolean).join(' | ') +
    ` || terrain ${T.drawn}d ${(T.bytes / 1048576).toFixed(0)}MB${T.detail != null ? ` det ${T.detail.toFixed(2)}` : ''} | bld ${B.drawn}d ${(B.bytes / 1048576).toFixed(0)}MB${B.detail != null ? ` det ${B.detail.toFixed(2)}` : ''} solid ${(B.solidBytes / 1048576).toFixed(0)}MB` +
    (B.nodes != null ? ` nodes ${B.nodes}` : '') + (B.skipped != null ? ` skipped ${B.skipped} deferred ${B.deferred}` : '') +
    (q.requests ? ` || jobs ${q.requests.active}/${q.requests.capacity} started ${q.requests.started} cancelled ${q.requests.cancelled} stale ${q.requests.stale} retries ${q.requests.retries}` : ''));
  last = q;
  console.log(lines.at(-1));
}
if (PLANE) console.log(`airplane: ${pilot.crashed ? 'crashed' : 'flew on'}, fastest ${Math.round(pilot.fastest * 3.6)} km/h, highest ${Math.round(pilot.highest)} m, last phase ${pilot.phase}`);
await page.evaluate(() => { clearInterval(globalThis.__look); globalThis.swissgpu.send('keys', { mask: 0 }); });
console.log('requests by host:', JSON.stringify(Object.fromEntries(hosts)));
if (last?.requests) console.log('decode jobs:', JSON.stringify({ ...last.requests, clients: undefined }), JSON.stringify(last.requests.clients));
if (last?.buildings.filesFetched != null) console.log(`building files: ${last.buildings.filesFetched} fetched, ${last.buildings.filesCached} from the cache, ${last.buildings.nodes} tile objects`);
console.log('warnings/errors:', logs.length, logs.slice(0, 8).join('\n'));
await browser.close(); server.close(); process.exit(0);
