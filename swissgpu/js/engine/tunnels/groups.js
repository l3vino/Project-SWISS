/* groups.js — tunnel runs (runs.js) from the tiles round the camera made
 * into tubes: one bore each, with the line it follows, how wide it is along
 * it, and what each of its ends is.
 *
 * Runs are cut where another tunnel line of their family ends on them (a
 * switch, a carriageway joining), then joined into chains where they go on:
 * across a tile's edge (two CUT ends within JOIN_CUT) and at nodes (two NODE
 * ends within JOIN_NODE), the straightest pair first, whatever their layers
 * (a line's layer changes along a tunnel). Chains of one family that run
 * beside each other, within TUBE_APART and parallel, over a share of the
 * shorter one share a bore: a double-track railway tunnel's two tracks lie
 * 4 to 4.5 m apart, a station's tracks in one cavern too; a motorway's two
 * tubes lie 25 to 50 m apart, single-track base tunnels' 17 to 40 m, and get
 * one each. A bore's spine is its longest chain; every SPINE_STEP along it,
 * the other chains beside it set how far the bore reaches either side (the
 * tracks fanning out to the switches behind a portal), held and smoothed
 * along. What of a chain lies beyond that (a branch leaving the bore) makes a
 * bore of its own. A bore's ends:
 *   PORTAL  the spine, or a chain beside it near its end, comes out;
 *   OPEN    it runs on beyond the tiles looked at (trace.js follows it);
 *   CLOSED  it stops (a dead end, or the data stops);
 *   JOIN    it meets another bore (a branch, carriageways joining).
 * Runs on a decode thread (workers/codec.js, 'tunnel-tubes').
 */

import { END } from './runs.js';

/* Metres two CUT ends (the tiles' crossing points differ by tenths of a
 * metre) and two NODE ends may be apart and still be the same point, and
 * how far back from an end its way is taken (the last few metres of a line
 * at a node are often a short kink). */
const JOIN_CUT = 2;
const JOIN_NODE = 0.5;
const JOIN_LOOK = 20;
/* Metres apart, and how parallel (cosine), two chains may be and run in one
 * bore, and how much of the shorter (share of its samples) must. 15 m: the
 * two carriageways drawn 10 to 14 m apart for the first 400 m inside the
 * Gotthard road tunnel's wide north portal at Göschenen are one bore; twin
 * single-track tubes (17 m and more) are not. */
const TUBE_APART = 15;
const TUBE_PARALLEL = 0.8;
const TUBE_SHARE = 0.3;
const SHARE_STEP = 4;
/* Metres between the spine's samples, how far along and across another
 * chain's points are looked for beside one, and the shortest stretch of a
 * chain outside its bore that makes a bore of its own. */
export const SPINE_STEP = 2;
const BESIDE_ALONG = 1.5;
const BESIDE_ACROSS = 20;
const BRANCH_LEAST = 10;
/* Metres over which the reach is held (the most within WIDTH_HOLD) and then
 * smoothed (a tent over WIDTH_SMOOTH either side) along the spine. */
const WIDTH_HOLD = 6;
const WIDTH_SMOOTH = 10;
/* Metres from a spine's end within which a chain beside it coming out makes
 * the bore's end a portal. */
const PORTAL_NEAR = 25;

export const TUBE_END = { PORTAL: 1, OPEN: 2, CLOSED: 3, JOIN: 4 };
/* Floats per spine point in a tube's points. */
export const TUBE_POINT = 5;

const M_LAT = 111132;

/**
 * Tubes from runs.
 * @param runs  [{ kind, family, layer, points: Float64Array [lon, lat, …], ends: [{ type, degree }, …] }]
 *              from every tile near the camera (each tile's runs only inside it)
 * @param priority  kind id → importance (the most important kind names a tube)
 * @returns [{ key, family, kind, layer, tracks, length,
 *            points: Float64Array, TUBE_POINT per sample: lon, lat, metres along, the bore's middle that many metres
 *              right of the spine, metres it reaches beyond one line either side,
 *            ends: [{ type, lon, lat, dirX, dirY (unit, east and north, outwards) }, …] }]
 */
