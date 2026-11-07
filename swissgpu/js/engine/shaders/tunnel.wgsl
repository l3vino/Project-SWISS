// tunnel.wgsl — the insides of tunnels (js/engine/passes/tunnels.js; the
// meshes from wasm/src/tunnel.c, their cross-sections and lamps from
// js/engine/tunnels/sections.js). Joined after common.wgsl, atmosphere.wgsl,
// frame.wgsl, imagery.wgsl and vector.wgsl.
//
// No sun reaches inside: the light is the tunnel's own lamps and the
// daylight falling in at its portals. Lamps hang every `lampStep` metres
// along at one place of the cross-section (road tunnels: a row of
// luminaires in the vault; railway tunnels: the dim emergency lights on the
// wall); a pixel is lit by the three nearest, found from its metres along,
// placed in the world from its own position, the way along and up. The
// daylight falls off from each portal inwards (two exponentials: the bright
// mouth over the first tens of metres, the long faint tail behind it). The
// floor of a road tunnel carries the tunnel's own roads from the vector
// tiles (vectorRoads, VT_IN_TUNNEL); a railway tunnel's floor is ballast
// (its tracks come with the railways, 5.20b). The collar round a portal is
// outside, in the open, and lit as everything outside is. The lamps are as
// bright as an eye adapted to them finds them, times `interior` (5.18b): from
// daylight a tunnel is dark inside, until the eye adapts (render.js raises
// frame.eyeGain to about 1 / interior after a while inside).

const T_FLOOR   : u32 = 1u;
const T_WALKWAY : u32 = 2u;
const T_WALL    : u32 = 3u;
const T_VAULT   : u32 = 4u;
const T_COLLAR  : u32 = 5u;
const T_DARK    : u32 = 6u;
const T_CEILING : u32 = 7u;

struct Tube {
  originRel  : vec3f,   // the mesh's origin minus the camera, metres
  lampStep   : f32,     // metres between lamps, 0 none
  merc       : vec2f,   // the mesh's Mercator origin from the imagery anchor, reference pixels
  mercScale  : f32,     // imagery reference pixels per mesh Mercator unit
  inside     : f32,     // 1: the camera is in this tube, no outdoor haze on it
  portals    : vec2f,   // metres along of the portal at its first end (x) and its last (y), ±1e9 none
  lamp       : vec2f,   // where its lamps are: metres right of its line and up from the floor
  lampColour : vec3f,   // a lamp's light one metre from it, display units
  family     : u32,     // 1 road, 2 railway, 3 other
  wall       : vec3f,   // the walls' colour (linear albedo)
  lampSize   : f32,     // metres a luminaire is long (along)
  spring     : f32,     // metres up where the walls end: the vault above it rises with the bore's width
  interior   : f32,     // the lamps' light against daylight's (the eye adapts to it inside, common.wgsl present)
  _p1        : f32,
  _p2        : f32,
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
};

@vertex
fn vs(@location(0) position : vec3f, @location(1) normal : vec4f, @location(2) along : f32,
      @location(3) ah : vec2f, @location(4) merc : vec2f, @location(5) way : vec4f, @location(6) bore : vec2f) -> VSOut {
  var out : VSOut;
  out.world = position + tube.originRel;
  out.clip = frame.viewProj * vec4f(out.world, 1.0);
  out.normal = normal.xyz;
  out.material = u32(round(normal.w * 32767.0));
  out.along = along;
  out.ah = ah;
  out.merc = tube.merc + merc * tube.mercScale;
  out.way = way.xyz;
  // The lamps' place, stretched with the bore as the mesh stretches its section (tunnel.c, placed).
  let middle = bore.x * 64.0;
  let wide = 1.0 + bore.y * 16.0;
  let up = select(tube.lamp.y, tube.spring + (tube.lamp.y - tube.spring) * sqrt(wide), tube.lamp.y > tube.spring);
  out.lamp = vec2f(middle + tube.lamp.x * wide, up);
  return out;
}

const T_CONCRETE : vec3f = vec3f(0.30, 0.29, 0.27);
const T_BALLAST  : vec3f = vec3f(0.16, 0.15, 0.13);
const T_SOOT     : vec3f = vec3f(0.06, 0.055, 0.05);

// Value noise in the tube's own coordinates (metres along, across + up), so
// the grain stays on the walls as the camera moves.
fn tNoise(p : vec2f) -> f32 {
  return vtNoise(p + vec2f(4096.0), 65536u);
}

// What a surface is made of, before any light.
fn tAlbedo(in : VSOut, dmx : vec2f, dmy : vec2f) -> vec3f {
  let m = in.material;
  let p = vec2f(in.along, in.ah.x + in.ah.y);
  let grain = 0.5 * (tNoise(p * 2.7) - 0.5) + 0.3 * (tNoise(p * 0.6) - 0.5) + 0.2 * (tNoise(p * 9.0) - 0.5);
  if (m == T_FLOOR) {
    if (tube.family == 2u) {
      // Ballast: stones a few centimetres across.
      return T_BALLAST * (1.0 + 0.9 * (tNoise(p * 22.0) - 0.5) + 0.4 * grain);
    }
    let base = T_CONCRETE * 0.55 * (1.0 + 0.3 * grain);
    return vectorRoads(in.merc, dmx, dmy, base, vec2f(1.0, 0.0), vec4f(0.0), VT_IN_TUNNEL);
  }
  if (m == T_WALKWAY) { return T_CONCRETE * 1.1 * (1.0 + 0.25 * grain); }
  if (m == T_CEILING) { return T_CONCRETE * 0.8 * (1.0 + 0.2 * grain); }
  // Walls and vault: the tube's own colour, dirtier near the floor (spray, soot).
  let low = 1.0 - smoothstep(0.2, 1.6, in.ah.y);
  let c = tube.wall * (1.0 + 0.35 * grain);
  return mix(c, T_SOOT, 0.5 * low);
}

// The light of the three lamps nearest along, on a surface at `world` facing `n`.
fn tLamps(in : VSOut, n : vec3f) -> vec3f {
  if (tube.lampStep <= 0.0) { return vec3f(0.0); }
  let up = localUp(in.world);
  let way = normalize(in.way);
  let right = normalize(cross(way, up));
  let j = round(in.along / tube.lampStep);
  let across = right * (in.lamp.x - in.ah.x) + up * (in.lamp.y - in.ah.y);
  var sum = vec3f(0.0);
  for (var k = -1; k <= 1; k++) {
    let d = way * ((j + f32(k)) * tube.lampStep - in.along) + across;
    let d2 = max(dot(d, d), 0.25);
    sum += tube.lampColour * max(dot(n, d * inverseSqrt(d2)), 0.0) / d2;
  }
  return sum;
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
  let glow = tLuminaire(in, fw, fa);
  let n = normalize(in.normal);
  var colour : vec3f;
  if (in.material == T_DARK) {
    // Far down the tube, beyond what is built: the dark a tunnel goes to.
    colour = vec3f(0.002);
  } else if (in.material == T_COLLAR) {
    colour = T_CONCRETE * 1.2 * modelledLight(n);
  } else {
    let albedo = tAlbedo(in, dmx, dmy);
    colour = albedo * ((tLamps(in, n) + vec3f(0.003)) * tube.interior + tDaylight(in, n)) + glow * tube.interior;
  }
  if (tube.inside < 0.5) { colour = applyAtmosphere(colour, in.world, in.clip.xy); }
  return present(colour, in.clip.xy);
}
