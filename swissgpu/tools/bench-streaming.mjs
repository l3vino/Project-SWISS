/* bench-streaming.mjs — the streamers' bookkeeping cost per frame, in Node.
 *
 *   node --expose-gc tools/bench-streaming.mjs [--frames 6000] [--terrain-mb 24] [--building-mb 48]
 *                                  [--building-km 3] [--terrain-km 0.15] [--root <app folder>]
 *                                  [--cache <folder of saved tileset JSON>] [--worst N] [--no-warmup]
 *
 * Never loaded by the app. Runs the app's own Terrain and Tileset classes
 * against the stand-in terrain (tiles of a realistic ~85 KB) and the real
 * swissBUILDINGS3D tileset tree (fetched from swisstopo, or read from
 * --cache), with a fake GPU and a fake decode pool whose results arrive a few
 * frames after they are asked for. A camera flies over Ticino at 150 m/s,
 * turning, at 120 simulated frames a second, with memory budgets the view
 * outgrows. Only the update() calls are timed: exactly the work the render
 * thread does per frame to decide what to draw, load and drop. `--root`
 * points at another copy of the app, to compare two versions.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const ROOT = args.root || fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const FRAMES = Number(args.frames || 6000);
const TERRAIN_MB = Number(args['terrain-mb'] || 24);
const BUILDING_MB = Number(args['building-mb'] || 48);
const BUILDING_KM = Number(args['building-km'] || 3);
const TERRAIN_KM = Number(args['terrain-km'] || 0.15);
const LATENCY_FRAMES = 6;        // request to result
const RESULTS_PER_FRAME = 6;     // what the pool can finish per frame
const GRID = 49;                 // mock terrain vertices per side

/* The app reads performance.now() for its own clocks (how fast the camera
 * moves, when a request went stale, time slices). Here simulated time runs
 * at 120 frames a second whatever the machine does between frames, and
 * really within a frame, so slices still end; timings use the real clock. */
const realNow = performance.now.bind(performance);
const FRAME_MS = 1000 / 120;
let simBase = 0, realBase = realNow();
performance.now = () => simBase + (realNow() - realBase);
const nextFrame = () => { simBase += FRAME_MS; realBase = realNow(); };

globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };

const { LAYER_JSON, encodeTerrainTile, height: groundHeight } = await import(`${ROOT}/tools/mock-data.mjs`);
const { instantiateCore } = await import(`${ROOT}/js/core/wasm.js`);
const { registry } = await import(`${ROOT}/js/adapters/index.js`);
const { Terrain, geometricError } = await import(`${ROOT}/js/engine/terrain/terrain.js`);
const { Tileset } = await import(`${ROOT}/js/engine/features/tileset.js`);
const { View } = await import(`${ROOT}/js/engine/view.js`);
const { Camera, FOV_Y } = await import(`${ROOT}/js/engine/camera.js`);
const { geodeticToEcef, enuBasis } = await import(`${ROOT}/js/core/math.js`);
// Builds before Stage 5 had no scheduler and parsed tileset files themselves.
const { Scheduler } = existsSync(`${ROOT}/js/core/scheduler.js`) ? await import(`${ROOT}/js/core/scheduler.js`) : {};
const { buildIndex } = existsSync(`${ROOT}/js/formats/tileset-index.js`) ? await import(`${ROOT}/js/formats/tileset-index.js`) : {};
// Builds from Stage 5 on fill buffers that come back once uploaded (core/buffer-pool.js).
const { BufferPool } = existsSync(`${ROOT}/js/core/buffer-pool.js`) ? await import(`${ROOT}/js/core/buffer-pool.js`) : {};
const spare = BufferPool ? new BufferPool() : null;
const handOver = (bytes, Type = Uint8Array) => (spare
  ? new Type(spare.take(bytes), 0, bytes / Type.BYTES_PER_ELEMENT)
  : new Type(bytes / Type.BYTES_PER_ELEMENT));
const tick = () => new Promise((r) => setImmediate(r));

/* ---- network: layer.json from the stand-in, building tilesets from swisstopo ---- */
const CACHE = args.cache ? args.cache.replace(/\/?$/, '/') : null;
if (CACHE) mkdirSync(CACHE, { recursive: true });
const realFetch = globalThis.fetch;
/* The file saved for a URL in --cache, fetched there first if need be, or
 * null without a cache. */
function cachedFile(url) {
  const file = CACHE && CACHE + url.replace(/[^a-z0-9.]+/gi, '_');
  if (!file) return null;
  if (existsSync(file)) return file;
  // curl honours the sandbox's proxy, which Node's fetch does not.
  try {
    execFileSync('curl', ['-sSf', '--compressed', '-o', file, url], { stdio: 'ignore' });
    return file;
  } catch { return null; }
}
async function tilesetText(url) {
  const file = cachedFile(url);
  if (file) return readFileSync(file, 'utf8');
  const response = await realFetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}