export function tubesFrom(runs, priority = {}) {
  if (!runs.length) return [];
  // A local frame in metres round the runs' middle.
  let lon0 = 0, lat0 = 0, np = 0;
  for (const r of runs) for (let i = 0; i < r.points.length; i += 2) { lon0 += r.points[i]; lat0 += r.points[i + 1]; np++; }
  lon0 /= np; lat0 /= np;
  const M_LON = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const frame = { lon0, lat0, M_LON };

  // 0. Runs in metres, cut where another run's NODE end lies on one of their points.
  let rs = runs.map((r) => {
    const n = r.points.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
    for (let k = 0; k < n; k++) { xs[k] = (r.points[2 * k] - lon0) * M_LON; ys[k] = (r.points[2 * k + 1] - lat0) * M_LAT; }
    return { xs, ys, n, family: r.family, layer: r.layer, kind: r.kind, ends: r.ends.map((e) => e.type) };
  });
  rs = cutAtNodes(rs);

  // 1. Join runs at their ends: end e of run i is 2i + e.
  const ends = [];
  rs.forEach((q, i) => {
    for (let e = 0; e < 2; e++) {
      const k = e ? q.n - 1 : 0, [ox, oy] = outward(q, e);
      ends.push({ run: i, e, x: q.xs[k], y: q.ys[k], ox, oy, type: q.ends[e], family: q.family, mate: -1 });
    }
  });
  const endGrid = new Grid(4);
  ends.forEach((d, i) => endGrid.addPoint(d.x, d.y, i));
  const pairs = [], found = [];
  ends.forEach((d, i) => {
    if (d.type !== END.CUT && d.type !== END.NODE) return;
    const reach = d.type === END.CUT ? JOIN_CUT : JOIN_NODE;
    for (const j of endGrid.near(d.x, d.y, reach, found)) {
      if (j <= i) continue;
      const f = ends[j];
      if (f.run === d.run || f.family !== d.family || f.type !== d.type) continue;
      const dist = Math.hypot(f.x - d.x, f.y - d.y);
      if (dist > reach) continue;
      // How straight the line runs on through the join: the two ends point away from each other.
      const straight = -(d.ox * f.ox + d.oy * f.oy);
      if (straight < 0.5) continue;
      pairs.push({ i, j, score: straight - dist * 0.01 });
    }
  });
  pairs.sort((a, b) => b.score - a.score);
  for (const p of pairs) {
    if (ends[p.i].mate >= 0 || ends[p.j].mate >= 0) continue;
    ends[p.i].mate = p.j; ends[p.j].mate = p.i;
  }

  // 2. Chains: runs walked through their joins, from an unjoined end (then loops).
  const used = new Uint8Array(rs.length);
  const chains = [];
  const walk = (start) => {
    const xs = [], ys = [], kinds = new Set();
    let layer = Infinity, e = start, last;
    for (;;) {
      const run = rs[ends[e].run];
      used[ends[e].run] = 1;
      kinds.add(run.kind);
      layer = Math.min(layer, run.layer);
      const fwd = ends[e].e === 0;
      for (let k = xs.length ? 1 : 0; k < run.n; k++) { const kk = fwd ? k : run.n - 1 - k; xs.push(run.xs[kk]); ys.push(run.ys[kk]); }
      last = 2 * ends[e].run + (fwd ? 1 : 0);
      const mate = ends[last].mate;
      if (mate < 0 || used[ends[mate].run]) break;
      e = mate;
    }
    return chainOf(xs, ys, ends[start].family, layer, kinds, [endType(ends[start]), endType(ends[last])]);
  };
  for (let i = 0; i < ends.length; i++) if (!used[ends[i].run] && ends[i].mate < 0) chains.push(walk(i));
  for (let i = 0; i < rs.length; i++) if (!used[i]) chains.push(walk(2 * i));

  // 3. Chains beside each other share a bore (union–find).
  const parent = chains.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (let a = 0; a < chains.length; a++) for (let b = a + 1; b < chains.length; b++) {
    const A = chains[a], B = chains[b];
    if (A.family !== B.family || !boxesNear(A.box, B.box, TUBE_APART)) continue;
    const [short, long] = A.length <= B.length ? [A, B] : [B, A];
    if (sharesBore(short, long)) parent[find(a)] = find(b);
  }
  const clusters = new Map();
  chains.forEach((c, i) => { const r = find(i); if (!clusters.has(r)) clusters.set(r, []); clusters.get(r).push(c); });

  // 4. Per cluster, bores: the longest chain left is a spine; what lies beside it, its width; what lies beyond, more chains.
  const tubes = [];
  for (let members of clusters.values()) {
    while (members.length) {
      let si = 0;
      for (let i = 1; i < members.length; i++) if (members[i].length > members[si].length) si = i;
      const spine = members[si], others = members.filter((_, i) => i !== si);
      const { tube, left } = boreOf(spine, others, frame, priority);
      if (tube) tubes.push(tube);
      members = left;
    }
  }
  return tubes;
}

