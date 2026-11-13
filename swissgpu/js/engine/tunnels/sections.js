/* sections.js — what a tunnel looks like across, and how its floor climbs.
 *
 * His words (on 5.15b): "Also implement tunnels (and try to get info about
 * them, like shape, rectangle or "round", ecc ecc)"; his answer on how:
 * "Rules + major tunnels table". The vector tiles say only that a line is in
 * a tunnel; the rest is rules by family, kind and length, and a table of the
 * longest Swiss tunnels from their operators' and Wikipedia's figures
 * (checked 2026-11-04; research doc "Tunnels").
 *
 * A cross-section is a loop for one line (one track, one road or one
 * carriageway) in metres across (right of the line) and up from the floor
 * (the top of the rails or the road), counter-clockwise seen along the way,
 * with a material per edge and creases where the light should break; the
 * mesh (wasm/src/tunnel.c) stretches it across where several lines share the
 * bore, its vault (above `spring`) rising with the square root of that.
 *   horseshoe  a flat floor, walkways, upright walls to the springline and a
 *              round arch: road tunnels, older railway tunnels;
 *   circle     a bored tube with a flat floor across its lower part: the
 *              base tunnels' single-track tubes (bored 8.8 to 9.6 m, about
 *              7.8 m inside);
 *   box        cut and cover: walls and a flat roof, for short tunnels.
 * Long road tunnels with transverse ventilation have a flat ceiling slab
 * under the vault (the air ducts above it), at its own height however wide
 * the bore is.
 *
 * The floor: each portal at the ground of its open approach (heights.js),
 * linear between; where the table knows a tunnel's culmination, its rise
 * above the line between its portals is added as a hump (the Gotthard road
 * tunnel climbs from Göschenen to 1,175 m 8 km in, then falls to Airolo).
 *
 * Where the ground over a short tunnel leaves no room for its section by the
 * rules (an underpass under a road's embankment), it is made a box as high
 * as there is room for, or not built at all if not even its clearance fits
 * (fitUnder; fit.js measures the ground). Each section says what its outline
 * is (`low`, `arch`), so the terrain is opened exactly along it
 * (outlineAt; tunnels/cuts.js, terrain.wgsl inBore).
 */

import { TUBE_POINT } from './groups.js';

export const MATERIAL = { FLOOR: 1, WALKWAY: 2, WALL: 3, VAULT: 4, COLLAR: 5, DARK: 6, CEILING: 7 };
/* Floats per cross-section point: across, up, material, crease. */
export const PROFILE_FLOATS = 4;

const ARCH_SEGMENTS = 20;   // (14 until 5.17p: his words on 5.17o, "more detailed tunnels")

/**
 * The longest Swiss tunnels: length (m), where their middle about is, what
 * they are, and their portals' and highest point's heights (m above sea),
 * the highest point `atFrom` metres from the portal named by `from`.
 * Sources: Wikipedia (List of tunnels in Switzerland; the tunnels' pages),
 * AlpTransit Gotthard's project figures (raonline GBT_Projekt01).
 */
export const TUNNEL_TABLE = [
  { name: 'Gotthard Base Tunnel', family: 2, length: 57104, mid: [8.78, 46.60], year: 2016, section: 'tube',
    portals: { north: 460, south: 312 }, top: { h: 549, from: 'north', at: 22000 } },
  { name: 'Lötschberg Base Tunnel', family: 2, length: 34577, mid: [7.72, 46.45], year: 2007, section: 'tube',
    portals: { north: 780, south: 654 }, top: null },
  { name: 'Simplon Tunnel', family: 2, length: 19823, mid: [8.10, 46.26], year: 1906, section: 'single', top: null },
  { name: 'Vereina Tunnel', family: 2, length: 19042, mid: [10.0, 46.83], year: 1999, section: 'metre', top: null },
  { name: 'Gotthard Road Tunnel', family: 1, length: 16942, mid: [8.596, 46.600], year: 1980, section: 'road', ceiling: true,
    portals: { north: 1080, south: 1146 }, top: { h: 1175, from: 'north', at: 8000 } },
  { name: 'Furka Base Tunnel', family: 2, length: 15407, mid: [8.43, 46.56], year: 1982, section: 'metre', top: null },
  { name: 'Ceneri Base Tunnel', family: 2, length: 15400, mid: [8.96, 46.10], year: 2020, section: 'tube', top: null },
  // Double track, 8.0 m wide, 7.1 m high: what the rules make of the data's two tracks 3.2 m apart (8.2 × 7.1 m).
  { name: 'Gotthard Rail Tunnel', family: 2, length: 15003, mid: [8.596, 46.596], year: 1882, section: null,
    portals: { north: 1106, south: 1142 }, top: { h: 1151, from: 'north', at: 8000 } },
];

