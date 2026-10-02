/* ground.js — the surface under your feet, on the render thread.
 *
 * Physics stands on the terrain's own triangles, not on some other copy of
 * it: standing on anything but what you see would put you visibly inside or
 * above the ground. The quadtree draws the finest tiles close to the eye, so
 * the tile under a walking camera is the finest there is, and standing on it
 * is precise to the elevation model.
 *
 * Only accurate tiles are indexed: level 14 and finer (about 5 m of error),
 * or the finest a service has at that spot (terrain.js, ACCURATE_LEVEL).
 * While terrain streams in, the first levels to arrive are stand-ins whose
 * surface can be kilometres off over mountains; standing on them is what
 * used to lift a camera flying along a valley to the height of the peaks.
 * No accurate ground means "unknown", never "the stand-in's surface".
 *
 * Only tiles around the camera carry the lookup data, built by the C core on
 * a decode thread (see wasm/src/ground.c). A tile that physics may need when
 * it is asked for (accurate, and near the camera or the watched point while
 * physics is on the ground or low) gets it in the same decode (`wants`,
 * `adopt`); one loaded before it was needed is fetched again for it, which
 * the browser's HTTP cache normally answers, in the scheduler's physics
 * class. Where several levels of the same ground are indexed, the finest
 * answers. One more point can be watched besides the camera, so ground there
 * is ready before the camera arrives: where a fast, low flight is heading, or
 * where a flight to a place will end.
 */

import { tileKey, tilesX, tilesY } from './tiling.js';
import { READY, ACCURATE_LEVEL, geometricError } from './terrain.js';
import { DEG, radiiAt } from '../../core/math.js';
import { PHYSICS, hostOf } from '../../core/scheduler.js';

const QMAX = 32767;
/* A tile whose index failed is asked for again after this. */
const RETRY_MS = 2000;

/**
 * Turns what the decode thread transferred into typed views, once.
 * `tile` is where it came from ({ z, x, y }) and whether it is accurate.
 */
