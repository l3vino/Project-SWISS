/* runs.js — the tunnels in a detail vector tile: each stretch of a line
 * marked tunnel (base.vt's brunnel = tunnel), as a polyline in degrees, and
 * what each of its ends does.
 *
 * His words (on 5.15b): "Also implement tunnels (and try to get info about
 * them, like shape, rectangle or "round", ecc ecc)". base.vt has every road
 * and railway tunnel as its line's segments marked tunnel, with a layer
 * (−1 to −3 under the ground), clipped at the tile's edges like any line
 * (research doc §6: at Göschenen the Gotthard rail tunnel's tracks, the road
 * tunnel and the rack railway's tunnels). An end of a stretch is
 *   PORTAL  where the line runs on in the open (or onto a bridge) inside the tile,
 *   CUT     where it runs on across the tile's edge (the next tile has the rest),
 *   NODE    where the line ends at a node only other tunnel lines meet (switches
 *           and junctions inside tunnels: the tunnel runs on as another line);
 *           a node any open line meets is a PORTAL (a tunnel ending at a
 *           junction; 5.17e: also where another short tunnel piece ends there
 *           too, as at the Mappo-Morettina tunnel's west portal by Locarno,
 *           where a 7 m covered stretch of the road outside meets it and
 *           5.17d took the node for a junction underground),
 *   DEAD    where the line just ends (a tunnel the data stops in).
 * Only the segments inside the tile are taken (the block also has the few
 * metres past its edge that the tile beyond has too). A stretch marked
 * tunnel on a layer over the ground (5.17e: base.vt's layer 1 and up) is a
 * covered way above it, not a tunnel: the covered walks along Bellinzona's
 * walls (the Murata, layer 2) are left out (5.17d built them as boxes along
 * the ground, standing out of it for 180 m). Runs on a decode thread with the
 * tile (workers/codec.js), and in the tests.
 */

import { BLOCK, ATTR, segmentArcs } from '../../formats/vector-tile.js';

export const END = { PORTAL: 1, CUT: 2, NODE: 3, DEAD: 4 };
const TUNNEL = 2, BRIDGE = 1;
const LINK_CUT_A = 1 << 22, LINK_CUT_B = 1 << 23, LINK_END_A = 1 << 24, LINK_END_B = 1 << 25;
/* Metres of the open line kept beyond a portal: its approach, whose ground places the portal's floor (a road
 * turning away right at a portal leaves the straight way out over the slope beside it). */
const APPROACH_KEEP = 30;
/* Metres from a portal another way's open line is taken as passing over it (`over`, 5.18n), and the stretch of it kept:
 * its segments that come that near. */
const OVER_NEAR = 20;
/* A road or path passing under another way the data does not tunnel it under (`implied`, 5.18p): crossing that way's
 * line at IMPLIED_SIN (30°) or more, away from any point the two lines share within JUNCTION_NEAR metres; crossings
 * within IMPLIED_MERGE metres of each other's level widths along it one stretch, run on IMPLIED_PAST either side along
 * its open line (IMPLIED_LEAST at least); its ground read at each crossing and IMPLIED_SIDES metres past the stretch on
 * either side. Cells of IMPLIED_CELL tile units the crossings are looked for in. */
const IMPLIED_SIN = 0.5, JUNCTION_NEAR = 2, IMPLIED_MERGE = 10, IMPLIED_PAST = 4, IMPLIED_LEAST = 8;
const IMPLIED_SIDES = [2, 6, 10, 15, 20], IMPLIED_CELL = 64;

/* An implied run is kept (impliedHolds) where the bare ground at its crossings stands IMPLIED_OVER over the line between
 * its lowest on either side past the way's clearance (sections.js clearanceFor: a main road 4 m, another 2.5 m, a path
 * 2 m): a deck or a track bed and what holds it (the Swiss clearance over a road is 4.5 m, and a road under a railway
 * stands 5.5 to 7 m under its rails; by Bellinzona the ground reads 5.7 m over the road's line through either side). */
const IMPLIED_OVER = 1.0;

/** An implied run's key (the tunnels' thread keeps what its ground showed under it). */
export function impliedKey(run) {
  const p = run.implied.probe;
  return `${run.kind}|${p[0].toFixed(6)}|${p[1].toFixed(6)}|${run.implied.crossings}`;
}

