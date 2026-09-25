/* solid.js — what a body bumps into and stands on, besides the ground.
 *
 * Buildings and bridges are solid, and they are solid exactly where they are
 * drawn: the triangles come from the tiles the streamers selected around the
 * view's focus, each with the collision grid built for it on a decode thread
 * (wasm/src/solid.c). Once a frame, the triangles within reach of the camera
 * are gathered into one short list in a local frame at the eye, metres east,
 * north and up, and every question the physics steps ask during that frame
 * is answered from the list:
 *
 *   floor      the highest surface under a point that can be stood on, below
 *              a given height (the top of a step)
 *   ceiling    the lowest surface over a point, above a given height
 *   resolve    how far an upright cylinder overlapping walls must move to be
 *              clear of them, and in which directions it was pushed
 *   sweep      resolve along a move in short steps, so speed cannot carry a
 *              body through a wall between two steps
 *   clearAt    whether a body standing somewhere is outside every building
 *              and clear of every wall, and nearestClear, the closest such
 *              place
 *
 * Walls are whatever is too steep to stand on. They only count between the
 * height a step can climb and the top of the head, so a kerb or a stair is
 * climbed rather than bumped into, and a roof edge stops holding you back once
 * your feet are above it.
 */

import { geodeticToEcef, enuBasis, radiiAt, DEG } from '../../core/math.js';

/* Floats per gathered triangle: corners a, b, c; unit normal; footprint box
 * min x, min y, max x, max y; lowest and highest z. */
const REC = 18;
/* Surfaces steeper than this are never floors or ceilings, whatever the
 * walkable limit, and walls hardly ever lean more. */
const CEILING_MIN_NZ = 0.1;
/* Walls lower than this above the feet do not stop a body: it steps up. */
const STEP_CLEARANCE = 0.4;

export class SolidWorld {
  constructor(tilesets) {
    this.tilesets = tilesets;
    this.walkCos = Math.cos(45 * DEG);    // steepest floor, as the cosine of its slope
    this.tris = new Float32Array(REC * 512);
    this.count = 0;
    this.origin = { lon: 0, lat: 0, height: 0 };
    this.mPerDegLon = 1;
    this.mPerDegLat = 1;
    this.stamp = 0;
    this.stats = { tiles: 0, triangles: 0 };
    this.originEcef = new Float64Array(3);
    this.east = new Float64Array(3);
    this.north = new Float64Array(3);
    this.up = new Float64Array(3);
  }

  /** Something to collide with near the camera this frame. */
  get active() { return this.count > 0; }

  /** Nothing is solid this frame. */
  clear() { this.count = 0; this.stats.tiles = 0; this.stats.triangles = 0; }

  /**
   * Whether every enabled layer has loaded what the focus covers, with its
   * collision copy, as of the view's current version.
   */
  settled(view) {
    for (const t of this.tilesets) {
      if (!t.enabled || t.status === 'failed') continue;
      if (!t.root || t.dirty || t.viewVersion !== view.version || t.focusPending > 0) return false;
    }
    return true;
  }

  /** Where the steepest standable slope lies, in radians. */
  setMaxSlope(radians) { this.walkCos = Math.cos(radians); }

  /**
   * Gathers the triangles within `reach` metres (horizontally) of a point,
   * normally the eye, into the local frame queries use.
   */
  prepare(lon, lat, height, reach) {
    this.count = 0;
    this.stats.tiles = 0;
    const o = this.origin;
    o.lon = lon; o.lat = lat; o.height = height;
    const { meridian, primeVertical } = radiiAt(lat);
    this.mPerDegLat = (meridian + height) * DEG;
    this.mPerDegLon = (primeVertical + height) * Math.cos(lat * DEG) * DEG;
    geodeticToEcef(lon, lat, height, this.originEcef);
    enuBasis(lon, lat, this.east, this.north, this.up);
    this.stamp = (this.stamp + 1) >>> 0 || 1;
    for (const t of this.tilesets) {
      if (!t.enabled) continue;
      for (const node of t.focusNodes) if (node.solid && node.gpu) this.#gather(node, reach);
    }
    this.stats.triangles = this.count;
  }

  /** Metres east, north and up of the gathered frame's origin. */
  toLocal(lon, lat, height, out) {
    const o = this.origin;
    out.x = (lon - o.lon) * this.mPerDegLon;
    out.y = (lat - o.lat) * this.mPerDegLat;
    out.z = height - o.height;
    return out;
  }

