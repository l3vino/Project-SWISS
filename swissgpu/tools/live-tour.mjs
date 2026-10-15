/* live-tour.mjs — the real app against the live swisstopo services.
 *
 *   xvfb-run -a node tools/live-tour.mjs [--seconds 90] [--terrain-mb 48] [--building-mb 48]
 *                                        [--root <app folder>] [--scale 0.2] [--threads N]
 *                                        [--flights "lon,lat;lon,lat"] [--walk]
 *                                        [--search "Lugano;Zermatt"] [--scope national|global]
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
  // to the exact ground, the phases, how ready the place was when the
  // descent's wait would start, and the frames (late ones, the slowest work).
  let q = null, plan = null, slowest = 0, lowest = Infinity, peak = -Infinity, readyAtHold = null, slowestClock = 1;
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
    const f = q?.flight;
    if (f) {
      phases.add(f.phase);
      if (f.plan) plan = f.plan;
      slowest = Math.max(slowest, f.planMs ?? 0);
      if (f.active && f.plan && readyAtHold == null && f.t >= f.plan.holdTime) readyAtHold = f.ready;
      if (f.active) slowestClock = Math.min(slowestClock, f.rate ?? 1);
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
      `(${plan.peakTurnAccel.toFixed(0)}°/s²), peak pace ${plan.peakPace.toFixed(2)} heights/s; phases ${[...phases].join(' ')}; ` +
      `the place ${readyAtHold == null ? '–' : `${Math.round(100 * readyAtHold)}%`} ready when the descent's wait would start, ` +
      `waited ${f?.waited?.toFixed(1)} s (clock down to x${slowestClock.toFixed(2)}), flown ${f?.elapsed?.toFixed(1)} s; ` +
      `lowest over the exact ground ${Number.isFinite(lowest) ? lowest.toFixed(1) : '–'} m, highest ` +
      `${Number.isFinite(peak) ? peak.toFixed(0) : '–'} m; slowest plan ${slowest.toFixed(1)} ms; ${f?.obstacleCalls} bound questions; ` +
      `ended ${Math.round(q.camera.height - (q.physicsGround?.height ?? NaN))} m over the ground${f?.guessed ? ', spot guessed' : ''}; ` +
      `exact zones ${f?.zoneMs ? `start ${f.zoneMs.start.toFixed(1)}, end ${f.zoneMs.end.toFixed(1)}, landing spot ${f.zoneMs.spot.toFixed(1)} ms` : '–'}; ` +
      `slowest steps ${f?.slowest ? Object.entries(f.slowest).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ') + ' ms' : '–'}; ` +
      `label ${JSON.stringify(q.label?.timings ?? null)}`);
    const d = f?.destination;
    if (d) console.log(`  at the arrival: terrain ${d.terrain.have}/${d.terrain.have + d.terrain.need}, buildings ${d.buildings.have}/` +
      `${d.buildings.have + d.buildings.need}, photos ${d.imagery.have}/${d.imagery.have + d.imagery.need} of what its view draws`);
    console.log(`  frames in flight (worst 5 s window): ${late} late, work 99th ${work99.toFixed(1)} ms, worst ${workMax.toFixed(1)} ms, ` +
      `interval 99th ${frame99.toFixed(1)} ms (${frames} frames a window); slowest sections: ` +
      Object.entries(peaks).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', ') + ' ms');
  }
}
await page.evaluate(() => {
  globalThis.__look = setInterval(() => globalThis.swissgpu.send('look', { dx: 3, dy: (Math.random() - 0.5) * 2 }), 4);
  globalThis.swissgpu.send('setting', { id: 'flySpeed', value: 150 });
  globalThis.swissgpu.send('keys', { mask: 1 });
});
const t0 = Date.now();
const lines = [];
let last = null;
while (Date.now() - t0 < SECONDS * 1000) {
  await wait(10000);
  const q = await probe();
  if (!q) continue;
  const p = q.profile, T = q.terrain, B = q.buildings;
  const sec = (k) => (p.sections[k] == null ? '' : `${k} ${p.sections[k].toFixed(2)}/${(p.p95?.[k] ?? NaN).toFixed(2)}/${p.peaks[k].toFixed(1)}`);
  lines.push(`t ${((Date.now() - t0) / 1000).toFixed(0)}s alt ${q.camera.height.toFixed(0)} m frames ${p.frames} work ${p.work.toFixed(2)} 99th ${p.work99.toFixed(1)} | ` +
    ['terrain', 'buildings', 'evict', 'maintain', 'uploads', 'imagery', 'requests', 'draw'].map(sec).filter(Boolean).join(' | ') +
    ` || terrain ${T.drawn}d ${(T.bytes / 1048576).toFixed(0)}MB${T.detail != null ? ` det ${T.detail.toFixed(2)}` : ''} | bld ${B.drawn}d ${(B.bytes / 1048576).toFixed(0)}MB${B.detail != null ? ` det ${B.detail.toFixed(2)}` : ''} solid ${(B.solidBytes / 1048576).toFixed(0)}MB` +
    (B.nodes != null ? ` nodes ${B.nodes}` : '') + (B.skipped != null ? ` skipped ${B.skipped} deferred ${B.deferred}` : '') +
    (q.requests ? ` || jobs ${q.requests.active}/${q.requests.capacity} started ${q.requests.started} cancelled ${q.requests.cancelled} stale ${q.requests.stale} retries ${q.requests.retries}` : ''));
  last = q;
  console.log(lines.at(-1));
}
await page.evaluate(() => { clearInterval(globalThis.__look); globalThis.swissgpu.send('keys', { mask: 0 }); });
console.log('requests by host:', JSON.stringify(Object.fromEntries(hosts)));
if (last?.requests) console.log('decode jobs:', JSON.stringify({ ...last.requests, clients: undefined }), JSON.stringify(last.requests.clients));
if (last?.buildings.filesFetched != null) console.log(`building files: ${last.buildings.filesFetched} fetched, ${last.buildings.filesCached} from the cache, ${last.buildings.nodes} tile objects`);
console.log('warnings/errors:', logs.length, logs.slice(0, 8).join('\n'));
await browser.close(); server.close(); process.exit(0);
