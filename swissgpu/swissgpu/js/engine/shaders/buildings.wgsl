// buildings.wgsl — 3D buildings. Joined after common.wgsl, frame.wgsl and
// imagery.wgsl.
//
// Twelve bytes a vertex: a position quantised into the tile's box in a local
// east-north-up frame, the height of the vertex above its building's lowest
// point, and sixteen bits of per-building info (kind, tint). No normals are
// stored: every face of a building is flat, so the face normal comes from the
// screen-space derivatives of the position, exact per facet and free in
// memory.
//
// Roofs take their colour from the aerial photograph projected straight down:
// the photo already shows every roof, with its tiles, its dormers and its
// solar panels. Walls are drawn procedurally: plaster in the colours Swiss
// facades actually come in, rows of windows that fade to their average with
// distance instead of shimmering, and darkening where the walls meet the
// ground.

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
  return out;
}

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

// Linear-light albedos. Plaster is mostly off-white and warm pastel, some
// grey stone, a little dark timber.
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
  let upness = dot(n, block.up);
  let kind = in.info >> 12u;
  let tint = in.info & 0x0fffu;

  // Facade coordinates in bays and storeys: along the wall, and up from the
  // building's base.
  let nl = vec2f(dot(n, block.east), dot(n, block.north));
  let along = normalize(vec2f(-nl.y, nl.x) + vec2f(1e-5, 0.0));
  let bays = dot(in.local.xy, along) / 2.6;
  let storeys = (in.base - 0.9) / 3.0;
  let windowCover = band(bays, 0.3, 0.7, fwidth(bays)) * band(storeys, 0.2, 0.68, fwidth(storeys));

  let roof = smoothstep(0.45, 0.65, upness);
  let underside = smoothstep(-0.3, -0.6, upness);
  let toEye = normalize(-in.world);

  // ---- walls ----
  var wall = plaster(tint);
  if (kind == KIND_PLAIN) { wall = vec3f(0.30, 0.30, 0.29); }
  var glassiness = 0.0;
  if (kind == KIND_BUILDING) { glassiness = windowCover * step(0.0, storeys); }
  if (kind == KIND_GLASS) { glassiness = 0.85; }
  // Glass reflects the sky more the more obliquely it is seen.
  let fresnel = pow(1.0 - clamp(abs(dot(n, toEye)), 0.0, 1.0), 3.0);
  let glass = mix(vec3f(0.018, 0.022, 0.027), frame.horizon * 0.55, 0.15 + 0.6 * fresnel);
  wall = mix(wall, glass, glassiness);
  // Contact shadow where the wall meets the ground.
  wall *= mix(0.55, 1.0, smoothstep(0.0, 3.0, in.base));

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

  let modelled = modelledLight(n, block.up);
  var albedo = mix(wall, roofColour, roof);
  var light = mix(modelled, mix(modelled, photoLight(modelled), photoFound), roof);
  albedo *= mix(1.0, 0.35, underside);

  if (frame.debugMode == 1u) {
    albedo = (n * 0.5 + 0.5) * (n * 0.5 + 0.5);
    light = 1.0;
  } else if (frame.debugMode == 4u) {
    albedo = select(vec3f(0.3), levelColour(photoLevel), photoFound > 0.0 && roof > 0.5);
  } else if (frame.debugMode == 5u) {
    albedo = levelColour(block.depth);
  }

  return present(applyFog(albedo * light, in.world), in.clip.xy);
}