  #gather(node, reach) {
    const g = node.gpu, sd = node.solid;
    // Tile frame to local frame: q = M p + b, M = Rl^T Rt, b = Rl^T (Ot - Ol).
    const E = this.east, N = this.north, U = this.up, O = this.originEcef;
    const te = g.east, tn = g.north, tu = g.up;
    const m00 = dot(E, te), m01 = dot(E, tn), m02 = dot(E, tu);
    const m10 = dot(N, te), m11 = dot(N, tn), m12 = dot(N, tu);
    const m20 = dot(U, te), m21 = dot(U, tn), m22 = dot(U, tu);
    const ox = g.origin[0] - O[0], oy = g.origin[1] - O[1], oz = g.origin[2] - O[2];
    const b0 = E[0] * ox + E[1] * oy + E[2] * oz;
    const b1 = N[0] * ox + N[1] * oy + N[2] * oz;
    const b2 = U[0] * ox + U[1] * oy + U[2] * oz;
    // The local origin in the tile frame: p = M^T (0 - b).
    const px = -(m00 * b0 + m10 * b1 + m20 * b2);
    const py = -(m01 * b0 + m11 * b1 + m21 * b2);

    const minX = g.boxMin[0], minY = g.boxMin[1], minZ = g.boxMin[2];
    const sx = g.boxSize[0], sy = g.boxSize[1], sz = g.boxSize[2];
    const kx = sx / 65535, ky = sy / 65535, kz = sz / 65535;
    const toQ = (v, lo, span) => (span > 0 ? ((v - lo) / span) * 65535 : 0);
    const r = reach + 1;
    const qx0 = toQ(px - r, minX, sx), qx1 = toQ(px + r, minX, sx);
    const qy0 = toQ(py - r, minY, sy), qy1 = toQ(py + r, minY, sy);
    if (qx1 < 0 || qy1 < 0 || qx0 > 65535 || qy0 > 65535) return;
    const cells = sd.cells, shift = sd.shift;
    const cx0 = clampQ(qx0) >> shift, cx1 = clampQ(qx1) >> shift;
    const cy0 = clampQ(qy0) >> shift, cy1 = clampQ(qy1) >> shift;

