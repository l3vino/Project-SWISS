// buildings.wgsl — 3D buildings. Joined after common.wgsl, frame.wgsl and
// imagery.wgsl.
//
// Twelve bytes a vertex: a position quantised into the tile's box in a local
// east-north-up frame, the height of the vertex above its building's lowest
// point, which building it belongs to, and the facing of the wall the vertex
// starts (see wasm/src/mesh.c). No normals are stored: every face of a
// building is flat, so the face normal comes from the screen-space
// derivatives of the position, exact per facet and free in memory. Only the
// direction windows run along needs more than that: derivatives wobble by a
// hair from pixel to pixel, and a hair times a few hundred metres from the
// tile's origin is a window edge that crawls.
//
// Each building has eight bytes of its own in a shared buffer (see
// js/engine/features/appearance.js): the colour of its walls, what they are
// made of, what its base is, the kind of openings it has, whether its windows
// have shutters and painted surrounds, where its eaves are and how far its
// roof overhangs them.
//
// Roofs take their colour from the aerial photograph projected straight down:
// the photo already shows every roof, with its tiles, its dormers and its
// solar panels. Walls are drawn here, so they cost no download and stay sharp
// however close you walk: the material from a small texture array made at
// start-up (materials.wgsl), coloured per building, with its relief lit by the
// sun; windows with frames, sills, surrounds, recessed glass reflecting the
// sky and, on some houses, open shutters; a plinth or a whole ground storey of
// another material; the shadow of the eaves. Every feature is box-filtered
// against the pixel's footprint, so detail fades to its average with distance
// instead of shimmering.

const KIND_GLASS : u32 = 2u;

const NO_BASE : u32 = 15u;

// Materials, in the order of the texture array's layers.
const M_PLASTER   : u32 = 0u;
const M_ROUGHCAST : u32 = 1u;
const M_RUBBLE    : u32 = 2u;
const M_ASHLAR    : u32 = 3u;
const M_BRICK     : u32 = 4u;
const M_BOARDS    : u32 = 5u;
const M_LOGS      : u32 = 6u;
const M_CONCRETE  : u32 = 7u;
const M_METAL     : u32 = 8u;

// Metres of wall each layer covers, along and up. Matches materials.wgsl.
const MATERIAL_SIZE = array<vec2f, 9>(
  vec2f(2.0, 2.0), vec2f(2.0, 2.0), vec2f(2.4, 2.4), vec2f(3.0, 1.8), vec2f(1.25, 1.2),
  vec2f(2.0, 2.0), vec2f(2.0, 1.8), vec2f(3.0, 3.0), vec2f(2.0, 2.0));

// Openings.
const O_NONE        : u32 = 0u;
const O_RESIDENTIAL : u32 = 1u;
const O_OFFICE      : u32 = 2u;
const O_INDUSTRIAL  : u32 = 3u;
const O_SACRED      : u32 = 4u;
const O_BARN        : u32 = 5u;
const O_HISTORIC    : u32 = 6u;
const O_CHALET      : u32 = 7u;

struct Block {
  originRel   : vec3f,   // tile frame origin minus the camera, metres
  depth       : f32,     // depth in the tileset, for the debug view
  east        : vec3f,   // the tile frame's axes, earth-centred
  featureBase : u32,     // where this tile's buildings start in `features`
  north       : vec3f,
  _p2         : f32,
  up          : vec3f,
  _p3         : f32,
  boxMin      : vec3f,   // the box positions are quantised into, local metres
  _p4         : f32,
  boxSize     : vec3f,
  _p5         : f32,
  merc        : vec4f,   // frame origin on the imagery grid from its anchor (x, y); px per metre east; px per metre north
  mercCurve   : vec4f,   // growth of the east scale per metre north; px per square metre north; parallel's curve; unused
};

@group(1) @binding(0) var<uniform> block : Block;
@group(1) @binding(1) var<storage, read> features : array<vec2u>;
@group(1) @binding(2) var materialTex : texture_2d_array<f32>;
@group(1) @binding(3) var materialSampler : sampler;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,    // relative to the camera
  @location(1) local : vec3f,    // in the tile frame, metres
  @location(2) base  : f32,      // metres above the building's lowest point
  @location(3) merc  : vec2f,    // imagery reference pixels from the anchor
  @location(4) @interpolate(flat) record : vec2u,
  @location(5) @interpolate(flat) facet : u32,
};

