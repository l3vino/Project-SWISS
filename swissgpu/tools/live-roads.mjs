/* live-roads.mjs — roads and rails from the live vector tiles: what loads,
 * what it costs, and the data view.
 *
 *   xvfb-run -a node tools/live-roads.mjs [--place zurich|bellinzona|goeschenen|airolo|<lon>,<lat>]
 *                                         [--above 250] [--pitch -1.1] [--yaw 0] [--seconds 240]
 *                                         [--shot out.png] [--scale 0.5] [--root <app folder>]
 *                                         [--structures] [--timeline]
 *
 * Never loaded by the app, and it needs the network. Starts `--above` metres
 * over the ground at the place (Zürich HB by default; Bellinzona station;
 * the Gotthard rail tunnel's north portal at Göschenen), looking north and
 * down, waits until the road and rail tiles round it are in, and prints
 * what loaded: tiles per zoom against those wanted, segments, memory against
 * the setting, the decode time per tile, the page tables, requests per
 * host; then, once the terrain round it is in, what cutting the roads into
 * it did. Then it switches Graphics → Diagnostics → Terrain view to Roads
 * and rails (data) and saves out-photo.png and out-data.png next to --shot.
 * `--structures` draws the bridges and other structures; `--timeline`
 * prints, once a second from the arrival, how far the road tiles, the
 * widths and the cut terrain have got.
 * Behind a proxy, HTTPS_PROXY is passed on to the browser.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url));
const PLACES = {
  zurich: { lon: 8.5403, lat: 47.3779, label: 'Zürich HB' },
  bellinzona: { lon: 9.0293, lat: 46.1955, label: 'Bellinzona station' },
  goeschenen: { lon: 8.58876, lat: 46.66282, label: 'Gotthard rail tunnel, north portal' },
  airolo: { lon: 8.59237, lat: 46.53260, label: 'Gotthard pass road above Airolo' },
  bahnhofstrasse: { lon: 8.53829, lat: 47.37280, label: 'Zürich, Bahnhofstrasse' },
  gotthard: { lon: 8.59861, lat: 46.54341, label: 'a road over Airolo at 2,190 m' },
};
const place = PLACES[args.place || 'zurich'] ??
  (() => { const [lon, lat] = String(args.place).split(',').map(Number); return { lon, lat, label: args.place }; })();
const ABOVE = Number(args.above || 250);
const PITCH = Number(args.pitch ?? -1.1);
const YAW = Number(args.yaw ?? 0);
const SECONDS = Number(args.seconds || 240);
const SHOT = args.shot || null;
const SCALE = Number(args.scale || 0.5);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ||
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.wgsl': 'text/plain', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path || 'index.html'));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface',
  ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : [])] });
const context = await browser.newContext({ viewport: { width: 960, height: 600 }, ignoreHTTPSErrors: true });
await context.addInitScript(([s, c]) => {
  localStorage.setItem('swissgpu.settings.v2', s);
  localStorage.setItem('swissgpu.session.v1', JSON.stringify({ camera: JSON.parse(c) }));
}, [JSON.stringify({ renderScale: SCALE, buildings: false, structures: Boolean(args.structures) }),
    JSON.stringify({ lon: place.lon, lat: place.lat, height: 3000, yaw: YAW, pitch: PITCH, mode: 'fly' })]);
const page = await context.newPage();
const logs = [];
const hosts = new Map();
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
context.on('request', (r) => { const h = new URL(r.url()).host; hosts.set(h, (hosts.get(h) || 0) + 1); });
await page.goto(`${origin}/index.html`);

const probe = () => page.evaluate(() => globalThis.swissgpu?.probe()).catch(() => null);
const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
const wait = (ms) => page.waitForTimeout(ms);
const until = async (test, ms) => {
  const end = Date.now() + ms;
  let q = null;
  while (Date.now() < end) { q = await probe(); if (q && test(q)) return q; await wait(500); }
  return q;
};
const snap = async (suffix) => {
  if (!SHOT) return;
  await page.screenshot({ path: SHOT.replace(/\.png$/, `-${suffix}.png`), timeout: 180000 })
    .catch((err) => console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`));
};
const done = async (code) => {
  console.log('requests per host:', [...hosts].map(([h, n]) => `${h} ${n}`).join(' · '));
  console.log(`warnings/errors: ${logs.length}`, logs.slice(0, 8).join('\n'));
  await browser.close(); server.close(); process.exit(code);
};

// Stand on the place first (its column of terrain is asked for at once),
// so the ground there is known accurately; then up to the height asked.
await until((r) => r.terrain, 60000);
await send('spawn', { lon: place.lon, lat: place.lat, label: place.label });
let q = await until((r) => r.physicsGround?.accurate, 180000);
if (!q?.physicsGround?.accurate) { console.log('accurate ground never arrived'); await done(2); }
const ground = q.physicsGround.height;
await page.evaluate(() => { document.getElementById('readout').hidden = true; });
await send('camera', { state: { lon: place.lon, lat: place.lat, height: ground + ABOVE, yaw: YAW, pitch: PITCH, mode: 'fly' } });
const t0 = Date.now();
if (args.timeline) {
  // Once a second until the terrain round the place is cut and nothing is waiting.
  let last = '';
  for (;;) {
    const r = await probe();
    if (r) {
      const w = r.vector.widths, t = r.terrain, sh = t.shaping;
      const line = `roads ${r.vector.levels.map((l) => `z${l.z} ${l.ready}/${l.wanted}`).join(' ')} loading ${r.vector.loading} · ` +
        `widths ${w.tiles} tiles, ${w.jobs} jobs, ${w.waiting} waiting, ${w.calls} calls · terrain ${t.drawn} drawn z${t.minLevel}-${t.maxLevel}, ` +
        `${t.pending} pending · cut ${sh.tiles} (${sh.reshaped} again, ${sh.waited} waited), ${t.reshapes} to cut again`;
      if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  ${line}`);
      last = line;
      const settled = r.vector.loading === 0 && r.vector.ready > 0 && (!w.on || (w.jobs === 0 && w.waiting === 0)) &&
        t.pending === 0 && t.reshapes === 0;
      if (settled || Date.now() - t0 > SECONDS * 1000) break;
    }
    await wait(1000);
  }
}
q = await until((r) => r.vector.ready > 0 && r.vector.loading === 0 && r.vector.levels.every((l) => l.ready >= l.wanted), SECONDS * 1000);
const v = q.vector;
console.log(`${place.label}: ${ABOVE} m over the ground (${ground.toFixed(1)} m), ${v.source}`);
console.log(`  in ${((Date.now() - t0) / 1000).toFixed(1)} s: ` + v.levels.map((l) => `z${l.z} ${l.ready} of ${l.wanted} wanted (${l.empty} empty)`).join(', ') +
  `, ${v.loading} loading, ${v.missing} missing`);
console.log(`  ${v.segments} segments, ${v.refs} references, ${(v.bytes / 1048576).toFixed(1)} of ${(v.budget / 1048576).toFixed(0)} MB in ${v.blocks} blocks, ` +
  `decode ${v.decodeMs.toFixed(1)} ms a tile (smoothed), ${v.decoded} decoded`);
for (const l of v.pages) console.log(`  z${l.z} page table from ${l.origin}: ${l.pages}`);
// Each road's own width round it, then the terrain round it, cut with the roads.
q = await until((r) => !r.vector.widths.on || (r.vector.widths.jobs === 0 && r.vector.widths.waiting === 0), 180000);
{
  const w = q.vector.widths;
  console.log(`  exact widths: ${w.tiles} tiles matched (${w.cached} from the cache), ${w.calls} calls, ${(w.bytes / 1048576).toFixed(2)} MB, ` +
    `${w.matched} of ${w.asked} segments, ${w.failed} failed`);
}
q = await until((r) => r.terrain.pending === 0 && r.terrain.reshapes === 0, 300000);
{
  const t = q.terrain, sh = t.shaping;
  console.log(`  terrain: ${t.drawn} drawn, levels ${t.minLevel}-${t.maxLevel}, ${t.pending} pending; cut ${sh.tiles} tiles (${sh.reshaped} again), ` +
    `${sh.pieces} pieces, ${sh.used} used, +${sh.addedTriangles} triangles, ${sh.ms.toFixed(1)} ms a tile (smoothed), ${sh.waited} waited for roads; ` +
    `road tiles kept for it ${(q.vector.cpuBytes / 1048576).toFixed(1)} MB, shaping out to ${(q.vector.shapeDistance / 1000).toFixed(2)} km`);
  const b = q.vector.bridges;
  if (b?.on) console.log(`  bridges joined: ${b.runs} bridge runs on ${b.tiles} tiles, ${b.pins} road ends pinned to a deck, ${b.gaps} stretches past a deck's end on a bank, ${b.waiting} tiles waiting`);
}
// Held still for a while first, so the numbers are of the steady state.
await wait(8000);
const pr = (await probe()).profile;
const ms = (k) => `${(pr.sections?.[k] ?? 0).toFixed(3)} / ${(pr.p95?.[k] ?? 0).toFixed(3)} / ${(pr.peaks?.[k] ?? 0).toFixed(3)}`;
console.log(`  render thread, ms a frame (mean / 95th / worst over ${pr.frames} frames): roads & rails ${ms('vector')}, imagery ${ms('imagery')}, terrain ${ms('terrain')}`);
await snap('photo');
await send('setting', { id: 'debugMode', value: 6 });
await wait(3000);
await snap('data');
const r = q.requests.clients.vector;
console.log(`  vector jobs: ${r.started} started, ${r.cancelled} cancelled, ${r.retries} retries, ${r.failed} given up`);
await done(v.ready > 0 && v.missing === 0 ? 0 : 1);
