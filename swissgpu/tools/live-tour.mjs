/* live-tour.mjs — the real app against the live swisstopo services.
 *
 *   xvfb-run -a node tools/live-tour.mjs [--seconds 90] [--terrain-mb 48] [--building-mb 48]
 *                                        [--root <app folder>] [--scale 0.2] [--threads N]
 *                                        [--flights "lon,lat;lon,lat"] [--walk]
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
 * beside the place and the buildings there get collision copies.
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
for (const [lon, lat] of FLIGHTS) {
  const start = Date.now();
  await page.evaluate(([x, y]) => globalThis.swissgpu.send('flyto', { lon: x, lat: y, label: 'live flight' }), [lon, lat]);
  let q = null;
  for (let i = 0; i < 300; i++) {
    await wait(1000);
    q = await probe();
    if (!q || q.flight?.arrived || logs.some((l) => l.includes('pageerror') || l.includes('Rendering stopped'))) break;
  }
  if (WALK) for (let i = 0; i < 60 && q && !(q.flight?.landed && q.camera.mode === 'walk'); i++) { await wait(1000); q = await probe(); }
  console.log(`flight to ${lon},${lat}: ${q?.flight?.arrived ? 'arrived' : 'not arrived'}${WALK ? (q?.flight?.landed ? ', landed walking' : ', not landed') : ''} ` +
    `after ${((Date.now() - start) / 1000).toFixed(0)} s; collision read-backs ${q?.buildings?.readbacks ?? '?'}; ` +
    `photos fetched ahead ${q?.imagery?.prefetched ?? '?'}; jobs ${q?.requests?.active}/${q?.requests?.capacity} on ${q?.requests?.threads} threads, ` +
    `stale ${q?.requests?.stale}, cancelled ${q?.requests?.cancelled}; ${logs.length} warnings/errors so far`);
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
    (B.nodes != null ? ` nodes ${B.nodes}` : '') +
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