/* Kinds by what their tunnels are like (the transport schema's ids). */
const PATHS = new Set(['path', 'footway', 'steps', 'track', 'trail', 'via_ferrata', 'cycleway']);
const NARROW = new Set(['narrow_gauge', 'rack', 'rack_rail', 'tram', 'transit_other']);
const MAIN = new Set(['motorway', 'trunk', 'primary', 'secondary']);

/* Metres over a cut-and-cover box's inside its roof slab and the soil on it take. */
export const ROOF = 0.6;

/**
 * The table's entry for a whole tunnel (its length and middle), or null.
 * @param tube  groups.js tube, traced from portal to portal
 */
export function tableEntry(tube) {
  const p = tube.points, n = p.length / TUBE_POINT, mid = Math.floor(n / 2) * TUBE_POINT;
  const lon = p[mid], lat = p[mid + 1];
  for (const e of TUNNEL_TABLE) {
    if (e.family !== tube.family) continue;
    if (Math.abs(tube.length - e.length) > Math.max(150, e.length * 0.02)) continue;
    const dx = (lon - e.mid[0]) * 111320 * Math.cos((lat * Math.PI) / 180), dy = (lat - e.mid[1]) * 111132;
    if (Math.hypot(dx, dy) <= 8000) return e;
  }
  return null;
}

/**
 * The cross-section for a tube.
 * @param tube   groups.js tube (family, kind, length; the whole tunnel's length if traced)
 * @param kind   its kind from the schema's tables (width: the road's drawn width)
 * @param entry  its table entry or null
 * @returns { points: Float32Array, count, spring, half (one line's half-width), height, ceiling (0 none) }
 */
export function sectionFor(tube, kind, entry, length = tube.length) {
  const sec = sectionOf(tube, kind, entry, length);
  // A railway's walkways give way where its bore is stretched for a line beside it (5.17q: tunnel.c walkway_at).
  if (sec && (tube.family === 2 || entry?.section === 'tube')) sec.rail = true;
  return sec;
}

/* Where a railway's walkways are gone from its cut (`outlineAt`): from half of tunnel.c's WALK_WIDE (0.12) more than
 * one line wide, where its mesh has lowered them half way. */
const WALK_YIELD = 0.06;
function yields(sec, wide) {
  return sec.rail === true && wide > 1 + WALK_YIELD;
}

function sectionOf(tube, kind, entry, length) {
  const id = kind?.id ?? '';
  if (entry?.section === 'tube') return circle({ diameter: 7.8, floor: 2.9, walkway: 1.1, kerb: 0.45 });
  if (tube.family === 2) {
    if (entry?.section === 'metre' || NARROW.has(id)) return horseshoe({ width: 4.6, height: 5.2, spring: 2.6, walkway: 0.5, kerb: 0.35 });
    if (id === 'funicular') return horseshoe({ width: 3.6, height: 4.0, spring: 2.0 });
    if (length < 100) return box({ width: 5.4, height: 6.0, walkway: 0.6, kerb: 0.35 });
    return horseshoe({ width: 5.0, height: 6.2, spring: 3.0, walkway: 0.6, kerb: 0.35 });
  }
  if (PATHS.has(id)) return length < 60 ? box({ width: 3.0, height: 2.8 }) : horseshoe({ width: 3.0, height: 3.0, spring: 1.8 });
  if (id === 'motorway') return horseshoe({ width: 11.0, height: 7.5, spring: 3.2, walkway: 1.0, kerb: 0.25, ceiling: length > 5000 ? 5.2 : 0 });
  // Roads: their drawn width, walkways either side.
  const road = Math.max(5.5, (kind?.width ?? 7) + 2.2);
  if (length < 100) return box({ width: road + 1, height: 5.5, walkway: 0.8, kerb: 0.2 });
  const long = entry?.ceiling || length > 5000;
  return horseshoe({ width: Math.min(10.5, road + 1.5), height: Math.min(7.0, 4.8 + road * 0.22), spring: 3.0, walkway: 1.0, kerb: 0.25,
    ceiling: long ? 5.0 : 0 });
}

