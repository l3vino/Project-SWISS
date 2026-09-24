/* verify.mjs — runs the real app headlessly on a software GPU.
 *
 *   xvfb-run -a node tools/verify.mjs [--shot out.png] [--seconds 25] [--settings '{json}']
 *
 * Never loaded by the app, and not needed to run it. This is how changes are
 * checked before they ship: the page is served locally, Chromium runs it on
 * SwiftShader's WebGPU, and every request to a remote service is answered from
 * tools/mock-data.mjs. Any WebGPU validation error, uncaught exception or
 * failed module load fails the run.
 *
 * Needs Node 20+, Playwright's Chromium and a display. Headless Chromium can
 * run WebGPU compute but cannot present a WebGPU canvas (its GPU process has no
 * shared-image backing for the swap chain and drops the device on the first
 * frame), so the browser runs headed on a virtual X server instead.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYER_JSON, encodeTerrainTile, encodeImageryTile } from './mock-data.mjs';
import { BUILDINGS_PATH, serveBuildings } from './mock-buildings.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const SECONDS = Number(args.seconds || 25);

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ||
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');

/* ---- static server with the MIME types the app depends on ---- */
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.wgsl': 'text/plain', '.json': 'application/json',
};
const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path || 'index.html'));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/* ---- the browser ---- */
if (!process.env.DISPLAY) {
  console.error('No display. Run under a virtual one: xvfb-run -a node tools/verify.mjs');
  process.exit(2);
}
const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
         '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

const counts = {
  terrain: 0, terrainMissing: 0, terrainByLevel: {}, terrainAccept: '',
  imagery: 0, imageryRefused: 0,
  buildingTilesets: 0, buildingTiles: { plain: 0, meshopt: 0, draco: 0 },
  other: 0,
};
await context.route(/^https:\/\//, async (route) => {
  const url = new URL(route.request().url());
  const cors = { 'access-control-allow-origin': '*' };

  if (url.host === '3d.geo.admin.ch' && url.pathname.endsWith('/layer.json')) {
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(LAYER_JSON) });
  }
  const tile = url.host === '3d.geo.admin.ch' && url.pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.terrain$/);
  if (tile) {
    const z = Number(tile[1]);
    const body = encodeTerrainTile(z, Number(tile[2]), Number(tile[3]));
    counts.terrainAccept ||= route.request().headers().accept || '(none)';
    // Object storage answers 403 for a key that is not there; imitate it.
    if (!body) { counts.terrainMissing++; return route.fulfill({ status: 403, headers: cors, body: '' }); }
    counts.terrain++;
    counts.terrainByLevel[z] = (counts.terrainByLevel[z] || 0) + 1;
    return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/vnd.quantized-mesh' }, body });
  }
  if (url.host === '3d.geo.admin.ch' && url.pathname.startsWith(BUILDINGS_PATH)) {
    const answer = serveBuildings(url.pathname);
    if (!answer) return route.fulfill({ status: 403, headers: cors, body: '' });
    if (answer.encoding) counts.buildingTiles[answer.encoding]++;
    else counts.buildingTilesets++;
    return route.fulfill({ status: answer.status, headers: { ...cors, 'content-type': answer.type }, body: answer.body });
  }
  const photo = url.host === 'wmts.geo.admin.ch' && url.pathname.match(/\/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg$/);
  if (photo) {
    const { status, body } = await encodeImageryTile(Number(photo[1]), Number(photo[2]), Number(photo[3]));
    if (status === 200) counts.imagery++; else counts.imageryRefused++;
    return route.fulfill({ status, headers: { ...cors, 'content-type': 'image/jpeg' }, body });
  }
  counts.other++;
  return route.fulfill({ status: 404, headers: cors, body: '' });
});

// Settings can be seeded before the app reads them: --settings '{"gpuTiming":false}'.
if (args.settings) {
  await context.addInitScript((json) => {
    localStorage.setItem('swissgpu.settings.v2', json);
  }, String(args.settings));
}
// So can the last session's camera, to start somewhere or in walking mode:
// --session '{"lon":8.7,"lat":46.2,"height":400,"mode":"walk"}'.
if (args.session) {
  await context.addInitScript((json) => {
    localStorage.setItem('swissgpu.session.v1', JSON.stringify({ camera: JSON.parse(json) }));
  }, String(args.session));
}

const page = await context.newPage();
const log = { errors: [], warnings: new Map(), info: [] };
const note = (type, text) => {
  if (type === 'error') log.errors.push(text);
  else if (type === 'warning') log.warnings.set(text.replace(/\d+\/\d+\/\d+/g, 'z/x/y'), (log.warnings.get(text) || 0) + 1);
  else log.info.push(text);
};
page.on('console', (m) => note(m.type(), m.text()));
page.on('pageerror', (e) => note('error', `pageerror: ${e.message}`));
page.on('worker', (w) => w.on?.('console', (m) => note(m.type(), `[${w.url().slice(-24)}] ${m.text()}`)));

await page.goto(`${origin}/index.html`);

/* ---- let it run, sampling the readout ---- */
const started = Date.now();
let readout = '';
while (Date.now() - started < SECONDS * 1000) {
  await page.waitForTimeout(1000);
  readout = await page.evaluate(() => document.getElementById('readout')?.innerText || '');
  const bootError = await page.evaluate(() => {
    const e = document.getElementById('boot-error');
    return e && !e.hidden ? e.textContent : '';
  });
  if (bootError) { note('error', `boot: ${bootError}`); break; }
  if (log.errors.length) break;
}

if (args.scenario && !log.errors.length) {
  const { run } = await import(`./scenarios/${args.scenario}.mjs`);
  const results = await run(page, { shot: args.shot, counts });
  console.log(`--- scenario: ${args.scenario} ---`);
  for (const r of results) {
    console.log(`${r.ok ? 'pass' : 'FAIL'}  ${r.name}: ${r.detail}`);
    if (!r.ok) log.errors.push(`scenario: ${r.name} (${r.detail})`);
  }
}

if (args.eval) {
  const value = await page.evaluate(args.eval).catch((e) => `eval failed: ${e.message}`);
  console.log('eval:', typeof value === 'string' ? value : JSON.stringify(value));
}
// A software GPU can take many seconds a frame; a slow screenshot is not a
// failure of the app.
if (args.shot) {
  await page.screenshot({ path: args.shot, timeout: 120000 })
    .catch((err) => console.warn(`final screenshot skipped: ${err.message.split('\n')[0]}`));
}

console.log('--- readout ---\n' + readout.replace(/\n{2,}/g, '\n'));
const { terrainAccept, ...tally } = counts;
console.log('--- requests ---', JSON.stringify(tally));
console.log('--- terrain Accept header ---', terrainAccept);
console.log('--- info ---\n' + log.info.slice(0, 12).join('\n'));
console.log(`--- warnings (${[...log.warnings.values()].reduce((a, b) => a + b, 0)}) ---`);
for (const [text, n] of log.warnings) console.log(`${n}x ${text.slice(0, 220)}`);
console.log(`--- errors (${log.errors.length}) ---`);
for (const e of log.errors.slice(0, 10)) console.log(e.slice(0, 400));

await browser.close();
server.close();
process.exit(log.errors.length ? 1 : 0);