export function groundEntry(data, rect, { z = 0, x = 0, y = 0, accurate = true } = {}) {
  const n = data.vertexCount;
  const uvh = new Uint16Array(data.uvh);
  const midLat = (rect.south + rect.north) / 2;
  const { meridian, primeVertical } = radiiAt(midLat);
  return {
    rect,
    z, x, y, accurate,
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
 * uses), `gradE` and `gradN` (rise per metre towards east and north), and
 * the tile's `level` and whether it is `accurate` into `out`, and returns
 * true. Returns false only for a point outside the tile.
 */
export function sampleEntry(e, lon, lat, out) {
  out.level = e.z;
  out.accurate = e.accurate;
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
  return Math.sqrt(dx * dx + dy * dy);
}

/* Points around a walker whose ground is indexed ahead of time: the spot
 * itself and eight around it, so walking backwards or sideways into the next
 * tile finds it ready, even though a tile behind you is never drawn. */
const AROUND = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

/** A sample with every field a lookup writes, so its shape never changes. */
export const groundSample = () => ({ height: 0, gradE: 0, gradN: 0, level: 0, accurate: false });

/**
 * Keeps lookup data for the tiles around the camera and answers "what is the
 * ground doing here". Knows nothing about walking; the controllers ask it.
 */
export class Ground {
  /**
   * @param radius  metres around a walker whose ground is indexed ahead
   * @param keep    indexed tiles further than this from the camera (and from
   *                the watched point) are dropped
   */
  constructor({ terrain, scheduler, radius = 40, keep = 600 }) {
    this.terrain = terrain;
    this.scheduler = scheduler;
    this.client = scheduler.client('ground', { weight: 1, pick: (cls) => this.#pick(cls) });
    this.radius = radius;
    this.keep = keep;
    this.entries = new Map();   // tile key -> entry
    this.pending = new Set();
    this.waiting = [];          // tiles to index, oldest first
    // Where physics may need ground (the camera when it is on or near the
    // ground, and the watched point), for `wants`.
    this.near = { on: false, lon: 0, lat: 0, mLon: 1, mLat: 1, watch: null };
    this.bytes = 0;
    this.zMin = 1;              // levels present, which bounds every lookup
    this.zMax = 0;
    this.point = { lon: 0, lat: 0 };
    this.radii = { meridian: 0, primeVertical: 0 };   // scratch, reused every frame
    this.columns = 0;           // tiles asked for because ground was needed, for the probe
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
   * Height and slope of the terrain under a point, with the level it comes
   * from and whether it is accurate (every indexed tile is, by the rule
   * above; the flag lets callers insist on it without knowing the rule), or
   * false when no tile there is indexed yet. Callers must treat false as
   * "unknown", never as "no ground".
   */
  sample(lon, lat, out) {
    const e = this.entryAt(lon, lat);
    return e ? sampleEntry(e, lon, lat, out) : false;
  }

  /**
   * An upper bound on the terrain under a point, from the finest tile loaded
   * there, or Infinity where nothing is. Something falling above it cannot
   * hit the ground yet, whether or not accurate ground is known. A tile's
   * top is its highest vertex, and a coarse tile's vertices can all miss a
   * peak, so the tile's own error is added: a few metres for a fine tile, a
   * kilometre or more for the first levels to arrive.
   */
  highest(lon, lat) {
    const t = this.terrain.finestAt(lon, lat);
    return t ? t.maxHeight + geometricError(t.z) : Infinity;
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
   * Index the ground where something needs it: around a walker, under a
   * flying camera only when it is low enough to hit something, and at the
   * watched point, if any ({ lon, lat }: see the file comment). Only
   * accurate tiles are indexed; where the finest tile loaded at such a point
   * is not accurate, the column of tiles under it is asked for, all levels
   * at once. Nothing else would load it: the view only refines what it
   * sees, and the ground behind a walker, or straight under a camera below
   * a stand-in surface, is out of view. Around a walker the column goes down
   * to the detail the view would draw there, so the ground physics stands
   * on behind you matches what you see when you turn round.
   */
  update(camera, walking, watch = null) {
    const terrain = this.terrain;
    const under = terrain.finestAt(camera.lon, camera.lat);
    const low = under && camera.height - under.maxHeight < 800;
    const near = this.near;
    near.on = Boolean(walking || low);
    near.lon = camera.lon;
    near.lat = camera.lat;
    near.watch = watch;
    const detail = walking ? Math.max(ACCURATE_LEVEL, terrain.levelFor(this.radius)) : ACCURATE_LEVEL;
    if (walking || low) {
      this.#need(camera.lon, camera.lat, under, detail);
      this.#want(terrain.leafAt(camera.lon, camera.lat));
    }
    if (walking) {
      for (let i = 1; i < AROUND.length; i++) {
        camera.offsetLonLat(AROUND[i][0] * this.radius, AROUND[i][1] * this.radius, this.point);
        this.#need(this.point.lon, this.point.lat, terrain.finestAt(this.point.lon, this.point.lat), detail);
      }
    }
    if (watch) this.#need(watch.lon, watch.lat, terrain.finestAt(watch.lon, watch.lat), ACCURATE_LEVEL);

    // Drop what the camera has left behind, and anything no longer loaded.
    // Horizontal distance only: a camera flying over a tile it may land on
    // must not drop that tile's index for being high above it. Around a
    // watched point too, and on the way there: the camera keeps what lies
    // within its distance to that point.
    let dropped = false;
    const { meridian, primeVertical } = radiiAt(camera.lat, this.radii);
    const mLat = meridian * DEG, mLon = primeVertical * Math.cos(camera.lat * DEG) * DEG;
    near.mLon = mLon;
    near.mLat = mLat;
    let reach = this.keep;
    if (watch) reach = Math.max(reach, Math.hypot((watch.lon - camera.lon) * mLon, (watch.lat - camera.lat) * mLat) + 100);
    for (const [key, entry] of this.entries) {
      const t = terrain.tiles.get(key);
      if (t && t.state === READY && (rectDistance(t.rect, camera.lon, camera.lat, mLon, mLat) <= reach ||
          (watch && rectDistance(t.rect, watch.lon, watch.lat, mLon, mLat) <= this.keep))) continue;
      this.bytes -= entry.bytes;
      this.entries.delete(key);
      dropped = true;
    }
    if (dropped) this.#levels();
  }

  /* Ground is needed at a point, whose finest loaded tile is `t`: index it if
   * it is accurate, and ask for the column below it while it is coarser than
   * `level` and something finer exists. */
  #need(lon, lat, t, level) {
    this.#want(t);
    if (t && (t.z >= level || !this.terrain.finerExists(t.z, t.x, t.y))) return;
    this.columns += this.terrain.prefetchColumn(lon, lat, level, { join: true });
  }

  #want(t) {
    if (!t || t.state !== READY || !t.url || this.entries.has(t.key) || this.pending.has(t.key)) return;
    if (t.groundRetryAt > performance.now() || !this.terrain.isAccurate(t)) return;
    this.pending.add(t.key);
    this.waiting.push(t);
  }

  /**
   * Whether a terrain tile about to be requested should bring its ground
   * index along: accurate, and within `keep` of the camera while physics is
   * on or near the ground, or of the watched point.
   */
  wants(t) {
    const n = this.near;
    if (!n.on && !n.watch) return false;
    if (t.z < ACCURATE_LEVEL && this.terrain.finerExists(t.z, t.x, t.y)) return false;
    if (n.on && rectDistance(t.rect, n.lon, n.lat, n.mLon, n.mLat) <= this.keep) return true;
    return Boolean(n.watch) && rectDistance(t.rect, n.watch.lon, n.watch.lat, n.mLon, n.mLat) <= this.keep;
  }

  /** A ground index made along with its tile (terrain.js, `onGround`). */
  adopt(t, data) {
    if (this.entries.has(t.key)) return;
    const entry = groundEntry(data, t.rect, { z: t.z, x: t.x, y: t.y, accurate: true });
    this.entries.set(t.key, entry);
    this.bytes += entry.bytes;
    this.#levels();
  }

  /* The scheduler's turn: physics only, oldest first. */
  #pick(cls) {
    if (cls !== PHYSICS) return false;
    while (this.waiting.length) {
      const t = this.waiting[0];
      if (t.state !== READY || this.entries.has(t.key)) { this.waiting.shift(); this.pending.delete(t.key); continue; }
      if (!this.client.canRun(hostOf(t.url))) return false;
      this.waiting.shift();
      this.#request(t);
      return true;
    }
    return false;
  }

  async #request(t) {
    const key = t.key;
    try {
      const data = await this.client.run('terrain-ground', { url: t.url, accept: t.source?.accept },
        { item: t, cls: PHYSICS, cost: 2, host: hostOf(t.url), timeout: 20000 });
      if (data.missing || t.state !== READY) return;
      this.adopt(t, data);
    } catch (err) {
      // Asked for again by the next update that needs it, after a pause.
      if (err.name !== 'AbortError') {
        t.groundRetryAt = performance.now() + RETRY_MS;
        // A busy or failing service is tried again quietly; anything else is news.
        if (!err.retry) console.warn(`[ground] ${t.z}/${t.x}/${t.y}: ${err.message}`);
      }
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