    sd.stamps ??= new Uint32Array(sd.triangles);
    const stamps = sd.stamps, stamp = this.stamp;
    const v = sd.vertices, idx = sd.indices, start = sd.cellStart, list = sd.cellTris;
    let gathered = 0;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const cell = cy * cells + cx;
        for (let k = start[cell], end = start[cell + 1]; k < end; k++) {
          const t = list[k];
          if (stamps[t] === stamp) continue;
          stamps[t] = stamp;
          if (this.count * REC + REC > this.tris.length) this.#grow();
          const o = this.count * REC, T = this.tris;
          for (let j = 0; j < 3; j++) {
            const vi = idx[t * 3 + j] * 6;
            const x = minX + v[vi] * kx, y = minY + v[vi + 1] * ky, z = minZ + v[vi + 2] * kz;
            T[o + j * 3] = m00 * x + m01 * y + m02 * z + b0;
            T[o + j * 3 + 1] = m10 * x + m11 * y + m12 * z + b1;
            T[o + j * 3 + 2] = m20 * x + m21 * y + m22 * z + b2;
          }
          if (this.#finish(o, reach)) { this.count++; gathered++; }
        }
      }
    }
    if (gathered) this.stats.tiles++;
  }

  /* Normal and bounds for the triangle just written; false to drop it
   * (degenerate, or entirely out of reach). */
  #finish(o, reach) {
    const T = this.tris;
    const ax = T[o], ay = T[o + 1], az = T[o + 2];
    const bx = T[o + 3], by = T[o + 4], bz = T[o + 5];
    const cx = T[o + 6], cy = T[o + 7], cz = T[o + 8];
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    if (minX > reach || maxX < -reach || minY > reach || maxY < -reach) return false;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) return false;
    nx /= len; ny /= len; nz /= len;
    T[o + 9] = nx; T[o + 10] = ny; T[o + 11] = nz;
    T[o + 12] = minX; T[o + 13] = minY; T[o + 14] = maxX; T[o + 15] = maxY;
    T[o + 16] = Math.min(az, bz, cz); T[o + 17] = Math.max(az, bz, cz);
    return true;
  }

  #grow() {
    const next = new Float32Array(this.tris.length * 2);
    next.set(this.tris);
    this.tris = next;
  }

  /**
   * Height of the highest surface one can stand on at (x, y) that is no
   * higher than `zMax`, or -Infinity.
   */
  floor(x, y, zMax) {
    const T = this.tris, walk = this.walkCos;
    let best = -Infinity;
    for (let i = 0, o = 0; i < this.count; i++, o += REC) {
      const nz = T[o + 11];
      if (Math.abs(nz) < walk || T[o + 16] > zMax + 1e-4) continue;
      if (x < T[o + 12] || x > T[o + 14] || y < T[o + 13] || y > T[o + 15]) continue;
      if (!inside(T, o, x, y)) continue;
      const z = T[o + 2] - (T[o + 9] * (x - T[o]) + T[o + 10] * (y - T[o + 1])) / nz;
      if (z <= zMax + 1e-4 && z > best) best = z;
    }
    return best;
  }

  /** Height of the lowest surface over (x, y) no lower than `zMin`, or Infinity. */
  ceiling(x, y, zMin) {
    const T = this.tris;
    let best = Infinity;
    for (let i = 0, o = 0; i < this.count; i++, o += REC) {
      const nz = T[o + 11];
      if (Math.abs(nz) < CEILING_MIN_NZ || T[o + 17] < zMin) continue;
      if (x < T[o + 12] || x > T[o + 14] || y < T[o + 13] || y > T[o + 15]) continue;
      if (!inside(T, o, x, y)) continue;
      const z = T[o + 2] - (T[o + 9] * (x - T[o]) + T[o + 10] * (y - T[o + 1])) / nz;
      if (z >= zMin && z < best) best = z;
    }
    return best;
  }

  /**
   * Moves `p` ({x, y}) until an upright cylinder of `radius` spanning heights
   * zLow..zHigh there overlaps no wall, deepest overlap first, as a corner
   * needs two pushes. Each push direction goes onto `contacts` as x, y.
   * Returns how many pushes it took.
   */
  resolve(p, radius, zLow, zHigh, contacts) {
    const T = this.tris, walk = this.walkCos;
    let pushes = 0;
    for (let iter = 0; iter < 4; iter++) {
      let deepest = 1e-5, dirX = 0, dirY = 0;
      for (let i = 0, o = 0; i < this.count; i++, o += REC) {
        if (Math.abs(T[o + 11]) >= walk) continue;                    // a floor, not a wall
        if (T[o + 16] >= zHigh || T[o + 17] <= zLow) continue;        // above the head or below the step
        if (p.x < T[o + 12] - radius || p.x > T[o + 14] + radius ||
            p.y < T[o + 13] - radius || p.y > T[o + 15] + radius) continue;
        const hit = nearestInPlan(T, o, p.x, p.y);
        let dist = hit.dist, dx, dy;
        if (dist > 1e-6) {
          dx = (p.x - hit.x) / dist; dy = (p.y - hit.y) / dist;
        } else {
          // Right on the wall's line, or over a leaning face: out along the
          // face's own horizontal normal, on the side the body is on.
          const hx = T[o + 9], hy = T[o + 10], hl = Math.hypot(hx, hy) || 1;
          const side = hx * (p.x - T[o]) + hy * (p.y - T[o + 1]) +
            T[o + 11] * ((zLow + zHigh) / 2 - T[o + 2]) >= 0 ? 1 : -1;
          dx = (side * hx) / hl; dy = (side * hy) / hl;
          dist = 0;
        }
        const depth = radius - dist;
        if (depth > deepest) { deepest = depth; dirX = dx; dirY = dy; }
      }
      if (deepest <= 1e-5) break;
      p.x += dirX * (deepest + 1e-4);
      p.y += dirY * (deepest + 1e-4);
      contacts?.push(dirX, dirY);
      pushes++;
    }
    return pushes;
  }

  /**
   * Moves from `from` towards `to` ({x, y}, local metres) in steps shorter
   * than the body, resolving walls after each, and leaves the end in `to`.
   */
  sweep(from, to, radius, zLow, zHigh, contacts) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (radius * 0.8)));
    const p = { x: from.x, y: from.y };
    for (let i = 0; i < steps; i++) {
      p.x += dx / steps;
      p.y += dy / steps;
      this.resolve(p, radius, zLow, zHigh, contacts);
    }
    to.x = p.x;
    to.y = p.y;
    return to;
  }

  /**
   * Whether a body standing with its feet at `feet` (local height) at (x, y)
   * is clear of everything: not inside a building, and no wall within
   * `radius` between a step above its feet and its head. Inside is decided
   * the way it is for any closed shape, by counting how many surfaces a line
   * straight up from the feet passes through: odd is inside a building, even
   * is outside, or under a bridge, whose deck it passes into and out of.
   */
  clearAt(x, y, feet, radius, height) {
    const T = this.tris, walk = this.walkCos;
    // Off the exact point by a hair, so a line through a shared edge or
    // corner is not counted twice.
    const px = x + 1.37e-4, py = y + 0.71e-4;
    let crossings = 0;
    for (let i = 0, o = 0; i < this.count; i++, o += REC) {
      if (x < T[o + 12] - radius || x > T[o + 14] + radius ||
          y < T[o + 13] - radius || y > T[o + 15] + radius) continue;
      const nz = T[o + 11];
      // Surfaces over the point, for the count.
      if (Math.abs(nz) > 1e-6 && T[o + 17] > feet && inside(T, o, px, py)) {
        const z = T[o + 2] - (T[o + 9] * (px - T[o]) + T[o + 10] * (py - T[o + 1])) / nz;
        if (z > feet) crossings++;
      }
      // Walls around the body.
      if (Math.abs(nz) < walk && T[o + 16] < feet + height && T[o + 17] > feet + STEP_CLEARANCE &&
          nearestInPlan(T, o, x, y).dist < radius) return false;
    }
    return (crossings & 1) === 0;
  }

  /**
   * The nearest point within `maxDistance` metres of (x, y) where a body
   * stands clear (see clearAt), searched in rings a metre apart, or null.
   * `feetAt(x, y)` gives the ground height at a point, local metres, or null
   * where it is not known.
   */
  nearestClear(x, y, radius, height, maxDistance, feetAt) {
    const test = (px, py) => {
      const feet = feetAt(px, py);
      return feet != null && this.clearAt(px, py, feet, radius, height);
    };
    if (test(x, y)) return { x, y };
    for (let ring = 1; ring <= maxDistance; ring++) {
      const n = Math.max(8, Math.round(2 * Math.PI * ring));
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        const px = x + ring * Math.cos(a), py = y + ring * Math.sin(a);
        if (test(px, py)) return { x: px, y: py };
      }
    }
    return null;
  }
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function clampQ(q) { return q < 0 ? 0 : q > 65535 ? 65535 : q | 0; }

