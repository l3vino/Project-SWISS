/* cuts.js — the room a tube takes, as the terrain and what is built are cut
 * away from it (Stage 5.17d; the terrain 5.17e).
 *
 * His words (on 5.17c): "it should be able to traverse building walls (like
 * the underground castle wall)"; on 5.17d: "there is weird terrain
 * triangles/Parts inside the tunnel (so that tunnel is not cutting
 * cleanly)", "tunnels kind of disappear at certain view angles". Neither
 * the terrain nor the building layers know anything of the tunnels: the
 * ground over a shallow tube dips into it wherever its tiles are coarser or
 * its fit left it thin, and a castle's wall modelled down into the hill
 * stands across the railway's tunnel under it. So each tube's bore is a
 * chain of points along its middle at its floor, each with its outline
 * there (sections.js outlineAt: as wide as the mesh makes the bore at that
 * point), the mesh's own points (mesh.js meshPoints: straight between them,
 * as the mesh is), run on out of each portal to its collar and CUT_PAST
 * beyond (a wall the portal stands in; not the terrain: the road in front
 * of the portal is its own). Each tile drawn (passes/terrain.js, the
 * terrain at every level; passes/buildings.js) gets the segments of it that
 * reach its box, in its own frame (cutsInFrame): the terrain's in a slot of
 * its own (bore.wgsl, 5.17k), the buildings' in a storage buffer shared by
 * every tile; its fragments inside the bore are not drawn (terrain.wgsl,
 * buildings.wgsl fsCut). Where the ground stands DEEP metres over the vault
 * (a mountain over a tunnel), no tile reaches the bore and nothing is cut.
 * Where bores run into each other (5.17m, boreMeets), each tube's mesh is cut
 * the same way along the others (tunnel.wgsl fsMeet). Like Unity's terrain
 * holes, the room counts for the bodies too (tunnels.js boreAt, roomAt):
 * inside a bore the tunnel's floor holds them, not the terrain over it, and
 * the solids of what is built there are left alone.
 */

import { geodeticToEcef } from '../../core/math.js';
import { outlineAt } from './sections.js';
import { POINT_DOUBLES, MESH_END } from './mesh.js';

/* Doubles a cut point: its middle at the floor (earth-centred, metres), then its outline: the walls' half-width and
 * top, the arch's middle up, half-width and half-height (sections.js outlineAt; archA 0 a flat roof), the floor's
 * half-width between the walkways. */
export const CUT_DOUBLES = 9;
/* Metres the cut of what is built runs on beyond a portal's collar (tunnels.js roomAt: the controllers leave the
 * solids alone there too). */
export const CUT_PAST = 1;
/* Floats a segment in a tile's frame (bore.wgsl and buildings.wgsl Cut): its ends at the floor and their
 * half-widths, then each end's outline (top, archY, archA, archH), then the floor's half-width between the walkways
 * at each end, the walkways' height and the arch's lower half-height (outlineAt inner, kerb, lowR). A negative top:
 * the bore ends there (not run on a little past it, as where two segments meet). */
export const CUT_FLOATS = 20;
/* A slot of pieces (bore.wgsl CutSlot, bound with a dynamic offset: passes/terrain.js a tile's, passes/tunnels.js a
 * tube's): a 16-float header (its frame, how many, how far they reach) and CUT_MOST pieces, padded to the 256 bytes
 * dynamic offsets go by (WebGPU minUniformBufferOffsetAlignment). */
export const CUT_MOST = 31, CUT_HEADER = 16;
export const CUT_SLOT_FLOATS = Math.ceil((CUT_HEADER + CUT_MOST * CUT_FLOATS) / 64) * 64, CUT_SLOT_BYTES = CUT_SLOT_FLOATS * 4;
/* Metres round a piece's ends its bore may reach past its outline (cutsReach). */
const CUT_REACH = 0.5;
/* Metres of ground over the vault from which on nothing reaches into the bore. */
const DEEP = 30;
/* Point flags: deep under the ground; beyond a portal (the collar and CUT_PAST out of it). */
const FLAG_DEEP = 1, FLAG_BEYOND = 2;