/* What a tunnel is for, as it looks inside (5.17n, his words on 5.17m: "make things better and make them more
 * interesting and realistic, also account what is road, rail and "by foot""; tunnel.wgsl LOOK_*): a road's, a
 * railway's, a footway's (an underpass in town), a path's or a farm track's (the bare rock of the hills). */
export const LOOK = { ROAD: 1, RAIL: 2, FOOT: 3, ROCK: 4 };
/* Look flags (tunnel.wgsl LOOK_*): a slab track (the base tunnels' bored tubes: concrete, no ballast); a masonry
 * portal (the older railway tunnels'); the safety fittings (SOS niches and exits in road tunnels of 300 m or more,
 * ASTRA 74001's scope; exit signs every 50 m and cross-passage doors in railway tunnels of a kilometre or more, TSI
 * SRT). */
export const LOOK_SLAB = 1, LOOK_MASONRY = 2, LOOK_SAFETY = 4, LOOK_NARROW = 8;
const TOWN_FOOT = new Set(['footway', 'steps', 'cycleway']);
const HILL = new Set(['path', 'trail', 'via_ferrata', 'track']);

/**
 * How a tube looks inside: its lamps (metres apart, colour at a metre, size along, where: tunnels.js lampAt), its
 * walls' colour (linear albedo), its fittings (a railway's contact wire `overhead` metres up, its conductor rail over
 * each track, `gauge` half its gauge (its rails); a road tube's pairs of jet fans every `fanStep` metres, where it has no
 * ventilation ceiling: under 500 m a tube needs none), `ways` (a road: 1 one way, its lanes dashed apart; 2 both ways, a solid line between) and its
 * flags (LOOK_*).
 * @param tube   groups.js tube (family, kind, oneway)
 * @param kind   its kind from the schema's tables
 * @param sec    its section as built (fit.js: a box where the ground leaves no room for more)
 * @param entry  its table entry or null
 * @param length the whole tunnel's length
 */
export function lookFor(tube, kind, sec, entry, length = tube.length) {
  const id = kind?.id ?? '';
  if (tube.family === 2) {
    const bored = entry?.section === 'tube', narrow = entry?.section === 'metre' || NARROW.has(id);
    return {
      look: LOOK.RAIL, lamps: { step: 25, colour: [3.3, 3.45, 3.75], size: 0.3, place: 'rail' },
      wall: bored ? [0.27, 0.26, 0.25] : [0.17, 0.16, 0.15],
      // SBB's contact wire is about 5 m over the rails in tunnels (metre gauge lower), under the crown with room for
      // the rail and its arms.
      overhead: id === 'funicular' ? 0 : Math.max(0, Math.min(narrow ? 4.4 : 5.0, sec.height - 0.9)),
      // Half the gauge: standard 1435 mm, metre gauge (narrow, rack, the funicular's) 1000 mm (5.17o: its rails).
      gauge: narrow || id === 'funicular' ? 0.5 : 0.7175,
      fanStep: 0, ways: 2,
      flags: (bored ? LOOK_SLAB : 0) | (!bored && !(entry?.year >= 1950) ? LOOK_MASONRY : 0) | (length >= 1000 ? LOOK_SAFETY : 0) |
        (narrow || id === 'funicular' ? LOOK_NARROW : 0),
    };
  }
  if (TOWN_FOOT.has(id)) {
    return { look: LOOK.FOOT, lamps: { step: 4, colour: [5.0, 5.2, 5.5], size: 1.2, place: 'vault' }, wall: [0.58, 0.59, 0.58],
      overhead: 0, fanStep: 0, ways: 2, flags: 0 };
  }
  if (HILL.has(id)) {
    return { look: LOOK.ROCK, lamps: { step: 30, colour: [1.4, 1.15, 0.8], size: 0.25, place: 'wall' }, wall: [0.20, 0.18, 0.16],
      overhead: 0, fanStep: 0, ways: 2, flags: 0 };
  }
  const main = MAIN.has(id);
  return {
    look: LOOK.ROAD,
    lamps: main ? { step: 12, colour: [10, 9.2, 8.0], size: 1.2, place: 'vault' } : { step: 20, colour: [7, 6.4, 5.6], size: 0.8, place: 'vault' },
    wall: [0.55, 0.55, 0.52], overhead: 0,
    fanStep: main && !sec.ceiling && length >= 500 ? 200 : 0,
    ways: tube.oneway ? 1 : 2, flags: length >= 300 ? LOOK_SAFETY : 0,
  };
}

