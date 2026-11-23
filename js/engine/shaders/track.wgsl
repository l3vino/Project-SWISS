// track.wgsl — a railway's track out in the open near the camera (5.18b): built over each tile by
// wasm/src/track.c and drawn by the terrain pass after the ground (passes/terrain.js), with the tile's own slot: its
// origin, the quarters finer tiles draw instead, its place on the imagery grid. Joined after terrain.wgsl.
//
// The bed is ballast, its top crossed by a sleeper every 0.6 m with the rails' fastenings and the shadow of their
// feet, as on a tunnel's floor (vector.wgsl vtTrack); the rails' heads are polished bright by the wheels and their
// sides rust brown (tunnel.wgsl tRail); a rack has its teeth every 10 cm. Its colours are matched in brightness to the
// photo's of the ground round it (the photo shows the same track from above, in the light and shade of the moment)
// and lit by how each face turns from level ground, so where it fades out at its reach into the photo's own track
// nothing jumps. The rails stand as geometry only while they are wider than a pixel (TrackInfo.railFar): past that
// they would shimmer, and the bed's top draws them instead.

struct TrackInfo {
  reach    : f32,   // metres: nothing drawn farther, faded out by a dither over its last fifth
  railNear : f32,   // the standing rails fade out from here
  railFar  : f32,   // to here
  _pad     : f32,
};
@group(1) @binding(2) var<uniform> trackInfo : TrackInfo;

const TRACK_SPAN : f32 = 4.0;
const TRACK_BED  : u32 = 0u;
const TRACK_RAIL : u32 = 1u;
const TRACK_RACK : u32 = 2u;
// The bed's top reaches this far past the gauge line (track.c: SLEEPER_OVER and SHOULDER).
const TRACK_TOP_OVER : f32 = 0.98;
const TRACK_BALLAST_RGB : vec3f = vec3f(0.205, 0.190, 0.170);
const TRACK_RUST_RGB    : vec3f = vec3f(0.085, 0.052, 0.034);  // rust and brake dust on a rail's sides
// A rail's web under its head (60E1: the head's lower edge 130 of its 172 mm up, the foot's top 12 mm): in the head's
// shadow, lit by the sky alone, as far up the side as these.
const TRACK_WEB_FROM : f32 = 0.10;
const TRACK_WEB_TO   : f32 = 0.74;
// How much of the light's relief the bed takes (the photo it is matched to holds the real light and shade; its
// slopes darker than that stood out as black slivers where two beds cross at a switch), and the rails (all of it).
const TRACK_BED_RELIEF : f32 = 0.5;
// The luminance of the bed's top as made (mostly ballast, a quarter sleepers), which the photo's is matched to.
const TRACK_OWN_LUM : f32 = 0.205;

struct TrackOut {
  @builtin(position) clip : vec4f,
  @location(0) world  : vec3f,   // relative to the camera
  @location(1) uv     : vec2f,   // on the tile
  @location(2) merc   : vec2f,   // imagery reference pixels from the anchor
  @location(3) along  : f32,     // metres along the line
  @location(4) across : f32,     // metres right of the track's middle
  @location(5) @interpolate(flat) gauge : f32,
  @location(6) @interpolate(flat) kind  : u32,
  @location(7) rise   : f32,     // how far up its profile: 0 a rail's foot or the bed's toe, 1 a head or the bed's top
  @location(8) rel    : vec3f,   // from the tile's origin, metres (earth-centred axes): for the bores (inBore)
};

// Tile.mask's bit for a tile whose bores are in its cut slot (passes/terrain.js MASK_BORES).
const TRACK_MASK_BORES : u32 = 0x400u;

@vertex
fn vsTrack(@location(0) position : vec3f, @location(1) uv : vec2f, @location(2) along : f32,
           @location(3) across : vec2f, @location(4) kind : vec4f) -> TrackOut {
  var out : TrackOut;
  out.world = position + tile.originRel;
  out.clip = frame.viewProj * vec4f(out.world, 1.0);
  out.uv = uv;
  // Longitude is linear in Mercator; latitude follows the tile's fitted curve (terrain.wgsl vs).
  out.merc = vec2f(tile.mercX.x + uv.x * tile.mercX.y, tile.mercY.x + uv.y * (tile.mercY.y + uv.y * tile.mercY.z));
  out.along = along;
  out.across = across.x * TRACK_SPAN;
  out.gauge = across.y * TRACK_SPAN;
  out.kind = u32(kind.x * 255.0 + 0.5);
  out.rise = kind.z;
  out.rel = position;
  return out;
}

