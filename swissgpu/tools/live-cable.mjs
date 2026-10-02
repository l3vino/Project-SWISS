/* live-cable.mjs — a real cable car, against the live services: is it drawn
 * as a rope and pylons, and can you fly through it?
 *
 *   xvfb-run -a node tools/live-cable.mjs [--root <app folder>] [--above 10] [--level] [--seconds 8]
 *
 * Never loaded by the app, and it needs the network. The rope is the one in
 * the user's screenshot of 2026-09-30: a material ropeway near Gorduno
 * (swissTLM3D OBJEKTART 3, Transportseil), modelled by swisstopo as a 1 m tube
 * per span. Its longest span runs from LV95 2721011.4 / 1127324.4 at 645.9 m
 * to 2721458.2 / 1127584.3 at 859.3 m, up to about 48 m over the slope. The
 * app starts 40 m to the north-west of the middle of that span, `--above`
 * metres over the ground (with `--level`, at the height of the line between
 * the masts), facing south-east across it, waits until the structures around
 * it have loaded with their collision copies, then flies forward at 10 m/s.
 * Before Stage 4.2 the rope's long side triangles stood as an invisible wall
 * from the bottom of the span to its top; until Stage 4.3 the tube itself
 * stopped a flight level with it; since 4.3 the cable car is ropes and
 * pylons, and nothing of it is solid. Prints what is drawn of it and how far
 * the flight got; exits with 1 if it did not pass. `--root` points it at
 * another copy of the app, to compare versions.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url));
const ABOVE = Number(args.above || 10);
const LEVEL = 'level' in args;
/* The line between the span's masts, at its middle. */
const MID_HEIGHT = (645.9 + 859.3) / 2;
const SECONDS = Number(args.seconds || 8);
const DEG = Math.PI / 180;

/* swisstopo's approximate LV95 to WGS84 formulas (about a metre). */
function lv95(e, n) {
  const y = (e - 2600000) / 1e6, x = (n - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lon: (lon * 100) / 36, lat: (lat * 100) / 36 };
}
const A = lv95(2721011.4, 1127324.4), B = lv95(2721458.2, 1127584.3);
const mid = { lon: (A.lon + B.lon) / 2, lat: (A.lat + B.lat) / 2 };
const mLat = 111132, mLon = 111320 * Math.cos(mid.lat * DEG);
const along = Math.atan2((B.lon - A.lon) * mLon, (B.lat - A.lat) * mLat);   // the span's bearing
const across = along + Math.PI / 2;                                          // flying across it
const START = { lon: mid.lon - (40 * Math.sin(across)) / mLon, lat: mid.lat - (40 * Math.cos(across)) / mLat };

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
}, [JSON.stringify({ renderScale: 0.2, flySpeed: 10 }),
    JSON.stringify({ ...START, height: 900, yaw: across, pitch: 0.2, mode: 'fly' })]);
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${origin}/index.html`);

const probe = () => page.evaluate(() => globalThis.swissgpu?.probe()).catch(() => null);
const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
const wait = (ms) => page.waitForTimeout(ms);
const until = async (test, ms) => {
  const end = Date.now() + ms;
  let q = null;
  while (Date.now() < end) { q = await probe(); if (q && test(q)) return q; await wait(300); }
  return q;
};
const done = async (code) => {
  console.log('warnings/errors:', logs.length, logs.slice(0, 6).join('\n'));
  await browser.close(); server.close(); process.exit(code);
};

// The ground under the start, accurately; then down to the chosen height.
let q = await until((r) => r.physicsGround?.accurate, 180000);
if (!q?.physicsGround?.accurate) { console.log('accurate ground never arrived'); await done(2); }
const startHeight = LEVEL ? MID_HEIGHT : q.physicsGround.height + ABOVE;
await send('camera', { state: { ...START, height: startHeight, yaw: across, pitch: 0.2, mode: 'fly' } });
q = await until((r) => r.solid.settled && r.buildings.pending === 0 && Math.abs(r.camera.lat - START.lat) < 1e-9, 180000);
const structures = q.buildingTiles.filter((t) => t.layer.endsWith('/structures'));
const ropes = structures.reduce((n, t) => n + (t.ropes ?? 0), 0), pylons = structures.reduce((n, t) => n + (t.pylons ?? 0), 0);
console.log(`start ${START.lon.toFixed(6)}, ${START.lat.toFixed(6)}, ` +
  `${LEVEL ? `level with the line between the masts (${MID_HEIGHT.toFixed(1)} m)` : `${ABOVE} m over the ground (${q.physicsGround.height.toFixed(1)} m)`}, ` +
  `facing ${(across / DEG).toFixed(0)}°; ${structures.length} structure tiles drawn with ${ropes} rope pieces and ${pylons} pylons, ` +
  `collision ${q.solid.settled ? 'loaded' : 'not loaded'}`);
const t0 = q.simTime, p0 = q.camera;
await send('keys', { mask: 1 });
do { await wait(100); q = await probe(); } while (q.simTime - t0 < SECONDS);
await send('keys', { mask: 0 });
const flown = Math.hypot((q.camera.lon - p0.lon) * mLon, (q.camera.lat - p0.lat) * mLat);
const passed = flown > 40 + 20;
console.log(`flew ${flown.toFixed(1)} m in ${(q.simTime - t0).toFixed(1)} s of simulation: ` +
  `${passed ? 'passed the rope' : 'stopped before or at the rope'}`);
await done(passed ? 0 : 1);