/* A tube's name: its family and ends to ~10 m, either way round. */
export function tubeKey(family, lonA, latA, lonB, latB) {
  const q = (v) => Math.round(v * 10000);
  let a = `${q(lonA)},${q(latA)}`, b = `${q(lonB)},${q(latB)}`;
  if (a > b) [a, b] = [b, a];
  return `${family}|${a}|${b}`;
}

/* An end's kind as a bore's: a CUT nothing went on from runs beyond the tiles; a NODE nothing went on from meets
 * other tunnel lines (another bore, or a line of this one beside). */
function endType(d) {
  switch (d.type) {
    case END.PORTAL: return TUBE_END.PORTAL;
    case END.CUT: return TUBE_END.OPEN;
    case END.NODE: return TUBE_END.JOIN;
    default: return TUBE_END.CLOSED;
  }
}

/* The way out of a run at end e (unit): from the point JOIN_LOOK back along it (or its other end) to the end. */
function outward(q, e) {
  const step = e ? -1 : 1, k0 = e ? q.n - 1 : 0;
  let k = k0, len = 0;
  while (k + step >= 0 && k + step < q.n && len < JOIN_LOOK) {
    len += Math.hypot(q.xs[k + step] - q.xs[k], q.ys[k + step] - q.ys[k]);
    k += step;
  }
  const dx = q.xs[k0] - q.xs[k], dy = q.ys[k0] - q.ys[k], l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

/* Runs cut at their points where another run's NODE end (same family) lies. */
function cutAtNodes(rs) {
  const nodes = new Grid(2), found = [];
  const nodeEnds = [];
  rs.forEach((q, i) => {
    for (let e = 0; e < 2; e++) {
      if (q.ends[e] !== END.NODE) continue;
      const k = e ? q.n - 1 : 0;
      nodes.addPoint(q.xs[k], q.ys[k], nodeEnds.length);
      nodeEnds.push({ run: i, x: q.xs[k], y: q.ys[k], family: q.family });
    }
  });
  if (!nodeEnds.length) return rs;
  const out = [];
  rs.forEach((q, i) => {
    const cuts = [];
    for (let k = 1; k + 1 < q.n; k++) {
      for (const j of nodes.near(q.xs[k], q.ys[k], JOIN_NODE, found)) {
        const d = nodeEnds[j];
        if (d.run === i || d.family !== q.family || Math.hypot(d.x - q.xs[k], d.y - q.ys[k]) > JOIN_NODE) continue;
        if (cuts[cuts.length - 1] !== k) cuts.push(k);
      }
    }
    if (!cuts.length) { out.push(q); return; }
    let from = 0;
    for (const k of [...cuts, q.n - 1]) {
      out.push({ ...q, xs: q.xs.subarray(from, k + 1), ys: q.ys.subarray(from, k + 1), n: k + 1 - from,
        ends: [from === 0 ? q.ends[0] : END.NODE, k === q.n - 1 ? q.ends[1] : END.NODE] });
      from = k;
    }
  });
  return out;
}

/* A chain from its points: lengths along, its box, and samples every SPINE_STEP or a little less (X, Y, and the way
 * along there TX, TY). */
function chainOf(xs, ys, family, layer, kinds, ends) {
  const n = xs.length, c = { xs: Float64Array.from(xs), ys: Float64Array.from(ys), n, family, layer, kinds, ends, grid: null };
  c.arc = new Float64Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    if (k) c.arc[k] = c.arc[k - 1] + Math.hypot(c.xs[k] - c.xs[k - 1], c.ys[k] - c.ys[k - 1]);
    x0 = Math.min(x0, c.xs[k]); y0 = Math.min(y0, c.ys[k]); x1 = Math.max(x1, c.xs[k]); y1 = Math.max(y1, c.ys[k]);
  }
  c.length = c.arc[n - 1];
  c.box = [x0, y0, x1, y1];
  const steps = (c.steps = Math.max(1, Math.ceil(c.length / SPINE_STEP)));
  c.ds = c.length / steps;
  c.X = new Float64Array(steps + 1); c.Y = new Float64Array(steps + 1);
  c.TX = new Float64Array(steps + 1); c.TY = new Float64Array(steps + 1);
  let seg = 0, tx = 1, ty = 0;
  for (let k = 0; k <= steps; k++) {
    const s = k * c.ds;
    while (seg < n - 2 && c.arc[seg + 1] < s) seg++;
    const span = c.arc[seg + 1] - c.arc[seg], f = span > 0 ? Math.min(1, Math.max(0, (s - c.arc[seg]) / span)) : 0;
    const dx = c.xs[seg + 1] - c.xs[seg], dy = c.ys[seg + 1] - c.ys[seg], l = Math.hypot(dx, dy);
    if (l > 0) { tx = dx / l; ty = dy / l; }
    c.X[k] = c.xs[seg] + dx * f; c.Y[k] = c.ys[seg] + dy * f; c.TX[k] = tx; c.TY[k] = ty;
  }
  return c;
}