// Interleaved gradient noise (Jimenez, 2014): a dither as even at every scale, for the fades.
fn trackDither(p : vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// The bed's top: the sleepers (concrete, 2.6 m long under standard gauge), the fastenings either side of each rail
// and the shadow of its foot, and the rails' heads for where they no longer stand (vtTrack's). `fw`, `fs`: metres a
// pixel spans across and along; where it spans more than a sleeper's pitch, the sleepers and fastenings are their
// share of the length, not a moiré.
fn trackTop(colour : vec3f, along : f32, across : f32, gauge : f32, fw : f32, fs : f32) -> vec3f {
  let x = abs(across);
  let rail = gauge + 0.036;                       // the head's middle from the track's
  let u = along - round(along / 0.6) * 0.6;       // metres from the nearest sleeper's middle
  let under = vtBand(x, gauge + 0.58, fw);
  let sleeper = mix(vtBand(u, 0.13, fs), 0.26 / 0.6, smoothstep(0.1, 0.3, fs)) * under;
  // The ballast a shade darker against each sleeper's side (they stand a little proud of it), while a pixel is
  // smaller than that.
  let edge = abs(u) - 0.13;
  let crib = select(0.0, 1.0 - smoothstep(0.0, 0.07, edge), edge > 0.0) * under * (1.0 - smoothstep(0.03, 0.1, fs));
  var c = mix(colour * (1.0 - 0.3 * crib), VT_SLEEPER_RGB, sleeper);
  let clip = vtBand(abs(x - rail) - 0.085, 0.025, fw) * mix(vtBand(u, 0.05, fs), 0.1 / 0.6, smoothstep(0.05, 0.15, fs));
  c = mix(c, vec3f(0.03), clip);
  c = mix(c, c * 0.35, vtBand(x - rail, 0.075, fw));
  return mix(c, VT_STEEL_RGB * 1.6, vtBand(x - rail, 0.036, fw));
}

@fragment
fn fsTrack(in : TrackOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is uniform.
  let facet = cross(dpdx(in.world), dpdy(in.world));
  let fw = max(length(vec2f(dpdx(in.across), dpdy(in.across))), 1e-4);
  let fs = max(length(vec2f(dpdx(in.along), dpdy(in.along))), 1e-4);
  let d = length(in.world);
  // The quarters finer tiles draw (terrain.wgsl fsMasked); the fade at the reach, and the standing rails' own.
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  var gone = smoothstep(0.8 * trackInfo.reach, trackInfo.reach, d);
  if (in.kind != TRACK_BED) { gone = max(gone, smoothstep(trackInfo.railNear, trackInfo.railFar, d)); }
  if (((tile.mask >> quarter) & 1u) != 0u || gone > trackDither(in.clip.xy)) { discard; }
  // Inside a tunnel's bore, where the ground is left out too, the tunnel's own track runs (5.18c: tunnel.c rails, on
  // a bed as high as this one), so the two meet where the bore begins instead of lying one over the other.
  if ((tile.mask & TRACK_MASK_BORES) != 0u && inBore(in.rel) == 1u) { discard; }

  let up = localUp(in.world);
  // The face's own normal, turned to the eye (back faces are culled: what shows faces it).
  var n = facet / max(length(facet), 1e-20);
  if (dot(n, in.world) > 0.0) { n = -n; }

  // The photo's brightness round here: the same track from above, in this moment's light and shade.
  let blur = photoBlur(in.merc, 3.0 / vtMetresPerRef());
  let tint = select(1.0, clamp(vtLuminance(blur.rgb) / TRACK_OWN_LUM, 0.35, 1.8), blur.w > 0.0);

  let q = vec2f(in.along, in.across);
  let grain = vtNoise(q * 9.0 + vec2f(512.0), 65536u) - 0.5;
  let stones = vtNoise(q * 26.0 + vec2f(77.0), 65536u) - 0.5;
  let fine = 1.0 - smoothstep(0.02, 0.12, max(fw, fs));
  var albedo : vec3f;
  var shine = 0.0;
  var power = 1.0;
  var relief = 1.0;
  var sun = 1.0;
  if (in.kind == TRACK_BED) {
    var c = TRACK_BALLAST_RGB * (1.0 + fine * (0.35 * grain + 0.30 * stones));
    if (abs(in.across) < in.gauge + TRACK_TOP_OVER - 0.001) { c = trackTop(c, in.along, in.across, in.gauge, fw, fs); }
    // Its sides grimier towards their foot, where they meet the ground.
    else { c *= mix(0.72, 1.0, smoothstep(0.0, 0.7, in.rise)); }
    albedo = c * tint;
    relief = TRACK_BED_RELIEF;
  } else if (in.kind == TRACK_RAIL) {
    let head = dot(n, up) > 0.7;
    // A side: its head's edge and its foot rust brown, the web between in the head's shadow (sky light alone).
    let web = select(smoothstep(TRACK_WEB_FROM - 0.03, TRACK_WEB_FROM + 0.03, in.rise) * (1.0 - smoothstep(TRACK_WEB_TO - 0.03, TRACK_WEB_TO + 0.03, in.rise)), 0.0, head);
    albedo = select(TRACK_RUST_RGB * (1.0 + 0.3 * grain) * (1.0 - 0.35 * web), VT_STEEL_RGB * 1.6, head) * sqrt(tint);
    sun = 1.0 - web;
    shine = select(0.05 * sun, 0.6, head);
    power = select(8.0, 60.0, head);
  } else {
    // A rack: dark steel, its teeth every 10 cm across its top.
    let teeth = select(0.0, vtBand(in.along - round(in.along / 0.1) * 0.1, 0.025, fs), dot(n, up) > 0.7);
    albedo = vec3f(0.10, 0.10, 0.105) * (1.0 - 0.6 * teeth) * sqrt(tint);
    shine = 0.2;
    power = 24.0;
  }
  // Lit by how the face turns from level ground, which shows as the photo has it (the bed with half the relief, a
  // web without the sun).
  let level = max(light.level.rgb, vec3f(1e-3));
  var colour = albedo * mix(vec3f(1.0), (sunLight(n) * sun + skyLight(n)) / level, relief);
  if (shine > 0.0) {
    let h = normalize(frame.sunDir - in.world / d);
    colour += light.sun.rgb / level * shine * pow(max(dot(n, h), 0.0), power) * max(dot(n, frame.sunDir), 0.0);
  }
  return present(applyAtmosphere(colour, in.world, in.clip.xy), in.clip.xy);
}
