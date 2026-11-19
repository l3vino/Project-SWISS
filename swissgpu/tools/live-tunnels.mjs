/* live-tunnels.mjs — tunnels from the live services (Stage 5.17b): what is
 * found, followed and built, and how it looks at the portals and inside.
 *
 *   xvfb-run -a node tools/live-tunnels.mjs [--shot out.png] [--scale 0.5] [--seconds 600] [--root <app folder>]
 *
 * Never loaded by the app, and it needs the network. At Göschenen, where the
 * Gotthard rail tunnel (north portal 8.58876, 46.66282) and the Gotthard road
 * tunnel (8.59252, 46.67168) begin: waits until the tunnels round the place
 * are found, followed to Airolo and built, prints them (kind, length, the
 * whole tunnel's length and far portal, the floor at both ends, the cross-
 * section, the portals' openings, what following them cost), then looks at
 * each portal from 60 m outside and from 40 m inside and saves the views
 * next to --shot. Behind a proxy, HTTPS_PROXY is passed on to the browser.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url));
const SHOT = args.shot || null;
const SCALE = Number(args.scale || 0.5);
const SECONDS = Number(args.seconds || 600);
const PORTALS = [
  { name: 'rail', lon: 8.58876, lat: 46.66282, family: 2 },
  { name: 'road', lon: 8.59252, lat: 46.67168, family: 1 },
];

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
const start = PORTALS[0];
await context.addInitScript(([s, c]) => {
  localStorage.setItem('swissgpu.settings.v2', s);
  localStorage.setItem('swissgpu.session.v1', JSON.stringify({ camera: JSON.parse(c) }));
}, [JSON.stringify({ renderScale: SCALE, buildings: false, structures: true }),
    JSON.stringify({ lon: start.lon, lat: start.lat, height: 3000, yaw: Math.PI, pitch: -1.1, mode: 'fly' })]);
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
  while (Date.now() < end) { q = await probe(); if (q && test(q)) return q; await wait(1000); }
  return q;
};
const frames = async () => { const t = (await probe())?.simTime ?? 0; return until((q) => q.simTime > t + 0.15, 180000); };
const snap = async (suffix) => {
  if (!SHOT) return;
  await page.screenshot({ path: SHOT.replace(/\.png$/, `-${suffix}.png`), timeout: 180000 })
    .catch((err) => console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`));
};
const done = async (code) => {
  console.log('requests per host:', [...hosts].map(([h, n]) => `${h} ${n}`).join(' · '));
  console.log(`warnings/errors: ${logs.length}`, logs.slice(0, 10).join('\n'));
  await browser.close(); server.close(); process.exit(code);
};
const M_LAT = 111132;
const mLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);
const near = (t, p) => t.ends.some((e) => Math.hypot((e.lon - p.lon) * mLon(p.lat), (e.lat - p.lat) * M_LAT) < 80);
const tubeOf = (q, p) => q?.tunnels?.tubes?.filter((t) => t.family === p.family && near(t, p)).sort((a, b) => b.length - a.length)[0];

await until((r) => r.terrain, 60000);
await send('spawn', { lon: start.lon, lat: start.lat, label: 'Göschenen' });
let q = await until((r) => r.physicsGround?.accurate, 240000);
if (!q?.physicsGround?.accurate) { console.log('accurate ground never arrived'); await done(2); }
await page.evaluate(() => { document.getElementById('readout').hidden = true; });
await send('camera', { state: { lon: start.lon, lat: start.lat + 60 / M_LAT, height: q.physicsGround.height + 8, yaw: Math.PI, pitch: -0.05, mode: 'fly' } });
const t0 = Date.now();
q = await until((r) => PORTALS.every((p) => tubeOf(r, p)?.mesh), SECONDS * 1000);
const tu = q?.tunnels;
console.log(`tunnels round Göschenen after ${((Date.now() - t0) / 1000).toFixed(0)} s: ${tu?.tubes?.length ?? 0} tubes, ` +
  `${tu?.meshes ?? 0} meshes (${((tu?.bytes ?? 0) / 1048576).toFixed(1)} MB), ${tu?.portals?.length ?? 0} portals, traced ${tu?.traced ?? 0} ` +
  `(${tu?.traceTiles ?? 0} tiles, ${((tu?.traceBytes ?? 0) / 1048576).toFixed(2)} MB), ${tu?.grounds ?? 0} portal grounds, ${tu?.failed ?? 0} failed, ` +
  `last mesh ${(tu?.meshMs ?? 0).toFixed(0)} ms; frame: tunnels ${(q?.profile?.sections?.tunnels ?? 0).toFixed(3)} ms mean`);
const fmt = (e) => `${['', 'portal', 'open', 'closed', 'join'][e.type] ?? e.type} ${e.lon.toFixed(5)},${e.lat.toFixed(5)}`;
for (const t of (tu?.tubes ?? []).sort((a, b) => b.length - a.length).slice(0, 12)) {
  console.log(`  ${t.kind} ${t.length} m ${t.tracks} line(s): ${t.ends.map(fmt).join(' → ')}` +
    (t.whole ? `; whole ${t.whole.length} m: ${t.whole.ends.map(fmt).join(' → ')}` : '') +
    `; floor ${t.floor ? t.floor.map((h) => h.toFixed(1)).join(' → ') : '—'}${t.entry ? ` (${t.entry})` : ''}` +
    `; section ${t.section ? `${(2 * t.section.half).toFixed(1)} × ${t.section.height.toFixed(1)} m` : '—'}; ${t.mesh ? `${t.mesh.triangles} triangles` : 'no mesh'}`);
}
for (const p of tu?.portals ?? []) console.log(`  portal ${p.lon.toFixed(5)},${p.lat.toFixed(5)} floor ${p.h.toFixed(1)} m, ${(2 * p.half).toFixed(1)} m wide, the approach rising ${(p.rise * 100).toFixed(1)}%`);

// Each portal: 60 m out along its approach, looking in; then 40 m inside, looking along.
for (const p of PORTALS) {
  const t = tubeOf(q, p);
  if (!t) { console.log(`${p.name}: no tube`); continue; }
  const e = t.ends.reduce((a, b) => (Math.hypot((a.lon - p.lon) * mLon(p.lat), (a.lat - p.lat) * M_LAT) <= Math.hypot((b.lon - p.lon) * mLon(p.lat), (b.lat - p.lat) * M_LAT) ? a : b));
  const portal = tu.portals.find((x) => Math.hypot((x.lon - e.lon) * mLon(e.lat), (x.lat - e.lat) * M_LAT) < 5);
  const other = t.ends.find((x) => x !== e);
  // The way out: from the tube's other end towards this one, near enough.
  const dx = (e.lon - other.lon) * mLon(e.lat), dy = (e.lat - other.lat) * M_LAT, l = Math.hypot(dx, dy);
  const ox = dx / l, oy = dy / l, yawIn = Math.atan2(-ox, -oy);
  const h = portal?.h ?? t.floor?.[0] ?? 1100;
  for (const [label, d, up] of [['outside', 60, 5], ['inside', -40, 2.2]]) {
    await send('camera', { state: { lon: e.lon + (ox * d) / mLon(e.lat), lat: e.lat + (oy * d) / M_LAT, height: h + up, yaw: yawIn, pitch: label === 'outside' ? -0.04 : 0, mode: 'fly' } });
    await wait(1500);
    await frames();
    const r = await probe();
    const inside = r?.tunnels?.tubes?.some((x) => x.mesh?.inside);
    console.log(`${p.name} ${label}: camera ${r.camera.height.toFixed(1)} m (floor ${h.toFixed(1)}), inside a tube: ${inside}, ${r.tunnels.drawn} tubes drawn, ` +
      `${r.tunnels.cutTiles} terrain tiles cut`);
    await snap(`${p.name}-${label}`);
  }
}
await done(logs.some((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')) ? 1 : 0);
