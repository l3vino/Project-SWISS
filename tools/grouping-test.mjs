/* grouping-test.mjs — whether the tunnels' tubes come out the same whatever order the tiles arrive in (Stage 5.18i).
 *
 *   node tools/grouping-test.mjs --fetch    the Ceneri base tunnel's north end: the detail tiles (z14) within 5 km
 *                                           fetched (kept in .scratch/tilecache), their railway tunnel runs written to
 *                                           tools/fixtures/runs-ceneri-north.json
 *   node tools/grouping-test.mjs [orders]   the runs grouped as their tiles come in, in `orders` orders (50); once with
 *                                           all of them, their runs shuffled; and as up to 5.18h, each time with hints
 *                                           from the tubes before: how many different groupings of the junction come
 *                                           out, and which
 *
 * The tunnels thread (engine/tunnels/tunnels.js #runTubes) groups the runs of the detail tiles in at the time, at most
 * every GATHER_MS, with hints from whole tunnels traced (rank 2: not here, the trace reads z13 tiles). Up to 5.18h also
 * from its tubes before (rank 1): live over 7 loads the junction came out 4 ways, here 8 ways in 50 orders; 5.18i
 * (groups.js firstOf, backwards) 1 way.
 */

import fs from 'fs';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = new URL('../', import.meta.url);
const FIXTURE = new URL('tools/fixtures/runs-ceneri-north.json', ROOT);
const CACHE = new URL('.scratch/tilecache/vt/', ROOT);
const TILEJSON = 'https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/tiles.json';
/* The junction (the crossover between the tubes), and how far round it the detail tiles load (tunnels.js). */
export const JUNCTION = { lon: 8.9868, lat: 46.1546 };
const RADIUS = 5000;
const Z = 14;

const tileX = (lon, n) => Math.floor(((lon + 180) / 360) * n);
const tileY = (lat, n) => Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * n);

async function fetchFixture() {
  const { Core } = await import('../js/core/wasm.js');
  const { decodeVectorTile, schemaTables } = await import('../js/formats/vector-tile.js');
  const { TRANSPORT } = await import('../js/adapters/swisstopo-transport.js');
  const { tunnelRuns } = await import('../js/engine/tunnels/runs.js');
  const mod = new WebAssembly.Module(fs.readFileSync(new URL('wasm/core.wasm', ROOT)));
  const core = new Core(new WebAssembly.Instance(mod, {}));
  const kinds = schemaTables(TRANSPORT).kinds;
  const template = (await (await fetch(TILEJSON)).json()).tiles[0];
  const n = 2 ** Z, m = 111320 * Math.cos((JUNCTION.lat * Math.PI) / 180);
  const x0 = tileX(JUNCTION.lon - RADIUS / m, n), x1 = tileX(JUNCTION.lon + RADIUS / m, n);
  const y0 = tileY(JUNCTION.lat + RADIUS / 111132, n), y1 = tileY(JUNCTION.lat - RADIUS / 111132, n);
  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const file = new URL(`${Z}-${x}-${y}.pbf`, CACHE);
      let bytes;
      if (fs.existsSync(file)) bytes = fs.readFileSync(file);
      else {
        const res = await fetch(template.replace('{z}', Z).replace('{x}', x).replace('{y}', y));
        if (!res.ok) { console.log(`${Z}/${x}/${y}: ${res.status}`); continue; }
        bytes = Buffer.from(await res.arrayBuffer());
        fs.mkdirSync(CACHE, { recursive: true });
        fs.writeFileSync(file, bytes);
      }
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
      const r = decodeVectorTile(core, new Uint8Array(bytes), { z: Z, x, y, schema: TRANSPORT, margin: 2 });
      const runs = r.block ? tunnelRuns(r.block, Z, x, y, kinds).filter((q) => q.family === 2) : [];
      if (runs.length) {
        tiles.push({ tile: `${x}/${y}`, runs: runs.map((q) => ({ kind: q.kind, family: q.family, layer: q.layer, oneway: q.oneway,
          points: [...q.points].map((v) => Math.round(v * 1e7) / 1e7), ends: q.ends.map((e) => ({ type: e.type, degree: e.degree })) })) });
      }
    }
  }
  fs.writeFileSync(FIXTURE, JSON.stringify({ junction: JUNCTION, z: Z, tiles }));
  console.log(`${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles, ${tiles.length} with railway tunnels, ${tiles.reduce((s, t) => s + t.runs.length, 0)} runs → ${fileURLToPath(FIXTURE)} (${fs.statSync(FIXTURE).size} bytes)`);
}

