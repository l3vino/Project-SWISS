/* live-startup.mjs — does the camera stay where it starts, against the live services?
 *
 *   xvfb-run -a node tools/live-startup.mjs [--seconds 30] [--root <app folder>]
 *                                           [--lon 9.0249 --lat 46.1907 --height 330]
 *
 * Never loaded by the app, and it needs the network. Starts the app flying low
 * in a valley (Bellinzona by default: ground at about 248 m, camera at 330 m),
 * holds no keys, and records the camera every 100 ms while the terrain streams
 * in level by level. Nothing should move it: coarse tiles are far above a
 * valley floor (the level-3 tile over Bellinzona puts the ground at 2,710 m),
 * and before Stage 4.1 physics stood on them and lifted the camera to over
 * 3,000 m within a second. Prints the timeline, and exits with 1 if the camera
 * rose more than a metre. `--root` points it at another copy of the app, to
 * compare versions.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url));
const SECONDS = Number(args.seconds || 30);
const START = { lon: Number(args.lon || 9.0249), lat: Number(args.lat || 46.1907), height: Number(args.height || 330) };

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
}, [JSON.stringify({ renderScale: 0.2 }),
    JSON.stringify({ ...START, yaw: 0.9, pitch: -0.15, mode: 'fly' })]);
const page = await context.newPage();
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${origin}/index.html`);

const probe = () => page.evaluate(() => globalThis.swissgpu?.probe()).catch(() => null);
const wait = (ms) => page.waitForTimeout(ms);
let q = null;
for (let i = 0; i < 240 && !q; i++) { q = await probe(); if (!q) await wait(250); }
if (!q) { console.log('the app did not start'); await browser.close(); server.close(); process.exit(2); }

const t0 = Date.now();
let highest = q.camera.height, lastLine = '', rows = 0;
while (Date.now() - t0 < SECONDS * 1000) {
  q = await probe();
  if (q) {
    highest = Math.max(highest, q.camera.height);
    const g = q.motion.aboveGround;
    const line = `height ${q.camera.height.toFixed(1)} m · above ground ${g == null ? '—' : g.toFixed(1)} · ` +
      `drawn z${q.leaf?.z ?? '—'} · physics on z${q.groundLevel ?? '—'} · terrain ${q.terrain.drawn} drawn ${q.terrain.pending} pending`;
    if (line !== lastLine) {
      console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s  sim ${q.simTime.toFixed(1).padStart(5)} s  ${line}`);
      lastLine = line;
      rows++;
    }
  }
  await wait(100);
}
const rose = highest - START.height;
console.log(`started at ${START.height} m, highest ${highest.toFixed(1)} m: ${rose > 1 ? `ROSE ${rose.toFixed(0)} m` : 'stayed put'}`);
console.log('warnings/errors:', logs.length, logs.slice(0, 6).join('\n'));
await browser.close();
server.close();
process.exit(rose > 1 ? 1 : 0);