/**
 * The least height a tunnel of a tube's kind needs inside (metres): under it, a stretch the data calls a tunnel
 * has no room in the ground and is not built (fitUnder). Swiss practice, rounded down: main roads 4.5 m (4.0
 * here), lesser roads and farm underpasses about 3 m (2.5 here since 5.17h: the ground model lies a few
 * decimetres either way, and a tube 0.3 m lower is nearer the truth than none), footpaths 2.2 to 2.5 m (2.0 here, for
 * the same reason), standard-gauge railways under the catenary about
 * 5 m, metre gauge about 4 m.
 */
export function clearanceFor(tube, kind) {
  const id = kind?.id ?? '';
  if (tube.family === 2) return id === 'funicular' ? 2.6 : NARROW.has(id) ? 3.6 : 4.6;
  if (PATHS.has(id)) return 2.0;
  return MAIN.has(id) ? 4.0 : 2.5;
}

/** The least box of a section's kind: as wide, `clearance` high inside (fit.js: under the thinnest ground that holds one). */
export function leastBox(sec, clearance) {
  return box({ width: 2 * sec.half, height: clearance, walkway: sec.walkway, kerb: sec.kerb });
}

/**
 * A section that fits under `cover` metres of ground over its floor: itself where there is room (its height and
 * ROOF), else a cut-and-cover box as wide and as high as there is room for; null where not even `clearance` fits.
 */
export function fitUnder(sec, cover, clearance) {
  if (!(cover < sec.height + ROOF)) return sec;
  const height = cover - ROOF;
  if (height < clearance) return null;
  return box({ width: 2 * sec.half, height, walkway: sec.walkway, kerb: sec.kerb });
}

/**
 * A section's outline as drawn where the bore is `wide` times one line's section wide (tunnel.c `placed`: across
 * stretched by `wide`, above the springline up by its square root): up to `top` a rectangle `half` either side of
 * the middle; above it the arch, an ellipse whose middle is `archY` up, `archA` across and `archH` up (archA 0: a
 * flat roof at `top`); `crown` its highest point. Metres. Exactly as the mesh is (5.17n: where tubes run into each
 * other, each leaves out what lies inside the other's outline, and where the outline claimed room the mesh does not
 * have, slits to the rock and the sky opened): beyond `inner` either side of the middle the walkways stand `kerb`
 * high, the room starts on them; under the arch's middle, where it is below the springline (a bored tube's lower
 * half: not stretched up), the ellipse is `lowR` high (0: archH there too).
 */
