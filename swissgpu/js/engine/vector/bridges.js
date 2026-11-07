/* bridges.js — where roads come off bridges, and how high the decks are
 * there: pins for the terrain under the roads (wasm/src/shape.c).
 *
 * His words (on 5.15b): "make it so that bridges connect fully with roads...
 * data seems to not be totally accurate and some bridges stop suddenly...
 * so if you can, use some algorithms to connect things and smoothen them
 * out". The road tiles (base.vt) say where a road is a bridge, the bridge
 * layer (swissTLM3D's 3D structures) has the decks as drawn, and the terrain
 * under neither knows of the other: the ground under a bridge's last metres
 * can fall away, and the road cut into it with it, leaving a step at the
 * joint; and the two sources do not always agree on where a bridge ends.
 *
 * So for each run of bridge along a line, at both its ends: from a few
 * metres inside it, where the deck surely is, the deck is followed outwards
 * metre by metre (features/decks.js: the same deck within half a metre of
 * the last point) to where it really ends, past the line's own bridge end if
 * the deck goes on over the approach. There the road on the ground is pinned
 * to the deck's height (PIN_BELOW under it, so the two never fight for the
 * same pixels), and eases back onto its own profile (shape.c). Where the
 * deck ends before the line's bridge does (a bridge that "stops suddenly"),
 * the rest of the line's bridge is cut into the terrain as road from the
 * deck's end, on a bank (the gaps), so the road runs on instead of stopping
 * in the air. A bridge with no deck in any tile loaded (the layer off, or
 * not in yet) gets nothing, and is looked at again when decks come.
 */

import { BLOCK, segmentArcs } from '../../formats/vector-tile.js';

const BRIDGE = 1;
/* Metres inside a run the deck is first looked for (at most half of it). */
const INSIDE = 4;
/* Metres between the points the deck is followed through, how far beyond
 * the line's own bridge end it is followed, and how far one point's deck
 * may be from the last one's in height. */
const STEP = 1;
const BEYOND = 40;
const SAME_DECK = 0.5;
/* Metres the road on the ground is pinned under the deck's top. */
export const PIN_BELOW = 0.05;
/* A deck stopping more than this short of the line's bridge is not made up
 * for with a bank (metres): that is more than a mismatch of two sources. */
const GAP_MOST = 25;
/* Floats per pin: x, y (the block's tile units), s along its line, height,
 * the deck's grade there (rise per metre of s), line, and the side of s
 * the ground is on (+1 beyond it, -1 before it). */
export const PIN_FLOATS = 7;

const lonOf = (mx) => mx * 360 - 180;
const latOf = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;

/* A segment's length, metres. */
const lengthOf = (f32, o, mpu) => Math.hypot(f32[o + 2] - f32[o], f32[o + 3] - f32[o + 1]) * mpu;

/**
 * The runs of bridge along a detail tile's lines: [{ line, first, count, sA,
 * sB }] (its segments, and the distances along the line where it starts and
 * ends: segmentArcs', the same the pieces carry).
 * @param cpu  { block } (a detail tile's CPU copy; its arcs are kept on it)
 */
export function bridgeRuns(cpu) {
  const block = cpu.block;
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const f32 = new Float32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const segs = u32[BLOCK.segmentsOff] / 4, lines = u32[BLOCK.linesOff] / 4, lineCount = u32[BLOCK.lineCount];
  const arcs = cpu.arcs ??= segmentArcs(block), mpu = f32[BLOCK.metresPerUnit];
  const runs = [];
  for (let l = 0; l < lineCount; l++) {
    const first = u32[lines + l * 4], count = u32[lines + l * 4 + 1];
    for (let k = 0; k < count;) {
      const brunnel = (u32[segs + (first + k) * 8 + 6] >>> 6) & 3;
      if (brunnel !== BRIDGE) { k++; continue; }
      let e = k + 1;
      while (e < count && ((u32[segs + (first + e) * 8 + 6] >>> 6) & 3) === BRIDGE) e++;
      const last = first + e - 1;
      runs.push({ line: l, first: first + k, count: e - k, sA: arcs[first + k], sB: arcs[last] + lengthOf(f32, segs + last * 8, mpu),
        lineFirst: first, lineCount: count });
      k = e;
    }
  }
  return runs;
}

/**
 * The pins and gaps of a block's bridges (see the top), from the decks known
 * now: { pins: Float32Array (PIN_FLOATS each) or null, gaps: Map of segment
 * → [s from, s to] or null, sig: a number that changes when they do }.
 * @param cpu    { block, z, x, y } (a detail tile's CPU copy)
 * @param runs   bridgeRuns(cpu.block)
 * @param decks  features/decks.js
 */
