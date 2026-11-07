/* mesh.js — a tube's points made ready for its mesh, and the mesh made
 * (wasm/src/tunnel.c, on a decode thread).
 *
 * The render thread knows the tube's spine (groups.js, every 2 m), its
 * floor along it (fit.js: kept under the ground) and its cross-section; the
 * mesh needs a ring only where something changes: the way turns, the floor
 * bends, the bore widens or its middle moves. `meshPoints` keeps a spine
 * point where the way has turned by TURN since the last one kept, the floor
 * strayed BEND from the grade it had there, the width or the middle moved by
 * SHIFT, or KEEP_MOST metres have passed (tunnel.c adds rings every
 * ringStep between them), and gives each its floor height, its Web Mercator
 * position (reference pixels at `zoom` from the mesh's origin, for the roads
 * painted on the floor) and how wide the bore is there against one line.
 */

import { TUBE_POINT } from './groups.js';
import { mercX, mercY, worldPixels } from '../imagery/mercator.js';

export const POINT_DOUBLES = 9;
/* How each end of a mesh is finished (tunnel.c END_*). */
export const MESH_END = { JOIN: 0, PORTAL: 1, WALL: 2, DARK: 3 };

const TURN = 0.012;        // radians
const SHIFT = 0.08;        // metres
const BEND = 0.08;         // metres the floor strays from its grade at the last point kept
const KEEP_MOST = 40;      // metres
const EQUATOR = 2 * Math.PI * 6378137;

/**
 * The mesh's points from a stretch of a tube.
 * @param tube     groups.js tube (points: lon, lat, s, offset, extra)
 * @param floorAt  (s along this tube) => floor height, metres above the ellipsoid
 * @param half     one line's half-width of the cross-section (sections.js), metres
 * @param zoom     the imagery reference zoom the Mercator positions are in
 * @param from, to metres along the tube the mesh covers
 * @returns { points: Float64Array (POINT_DOUBLES each), count, origin: { lon, lat, h, mx, my } }
 */
