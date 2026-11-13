// tunnel.wgsl — the insides of tunnels (js/engine/passes/tunnels.js; the
// meshes from wasm/src/tunnel.c, their cross-sections, lamps and looks from
// js/engine/tunnels/sections.js). Joined after common.wgsl, atmosphere.wgsl,
// frame.wgsl, imagery.wgsl, vector.wgsl and bore.wgsl.
//
// No sun reaches inside: the light is the tunnel's own lamps and the
// daylight falling in at its portals. Lamps hang every `lampStep` metres
// along at one place of the cross-section (road tunnels: a row of
// luminaires in the vault; railway tunnels: the emergency lights under the
// handrail; underpasses: panels in the ceiling); a pixel is lit by the three
// nearest, found from its metres along, placed in the world from its own
// position, the way along and up. The daylight falls off from each portal
// inwards (two exponentials: the bright mouth over the first tens of metres,
// the long faint tail behind it). The collar round a portal is outside, in
// the open, and lit as everything outside is. The lamps are as bright as an
// eye adapted to them finds them, times `interior` (5.18b): from daylight a
// tunnel is dark inside, until the eye adapts (render.js raises
// frame.eyeGain to about 1 / interior after a while inside).
//
// What it looks like goes by what it is for (5.17n, sections.js lookFor; his
// words on 5.17m: "make things better and make them more interesting and
// realistic, also account what is road, rail and "by foot""), all of it
// drawn from the pixel's metres along, across and up, nothing sampled:
//   road  the walls' light coating 3.5 m up (the bare concrete over it, a
//         joint every 10 m where it was cast), road spray low on them;
//         asphalt with its markings along the tube (edge lines, a middle line
//         both ways, lanes dashed one way), a drain along each kerb; guide lights
//         every 25 m; in a tunnel of 300 m or more (ASTRA 74001) an SOS niche
//         every 150 m, sides taking turns (an orange door, a lit sign over
//         it), an emergency exit every 300 m (a green surround, its door
//         framed in green light, the sign over it) and signs to the exits
//         every 50 m; under a ventilation ceiling its exhaust openings every
//         16 m (PIARC 05.16.B: the St. Gotthard's); jet fans (tunnel.c);
//   rail  sooty walls (old tunnels: masonry; bored tubes: their segment
//         rings), brake dust low on them; the track from the vector tiles on
//         ballast or a slab (vector.wgsl vtTrack), its rails standing on it
//         (tunnel.c, over each line in the bore); a handrail 1 m over each
//         walkway on brackets (TSI SRT: 0.8 to 1.1 m), the cable troughs'
//         lids; in a tunnel of a kilometre or more exit signs every 50 m and
//         a cross-passage door every 500 m (TSI SRT); its overhead line
//         (tunnel.c);
//   foot  tiled walls with a band at hand height, a white ceiling of panels,
//         stone paving with a tactile guidance strip, bright lamps;
//   rock  a path's or a farm track's bare rock, wet streaks down it, a dim
//         bulb now and then.

const T_FLOOR   : u32 = 1u;
const T_WALKWAY : u32 = 2u;
const T_WALL    : u32 = 3u;
const T_VAULT   : u32 = 4u;
const T_COLLAR  : u32 = 5u;
const T_DARK    : u32 = 6u;
const T_CEILING : u32 = 7u;
const T_FIXTURE : u32 = 8u;
const T_RAIL    : u32 = 9u;
const T_INSULATOR : u32 = 10u;
const T_LAMP    : u32 = 11u;
const T_BED     : u32 = 12u;
// Metres outside the other's room a fitting still goes (5.17q: a handrail along a wall left out at a junction stood
// across the opening in the hand's width of wall left at its edge, live by Giubiasco).
const MEET_FITTING : f32 = 0.25;   // a track's bed on the floor (5.17q): `bed` metres across from its middle

const LOOK_ROAD : u32 = 1u;
const LOOK_RAIL : u32 = 2u;
const LOOK_FOOT : u32 = 3u;
const LOOK_ROCK : u32 = 4u;
const LOOK_SLAB     : u32 = 1u;
const LOOK_MASONRY  : u32 = 2u;
const LOOK_SAFETY   : u32 = 4u;
const LOOK_NARROW   : u32 = 8u;   // metre gauge (5.17q: its beds' rails)

struct Tube {
  originRel  : vec3f,   // the mesh's origin minus the camera, metres
  lampStep   : f32,     // metres between lamps, 0 none
  merc       : vec2f,   // the mesh's Mercator origin from the imagery anchor, reference pixels
  mercScale  : f32,     // imagery reference pixels per mesh Mercator unit
  inside     : f32,     // 1: the camera is in this tube, no outdoor haze on it
  portals    : vec2f,   // metres along of the portal at its first end (x) and its last (y), ±1e9 none
  lamp       : vec2f,   // where its lamps are: metres right of its line and up from the floor
  lampColour : vec3f,   // a lamp's light one metre from it, display units
  look       : u32,     // what it is for: LOOK_ROAD, LOOK_RAIL, LOOK_FOOT, LOOK_ROCK
  wall       : vec3f,   // the walls' colour (linear albedo)
  lampSize   : f32,     // metres a luminaire is long (along)
  spring     : f32,     // metres up where the walls end: the vault above it rises with the bore's width
  interior   : f32,     // the lamps' light against daylight's (the eye adapts to it inside, common.wgsl present)
  inner      : f32,     // one line's floor between its walkways, half its width (the bore stretches it)
  kerb       : f32,     // the walkways' height, 0 none
  ceiling    : f32,     // a ventilation ceiling's height, 0 none
  flags      : u32,     // LOOK_SLAB, LOOK_MASONRY, LOOK_SAFETY
  ways       : u32,     // a road's: 1 one way, 2 both ways
  _p3        : f32,
};