/* Whether (x, y) lies inside a triangle seen from above, edges included. */
function inside(T, o, x, y) {
  const ax = T[o], ay = T[o + 1], bx = T[o + 3], by = T[o + 4], cx = T[o + 6], cy = T[o + 7];
  const e0 = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const e1 = (cx - bx) * (y - by) - (cy - by) * (x - bx);
  const e2 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx);
  const tol = 1e-7 * (Math.abs(e0) + Math.abs(e1) + Math.abs(e2)) + 1e-9;
  return (e0 >= -tol && e1 >= -tol && e2 >= -tol) || (e0 <= tol && e1 <= tol && e2 <= tol);
}

const nearest = { x: 0, y: 0, dist: 0 };

/* The point of a triangle's plan (its shadow from straight above) nearest to
 * (x, y), and how far. A wall's plan is a line; a sloping face's is a
 * triangle, and a point over it is at distance zero. */
function nearestInPlan(T, o, x, y) {
  const ax = T[o], ay = T[o + 1], bx = T[o + 3], by = T[o + 4], cx = T[o + 6], cy = T[o + 7];
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) > 1e-4 && inside(T, o, x, y)) {
    nearest.x = x; nearest.y = y; nearest.dist = 0;
    return nearest;
  }
  let best = Infinity, bxOut = 0, byOut = 0;
  for (let e = 0; e < 3; e++) {
    const px = T[o + e * 3], py = T[o + e * 3 + 1];
    const qx = T[o + ((e + 1) % 3) * 3], qy = T[o + ((e + 1) % 3) * 3 + 1];
    const ex = qx - px, ey = qy - py;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - px) * ex + (y - py) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const sx = px + t * ex, sy = py + t * ey;
    const d = (x - sx) * (x - sx) + (y - sy) * (y - sy);
    if (d < best) { best = d; bxOut = sx; byOut = sy; }
  }
  nearest.x = bxOut; nearest.y = byOut; nearest.dist = Math.sqrt(best);
  return nearest;
}
