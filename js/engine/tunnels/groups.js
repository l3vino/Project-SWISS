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
/* A railway's line shares the bore only where it lies within RAIL_GAP of the spine's track or of a track that does
 * (5.17t): a double track's lie 4 to 4.5 m apart, a station's fanning out behind a portal 4.5 to 6 m, 10 to 12 m
 * across an island platform (Göschenen's to 19.6 m off the spine: one cavern, as before); past that gap each single
 * track goes on in a tube of its own (the Ceneri base tunnel's west line, 8.4 m off the east one at the portal by
 * Giubiasco and 20 m off 732 m in, stood in one cavern up to 25 m wide with it the whole way: the real tubes lie
 * 40 m apart; his words on 5.17s: "Make the intersections actually work"; now one bore for its first ~230 m).
 * Stretches in or out shorter than RAIL_RUN samples are taken as their neighbours. */
const RAIL_GAP = 12;
const RAIL_RUN = 10;
/* Metres a spine's hint may lie off a chain's line and be on it (5.18a: tunnels.js puts them where a branch has left
 * the line it shared a bore with, ~15 m off it by Giubiasco). */
const HINT_OFF = 5;
/* The order of a cluster's spines (5.18i): the longer first only up to SPINE_CAP metres, and only by more than SPINE_TIE
 * (5.18a took the longest: by Giubiasco the Ceneri base tunnel's east line and the line into its west tube leave one
 * mouth and ran 6180 m each to the tiles' edge, the longer by under a metre, whichever the tiles in at the time made
 * so; over 50 orders of the same tiles coming in, the junction came out 8 ways: tools/grouping-test.mjs). */
const SPINE_CAP = 2000, SPINE_TIE = 1;
const FAMILY_RAIL = 2;
const BRANCH_LEAST = 10;
/* Metres over which the reach is held (the most within WIDTH_HOLD) and then
 * smoothed (a tent over WIDTH_SMOOTH either side) along the spine. */
const WIDTH_HOLD = 6;
const WIDTH_SMOOTH = 10;
/* Metres from a spine's end within which a chain beside it coming out makes
 * the bore's end a portal. */
const PORTAL_NEAR = 25;
/* Metres a branch's own bore runs on back into the bore it leaves (5.17m): it
 * leaves where its line is BESIDE_ACROSS off the spine, and there the bore's
 * reach, smoothed along, falls short of it (3.4 m for a branch leaving at 5°),
 * so the branch's open end stood mostly outside the room it opens into, a hole
 * to the rock behind. Back along its line by more than the reach is held and
 * smoothed over (WIDTH_HOLD and WIDTH_SMOOTH: 16 m), the reach covers it; what
 * of it lies inside the bore is not drawn (shaders/tunnel.wgsl fsMeet). */
const JOIN_INTO = 20;

export const TUBE_END = { PORTAL: 1, OPEN: 2, CLOSED: 3, JOIN: 4 };
/* Floats per spine point in a tube's points. */
export const TUBE_POINT = 5;
/* A sample of a tube's `lines` (5.17q; 5.17o kept only the outermost either side): how many lines lie side by side
 * there, then each (at most LINE_MOST) in metres right of the spine, in order, the spine's own at 0 among them. */
export const LINE_MOST = 6;
export const LINE_FLOATS = 1 + LINE_MOST;
/* A turnout (5.17q; its curve since 5.18j: turnout()): a track whose line's data ends within SWITCH_FAR of another
 * track runs into it; beside it, over a reverse curve SWITCH_LEAST to 2 × SWITCH_LENGTH metres long; with none so
 * near, on as it lies to the bore's end if that is within RUN_ON. */
const SWITCH_FAR = 6, SWITCH_LENGTH = 55, SWITCH_LEAST = 8, RUN_ON = 40;

const M_LAT = 111132;

