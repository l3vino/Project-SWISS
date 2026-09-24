// buildings.wgsl — 3D buildings. Joined after common.wgsl, frame.wgsl and
// imagery.wgsl.
//
// Twelve bytes a vertex: a position quantised into the tile's box in a local
// east-north-up frame, the height of the vertex above its building's lowest
// point, sixteen bits of per-building info (kind, tint), and the facing of the
// wall the vertex starts (see wasm/src/mesh.c). No normals are stored: every
// face of a building is flat, so the face normal comes from the screen-space
// derivatives of the position, exact per facet and free in memory. Only the
// direction windows run along needs more than that: derivatives wobble by a
// hair from pixel to pixel, and a hair times a few hundred metres from the
// tile's origin is a window edge that crawls.
//
// Roofs take their colour from the aerial photograph projected straight down:
// the photo already shows every roof, with its tiles, its dormers and its
// solar panels. Walls are drawn procedurally, so they cost no memory and no
// download and stay sharp however close you walk: plaster with grain and
// weathering, windows with frames, sills, recessed glass reflecting the sky
// and, on some houses, open wooden shutters; a stone plinth, storey bands, a
// shopfront now and then. Each building draws its own proportions and colours
// from a hash of its identifier. Every feature is box-filtered against the
// pixel's footprint, so detail fades to its average with distance instead of
// shimmering.

const KIND_BUILDING : u32 = 0u;
const KIND_PLAIN    : u32 = 1u;
const KIND_GLASS    : u32 = 2u;

struct Block {
  originRel : vec3f,   // tile frame origin minus the camera, metres
  depth     : f32,     // depth in the tileset, for the debug view
  east      : vec3f,   // the tile frame's axes, earth-centred
  _p1       : f32,
  north     : vec3f,
  _p2       : f32,
  up        : vec3f,
  _p3       : f32,
  boxMin    : vec3f,   // the box positions are quantised into, local metres
  _p4       : f32,
  boxSize   : vec3f,
  _p5       : f32,
  merc      : vec4f,   // frame origin on the imagery grid from its anchor (x, y); px per metre east; px per metre north
  mercCurve : vec4f,   // growth of the east scale per metre north; px per square metre north; parallel's curve; unused
};

@group(1) @binding(0) var<uniform> block : Block;

struct VSOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,    // relative to the camera
  @location(1) local : vec3f,    // in the tile frame, metres
  @location(2) base  : f32,      // metres above the building's lowest point
  @location(3) merc  : vec2f,    // imagery reference pixels from the anchor
  @location(4) @interpolate(flat) info : u32,
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
  out.info = info.x;
  out.facet = info.y;
  return out;
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

// 1 while a feature `period` metres across spans a few pixels, fading to 0
// as it shrinks towards one: below that it can only flicker.
fn visibleDetail(period : f32, metresPerPixel : f32) -> f32 {
  return 1.0 - smoothstep(0.25, 0.6, metresPerPixel / period);
}

// ---- hashing and noise ----

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

