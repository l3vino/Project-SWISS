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

/**
 * The tunnel runs of a block.
 * @param block  the tile's block (formats/vector-tile.js)
 * @param z, x, y  the tile (Web Mercator)
 * @param kinds  the schema's kinds (schemaTables(schema).kinds): id and family per kind number
 * @returns [{ kind, family, layer, oneway, points: Float64Array [lon, lat, …], ends: [{ type, degree, approach, pin }, …] }]
 *          (approach: at a PORTAL, the line on beyond it, [lon, lat, …] from the portal out, APPROACH_KEEP metres
 *          at most, as far as the block has it; else null. pin: where that line's road is pinned to the tunnel's
 *          floor (vector/portals.js): { x, y } the portal in the block's units, its `line`, `s` the distance along
 *          it there (segmentArcs'), `dir` +1 where the line runs on out of the portal with s growing, -1 falling;
 *          else null)
 */
export function tunnelRuns(block, z, x, y, kinds) {
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
  const tunnelEnds = new Map();
  for (let s = 0, count = u32[BLOCK.segmentCount]; s < count; s++) {
    if (!tunnel(s)) continue;
    const o = segs + s * 8, a = at(o), b = at(o + 2);
    tunnelEnds.set(a, (tunnelEnds.get(a) ?? 0) + 1);
    tunnelEnds.set(b, (tunnelEnds.get(b) ?? 0) + 1);
  }
  if (!tunnelEnds.size) return [];
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
          // (Whether it goes on as a bridge: only then is a deck over its first metres its own, 5.17s.)
          if (d.approach) d.approach.bridge = onBridge(nb);
          d.pin = pinOf(nb, side ? 1 : -1, px, py);
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
        if (d.approach) d.approach.bridge = onBridge(best.seg);
        d.pin = pinOf(best.seg, best.step, px, py);
      };
      const ends = [endOf(s, 0), endOf(e - 1, 1)];
      ends.forEach((d, side) => {
        d.approach = null;
        d.pin = null;
        if (d.type === END.PORTAL) approachOf(side, d);
      });
      runs.push({ kind: kind?.id ?? 'unknown', family: kind?.family ?? 'road', layer: ATTR.layer(attr), oneway: ATTR.oneway(attr) !== 0, points, ends });
      s = e;
    }
  }
  return runs;
}