@vertex
fn vs(@location(0) q : vec4f, @location(1) info : vec2u) -> VSOut {
  var out : VSOut;
  let local = block.boxMin + q.xyz * block.boxSize;
  out.world = block.originRel + block.east * local.x + block.north * local.y + block.up * local.z;
  out.clip = frame.viewProj * vec4f(out.world, 1.0);
  out.local = local;
  out.base = q.w * 655.35;
  // Web Mercator around the frame origin, to second order: well under a
  // reference pixel across a tile. North is measured from the curved
  // parallel, not the flat frame, which drops away from it to the east.
  let n = local.y - block.mercCurve.z * local.x * local.x;
  out.merc = vec2f(block.merc.x + local.x * block.merc.z * (1.0 + block.mercCurve.x * n),
                   block.merc.y + n * (block.merc.w + block.mercCurve.y * n));
  // Read once per vertex, not per pixel: every corner of a triangle belongs
  // to the same building.
  out.record = features[block.featureBase + info.x];
  out.facet = info.y;
  return out;
}

// ---- one building ----

struct Building {
  colour     : vec3f,   // walls, linear light
  kind       : u32,
  material   : u32,
  eaves      : f32,     // metres above the base
  overhang   : f32,     // metres
  base       : u32,     // material of the plinth or ground storey, or NO_BASE
  openings   : u32,
  shutters   : bool,
  surrounds  : bool,
  baseStorey : bool,    // the base material rises a whole storey, not a plinth
  seed       : u32,
};