export function pinsFor(cpu, runs, decks) {
  const block = cpu.block;
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const f32 = new Float32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const segs = u32[BLOCK.segmentsOff] / 4, E = u32[BLOCK.extent], n = 2 ** cpu.z;
  const arcs = cpu.arcs ??= segmentArcs(block), mpu = f32[BLOCK.metresPerUnit];
  // The point at distance s along a line: tile units, or null off its ends.
  // Asked metre by metre outwards from a run's end, so the search starts at
  // the segment the last answer was on (`hint`) and goes the way s went.
  const at = { x: 0, y: 0, lon: 0, lat: 0 };
  let hint = 0;
  const segmentAt = (run, k, s) => {
    const o = segs + (run.lineFirst + k) * 8;
    const s0 = arcs[run.lineFirst + k], s1 = s0 + lengthOf(f32, o, mpu);
    if (s < s0 - 1e-3 || s > s1 + 1e-3) return false;
    hint = k;
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    at.x = f32[o] + (f32[o + 2] - f32[o]) * f;
    at.y = f32[o + 1] + (f32[o + 3] - f32[o + 1]) * f;
    at.lon = lonOf((cpu.x + at.x / E) / n);
    at.lat = latOf((cpu.y + at.y / E) / n);
    return true;
  };
  const pointAt = (run, s) => {
    const last = run.lineCount - 1;
    const h = Math.max(0, Math.min(last, hint));
    const up = s >= arcs[run.lineFirst + h];
    for (let k = h; up ? k <= last : k >= 0; k += up ? 1 : -1) if (segmentAt(run, k, s)) return at;
    for (let k = 0; k <= last; k++) if (segmentAt(run, k, s)) return at;
    return null;
  };

  const pins = [];
  let gaps = null, h = 2166136261;
  const nodes = [], box = [0, 0, 0, 0];
  const cosLat = Math.cos(((latOf(cpu.y / n) + latOf((cpu.y + 1) / n)) / 2) * Math.PI / 180);
  const padLat = (BEYOND + INSIDE + 10) / 111132, padLon = padLat * 111132 / (111320 * cosLat);
  // The deck tiles over the whole tile first: none, and there is nothing to join.
  const near = decks.near([lonOf(cpu.x / n) - padLon, latOf((cpu.y + 1) / n) - padLat, lonOf((cpu.x + 1) / n) + padLon, latOf(cpu.y / n) + padLat]);
  if (!near.length) return { pins: null, gaps: null, sig: 0 };
  for (const run of runs) {
    // The deck tiles round this run (its segments, and as far as a deck is
    // followed past its ends), the only ones its heights are asked of.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < run.count; k++) {
      const o = segs + (run.first + k) * 8;
      for (let e = 0; e < 4; e += 2) {
        if (f32[o + e] < x0) x0 = f32[o + e];
        if (f32[o + e] > x1) x1 = f32[o + e];
        if (f32[o + e + 1] < y0) y0 = f32[o + e + 1];
        if (f32[o + e + 1] > y1) y1 = f32[o + e + 1];
      }
    }
    box[0] = lonOf((cpu.x + x0 / E) / n) - padLon; box[2] = lonOf((cpu.x + x1 / E) / n) + padLon;
    box[1] = latOf((cpu.y + y1 / E) / n) - padLat; box[3] = latOf((cpu.y + y0 / E) / n) + padLat;
    nodes.length = 0;
    for (const node of near) {
      const b = node.decks.box;
      if (b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1]) nodes.push(node);
    }
    if (!nodes.length) continue;
    for (const dir of [-1, 1]) {
      const end = dir < 0 ? run.sA : run.sB;
      hint = dir < 0 ? run.first - run.lineFirst : run.first - run.lineFirst + run.count - 1;
      const inside = Math.min(INSIDE, (run.sB - run.sA) / 2);
      const s0 = end - dir * inside;
      let p = pointAt(run, s0);
      if (!p) continue;
      let z = decks.heightAt(p.lon, p.lat, NaN, Infinity, nodes);
      if (Number.isNaN(z)) continue;
      // Followed out to where the deck ends; its grade over its last metres.
      let sLast = s0, zLast = z, xLast = p.x, yLast = p.y, sBack = s0, zBack = z;
      for (let s = s0 + dir * STEP; dir * (s - end) <= BEYOND; s += dir * STEP) {
        p = pointAt(run, s);
        if (!p) break;
        const zz = decks.heightAt(p.lon, p.lat, zLast, SAME_DECK, nodes);
        if (Number.isNaN(zz)) break;
        if (Math.abs(s - sBack) > 6) { sBack = sLast; zBack = zLast; }
        sLast = s; zLast = zz; xLast = p.x; yLast = p.y;
      }
      const zPin = zLast - PIN_BELOW, grade = Math.abs(sLast - sBack) > 1.5 ? (zLast - zBack) / (sLast - sBack) : 0;
      pins.push(xLast, yLast, sLast, zPin, Math.max(-0.15, Math.min(0.15, grade)), run.line, dir);
      // The signature moves with the pin by half a metre along and a tenth
      // up or down (a finer level of the deck's tiles moves it by
      // centimetres: not worth cutting the terrain again).
      h = Math.imul(h ^ Math.round(sLast * 2), 16777619);
      h = Math.imul(h ^ Math.round(zPin * 10), 16777619);
      // The deck stops before the line's bridge does: the rest on a bank.
      if (dir * (end - sLast) > 0.5 && dir * (end - sLast) <= GAP_MOST) {
        const lo = Math.min(sLast, end), hi = Math.max(sLast, end);
        for (let k = 0; k < run.count; k++) {
          const a = arcs[run.first + k], b = a + lengthOf(f32, segs + (run.first + k) * 8, mpu);
          const from = Math.max(a, lo), to = Math.min(b, hi);
          if (to - from <= 0.05) continue;
          gaps ??= new Map();
          const was = gaps.get(run.first + k);
          gaps.set(run.first + k, was ? [Math.min(was[0], from), Math.max(was[1], to)] : [from, to]);
          h = Math.imul(h ^ ((run.first + k) * 31 + Math.round(from * 10)), 16777619);
        }
      }
    }
  }
  return { pins: pins.length ? Float32Array.from(pins) : null, gaps, sig: pins.length ? (h >>> 0) || 1 : 0 };
}