// Render-thread work done outside update(): the old build parsed tileset
// JSON there (through this fetch) and built every tile object at once.
let parseMs = 0;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.endsWith('/layer.json')) return { ok: true, status: 200, json: async () => structuredClone(LAYER_JSON) };
  if (url.includes('swissbuildings3d')) {
    const text = await tilesetText(url);
    return { ok: true, status: 200, json: async () => { const t = realNow(); const v = JSON.parse(text); parseMs += realNow() - t; return v; } };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

/* ---- the decode pool: real terrain decode, synthetic building content ---- */
const core = instantiateCore(new WebAssembly.Module(readFileSync(`${ROOT}/wasm/core.wasm`)));
const skirtFor = (z) => Math.min(2000, Math.max(2, 5 * geometricError(z)));
const encoded = new Map();
const decoder = new TextDecoder();
function terrainTile({ url, rect }) {
  const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.terrain/);
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const key = `${z}/${x}/${y}`;
  let bytes = encoded.get(key);
  if (bytes === undefined) { bytes = encodeTerrainTile(z, x, y, GRID); encoded.set(key, bytes); }
  if (!bytes) return { missing: true };
  core.reset();
  const src = core.write(bytes);
  const size = core.exports.qm_result_size();
  const out = core.alloc(size);
  const status = core.exports.qm_decode(src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north, skirtFor(z), out);
  core.sync();
  if (status !== 0) throw new Error(`decode ${status}`);
  const r = new DataView(core.buffer, out, size);
  const vertexCount = r.getUint32(64, true), indexCount = r.getUint32(68, true);
  const vo = r.getUint32(72, true), io = r.getUint32(76, true), u32 = r.getUint32(80, true) === 1;
  let available = null;
  const metaLength = r.getUint32(92, true);
  if (metaLength > 0) {
    const mo = r.getUint32(88, true);
    available = JSON.parse(decoder.decode(core.u8.subarray(mo, mo + metaLength))).available ?? null;
  }
  const indexBytes = (indexCount * (u32 ? 4 : 2) + 3) & ~3;
  const copyOut = (at, n) => (spare ? spare.copy(core.u8.subarray(at, at + n)) : core.buffer.slice(at, at + n));
  return {
    vertices: copyOut(vo, vertexCount * 24), indices: copyOut(io, indexBytes),
    indexCount, indexIsU32: u32,
    origin: [r.getFloat64(0, true), r.getFloat64(8, true), r.getFloat64(16, true)],
    radius: r.getFloat64(48, true), minHeight: r.getFloat32(56, true), maxHeight: r.getFloat32(60, true),
    serverNormals: r.getUint32(96, true) === 1, available, acceptRejected: false,
  };
}
function featureTile({ frame, solid }) {
  const vertexCount = 6000, indexCount = 18000;
  const origin = new Float64Array(3), east = new Float64Array(3), north = new Float64Array(3), up = new Float64Array(3);
  geodeticToEcef(frame.lon, frame.lat, frame.height, origin);
  enuBasis(frame.lon, frame.lat, east, north, up);
  return {
    vertexCount, indexCount, indexFormat: 'uint16',
    vertices: handOver(vertexCount * 12), indices: handOver(indexCount * 2),
    records: handOver(80 * 4, Uint32Array), origin: [...origin], east: [...east], north: [...north], up: [...up],
    boxMin: [-120, -120, 0], boxMax: [120, 120, 40], encoding: 'draco', typesSeen: [],
    solid: solid ? { cells: 16, cellStart: new ArrayBuffer(257 * 4), cellTris: new ArrayBuffer(6000 * 4) } : null,
  };
}
// Decode-thread work the new build moved off the render thread. It runs on
// a thread of its own here too, as in the app: the 10 MB of JSON behind each
// index would otherwise be collected during the timed frames of this thread.
let indexMs = 0, indexFiles = 0;
let indexWorker = null, indexCalls = 0;
const indexReplies = new Map();
function buildElsewhere(file, options) {
  if (!indexWorker) {
    indexWorker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { readFileSync } = require('node:fs');
      import(workerData).then(({ buildIndex, indexBuffers }) => parentPort.on('message', ({ id, file, options }) => {
        const text = readFileSync(file, 'utf8');
        const t = performance.now();
        const index = buildIndex(JSON.parse(text), options);
        parentPort.postMessage({ id, index, ms: performance.now() - t }, indexBuffers(index));
      }));`, { eval: true, workerData: pathToFileURL(`${ROOT}/js/formats/tileset-index.js`).href });
    indexWorker.on('message', ({ id, index, ms }) => {
      indexReplies.get(id)({ index, ms });
      indexReplies.delete(id);
      if (!indexReplies.size) indexWorker.unref();
    });
  }
  indexWorker.ref();
  const id = ++indexCalls;
  return new Promise((resolve) => { indexReplies.set(id, resolve); indexWorker.postMessage({ id, file, options }); });
}
async function tilesetIndex({ url, transform, refine, geometricError: error }) {
  const options = { transform, refine, geometricError: error };
  const file = cachedFile(url);
  let index, ms;
  if (file) ({ index, ms } = await buildElsewhere(file, options));
  else {
    const text = await tilesetText(url);
    const t = realNow();
    index = buildIndex(JSON.parse(text), options);
    ms = realNow() - t;
  }
  indexMs += ms;
  indexFiles++;
  index.validator = 'bench';
  index.cached = false;
  return index;
}
let frameNo = 0;
const jobs = [];
const pool = {
  size: 5,
  counts: {},
  // What the streamers are done with goes back to be filled again.
  recycle(buffers) { for (const b of buffers) spare?.give(b); },
  run(type, payload, { signal } = {}) {
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    return new Promise((resolve, reject) => {
      const job = { due: frameNo + LATENCY_FRAMES, type, payload, resolve, reject };
      jobs.push(job);
      signal?.addEventListener('abort', () => {
        const i = jobs.indexOf(job);
        if (i >= 0) jobs.splice(i, 1);
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      }, { once: true });
    });
  },
  /* Decodes what is due and returns the answers, for the frame loop to
   * hand over. `work` is how long the decoding took: decode-thread work,
   * which the frame loop takes out of its timing. */
  work: 0,
  async due() {
    const out = [], start = realNow();
    for (let i = 0; i < jobs.length && out.length < RESULTS_PER_FRAME; i++) {
      const j = jobs[i];
      if (j.due > frameNo) continue;
      jobs.splice(i--, 1);
      try {
        if (j.type === 'terrain-tile') out.push([j.resolve, terrainTile(j.payload)]);
        else if (j.type === 'feature-tile') out.push([j.resolve, featureTile(j.payload)]);
        else if (j.type === 'tileset-index') out.push([j.resolve, await tilesetIndex(j.payload)]);
        else out.push([j.resolve, { missing: true }]);
      } catch (err) { out.push([j.reject, err]); }
    }
    this.work = realNow() - start;
    return out;
  },
};
const device = {
  createBuffer: ({ size }) => ({ size, destroy() {} }),
  queue: { writeBuffer() {} },
};
const features = { add: () => 0, remove() {}, version: 0 };

/* ---- the streamers: through the scheduler where the version has one ---- */
async function streamers() {
  const scheduler = Scheduler ? new Scheduler(pool) : null;
  const feed = scheduler ? { scheduler } : { pool };
  const terrain = new Terrain({ device, ...feed, registry, uploads: null, maxError: 2, budgetMB: TERRAIN_MB });
  await terrain.prepare();
  terrain.configure({ detailDistance: TERRAIN_KM * 1000, budgetMB: TERRAIN_MB });
  const spec = registry.all[0].features[0];
  const buildings = new Tileset({ device, ...feed, features, uploads: null,
    spec: { ...spec, id: 'swisstopo/buildings', setting: 'buildings' }, maxError: 10, budgetMB: BUILDING_MB });
  const loading = buildings.load();
  for (let i = 0; i < 1000 && !buildings.root; i++) {
    frameNo += LATENCY_FRAMES;
    for (const [settle, value] of await pool.due()) settle(value);
    await tick(); await tick();
  }
  await loading;
  buildings.configure({ enabled: true, detailDistance: BUILDING_KM * 1000, maxDistance: 15000, budgetMB: BUILDING_MB });
  return { scheduler, terrain, buildings };
}

/* ---- the flight ---- */
async function fly({ scheduler, terrain, buildings }, times) {
  const camera = new Camera({ lon: 9.0249, lat: 46.1907, height: 900, yaw: 0.9, pitch: -0.2 });
  const view = new View();
  const params = { viewHeight: 1080, fovY: FOV_Y, aspect: 16 / 9, near: 0.1 };
  for (frameNo = 0; frameNo < FRAMES; frameNo++) {
    nextFrame();
    camera.translate(Math.sin(camera.yaw) * 1.25, Math.cos(camera.yaw) * 1.25, 0);
    camera.setHeight(groundHeight(camera.lon, camera.lat) + 350);
    camera.look(0.35, Math.sin(frameNo / 240) * 0.4, 0.0022, false);
    view.update(camera, params, terrain.finestAt(camera.lon, camera.lat)?.minHeight ?? 0);
    const f0 = realNow();
    terrain.update(view);
    const a = realNow();
    buildings.update(view);
    const b = realNow();
    scheduler?.dispatch();
    const c = realNow();
    // Results handed back, and what the streamers do with them (the old build
    // parsed tileset files and built their tiles here, as its fetches came back).
    const t = realNow();
    const answers = await pool.due();
    for (const [settle, value] of answers) settle(value);
    await tick(); await tick();
    const arrivals = realNow() - t - pool.work;
    if (!times) continue;
    times.terrain.push(a - f0);
    times.buildings.push(b - a);
    times.requests.push(c - b);
    times.arrivals.push(arrivals);
    times.frame.push((c - f0) + arrivals);
  }
}

/* A first flight, untimed, makes the stand-in terrain tiles: the mock
 * encoder allocates about a megabyte per tile, and that garbage would land
 * in the timed frames as collection pauses that the real render thread,
 * whose tiles are made on other threads, never sees. The timed flight then
 * starts from nothing again, with only the stand-in's tiles kept. */
if (!args['no-warmup']) {
  await fly(await streamers(), null);
  jobs.length = 0;
  parseMs = indexMs = indexFiles = 0;
  pool.counts = {};
  globalThis.gc?.();   // with node --expose-gc: the first flight's leftovers go now
}
const { scheduler, terrain, buildings } = await streamers();
const times = { terrain: [], buildings: [], requests: [], arrivals: [], frame: [] };
const t0 = realNow();
await fly({ scheduler, terrain, buildings }, times);
const wall = realNow() - t0;

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const line = (name, a) => `${name.padEnd(9)} mean ${mean(a).toFixed(3)}  p50 ${pct(a, 0.5).toFixed(3)}  p95 ${pct(a, 0.95).toFixed(3)}  p99 ${pct(a, 0.99).toFixed(3)}  max ${Math.max(...a).toFixed(2)} ms`;
const late = (a) => a.slice(Math.floor(a.length / 2));
let nodes = 0; const count = (n) => { nodes++; (n.children || []).forEach(count); }; count(buildings.root);
console.log(`${ROOT.split('/').pop()}: ${FRAMES} frames, terrain budget ${TERRAIN_MB} MB, buildings ${BUILDING_MB} MB at ${BUILDING_KM} km, wall ${(wall / 1000).toFixed(1)} s`);
console.log(`tileset files: ${scheduler ? `${indexFiles} indexed on the decode threads in ${indexMs.toFixed(0)} ms (parse included)` : `parsed on the render thread in ${parseMs.toFixed(0)} ms`}`);
console.log(line('terrain', times.terrain));
console.log(line('  2nd half', late(times.terrain)));
console.log(line('buildings', times.buildings));
console.log(line('  2nd half', late(times.buildings)));
console.log(line('requests', times.requests));
console.log(line('arrivals', times.arrivals));
console.log(line('all', times.frame));
console.log(`frames over 4 ms: ${times.frame.filter((v) => v > 4).length}, over 2 ms: ${times.frame.filter((v) => v > 2).length}`);
// --worst N: the N slowest frames, section by section.
if (args.worst) {
  const order = times.frame.map((v, i) => i).sort((a, b) => times.frame[b] - times.frame[a]).slice(0, Number(args.worst));
  for (const i of order) {
    console.log(`  frame ${i}: ${times.frame[i].toFixed(2)} ms = terrain ${times.terrain[i].toFixed(2)} + buildings ${times.buildings[i].toFixed(2)} + ` +
      `requests ${times.requests[i].toFixed(2)} + arrivals ${times.arrivals[i].toFixed(2)}`);
  }
}
const ts = terrain.stats, bs = buildings.stats;
console.log(`terrain: ${terrain.tiles.size} nodes, ${ts.ready} ready, ${(ts.bytes / 1048576).toFixed(1)} MB, drawn ${ts.drawn}, z${ts.minLevel}-${ts.maxLevel}` +
  (terrain.detailScale != null ? `, detail ×${terrain.detailScale.toFixed(2)}` : ''));
console.log(`buildings: ${nodes} nodes, ${bs.ready} ready, ${(bs.bytes / 1048576).toFixed(1)} MB (solid ${(bs.solidBytes / 1048576).toFixed(1)}), drawn ${bs.drawn}, pending ${bs.pending}` +
  (buildings.detailScale != null ? `, detail ×${buildings.detailScale.toFixed(2)}` : '') +
  (bs.deferred != null ? `, held back ${bs.deferred}, skipped ${bs.skipped}` : ''));
console.log(`decode jobs: ${Object.entries(pool.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (scheduler) {
  const r = scheduler.stats;
  console.log(`requests: started ${r.started}, cancelled ${r.cancelled} (stale ${r.stale}), in flight at the end ${scheduler.active}/${scheduler.capacity}`);
}
