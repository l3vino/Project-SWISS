/* test.mjs — checks the native core against double-precision references.
 *
 *   node wasm/test.mjs
 *
 * Builds a synthetic quantized-mesh tile, decodes it, and compares every
 * vertex against the same computation done in JavaScript doubles.
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
const tris = [];
for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
  const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
  tris.push(a, c, b, b, c, d);
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

const size = 88 + 4 + N * N * 6 + 4 + tris.length * 2
  + Object.values(edges).reduce((s, e) => s + 4 + e.length * 2, 0);
const buf = new ArrayBuffer(size + 8);
const dv = new DataView(buf);
let o = 0;
const f64 = v => { dv.setFloat64(o, v, true); o += 8; };
const f32 = v => { dv.setFloat32(o, v, true); o += 4; };
const u32 = v => { dv.setUint32(o, v, true); o += 4; };
const u16 = v => { dv.setUint16(o, v, true); o += 2; };

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

/* ---- 3. decode ---- */
const bytes = new Uint8Array(buf, 0, o);
ex.arena_reset();
const src = ex.arena_alloc(bytes.length);
new Uint8Array(ex.memory.buffer).set(bytes, src);
const res = ex.arena_alloc(88);
const status = ex.qm_decode(src, bytes.length, west, south, east, north, res);
console.log('decode status', status, '(0 = ok)');

const mem = ex.memory.buffer;
const R = new DataView(mem, res, 88);
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
