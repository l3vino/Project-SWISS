/* ground.js — the surface under your feet, on the render thread.
 *
 * Physics stands on the terrain's own triangles, not on some other copy of
 * it: standing on anything but what you see would put you visibly inside or
 * above the ground. The quadtree draws the finest tiles close to the eye, so
 * the tile under a walking camera is the finest there is, and standing on it
 * is precise to the elevation model.
 *
 * Only tiles around the camera carry the lookup data, built by the C core on
 * a decode thread (see wasm/src/ground.c) from the same tile fetched again,
 * which normally comes straight out of the browser's HTTP cache. Where several
 * levels of the same ground are indexed, the finest answers.
 */

import { tileKey, tilesX, tilesY } from './tiling.js';
import { READY } from './terrain.js';
import { DEG, radiiAt } from '../../core/math.js';

const QMAX = 32767;

/** Turns what the decode thread transferred into typed views, once. */
export function groundEntry(data, rect) {
  const n = data.vertexCount;
  const uvh = new Uint16Array(data.uvh);
  const midLat = (rect.south + rect.north) / 2;
  const { meridian, primeVertical } = radiiAt(midLat);
  return {
    rect,
    minHeight: data.minHeight,
    heightScale: (data.maxHeight - data.minHeight) / QMAX,
    u: uvh.subarray(0, n),
    v: uvh.subarray(n, 2 * n),
    h: uvh.subarray(2 * n, 3 * n),
    idx: data.indexIsU32 ? new Uint32Array(data.indices) : new Uint16Array(data.indices),
    grid: data.grid,
    shift: 15 - Math.log2(data.grid),
    start: new Uint32Array(data.cellStart),
    tris: new Uint32Array(data.cellTris),
    // Metres per quantized step, for turning a triangle into a real slope.
    metresPerU: ((rect.east - rect.west) * DEG * primeVertical * Math.cos(midLat * DEG)) / QMAX,
    metresPerV: ((rect.north - rect.south) * DEG * meridian) / QMAX,
    // Walking stays on one triangle for many frames; trying it first skips
    // the grid walk almost every time.
    lastTriangle: -1,
    bytes: data.uvh.byteLength + data.indices.byteLength + data.cellStart.byteLength + data.cellTris.byteLength,
  };
}

/**
 * Height and slope of the drawn surface at a point inside one tile.
 *
 * Writes `height` (metres above the ellipsoid, the same datum the camera
 * uses), `gradE` and `gradN` (rise per metre towards east and north) into
 * `out`, and returns true. Returns false only for a point outside the tile.
 */
export function sampleEntry(e, lon, lat, out) {
  const r = e.rect;
  let qu = ((lon - r.west) / (r.east - r.west)) * QMAX;
  let qv = ((lat - r.south) / (r.north - r.south)) * QMAX;
  if (qu < -1 || qv < -1 || qu > QMAX + 1 || qv > QMAX + 1) return false;
  qu = qu < 0 ? 0 : qu > QMAX ? QMAX : qu;
  qv = qv < 0 ? 0 : qv > QMAX ? QMAX : qv;

  if (e.lastTriangle >= 0 && tryTriangle(e, e.lastTriangle, qu, qv, out, 1e-9)) return true;

  const cell = ((qv | 0) >> e.shift) * e.grid + ((qu | 0) >> e.shift);
  const from = e.start[cell], to = e.start[cell + 1];
  for (let k = from; k < to; k++) {
    if (tryTriangle(e, e.tris[k], qu, qv, out, 1e-9)) { e.lastTriangle = e.tris[k]; return true; }
  }
  // A point exactly on a shared edge can miss both neighbours by rounding.
  // Accept the least-outside triangle in the cell rather than report a hole.
  let best = -1, bestMargin = -Infinity;
  for (let k = from; k < to; k++) {
    const m = margin(e, e.tris[k], qu, qv);
    if (m > bestMargin) { bestMargin = m; best = e.tris[k]; }
  }
  if (best >= 0 && tryTriangle(e, best, qu, qv, out, Infinity)) { e.lastTriangle = best; return true; }
  return false;
}

