/* appearance.js — what each building looks like, from its adapter's rules.
 *
 * Runs on a decode thread with every building tile. The adapter describes,
 * as plain data, the looks its country's buildings come in and the rules
 * that pick one for each building from what is known about it: its type in
 * the source, whether the source gives it an id, how tall it is, where its
 * eaves are, how much ground it covers, whether its roof is pitched, how high
 * above the sea it stands and which region it is in. The first rule that
 * matches wins, so the rules read as a list of exceptions ending in the
 * ordinary case. Conditions: type (exact) or typeHas (contains a word),
 * region, hasId, and [min, max] ranges for height, eaves, footprint,
 * pitched (the share of the roof that slopes), altitude; `chance` lets only
 * that share of the matching buildings take the look.
 *
 * A look names a wall material, a palette to take the colour from, the kind
 * of openings its walls have, how often its windows get shutters and painted
 * surrounds, how far its roof overhangs, and what its base is made of.
 *
 * The shader receives eight bytes per building (see buildings.wgsl):
 *   word 0   wall colour, sRGB, 8 bits a channel | kind << 24 | material << 28
 *   word 1   eaves above the base, decimetres (11 bits) | overhang, quarter
 *            metres (3) | base material (4) | openings (3) | shutters (1) |
 *            surrounds (1) | base is a whole storey (1) | seed (8)
 */

import { MATERIALS, OPENINGS, NO_BASE } from './materials.js';

export const RECORD_WORDS = 2;

/* Per building, as measured by mesh_features in wasm/src/mesh.c. */
export const METRIC = { lowest: 0, eaves: 1, top: 2, roofArea: 3, pitchedArea: 4,
  minX: 5, minY: 6, maxX: 7, maxY: 8, STRIDE: 9 };

const KIND = { building: 0, plain: 1, glass: 2, canopy: 3, hidden: 15 };

/**
 * @param count     features in the tile
 * @param metrics   Float32Array, METRIC.STRIDE per feature
 * @param types     the source's type per feature, or null
 * @param ids       the source's id per feature, or null
 * @param frame     { lon, lat, height } of the tile's local frame
 * @param spec      the adapter's `appearance`: { regions, palettes, looks, rules }
 * @returns { records: Uint32Array, kinds: Uint8Array }
 */
export function describeBuildings({ count, metrics, types, ids, frame, spec }) {
  const records = new Uint32Array(count * RECORD_WORDS);
  const kinds = new Uint8Array(count);
  const regions = regionsAt(spec?.regions, frame.lon, frame.lat);
  const rules = spec?.rules || [];
  const looks = spec?.looks || {};
  const facts = { type: undefined, hasId: false, height: 0, eaves: 0, footprint: 0, pitched: 0, altitude: 0, regions, chance: 0 };

  for (let k = 0; k < count; k++) {
    const m = k * METRIC.STRIDE;
    const lowest = metrics[m + METRIC.lowest];
    const empty = !(lowest < 1e30);
    const id = ids?.[k];
    const hasId = id != null && id !== '' && Number(id) !== 0 && Number(id) !== -1;
    const h = hash32(hasId ? String(id) : `${frame.lon.toFixed(5)}:${frame.lat.toFixed(5)}:${k}`);

    facts.type = types?.[k];
    facts.hasId = hasId;
    facts.height = empty ? 0 : metrics[m + METRIC.top] - lowest;
    facts.eaves = empty ? 0 : metrics[m + METRIC.eaves] - lowest;
    const roof = metrics[m + METRIC.roofArea];
    const planBox = empty ? 0 : (metrics[m + METRIC.maxX] - metrics[m + METRIC.minX]) * (metrics[m + METRIC.maxY] - metrics[m + METRIC.minY]);
    facts.footprint = roof > 0 ? roof : planBox;
    facts.pitched = roof > 0 ? metrics[m + METRIC.pitchedArea] / roof : 0;
    facts.altitude = frame.height + (empty ? 0 : lowest);
    facts.chance = unit(h, 1);

    const look = looks[pickLook(rules, facts)] || looks.default || {};
    const kind = KIND[look.kind] ?? KIND.building;
    kinds[k] = kind;
    if (kind === KIND.hidden || empty) continue;

    const materialName = pick(look.material ?? 'plaster', h, 2);
    const material = Math.max(0, MATERIALS.indexOf(materialName));
    const baseSpec = typeof look.base === 'string' || Array.isArray(look.base) ? { material: look.base } : look.base;
    const base = baseSpec ? MATERIALS.indexOf(pick(baseSpec.material, h, 3)) : -1;
    // A palette per look, or per material where a look mixes them.
    const paletteName = look.palette && typeof look.palette === 'object'
      ? look.palette[materialName] ?? look.palette.default : look.palette;
    const colour = shade(pick(spec?.palettes?.[paletteName] ?? ['#d8d4cc'], h, 4), h);
    const eavesDm = Math.max(0, Math.min(2047, Math.round(facts.eaves * 10)));
    const overhang = Math.max(0, Math.min(7, Math.round((look.overhang ?? 0.5) * 4)));
    const shutters = unit(h, 5) < (look.shutters ?? 0) ? 1 : 0;
    const surrounds = unit(h, 6) < (look.surrounds ?? 0) ? 1 : 0;
    const openings = Math.max(0, OPENINGS.indexOf(look.openings ?? 'none'));

    records[k * 2] = (colour | (kind << 24) | ((material & 15) << 28)) >>> 0;
    records[k * 2 + 1] = (eavesDm
      | (overhang << 11)
      | ((base >= 0 ? base : NO_BASE) << 14)
      | ((openings & 7) << 18)
      | (shutters << 21)
      | (surrounds << 22)
      | ((baseSpec?.storey ? 1 : 0) << 23)
      | ((h & 0xff) << 24)) >>> 0;
  }
  return { records, kinds };
}