/* A grid of a chain's samples (made when first asked for). */
function sampleGrid(c) {
  if (c.grid) return c.grid;
  c.grid = new Grid(16);
  for (let k = 0; k <= c.steps; k++) c.grid.addPoint(c.X[k], c.Y[k], k);
  return c.grid;
}

/* The sample of a chain nearest (x, y) within r, or −1. */
function nearestSample(c, x, y, r, found) {
  let best = -1, bd = r * r;
  for (const j of sampleGrid(c).near(x, y, r, found)) {
    const d = (c.X[j] - x) ** 2 + (c.Y[j] - y) ** 2;
    if (d <= bd) { bd = d; best = j; }
  }
  return best;
}

function boxesNear(a, b, r) {
  return a[0] - r <= b[2] && b[0] - r <= a[2] && a[1] - r <= b[3] && b[1] - r <= a[3];
}

/* Whether the shorter chain runs beside the longer, parallel and within TUBE_APART, over TUBE_SHARE of it (every
 * SHARE_STEP along it). */
function sharesBore(short, long) {
  const found = [], every = Math.max(1, Math.round(SHARE_STEP / Math.max(short.ds, 1e-3)));
  let near = 0, looked = 0;
  for (let k = 0; k <= short.steps; k += every) {
    looked++;
    const j = nearestSample(long, short.X[k], short.Y[k], TUBE_APART, found);
    if (j >= 0 && Math.abs(short.TX[k] * long.TX[j] + short.TY[k] * long.TY[j]) >= TUBE_PARALLEL) near++;
  }
  return near >= 2 && near >= TUBE_SHARE * looked;
}

/* The bore round a spine: its samples, the reach of the others beside it, its ends; and what of the others lies
 * beyond it, as chains. */