function tryTriangle(e, t, qu, qv, out, tolerance) {
  const a = e.idx[t * 3], b = e.idx[t * 3 + 1], c = e.idx[t * 3 + 2];
  const u0 = e.u[a], v0 = e.v[a], u1 = e.u[b], v1 = e.v[b], u2 = e.u[c], v2 = e.v[c];
  const d = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (d === 0) return false;
  const w0 = ((v1 - v2) * (qu - u2) + (u2 - u1) * (qv - v2)) / d;
  const w1 = ((v2 - v0) * (qu - u2) + (u0 - u2) * (qv - v2)) / d;
  const w2 = 1 - w0 - w1;
  if (w0 < -tolerance || w1 < -tolerance || w2 < -tolerance) return false;

  const h0 = e.h[a], h1 = e.h[b], h2 = e.h[c];
  out.height = e.minHeight + (w0 * h0 + w1 * h1 + w2 * h2) * e.heightScale;

  // Slope from the triangle's plane, in metres. The normal is the cross
  // product of two edges; rise per metre is minus its horizontal part over
  // its vertical part.
  const x1 = (u1 - u0) * e.metresPerU, y1 = (v1 - v0) * e.metresPerV, z1 = (h1 - h0) * e.heightScale;
  const x2 = (u2 - u0) * e.metresPerU, y2 = (v2 - v0) * e.metresPerV, z2 = (h2 - h0) * e.heightScale;
  const nx = y1 * z2 - z1 * y2, ny = z1 * x2 - x1 * z2, nz = x1 * y2 - y1 * x2;
  if (nz !== 0) { out.gradE = -nx / nz; out.gradN = -ny / nz; }
  else { out.gradE = 0; out.gradN = 0; }
  return true;
}

/** How far inside a triangle a point is; negative means outside. */
function margin(e, t, qu, qv) {
  const a = e.idx[t * 3], b = e.idx[t * 3 + 1], c = e.idx[t * 3 + 2];
  const u0 = e.u[a], v0 = e.v[a], u1 = e.u[b], v1 = e.v[b], u2 = e.u[c], v2 = e.v[c];
  const d = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
  if (d === 0) return -Infinity;
  const w0 = ((v1 - v2) * (qu - u2) + (u2 - u1) * (qv - v2)) / d;
  const w1 = ((v2 - v0) * (qu - u2) + (u0 - u2) * (qv - v2)) / d;
  return Math.min(w0, w1, 1 - w0 - w1);
}

/** Metres from a point to the nearest edge of a rectangle, zero inside it. */
function rectDistance(r, lon, lat, mLon, mLat) {
  const dx = (lon < r.west ? r.west - lon : lon > r.east ? lon - r.east : 0) * mLon;
  const dy = (lat < r.south ? r.south - lat : lat > r.north ? lat - r.north : 0) * mLat;
  return Math.hypot(dx, dy);
}

/* Points around a walker whose ground is indexed ahead of time: the spot
 * itself and eight around it, so walking backwards or sideways into the next
 * tile finds it ready, even though a tile behind you is never drawn. */
const AROUND = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

/**
 * Keeps lookup data for the tiles around the camera and answers "what is the
 * ground doing here". Knows nothing about walking; the controllers ask it.
 */
export class Ground {
  /**
   * @param radius  metres around a walker whose ground is indexed ahead
   * @param keep    indexed tiles further than this are dropped
   */
  constructor({ terrain, pool, radius = 40, keep = 600 }) {
    this.terrain = terrain;
    this.pool = pool;
    this.radius = radius;
    this.keep = keep;
    this.entries = new Map();   // tile key -> entry
    this.pending = new Set();
    this.bytes = 0;
    this.zMin = 1;              // levels present, which bounds every lookup
    this.zMax = 0;
    this.point = { lon: 0, lat: 0 };
    this.radii = { meridian: 0, primeVertical: 0 };   // scratch, reused every frame
  }