@group(1) @binding(0) var<uniform> tube : Tube;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) world  : vec3f,   // relative to the camera
  @location(1) normal : vec3f,
  @location(2) along  : f32,     // metres along the tunnel
  @location(3) ah     : vec2f,   // metres across and up of the cross-section
  @location(4) merc   : vec2f,   // imagery reference pixels from the anchor
  @location(5) way    : vec3f,   // the way along, earth-centred
  @location(6) lamp   : vec2f,   // where the lamps are here: metres across and up (they go with the bore)
  @location(7) @interpolate(flat) material : u32,
  @location(8) rel    : vec3f,   // from the mesh's origin, metres (earth-centred axes): for the bores meeting it
  @location(9) bore   : vec2f,   // the bore here: its middle (metres right of the line), how many lines wide
  @location(10) bed   : f32,     // a track's bed: metres across from the track's middle (tunnel.c bedAcross)
};

@vertex
fn vs(@location(0) position : vec3f, @location(1) normal : vec4f, @location(2) along : f32,
      @location(3) ah : vec2f, @location(4) merc : vec2f, @location(5) way : vec4f, @location(6) bore : vec2f) -> VSOut {
  var out : VSOut;
  out.world = position + tube.originRel;
  out.rel = position;
  out.clip = frame.viewProj * vec4f(out.world, 1.0);
  out.normal = normal.xyz;
  out.material = u32(round(normal.w * 32767.0));
  out.along = along;
  out.ah = ah;
  out.merc = tube.merc + merc * tube.mercScale;
  out.way = way.xyz;
  out.bed = way.w * 2.0;
  // The lamps' place, stretched with the bore as the mesh stretches its section (tunnel.c, placed).
  let middle = bore.x * 64.0;
  let wide = 1.0 + bore.y * 16.0;
  let up = select(tube.lamp.y, tube.spring + (tube.lamp.y - tube.spring) * sqrt(wide), tube.lamp.y > tube.spring);
  out.lamp = vec2f(middle + tube.lamp.x * wide, up);
  out.bore = vec2f(middle, wide);
  return out;
}

// Linear albedos.
const T_CONCRETE : vec3f = vec3f(0.30, 0.29, 0.27);
const T_BALLAST  : vec3f = vec3f(0.16, 0.15, 0.13);
const T_GRIME    : vec3f = vec3f(0.10, 0.095, 0.085);  // road spray
const T_RUST     : vec3f = vec3f(0.13, 0.075, 0.045);  // brake dust
const T_PAINT    : vec3f = vec3f(0.70, 0.70, 0.68);    // road markings
const T_NICHE    : vec3f = vec3f(0.06, 0.06, 0.06);
const T_ORANGE   : vec3f = vec3f(0.80, 0.20, 0.03);    // an SOS niche's door
const T_DOOR     : vec3f = vec3f(0.22, 0.24, 0.23);
const T_GREEN    : vec3f = vec3f(0.03, 0.30, 0.10);    // an exit's painted surround
const T_STEEL    : vec3f = vec3f(0.42, 0.43, 0.45);
const T_PLASTER  : vec3f = vec3f(0.72, 0.72, 0.70);
const T_BAND     : vec3f = vec3f(0.10, 0.16, 0.24);
const T_GROUT    : vec3f = vec3f(0.30, 0.30, 0.29);
const T_PAVING   : vec3f = vec3f(0.30, 0.29, 0.27);
const T_TACTILE  : vec3f = vec3f(0.55, 0.55, 0.53);
const T_STONE    : vec3f = vec3f(0.30, 0.27, 0.23);
const T_ALU      : vec3f = vec3f(0.40, 0.41, 0.42);
const T_COPPER   : vec3f = vec3f(0.30, 0.13, 0.06);
const T_FAN      : vec3f = vec3f(0.14, 0.15, 0.15);
// Lights of their own, as the lamps' light is reckoned (times `interior`).
const T_GUIDE      : vec3f = vec3f(2.4, 2.0, 1.2);
const T_SIGN_BLUE  : vec3f = vec3f(0.05, 0.25, 1.1);
const T_SIGN_WHITE : vec3f = vec3f(1.1, 1.1, 1.1);
const T_SIGN_GREEN : vec3f = vec3f(0.05, 1.0, 0.3);

// Value noise in the tube's own coordinates (metres along, across + up), so
// the grain stays on the walls as the camera moves.
fn tNoise(p : vec2f) -> f32 {
  return vtNoise(p + vec2f(4096.0), 65536u);
}

