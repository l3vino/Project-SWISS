/* rails.js — a detail road tile's railway lines as the tunnels' thread profiles them (Stage 5.18d).
 *
 * Every railway line (a kind with a gauge) as its stretches on the ground, between its bridges and tunnels: each the
 * points along it [lon, lat, s, …], s the metres along the line from its start in the tile (formats/vector-tile.js
 * segmentArcs, as its pieces carry: pieces.js), so a profile made along a stretch (engine/tunnels/rail-profiles.js)
 * matches the pieces cut along it. A line's parts that do not follow on from each other are stretches of their own.
 */

import { BLOCK, segmentArcs } from '../../formats/vector-tile.js';

const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

/**
 * @param cpu    { block, z, x, y } (a detail tile's CPU copy; its arcs are kept on it)
 * @param kinds  the road kinds by number (tiles.js shapeKinds: those with a gauge are railways)
 * @returns [{ line, stretches: [Float64Array [lon, lat, s, …]] }] (none: an empty list)
 */
export function railLines(cpu, kinds) {
  const block = cpu.block;
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const f32 = new Float32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const E = u32[BLOCK.extent], n = 2 ** cpu.z, mpu = f32[BLOCK.metresPerUnit];
  const segs = u32[BLOCK.segmentsOff] / 4, lines = u32[BLOCK.linesOff] / 4, lineCount = u32[BLOCK.lineCount];
  const arcs = cpu.arcs ??= segmentArcs(block);
  const lon = (x) => ((cpu.x + x / E) / n) * 360 - 180, lat = (y) => latOf((cpu.y + y / E) / n);
  const out = [];
  for (let l = 0; l < lineCount; l++) {
    const first = u32[lines + l * 4], count = u32[lines + l * 4 + 1];
    if (!count || !(kinds[u32[segs + first * 8 + 6] & 63]?.gauge > 0)) continue;
    const stretches = [];
    let cur = null, endX = NaN, endY = NaN, endS = NaN;
    for (let k = 0; k < count; k++) {
      const o = segs + (first + k) * 8;
      if ((u32[o + 6] >>> 6) & 3) { cur = null; continue; }   // a bridge, a tunnel or a ford: not on the ground
      const x0 = f32[o], y0 = f32[o + 1], x1 = f32[o + 2], y1 = f32[o + 3];
      const s0 = arcs[first + k], s1 = s0 + Math.hypot(x1 - x0, y1 - y0) * mpu;
      // A new stretch where this segment does not go on from the last one.
      if (cur && (Math.hypot(x0 - endX, y0 - endY) > 0.5 || Math.abs(s0 - endS) > 0.5)) cur = null;
      if (!cur) { cur = [lon(x0), lat(y0), s0]; stretches.push(cur); }
      cur.push(lon(x1), lat(y1), s1);
      endX = x1; endY = y1; endS = s1;
    }
    if (stretches.length) out.push({ line: l, stretches: stretches.map((a) => Float64Array.from(a)) });
  }
  return out;
}