const M_LAT = 111132;
const metresLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * A tube's cut.
 * @param mp       mesh.js meshPoints' answer (points: lon, lat, floor, s, …, the bore's middle right of the line, how wide)
 * @param sec      its cross-section (sections.js)
 * @param ends     per end: { type (MESH_END), dirX, dirY (out of it, east and north), collar, rise, open (metres of
 *                 open approach from the collar to the portal as mapped) } (collar, rise and open only for a portal)
 * @param coverAt  (s along the tube) => metres of ground over its vault there (NaN not known), or null
 * @returns { points: Float64Array (CUT_DOUBLES each), flags: Uint8Array, count, centre: [x, y, z], radius (a
 *          bounding sphere round it), kerb, lowR (outlineAt's: the same all along) }
 */
export function boreCut(mp, sec, ends, coverAt = null) {
  const p = mp.points, n = mp.count, out = [], flags = [];
  const put = (lon, lat, h, wide, flag) => {
    const e = geodeticToEcef(lon, lat, h), o = outlineAt(sec, wide);
    out.push(e[0], e[1], e[2], o.half, o.top, o.archY, o.archA, o.archH, o.inner);
    flags.push(flag);
  };
  const middle = (k) => middleOf(p, n, k);
  // Out of a portal: along its way out to the collar and CUT_PAST on, the floor rising as the approach does.
  const beyond = (k, end) => {
    if (end.type !== MESH_END.PORTAL) return;
    const o = k * POINT_DOUBLES, [lon, lat] = middle(k), d = Math.max(0, end.collar ?? 0) + CUT_PAST;
    put(lon + (end.dirX * d) / metresLon(lat), lat + (end.dirY * d) / M_LAT, p[o + 2] + (end.rise ?? 0) * d, p[o + 8], FLAG_BEYOND);
  };
  beyond(0, ends[0]);
  for (let k = 0; k < n; k++) {
    const [lon, lat] = middle(k), o = k * POINT_DOUBLES;
    const cover = coverAt ? coverAt(p[o + 3]) : NaN;
    put(lon, lat, p[o + 2], p[o + 8], cover > DEEP ? FLAG_DEEP : 0);
  }
  beyond(n - 1, ends[1]);
  const thinned = thin(out, flags);
  const points = Float64Array.from(thinned.points), count = points.length / CUT_DOUBLES;
  flags.length = 0;
  flags.push(...thinned.flags);
  const centre = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let j = 0; j < 3; j++) centre[j] += points[i * CUT_DOUBLES + j] / count;
  let radius = 0, reach = 0;
  for (let i = 0; i < count; i++) {
    const o = i * CUT_DOUBLES;
    radius = Math.max(radius, Math.hypot(points[o] - centre[0], points[o + 1] - centre[1], points[o + 2] - centre[2]));
    reach = Math.max(reach, points[o + 3], points[o + 4], points[o + 5] + points[o + 7], points[o + 6]);
  }
  const o = outlineAt(sec, 1);
  return { points, flags: Uint8Array.from(flags), count, centre, radius: radius + reach, kerb: o.kerb, lowR: o.lowR,
    joins: [ends[0]?.type === MESH_END.JOIN, ends[1]?.type === MESH_END.JOIN] };
}

/* The middle of a bore at point k of meshPoints' points: its offset right of the line (as the line runs there). */
function middleOf(p, n, k) {
  const a = Math.max(0, k - 1) * POINT_DOUBLES, b = Math.min(n - 1, k + 1) * POINT_DOUBLES, o = k * POINT_DOUBLES;
  const m = metresLon(p[o + 1]);
  const dx = (p[b] - p[a]) * m, dy = (p[b + 1] - p[a + 1]) * M_LAT, l = Math.hypot(dx, dy) || 1, off = p[o + 7];
  return [p[o] + (off * dy) / l / m, p[o + 1] - (off * dx) / l / M_LAT];
}

/* Metres over the floor of an open approach the terrain is drawn as its floor up to (and as far under it). */
export const APRON_TOP = 0.6;


/**
 * The open approaches in front of a tube (5.17n): from a portal as mapped to its collar the tube is not built (fit.js:
 * the ground over it is too thin) and the road or railway runs on in an open cutting, where the photo shows the
 * hillside over the real portal (his words on 5.17m: "there is still terrain on the track"; by Giubiasco 13.9 m of the
 * hillside's green across the tracks in front of the Ceneri base tunnel's tube). Their floors, as wide as the bore's
 * between its walkways, are drawn as the tube's (terrain.wgsl: the tunnel's own roads and tracks on them), pieces of
 * the terrain's slot marked by a negative kerb. Kept on the cut (`aprons`), its sphere grown round them.
 * @param cut     boreCut's answer
 * @param aprons  meshPoints' answers, one an approach (their floors as the approach runs)
 * @param sec     the tube's section
 */
export function addAprons(cut, aprons, sec) {
  cut.aprons = aprons.filter((mp) => mp.count >= 2).map((mp) => {
    const p = mp.points, n = mp.count, out = [];
    for (let k = 0; k < n; k++) {
      const [lon, lat] = middleOf(p, n, k), o = k * POINT_DOUBLES, e = geodeticToEcef(lon, lat, p[o + 2]), w = outlineAt(sec, p[o + 8]);
      out.push(e[0], e[1], e[2], w.inner, APRON_TOP, 0, 0, 0, w.inner);
      cut.radius = Math.max(cut.radius, Math.hypot(e[0] - cut.centre[0], e[1] - cut.centre[1], e[2] - cut.centre[2]) + w.inner + APRON_TOP);
    }
    return { points: Float64Array.from(out), count: n, kerb: -1, lowR: 0 };
  });
  return cut;
}

/* A bore's points without those it runs straight through (5.17k): a point goes where it lies within MERGE_OFF of the
 * line between the points kept either side of it (5 cm: the terrain is cut within that of the bore), its outline within
 * MERGE_OUT of that line's, with the same flags as
 * both, and the two no further apart than MERGE_LONG. The mesh has a ring every couple of metres, and a tile's pixels
 * look at each piece that reaches it (passes/terrain.js: at most CUT_MOST a tile, the nearest first; 1686 pieces over
 * 14 tiles where his GPU was reset in 5.17h): now a few a tube where it runs straight. */
const MERGE_OFF = 0.05, MERGE_OUT = 0.02, MERGE_LONG = 150;

function thin(pts, flags) {
  const n = flags.length, D = CUT_DOUBLES, keep = [0];
  if (n < 3) return { points: pts, flags: [...flags] };
  const straight = (i, j) => {
    const a = i * D, b = j * D;
    const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], dz = pts[b + 2] - pts[a + 2], l2 = dx * dx + dy * dy + dz * dz;
    if (l2 > MERGE_LONG * MERGE_LONG || flags[j] !== flags[i]) return false;
    for (let k = i + 1; k < j; k++) {
      if (flags[k] !== flags[i]) return false;
      const o = k * D;
      const t = l2 > 1e-9 ? ((pts[o] - pts[a]) * dx + (pts[o + 1] - pts[a + 1]) * dy + (pts[o + 2] - pts[a + 2]) * dz) / l2 : 0;
      if (t < 0 || t > 1) return false;
      if (Math.hypot(pts[o] - pts[a] - dx * t, pts[o + 1] - pts[a + 1] - dy * t, pts[o + 2] - pts[a + 2] - dz * t) > MERGE_OFF) return false;
      for (let q = 3; q < D; q++) if (Math.abs(pts[o + q] - (pts[a + q] + (pts[b + q] - pts[a + q]) * t)) > MERGE_OUT) return false;
    }
    return true;
  };
  for (let i = 0; i < n - 1;) {
    let j = i + 1;
    while (j + 1 < n && straight(i, j + 1)) j++;
    keep.push(j);
    i = j;
  }
  const points = [], kept = [];
  for (const k of keep) { for (let q = 0; q < D; q++) points.push(pts[k * D + q]); kept.push(flags[k]); }
  return { points, flags: kept };
}