  /** The finest indexed tile over a point, or null. */
  entryAt(lon, lat) {
    for (let z = this.zMax; z >= this.zMin; z--) {
      const x = Math.min(tilesX(z) - 1, Math.floor(((lon + 180) / 360) * tilesX(z)));
      const y = Math.min(tilesY(z) - 1, Math.floor(((lat + 90) / 180) * tilesY(z)));
      const e = this.entries.get(tileKey(z, x, y));
      if (e) return e;
    }
    return null;
  }

  /**
   * Height and slope of the terrain under a point, or false when no tile
   * there is indexed yet. Callers must treat false as "unknown", never as
   * "no ground".
   */
  sample(lon, lat, out) {
    const e = this.entryAt(lon, lat);
    return e ? sampleEntry(e, lon, lat, out) : false;
  }

  /**
   * Whether the ground here is final: the tile drawn at this point is as
   * detailed as the view asks for, and physics is standing on it or on
   * something finer. A camera placed on the ground waits for this, so it
   * does not land on a coarse stand-in and then drop when detail arrives.
   */
  settled(lon, lat) {
    const leaf = this.terrain.leafAt(lon, lat);
    if (!leaf || !leaf.final) return false;
    const e = this.entryAt(lon, lat);
    return Boolean(e && e.z >= leaf.z);
  }

  /**
   * Index the ground where something needs it: around a walker, and under
   * a flying camera only when it is low enough to hit something.
   */
  update(camera, walking) {
    const terrain = this.terrain;
    const under = terrain.finestAt(camera.lon, camera.lat);
    const low = under && camera.height - under.maxHeight < 800;
    if (walking || low) {
      this.#want(under);
      this.#want(terrain.leafAt(camera.lon, camera.lat));
    }
    if (walking) {
      for (let i = 1; i < AROUND.length; i++) {
        camera.offsetLonLat(AROUND[i][0] * this.radius, AROUND[i][1] * this.radius, this.point);
        this.#want(terrain.finestAt(this.point.lon, this.point.lat));
      }
    }

    // Drop what the camera has left behind, and anything no longer loaded.
    // Horizontal distance only: a camera flying over a tile it may land on
    // must not drop that tile's index for being high above it.
    let dropped = false;
    const { meridian, primeVertical } = radiiAt(camera.lat, this.radii);
    const mLat = meridian * DEG, mLon = primeVertical * Math.cos(camera.lat * DEG) * DEG;
    for (const [key, entry] of this.entries) {
      const t = terrain.tiles.get(key);
      if (t && t.state === READY && rectDistance(t.rect, camera.lon, camera.lat, mLon, mLat) <= this.keep) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(key);
      dropped = true;
    }
    if (dropped) this.#levels();
  }

  #want(t) {
    if (!t || t.state !== READY || !t.url || this.entries.has(t.key) || this.pending.has(t.key)) return;
    this.#request(t);
  }

  async #request(t) {
    const key = t.key;
    this.pending.add(key);
    try {
      const data = await this.pool.run('terrain-ground', { url: t.url, accept: t.source?.accept },
        { cost: 2, timeout: 20000 });
      if (data.missing || t.state !== READY) return;
      const entry = groundEntry(data, t.rect);
      entry.z = t.z; entry.x = t.x; entry.y = t.y;
      this.entries.set(key, entry);
      this.bytes += entry.bytes;
      this.#levels();
    } catch (err) {
      console.warn(`[ground] ${t.z}/${t.x}/${t.y}: ${err.message}`);
    } finally {
      this.pending.delete(key);
    }
  }

  #levels() {
    this.zMin = 1; this.zMax = 0;
    for (const e of this.entries.values()) {
      if (this.zMin > this.zMax) { this.zMin = this.zMax = e.z; continue; }
      if (e.z < this.zMin) this.zMin = e.z;
      if (e.z > this.zMax) this.zMax = e.z;
    }
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
    this.#levels();
  }
}