fn srgbToLinear(c : vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn unpack(r : vec2u) -> Building {
  var b : Building;
  b.colour = srgbToLinear(vec3f(f32(r.x & 255u), f32((r.x >> 8u) & 255u), f32((r.x >> 16u) & 255u)) / 255.0);
  b.kind = (r.x >> 24u) & 15u;
  b.material = min(r.x >> 28u, 8u);
  b.eaves = f32(r.y & 2047u) * 0.1;
  b.overhang = f32((r.y >> 11u) & 7u) * 0.25;
  b.base = (r.y >> 14u) & 15u;
  b.openings = (r.y >> 18u) & 7u;
  b.shutters = ((r.y >> 21u) & 1u) == 1u;
  b.surrounds = ((r.y >> 22u) & 1u) == 1u;
  b.baseStorey = ((r.y >> 23u) & 1u) == 1u;
  b.seed = r.y >> 24u;
  return b;
}

// The horizontal direction along a wall, from its facing stored as a
// diamond angle (0..2 over the half-plane of directions).
fn facetAlong(code : u32) -> vec2f {
  let d = f32(code) * (4.0 / 65536.0);
  let n = select(vec2f(1.0 - d, 2.0 - d), vec2f(1.0 - d, d), d < 1.0);
  let f = normalize(n);
  return vec2f(-f.y, f.x);
}

// ---- filtering ----

// How much of a pixel footprint `w` wide, centred on x, falls inside the
// repeating band [lo, hi) of each unit interval. The exact box filter of a
// window grid: sharp up close, its average coverage far away.
fn band(x : f32, lo : f32, hi : f32, w : f32) -> f32 {
  let width = max(w, 1e-4);
  return (bandIntegral(x + 0.5 * width, lo, hi) - bandIntegral(x - 0.5 * width, lo, hi)) / width;
}

fn bandIntegral(x : f32, lo : f32, hi : f32) -> f32 {
  return floor(x) * (hi - lo) + clamp(fract(x) - lo, 0.0, hi - lo);
}

// The same for a single interval [lo, hi], not repeating.
fn span(x : f32, lo : f32, hi : f32, w : f32) -> f32 {
  let width = max(w, 1e-4);
  return (clamp(x + 0.5 * width, lo, hi) - clamp(x - 0.5 * width, lo, hi)) / width;
}

// ---- hashing ----

fn hashU(x : u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

// A number in [0, 1) that depends on a building and on what it is for.
fn pick(seed : u32, salt : u32) -> f32 {
  return f32(hashU(seed * 0x9e3779b9u + salt * 0x85ebca6bu) >> 8u) / 16777216.0;
}

fn cellHash(c : vec2f, seed : u32) -> f32 {
  let i = vec2i(floor(c));
  return f32(hashU((u32(i.x) * 0x8da6b343u) ^ (u32(i.y) * 0xd8163841u) ^ seed) >> 8u) / 16777216.0;
}

// ---- palettes, linear light ----

// Shutters: bottle green, brown, grey, off-white, oxblood, Ticino green.
fn shutterPaint(i : u32) -> vec3f {
  var colours = array<vec3f, 6>(
    vec3f(0.035, 0.085, 0.050), vec3f(0.100, 0.050, 0.025), vec3f(0.180, 0.190, 0.190),
    vec3f(0.520, 0.500, 0.450), vec3f(0.130, 0.035, 0.025), vec3f(0.050, 0.120, 0.070));
  return colours[i % 6u];
}

// Window frames: white, light grey, stained wood, anthracite.
fn framePaint(i : u32) -> vec3f {
  var colours = array<vec3f, 4>(
    vec3f(0.70, 0.70, 0.68), vec3f(0.40, 0.41, 0.41), vec3f(0.090, 0.050, 0.030), vec3f(0.040, 0.045, 0.050));
  return colours[i % 4u];
}

// A material's own colour where it is not the building's main one: the stone
// of a plinth, the render of a chalet's ground floor.
fn baseColour(m : u32, seed : u32) -> vec3f {
  let k = mix(0.9, 1.1, pick(seed, 40u));
  switch m {
    case 0u, 1u: { return vec3f(0.62, 0.60, 0.55) * k; }          // whitewashed render
    case 2u: { return vec3f(0.26, 0.25, 0.23) * k; }              // field stone
    case 3u: { return vec3f(0.30, 0.29, 0.27) * k; }              // granite or sandstone
    case 4u: { return vec3f(0.30, 0.10, 0.06) * k; }              // brick
    case 5u, 6u: { return vec3f(0.10, 0.055, 0.03) * k; }          // larch
    case 7u: { return vec3f(0.32, 0.31, 0.29) * k; }              // concrete
    default: { return vec3f(0.35, 0.36, 0.37) * k; }              // metal
  }
}

// What the joints are filled with: mortar between stone and brick, shadow
// between boards and logs, a dark hole in concrete.
fn jointColour(m : u32) -> vec3f {
  switch m {
    case 2u, 3u: { return vec3f(0.36, 0.34, 0.30); }
    case 4u: { return vec3f(0.42, 0.40, 0.36); }
    case 5u, 6u: { return vec3f(0.012, 0.009, 0.007); }
    default: { return vec3f(0.05, 0.05, 0.05); }
  }
}

// ---- materials ----

struct MaterialSample {
  colour : vec3f,
  joint  : f32,
  slope  : vec2f,   // of the surface, along the wall and up it
};

// The material at (u, v) metres, filtered over the pixel's footprint. The
// gradients are passed in because which material a pixel shows depends on the
// building, and implicit derivatives need the same code path for the whole
// quad of pixels around it.
fn material(m : u32, colour : vec3f, u : f32, v : f32, gx : vec2f, gy : vec2f) -> MaterialSample {
  let size = MATERIAL_SIZE[m];
  let uv = vec2f(u, -v) / size;
  let t = textureSampleGrad(materialTex, materialSampler, uv, i32(m), vec2f(gx.x, -gx.y) / size, vec2f(gy.x, -gy.y) / size);
  var s : MaterialSample;
  s.joint = t.g;
  s.colour = mix(colour * (t.r * 2.0), jointColour(m), t.g);
  s.slope = (t.ba * 2.0 - 1.0) * 2.0;
  return s;
}

// ---- surfaces ----

// What a wall looks like: a diffuse colour lit like everything else, a
// reflection added on top, which is not, the normal its relief gives it, and
// how much of the sun and the sky reach it.
struct Surface {
  albedo   : vec3f,
  specular : vec3f,
  normal   : vec3f,
  sun      : f32,
  sky      : f32,
};

// How a building's openings are laid out: bays across, storeys up, and where
// in its cell a window sits.
struct Openings {
  bay      : f32,   // window to window, metres
  storey   : f32,   // floor to floor
  ground   : f32,   // the ground storey's own height
  width    : f32,   // window width, fraction of a bay
  sill     : f32,   // bottom and top of the glass, fractions of a storey
  top      : f32,
  presence : f32,   // chance a cell has a window at all
  frame    : f32,   // frame width, metres
  sills    : bool,
  eavesCap : bool,  // no windows in the gable above the eaves
};

fn openingsOf(b : Building) -> Openings {
  let s = b.seed;
  var o = Openings(2.8, 3.0, 3.0, 0.42, 0.3, 0.76, 1.0, 0.075, true, false);
  switch b.openings {
    case 2u: {   // office: ribbons of glass between spandrels
      o.bay = mix(1.25, 1.5, pick(s, 1u));
      o.storey = mix(3.4, 3.9, pick(s, 2u));
      o.ground = o.storey * 1.2;
      o.width = 0.93;
      o.sill = mix(0.24, 0.3, pick(s, 9u));
      o.top = mix(0.84, 0.9, pick(s, 10u));
      o.frame = 0.05;
      o.sills = false;
      o.eavesCap = true;
    }
    case 3u: {   // industrial: a high band of windows
      o.bay = mix(4.5, 6.0, pick(s, 1u));
      o.storey = mix(5.5, 7.0, pick(s, 2u));
      o.ground = o.storey;
      o.width = mix(0.6, 0.8, pick(s, 8u));
      o.sill = 0.6;
      o.top = 0.8;
      o.presence = 0.85;
      o.frame = 0.06;
      o.sills = false;
      o.eavesCap = true;
    }
    case 4u: {   // church or chapel: tall and few
      o.bay = mix(4.5, 6.0, pick(s, 1u));
      o.storey = 12.0;
      o.ground = 12.0;
      o.width = 0.24;
      o.sill = 0.2;
      o.top = 0.6;
      o.frame = 0.09;
      o.eavesCap = true;
    }
    case 5u: {   // barn: small openings in the base, none in the boarding
      o.bay = mix(3.0, 4.0, pick(s, 1u));
      o.storey = 2.6;
      o.ground = 2.6;
      o.width = mix(0.18, 0.24, pick(s, 8u));
      o.sill = 0.45;
      o.top = 0.75;
      o.presence = 0.6;
      o.eavesCap = true;
    }
    case 6u: {   // old stone: small windows, irregular
      o.bay = mix(3.0, 4.0, pick(s, 1u));
      o.storey = mix(3.1, 3.6, pick(s, 2u));
      o.ground = o.storey;
      o.width = mix(0.22, 0.3, pick(s, 8u));
      o.sill = 0.36;
      o.top = 0.64;
      o.presence = 0.55;
      o.frame = 0.06;
    }
    case 7u: {   // chalet: small windows close together
      o.bay = mix(2.1, 2.7, pick(s, 1u));
      o.storey = mix(2.45, 2.7, pick(s, 2u));
      o.ground = o.storey;
      o.width = mix(0.34, 0.42, pick(s, 8u));
      o.sill = 0.33;
      o.top = 0.7;
      o.presence = 0.92;
      o.frame = 0.07;
    }
    default: {   // houses and flats
      o.bay = mix(2.3, 3.4, pick(s, 1u));
      o.storey = mix(2.75, 3.25, pick(s, 2u));
      o.ground = o.storey * mix(1.0, 1.25, pick(s, 3u));
      o.width = select(mix(0.36, 0.48, pick(s, 8u)), mix(0.30, 0.40, pick(s, 8u)), b.shutters);
      o.sill = mix(0.28, 0.33, pick(s, 9u));
      o.top = o.sill + mix(0.42, 0.50, pick(s, 10u));
    }
  }
  return o;
}

// A wall seen through one pixel. `u` runs along the wall and `v` up from the
// building's base, both in metres; gx and gy are their changes to the next
// pixel across and down, du and dv the footprint.
fn facade(b : Building, u : f32, v : f32, gx : vec2f, gy : vec2f, du : f32, dv : f32,
          n : vec3f, along : vec3f, up : vec3f, toEye : vec3f) -> Surface {
  let o = openingsOf(b);
  let plinth = mix(0.25, 0.7, pick(b.seed, 4u));
  let hasBase = b.base != NO_BASE;
  let baseTop = select(plinth, o.ground, b.baseStorey);

  // ---- the material: the wall's own, or the base's below baseTop ----
  let inBase = hasBase && v < baseTop;
  let m = select(b.material, b.base, inBase);
  let body = select(b.colour, baseColour(b.base, b.seed), inBase);
  let mat = material(m, body, u, v, gx, gy);
  var wall = mat.colour;
  // A clean line where the base meets the wall, filtered like everything else.
  if (hasBase) {
    let edge = span(v, baseTop - 0.04, baseTop, dv);
    wall *= 1.0 - 0.35 * edge;
  }

  // ---- openings ----
  let inGround = v < o.ground;
  let period = select(o.storey, o.ground, inGround);
  let x = u / o.bay;
  let y = select((v - o.ground) / o.storey, v / o.ground, inGround);
  let wx = du / o.bay;
  let wy = dv / period;

  let g0 = 0.5 - 0.5 * o.width;
  let g1 = 0.5 + 0.5 * o.width;
  let fx = o.frame / o.bay;
  let fy = o.frame / period;
  let sx = 0.05 / o.bay;                      // sill overhang to each side
  let sh = 0.06 / period;                     // sill thickness
  let rx = 0.14 / o.bay;                      // painted surround
  let ry = 0.14 / period;
  let leaf = 0.5 * o.width;                   // one shutter leaf, folded open

  let glassX = band(x, g0, g1, wx);
  let glassY = band(y, o.sill, o.top, wy);
  let openX = band(x, g0 - fx, g1 + fx, wx);
  let openY = band(y, o.sill - fy, o.top + fy, wy);
  let sillX = band(x, g0 - fx - sx, g1 + fx + sx, wx);
  let sillY = band(y, o.sill - fy - sh, o.sill - fy, wy);
  let lintel = band(y, o.top - 0.14 / period, o.top, wy);
  let stainY = band(y, o.sill - fy - sh - 0.9 / period, o.sill - fy - sh, wy);

  // Which cells have a window: all of them on most buildings; on barns and
  // old stone houses, some.
  let cell = vec2f(floor(x), floor(y) + select(0.0, 1000.0, inGround));
  let near = 1.0 - smoothstep(0.25, 0.6, max(wx, wy));
  let present = mix(o.presence, select(0.0, 1.0, cellHash(cell, b.seed + 57u) < o.presence), near);

  // Where there are no openings: none drawn at all, none in a barn's
  // boarding, none in the plinth, none above the eaves where the style says.
  var allowed = select(1.0, 0.0, b.openings == O_NONE);
  if (b.openings == O_BARN && !inBase) { allowed = 0.0; }
  allowed *= 1.0 - span(v, -100.0, plinth + 0.15, dv);
  if (o.eavesCap) { allowed *= 1.0 - span(v, b.eaves - 0.4, 1e4, dv); }
  let open = allowed * present;

  var glass = glassX * glassY * open;
  var frameCover = max(openX * openY - glassX * glassY, 0.0) * open;
  var sill = select(0.0, sillX * sillY, o.sills) * open;
  var leaves = 0.0;
  if (b.shutters) {
    leaves = (band(x, g0 - fx - leaf, g0 - fx, wx) + band(x, g1 + fx, g1 + fx + leaf, wx)) * openY * open;
  }
  var surround = 0.0;
  if (b.surrounds) {
    let outer = band(x, g0 - fx - rx, g1 + fx + rx, wx) * band(y, o.sill - fy - ry, o.top + fy + ry, wy);
    surround = max(outer - openX * openY, 0.0) * open * (1.0 - leaves);
  }

  // A shopfront, now and then, across a house's ground floor.
  if (b.openings == O_RESIDENTIAL && pick(b.seed, 6u) < 0.12) {
    let shopX = band(x, 0.08, 0.92, wx);
    let shopY = span(v, plinth + 0.1, o.ground - 0.45, dv);
    let shopFrame = band(x, 0.06, 0.94, wx) * span(v, plinth, o.ground - 0.35, dv);
    let g = select(0.0, 1.0, inGround);
    glass = mix(glass, shopX * shopY, g);
    frameCover = mix(frameCover, max(shopFrame - shopX * shopY, 0.0), g);
    sill *= 1.0 - g; leaves *= 1.0 - g; surround *= 1.0 - g;
  }

  // Rain runs off each sill and stains the render below it.
  if (m == M_PLASTER || m == M_ROUGHCAST) {
    let streak = stainY * band(x, g0 + 0.05, g1 - 0.05, wx) * open;
    wall *= 1.0 - 0.18 * streak;
  }
  // Splash-back and grime along the foot of the wall.
  wall *= mix(0.8, 1.0, smoothstep(0.0, 1.2, v));

  // ---- joinery ----
  let frameColour = select(framePaint(hashU(b.seed + 12u)), vec3f(0.10, 0.10, 0.11), b.openings == O_OFFICE);
  let surroundColour = select(vec3f(0.66, 0.65, 0.62), vec3f(0.42, 0.41, 0.39), pick(b.seed, 14u) < 0.35);
  let slats = mix(0.72, 1.0, band(v / 0.06, 0.0, 0.65, dv / 0.06));
  wall = mix(wall, surroundColour, surround);
  wall = mix(wall, shutterPaint(hashU(b.seed + 13u)) * slats, leaves);
  wall = mix(wall, frameColour, frameCover);
  wall = mix(wall, vec3f(0.45, 0.44, 0.41), sill);
  // The sill's shadow on the wall just below it.
  wall *= 1.0 - 0.35 * sillX * band(y, o.sill - fy - sh - 0.05 / period, o.sill - fy - sh, wy) * select(0.0, 1.0, o.sills) * open;

  // ---- glass ----
  // Dark interiors, some with curtains, each window its own; far away, where
  // one window is a pixel or less, their average instead of a flicker.
  let lit = cellHash(cell, b.seed + 31u);
  let interior = mix(vec3f(0.035, 0.034, 0.032),
                     mix(vec3f(0.018, 0.017, 0.016), vec3f(0.20, 0.18, 0.14), step(0.72, lit)), near)
               * (1.0 - 0.6 * lintel);
  // Double glazing: four faces of glass reflect about a tenth of the light
  // head on, and nearly all of it at a glancing angle.
  let facing = clamp(dot(n, toEye), 0.0, 1.0);
  let fresnel = 0.1 + 0.9 * pow(1.0 - facing, 5.0);
  let mirror = skyReflection(reflect(-toEye, n), up) * (1.0 - 0.5 * lintel);

  // ---- light ----
  // The material's relief tilts the normal; the openings are flat.
  let flat = clamp(glass + frameCover + sill + leaves + surround, 0.0, 1.0);
  let slope = mat.slope * (1.0 - flat);
  let bent = normalize(n - slope.x * along - slope.y * up);
  // Under the eaves: the roof hides part of the sky, and the sun is cut off
  // for as far down the wall as the overhang's shadow reaches.
  let below = b.eaves - v;
  var sun = 1.0;
  var sky = mix(0.62, 1.0, smoothstep(0.0, 2.5, v));        // ground contact
  if (below > 0.0 && b.overhang > 0.0) {
    sky *= 1.0 - 0.45 * exp(-below / (0.2 + 0.6 * b.overhang));
    let sunUp = dot(frame.sunDir, up);
    let into = max(dot(frame.sunDir, n), 0.02);
    let reach = b.overhang * sunUp / into;
    sun = smoothstep(reach - 0.05, reach + 0.12, below);
  }

  var out : Surface;
  out.albedo = mix(wall, interior * (1.0 - fresnel), glass);
  out.specular = mirror * fresnel * glass;
  out.normal = bent;
  out.sun = sun;
  out.sky = sky;
  return out;
}

// Curtain walls: glass between a grid of mullions and dark spandrel panels at
// each floor.
fn curtainWall(b : Building, u : f32, v : f32, du : f32, dv : f32, n : vec3f, up : vec3f, toEye : vec3f) -> Surface {
  let bay = mix(1.35, 1.8, pick(b.seed, 1u));
  let storey = mix(3.5, 4.0, pick(b.seed, 2u));
  let x = u / bay;
  let y = v / storey;
  let mullion = 1.0 - band(x, 0.03, 0.97, du / bay);
  let spandrel = 1.0 - band(y, 0.28, 0.97, dv / storey);
  let solid = clamp(mullion + spandrel, 0.0, 1.0);
  let facing = clamp(dot(n, toEye), 0.0, 1.0);
  let fresnel = 0.08 + 0.92 * pow(1.0 - facing, 5.0);
  let tint = b.colour * 0.35;
  var out : Surface;
  out.albedo = mix(tint * (1.0 - fresnel), vec3f(0.06, 0.065, 0.07), solid);
  out.specular = skyReflection(reflect(-toEye, n), up) * fresnel * (1.0 - solid) * mix(vec3f(1.0), b.colour, 0.4);
  out.normal = n;
  out.sun = 1.0;
  out.sky = mix(0.62, 1.0, smoothstep(0.0, 2.5, v));
  return out;
}

// Where the photograph has nothing: clay tile, slate, weathered grey, brown.
fn roofing(seed : u32) -> vec3f {
  var colours = array<vec3f, 4>(
    vec3f(0.23, 0.08, 0.05), vec3f(0.05, 0.05, 0.055), vec3f(0.14, 0.13, 0.12), vec3f(0.12, 0.07, 0.045));
  return colours[(seed >> 4u) % 4u];
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // Everything that needs derivatives first, while control flow is uniform.
  let dwx = dpdx(in.world);
  let dwy = dpdy(in.world);
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);

  // Face normal, turned towards the eye: nothing is culled, so the inside of
  // a wall is what you see standing in a building.
  let face = normalize(cross(dwx, dwy));
  let n = select(face, -face, dot(face, in.world) > 0.0);
  let up = block.up;
  let upness = dot(n, up);
  let b = unpack(in.record);
  let toEye = normalize(-in.world);

  // Facade coordinates: metres along the wall and up from the building's
  // base, their changes to the neighbouring pixels, and the footprint.
  let along2 = facetAlong(in.facet);
  let along = block.east * along2.x + block.north * along2.y;
  let u = dot(in.local.xy, along2);
  let v = in.base;
  let gx = vec2f(dpdx(u), dpdx(v));
  let gy = vec2f(dpdy(u), dpdy(v));
  let du = abs(gx.x) + abs(gy.x);
  let dv = abs(gx.y) + abs(gy.y);

  let roof = smoothstep(0.45, 0.65, upness);
  let underside = smoothstep(-0.3, -0.6, upness);

  // ---- walls ----
  var wall : Surface;
  if (b.kind == KIND_GLASS) {
    wall = curtainWall(b, u, v, du, dv, n, up, toEye);
  } else {
    wall = facade(b, u, v, gx, gy, du, dv, n, along, up, toEye);
  }

  // ---- roofs ----
  var roofColour = roofing(b.seed);
  var photoFound = 0.0;
  var photoLevel = 0.0;
  if (roof > 0.0) {
    let photo = sampleImagery(in.merc, dmx, dmy);
    roofColour = mix(roofColour, photo.colour, photo.found);
    photoFound = photo.found;
    photoLevel = photo.level;
  }

  let wallLight = sunLight(wall.normal) * wall.sun + skyLight(wall.normal) * wall.sky;
  let roofModelled = modelledLight(n);
  let roofLight = mix(roofModelled, photoLight(n), photoFound);
  var albedo = mix(wall.albedo, roofColour, roof);
  var light = mix(wallLight, roofLight, roof);
  var reflection = wall.specular * (1.0 - roof);
  albedo *= mix(1.0, 0.35, underside);

  if (frame.debugMode == 1u) {
    albedo = (n * 0.5 + 0.5) * (n * 0.5 + 0.5);
    light = vec3f(1.0);
    reflection = vec3f(0.0);
  } else if (frame.debugMode == 4u) {
    albedo = select(vec3f(0.3), levelColour(photoLevel), photoFound > 0.0 && roof > 0.5);
    reflection = vec3f(0.0);
  } else if (frame.debugMode == 5u) {
    albedo = levelColour(block.depth);
    reflection = vec3f(0.0);
  }

  return present(applyAtmosphere(albedo * light + reflection, in.world, in.clip.xy), in.clip.xy);
}