/**
 * The segments of the bores that reach a box, in its frame (CUT_FLOATS each), appended to `out` (an array).
 * @param cuts    boreCut answers
 * @param frame   { origin: [x, y, z] earth-centred, east, north, up: unit vectors }: the tile's
 * @param lo, size  the box in that frame (metres: its least corner and its size)
 * @param terrain  true: the terrain's (the bore not run on beyond its portals, nor past its ends)
 * @returns out
 */
export function cutsInFrame(cuts, frame, lo, size, terrain, out = []) {
  const o = frame.origin, e = frame.east, n = frame.north, u = frame.up;
  // The box's middle, earth-centred, and half its diagonal.
  const cx = lo[0] + size[0] / 2, cy = lo[1] + size[1] / 2, cz = lo[2] + size[2] / 2;
  const mid = [0, 1, 2].map((k) => o[k] + e[k] * cx + n[k] * cy + u[k] * cz);
  const reach = Math.hypot(size[0], size[1], size[2]) / 2 + MARGIN;
  const a = [0, 0, 0], b = [0, 0, 0];
  const local = (p, i, q) => {
    const dx = p[i] - o[0], dy = p[i + 1] - o[1], dz = p[i + 2] - o[2];
    q[0] = dx * e[0] + dy * e[1] + dz * e[2];
    q[1] = dx * n[0] + dy * n[1] + dz * n[2];
    q[2] = dx * u[0] + dy * u[1] + dz * u[2];
  };
  for (const cut of cuts) {
    if (Math.hypot(cut.centre[0] - mid[0], cut.centre[1] - mid[1], cut.centre[2] - mid[2]) > cut.radius + reach) continue;
    const p = cut.points, f = cut.flags;
    // The first and last points the terrain's cut runs between (not those beyond the portals).
    let first = 0, last = cut.count - 1;
    if (terrain) {
      while (first < last && f[first] & FLAG_BEYOND) first++;
      while (last > first && f[last] & FLAG_BEYOND) last--;
    }
    for (let i = first + 1; i <= last; i++) {
      const pa = (i - 1) * CUT_DOUBLES, pb = i * CUT_DOUBLES;
      if (f[i - 1] & f[i] & FLAG_DEEP) continue;
      local(p, pa, a);
      local(p, pb, b);
      // The segment's box: its ends, as wide as its outline and as high as its crown.
      const side = Math.max(p[pa + 3], p[pa + 6], p[pb + 3], p[pb + 6]) + MARGIN;
      const top = Math.max(p[pa + 4], p[pa + 5] + p[pa + 7], p[pb + 4], p[pb + 5] + p[pb + 7]) + MARGIN;
      if (Math.min(a[0], b[0]) - side > lo[0] + size[0] || Math.max(a[0], b[0]) + side < lo[0]) continue;
      if (Math.min(a[1], b[1]) - side > lo[1] + size[1] || Math.max(a[1], b[1]) + side < lo[1]) continue;
      if (Math.min(a[2], b[2]) - MARGIN > lo[2] + size[2] || Math.max(a[2], b[2]) + top < lo[2]) continue;
      // The terrain's bore ends exactly at its first and last points.
      pushPiece(out, cut, pa, pb, a, b, terrain && i - 1 === first, terrain && i === last);
    }
    // Its open approaches' floors (the terrain's only).
    for (const ap of terrain ? cut.aprons ?? [] : []) {
      const q = ap.points;
      for (let i = 1; i < ap.count; i++) {
        const pa = (i - 1) * CUT_DOUBLES, pb = i * CUT_DOUBLES;
        local(q, pa, a);
        local(q, pb, b);
        const side = Math.max(q[pa + 3], q[pb + 3], q[pa + 6], q[pb + 6]) + MARGIN;
        const top = Math.max(q[pa + 4], q[pb + 4], q[pa + 5] + q[pa + 7], q[pb + 5] + q[pb + 7]) + MARGIN;
        if (Math.min(a[0], b[0]) - side > lo[0] + size[0] || Math.max(a[0], b[0]) + side < lo[0]) continue;
        if (Math.min(a[1], b[1]) - side > lo[1] + size[1] || Math.max(a[1], b[1]) + side < lo[1]) continue;
        if (Math.min(a[2], b[2]) - APRON_TOP - MARGIN > lo[2] + size[2] || Math.max(a[2], b[2]) + top < lo[2]) continue;
        pushPiece(out, ap, pa, pb, a, b, i === 1, i === ap.count - 1);
      }
    }
  }
  return out;
}

