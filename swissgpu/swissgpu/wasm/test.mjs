/* test.mjs — checks the native core against double-precision references.
 *
 *   node wasm/test.mjs
 *
 * Builds a synthetic quantized-mesh tile, decodes it, and compares every
 * vertex against the same computation done in JavaScript doubles. Then builds
 * the ground index over an irregular tile and checks every lookup against a
 * brute-force search over all of its triangles. Last, places and packs a
 * building mesh the way 3D Tiles content arrives, against a double-precision
 * reference, and checks that hidden buildings' triangles are dropped.
 */
import fs from 'fs';
import { geodeticToEcef } from '../js/core/math.js';

const mod = new WebAssembly.Module(fs.readFileSync(new URL('./core.wasm', import.meta.url)));
const ex = new WebAssembly.Instance(mod, {}).exports;
ex.arena_init();
console.log('selftest', ex.core_selftest(), '| result size', ex.qm_result_size(), '| stride', ex.qm_vertex_stride());

/* ---- 1. trig kernels against the reference ---- */
let maxSin = 0, maxCos = 0;
for (let i = 0; i <= 200000; i++) {
  const x = -Math.PI + (2 * Math.PI * i) / 200000;
  maxSin = Math.max(maxSin, Math.abs(ex.math_sin(x) - Math.sin(x)));
  maxCos = Math.max(maxCos, Math.abs(ex.math_cos(x) - Math.cos(x)));
}
console.log('max |sin err|', maxSin.toExponential(2), ' max |cos err|', maxCos.toExponential(2));

/* ---- 2. build a synthetic quantized-mesh tile ---- */
const N = 5;                                   // N x N vertex grid
const west = 8.6132812500, south = 46.0664062500;
const east = 8.7890625000, north = 46.2421875000;
const minH = 200, maxH = 2400;
const QMAX = 32767;

const uq = [], vq = [], hq = [];
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  uq.push(Math.round((i / (N - 1)) * QMAX));
  vq.push(Math.round((j / (N - 1)) * QMAX));
  hq.push(Math.round(((i * 7 + j * 13) % 11 / 10) * QMAX));
}
// Counter-clockwise seen from above, as real tiles are wound.
const tris = [];
for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
  const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
  tris.push(a, b, c, b, d, c);
}
const centre = geodeticToEcef((west + east) / 2, (south + north) / 2, (minH + maxH) / 2);

const zig = (arr) => { let prev = 0; return arr.map(v => { const d = v - prev; prev = v; return ((d << 1) ^ (d >> 31)) & 0xffff; }); };
const highWater = (idx) => { let hi = 0; return idx.map(v => { const code = hi - v; if (code === 0) hi++; return code; }); };

const edges = {
  west:  [...uq.keys()].filter(k => uq[k] === 0),
  south: [...uq.keys()].filter(k => vq[k] === 0),
  east:  [...uq.keys()].filter(k => uq[k] === QMAX),
  north: [...uq.keys()].filter(k => vq[k] === QMAX),
};

/* Optional extensions, appended the way a server does: oct normals as bytes
 * (a fixed, recognisable direction per vertex) and a metadata JSON. */
const serverOct = uq.map((_, k) => [(k * 37 + 11) % 256, (k * 91 + 200) % 256]);
const metadataJson = JSON.stringify({ available: [[{ startX: 1, startY: 2, endX: 3, endY: 4 }]] });

function encodeTile({ normals = false, metadata = false } = {}) {
  const size = 88 + 4 + N * N * 6 + 4 + tris.length * 2
    + Object.values(edges).reduce((s, e) => s + 4 + e.length * 2, 0)
    + (normals ? 5 + N * N * 2 : 0) + (metadata ? 5 + 4 + metadataJson.length : 0);
  const buf = new ArrayBuffer(size + 8);
  const dv = new DataView(buf);
  let o = 0;
  const f64 = v => { dv.setFloat64(o, v, true); o += 8; };
  const f32 = v => { dv.setFloat32(o, v, true); o += 4; };
  const u32 = v => { dv.setUint32(o, v, true); o += 4; };
  const u16 = v => { dv.setUint16(o, v, true); o += 2; };
  const u8 = v => { dv.setUint8(o, v); o += 1; };

  f64(centre[0]); f64(centre[1]); f64(centre[2]);      // centre
  f32(minH); f32(maxH);
  f64(centre[0]); f64(centre[1]); f64(centre[2]);      // bounding sphere centre
  f64(9000);                                            // radius
  f64(0); f64(0); f64(1);                               // horizon occlusion point
  u32(N * N);
  for (const a of [zig(uq), zig(vq), zig(hq)]) for (const v of a) u16(v);
  u32(tris.length / 3);
  for (const v of highWater(tris)) u16(v);
  for (const e of [edges.west, edges.south, edges.east, edges.north]) { u32(e.length); for (const v of e) u16(v); }
  if (normals) { u8(1); u32(N * N * 2); for (const [x, y] of serverOct) { u8(x); u8(y); } }
  if (metadata) {
    u8(4); u32(4 + metadataJson.length); u32(metadataJson.length);
    for (let i = 0; i < metadataJson.length; i++) u8(metadataJson.charCodeAt(i));
  }
  return new Uint8Array(buf, 0, o);
}