fn valueNoise(p : vec2f, seed : u32) -> f32 {
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = cellHash(p, seed);
  let b = cellHash(p + vec2f(1.0, 0.0), seed);
  let c = cellHash(p + vec2f(0.0, 1.0), seed);
  let d = cellHash(p + vec2f(1.0, 1.0), seed);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// ---- palettes, linear light ----

// Plaster: mostly off-white and warm pastel, some grey stone, a little dark
// timber.
fn plaster(tint : u32) -> vec3f {
  var colours = array<vec3f, 10>(
    vec3f(0.60, 0.58, 0.53), vec3f(0.62, 0.55, 0.42), vec3f(0.52, 0.44, 0.33),
    vec3f(0.46, 0.46, 0.45), vec3f(0.63, 0.53, 0.30), vec3f(0.58, 0.40, 0.32),
    vec3f(0.55, 0.55, 0.52), vec3f(0.40, 0.44, 0.36), vec3f(0.33, 0.32, 0.30),
    vec3f(0.12, 0.07, 0.04));
  return colours[tint % 10u];
}

// Where the photograph has nothing: clay tile, slate, weathered grey, brown.
fn roofing(tint : u32) -> vec3f {
  var colours = array<vec3f, 4>(
    vec3f(0.23, 0.08, 0.05), vec3f(0.05, 0.05, 0.055), vec3f(0.14, 0.13, 0.12), vec3f(0.12, 0.07, 0.045));
  return colours[(tint >> 4u) % 4u];
}

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

// ---- surfaces ----

// What a wall looks like: a diffuse colour lit like everything else, and a
// reflection added on top, which is not.
struct Surface {
  albedo  : vec3f,
  specular : vec3f,
};

// A facade seen through one pixel. `u` runs along the wall and `v` up from
// the building's base, both in metres, with their footprints in the pixel.
fn facade(tint : u32, u : f32, v : f32, du : f32, dv : f32, n : vec3f, up : vec3f, toEye : vec3f) -> Surface {
  // The building's own proportions.
  let bay = mix(2.3, 3.4, pick(tint, 1u));                  // window to window, metres
  let storey = mix(2.75, 3.25, pick(tint, 2u));             // floor to floor
  let groundFloor = storey * mix(1.0, 1.25, pick(tint, 3u));
  let plinth = mix(0.25, 0.7, pick(tint, 4u));
  let shutters = pick(tint, 5u) < 0.45;
  let shopfront = pick(tint, 6u) < 0.12;
  let bands = pick(tint, 7u) < 0.4;
  let winW = select(mix(0.36, 0.48, pick(tint, 8u)), mix(0.30, 0.40, pick(tint, 8u)), shutters);
  let sillAt = mix(0.28, 0.33, pick(tint, 9u));             // fractions of a storey
  let topAt = sillAt + mix(0.42, 0.50, pick(tint, 10u));
  let wallColour = plaster(tint) * mix(0.9, 1.08, pick(tint, 11u));
  let frameColour = framePaint(hashU(tint + 12u));
  let shutterColour = shutterPaint(hashU(tint + 13u));

  // Position in bays and in storeys. The ground floor has a height of its own.
  let inGround = v < groundFloor;
  let period = select(storey, groundFloor, inGround);
  let x = u / bay;
  let y = select((v - groundFloor) / storey, v / groundFloor, inGround);
  let wx = du / bay;
  let wy = dv / period;
  let mpp = max(du, dv);

  // Window geometry in fractions of a bay and a storey.
  let g0 = 0.5 - 0.5 * winW;
  let g1 = 0.5 + 0.5 * winW;
  let fx = 0.075 / bay;                     // frame
  let fy = 0.075 / period;
  let sx = 0.05 / bay;                      // sill overhang to each side
  let sh = 0.06 / period;                   // sill thickness
  let sw = 0.5 * winW;                      // one shutter leaf, folded open

  let glassX = band(x, g0, g1, wx);
  let openX = band(x, g0 - fx, g1 + fx, wx);
  var glassY = band(y, sillAt, topAt, wy);
  var openY = band(y, sillAt - fy, topAt + fy, wy);
  var sillY = band(y, sillAt - fy - sh, sillAt - fy, wy);
  let sillX = band(x, g0 - fx - sx, g1 + fx + sx, wx);
  // Glass sits in a reveal: its top is shaded by the lintel.
  let lintel = band(y, topAt - 0.14 / period, topAt, wy);
  // Rain runs off each sill and stains the plaster below it.
  let stainY = band(y, sillAt - fy - sh - 0.9 / period, sillAt - fy - sh, wy);

  var glass = glassX * glassY;
  var frame = max(openX * openY - glass, 0.0);
  var sill = sillX * sillY;
  var leaves = 0.0;
  if (shutters) {
    leaves = (band(x, g0 - fx - sw, g0 - fx, wx) + band(x, g1 + fx, g1 + fx + sw, wx)) * openY;
  }

  // No windows in the plinth. A shopfront replaces the ground floor's.
  let above = 1.0 - span(v, -100.0, plinth + 0.15, dv);
  glass *= above; frame *= above; sill *= above; leaves *= above;
  if (shopfront) {
    let shopX = band(x, 0.08, 0.92, wx);
    let shopY = span(v, plinth + 0.1, groundFloor - 0.45, dv);
    let shopFrame = band(x, 0.06, 0.94, wx) * span(v, plinth, groundFloor - 0.35, dv);
    let g = select(0.0, 1.0, inGround);
    glass = mix(glass, shopX * shopY, g);
    frame = mix(frame, max(shopFrame - shopX * shopY, 0.0), g);
    sill *= 1.0 - g; leaves *= 1.0 - g;
  }

  // ---- plaster ----
  var wall = wallColour;
  // Large blotches and finer mottling, then grain only close up.
  let blotch = valueNoise(vec2f(u, v) / 1.7, tint) - 0.5;
  let mottle = valueNoise(vec2f(u, v) / 0.45, tint + 7u) - 0.5;
  let grain = valueNoise(vec2f(u, v) / 0.035, tint + 13u) - 0.5;
  wall *= 1.0 + 0.10 * blotch * visibleDetail(1.7, mpp)
              + 0.07 * mottle * visibleDetail(0.45, mpp)
              + 0.10 * grain * visibleDetail(0.035, mpp);
  // Streaks under the windows, strongest just below the sill.
  let streak = stainY * band(x, g0 + 0.05, g1 - 0.05, wx) * above
             * (0.6 + 0.4 * valueNoise(vec2f(u / 0.3, v / 2.0), tint + 21u));
  wall *= 1.0 - 0.22 * streak;
  // Splash-back and grime along the bottom of the wall.
  wall *= mix(0.78, 1.0, smoothstep(0.0, 1.2, v));
  // A thin moulding along each floor line, lit from above.
  if (bands) {
    let moulding = band(y, 0.0, 0.05, wy) * (1.0 - select(0.0, 1.0, inGround));
    let under = band(y, 0.97, 1.0, wy) * (1.0 - select(0.0, 1.0, inGround));
    wall = mix(wall, wallColour * 1.12, moulding);
    wall *= 1.0 - 0.25 * under;
  }
  // The plinth: rougher, darker stone.
  let plinthCover = span(v, -100.0, plinth, dv);
  let stone = vec3f(0.24, 0.235, 0.22) * (1.0 + 0.18 * (valueNoise(vec2f(u, v) / 0.25, tint + 3u) - 0.5)
            * visibleDetail(0.25, mpp));
  wall = mix(wall, stone, plinthCover);

  // ---- joinery ----
  // Louvred shutters: slats every six centimetres, averaged far away.
  let slats = mix(0.72, 1.0, band(v / 0.06, 0.0, 0.65, dv / 0.06));
  wall = mix(wall, shutterColour * slats, leaves);
  wall = mix(wall, frameColour, frame);
  wall = mix(wall, vec3f(0.45, 0.44, 0.41), sill);
  // The sill's shadow on the wall just below it.
  wall *= 1.0 - 0.35 * sillX * band(y, sillAt - fy - sh - 0.05 / period, sillAt - fy - sh, wy) * above;

  // ---- glass ----
  // Dark interiors, some with curtains, each window its own; far away, where
  // one window is a pixel or less, their average instead of a flicker.
  let pane = vec2f(x, floor(y) + select(0.0, 1000.0, inGround));
  let lit = cellHash(pane, tint + 31u);
  let near = 1.0 - smoothstep(0.25, 0.6, max(wx, wy));
  let interior = mix(vec3f(0.035, 0.034, 0.032),
                     mix(vec3f(0.018, 0.017, 0.016), vec3f(0.20, 0.18, 0.14), step(0.72, lit)), near)
               * (1.0 - 0.6 * lintel);
  // Double glazing: four faces of glass reflect about a tenth of the light
  // head on, and nearly all of it at a glancing angle.
  let facing = clamp(dot(n, toEye), 0.0, 1.0);
  let fresnel = 0.1 + 0.9 * pow(1.0 - facing, 5.0);
  let mirror = skyReflection(reflect(-toEye, n), up) * (1.0 - 0.5 * lintel);

  var out : Surface;
  out.albedo = mix(wall, interior * (1.0 - fresnel), glass);
  out.specular = mirror * fresnel * glass;
  return out;
}

// Towers, walls, tanks, bridges: concrete with formwork joints every
// metre or so, stained and blotchy like the real thing.
fn concrete(tint : u32, u : f32, v : f32, du : f32, dv : f32) -> vec3f {
  let mpp = max(du, dv);
  var c = vec3f(0.30, 0.295, 0.28) * mix(0.85, 1.12, pick(tint, 14u));
  c *= 1.0 + 0.14 * (valueNoise(vec2f(u, v) / 2.2, tint) - 0.5) * visibleDetail(2.2, mpp)
           + 0.08 * (valueNoise(vec2f(u, v) / 0.3, tint + 5u) - 0.5) * visibleDetail(0.3, mpp);
  let lift = mix(0.9, 1.25, pick(tint, 15u));
  c *= 1.0 - 0.18 * band(v / lift, 0.0, 0.03, dv / lift);
  c *= mix(0.8, 1.0, smoothstep(0.0, 1.5, v));
  return c;
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
  let kind = in.info >> 12u;
  let tint = in.info & 0x0fffu;
  let toEye = normalize(-in.world);

  // Facade coordinates: metres along the wall and up from the building's
  // base, with how much of each one pixel covers.
  let along = facetAlong(in.facet);
  let u = dot(in.local.xy, along);
  let v = in.base;
  let du = fwidth(u);
  let dv = fwidth(v);

  let roof = smoothstep(0.45, 0.65, upness);
  let underside = smoothstep(-0.3, -0.6, upness);

  // ---- walls ----
  var wall = Surface(vec3f(0.0), vec3f(0.0));
  if (kind == KIND_BUILDING) {
    wall = facade(tint, u, v, du, dv, n, up, toEye);
  } else if (kind == KIND_GLASS) {
    let facing = clamp(dot(n, toEye), 0.0, 1.0);
    let fresnel = 0.1 + 0.9 * pow(1.0 - facing, 5.0);
    wall.albedo = vec3f(0.10, 0.13, 0.09) * (1.0 - fresnel) * 0.6 + concrete(tint, u, v, du, dv) * 0.15;
    wall.specular = skyReflection(reflect(-toEye, n), up) * fresnel;
  } else {
    wall.albedo = concrete(tint, u, v, du, dv);
  }
  // Contact shadow where the wall meets the ground.
  let contact = mix(0.6, 1.0, smoothstep(0.0, 2.5, v));

  // ---- roofs ----
  var roofColour = roofing(tint);
  var photoFound = 0.0;
  var photoLevel = 0.0;
  if (roof > 0.0) {
    let photo = sampleImagery(in.merc, dmx, dmy);
    roofColour = mix(roofColour, photo.colour, photo.found);
    photoFound = photo.found;
    photoLevel = photo.level;
  }

  let modelled = modelledLight(n, up);
  var albedo = mix(wall.albedo * contact, roofColour, roof);
  var light = mix(modelled, mix(modelled, photoLight(modelled), photoFound), roof);
  var reflection = wall.specular * (1.0 - roof);
  albedo *= mix(1.0, 0.35, underside);

  if (frame.debugMode == 1u) {
    albedo = (n * 0.5 + 0.5) * (n * 0.5 + 0.5);
    light = 1.0;
    reflection = vec3f(0.0);
  } else if (frame.debugMode == 4u) {
    albedo = select(vec3f(0.3), levelColour(photoLevel), photoFound > 0.0 && roof > 0.5);
    reflection = vec3f(0.0);
  } else if (frame.debugMode == 5u) {
    albedo = levelColour(block.depth);
    reflection = vec3f(0.0);
  }

  return present(applyFog(albedo * light + reflection, in.world), in.clip.xy);
}