/* Metres round a box a segment still counts as reaching it. */
const MARGIN = 0.5;

/* A piece (bore.wgsl Cut) from point pa to point pb of a cut's points, its ends a and b already in the frame: their
 * outlines; endA, endB: the bore ends there (a negative top). */
function pushPiece(out, cut, pa, pb, a, b, endA, endB, main = false) {
  const p = cut.points;
  out.push(a[0], a[1], a[2], p[pa + 3], b[0], b[1], b[2], p[pb + 3],
    (endA ? -1 : 1) * p[pa + 4], p[pa + 5], p[pa + 6], p[pa + 7], (endB ? -1 : 1) * p[pb + 4], p[pb + 5], p[pb + 6], p[pb + 7],
    p[pa + 8], p[pb + 8], cut.kerb, main ? -1 - cut.lowR : cut.lowR);
}

/* Whether bore A opens into bore B: one of A's JOIN ends lies within B's reach (its pieces' half-width and a metre of
 * its floor line), so A is a branch of B, whose tracks run on to the switch (tunnel.wgsl inMain, 5.17q). */
function opensInto(A, B) {
  for (const e of [0, 1]) {
    if (!A.joins?.[e]) continue;
    const o = (e ? A.count - 1 : 0) * CUT_DOUBLES;
    for (let k = 0; k + 1 < B.count; k++) {
      const pa = k * CUT_DOUBLES, pb = pa + CUT_DOUBLES, P = B.points, Q = A.points;
      const dx = P[pb] - P[pa], dy = P[pb + 1] - P[pa + 1], dz = P[pb + 2] - P[pa + 2], l2 = dx * dx + dy * dy + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((Q[o] - P[pa]) * dx + (Q[o + 1] - P[pa + 1]) * dy + (Q[o + 2] - P[pa + 2]) * dz) / l2)) : 0;
      const d = Math.hypot(Q[o] - P[pa] - dx * t, Q[o + 1] - P[pa + 1] - dy * t, Q[o + 2] - P[pa + 2] - dz * t);
      if (d <= Math.max(P[pa + 3], P[pb + 3]) + 1) return true;
    }
  }
  return false;
}