function boreOf(spine, others, frame, priority) {
  const { lon0, lat0, M_LON } = frame;
  const { steps, ds, X, Y, TX, TY } = spine;
  const lo = new Float64Array(steps + 1), hi = new Float64Array(steps + 1), lines = new Uint8Array(steps + 1).fill(1);
  const left = [], found = [];
  const kinds = new Set(spine.kinds);
  let layer = spine.layer, wide = false;
  const portals = [];                       // metres along the spine where a chain beside it comes out
  for (const c of others) {
    const n = c.steps;
    const at = new Int32Array(n + 1).fill(-1);
    const mark = new Uint8Array(steps + 1);
    let covered = 0;
    for (let k = 0; k <= n; k++) {
      const best = nearestSample(spine, c.X[k], c.Y[k], BESIDE_ACROSS, found);
      if (best < 0) continue;
      const dx = c.X[k] - X[best], dy = c.Y[k] - Y[best];
      const along = dx * TX[best] + dy * TY[best], across = dx * TY[best] - dy * TX[best];
      if (Math.abs(along) > BESIDE_ALONG) continue;
      at[k] = best; covered++;
      if (across < lo[best]) lo[best] = across;
      if (across > hi[best]) hi[best] = across;
      mark[best] = 1;
    }
    if (covered) {
      wide = true;
      for (let k = 0; k <= steps; k++) lines[k] += mark[k];
      for (const kd of c.kinds) kinds.add(kd);
      layer = Math.min(layer, c.layer);
      for (const e of [0, 1]) if (c.ends[e] === TUBE_END.PORTAL && at[e ? n : 0] >= 0) portals.push(at[e ? n : 0] * ds);
    }
    // Stretches beyond the bore, BRANCH_LEAST long or more, go on as chains of their own.
    for (let k = 0; k <= n;) {
      if (at[k] >= 0) { k++; continue; }
      let e = k;
      while (e < n && at[e + 1] < 0) e++;
      const a = k * c.ds, b = e * c.ds;
      if (b - a >= BRANCH_LEAST) left.push(stretch(c, a, b, k === 0 ? c.ends[0] : TUBE_END.JOIN, e === n ? c.ends[1] : TUBE_END.JOIN));
      k = e + 1;
    }
  }
  if (spine.length < 1) return { tube: null, left };
  if (wide) {
    holdAndSmooth(lo, Math.round(WIDTH_HOLD / ds), Math.round(WIDTH_SMOOTH / ds), -1);
    holdAndSmooth(hi, Math.round(WIDTH_HOLD / ds), Math.round(WIDTH_SMOOTH / ds), 1);
  }
  const points = new Float64Array((steps + 1) * TUBE_POINT);
  for (let k = 0; k <= steps; k++) {
    const o = k * TUBE_POINT;
    points[o] = lon0 + X[k] / M_LON; points[o + 1] = lat0 + Y[k] / M_LAT; points[o + 2] = k * ds;
    points[o + 3] = (lo[k] + hi[k]) / 2; points[o + 4] = (hi[k] - lo[k]) / 2;
  }
  const ends = [0, 1].map((e) => {
    const k = e ? steps : 0, dir = e ? 1 : -1;
    let type = spine.ends[e];
    if (type !== TUBE_END.PORTAL && portals.some((s) => Math.abs(s - k * ds) <= PORTAL_NEAR)) type = TUBE_END.PORTAL;
    return { type, lon: points[k * TUBE_POINT], lat: points[k * TUBE_POINT + 1], dirX: TX[k] * dir, dirY: TY[k] * dir };
  });
  // Lines side by side: the most common count along the bore.
  const counts = new Map();
  for (const v of lines) counts.set(v, (counts.get(v) ?? 0) + 1);
  let tracks = 1, most = 0;
  for (const [v, c] of counts) if (c > most) { most = c; tracks = v; }
  let kind = null;
  for (const kd of kinds) if (kind === null || (priority[kd] ?? 0) > (priority[kind] ?? 0)) kind = kd;
  const key = tubeKey(spine.family, ends[0].lon, ends[0].lat, ends[1].lon, ends[1].lat);
  return { tube: { key, family: spine.family, kind, layer, tracks, length: spine.length, points, ends }, left };
}