function decode(bytes, skirt = 0) {
  ex.arena_reset();
  const src = ex.arena_alloc(bytes.length);
  new Uint8Array(ex.memory.buffer).set(bytes, src);
  const res = ex.arena_alloc(ex.qm_result_size());
  const status = ex.qm_decode(src, bytes.length, west, south, east, north, skirt, res);
  return { status, res, mem: ex.memory.buffer };
}

/* ---- 3. decode ---- */
const { status, res, mem } = decode(encodeTile());
console.log('decode status', status, '(0 = ok)');

const R = new DataView(mem, res, ex.qm_result_size());
const origin = [R.getFloat64(0, true), R.getFloat64(8, true), R.getFloat64(16, true)];
const vCount = R.getUint32(64, true), iCount = R.getUint32(68, true);
const vOff = R.getUint32(72, true), iOff = R.getUint32(76, true), wide = R.getUint32(80, true);
console.log(`vertices ${vCount} (mesh ${N * N} + skirt ${vCount - N * N}), indices ${iCount}, u32 indices: ${!!wide}`);

/* ---- 4. positions against a double-precision reference ---- */
let maxErr = 0;
const vb = new DataView(mem, vOff, vCount * 24);
for (let k = 0; k < N * N; k++) {
  const lon = west + (uq[k] / QMAX) * (east - west);
  const lat = south + (vq[k] / QMAX) * (north - south);
  const h = minH + (hq[k] / QMAX) * (maxH - minH);
  const want = geodeticToEcef(lon, lat, h);
  const got = [vb.getFloat32(k * 24, true), vb.getFloat32(k * 24 + 4, true), vb.getFloat32(k * 24 + 8, true)];
  maxErr = Math.max(maxErr, Math.hypot(...got.map((g, i) => g + origin[i] - want[i])));
}
console.log('max position error', maxErr.toFixed(6), 'm  (float32 spacing at this radius is ~0.5 m)');

/* ---- 5. normals and skirts ---- */
let minLen = 2, maxLen = 0, skirtOk = true;
for (let k = 0; k < vCount; k++) {
  let ox = vb.getInt16(k * 24 + 12, true) / 32767, oy = vb.getInt16(k * 24 + 14, true) / 32767;
  let z = 1 - Math.abs(ox) - Math.abs(oy);
  if (z < 0) { const t = ox; ox = (1 - Math.abs(oy)) * Math.sign(t); oy = (1 - Math.abs(t)) * Math.sign(oy); }
  const len = Math.hypot(ox, oy, z);
  minLen = Math.min(minLen, len); maxLen = Math.max(maxLen, len);
}
for (let k = N * N; k < vCount; k++) {
  const r = Math.hypot(vb.getFloat32(k * 24, true) + origin[0],
                       vb.getFloat32(k * 24 + 4, true) + origin[1],
                       vb.getFloat32(k * 24 + 8, true) + origin[2]);
  const flag = vb.getUint16(k * 24 + 22, true);
  if (flag !== 65535 || r > Math.hypot(...origin) + maxH) skirtOk = false;
}
console.log('oct normal length range', minLen.toFixed(4), '-', maxLen.toFixed(4), '(before renormalising)');
console.log('skirt vertices flagged and below the surface:', skirtOk);

/* ---- 6. indices in range ---- */
const idx = wide ? new Uint32Array(mem, iOff, iCount) : new Uint16Array(mem, iOff, iCount);
let bad = 0;
for (const v of idx) if (v >= vCount) bad++;
console.log('out-of-range indices:', bad);
console.log('arena used', (ex.arena_used() / 1024).toFixed(1), 'KB for a', N * N, 'vertex tile');