// A number from 0 to 1 for each whole cell of a grid (a tile's, a block's own shade).
fn tHash(p : vec2f) -> f32 {
  let q = bitcast<vec2u>(vec2i(floor(p)));
  var h = (q.x * 0x27d4eb2du) ^ (q.y * 0x165667b1u + 0x9e3779b9u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = h ^ (h >> 13u);
  return f32(h & 0xffffu) / 65535.0;
}

// A pixel of a tube: metres along, right of the bore's middle (`side` 1 right, -1 left) and up from the floor; metres
// a pixel spans along and across; the floor's half-width here and the walkways' height; where the fittings are counted
// from (its first portal, else where its metres start).
struct TPx {
  s         : f32,
  x         : f32,
  h         : f32,
  side      : f32,
  fw        : f32,
  fa        : f32,
  floorHalf : f32,
  walk      : f32,
  first     : f32,
};

fn tPixel(in : VSOut, fw : f32, fa : f32) -> TPx {
  var p : TPx;
  p.s = in.along;
  p.x = in.ah.x - in.bore.x;
  p.h = in.ah.y;
  p.side = select(-1.0, 1.0, p.x >= 0.0);
  p.fw = fw;
  p.fa = fa;
  p.floorHalf = tube.inner * in.bore.y;
  p.walk = tube.kerb;
  p.first = select(0.0, tube.portals.x, tube.portals.x > -1e8);
  return p;
}

// The nearest of a row of fittings `step` metres apart, the first `offset` metres from where they are counted from:
// x the pixel's metres from it along, y its number.
fn tStation(p : TPx, step : f32, offset : f32) -> vec2f {
  let d = p.s - p.first - offset;
  let k = round(d / step);
  return vec2f(d - k * step, k);
}

// A rectangle's share of a pixel: (u, v) the pixel's place in metres, the rectangle `hu` either side of u = 0 and from
// v0 to v1; fu, fv metres the pixel spans.
fn tRect(u : f32, v : f32, hu : f32, v0 : f32, v1 : f32, fu : f32, fv : f32) -> f32 {
  return vtBand(u, hu, fu) * vtBand(v - 0.5 * (v0 + v1), 0.5 * (v1 - v0), fv);
}

// A small light's share: no smaller than half a pixel, dimmer as it is spread (its light kept in part, so a row of
// them still shows far off).
fn tDot(u : f32, v : f32, hu : f32, hv : f32, fu : f32, fv : f32) -> f32 {
  let wu = max(hu, 0.5 * fu);
  let wv = max(hv, 0.5 * fv);
  return vtBand(u, wu, fu) * vtBand(v, wv, fv) * sqrt(hu * hv / (wu * wv));
}

// Stone blocks `size` (along, up) in courses, each course shifted half a block: x the mortar's share, y the block's
// own shade.
fn tBlocks(u : f32, v : f32, size : vec2f, fu : f32, fv : f32) -> vec2f {
  let row = floor(v / size.y);
  let uu = u / size.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  let du = (uu - floor(uu) - 0.5) * size.x;
  let dv = (v / size.y - row - 0.5) * size.y;
  let mortar = 1.0 - vtBand(du, 0.5 * size.x - 0.012, fu) * vtBand(dv, 0.5 * size.y - 0.012, fv);
  return vec2f(mortar, tHash(vec2f(floor(uu), row)));
}

// Tiles `size` in a grid, `line` the grout's half-width: x the grout's share, y the tile's own shade.
fn tGrid(u : f32, v : f32, size : vec2f, line : f32, fu : f32, fv : f32) -> vec2f {
  let cu = u / size.x;
  let cv = v / size.y;
  let du = (fract(cu) - 0.5) * size.x;
  let dv = (fract(cv) - 0.5) * size.y;
  let grout = 1.0 - vtBand(du, 0.5 * size.x - line, fu) * vtBand(dv, 0.5 * size.y - line, fv);
  return vec2f(grout, tHash(vec2f(floor(cu), floor(cv))));
}

// What a surface is: its albedo, the light it gives itself, and how glossy it is (a Blinn-Phong exponent, its share).
struct TSurf {
  albedo : vec3f,
  glow   : vec3f,
  shine  : f32,
  ks     : f32,
};

fn tPlain(albedo : vec3f) -> TSurf {
  var o : TSurf;
  o.albedo = albedo;
  o.glow = vec3f(0.0);
  o.shine = 0.0;
  o.ks = 0.0;
  return o;
}

// ---- roads ----

const COAT_TOP : f32 = 3.5;

fn tRoadWall(p : TPx, grain : f32) -> TSurf {
  let coat = 1.0 - smoothstep(COAT_TOP - p.fa, COAT_TOP + p.fa, p.h);
  var c = mix(T_CONCRETE * (1.0 + 0.35 * grain), tube.wall * (1.0 + 0.08 * grain), coat);
  c = mix(c, T_GRIME, 0.45 * (1.0 - smoothstep(0.1, 1.2, p.h - p.walk)));
  c *= 1.0 - 0.6 * vtBand(p.s - round(p.s / 10.0) * 10.0, 0.01, p.fw);
  c *= 1.0 - 0.3 * vtBand(p.h - COAT_TOP, 0.015, p.fa);
  var o = tPlain(c);
  o.shine = 16.0;
  o.ks = 0.06 * coat;
  return tRoadFittings(p, o);
}

fn tRoadFittings(p : TPx, wall : TSurf) -> TSurf {
  var o = wall;
  let up = p.h - p.walk;
  let guide = tStation(p, 25.0, 12.5);
  o.glow += T_GUIDE * tDot(guide.x, up - 0.85, 0.06, 0.025, p.fw, p.fa);
  if ((tube.flags & LOOK_SAFETY) == 0u) { return o; }
  // An SOS niche every 150 m, sides taking turns.
  let n = tStation(p, 150.0, 75.0);
  if (abs(n.x) < 1.2 && p.side == select(-1.0, 1.0, (i32(n.y) & 1) == 0)) {
    let door = tRect(n.x, up, 0.6, 0.0, 2.1, p.fw, p.fa);
    o.albedo = mix(o.albedo, T_NICHE, tRect(n.x, up, 0.68, -0.1, 2.25, p.fw, p.fa));
    o.albedo = mix(o.albedo, T_ORANGE, door);
    o.albedo = mix(o.albedo, T_PAINT, door * tRect(n.x, up, 0.25, 1.45, 1.75, p.fw, p.fa));
    let board = tRect(n.x, up, 0.45, 2.35, 2.75, p.fw, p.fa);
    o.glow += mix(T_SIGN_BLUE, T_SIGN_WHITE, tRect(n.x, up, 0.14, 2.42, 2.68, p.fw, p.fa)) * board;
    o.albedo *= 1.0 - board;
    o.ks *= 1.0 - door;
  }
  // An emergency exit every 300 m on the right.
  let e = tStation(p, 300.0, 150.0);
  if (abs(e.x) < 1.7 && p.side > 0.0) {
    let door = tRect(e.x, up, 0.75, 0.0, 2.25, p.fw, p.fa);
    let rim = max(tRect(e.x, up, 0.85, 0.0, 2.35, p.fw, p.fa) - door, 0.0);
    let board = tRect(e.x, up, 0.55, 2.6, 3.0, p.fw, p.fa);
    o.albedo = mix(o.albedo, T_GREEN, tRect(e.x, up, 1.5, -0.1, 3.3, p.fw, p.fa));
    o.albedo = mix(o.albedo, T_DOOR, door);
    o.glow += T_SIGN_GREEN * rim + mix(T_SIGN_GREEN, T_SIGN_WHITE, tRect(e.x - 0.2, up, 0.12, 2.66, 2.94, p.fw, p.fa)) * board;
    o.albedo *= 1.0 - max(board, rim);
  }
  // Signs to the nearest exit every 50 m, both sides, where no door is.
  let d = tStation(p, 50.0, 25.0);
  if (abs(e.x) > 2.0 && abs(n.x) > 1.5) {
    let board = tRect(d.x, up - 1.15, 0.3, -0.13, 0.13, p.fw, p.fa);
    o.glow += mix(T_SIGN_WHITE, T_SIGN_GREEN, tRect(d.x + 0.15, up - 1.15, 0.15, -0.13, 0.13, p.fw, p.fa)) * board * 0.6;
    o.albedo *= 1.0 - board;
  }
  return o;
}

// A drain along each kerb.
fn tDrains(p : TPx, c : vec3f) -> vec3f {
  return c * (1.0 - 0.7 * vtBand(abs(p.x) - (p.floorHalf - 0.08), 0.02, p.fa));
}

// The road's markings along the tube (5.17p, his words on 5.17o: "make turns and lines smooth", "lanes are messed up
// and conjunctions too": 5.17o drew them from the data's own lines, which kink at their points and cross where two
// lines meet; the tube's line is smoothed and its rings follow its curves): edge lines 0.4 m in from the kerbs, a
// solid line on its middle where it is 6 m wide or more both ways (no overtaking in a tunnel with traffic both ways),
// one way (the data's oneway) its lanes of 3.5 m or more dashed apart, 6 m lines 12 m apart where 8 m wide or more,
// else 3 m 6 m apart; 15 cm wide. None where the floor runs on inside another tube (tNoMarks: a junction).
var<private> tNoMarks : bool;

fn tRoadMarks(p : TPx, c : vec3f, grain : f32) -> vec3f {
  if (tNoMarks) { return c; }
  let lw = 0.075;
  let width = 2.0 * p.floorHalf;
  var paint = vtBand(abs(p.x) - (p.floorHalf - 0.4), lw, p.fa);
  if (tube.ways == 2u) {
    if (width >= 6.0) { paint = max(paint, vtBand(p.x, lw, p.fa)); }
  } else {
    let usable = width - 0.8;
    let lanes = max(1.0, floor(usable / 3.5));
    let lane = usable / lanes;
    let rel = p.x + p.floorHalf - 0.4;
    let k = round(rel / lane);
    let dash = select(3.0, 6.0, width >= 8.0);
    let on = vtBand(fract(p.s / (3.0 * dash)) * 3.0 * dash - 0.5 * dash, 0.5 * dash, p.fw);
    paint = max(paint, select(0.0, 1.0, k >= 1.0 && k <= lanes - 1.0) * vtBand(rel - k * lane, lw, p.fa) * on);
  }
  return mix(c, T_PAINT * (0.85 + 0.25 * grain), paint);
}

// ---- railways ----

fn tRailWall(p : TPx, grain : f32) -> TSurf {
  var c = tube.wall * (1.0 + 0.35 * grain);
  if ((tube.flags & LOOK_MASONRY) != 0u) {
    let b = tBlocks(p.s, p.h + abs(p.x), vec2f(0.62, 0.34), p.fw, p.fa);
    c = mix(c * (0.75 + 0.5 * b.y), c * 0.45, b.x);
  } else {
    let ring = select(10.0, 1.8, (tube.flags & LOOK_SLAB) != 0u);
    c *= 1.0 - 0.5 * vtBand(p.s - round(p.s / ring) * ring, 0.008, p.fw);
  }
  c = mix(c, T_RUST, 0.5 * (1.0 - smoothstep(0.0, 1.5, p.h - p.walk)));
  return tRailFittings(p, tPlain(c));
}

fn tRailFittings(p : TPx, wall : TSurf) -> TSurf {
  var o = wall;
  let up = p.h - p.walk;
  if (p.walk > 0.0) {
    // The handrail 1 m over the walkway (tunnel.c since 5.17p): its shadow on the wall, a bracket every 1.5 m.
    let b = tStation(p, 1.5, 0.0);
    let dark = max(vtBand(up - 0.93, 0.04, p.fa), tRect(b.x, up, 0.02, 0.9, 1.0, p.fw, p.fa));
    o.albedo = mix(o.albedo, o.albedo * 0.35, dark);
  }
  if ((tube.flags & LOOK_SAFETY) == 0u) { return o; }
  // Exit signs every 50 m both sides, 1.6 m over the walkway.
  let d = tStation(p, 50.0, 25.0);
  let board = tRect(d.x, up - 1.6, 0.22, -0.11, 0.11, p.fw, p.fa);
  o.glow += mix(T_SIGN_GREEN, T_SIGN_WHITE, tRect(d.x - 0.1, up - 1.6, 0.06, -0.08, 0.08, p.fw, p.fa)) * board * 0.7;
  o.albedo *= 1.0 - board;
  // A door to a cross-passage every 500 m on the right.
  let e = tStation(p, 500.0, 250.0);
  if (abs(e.x) < 1.5 && p.side > 0.0) {
    let door = tRect(e.x, up, 0.7, 0.0, 2.0, p.fw, p.fa);
    let rim = max(tRect(e.x, up, 0.78, 0.0, 2.08, p.fw, p.fa) - door, 0.0);
    let over = tRect(e.x, up, 0.45, 2.25, 2.6, p.fw, p.fa);
    o.albedo = mix(o.albedo, T_GREEN, tRect(e.x, up, 1.3, -0.1, 2.9, p.fw, p.fa));
    o.albedo = mix(o.albedo, T_DOOR, door);
    o.glow += T_SIGN_GREEN * (rim + over);
    o.albedo *= 1.0 - max(rim, over);
  }
  return o;
}

// ---- footways and the hills ----

fn tFootWall(p : TPx, grain : f32) -> TSurf {
  let t = tGrid(p.s, p.h + abs(p.x), vec2f(0.3, 0.15), 0.003, p.fw, p.fa);
  var c = tube.wall * (0.94 + 0.12 * t.y);
  c = mix(c, T_BAND, smoothstep(0.88 - p.fa, 0.88 + p.fa, p.h) * (1.0 - smoothstep(1.12 - p.fa, 1.12 + p.fa, p.h)));
  var o = tPlain(mix(c, T_GROUT, t.x));
  o.shine = 48.0;
  o.ks = 0.1 * (1.0 - t.x);
  return o;
}

fn tFootFloor(p : TPx, grain : f32) -> vec3f {
  let t = tGrid(p.s, p.x, vec2f(0.4, 0.4), 0.004, p.fw, p.fa);
  var c = T_PAVING * (0.9 + 0.2 * t.y) * (1.0 + 0.15 * grain);
  c = mix(c, c * 0.6, t.x);
  // A tactile guidance strip, white ribbed slabs 0.3 m wide, 0.6 m from the left wall.
  let gx = p.x + p.floorHalf - 0.6;
  let ribs = (0.5 + 0.5 * cos(gx * 104.72)) * (1.0 - smoothstep(0.01, 0.03, p.fa));
  return mix(c, T_TACTILE * (1.0 - 0.25 * ribs), vtBand(gx, 0.15, p.fa));
}

fn tRock(p : TPx) -> TSurf {
  let q = vec2f(p.s, p.h + abs(p.x));
  let v = 0.9 * (tNoise(q * 0.35) - 0.5) + 0.6 * (tNoise(q * 1.7 + 17.0) - 0.5) + 0.35 * (tNoise(q * 6.0 + 41.0) - 0.5);
  let streak = smoothstep(0.62, 0.8, tNoise(vec2f(p.s * 2.3, 0.15 * q.y) + 9.0));
  var o = tPlain(max(tube.wall * (1.0 + v) * (1.0 - 0.35 * streak), vec3f(0.01)));
  o.shine = 12.0;
  o.ks = 0.12 * streak;
  return o;
}

// ---- every look ----

fn tCeiling(p : TPx, grain : f32) -> vec3f {
  if (tube.look == LOOK_FOOT) {
    return T_PLASTER * (1.0 + 0.05 * grain) * (1.0 - 0.4 * vtBand(p.s - round(p.s / 1.2) * 1.2, 0.006, p.fw));
  }
  var c = T_CONCRETE * 1.3 * (1.0 + 0.2 * grain);
  c *= 1.0 - 0.4 * vtBand(p.s - round(p.s / 2.5) * 2.5, 0.008, p.fw);
  if (tube.ceiling > 0.0) {
    let g = tStation(p, 16.0, 8.0);
    let slats = 0.5 + 0.5 * cos(g.x * 78.54);
    c = mix(c, vec3f(0.01 + 0.03 * slats * (1.0 - smoothstep(0.01, 0.03, p.fw))), tRect(g.x, p.x, 0.25, -0.2, 0.2, p.fw, p.fa));
  }
  return c;
}

// A railway's floor: its ballast, or the concrete a slab track is laid on (its tracks are their beds, T_BED).
fn tRailFloor(p : TPx, across : f32, grain : f32) -> vec3f {
  let slab = (tube.flags & LOOK_SLAB) != 0u;
  let ballast = T_BALLAST * (1.0 + 0.9 * (tNoise(vec2f(p.s, across) * 22.0) - 0.5) + 0.4 * grain);
  return select(ballast, T_CONCRETE * 0.9 * (1.0 + 0.2 * grain), slab);
}

// A track's bed (5.17q, his words on 5.17p: "if a railways is entering a tunnel or near to it, it extends them in the
// tunnel, try to make it so that they never touch the walls or sidewalks"): its sleepers or a slab track's blocks,
// clips and rails' shadows drawn across its own middle (tunnel.c lays it where the track runs; 5.17p drew the tracks
// from the data's lines, whose straight stretches between nodes stood off a curved tube's and crossed at junctions).
fn tBed(in : VSOut, p : TPx, grain : f32) -> vec3f {
  let slab = (tube.flags & LOOK_SLAB) != 0u;
  var px : RoadPixel;
  px.dxm = vec2f(p.fw, 0.0);
  px.on = VT_IN_TUNNEL | select(0u, VT_SLAB, slab);
  var g : RoadGroup;
  g.across = in.bed;
  g.along = p.s;
  g.tangent = vec2f(1.0, 0.0);
  let gauge = select(0.7175, 0.5, (tube.flags & LOOK_NARROW) != 0u);
  return vtTrack(px, g, tRailFloor(p, in.ah.x, grain), gauge, p.fa);
}

fn tFloor(in : VSOut, p : TPx, dmx : vec2f, dmy : vec2f, grain : f32) -> vec3f {
  if (tube.look == LOOK_RAIL) { return tRailFloor(p, in.ah.x, grain); }
  if (tube.look == LOOK_FOOT) { return tFootFloor(p, grain); }
  if (tube.look == LOOK_ROCK) {
    return vectorRoads(in.merc, dmx, dmy, VT_GRAVEL_RGB * (1.0 + 0.5 * grain), vec2f(1.0, 0.0), vec4f(0.0), VT_IN_TUNNEL);
  }
  // A road tunnel's floor between its kerbs is its road: asphalt, its aggregate's grain (5.17p: the data's lines kink).
  let q = vec2f(p.s, in.ah.x);
  let asphalt = VT_ASPHALT_RGB * (1.0 + 0.3 * grain + 0.35 * (tNoise(q * 14.0) - 0.5) + 0.2 * smoothstep(0.42, 0.5, tNoise(q * 31.0 + 7.0)));
  return tDrains(p, tRoadMarks(p, asphalt, grain));
}

fn tWalkway(p : TPx, n : vec3f, up : vec3f, grain : f32) -> vec3f {
  let top = dot(n, up) > 0.7;
  var c = T_CONCRETE * select(1.0, 1.2, top) * (1.0 + 0.25 * grain);
  // A railway's cable troughs under lids a metre long.
  if (top && tube.look == LOOK_RAIL) { c *= 1.0 - 0.5 * vtBand(p.s - round(p.s), 0.01, p.fw); }
  return c;
}

fn tFixture(n : vec3f, up : vec3f, grain : f32) -> TSurf {
  // A conductor rail's aluminium and the copper contact wire under it; a jet fan's casing.
  var o = tPlain(select(T_FAN, select(T_ALU, T_COPPER, dot(n, up) < -0.7), tube.look == LOOK_RAIL) * (1.0 + 0.1 * grain));
  o.shine = 24.0;
  o.ks = 0.35;
  return o;
}

// A rail (5.17o): its head polished bright by the wheels, its sides rust brown; a drop arm's insulator, glazed.
fn tRail(n : vec3f, up : vec3f, grain : f32) -> TSurf {
  let head = dot(n, up) > 0.7;
  var o = tPlain(select(T_RUST * 0.9, T_STEEL * 1.35, head) * (1.0 + 0.15 * grain));
  o.shine = select(8.0, 48.0, head);
  o.ks = select(0.05, 0.7, head);
  return o;
}

fn tSurface(in : VSOut, p : TPx, dmx : vec2f, dmy : vec2f, n : vec3f) -> TSurf {
  let q = vec2f(p.s, in.ah.x + in.ah.y);
  let grain = 0.5 * (tNoise(q * 2.7) - 0.5) + 0.3 * (tNoise(q * 0.6) - 0.5) + 0.2 * (tNoise(q * 9.0) - 0.5);
  let m = in.material;
  let up = localUp(in.world);
  if (m == T_FIXTURE) { return tFixture(n, up, grain); }
  if (m == T_RAIL) { return tRail(n, up, grain); }
  if (m == T_BED) { return tPlain(tBed(in, p, grain)); }
  // A luminaire's housing's diffuser (tunnel.c, 5.17p): the lamp's own light.
  if (m == T_LAMP) { var o = tPlain(vec3f(0.05)); o.glow = tube.lampColour * 0.35; return o; }
  if (m == T_INSULATOR) { var o = tPlain(vec3f(0.32, 0.17, 0.08) * (1.0 + 0.1 * grain)); o.shine = 30.0; o.ks = 0.25; return o; }
  if (m == T_FLOOR) { return tPlain(tFloor(in, p, dmx, dmy, grain)); }
  if (m == T_WALKWAY) { return tPlain(tWalkway(p, n, up, grain)); }
  if (m == T_CEILING) { return tPlain(tCeiling(p, grain)); }
  if (tube.look == LOOK_ROAD) { return tRoadWall(p, grain); }
  if (tube.look == LOOK_RAIL) { return tRailWall(p, grain); }
  if (tube.look == LOOK_FOOT) { return tFootWall(p, grain); }
  return tRock(p);
}

// The collar round a portal, out in the open: an older railway tunnel's masonry, else board-marked concrete (the
// formwork's boards, 20 cm, left in it); a path's rock.
fn tCollar(in : VSOut, p : TPx) -> vec3f {
  let q = vec2f(in.along, in.ah.x + in.ah.y);
  let grain = 0.5 * (tNoise(q * 2.7) - 0.5) + 0.3 * (tNoise(q * 0.6) - 0.5);
  let u = in.ah.x + in.along;
  let v = in.ah.y;
  if (tube.look == LOOK_RAIL && (tube.flags & LOOK_MASONRY) != 0u) {
    let b = tBlocks(u, v, vec2f(0.7, 0.4), p.fa, p.fa);
    let stone = T_STONE * (0.75 + 0.5 * b.y) * (1.0 + 0.25 * grain);
    return mix(stone, stone * 0.55, b.x);
  }
  if (tube.look == LOOK_ROCK) { return tRock(p).albedo * 1.4; }
  return T_CONCRETE * 1.2 * (1.0 + 0.15 * grain) * (1.0 - 0.15 * vtBand(v - round(v / 0.2) * 0.2, 0.004, p.fa));
}

// The light of the three lamps nearest along on a surface facing `n`: what it scatters, and a highlight of each
// (Blinn-Phong, exponent `shine`; none where 0).
struct TLit {
  diffuse : vec3f,
  glint   : vec3f,
  near    : f32,     // m² to the nearest lamp
};

fn tLamps(in : VSOut, n : vec3f, shine : f32) -> TLit {
  var lit : TLit;
  lit.diffuse = vec3f(0.0);
  lit.glint = vec3f(0.0);
  lit.near = 1e6;
  if (tube.lampStep <= 0.0) { return lit; }
  let up = localUp(in.world);
  let way = normalize(in.way);
  let right = normalize(cross(way, up));
  let j = round(in.along / tube.lampStep);
  let across = right * (in.lamp.x - in.ah.x) + up * (in.lamp.y - in.ah.y);
  let v = -normalize(in.world);
  for (var k = -1; k <= 1; k++) {
    let d = way * ((j + f32(k)) * tube.lampStep - in.along) + across;
    lit.near = min(lit.near, dot(d, d));
    let d2 = max(dot(d, d), 0.25);
    let l = d * inverseSqrt(d2);
    let e = tube.lampColour * max(dot(n, l), 0.0) / d2;
    lit.diffuse += e;
    if (shine > 0.0) { lit.glint += e * pow(max(dot(n, normalize(l + v)), 0.0), shine); }
  }
  return lit;
}

// The daylight at the portals: as level ground outside at the mouth, falling off inwards.
fn tDaylight(in : VSOut, n : vec3f) -> vec3f {
  let d0 = max(in.along - tube.portals.x, 0.0);
  let d1 = max(tube.portals.y - in.along, 0.0);
  let fall = 0.55 * (exp(-d0 / 18.0) + exp(-d1 / 18.0)) + 0.08 * (exp(-d0 / 90.0) + exp(-d1 / 90.0));
  // Surfaces facing up and the mouth catch more of it than the vault.
  let up = localUp(in.world);
  return light.level.rgb * fall * (0.6 + 0.4 * max(dot(n, up), 0.0));
}

// A luminaire itself, where it hangs: a bright strip `lampSize` long. `fw`,
// `fa`: metres a pixel spans along and across.
fn tLuminaire(in : VSOut, fw : f32, fa : f32) -> vec3f {
  if (tube.lampStep <= 0.0 || (in.material != T_VAULT && in.material != T_CEILING && in.material != T_WALL)) { return vec3f(0.0); }
  let u = in.along - round(in.along / tube.lampStep) * tube.lampStep;
  let along = vtBand(abs(u), 0.5 * tube.lampSize, fw);
  let across = vtBand(length(in.ah - in.lamp), 0.12, fa);
  return tube.lampColour * 0.35 * along * across;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is still uniform.
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let fw = max(fwidth(in.along), 1e-3);
  let fa = max(fwidth(in.ah.x) + fwidth(in.ah.y), 1e-3);
  return tShade(in, dmx, dmy, fw, fa);
}

// Where tubes run into each other (5.17m: a branch, carriageways or tracks joining, two tubes side by side becoming
// one), each mesh is whole, walls, floor and vault, and stood inside the other's room: a wall across the way into a
// branch, fins of the other's walls in the curve where they part. For a mesh other bores reach into (passes/tunnels.js
// gives it their pieces, bore.wgsl cutSlot): what of it lies inside one of them is left out, and the two are one room.
// Since 5.17n the pieces are the other's room exactly (bore.wgsl cutAt: the walkways beside its floor, a bored tube's
// lower half; 5.17m's claimed the room over the walkways too, and the walls left out there opened slits to the sky by
// Giubiasco), so only MEET_IN metres within it (more than cuts.js thin() leaves a bore off its mesh, 5 cm; where two
// cross, a hand's width of each stands past the other, the edge of the opening) and its arch MEET_FIT of its size (the
// mesh's arch is a polygon inside the ellipse). Walls, vault, ceilings and kerbs: from over the other's floor (or its
// walkways' top beside it): from MEET_UNDER under it where the two floors lie within MEET_TIE of one height, else from
// MEET_OVER over it (a branch higher than the tube it opens into: what of this one lies under the branch's floor stays,
// and no slit opens between them). What is walked on (floors, walkways' tops: `onTop`) from MEET_TIE over it: where two
// lie at one height both stay, and the higher of two goes only where the other's room is under it (a walkway running
// on into the other tube stops at its edge). Floors stay: a branch's floor runs on into the room it opens into, at one
// height with that one's where they meet, and where they part the higher shows (left out, the lower would show
// through as a trench). `own`: the point's height over this tube's own floor (its cross-section's, tunnel.c).
const MEET_IN : f32 = 0.1;
const MEET_FIT : f32 = 0.99;
const MEET_UNDER : f32 = 0.08;
const MEET_TIE : f32 = 0.05;
const MEET_OVER : f32 = 0.02;

fn inMeets(rel : vec3f, own : f32, onTop : bool, grow : f32) -> bool {
  let q = slotPoint(rel);
  if (q.w == 0.0) { return false; }
  let last = min(cutSlot.count, CUT_MOST);
  for (var i = 0u; i < last; i++) {
    let r = cutAt(cutSlot.list[i], q.xyz, grow, MEET_FIT);
    if (r.y == 0.0) { continue; }
    let under = select(select(-MEET_OVER, MEET_UNDER, abs(own - r.x) <= MEET_TIE), -MEET_TIE, onTop);
    if (r.x >= -under) { return true; }
  }
  return false;
}

// Whether a pixel lies in the room of a tube this one opens into (its JOIN end there: cuts.js marks those pieces, their
// low.w under 0), from 1.2 m under the top of what is walked on there up (under a walkway's top too: a branch's track
// ran on beside the switch under the other's walkway, live by Giubiasco): where a branch's tracks give way (5.17q).
fn inMain(rel : vec3f) -> bool {
  let q = slotPoint(rel);
  if (q.w == 0.0) { return false; }
  let last = min(cutSlot.count, CUT_MOST);
  var found = false;
  for (var i = 0u; i < last; i++) {
    let c = cutSlot.list[i];
    if (c.low.w >= 0.0) { continue; }
    let r = cutAt(c, q.xyz, -MEET_IN, MEET_FIT);
    found = found || (r.y > 0.0 && r.x > -1.2);
  }
  return found;
}

// Whether a floor's pixel lies in another bore's room, at its floor's height or over it: a junction, where each
// tube's markings would cross the other's.
fn onOther(rel : vec3f) -> bool {
  let q = slotPoint(rel);
  if (q.w == 0.0) { return false; }
  let last = min(cutSlot.count, CUT_MOST);
  var found = false;
  for (var i = 0u; i < last; i++) {
    let r = cutAt(cutSlot.list[i], q.xyz, 0.3, 1.0);
    found = found || (r.y > 0.0 && r.x > -0.3);
  }
  return found;
}

@fragment
fn fsMeet(in : VSOut) -> @location(0) vec4f {
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let fw = max(fwidth(in.along), 1e-3);
  let fa = max(fwidth(in.ah.x) + fwidth(in.ah.y), 1e-3);
  let onTop = in.material == T_WALKWAY && dot(normalize(in.normal), localUp(in.world)) > 0.7;
  // A railway's tracks (beds and rails) give way only in the tube a branch opens into (5.17q: there that tube's own
  // tracks run on to the switch; elsewhere a track inside the other's room is where its line runs). Its fittings on
  // the walls and in the vault (handrails, the overhead line) go with the walls.
  let track = in.material == T_BED || in.material == T_RAIL;
  if (track) {
    if (inMain(in.rel)) { discard; }
  } else if (in.material != T_FLOOR && inMeets(in.rel, in.ah.y, onTop, select(-MEET_IN, MEET_FITTING, in.material == T_FIXTURE || in.material == T_INSULATOR))) { discard; }
  tNoMarks = in.material == T_FLOOR && onOther(in.rel);
  return tShade(in, dmx, dmy, fw, fa);
}

fn tShade(in : VSOut, dmx : vec2f, dmy : vec2f, fw : f32, fa : f32) -> vec4f {
  let n = normalize(in.normal);
  let p = tPixel(in, fw, fa);
  var colour : vec3f;
  if (in.material == T_DARK) {
    // Far down the tube, beyond what is built: the dark a tunnel goes to (and a jet fan's duct).
    colour = vec3f(0.002);
  } else if (in.material == T_COLLAR) {
    colour = tCollar(in, p) * modelledLight(n);
  } else {
    let s = tSurface(in, p, dmx, dmy, n);
    let lit = tLamps(in, n, s.shine);
    // (And the lamps' light thrown back by the floor and the walls: no face in a lit tunnel is black, 5.17p; a
    // luminaire's housing beside its lamp, what its glass spills and the bright vault round it throws back: else its
    // sides black against the glow, as live.)
    let spill = tube.lampColour * select(0.0, 0.3 * exp(-lit.near / 0.5), in.material == T_FIXTURE);
    colour = s.albedo * ((lit.diffuse + spill + vec3f(0.003) + tube.lampColour * 0.004) * tube.interior + tDaylight(in, n)) +
      (s.ks * lit.glint + s.glow + tLuminaire(in, fw, fa)) * tube.interior;
  }
  if (tube.inside < 0.5) { colour = applyAtmosphere(colour, in.world, in.clip.xy); }
  return present(colour, in.clip.xy);
}