export function outlineAt(sec, wide = 1) {
  const root = Math.sqrt(wide), up = (h) => (h > sec.spring ? sec.spring + (h - sec.spring) * root : h);
  const o = { half: sec.low.half * wide, top: up(sec.low.top), archY: 0, archA: 0, archH: 0, crown: up(sec.height),
    inner: (yields(sec, wide) ? sec.low.half : sec.low.inner ?? sec.low.half) * wide, kerb: sec.kerb > 0 && sec.walkway > 0 ? sec.kerb : 0, lowR: 0 };
  if (sec.arch) {
    o.archY = sec.spring + (sec.arch.y - sec.spring) * root;
    o.archA = sec.arch.r * wide;
    o.archH = sec.arch.r * root;
    if (sec.arch.y > sec.low.top + 1e-6 && sec.arch.y <= sec.spring + 1e-6) o.lowR = sec.arch.r;
  }
  return o;
}

/* A loop builder: points in order with the material of the edge leaving each, and creases. */
function loop() {
  const pts = [];
  return {
    add(a, h, material, crease = false) { pts.push(a, h, material, crease ? 1 : 0); },
    done(spring, half, height) {
      // A point on the one before it (or the last on the first) would make an edge of no length.
      const out = [];
      for (let i = 0; i < pts.length; i += PROFILE_FLOATS) {
        const j = out.length - PROFILE_FLOATS;
        if (j >= 0 && Math.hypot(pts[i] - out[j], pts[i + 1] - out[j + 1]) < 1e-3) continue;
        out.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
      }
      while (out.length > 3 * PROFILE_FLOATS && Math.hypot(out[0] - out[out.length - 4], out[1] - out[out.length - 3]) < 1e-3) out.length -= PROFILE_FLOATS;
      return { points: Float32Array.from(out), count: out.length / PROFILE_FLOATS, spring, half, height };
    },
  };
}

/* The floor and the walkways from the left wall's foot to the right wall's foot (at walkway height `kerb`). */
function floorAndWalkways(L, half, walkway, kerb) {
  const fw = half - walkway;
  if (walkway > 0 && kerb > 0) {
    L.add(-fw, 0, MATERIAL.FLOOR, true);
    L.add(fw, 0, MATERIAL.WALKWAY, true);      // the kerb's face
    L.add(fw, kerb, MATERIAL.WALKWAY, true);   // the walkway
  } else {
    L.add(-half, 0, MATERIAL.FLOOR, true);
  }
}

/**
 * A horseshoe: upright walls to `spring`, a round arch through the crown at `height`; walkways `walkway` wide
 * and `kerb` high either side; with `ceiling`, a flat ceiling slab at that height under the vault (the air ducts
 * above it), which the mesh adds across between the walls (tunnel.c): the loop itself stays the whole arch, so
 * the portal shows it.
 */
export function horseshoe({ width, height, spring, walkway = 0, kerb = 0, ceiling = 0 }) {
  const half = width / 2, L = loop();
  floorAndWalkways(L, half, walkway, kerb);
  const foot = walkway > 0 && kerb > 0 ? kerb : 0;
  // The arch through (±half, spring) and (0, height): centre (0, c), radius R; its points between the springlines.
  const c = (height * height - spring * spring - half * half) / (2 * (height - spring)), R = height - c;
  const a0 = Math.atan2(spring - c, half);
  L.add(half, foot, MATERIAL.WALL, true);          // the right wall's foot
  L.add(half, spring, MATERIAL.VAULT);
  for (let i = 1; i < ARCH_SEGMENTS; i++) {
    const t = a0 + ((Math.PI - 2 * a0) * i) / ARCH_SEGMENTS;
    L.add(R * Math.cos(t), c + R * Math.sin(t), MATERIAL.VAULT);
  }
  L.add(-half, spring, MATERIAL.WALL);
  if (walkway > 0 && kerb > 0) {
    L.add(-half, foot, MATERIAL.WALKWAY, true);    // the left walkway
    L.add(-(half - walkway), kerb, MATERIAL.WALKWAY, true);
  }
  const sec = L.done(spring, half, height);
  sec.ceiling = ceiling > 0 && ceiling < height ? ceiling : 0;
  Object.assign(sec, { walkway, kerb, low: { half, top: spring, inner: walkway > 0 && kerb > 0 ? half - walkway : half }, arch: { y: c, r: R } });
  return sec;
}

