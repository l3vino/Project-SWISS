/* live-prof.mjs — where the threads' time goes (5.19a): CPU profiles of the render thread, two decode threads and
 * the tunnels' thread over Chrome's own debugging protocol, while loading where you start (A, --loadms) and while
 * flying along a line (B, --fly), with the app's own per-frame sections (probe().profile); with --heap, what the
 * render thread allocates while loading (the garbage collector's work). Needs the network.
 *
 *   xvfb-run -a node tools/live-prof.mjs --lon 8.9860 --lat 46.1567 --height 225 --scale 0.35 --loadms 240000 \
 *     --fly '{"from":[8.9860,46.1567],"to":[9.0230,46.1950],"height":400,"yaw":0.59,"pitch":-0.25,"seconds":120}' --heap
 *
 * --root the folder served (default: this project), --cams views to take after settling ([{name, at, height, yaw,
 * pitch}], --shot names the pictures), --seconds how long settling may take.
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
const AT = { lon: Number(args.lon), lat: Number(args.lat), height: Number(args.height || 300) };
const VIEWS = [[0, -0.35]];
const BUILDINGS = args.buildings !== 'false';

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

const browser = await chromium.launch({ headless: false, args: ['--remote-debugging-port=9333', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
  '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface',
  ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--ignore-certificate-errors'] : [])] });
const context = await browser.newContext({ viewport: { width: Number(args.width || 1280), height: Number(args.height2 || 720) }, ignoreHTTPSErrors: true });
await context.addInitScript(([s, c]) => {
  localStorage.setItem('swissgpu.settings.v2', s);
  localStorage.setItem('swissgpu.session.v1', JSON.stringify({ camera: JSON.parse(c) }));
}, [JSON.stringify({ renderScale: SCALE, autoScale: false, buildings: BUILDINGS, structures: true, ...(args.settings ? JSON.parse(args.settings) : {}) }),
    JSON.stringify({ lon: AT.lon, lat: AT.lat, height: AT.height, yaw: VIEWS[0]?.[0] ?? 0, pitch: VIEWS[0]?.[1] ?? 0, mode: 'fly' })]);
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
  while (Date.now() < end) { q = await probe(); if (q && test(q)) return q; await wait(2000); }
  return q;
};
const frames = async () => { const t = (await probe())?.simTime ?? 0; return until((q) => q.simTime > t + 0.15, 180000); };
const snap = async (suffix) => {
  if (!SHOT) return;
  await page.screenshot({ path: SHOT.replace(/\.png$/, `-${suffix}.png`), timeout: 180000 })
    .catch((err) => console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`));
};


/* ---- CPU profiles of the render worker and its decode workers over the browser's own debugging protocol ---- */
const version = await (await fetch('http://127.0.0.1:9333/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map(), sessions = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.no(new Error(JSON.stringify(m.error))) : p.ok(m.result); return; }
  if (m.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = m.params;
    sessions.set(sessionId, { info: targetInfo, parent: m.sessionId ?? null });
    if (targetInfo.type === 'worker') cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((ok, no) => pending.set(id, { ok, no }));
}
const { targetInfos } = await cdp('Target.getTargets');
const pageTarget = targetInfos.find((t) => t.type === 'page' && t.url.startsWith(origin));
const { sessionId: pageSession } = await cdp('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, pageSession);

const workerSessions = () => {
  const list = [...sessions.entries()].filter(([, s]) => s.info.type === 'worker');
  const render = list.find(([, s]) => s.parent === pageSession);
  const kids = render ? list.filter(([, s]) => s.parent === render[0]) : [];
  const tunnels = kids.find(([, s]) => /tunnels/.test(`${s.info.title} ${s.info.url}`));
  const codecs = kids.filter((k) => k !== tunnels);
  return { render: render?.[0] ?? null, codecs: codecs.map(([id]) => id), tunnels: tunnels?.[0] ?? null,
    titles: kids.map(([, s]) => s.info.title).join(', ') };
};
async function heapStart(id) { await cdp('HeapProfiler.enable', {}, id); await cdp('HeapProfiler.startSampling', { samplingInterval: 16384 }, id); }
async function heapStop(id, title, top = 22) {
  const { profile } = await cdp('HeapProfiler.stopSampling', {}, id);
  const self = new Map();
  let total = 0;
  const walk = (n) => {
    const f = n.callFrame, key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + n.selfSize);
    total += n.selfSize;
    for (const c of n.children ?? []) walk(c);
  };
  walk(profile.head);
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`== ${title}: ${(total / 1048576).toFixed(1)} MB sampled live at the end (allocation sampling)`);
  for (const [k, b] of rows) console.log(`   ${(b / 1048576).toFixed(2).padStart(7)} MB ${(100 * b / Math.max(total, 1)).toFixed(1).padStart(5)}%  ${k}`);
}
async function profileStart(ids) {
  for (const id of ids) { await cdp('Profiler.enable', {}, id); await cdp('Profiler.setSamplingInterval', { interval: 500 }, id); await cdp('Profiler.start', {}, id); }
}
function summarize(profile, title, top = 22) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0, idle = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]), dt = (profile.timeDeltas[i] ?? 0) / 1000;
    const f = n.callFrame, name = f.functionName || '(anonymous)';
    if (name === '(idle)' || name === '(program)' && false) { idle += dt; continue; }
    total += dt;
    const key = `${name} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`== ${title}: busy ${(total / 1000).toFixed(1)} s, idle ${(idle / 1000).toFixed(1)} s`);
  for (const [k, ms] of rows) console.log(`   ${(ms / 1000).toFixed(2).padStart(7)} s ${(100 * ms / Math.max(total, 1)).toFixed(1).padStart(5)}%  ${k}`);
  // Who the posting is for: postMessage's callers, two frames up (the message type is in the second).
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const key = (n) => `${n.callFrame.functionName || '(anonymous)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`;
  const callers = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    if (n.callFrame.functionName !== 'postMessage') continue;
    const up = [];
    for (let id = parent.get(n.id), k = 0; id !== undefined && k < 4; id = parent.get(id), k++) up.push(key(byId.get(id)));
    const name = up.slice(0, 4).join(' < ');
    callers.set(name, (callers.get(name) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const posts = [...callers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (posts.length) console.log('   postMessage from:');
  for (const [k, ms] of posts) console.log(`   ${(ms / 1000).toFixed(2).padStart(7)} s  ${k}`);
}
async function profileStop(ids, title) {
  const merged = { nodes: [], samples: [], timeDeltas: [] };
  let off = 0;
  for (const id of ids) {
    const { profile } = await cdp('Profiler.stop', {}, id);
    let most = 0;
    for (const n of profile.nodes) { merged.nodes.push({ ...n, id: n.id + off }); if (n.id > most) most = n.id; }
    for (const s of profile.samples) merged.samples.push(s + off);
    for (const d of profile.timeDeltas) merged.timeDeltas.push(d);
    off += most + 1;
  }
  summarize(merged, title);
}
const sections = (q) => {
  const p = q?.profile;
  if (!p) return '';
  const rows = Object.entries(p.sections ?? {}).filter(([, v]) => v > 0.02).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toFixed(2)}/${(p.p95?.[k] ?? 0).toFixed(1)}/${(p.peaks?.[k] ?? 0).toFixed(0)}`);
  return `work ${p.work?.toFixed?.(2)} ms (95th ${p.work95?.toFixed?.(1)}, 99th ${p.work99?.toFixed?.(1)}, most ${p.workMax?.toFixed?.(0)}), frame ${p.interval?.toFixed?.(0)} ms, late ${p.late}; sections mean/95th/peak: ${rows.join(', ')}`;
};

const t0 = Date.now();
await until((r) => r.terrain, 90000);
await wait(5000);
let w = workerSessions();
console.log(`workers: render ${w.render ? 'yes' : 'no'}, decode ${w.codecs.length}, tunnels ${w.tunnels ? 'yes' : 'no'} (${w.titles})`);
// A: the first minutes of loading where he starts.
await profileStart([w.render]);
await profileStart(w.codecs.slice(0, 2));
if (w.tunnels) await profileStart([w.tunnels]);
if (args.heap) await heapStart(w.render);
await wait(Number(args.loadms || 240000));
let q = await probe();
console.log(`A after ${((Date.now() - t0) / 1000).toFixed(0)} s: terrain ${q.terrain.drawn} drawn ${q.terrain.pending} pending; ${sections(q)}`);
console.log(`jobs started ${q.requests?.started}, frames ${q.frame ?? q.frames ?? '?'}; per client ${JSON.stringify(Object.fromEntries(Object.entries(q.requests?.clients ?? {}).map(([k, v]) => [k, v.started])))}`);
if (args.only === 'A') {
  await profileStop([w.render], 'A render worker (loading)');
  if (w.tunnels) await profileStop([w.tunnels], 'A tunnels worker (loading)');
  if (args.heap) await heapStop(w.render, 'A render worker allocations (loading)');
  console.log(`warnings/errors: ${logs.length}`, [...new Set(logs)].slice(0, 12).join('\n'));
  ws.close();
  await browser.close(); server.close(); process.exit(0);
}
await profileStop([w.render], 'A render worker (loading)');
await profileStop(w.codecs.slice(0, 2), 'A two decode workers (loading)');
if (w.tunnels) await profileStop([w.tunnels], 'A tunnels worker (loading)');
if (args.heap) await heapStop(w.render, 'A render worker allocations (loading)');
console.log(`tunnels: ${JSON.stringify({ tubes: q.tunnels?.tubes?.length, meshes: q.tunnels?.meshes, drawn: q.tunnels?.drawn, portals: q.tunnels?.portals?.length, failed: q.tunnels?.failed, jobs: q.tunnels?.jobs })}`);

// Settle, then the views from outside the tunnels.
q = await until((r) => r.terrain?.pending === 0 && (r.vector?.loading ?? 0) === 0, SECONDS * 1000);
await wait(15000);
q = await probe();
console.log(`settled after ${((Date.now() - t0) / 1000).toFixed(0)} s (${q.terrain.pending} pending): ${sections(q)}`);
const cams = args.cams ? JSON.parse(args.cams) : [];
for (const c of cams) {
  await send('camera', { state: { lon: c.at[0], lat: c.at[1], height: c.height, yaw: c.yaw, pitch: c.pitch, mode: 'fly' } });
  await wait(6000);
  await until((r) => r.terrain?.pending === 0 && (r.vector?.loading ?? 0) === 0, 300000);
  await wait(8000);
  await frames();
  await snap(c.name);
  console.log(`view ${c.name} taken`);
}

// B: flying along a line at speed (a camera step a second), the work as tiles stream in.
w = workerSessions();
await profileStart([w.render]);
await profileStart(w.codecs.slice(0, 2));
if (w.tunnels) await profileStart([w.tunnels]);
const fly = args.fly ? JSON.parse(args.fly) : null;
if (fly) {
  const n = Number(fly.seconds || 120);
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    await send('camera', { state: { lon: fly.from[0] + (fly.to[0] - fly.from[0]) * f, lat: fly.from[1] + (fly.to[1] - fly.from[1]) * f, height: fly.height, yaw: fly.yaw, pitch: fly.pitch, mode: 'fly' } });
    await wait(1000);
  }
}
q = await probe();
console.log(`B after ${((Date.now() - t0) / 1000).toFixed(0)} s: terrain ${q.terrain.drawn} drawn ${q.terrain.pending} pending; ${sections(q)}`);
await profileStop([w.render], 'B render worker (flying)');
await profileStop(w.codecs.slice(0, 2), 'B two decode workers (flying)');
if (w.tunnels) await profileStop([w.tunnels], 'B tunnels worker (flying)');
console.log(`tunnels: ${JSON.stringify({ tubes: q.tunnels?.tubes?.length, meshes: q.tunnels?.meshes, drawn: q.tunnels?.drawn, portals: q.tunnels?.portals?.length, failed: q.tunnels?.failed, jobs: q.tunnels?.jobs })}`);
console.log(`warnings/errors: ${logs.length}`, [...new Set(logs)].slice(0, 12).join('\n'));
ws.close();
await browser.close(); server.close(); process.exit(0);
