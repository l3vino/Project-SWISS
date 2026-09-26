/* bench-streaming.mjs — the streamers' bookkeeping cost per frame, in Node.
 *
 *   node tools/bench-streaming.mjs [--frames 6000] [--terrain-mb 24] [--building-mb 48]
 *                                  [--building-km 3] [--terrain-km 0.15] [--root <app folder>]
 *                                  [--cache <folder of saved tileset JSON>]
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
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

globalThis.GPUBufferUsage = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };

const { LAYER_JSON, encodeTerrainTile, height: groundHeight } = await import(`${ROOT}/tools/mock-data.mjs`);
const { instantiateCore } = await import(`${ROOT}/js/core/wasm.js`);
const { registry } = await import(`${ROOT}/js/adapters/index.js`);
const { Terrain, geometricError } = await import(`${ROOT}/js/engine/terrain/terrain.js`);
const { Tileset } = await import(`${ROOT}/js/engine/features/tileset.js`);
const { View } = await import(`${ROOT}/js/engine/view.js`);
const { Camera, FOV_Y } = await import(`${ROOT}/js/engine/camera.js`);
const { geodeticToEcef, enuBasis } = await import(`${ROOT}/js/core/math.js`);

/* ---- network: layer.json from the stand-in, building tilesets from swisstopo ---- */
const CACHE = args.cache ? args.cache.replace(/\/?$/, '/') : null;
if (CACHE) mkdirSync(CACHE, { recursive: true });
const realFetch = globalThis.fetch;
async function tilesetText(url) {
  const file = CACHE && CACHE + url.replace(/[^a-z0-9.]+/gi, '_');
  if (file && existsSync(file)) return readFileSync(file, 'utf8');
  const response = await realFetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const text = await response.text();
  if (file) writeFileSync(file, text);
  return text;
}
let parseMs = 0;
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.endsWith('/layer.json')) return { ok: true, status: 200, json: async () => structuredClone(LAYER_JSON) };
  if (url.includes('swissbuildings3d')) {
    const text = await tilesetText(url);
    return { ok: true, status: 200, json: async () => { const t = performance.now(); const v = JSON.parse(text); parseMs += performance.now() - t; return v; } };
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
  return {
    vertices: core.buffer.slice(vo, vo + vertexCount * 24), indices: core.buffer.slice(io, io + indexBytes),
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
    vertices: new ArrayBuffer(vertexCount * 12), indices: new ArrayBuffer(indexCount * 2),
    records: new Uint32Array(80), origin: [...origin], east: [...east], north: [...north], up: [...up],
    boxMin: [-120, -120, 0], boxMax: [120, 120, 40], encoding: 'draco', typesSeen: [],
    solid: solid ? { cells: 16, cellStart: new ArrayBuffer(257 * 4), cellTris: new ArrayBuffer(6000 * 4) } : null,
  };
}
let frameNo = 0;
const jobs = [];
const pool = {
  size: 5,
  run(type, payload) {
    return new Promise((resolve, reject) => jobs.push({ due: frameNo + LATENCY_FRAMES, type, payload, resolve, reject }));
  },
  deliver() {
    let n = 0;
    for (let i = 0; i < jobs.length && n < RESULTS_PER_FRAME; i++) {
      const j = jobs[i];
      if (j.due > frameNo) continue;
      jobs.splice(i--, 1);
      n++;
      try {
        if (j.type === 'terrain-tile') j.resolve(terrainTile(j.payload));
        else if (j.type === 'feature-tile') j.resolve(featureTile(j.payload));
        else j.resolve({ missing: true });
      } catch (err) { j.reject(err); }
    }
  },
};
const device = {
  createBuffer: ({ size }) => ({ size, destroy() {} }),
  queue: { writeBuffer() {} },
};
const features = { add: () => 0, remove() {}, version: 0 };

/* ---- the streamers ---- */
const terrain = new Terrain({ device, pool, registry, uploads: null, maxError: 2, budgetMB: TERRAIN_MB });
await terrain.prepare();
terrain.configure({ detailDistance: TERRAIN_KM * 1000, budgetMB: TERRAIN_MB });
const spec = registry.all[0].features[0];
const buildings = new Tileset({ device, pool, features, uploads: null,
  spec: { ...spec, id: 'swisstopo/buildings', setting: 'buildings' }, maxError: 10, budgetMB: BUILDING_MB });
await buildings.load();
buildings.configure({ enabled: true, detailDistance: BUILDING_KM * 1000, maxDistance: 15000, budgetMB: BUILDING_MB });

/* ---- the flight ---- */
const camera = new Camera({ lon: 9.0249, lat: 46.1907, height: 900, yaw: 0.9, pitch: -0.2 });
const view = new View();
const params = { viewHeight: 1080, fovY: FOV_Y, aspect: 16 / 9, near: 0.1 };
const times = { terrain: [], buildings: [] };
const tick = () => new Promise((r) => setImmediate(r));
const t0 = performance.now();
for (frameNo = 0; frameNo < FRAMES; frameNo++) {
  camera.translate(Math.sin(camera.yaw) * 1.25, Math.cos(camera.yaw) * 1.25, 0);
  camera.setHeight(groundHeight(camera.lon, camera.lat) + 350);
  camera.look(0.35, Math.sin(frameNo / 240) * 0.4, 0.0022, false);
  view.update(camera, params, terrain.finestAt(camera.lon, camera.lat)?.minHeight ?? 0);
  let t = performance.now();
  terrain.update(view);
  times.terrain.push(performance.now() - t);
  t = performance.now();
  buildings.update(view);
  times.buildings.push(performance.now() - t);
  pool.deliver();
  await tick(); await tick();
}
const wall = performance.now() - t0;

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const line = (name, a) => `${name.padEnd(9)} mean ${mean(a).toFixed(3)}  p50 ${pct(a, 0.5).toFixed(3)}  p95 ${pct(a, 0.95).toFixed(3)}  p99 ${pct(a, 0.99).toFixed(3)}  max ${Math.max(...a).toFixed(2)} ms`;
const late = (a) => a.slice(Math.floor(a.length / 2));
let nodes = 0; const count = (n) => { nodes++; n.children.forEach(count); }; count(buildings.root);
console.log(`${ROOT.split('/').pop()}: ${FRAMES} frames, terrain budget ${TERRAIN_MB} MB, buildings ${BUILDING_MB} MB at ${BUILDING_KM} km, wall ${(wall / 1000).toFixed(1)} s, tileset JSON parse ${parseMs.toFixed(0)} ms`);
console.log(line('terrain', times.terrain));
console.log(line('  2nd half', late(times.terrain)));
console.log(line('buildings', times.buildings));
console.log(line('  2nd half', late(times.buildings)));
const ts = terrain.stats, bs = buildings.stats;
console.log(`terrain: ${terrain.tiles.size} nodes, ${ts.ready} ready, ${(ts.bytes / 1048576).toFixed(1)} MB, drawn ${ts.drawn}, z${ts.minLevel}-${ts.maxLevel}` +
  (terrain.detailScale != null ? `, detail ×${terrain.detailScale.toFixed(2)}` : ''));
console.log(`buildings: ${nodes} nodes, ${bs.ready} ready, ${(bs.bytes / 1048576).toFixed(1)} MB (solid ${(bs.solidBytes / 1048576).toFixed(1)}), drawn ${bs.drawn}, pending ${bs.pending}` +
  (buildings.detailScale != null ? `, detail ×${buildings.detailScale.toFixed(2)}` : ''));