/* A number in [0, 1) from a building's hash, independent for each `salt`. */
function unit(h, salt) {
  return (mix32(h ^ Math.imul(salt, 0x9e3779b9)) >>> 8) / 16777216;
}

/* The first rule whose every condition holds. `type` matches the source's
 * type exactly; `typeHas` matches types containing any of the given words,
 * for sources whose exact vocabulary is not known in advance. */
function pickLook(rules, f) {
  for (const r of rules) {
    if (r.type !== undefined && !(Array.isArray(r.type) ? r.type.includes(f.type) : r.type === f.type)) continue;
    if (r.typeHas !== undefined && !(typeof f.type === 'string'
        && [].concat(r.typeHas).some((w) => f.type.toLowerCase().includes(String(w).toLowerCase())))) continue;
    if (r.region !== undefined && !f.regions.has(r.region)) continue;
    if (r.hasId !== undefined && r.hasId !== f.hasId) continue;
    if (!within(f.height, r.height) || !within(f.eaves, r.eaves) || !within(f.footprint, r.footprint)
        || !within(f.pitched, r.pitched) || !within(f.altitude, r.altitude)) continue;
    if (r.chance !== undefined && f.chance >= r.chance) continue;
    return r.look;
  }
  return 'default';
}

/* [min, max], either end left out for open. */
function within(value, range) {
  if (!range) return true;
  const [lo, hi] = range;
  return (lo == null || value >= lo) && (hi == null || value < hi);
}

/* A look may list several materials or colours: one per building, by hash. */
function pick(options, h, salt) {
  if (!Array.isArray(options)) return options;
  return options[Math.floor(unit(h, salt) * options.length)];
}

/* A palette colour, varied a little per building so no two terraces match:
 * a few percent of brightness and a touch of warmth. Packed as 0xBBGGRR. */
function shade(hex, h) {
  const v = parseInt(String(hex).replace('#', ''), 16);
  const light = 0.93 + 0.14 * unit(h, 7);
  const warm = 0.06 * (unit(h, 8) - 0.5);
  const r = clamp8(((v >> 16) & 255) * light * (1 + warm));
  const g = clamp8(((v >> 8) & 255) * light);
  const b = clamp8((v & 255) * light * (1 - warm));
  return r | (g << 8) | (b << 16);
}

const clamp8 = (x) => Math.max(0, Math.min(255, Math.round(x)));

/* Which of the adapter's regions a point is in: polygons of [lon, lat]. */
function regionsAt(regions, lon, lat) {
  const inside = new Set();
  for (const [name, polygon] of Object.entries(regions || {})) {
    if (pointInPolygon(lon, lat, polygon)) inside.add(name);
  }
  return inside;
}

function pointInPolygon(x, y, poly) {
  let odd = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return mix32(h);
}

/* Finalises a hash so that nearby inputs differ in every bit. */
function mix32(x) {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