/* The part of a chain from a to b metres along, as a chain. */
function stretch(c, a, b, endA, endB) {
  const xs = [], ys = [];
  const pa = pointAt(c, a), pb = pointAt(c, b);
  xs.push(pa.x); ys.push(pa.y);
  for (let k = 0; k < c.n; k++) if (c.arc[k] > a && c.arc[k] < b) { xs.push(c.xs[k]); ys.push(c.ys[k]); }
  xs.push(pb.x); ys.push(pb.y);
  return chainOf(xs, ys, c.family, c.layer, c.kinds, [endA, endB]);
}

/* The point s metres along a chain, and the way along there (unit). */
function pointAt(c, s) {
  let lo = 0, hi = c.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.arc[m] <= s) lo = m; else hi = m; }
  const span = c.arc[hi] - c.arc[lo], f = span > 0 ? Math.min(1, Math.max(0, (s - c.arc[lo]) / span)) : 0;
  const dx = c.xs[hi] - c.xs[lo], dy = c.ys[hi] - c.ys[lo], l = Math.hypot(dx, dy) || 1;
  return { x: c.xs[lo] + dx * f, y: c.ys[lo] + dy * f, tx: dx / l, ty: dy / l };
}

/* The most (sign 1) or least (sign −1) within `hold` samples either side, then a tent over `smooth` either side,
 * in place. */
function holdAndSmooth(v, hold, smooth, sign) {
  const n = v.length, a = Float64Array.from(v);
  for (let k = 0; k < n; k++) {
    let m = a[k];
    for (let j = Math.max(0, k - hold); j <= Math.min(n - 1, k + hold); j++) m = sign > 0 ? Math.max(m, a[j]) : Math.min(m, a[j]);
    v[k] = m;
  }
  const b = Float64Array.from(v);
  for (let k = 0; k < n; k++) {
    let sw = 0, sv = 0;
    for (let j = Math.max(0, k - smooth); j <= Math.min(n - 1, k + smooth); j++) {
      const w = smooth + 1 - Math.abs(j - k);
      sw += w; sv += w * b[j];
    }
    v[k] = sv / sw;
  }
}

/* Ids binned in square cells (metres) of the local frame. */
class Grid {
  constructor(cell) { this.cell = cell; this.cells = new Map(); this.stamp = 0; this.seen = new Int32Array(64); }
  #key(cx, cy) { return (cx + 0x8000) * 0x10000 + (cy + 0x8000); }
  #put(cx, cy, id) {
    if (id >= this.seen.length) { const s = new Int32Array(Math.max(id + 1, this.seen.length * 2)); s.set(this.seen); this.seen = s; }
    const k = this.#key(cx, cy);
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(id);
  }
  addPoint(x, y, id) { this.#put(Math.floor(x / this.cell), Math.floor(y / this.cell), id); }
  addBox(x0, y0, x1, y1, id) {
    for (let cx = Math.floor(x0 / this.cell); cx <= Math.floor(x1 / this.cell); cx++)
      for (let cy = Math.floor(y0 / this.cell); cy <= Math.floor(y1 / this.cell); cy++) this.#put(cx, cy, id);
  }
  /* The ids in the cells within r of (x, y), each once, into out. */
  near(x, y, r, out) {
    out.length = 0;
    const stamp = ++this.stamp;
    for (let cx = Math.floor((x - r) / this.cell); cx <= Math.floor((x + r) / this.cell); cx++)
      for (let cy = Math.floor((y - r) / this.cell); cy <= Math.floor((y + r) / this.cell); cy++) {
        const list = this.cells.get(this.#key(cx, cy));
        if (!list) continue;
        for (const id of list) if (this.seen[id] !== stamp) { this.seen[id] = stamp; out.push(id); }
      }
    return out;
  }
}