/**
 * Tubes from runs.
 * @param runs  [{ kind, family, layer, points: Float64Array [lon, lat, …], ends: [{ type, degree }, …] }]
 *              from every tile near the camera (each tile's runs only inside it)
 * @param priority  kind id → importance (the most important kind names a tube)
 * @param hints  [{ lon, lat, rank }]: points a bore's spine is to run through (5.18a: tunnels.js spineHints), the
 *               higher rank first; a cluster with none on any of its chains takes its longest
 * @returns [{ key, family, kind, layer, tracks, oneway (every line in it one way), length,
 *            points: Float64Array, TUBE_POINT per sample: lon, lat, metres along, the bore's middle that many metres
 *              right of the spine, metres it reaches beyond one line either side,
 *            lines: Float32Array, LINE_FLOATS per sample (where its lines are: tunnel.c's tracks),
 *            ends: [{ type, lon, lat, dirX, dirY (unit, east and north, outwards) }, …] }]
 */
export function tubesFrom(runs, priority = {}, hints = []) {
  if (!runs.length) return [];
  // A local frame in metres round the middle of the runs' box (not their mean, summed as they came: 5.18j, a tube's
  // end on its key's 10 m rounding came out under one name or the other by the last bits of the sum).
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of runs) {
    for (let i = 0; i < r.points.length; i += 2) {
      w = Math.min(w, r.points[i]); e = Math.max(e, r.points[i]); s = Math.min(s, r.points[i + 1]); n = Math.max(n, r.points[i + 1]);
    }
  }
  const lon0 = (w + e) / 2, lat0 = (s + n) / 2;
  const M_LON = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const frame = { lon0, lat0, M_LON };

  // 0. Runs in metres, cut where another run's NODE end lies on one of their points.
  let rs = runs.map((r) => {
    const n = r.points.length / 2, xs = new Float64Array(n), ys = new Float64Array(n);
    for (let k = 0; k < n; k++) { xs[k] = (r.points[2 * k] - lon0) * M_LON; ys[k] = (r.points[2 * k + 1] - lat0) * M_LAT; }
    return { xs, ys, n, family: r.family, layer: r.layer, kind: r.kind, oneway: r.oneway === true, ends: r.ends.map((e) => e.type) };
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
    let layer = Infinity, e = start, last, oneway = true;
    for (;;) {
      const run = rs[ends[e].run];
      used[ends[e].run] = 1;
      kinds.add(run.kind);
      layer = Math.min(layer, run.layer);
      oneway &&= run.oneway;
      const fwd = ends[e].e === 0;
      // (Where it goes on from the run before, the two ends as one: their middle, whichever came first; 5.18j, the
      // first's alone moved a tube's end by up to the metre or two two runs' ends lie apart at a tile's edge.)
      if (xs.length) {
        const k0 = fwd ? 0 : run.n - 1, j = xs.length - 1;
        xs[j] = (xs[j] + run.xs[k0]) / 2; ys[j] = (ys[j] + run.ys[k0]) / 2;
      }
      for (let k = xs.length ? 1 : 0; k < run.n; k++) { const kk = fwd ? k : run.n - 1 - k; xs.push(run.xs[kk]); ys.push(run.ys[kk]); }
      last = 2 * ends[e].run + (fwd ? 1 : 0);
      const mate = ends[last].mate;
      if (mate < 0 || used[ends[mate].run]) break;
      e = mate;
    }
    const types = [endType(ends[start]), endType(ends[last])];
    if (backwards(xs, ys, types)) { xs.reverse(); ys.reverse(); types.reverse(); }
    return Object.assign(chainOf(xs, ys, ends[start].family, layer, kinds, types), { oneway });
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

  // 4. Per cluster, bores: the chain a hint lies on (the highest rank), else the longest up to SPINE_CAP, else the one
  // from the stronger end, else from the east (firstOf), is a spine; what lies beside it, its width; what lies beyond,
  // more chains. (5.18a: by the longest alone the bore out of a portal followed whichever line the tiles loaded had the
  // more of: by Giubiasco the Ceneri base tunnel's east line, then, flying in, the west one, then the east again; the
  // hints keep it on the line a whole tunnel traced from that portal runs on.)
  const hs = hints.map((h) => ({ x: (h.lon - lon0) * M_LON, y: (h.lat - lat0) * M_LAT, rank: h.rank }));
  const rankOf = (c) => {
    let best = 0;
    for (const h of hs) {
      if (h.rank <= best || h.x < c.box[0] - HINT_OFF || h.x > c.box[2] + HINT_OFF || h.y < c.box[1] - HINT_OFF || h.y > c.box[3] + HINT_OFF) continue;
      if (nearestSample(c, h.x, h.y, HINT_OFF, found) >= 0) best = h.rank;
    }
    return best;
  };
  const tubes = [];
  for (let members of clusters.values()) {
    while (members.length) {
      const ranks = hs.length && members.length > 1 ? members.map(rankOf) : null;
      let si = 0;
      for (let i = 1; i < members.length; i++) if (firstOf(members[i], members[si], ranks?.[i] ?? 0, ranks?.[si] ?? 0)) si = i;
      const spine = members[si], others = members.filter((_, i) => i !== si);
      const { tube, left } = boreOf(spine, others, frame, priority);
      if (tube) tubes.push(tube);
      members = left;
    }
  }
  return tubes;
}

/* How strong a chain's end is: a portal, where it opens into another, closed, cut at the tiles' edge. */
const END_RANK = { [TUBE_END.PORTAL]: 3, [TUBE_END.JOIN]: 2, [TUBE_END.CLOSED]: 1, [TUBE_END.OPEN]: 0 };

/* Whether a chain walked from its first point runs the wrong way (5.18i: it ran as the runs came, and a tube's ends
 * swapped from load to load): it runs from its stronger end, between two alike from the west (then the south). */
function backwards(xs, ys, types) {
  const a = END_RANK[types[0]] ?? 0, b = END_RANK[types[1]] ?? 0, n = xs.length - 1;
  if (a !== b) return b > a;
  return xs[n] !== xs[0] ? xs[n] < xs[0] : ys[n] < ys[0];
}

/* A chain's stronger end, between two alike the more easterly (then northerly): { rank, x, y }. */
function anchorOf(c) {
  const [p, q] = [0, 1].map((e) => ({ rank: END_RANK[c.ends[e]] ?? 0, x: e ? c.xs[c.n - 1] : c.xs[0], y: e ? c.ys[c.n - 1] : c.ys[0] }));
  if (p.rank !== q.rank) return p.rank > q.rank ? p : q;
  return p.x !== q.x ? (p.x > q.x ? p : q) : p.y >= q.y ? p : q;
}

/* Whether chain a is a cluster's spine before chain b (their hints' ranks ra, rb), the same whatever order the tiles
 * came in (5.18i): the higher rank; the longer up to SPINE_CAP, by more than SPINE_TIE; the stronger end; the more
 * easterly, then northerly, of their ends (by Giubiasco the east line's portal end lies 11 m east of the other's). */
function firstOf(a, b, ra, rb) {
  if (ra !== rb) return ra > rb;
  const la = Math.min(a.length, SPINE_CAP), lb = Math.min(b.length, SPINE_CAP);
  if (Math.abs(la - lb) > SPINE_TIE) return la > lb;
  const pa = anchorOf(a), pb = anchorOf(b);
  if (pa.rank !== pb.rank) return pa.rank > pb.rank;
  return pa.x !== pb.x ? pa.x > pb.x : pa.y > pb.y;
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

/* The curve a chain follows (5.17q, his words on 5.17p: "the tunnels do not follow smooth curves"): a centripetal
 * Catmull-Rom spline through its nodes (Yuksel, Schaefer and Keyser 2011: no cusp or loop within a span, tight to the
 * nodes), where 5.17p took the straight lines between them and only rounded the kinks over a few metres (mesh.js
 * `smoothed`), so a curve mapped by nodes 30 to 60 m apart showed as straight stretches with bends. Mapped nodes lie
 * on the track or the road's middle, and the true curve bulges out of the straight line between two by up to a metre
 * (60 m apart on a 400 m radius: 1.1 m); the spline puts it back. Nodes within NODE_MERGE of each other are one (a
 * tile's edge cut beside a node, a stub at a join); where a line turns by more than CORNER_TURN at a node the curve
 * keeps the corner (a data corner or a junction, not a curve). Sampled every CURVE_STEP before the even samples are
 * taken by length. */
const NODE_MERGE = 1;
const CORNER_COS = Math.cos((50 * Math.PI) / 180);
const CURVE_STEP = 0.5;

function curveOf(xs, ys) {
  const n = xs.length, px = [xs[0]], py = [ys[0]];
  for (let k = 1; k < n; k++) {
    const far = Math.hypot(xs[k] - px[px.length - 1], ys[k] - py[py.length - 1]) >= NODE_MERGE;
    if (far) { px.push(xs[k]); py.push(ys[k]); }
    else if (k === n - 1 && px.length > 1) { px[px.length - 1] = xs[k]; py[py.length - 1] = ys[k]; }
  }
  if (px.length === 1 && n > 1) { px.push(xs[n - 1]); py.push(ys[n - 1]); }
  const m = px.length;
  // The way in and out of each node, and whether the line keeps a corner there.
  const corner = new Uint8Array(m);
  for (let j = 1; j + 1 < m; j++) {
    const ax = px[j] - px[j - 1], ay = py[j] - py[j - 1], bx = px[j + 1] - px[j], by = py[j + 1] - py[j];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la > 0 && lb > 0 && (ax * bx + ay * by) / (la * lb) < CORNER_COS) corner[j] = 1;
  }
  const X = [px[0]], Y = [py[0]];
  for (let i = 0; i + 1 < m; i++) {
    // The four control points. Past an end the curve goes on as it bends there (a point on the parabola through the
    // last three nodes, unless a corner is one of them); across a corner, or with two nodes, the mirror image (the
    // span runs straight on).
    const x1 = px[i], y1 = py[i], x2 = px[i + 1], y2 = py[i + 1];
    const before = i > 0 && !corner[i], after = i + 2 < m && !corner[i + 1];
    const bentIn = i === 0 && m > 2 && !corner[1], bentOut = i + 2 === m && m > 2 && !corner[m - 2];
    const x0 = before ? px[i - 1] : bentIn ? 3 * x1 - 3 * x2 + px[2] : 2 * x1 - x2;
    const y0 = before ? py[i - 1] : bentIn ? 3 * y1 - 3 * y2 + py[2] : 2 * y1 - y2;
    const x3 = after ? px[i + 2] : bentOut ? 3 * x2 - 3 * x1 + px[m - 3] : 2 * x2 - x1;
    const y3 = after ? py[i + 2] : bentOut ? 3 * y2 - 3 * y1 + py[m - 3] : 2 * y2 - y1;
    const t1 = Math.max(1e-6, Math.hypot(x1 - x0, y1 - y0) ** 0.5);
    const t2 = t1 + Math.max(1e-6, Math.hypot(x2 - x1, y2 - y1) ** 0.5);
    const t3 = t2 + Math.max(1e-6, Math.hypot(x3 - x2, y3 - y2) ** 0.5);
    const sub = Math.min(400, Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / CURVE_STEP)));
    for (let q = 1; q <= sub; q++) {
      if (q === sub) { X.push(x2); Y.push(y2); continue; }
      const t = t1 + ((t2 - t1) * q) / sub;
      // Barry and Goldman's pyramid (t0 = 0).
      const a1x = ((t1 - t) * x0 + t * x1) / t1, a1y = ((t1 - t) * y0 + t * y1) / t1;
      const a2x = ((t2 - t) * x1 + (t - t1) * x2) / (t2 - t1), a2y = ((t2 - t) * y1 + (t - t1) * y2) / (t2 - t1);
      const a3x = ((t3 - t) * x2 + (t - t2) * x3) / (t3 - t2), a3y = ((t3 - t) * y2 + (t - t2) * y3) / (t3 - t2);
      const b1x = ((t2 - t) * a1x + t * a2x) / t2, b1y = ((t2 - t) * a1y + t * a2y) / t2;
      const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1), b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);
      X.push(((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1));
      Y.push(((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1));
    }
  }
  const L = new Float64Array(X.length);
  for (let k = 1; k < X.length; k++) L[k] = L[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]);
  return { X, Y, L };
}