/* A seeded random number generator (mulberry32), so a run can be repeated. */
export function seeded(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, rand) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* The fixture's tiles with their runs as runs.js gives them (Float64Array points). */
export function fixtureTiles(file = FIXTURE) {
  const { tiles } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return tiles.map((t) => ({ tile: t.tile, runs: t.runs.map((q) => ({ ...q, points: Float64Array.from(q.points) })) }));
}

/* tunnels.js #spineHints' rank 1: from each portal of a tube, the point HINT_IN (600 m) along it, 60% at most. */
export function hintsFrom(tubes, TUBE_END, TUBE_POINT) {
  const hints = [];
  for (const t of tubes) {
    for (let e = 0; e < 2; e++) {
      if (t.ends[e].type !== TUBE_END.PORTAL) continue;
      const p = t.points, n = p.length / TUBE_POINT, d = Math.min(600, 0.6 * t.length);
      const s = e === 0 ? d : p[(n - 1) * TUBE_POINT + 2] - d;
      for (let k = 0; k + 1 < n; k++) {
        const a = k * TUBE_POINT, b = a + TUBE_POINT;
        if (s < p[a + 2] || s > p[b + 2]) continue;
        const f = p[b + 2] > p[a + 2] ? (s - p[a + 2]) / (p[b + 2] - p[a + 2]) : 0;
        hints.push({ lon: p[a] + (p[b] - p[a]) * f, lat: p[a + 1] + (p[b + 1] - p[a + 1]) * f, rank: 1 });
        break;
      }
    }
  }
  return hints;
}

/* The junction's railway tubes as a signature: each tube within `near` metres of it by its key, its ends' types in
 * order and its length to 10 m. */
export function signature(tubes, near = 1500) {
  const m = 111320 * Math.cos((JUNCTION.lat * Math.PI) / 180);
  const close = (t) => {
    for (let i = 0; i < t.points.length; i += 5) if (Math.hypot((t.points[i] - JUNCTION.lon) * m, (t.points[i + 1] - JUNCTION.lat) * 111132) < near) return true;
    return false;
  };
  return tubes.filter((t) => t.family === 2 && close(t)).map((t) => `${t.key} ${t.ends.map((e) => e.type).join('/')} ${Math.round(t.length / 10) * 10}`).sort().join('; ');
}

/* The tubes at the end, the tiles coming in batches of 1 to 4 in a random order, each grouping with the hints of the
 * one before (as tunnels.js does). */
export function loadInOrder(tiles, rand, tubesFrom, TUBE_END, TUBE_POINT, { hints = true } = {}) {
  const order = shuffled(tiles, rand);
  let tubes = [];
  for (let k = 0; k < order.length;) {
    k = Math.min(order.length, k + 1 + Math.floor(rand() * 4));
    const runs = order.slice(0, k).flatMap((t) => t.runs);
    tubes = tubesFrom(runs, {}, hints ? hintsFrom(tubes, TUBE_END, TUBE_POINT) : []);
  }
  return tubes;
}

async function main() {
  if (process.argv.includes('--fetch')) return fetchFixture();
  const orders = Number(process.argv[2]) || 50;
  const { tubesFrom, TUBE_END, TUBE_POINT } = await import('../js/engine/tunnels/groups.js');
  const tiles = fixtureTiles();
  const count = (make) => {
    const seen = new Map();
    for (let i = 0; i < orders; i++) { const s = signature(make(seeded(i + 1))); seen.set(s, (seen.get(s) ?? 0) + 1); }
    return seen;
  };
  const report = (name, seen) => {
    console.log(`${name}: ${seen.size} grouping${seen.size === 1 ? '' : 's'} in ${orders} orders`);
    for (const [s, k] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${k}×  ${s}`);
  };
  report('tiles coming in, as the tunnels thread groups them (5.18i)', count((rand) => loadInOrder(tiles, rand, tubesFrom, TUBE_END, TUBE_POINT, { hints: false })));
  report('all tiles, their runs shuffled', count((rand) => tubesFrom(shuffled(tiles.flatMap((t) => t.runs), rand), {}, [])));
  report('tiles coming in, with hints from the tubes before (as up to 5.18h)', count((rand) => loadInOrder(tiles, rand, tubesFrom, TUBE_END, TUBE_POINT)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