export function meshPoints(tube, floorAt, half, zoom, from = 0, to = Infinity) {
  const p = smoothed(tube.points, half), n = p.length / TUBE_POINT, world = worldPixels(zoom);
  const dirAt = (k) => {
    const a = Math.max(0, k - 1) * TUBE_POINT, b = Math.min(n - 1, k + 1) * TUBE_POINT;
    const m = Math.cos((p[a + 1] * Math.PI) / 180);
    const dx = (p[b] - p[a]) * m, dy = p[b + 1] - p[a + 1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  // The samples covering from..to: the last at or before `from`, the first at or after `to`; moved to exactly there
  // (a tube that starts inside its portal, fit.js).
  let k0 = 0, k1 = n - 1;
  while (k0 + 1 < n && p[(k0 + 1) * TUBE_POINT + 2] <= from) k0++;
  while (k1 - 1 > k0 && p[(k1 - 1) * TUBE_POINT + 2] >= to) k1--;
  // Sample k moved towards sample j to where the tube is `s` along.
  const moveTo = (k, j, s) => {
    const a = k * TUBE_POINT, b = j * TUBE_POINT, span = p[b + 2] - p[a + 2];
    if (!(Math.abs(span) > 1e-9)) return;
    const f = (s - p[a + 2]) / span;
    if (!(f > 1e-6 && f < 1 - 1e-6)) return;
    for (let i = 0; i < TUBE_POINT; i++) p[a + i] += (p[b + i] - p[a + i]) * f;
  };
  if (k0 + 1 < n) moveTo(k0, k0 + 1, from);
  if (k1 > 0 && k1 - 1 >= k0) moveTo(k1, k1 - 1, to);
  const keep = [k0];
  // The floor's grade on from a kept point (a floor kept under the ground bends: fit.js).
  const gradeAt = (s) => (floorAt(s + 2) - floorAt(s)) / 2;
  let last = k0, lastDir = dirAt(k0), lastFloor = floorAt(p[k0 * TUBE_POINT + 2]), lastGrade = gradeAt(p[k0 * TUBE_POINT + 2]);
  for (let k = k0 + 1; k < k1; k++) {
    const d = dirAt(k), turned = Math.acos(Math.min(1, d[0] * lastDir[0] + d[1] * lastDir[1]));
    const o = k * TUBE_POINT, l = last * TUBE_POINT, s = p[o + 2];
    const bent = Math.abs(floorAt(s) - (lastFloor + lastGrade * (s - p[l + 2]))) > BEND;
    if (turned > TURN || bent || Math.abs(p[o + 3] - p[l + 3]) > SHIFT || Math.abs(p[o + 4] - p[l + 4]) > SHIFT || s - p[l + 2] >= KEEP_MOST) {
      keep.push(k); last = k; lastDir = d; lastFloor = floorAt(s); lastGrade = gradeAt(s);
    }
  }
  if (k1 > k0) keep.push(k1);
  const mid = keep[Math.floor(keep.length / 2)] * TUBE_POINT;
  const origin = { lon: p[mid], lat: p[mid + 1], h: floorAt(p[mid + 2]) };
  origin.mx = mercX(origin.lon) * world;
  origin.my = mercY(origin.lat) * world;
  const out = new Float64Array(keep.length * POINT_DOUBLES);
  keep.forEach((k, i) => {
    const o = k * TUBE_POINT, w = i * POINT_DOUBLES, lon = p[o], lat = p[o + 1], s = p[o + 2];
    out[w] = lon; out[w + 1] = lat; out[w + 2] = floorAt(s); out[w + 3] = s;
    out[w + 4] = mercX(lon) * world - origin.mx;
    out[w + 5] = mercY(lat) * world - origin.my;
    out[w + 6] = world / (EQUATOR * Math.cos((lat * Math.PI) / 180));
    out[w + 7] = p[o + 3];
    out[w + 8] = (half + p[o + 4]) / half;
  });
  return { points: out, count: keep.length, origin };
}

/* The spine smoothed over a stretch as long as the bore is wide there and
 * at least SMOOTH_LEAST (a tent either side): the lines' kinks at nodes and
 * joins (a few metres' stub) would fold a wide bore's inner side, which
 * cannot turn tighter than its half-width. The bore's middle and width stay
 * where they were measured. Its ends stay where they are. */
const SMOOTH_LEAST = 8;

/** A tube's spine as its mesh runs (TUBE_POINT doubles a point, as the tube's): where the terrain is opened follows it (fit.js). */
export function spineOf(tube, half) {
  return smoothed(tube.points, half);
}

function smoothed(points, half) {
  const n = points.length / TUBE_POINT, out = Float64Array.from(points);
  if (n < 3) return out;
  const lat0 = points[1], m = Math.cos((lat0 * Math.PI) / 180);
  const step = Math.max(0.1, (points[(n - 1) * TUBE_POINT + 2] - points[2]) / (n - 1));
  for (let k = 1; k + 1 < n; k++) {
    const o = k * TUBE_POINT, reach = Math.max(SMOOTH_LEAST, 1.5 * (half + points[o + 4]) + Math.abs(points[o + 3]));
    const r = Math.min(Math.round(reach / step), k, n - 1 - k);
    if (r < 1) continue;
    let sw = 0, sx = 0, sy = 0;
    for (let j = -r; j <= r; j++) {
      const w = r + 1 - Math.abs(j), q = (k + j) * TUBE_POINT;
      sw += w; sx += w * points[q] * m; sy += w * points[q + 1];
    }
    out[o] = sx / sw / m; out[o + 1] = sy / sw;
  }
  return out;
}

/**
 * The mesh (on a decode thread).
 * @param core     the wasm core (core/wasm.js)
 * @param spec     { origin: [x, y, z] ECEF, ends: [MESH_END, MESH_END], spring, ringStep, collar, ceiling, and per end
 *                 (a pair, or one number for both): collarDepth (metres the tube runs on out of its portal to the
 *                 collar), shell (metres the collar's outer side runs back along it from the collar), wingTop
 *                 (metres up the wing walls' top at the collar, 0 none; by default the springline's and a metre),
 *                 rise (the floor's rise a metre out of the portal to the collar, its approach's; 0 by default) }
 * @param points   meshPoints' points
 * @param profile  the cross-section (sections.js points)
 * @param copy     (Uint8Array) => a copy that can be handed over
 * @returns { vertices: Uint8Array, indices: Uint8Array (u32), vertexCount, indexCount, rings, stride (bytes a vertex) }
 */
export function buildTunnelMesh(core, spec, points, profile, copy = (u8) => u8.slice()) {
  core.reset();
  const specSize = core.exports.tunnel_spec_size(), resultSize = core.exports.tunnel_result_size();
  const specOff = core.alloc(specSize);
  const pointsOff = core.write(new Uint8Array(points.buffer, points.byteOffset, points.byteLength));
  const profileOff = core.write(new Uint8Array(profile.buffer, profile.byteOffset, profile.byteLength));
  const resOff = core.alloc(resultSize);
  const dv = new DataView(core.buffer, specOff, specSize);
  // tunnel.c TunnelSpec.
  const pair = (v, fallback) => (Array.isArray(v) ? v : [v ?? fallback[0], v ?? fallback[1]]);
  const depth = pair(spec.collarDepth, [0.5, 0.5]);
  const shell = pair(spec.shell, [depth[0] + 3, depth[1] + 3]);
  const wings = pair(spec.wingTop, [spec.spring + 1, spec.spring + 1]);
  const rise = pair(spec.rise, [0, 0]);
  dv.setUint32(0, points.length / POINT_DOUBLES, true);
  dv.setUint32(4, profile.length / 4, true);
  dv.setUint32(8, (spec.ends[0] & 3) | ((spec.ends[1] & 3) << 2), true);
  dv.setFloat32(12, spec.spring, true);
  dv.setFloat64(16, spec.origin[0], true);
  dv.setFloat64(24, spec.origin[1], true);
  dv.setFloat64(32, spec.origin[2], true);
  dv.setFloat32(40, spec.ringStep ?? 25, true);
  dv.setFloat32(44, spec.collar ?? 0.8, true);
  dv.setFloat32(48, spec.ceiling ?? 0, true);
  for (let e = 0; e < 2; e++) {
    dv.setFloat32(52 + 4 * e, depth[e], true);
    dv.setFloat32(60 + 4 * e, shell[e], true);
    dv.setFloat32(68 + 4 * e, wings[e], true);
    dv.setFloat32(76 + 4 * e, rise[e], true);
  }
  const status = core.exports.tunnel_mesh(specOff, pointsOff, profileOff, resOff);
  core.sync();
  if (status !== 0) throw new Error(`tunnel mesh failed (${status})`);
  const r = new DataView(core.buffer, resOff, resultSize);
  const vertexCount = r.getUint32(0, true), indexCount = r.getUint32(4, true);
  const vOff = r.getUint32(8, true), iOff = r.getUint32(12, true), rings = r.getUint32(20, true);
  const stride = core.exports.tunnel_stride();
  return {
    vertices: copy(core.u8.subarray(vOff, vOff + vertexCount * stride)),
    indices: copy(core.u8.subarray(iOff, iOff + indexCount * 4)),
    vertexCount, indexCount, rings, stride,
  };
}