/** An implied run's probe as [lon, lat, …] for the ground to be read at. */
export function impliedPoints(run) {
  const p = run.implied.probe, out = new Float64Array((p.length / 3) * 2);
  for (let i = 0, j = 0; i < p.length; i += 3, j += 2) { out[j] = p[i]; out[j + 1] = p[i + 1]; }
  return out;
}

/**
 * Whether an implied run's way passes under the others there (5.18p): the bare ground at its crossings (`heights`, as
 * its probe) stands `clearance` and IMPLIED_OVER over the line between the lowest on either side of the stretch, at the
 * highest crossing (the elevation model kept the bridge over it as ground). Where a side is not known, no.
 */
export function impliedHolds(run, heights, clearance) {
  const { probe: p, crossings: k, lo, hi } = run.implied, n = p.length / 3;
  let top = -Infinity, sTop = 0, left = null, right = null;
  for (let i = 0; i < k; i++) if (Number.isFinite(heights[i]) && heights[i] > top) { top = heights[i]; sTop = p[3 * i + 2]; }
  for (let i = k; i < n; i++) {
    const s = p[3 * i + 2], z = heights[i];
    if (!Number.isFinite(z)) continue;
    if (s < lo && (!left || z < left[1])) left = [s, z];
    if (s > hi && (!right || z < right[1])) right = [s, z];
  }
  if (!left || !right || !Number.isFinite(top)) return false;
  const base = left[1] + ((right[1] - left[1]) * (sTop - left[0])) / (right[0] - left[0]);
  return top - base >= clearance + IMPLIED_OVER;
}

/**
 * The tunnel runs of a block.
 * @param block  the tile's block (formats/vector-tile.js)
 * @param z, x, y  the tile (Web Mercator)
 * @param kinds  the schema's kinds (schemaTables(schema).kinds): id and family per kind number
 * @param implied  whether to add the stretches where a road or path passes under another way without a tunnel in the
 *               data (5.18p, impliedOf: runs with `implied`; the tunnels' thread keeps those the ground shows)
 * @returns [{ kind, family, layer, oneway, points: Float64Array [lon, lat, …], ends: [{ type, degree, approach, bridge, pin, over }, …] }]
 *          (approach: at a PORTAL, the line on beyond it, [lon, lat, …] from the portal out, APPROACH_KEEP metres
 *          at most, as far as the block has it; else null. bridge: whether that line goes on as a bridge. pin: where that line's road is pinned to the tunnel's
 *          floor (vector/portals.js): { x, y } the portal in the block's units, its `line`, `s` the distance along
 *          it there (segmentArcs'), `dir` +1 where the line runs on out of the portal with s growing, -1 falling;
 *          else null. over: at a PORTAL, the other ways that may pass over it (5.18n, overOf), else null)
 */