/* How far a slot's pieces reach (their frame): { widest, top, box: [least east, north, most east, north] }. */
export function cutsReach(out) {
  let widest = 0, top = -Infinity;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < out.length; k += CUT_FLOATS) {
    widest = Math.max(widest, out[k + 3], out[k + 7], out[k + 10], out[k + 14]);
    for (let e = 0; e < 2; e++) {
      const p = k + 4 * e, o = k + 8 + 4 * e, r = Math.max(out[p + 3], out[o + 2]) + CUT_REACH;
      box[0] = Math.min(box[0], out[p] - r); box[1] = Math.min(box[1], out[p + 1] - r);
      box[2] = Math.max(box[2], out[p] + r); box[3] = Math.max(box[3], out[p + 1] + r);
      top = Math.max(top, out[p + 2] + Math.max(Math.abs(out[o]), out[o + 1] + out[o + 3]) + CUT_REACH);
    }
  }
  return { widest, top, box: Float32Array.from(box) };
}

/* A slot's pieces, the nearest the camera first (in place). f: their frame (origin, east, north). */
export function nearestFirst(out, f, camera) {
  const dx = camera[0] - f.origin[0], dy = camera[1] - f.origin[1], dz = camera[2] - f.origin[2];
  const cx = dx * f.east[0] + dy * f.east[1] + dz * f.east[2], cy = dx * f.north[0] + dy * f.north[1] + dz * f.north[2];
  const n = out.length / CUT_FLOATS, order = [];
  for (let i = 0; i < n; i++) {
    const k = i * CUT_FLOATS, mx = (out[k] + out[k + 4]) / 2 - cx, my = (out[k + 1] + out[k + 5]) / 2 - cy;
    order.push([mx * mx + my * my, i]);
  }
  order.sort((a, b) => a[0] - b[0]);
  const copy = out.slice();
  order.forEach(([, i], j) => { for (let q = 0; q < CUT_FLOATS; q++) out[j * CUT_FLOATS + q] = copy[i * CUT_FLOATS + q]; });
}

/* Metres more than both pieces' reach two pieces may be apart and still count as meeting (boreMeets). */
const MEET_MARGIN = 0.5;

/**
 * Where bores run into each other (5.17m; his words on 5.17l: "count for tunnels merging, or 2 tunnels near
 * eachother and then merging"): a branch opening into its main tube, carriageways or tracks joining, two tubes side
 * by side that become one. Each tube's mesh is whole in itself, walls, floor and vault (a JOIN end is left open,
 * tunnel.c), so where two overlap each stands inside the other's room; each now leaves out what of it lies inside
 * the other's bore (tunnel.wgsl fsMeet), and what is left is one room. Here: for each cut, the pieces of the others
 * near enough to reach into it (their segments within both reaches of one of its own).
 * @param cuts  boreCut answers (one per mesh)
 * @returns per cut, the others reaching into it: [{ other: index into cuts, pieces: [segment index, …] }]
 */