/* ---- 6b. winding: the surface faces up and every curtain faces outward,
 * which is what lets the renderer cull back faces ---- */
{
  const P = (k) => [0, 1, 2].map((i) => vb.getFloat32(k * 24 + i * 4, true) + origin[i]);
  const up = origin.map((c) => c / Math.hypot(...origin));
  let surfaceDown = 0, curtainsIn = 0, curtains = 0;
  for (let t = 0; t < iCount; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map(P);
    const e1 = b.map((v, i) => v - a[i]), e2 = c.map((v, i) => v - a[i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const isCurtain = [idx[t], idx[t + 1], idx[t + 2]].some((k) => k >= N * N);
    if (!isCurtain) { if (n[0] * up[0] + n[1] * up[1] + n[2] * up[2] <= 0) surfaceDown++; continue; }
    curtains++;
    // Outward: away from the tile's centre line, measured horizontally.
    const mid = [0, 1, 2].map((i) => (a[i] + b[i] + c[i]) / 3 - origin[i]);
    const along = mid[0] * up[0] + mid[1] * up[1] + mid[2] * up[2];
    const flat = mid.map((v, i) => v - along * up[i]);
    if (n[0] * flat[0] + n[1] * flat[1] + n[2] * flat[2] <= 0) curtainsIn++;
  }
  console.log(`winding: ${surfaceDown} surface triangles face down, ${curtainsIn} of ${curtains} curtain triangles face inward`);
}

/* ---- 6c. extensions: the tile's own normals and its metadata ---- */
{
  const { status: st, res: r, mem: m } = decode(encodeTile({ normals: true, metadata: true }), 7.5);
  const D = new DataView(m, r, ex.qm_result_size());
  const vOff2 = D.getUint32(72, true), n2 = D.getUint32(64, true);
  const metaOff = D.getUint32(88, true), metaLen = D.getUint32(92, true), server = D.getUint32(96, true);
  const vb2 = new DataView(m, vOff2, n2 * 24);

  // Reference: the specification's decode of the byte pair, against ours of
  // the signed 16-bit pair the C side wrote.
  const octDecode = (x, y) => {
    let z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) { const t = x; x = (1 - Math.abs(y)) * (t >= 0 ? 1 : -1); y = (1 - Math.abs(t)) * (y >= 0 ? 1 : -1); }
    const l = Math.hypot(x, y, z); return [x / l, y / l, z / l];
  };
  let worst = 0;
  for (let k = 0; k < N * N; k++) {
    const want = octDecode(serverOct[k][0] / 255 * 2 - 1, serverOct[k][1] / 255 * 2 - 1);
    const got = octDecode(vb2.getInt16(k * 24 + 12, true) / 32767, vb2.getInt16(k * 24 + 14, true) / 32767);
    worst = Math.max(worst, Math.acos(Math.min(1, want[0] * got[0] + want[1] * got[1] + want[2] * got[2])));
  }
  const text = new TextDecoder().decode(new Uint8Array(m, metaOff, metaLen));
  console.log(`extensions: status ${st}, server normals ${server === 1}, worst normal error ${(worst * 180 / Math.PI).toFixed(4)}°, ` +
    `metadata ${text === metadataJson ? 'read back exactly' : 'WRONG: ' + text}`);

  // A skirt asked for 7.5 m hangs exactly 7.5 m below its edge vertex.
  const o2 = [D.getFloat64(0, true), D.getFloat64(8, true), D.getFloat64(16, true)];
  const radius = (k) => Math.hypot(...[0, 1, 2].map((i) => vb2.getFloat32(k * 24 + i * 4, true) + o2[i]));
  const w0 = edges.west[0];
  console.log(`skirt drop: ${(radius(w0) - radius(N * N)).toFixed(3)} m (asked for 7.500)`);
}

/* ---- 7. ground index: the grid must find exactly what brute force finds ---- */
{
  const { groundEntry, sampleEntry } = await import('../js/engine/terrain/ground.js');

  // An irregular network: a 41 x 41 grid with interior vertices jittered, so
  // triangles have uneven sizes and orientations like a real tile.
  const G = 41;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const gu = [], gv = [], gh = [];
  const step = QMAX / (G - 1);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const interior = i > 0 && j > 0 && i < G - 1 && j < G - 1;
    gu.push(Math.round(i * step + (interior ? (rand() - 0.5) * 0.6 * step : 0)));
    gv.push(Math.round(j * step + (interior ? (rand() - 0.5) * 0.6 * step : 0)));
    gh.push(Math.round(QMAX * (0.5 + 0.5 * Math.sin(i * 0.37) * Math.cos(j * 0.23))));
  }
  const gt = [];
  for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) {
    const a = j * G + i, b = a + 1, c = a + G, d = c + 1;
    gt.push(a, c, b, b, c, d);
  }
  const bytes2 = new Uint8Array(88 + 4 + G * G * 6 + 4 + gt.length * 2 + 16);
  const d2 = new DataView(bytes2.buffer);
  let q = 0;
  d2.setFloat32(24, 300, true); d2.setFloat32(28, 3300, true);    // height range
  q = 88;
  d2.setUint32(q, G * G, true); q += 4;
  for (const a of [zig(gu), zig(gv), zig(gh)]) for (const v of a) { d2.setUint16(q, v, true); q += 2; }
  d2.setUint32(q, gt.length / 3, true); q += 4;
  for (const v of highWater(gt)) { d2.setUint16(q, v, true); q += 2; }

  ex.arena_reset();
  const s2 = ex.arena_alloc(bytes2.length);
  new Uint8Array(ex.memory.buffer).set(bytes2, s2);
  const r2 = ex.arena_alloc(ex.qm_ground_size());
  const st = ex.qm_ground(s2, bytes2.length, r2);
  const R2 = new DataView(ex.memory.buffer, r2, 64);
  const n = R2.getUint32(8, true), tc = R2.getUint32(12, true), grid = R2.getUint32(28, true);
  const wide = R2.getUint32(24, true) === 1;
  const copy = (off, len) => ex.memory.buffer.slice(off, off + len);
  const data = {
    minHeight: R2.getFloat32(0, true), maxHeight: R2.getFloat32(4, true),
    vertexCount: n, indexIsU32: wide, grid,
    uvh: copy(R2.getUint32(16, true), n * 6),
    indices: copy(R2.getUint32(20, true), tc * 3 * (wide ? 4 : 2)),
    cellStart: copy(R2.getUint32(32, true), (grid * grid + 1) * 4),
    cellTris: copy(R2.getUint32(36, true), R2.getUint32(40, true) * 4),
  };
  console.log(`ground status ${st} | ${n} vertices, ${tc} triangles, ${grid}x${grid} grid, ` +
    `${R2.getUint32(40, true)} cell entries, ${(ex.arena_used() / 1024).toFixed(0)} KB arena`);

  const rect = { west, south, east, north };
  const entry = groundEntry(data, rect);

  // Brute force over every triangle, from the original, un-encoded arrays.
  const heightAt = (lon, lat) => {
    const pu = ((lon - west) / (east - west)) * QMAX, pv = ((lat - south) / (north - south)) * QMAX;
    for (let t = 0; t < gt.length; t += 3) {
      const [a, b, c] = [gt[t], gt[t + 1], gt[t + 2]];
      const dd = (gv[b] - gv[c]) * (gu[a] - gu[c]) + (gu[c] - gu[b]) * (gv[a] - gv[c]);
      const w0 = ((gv[b] - gv[c]) * (pu - gu[c]) + (gu[c] - gu[b]) * (pv - gv[c])) / dd;
      const w1 = ((gv[c] - gv[a]) * (pu - gu[c]) + (gu[a] - gu[c]) * (pv - gv[c])) / dd;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-9 && w1 >= -1e-9 && w2 >= -1e-9) {
        return 300 + (w0 * gh[a] + w1 * gh[b] + w2 * gh[c]) * (3000 / QMAX);
      }
    }
    return NaN;
  };

  const out = {};
  let worst = 0, misses = 0;
  for (let k = 0; k < 20000; k++) {
    const lon = west + rand() * (east - west), lat = south + rand() * (north - south);
    if (!sampleEntry(entry, lon, lat, out)) { misses++; continue; }
    worst = Math.max(worst, Math.abs(out.height - heightAt(lon, lat)));
  }
  // Exactly on vertices, where the rounding of shared edges is hardest.
  for (let k = 0; k < gu.length; k += 7) {
    const lon = west + (gu[k] / QMAX) * (east - west), lat = south + (gv[k] / QMAX) * (north - south);
    if (!sampleEntry(entry, lon, lat, out)) { misses++; continue; }
    worst = Math.max(worst, Math.abs(out.height - (300 + gh[k] * (3000 / QMAX))));
  }
  console.log(`ground lookups: worst difference from brute force ${worst.toExponential(2)} m, misses ${misses}`);

  // A walking camera asks from nearly the same spot every frame.
  let lon = west + 0.3 * (east - west), lat = south + 0.4 * (north - south);
  const t0 = performance.now();
  for (let k = 0; k < 200000; k++) { lon += 1e-7; sampleEntry(entry, lon, lat, out); }
  console.log(`walking lookup cost: ${((performance.now() - t0) * 1000 / 200000).toFixed(3)} µs per query`);

  // Slope sanity: a tilted plane must report its own gradient.
  const plane = groundEntry({ ...data }, rect);
  plane.h = plane.u.map((u) => Math.round(u * 0.5)).map((x) => x);   // rises eastward only
  sampleEntry(plane, west + 0.5 * (east - west), south + 0.5 * (north - south), out);
  const expected = (0.5 * plane.heightScale) / plane.metresPerU;
  console.log(`plane slope: east ${out.gradE.toFixed(5)} (expected ${expected.toFixed(5)}), north ${out.gradN.toFixed(5)} (expected 0)`);
}