export function tunnelRuns(block, z, x, y, kinds, { implied = false } = {}) {
  if (!block) return [];
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const f32 = new Float32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const E = u32[BLOCK.extent], segs = u32[BLOCK.segmentsOff] / 4, lines = u32[BLOCK.linesOff] / 4;
  const n = 2 ** z;
  const lonOf = (ux) => ((x + ux / E) / n) * 360 - 180;
  const latOf = (uy) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + uy / E)) / n))) * 180) / Math.PI;
  // Metres a tile unit is on the ground at the tile's middle.
  const metresPerUnit = (40075016.686 * Math.cos((latOf(E / 2) * Math.PI) / 180)) / n / E;
  // Inside the tile: its middle (a crossing splits a segment, so a segment lies on one side).
  const inside = (s) => {
    const o = segs + s * 8, mx = (f32[o] + f32[o + 2]) / 2, my = (f32[o + 1] + f32[o + 3]) / 2;
    return mx >= 0 && mx <= E && my >= 0 && my <= E;
  };
  // Under the ground: marked tunnel on a layer no higher than the ground's (one over it is a covered way, see the top).
  const tunnel = (s) => { const a = u32[segs + s * 8 + 6]; return ATTR.brunnel(a) === TUNNEL && ATTR.layer(a) <= 0; };
  const onBridge = (s) => { const a = u32[segs + s * 8 + 6]; return ATTR.brunnel(a) === BRIDGE || ATTR.layer(a) > 0; };
  // The distances along the lines (made when a portal first asks).
  let arcs = null;
  const pinOf = (seg, step, px, py) => {
    arcs ??= segmentArcs(block);
    const o = segs + seg * 8;
    const s = step > 0 ? arcs[seg] : arcs[seg] + Math.hypot(f32[o + 2] - f32[o], f32[o + 3] - f32[o + 1]) * f32[BLOCK.metresPerUnit];
    return { x: px, y: py, line: u32[o + 7] & 0xffff, s, dir: step > 0 ? 1 : -1 };
  };
  // How many tunnel segments end at each point (a node's lines share the point exactly; 1/16 unit is ~3 cm).
  const at = (o) => Math.round((f32[o] + 4096) * 16) * 0x40000 + Math.round((f32[o + 1] + 4096) * 16);
  // Tile units from a point to segment o.
  const gap = (o, px, py) => {
    const ax = f32[o], ay = f32[o + 1], ux = f32[o + 2] - ax, uy = f32[o + 3] - ay, L2 = ux * ux + uy * uy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ux + (py - ay) * uy) / L2)) : 0;
    return Math.hypot(px - ax - ux * t, py - ay - uy * t);
  };
  // The other ways that may pass over a portal at (px, py) (5.18n: fit.js decides which do, by the ground beside the
  // tube): open segments (not tunnels; not bridges, whose decks pass over by themselves) of a kind shaped into the
  // ground within OVER_NEAR of it, of lines other than the run's (`own`) and its approach's, that meet neither of those
  // at a point there (one crossing at a node meets the road on the level). Per line, each stretch of its segments that
  // come that near: [{ line, kind, half (its kind's level half-width, metres), points: Float64Array [lon, lat, s, …] }],
  // or null where there is none.
  // (The open segments of a kind shaped into the ground, with their boxes: made when a portal first asks, 5.18p: each
  // portal went through every line of the tile, 20 ms a tile by Bellinzona.)
  let openSegs = null;
  const overOf = (px, py, own, approach) => {
    arcs ??= segmentArcs(block);
    const reach = OVER_NEAR / metresPerUnit, mpu = f32[BLOCK.metresPerUnit];
    if (!openSegs) {
      openSegs = [];
      for (let k = 0, count = u32[BLOCK.segmentCount]; k < count; k++) if (!tunnel(k) && !onBridge(k) && kinds[ATTR.kind(u32[segs + k * 8 + 6])]?.shape) openSegs.push(k);
    }
    // Those near, by line, in order along it.
    const byLine = new Map();
    for (const k of openSegs) {
      const o = segs + k * 8;
      if (Math.min(f32[o], f32[o + 2]) > px + reach || Math.max(f32[o], f32[o + 2]) < px - reach ||
          Math.min(f32[o + 1], f32[o + 3]) > py + reach || Math.max(f32[o + 1], f32[o + 3]) < py - reach || gap(o, px, py) > reach) continue;
      const l = u32[o + 7] & 0xffff;
      if (l === own || l === approach) continue;
      let list = byLine.get(l);
      if (!list) byLine.set(l, (list = []));
      list.push(k);
    }
    if (!byLine.size) return null;
    const meets = new Set();
    for (const l of new Set([own, approach])) {
      for (let k = u32[lines + l * 4], en = k + u32[lines + l * 4 + 1]; k < en; k++) { meets.add(at(segs + k * 8)); meets.add(at(segs + k * 8 + 2)); }
    }
    let out = null;
    for (const [l, list] of byLine) {
      if (list.some((k) => meets.has(at(segs + k * 8)) || meets.has(at(segs + k * 8 + 2)))) continue;
      // Each run of segments following on from each other, a stretch.
      for (let i = 0; i < list.length;) {
        let j = i;
        while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
        const o0 = segs + list[i] * 8, attr = u32[o0 + 6], kind = kinds[ATTR.kind(attr)];
        const points = [lonOf(f32[o0]), latOf(f32[o0 + 1]), arcs[list[i]]];
        for (let q = i; q <= j; q++) {
          const k = list[q], o = segs + k * 8;
          points.push(lonOf(f32[o + 2]), latOf(f32[o + 3]), arcs[k] + Math.hypot(f32[o + 2] - f32[o], f32[o + 3] - f32[o + 1]) * mpu);
        }
        (out ??= []).push({ line: l, kind: ATTR.kind(attr), half: kind.width / 2 + kind.bench, points: Float64Array.from(points) });
        i = j + 1;
      }
    }
    return out;
  };
  const tunnelEnds = new Map();
  for (let s = 0, count = u32[BLOCK.segmentCount]; s < count; s++) {
    if (!tunnel(s)) continue;
    const o = segs + s * 8, a = at(o), b = at(o + 2);
    tunnelEnds.set(a, (tunnelEnds.get(a) ?? 0) + 1);
    tunnelEnds.set(b, (tunnelEnds.get(b) ?? 0) + 1);
  }
  if (!tunnelEnds.size && !implied) return [];
  // A line's segments from segment k on (step 1) or back (step -1) while open, from the point (px, py): its points
  // [lon, lat, …], APPROACH_KEEP metres at most.
  const walk = (lineFirst, lineEnd, k, step, px, py) => {
    const out = [];
    let len = 0;
    while (k >= lineFirst && k < lineEnd && !tunnel(k) && len < APPROACH_KEEP) {
      const o = segs + k * 8, qx = step > 0 ? f32[o + 2] : f32[o], qy = step > 0 ? f32[o + 3] : f32[o + 1];
      len += Math.hypot(qx - px, qy - py) * metresPerUnit;
      out.push(lonOf(qx), latOf(qy));
      px = qx; py = qy;
      k += step;
    }
    return out.length ? Float64Array.from(out) : null;
  };
  // The open segments' ends by point (made when first asked): one starting there runs on forwards along its line, one
  // ending there backwards (a line's ends, and its points in between: a road going on through the node a tunnel
  // ends at, 5.17e).
  let openEnds = null;
  const openEndsAt = (key) => {
    if (!openEnds) {
      openEnds = new Map();
      const add = (k, v) => { const list = openEnds.get(k); if (list) list.push(v); else openEnds.set(k, [v]); };
      for (let l = 0, count = u32[BLOCK.lineCount]; l < count; l++) {
        const f = u32[lines + l * 4], en = f + u32[lines + l * 4 + 1];
        for (let k = f; k < en; k++) {
          if (tunnel(k)) continue;
          add(at(segs + k * 8), { first: f, end: en, seg: k, step: 1 });
          add(at(segs + k * 8 + 2), { first: f, end: en, seg: k, step: -1 });
        }
      }
    }
    return openEnds.get(key) ?? [];
  };
  const runs = [];
  for (let l = 0, count = u32[BLOCK.lineCount]; l < count; l++) {
    const first = u32[lines + l * 4], end = first + u32[lines + l * 4 + 1];
    for (let s = first; s < end;) {
      if (!tunnel(s) || !inside(s)) { s++; continue; }
      let e = s + 1;
      while (e < end && tunnel(e) && inside(e)) e++;
      // s .. e - 1: the run.
      const a = segs + s * 8, b = segs + (e - 1) * 8;
      const attr = u32[a + 6], kind = kinds[ATTR.kind(attr)];
      const endOf = (k, side) => {
        const link = u32[segs + k * 8 + 7];
        const nb = side ? e : s - 1;            // the segment beyond this end along the line
        if (nb >= first && nb < end) {
          if (!inside(nb)) return { type: END.CUT, degree: 0 };
          if (!tunnel(nb)) return { type: END.PORTAL, degree: 0 };
        }
        if (link & (side ? LINK_CUT_B : LINK_CUT_A)) return { type: END.CUT, degree: 0 };
        if (link & (side ? LINK_END_B : LINK_END_A)) {
          const degree = (link >>> (side ? 19 : 16)) & 7;
          if (degree < 2) return { type: END.DEAD, degree };
          // The other tunnel segments ending at the node (this one's own end counts once), against the pieces meeting
          // there (the degree, this one's among them): only tunnel lines, inside; any open one, a portal.
          const others = (tunnelEnds.get(at(segs + k * 8 + (side ? 2 : 0))) ?? 1) - 1;
          return { type: others > 0 && degree <= others + 1 ? END.NODE : END.PORTAL, degree };
        }
        return { type: END.DEAD, degree: 0 };
      };
      const points = new Float64Array((e - s + 1) * 2);
      points[0] = lonOf(f32[a]); points[1] = latOf(f32[a + 1]);
      for (let k = s; k < e; k++) {
        const o = segs + k * 8, i = (k - s + 1) * 2;
        points[i] = lonOf(f32[o + 2]); points[i + 1] = latOf(f32[o + 3]);
      }
      // The line on beyond a portal while it is open, from the portal out: this line's own segments, or where it
      // ends at the portal (a node), the open line going on from there that turns least; and where its road is
      // pinned to the floor.
      const approachOf = (side, d) => {
        const px = side ? f32[b + 2] : f32[a], py = side ? f32[b + 3] : f32[a + 1];
        const nb = side ? e : s - 1;
        if (nb >= first && nb < end) {
          if (tunnel(nb)) return;
          d.approach = walk(first, end, nb, side ? 1 : -1, px, py);
          // (Whether it goes on as a bridge: only then is a deck over its first metres its own, 5.17s. On the end, not on
          // the line: a typed array's own properties do not cross to the render thread, and 5.17s's never did.)
          d.bridge = Boolean(d.approach) && onBridge(nb);
          d.pin = pinOf(nb, side ? 1 : -1, px, py);
          d.over = overOf(px, py, l, l);
          return;
        }
        const ox = side ? f32[b + 2] - f32[b] : f32[a] - f32[a + 2], oy = side ? f32[b + 3] - f32[b + 1] : f32[a + 1] - f32[a + 3];
        let best = null, straightest = -2;
        for (const c of openEndsAt(at(side ? b + 2 : a))) {
          const o = segs + c.seg * 8, dx = (c.step > 0 ? f32[o + 2] : f32[o]) - px, dy = (c.step > 0 ? f32[o + 3] : f32[o + 1]) - py;
          const cos = (dx * ox + dy * oy) / (Math.hypot(dx, dy) * Math.hypot(ox, oy) || 1);
          if (cos > straightest) { straightest = cos; best = c; }
        }
        if (!best) return;
        d.approach = walk(best.first, best.end, best.seg, best.step, px, py);
        d.bridge = Boolean(d.approach) && onBridge(best.seg);
        d.pin = pinOf(best.seg, best.step, px, py);
        d.over = overOf(px, py, l, d.pin.line);
      };
      const ends = [endOf(s, 0), endOf(e - 1, 1)];
      ends.forEach((d, side) => {
        d.approach = null;
        d.bridge = false;
        d.pin = null;
        d.over = null;
        if (d.type === END.PORTAL) approachOf(side, d);
      });
      runs.push({ kind: kind?.id ?? 'unknown', family: kind?.family ?? 'road', layer: ATTR.layer(attr), oneway: ATTR.oneway(attr) !== 0, points, ends });
      s = e;
    }
  }
  if (implied) runs.push(...impliedOf());
  return runs;

  /* Where a road or path passes under another way that the data does not tunnel it under (5.18p, his words: "there are
   * places where the road should go under the rails, but the data does not show that there is a tunnel... find an
   * algorithm that figures such things out"): it crosses that way's line away from any point the two share (ways
   * crossing on the level meet at a junction: JOSM's crossing-ways check has it so), that way not lower by its layer, at
   * IMPLIED_SIN or more. Its stretch under the other ways' level widths (those within IMPLIED_MERGE of each other along
   * it one) and IMPLIED_PAST either side along its open line is a tunnel run of its own, `implied: { probe: Float64Array
   * [lon, lat, s, …] (each crossing, then IMPLIED_SIDES past the stretch either side), crossings (how many of them),
   * lo, hi (metres along its line the level widths over it reach) }`, its ends portals pinned as a tunnel's are. The
   * tunnels' thread keeps it only where the bare ground stands over it as a road's clearance and a structure would (the
   * elevation model kept the bridge as ground there, as by Bellinzona: 6.0 m over the road for 18 m; where it left the
   * bridge out, the way runs in the open under the deck), as a hydrologist breaches an embankment where a stream
   * crosses a road. Crossings in the tile's own square only (the tile beyond has the rest). */
  function impliedOf() {
    arcs ??= segmentArcs(block);
    const mpu = f32[BLOCK.metresPerUnit], count = u32[BLOCK.segmentCount];
    const lenOf = (k) => Math.hypot(f32[segs + k * 8 + 2] - f32[segs + k * 8], f32[segs + k * 8 + 3] - f32[segs + k * 8 + 1]) * mpu;
    const lineOf = (k) => u32[segs + k * 8 + 7] & 0xffff;
    const kindOf = (k) => kinds[ATTR.kind(u32[segs + k * 8 + 6])];
    // Each segment's part (LOWER: a way that may pass under, open, a road's or path's shaped into the ground; UPPER: one
    // that may pass over, not a tunnel, a road's or railway's, shaped into the ground or a bridge), and the cells.
    const LOWER = 1, UPPER = 2, part = new Uint8Array(count), cellKey = (cx, cy) => (cx + 1024) * 4096 + cy + 1024;
    const cells = new Map();
    for (let k = 0; k < count; k++) {
      const a = u32[segs + k * 8 + 6], kd = kindOf(k);
      if (!kd) continue;
      if (!tunnel(k) && !onBridge(k) && kd.shape && kd.family === 1) part[k] |= LOWER;
      if (ATTR.brunnel(a) !== TUNNEL && (kd.family === 1 || kd.family === 2) && (kd.shape || ATTR.brunnel(a) === BRIDGE)) part[k] |= UPPER;
      if (!part[k]) continue;
      const o = segs + k * 8;
      for (let cx = Math.floor(Math.min(f32[o], f32[o + 2]) / IMPLIED_CELL); cx <= Math.floor(Math.max(f32[o], f32[o + 2]) / IMPLIED_CELL); cx++) {
        for (let cy = Math.floor(Math.min(f32[o + 1], f32[o + 3]) / IMPLIED_CELL); cy <= Math.floor(Math.max(f32[o + 1], f32[o + 3]) / IMPLIED_CELL); cy++) {
          let list = cells.get(cellKey(cx, cy));
          if (!list) cells.set(cellKey(cx, cy), (list = []));
          list.push(k);
        }
      }
    }
    const lower = (k) => (part[k] & LOWER) !== 0;
    // Whether lines la and lb share a point within JUNCTION_NEAR of (px, py).
    const pointsOf = new Map(), near = JUNCTION_NEAR / metresPerUnit;
    const shared = (la, lb, px, py) => {
      let theirs = pointsOf.get(lb);
      if (!theirs) {
        theirs = new Set();
        for (let k = u32[lines + lb * 4], en = k + u32[lines + lb * 4 + 1]; k < en; k++) { theirs.add(at(segs + k * 8)); theirs.add(at(segs + k * 8 + 2)); }
        pointsOf.set(lb, theirs);
      }
      for (let k = u32[lines + la * 4], en = k + u32[lines + la * 4 + 1]; k < en; k++) {
        for (const o of [segs + k * 8, segs + k * 8 + 2]) if (Math.hypot(f32[o] - px, f32[o + 1] - py) <= near && theirs.has(at(o))) return true;
      }
      return false;
    };
    // The crossings, by the line passing under (each pair looked at in the cell its crossing lies in only).
    const found = new Map();
    for (const [key, list] of cells) {
      for (const a of list) {
        if (!lower(a)) continue;
        const oa = segs + a * 8, la = lineOf(a), ax = f32[oa], ay = f32[oa + 1], dx = f32[oa + 2] - ax, dy = f32[oa + 3] - ay;
        for (const b of list) {
          if (a === b || !(part[b] & UPPER) || lineOf(b) === la) continue;
          const ob = segs + b * 8, ex = f32[ob + 2] - f32[ob], ey = f32[ob + 3] - f32[ob + 1], den = dx * ey - dy * ex;
          if (!(Math.abs(den) >= IMPLIED_SIN * Math.hypot(dx, dy) * Math.hypot(ex, ey))) continue;
          const t = ((f32[ob] - ax) * ey - (f32[ob + 1] - ay) * ex) / den, u = ((f32[ob] - ax) * dy - (f32[ob + 1] - ay) * dx) / den;
          if (!(t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999)) continue;
          const px = ax + dx * t, py = ay + dy * t;
          if (px < 0 || px > E || py < 0 || py > E || cellKey(Math.floor(px / IMPLIED_CELL), Math.floor(py / IMPLIED_CELL)) !== key) continue;
          const sin = Math.abs(den) / (Math.hypot(dx, dy) * Math.hypot(ex, ey));
          if (ATTR.layer(u32[ob + 6]) < ATTR.layer(u32[oa + 6]) || shared(la, lineOf(b), px, py)) continue;
          const kb = kindOf(b);
          let list2 = found.get(la);
          if (!list2) found.set(la, (list2 = []));
          list2.push({ s: arcs[a] + lenOf(a) * t, reach: (kb.width / 2 + kb.bench) / sin, seg: a, lon: lonOf(px), lat: latOf(py) });
        }
      }
    }
    const out = [];
    for (const [la, crossings] of found) {
      crossings.sort((p, q) => p.s - q.s);
      const first = u32[lines + la * 4], end = first + u32[lines + la * 4 + 1];
      for (let i = 0; i < crossings.length;) {
        let j = i, lo = crossings[i].s - crossings[i].reach, hi = crossings[i].s + crossings[i].reach;
        while (j + 1 < crossings.length && crossings[j + 1].s - crossings[j + 1].reach - hi <= IMPLIED_MERGE) {
          j++;
          lo = Math.min(lo, crossings[j].s - crossings[j].reach);
          hi = Math.max(hi, crossings[j].s + crossings[j].reach);
        }
        const run = impliedRun(la, first, end, crossings.slice(i, j + 1), lo, hi);
        if (run) out.push(run);
        i = j + 1;
      }
    }
    return out;

    /* The implied run of line la (its segments first..end) over crossings whose level widths reach from lo to hi along it. */
    function impliedRun(la, first, end, crossings, lo, hi) {
      // Its open stretch round the crossings.
      let k0 = crossings[0].seg, k1 = crossings[crossings.length - 1].seg;
      while (k0 - 1 >= first && lower(k0 - 1)) k0--;
      while (k1 + 1 < end && lower(k1 + 1)) k1++;
      const sMin = arcs[k0], sMax = arcs[k1] + lenOf(k1);
      const sA = Math.max(sMin, lo - IMPLIED_PAST), sB = Math.min(sMax, hi + IMPLIED_PAST);
      if (!(sB - sA >= IMPLIED_LEAST)) return null;
      // The point at s along it (tile units).
      const unitsAt = (s) => {
        for (let k = k0; k <= k1; k++) {
          const l = lenOf(k);
          if (s > arcs[k] + l + 1e-6 && k < k1) continue;
          const o = segs + k * 8, f = l > 0 ? Math.min(1, Math.max(0, (s - arcs[k]) / l)) : 0;
          return [f32[o] + (f32[o + 2] - f32[o]) * f, f32[o + 1] + (f32[o + 3] - f32[o + 1]) * f];
        }
        return null;
      };
      const pts = [], a = unitsAt(sA), b = unitsAt(sB);
      pts.push(lonOf(a[0]), latOf(a[1]));
      for (let k = k0; k <= k1; k++) {
        const s = arcs[k] + lenOf(k), o = segs + k * 8;
        if (s > sA + 0.05 && s < sB - 0.05) pts.push(lonOf(f32[o + 2]), latOf(f32[o + 3]));
      }
      pts.push(lonOf(b[0]), latOf(b[1]));
      // Its ends: portals, the road out of each pinned to the floor (as a tunnel's is), its approach as far as it is open.
      const endAt = (s, p, dir) => {
        const approach = [];
        for (let d = 2; d <= APPROACH_KEEP; d += 2) {
          const q = s + dir * d;
          if (q < sMin || q > sMax) break;
          const u = unitsAt(q);
          approach.push(lonOf(u[0]), latOf(u[1]));
        }
        // (No ways over its ends: it runs on IMPLIED_PAST past what passes over it, and one crossing there is its own.)
        return { type: END.PORTAL, degree: 0, approach: approach.length ? Float64Array.from(approach) : null, bridge: false,
          pin: { x: p[0], y: p[1], line: la, s, dir }, over: null };
      };
      // Its ground read at each crossing, and past the stretch either side.
      const probe = [];
      for (const c of crossings) probe.push(c.lon, c.lat, c.s);
      for (const d of IMPLIED_SIDES) {
        for (const s of [lo - d, hi + d]) {
          if (s < sMin || s > sMax) continue;
          const u = unitsAt(s);
          probe.push(lonOf(u[0]), latOf(u[1]), s);
        }
      }
      const attr = u32[segs + crossings[0].seg * 8 + 6], kind = kinds[ATTR.kind(attr)];
      return { kind: kind?.id ?? 'unknown', family: kind?.family ?? 1, layer: ATTR.layer(attr), oneway: ATTR.oneway(attr) !== 0,
        points: Float64Array.from(pts), ends: [endAt(sA, a, -1), endAt(sB, b, 1)],
        implied: { probe: Float64Array.from(probe), crossings: crossings.length, lo, hi } };
    }
  }
}