/* A chain from its points: lengths along, its box, and samples every SPINE_STEP or a little less along its curve
 * (X, Y, and the way along there TX, TY). */
function chainOf(xs, ys, family, layer, kinds, ends) {
  const n = xs.length, c = { xs: Float64Array.from(xs), ys: Float64Array.from(ys), n, family, layer, kinds, ends, grid: null };
  c.arc = new Float64Array(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    if (k) c.arc[k] = c.arc[k - 1] + Math.hypot(c.xs[k] - c.xs[k - 1], c.ys[k] - c.ys[k - 1]);
    x0 = Math.min(x0, c.xs[k]); y0 = Math.min(y0, c.ys[k]); x1 = Math.max(x1, c.xs[k]); y1 = Math.max(y1, c.ys[k]);
  }
  c.box = [x0, y0, x1, y1];
  const cv = curveOf(c.xs, c.ys), N = cv.X.length;
  c.length = cv.L[N - 1];
  const steps = (c.steps = Math.max(1, Math.ceil(c.length / SPINE_STEP)));
  c.ds = c.length / steps;
  c.X = new Float64Array(steps + 1); c.Y = new Float64Array(steps + 1);
  c.TX = new Float64Array(steps + 1); c.TY = new Float64Array(steps + 1);
  let seg = 0, tx = 1, ty = 0;
  for (let k = 0; k <= steps; k++) {
    const s = k * c.ds;
    while (seg < N - 2 && cv.L[seg + 1] < s) seg++;
    const span = cv.L[seg + 1] - cv.L[seg], f = span > 0 ? Math.min(1, Math.max(0, (s - cv.L[seg]) / span)) : 0;
    const dx = cv.X[seg + 1] - cv.X[seg], dy = cv.Y[seg + 1] - cv.Y[seg], l = Math.hypot(dx, dy);
    if (l > 0) { tx = dx / l; ty = dy / l; }
    c.X[k] = cv.X[seg] + dx * f; c.Y[k] = cv.Y[seg] + dy * f; c.TX[k] = tx; c.TY[k] = ty;
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

/* A railway bore's lines kept to those in reach of its track (RAIL_GAP, 5.17t): at each of the spine's samples the
 * others' offsets in order out from the spine's 0 either side, each kept while it lies within RAIL_GAP of the last
 * kept; stretches kept or left shorter than RAIL_RUN samples taken as their neighbours; a chain's samples by a spine
 * sample where it is not kept are no longer beside it (`seen[i].at` -1: they go on as a bore of their own). */
function keepContiguous(others, seen, steps) {
  const offAt = others.map(() => new Float64Array(steps + 1).fill(NaN));
  seen.forEach(({ at, acr }, i) => { for (let k = 0; k < at.length; k++) if (at[k] >= 0) offAt[i][at[k]] = acr[k]; });
  const kept = others.map(() => new Uint8Array(steps + 1));
  const here = [];
  for (let j = 0; j <= steps; j++) {
    here.length = 0;
    for (let i = 0; i < others.length; i++) if (!Number.isNaN(offAt[i][j])) here.push(i);
    if (!here.length) continue;
    here.sort((a, b) => offAt[a][j] - offAt[b][j]);
    let last = 0;
    for (const i of here) { const v = offAt[i][j]; if (v < 0) continue; if (v - last > RAIL_GAP) break; kept[i][j] = 1; last = v; }
    last = 0;
    for (let q = here.length - 1; q >= 0; q--) { const i = here[q], v = offAt[i][j]; if (v >= 0) continue; if (last - v > RAIL_GAP) break; kept[i][j] = 1; last = v; }
  }
  for (let i = 0; i < others.length; i++) {
    const kk = kept[i], present = (j) => !Number.isNaN(offAt[i][j]);
    // Short stretches of either among the samples where it is present take their neighbours' (gaps first).
    for (const v of [0, 1]) {
      for (let j = 0; j <= steps;) {
        if (!present(j) || kk[j] !== v) { j++; continue; }
        let e = j;
        while (e < steps && present(e + 1) && kk[e + 1] === v) e++;
        const before = j > 0 && present(j - 1), after = e < steps && present(e + 1);
        if (e - j + 1 < RAIL_RUN && before && after) for (let q = j; q <= e; q++) kk[q] = 1 - v;
        j = e + 1;
      }
    }
    const { at } = seen[i];
    for (let k = 0; k < at.length; k++) if (at[k] >= 0 && !kk[at[k]]) at[k] = -1;
  }
}

/* The bore round a spine: its samples, the reach of the others beside it, its ends; and what of the others lies
 * beyond it, as chains. */
function boreOf(spine, others, frame, priority) {
  const { lon0, lat0, M_LON } = frame;
  const { steps, ds, X, Y, TX, TY } = spine;
  const lo = new Float64Array(steps + 1), hi = new Float64Array(steps + 1), lines = new Uint8Array(steps + 1).fill(1);
  const left = [], found = [], beside = [];
  const kinds = new Set(spine.kinds);
  let layer = spine.layer, wide = false;
  const portals = [];                       // metres along the spine where a chain beside it comes out
  // Each chain's samples beside the spine: the spine's sample each lies by (-1: none) and how far across.
  const seen = others.map((c) => {
    const n = c.steps, at = new Int32Array(n + 1).fill(-1), acr = new Float64Array(n + 1);
    for (let k = 0; k <= n; k++) {
      const best = nearestSample(spine, c.X[k], c.Y[k], BESIDE_ACROSS, found);
      if (best < 0) continue;
      const dx = c.X[k] - X[best], dy = c.Y[k] - Y[best], along = dx * TX[best] + dy * TY[best];
      if (Math.abs(along) > BESIDE_ALONG) continue;
      // How far across it is at the spine's own sample, not at its own up to a metre along from it (5.18j: a line
      // converging at 5° stepped 0.18 m wherever two of its samples fell by one of the spine's, a kink in its rails):
      // back along its own way by that much.
      const runAlong = c.TX[k] * TX[best] + c.TY[k] * TY[best], runAcross = c.TX[k] * TY[best] - c.TY[k] * TX[best];
      at[k] = best;
      acr[k] = dx * TY[best] - dy * TX[best] - (Math.abs(runAlong) > 0.5 ? (runAcross / runAlong) * along : 0);
    }
    return { at, acr };
  });
  if (spine.family === FAMILY_RAIL && others.length) keepContiguous(others, seen, steps);
  for (let ci = 0; ci < others.length; ci++) {
    const c = others[ci], n = c.steps, { at, acr } = seen[ci];
    const mark = new Uint8Array(steps + 1);
    const offs = new Float64Array(steps + 1).fill(NaN);
    let covered = 0;
    for (let k = 0; k <= n; k++) {
      const best = at[k];
      if (best < 0) continue;
      const across = acr[k];
      covered++;
      if (across < lo[best]) lo[best] = across;
      if (across > hi[best]) hi[best] = across;
      mark[best] = 1;
      offs[best] = across;
    }
    if (covered) {
      // (Where it is beside the spine, sample by sample: a sample it skipped between two takes their middle.)
      for (let k = 1; k < steps; k++) if (Number.isNaN(offs[k]) && !Number.isNaN(offs[k - 1]) && !Number.isNaN(offs[k + 1])) offs[k] = (offs[k - 1] + offs[k + 1]) / 2;
      beside.push({ offs, ends: [at[0], at[n]], covered });
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
      if (b - a >= BRANCH_LEAST) {
        left.push(stretch(c, k === 0 ? a : Math.max(0, a - JOIN_INTO), e === n ? b : Math.min(c.length, b + JOIN_INTO),
          k === 0 ? c.ends[0] : TUBE_END.JOIN, e === n ? c.ends[1] : TUBE_END.JOIN));
      }
      k = e + 1;
    }
  }
  if (spine.length < 1) return { tube: null, left };
  // Where its tracks are (rails, beds and overhead lines, tunnel.c), each in a place of its own (5.17q: each keeps it
  // from sample to sample, NaN where it does not run; sorted afresh at every sample, a track met another's place
  // where a line came or went and its rails broke off): the spine's own, then the lines beside it (the longest
  // LINE_MOST − 1), left to right.
  const places = beside.sort((a, b) => b.covered - a.covered).slice(0, LINE_MOST - 1);
  for (const b of places) {
    let sum = 0, cnt = 0;
    for (let k = 0; k <= steps; k++) if (!Number.isNaN(b.offs[k])) { sum += b.offs[k]; cnt++; }
    b.mean = cnt ? sum / cnt : 0;
  }
  places.sort((a, b) => a.mean - b.mean);
  // Where a line's data ends inside the bore, its track runs on into the nearest track there over a turnout (his
  // words on 5.17q: "connect the tracks correctly even if the data is not there", "add rail intersection/splitting"),
  // or, with none within SWITCH_FAR, on as it lies to the bore's end if that is within RUN_ON.
  for (const b of places) {
    let first = -1, last = -1;
    for (let k = 0; k <= steps; k++) if (!Number.isNaN(b.offs[k])) { if (first < 0) first = k; last = k; }
    if (first < 0) continue;
    for (const [kE, dir] of [[first, -1], [last, 1]]) {
      // (Only where the line's own data ends here: where it leaves the bore its own tube goes on.)
      if (!b.ends.some((k) => k >= 0 && Math.abs(k - kE) <= 2)) continue;
      const off0 = b.offs[kE];
      let parent = null, gap = Math.abs(off0);
      for (const o of places) if (o !== b && !Number.isNaN(o.offs[kE]) && Math.abs(o.offs[kE] - off0) < gap) { parent = o; gap = Math.abs(o.offs[kE] - off0); }
      if (gap < SWITCH_FAR) {
        turnout(b, parent, kE, dir, steps, ds);
      } else if ((dir < 0 ? kE : steps - kE) * ds <= RUN_ON) {
        for (let k = kE + dir; k >= 0 && k <= steps && Number.isNaN(b.offs[k]); k += dir) b.offs[k] = off0;
      }
    }
  }
  const lineAt = new Float32Array((steps + 1) * LINE_FLOATS);
  for (let k = 0; k <= steps; k++) {
    lineAt[k * LINE_FLOATS] = 1 + places.length;
    lineAt[k * LINE_FLOATS + 1] = 0;
    for (let i = 0; i < LINE_MOST - 1; i++) lineAt[k * LINE_FLOATS + 2 + i] = i < places.length ? places[i].offs[k] : NaN;
  }
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
  return { tube: { key, family: spine.family, kind, layer, tracks, oneway: spine.oneway === true, length: spine.length, points, lines: lineAt, ends }, left };
}

/* A turnout where a line's data ends by another track (5.18j, his words on 5.18i: "rails when 2 "connect" are not
 * straight.. they kinda curve"): the other track runs on as it is, and this one meets it along one curve of
 * TURNOUT_RADIUS (a 1:12 turnout's: 500 m, 4.76°, 41.6 m long), tangent to its own line and to the other's, round
 * where the two lines meet (as its data has them, or on along the way its last TURNOUT_LOOK metres run where they do
 * not meet yet); where it runs beside the other, a reverse curve of that radius over to it. Up to 5.18i a smoothstep
 * from where its data ended: it turned parallel there, then swung across in an S. Writes b.offs (metres right of the
 * spine, NaN where the line is not): back into its data at most TURNOUT_TANGENT metres, and on beyond it until it is on
 * the other track (not over another stretch of its data, nor past the bore's ends). `parent`: the other track's place
 * (its offs), null for the spine's own (0). */
const TURNOUT_RADIUS = 500, TURNOUT_LOOK = 20, TURNOUT_TANGENT = 40, TURNOUT_CLOSING = 0.002, TURNOUT_ON = 0.05;

function turnout(b, parent, kE, dir, steps, ds) {
  const offs = b.offs, inData = (k) => k >= 0 && k <= steps && !Number.isNaN(offs[k]);
  const p0 = parent === null ? 0 : parent.offs[kE];
  const parentAt = (k) => (parent === null ? 0 : Number.isNaN(parent.offs[k]) ? p0 : parent.offs[k]);
  const gapOf = (k) => offs[k] - parentAt(k);
  // Which side it comes from: where its data ends on the other track, the side it came along its last TURNOUT_LOOK m.
  let kB = kE;
  for (let i = 1; i <= Math.round(TURNOUT_LOOK / ds) && inData(kE - dir * i); i++) kB = kE - dir * i;
  const sign = (Math.abs(gapOf(kE)) > TURNOUT_ON ? Math.sign(gapOf(kE)) : Math.sign(gapOf(kB))) || 1;
  // How fast the gap closes towards the end of the data at sample k (metres a metre, from its neighbours in the data).
  const closingAt = (k) => {
    const a = inData(k - dir) ? k - dir : k, c = inData(k + dir) ? k + dir : k;
    return a === c ? 0 : (sign * gapOf(a) - sign * gapOf(c)) / (Math.abs(c - a) * ds);
  };
  // Where the curve starts: the sample of the data nearest its end (at most TURNOUT_TANGENT back) whose gap leaves room
  // for the radius to the other track, tangent to its line there: gap ≥ R s² / 2, s its closing there (where the data
  // is a curve itself, as by the Ceneri junction, tangent to that curve: a curve started at the angle of its last
  // metres was kinked 2° where it began). Beyond the data where it stops short of the other track.
  let k0 = -1, kFar = kE;
  for (let i = 0; i * ds <= TURNOUT_TANGENT && inData(kE - dir * i); i++) {
    const k = kE - dir * i, s = closingAt(k);
    kFar = k;
    if (s > TURNOUT_CLOSING && sign * gapOf(k) >= (TURNOUT_RADIUS * s * s) / 2) { k0 = k; break; }
  }
  if (k0 < 0 && closingAt(kFar) > TURNOUT_CLOSING && sign * gapOf(kFar) > 0) k0 = kFar;   // (a tighter curve: no room)
  let gapAt, len;
  if (k0 >= 0) {
    // From k0: g0 (1 − d / L)², L = 2 g0 / s: tangent to its line at k0 and to the other track at its end.
    const g0 = sign * gapOf(k0), s = closingAt(k0);
    len = (2 * g0) / s;
    gapAt = (d) => sign * g0 * (1 - Math.min(1, d / len)) ** 2;
  } else {
    // Beside it: over and back, two curves of the radius, each half the way across.
    const g0 = gapOf(kE);
    k0 = kE;
    len = Math.min(2 * SWITCH_LENGTH, Math.max(SWITCH_LEAST, 2 * Math.sqrt(Math.abs(g0) * TURNOUT_RADIUS)));
    gapAt = (d) => { const u = Math.min(1, Math.max(0, d / len)); return u <= 0.5 ? g0 * (1 - 2 * u * u) : g0 * 2 * (1 - u) ** 2; };
  }
  for (let i = 1; i * ds <= len + 1e-6; i++) {
    const k = k0 + dir * i;
    if (k < 0 || k > steps) break;
    // (On beyond the data only where the line is not: another stretch of it, its own data.)
    if ((k - kE) * dir > 0 && !Number.isNaN(offs[k])) break;
    offs[k] = parentAt(k) + gapAt(i * ds);
  }
}

/* The part of a chain from a to b metres along, as a chain: its curve's samples there (5.17q: its nodes made the
 * stretch's own spline, which left the chain's curve where it was cut). */
function stretch(c, a, b, endA, endB) {
  const xs = [], ys = [];
  const pa = pointAt(c, a), pb = pointAt(c, b);
  xs.push(pa.x); ys.push(pa.y);
  for (let k = 0; k <= c.steps; k++) if (k * c.ds > a && k * c.ds < b) { xs.push(c.X[k]); ys.push(c.Y[k]); }
  xs.push(pb.x); ys.push(pb.y);
  return Object.assign(chainOf(xs, ys, c.family, c.layer, c.kinds, [endA, endB]), { oneway: c.oneway });
}

/* The point s metres along a chain's curve, and the way along there (unit). */
function pointAt(c, s) {
  const f = Math.min(c.steps, Math.max(0, s / c.ds)), k = Math.min(c.steps - 1, Math.floor(f)), t = f - k;
  const dx = c.X[k + 1] - c.X[k], dy = c.Y[k + 1] - c.Y[k], l = Math.hypot(dx, dy) || 1;
  return { x: c.X[k] + dx * t, y: c.Y[k] + dy * t, tx: dx / l, ty: dy / l };
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