/* ---- 8. building meshes (mesh.c): placement, 12-byte packing, hidden kinds ---- */
{
  const { mat4d, Y_UP_TO_Z_UP, enuBasis: enu } = await import('../js/core/math.js');
  // A model in glTF's y-up frame around an earth-centred centre near Locarno,
  // as a b3dm with an RTC centre holds it: random points in a 400 m block.
  const centre = geodeticToEcef(8.79, 46.17, 300);
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const count = 3000;
  const model = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) model[i] = (rand() - 0.5) * 400;
  const placement = mat4d.multiply(mat4d.translation(centre[0], centre[1], centre[2]), Y_UP_TO_Z_UP);
  const frame = { lon: 8.79, lat: 46.17, height: 250 };
  const origin = geodeticToEcef(frame.lon, frame.lat, frame.height);
  const { east: e, north: n, up: u } = enu(frame.lon, frame.lat);

  ex.arena_reset();
  const mem = () => ex.memory.buffer;
  const put = (typed) => { const off = ex.arena_alloc(typed.byteLength); new Uint8Array(mem()).set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), off); return off; };
  const frameOff = put(Float64Array.from([...origin, ...e, ...n, ...u]));
  const boundsOff = put(Float32Array.of(Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity));
  const matOff = put(placement);
  const posOff = put(model);
  const localOff = ex.arena_alloc(count * 12);
  ex.mesh_transform(posOff, count, matOff, frameOff, localOff, boundsOff);

  // Reference in doubles: model -> earth-centred -> local east, north, up.
  let worst = 0;
  const local = new Float32Array(mem(), localOff, count * 3).slice();
  for (let i = 0; i < count; i++) {
    const p = mat4d.transformPoint(placement, model[i * 3], model[i * 3 + 1], model[i * 3 + 2]);
    const d = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
    const want = [e, n, u].map((a) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2]);
    worst = Math.max(worst, Math.hypot(...want.map((w, k) => w - local[i * 3 + k])));
  }

  // Pack: features alternate between three buildings; building 2 is hidden.
  const features = Uint32Array.from({ length: count }, (_, i) => i % 3);
  const info = Uint16Array.of(0x0001, 0x1002, 0xF003);          // kinds 0, 1 and 15 (hidden)
  const featOff = put(features), infoOff = put(info);
  const lowestOff = ex.arena_alloc(3 * 4);
  const outOff = ex.arena_alloc(count * 12);
  ex.mesh_quantize(localOff, count, boundsOff, featOff, 3, infoOff, lowestOff, outOff);
  const b = new Float32Array(mem(), boundsOff, 6).slice();
  const packed = new Uint16Array(mem(), outOff, count * 6).slice();
  let worstPacked = 0, infoOk = true;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const back = b[k] + (packed[i * 6 + k] / 65535) * (b[k + 3] - b[k]);
      worstPacked = Math.max(worstPacked, Math.abs(back - local[i * 3 + k]));
    }
    if (packed[i * 6 + 4] !== info[i % 3]) infoOk = false;
  }

  // Triangles: every one of building 2 is dropped, the rest kept, narrowed.
  // Triangle t starts on vertex t, so it belongs to building t % 3.
  const tris = Uint32Array.from({ length: 900 }, (_, k) => (Math.floor(k / 3) + (k % 3) * 3) % count);
  const idxOff = put(tris);
  const idxOutOff = ex.arena_alloc(900 * 2);
  const kept = ex.mesh_indices(idxOff, 900, featOff, 3, infoOff, 1 << 15, idxOutOff, 1);
  const out16 = new Uint16Array(mem(), idxOutOff, kept);
  let hiddenLeft = 0;
  for (let t = 0; t < kept; t += 3) if (features[out16[t]] === 2) hiddenLeft++;
  const expectKept = [...Array(300).keys()].filter((t) => features[tris[t * 3]] !== 2).length * 3;
  console.log(`building mesh: placement error ${worst.toExponential(2)} m, packing error ${(worstPacked * 1000).toFixed(1)} mm ` +
    `over a ${(b[3] - b[0]).toFixed(0)} m box, info ${infoOk ? 'intact' : 'WRONG'}, ` +
    `${kept} of 900 indices kept (want ${expectKept}), hidden left ${hiddenLeft}`);
}