/**
 * A bored tube of `diameter` inside, its floor `floor` metres either side of the middle (the invert filled up to
 * the top of the rails), raised walkways `walkway` wide either side.
 */
export function circle({ diameter, floor, walkway = 0, kerb = 0 }) {
  const R = diameter / 2, c = Math.sqrt(R * R - floor * floor), L = loop();
  // Where the circle meets the walkways' height.
  const wx = Math.sqrt(R * R - (kerb - c) ** 2);
  const fw = Math.min(floor, wx - walkway);
  L.add(-fw, 0, MATERIAL.FLOOR, true);
  if (kerb > 0) { L.add(fw, 0, MATERIAL.WALKWAY, true); L.add(fw, kerb, MATERIAL.WALKWAY, true); }
  const a0 = Math.atan2(kerb - c, wx);
  const steps = ARCH_SEGMENTS + 6;
  for (let i = 0; i < steps; i++) {
    const t = a0 + ((Math.PI - 2 * a0) * i) / steps;
    L.add(R * Math.cos(t), c + R * Math.sin(t), i === 0 ? MATERIAL.WALL : MATERIAL.VAULT, i === 0);
  }
  L.add(-wx, kerb, MATERIAL.WALKWAY, true);
  if (kerb > 0) L.add(-fw, kerb, MATERIAL.WALKWAY, true);
  // Its outline: the floor between the walkways up to their height, the circle over them.
  return Object.assign(L.done(c, R, c + R), { walkway, kerb, low: { half: fw, top: kerb, inner: fw }, arch: { y: c, r: R } });
}

/* Cut and cover: upright walls, a flat roof. */
export function box({ width, height, walkway = 0, kerb = 0 }) {
  const half = width / 2, L = loop();
  floorAndWalkways(L, half, walkway, kerb);
  const foot = walkway > 0 && kerb > 0 ? kerb : 0;
  L.add(half, foot, MATERIAL.WALL, foot > 0);
  L.add(half, height, MATERIAL.CEILING, true);
  L.add(-half, height, MATERIAL.WALL, true);
  if (walkway > 0 && kerb > 0) {
    L.add(-half, foot, MATERIAL.WALKWAY, true);
    L.add(-(half - walkway), kerb, MATERIAL.WALKWAY, true);
  }
  return Object.assign(L.done(height, half, height), { walkway, kerb, low: { half, top: height, inner: walkway > 0 && kerb > 0 ? half - walkway : half }, arch: null });
}

/**
 * The floor's height along a whole tunnel: linear between its ends' heights, with the table's hump.
 * @param length  the whole tunnel's length (m)
 * @param hA, hB  the ground at its first and last end (m above the ellipsoid; NaN where unknown)
 * @param entry   its table entry or null; `ends` its ends' lat (which is north)
 * @returns (s) => metres above the ellipsoid, or null if neither end is known
 */
export function floorProfile(length, hA, hB, entry = null, latA = 0, latB = 0) {
  const knownA = Number.isFinite(hA), knownB = Number.isFinite(hB);
  if (!knownA && !knownB) return null;
  const a = knownA ? hA : hB, b = knownB ? hB : hA;
  let hump = null;
  const top = entry?.top, portals = entry?.portals;
  if (top && portals && knownA && knownB) {
    // Where the highest point is along this tube (from its first end), and how far above the table's own line.
    const northFirst = latA >= latB;
    const fromFirst = (top.from === 'north') === northFirst;
    const s = fromFirst ? top.at : length - top.at;
    const t = Math.min(1, Math.max(0, top.at / entry.length));
    const pA = top.from === 'north' ? portals.north : portals.south, pB = top.from === 'north' ? portals.south : portals.north;
    const rise = top.h - (pA + (pB - pA) * t);
    if (rise > 0 && s > 0 && s < length) hump = { s, rise };
  }
  return (s) => {
    const t = length > 0 ? Math.min(1, Math.max(0, s / length)) : 0;
    let h = a + (b - a) * t;
    if (hump) h += hump.rise * (s <= hump.s ? Math.max(0, s) / hump.s : Math.max(0, length - s) / (length - hump.s));
    return h;
  };
}