export function boreMeets(cuts) {
  const out = cuts.map(() => []);
  const reach = cuts.map(pieceReach);
  for (let i = 0; i < cuts.length; i++) {
    for (let j = i + 1; j < cuts.length; j++) {
      const A = cuts[i], B = cuts[j];
      if (Math.hypot(A.centre[0] - B.centre[0], A.centre[1] - B.centre[1], A.centre[2] - B.centre[2]) > A.radius + B.radius) continue;
      const inA = new Set(), inB = new Set();
      for (let a = 1; a < A.count; a++) {
        for (let b = 1; b < B.count; b++) {
          if (segmentGap(A.points, a - 1, B.points, b - 1) > reach[i][a - 1] + reach[j][b - 1] + MEET_MARGIN) continue;
          inA.add(a - 1);
          inB.add(b - 1);
        }
      }
      if (inB.size) out[i].push({ other: j, pieces: [...inB].sort((x, y) => x - y), main: opensInto(A, B) });
      if (inA.size) out[j].push({ other: i, pieces: [...inA].sort((x, y) => x - y), main: opensInto(B, A) });
    }
  }
  return out;
}

/**
 * The pieces of the other bores that reach into one (boreMeets), in its mesh's frame (CUT_FLOATS each), appended to
 * `out`. Each bore ends at its own first and last points (a JOIN end opens into the other; no quarter metre past it).
 * @param cuts   boreCut answers
 * @param meets  boreMeets(cuts)[i]: those reaching into bore i
 * @param frame  { origin: [x, y, z] earth-centred, east, north, up }: its mesh's
 */
export function meetsInFrame(cuts, meets, frame, out = []) {
  const o = frame.origin, e = frame.east, n = frame.north, u = frame.up, a = [0, 0, 0], b = [0, 0, 0];
  const local = (p, k, q) => {
    const dx = p[k] - o[0], dy = p[k + 1] - o[1], dz = p[k + 2] - o[2];
    q[0] = dx * e[0] + dy * e[1] + dz * e[2];
    q[1] = dx * n[0] + dy * n[1] + dz * n[2];
    q[2] = dx * u[0] + dy * u[1] + dz * u[2];
  };
  for (const { other, pieces, main } of meets) {
    const c = cuts[other], p = c.points;
    for (const k of pieces) {
      const pa = k * CUT_DOUBLES, pb = (k + 1) * CUT_DOUBLES;
      local(p, pa, a);
      local(p, pb, b);
      pushPiece(out, c, pa, pb, a, b, k === 0, k + 1 === c.count - 1, main);
    }
  }
  return out;
}

/* How far each of a cut's pieces (from point k to k + 1) reaches from its floor line: its outline's widest and
 * highest, the hypotenuse of the two. */
function pieceReach(cut) {
  const p = cut.points, n = cut.count, out = new Float64Array(Math.max(0, n - 1));
  const of = (o) => Math.hypot(Math.max(p[o + 3], p[o + 6]), Math.max(p[o + 4], p[o + 5] + p[o + 7]));
  for (let k = 0; k + 1 < n; k++) out[k] = Math.max(of(k * CUT_DOUBLES), of((k + 1) * CUT_DOUBLES));
  return out;
}

/* The least distance between segment a (points a, a + 1 of P) and segment b (points b, b + 1 of Q): Ericson,
 * Real-Time Collision Detection, 5.1.9. */
function segmentGap(P, a, Q, b) {
  const p = a * CUT_DOUBLES, q = p + CUT_DOUBLES, r = b * CUT_DOUBLES, s = r + CUT_DOUBLES;
  const d1x = P[q] - P[p], d1y = P[q + 1] - P[p + 1], d1z = P[q + 2] - P[p + 2];
  const d2x = Q[s] - Q[r], d2y = Q[s + 1] - Q[r + 1], d2z = Q[s + 2] - Q[r + 2];
  const rx = P[p] - Q[r], ry = P[p + 1] - Q[r + 1], rz = P[p + 2] - Q[r + 2];
  const aa = d1x * d1x + d1y * d1y + d1z * d1z, ee = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let t1 = 0, t2 = 0;
  if (aa < 1e-9 && ee < 1e-9) { t1 = 0; t2 = 0; }
  else if (aa < 1e-9) { t2 = clamp01(f / ee); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (ee < 1e-9) { t1 = clamp01(-c / aa); }
    else {
      const bb = d1x * d2x + d1y * d2y + d1z * d2z, den = aa * ee - bb * bb;
      t1 = den > 1e-12 ? clamp01((bb * f - c * ee) / den) : 0;
      t2 = (bb * t1 + f) / ee;
      if (t2 < 0) { t2 = 0; t1 = clamp01(-c / aa); }
      else if (t2 > 1) { t2 = 1; t1 = clamp01((bb - c) / aa); }
    }
  }
  return Math.hypot(rx + d1x * t1 - d2x * t2, ry + d1y * t1 - d2y * t2, rz + d1z * t1 - d2z * t2);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
