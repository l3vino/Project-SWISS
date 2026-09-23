// terrain.wgsl — the ground.
//
// Vertices arrive as offsets from their own tile's origin, and the tile
// uniform carries that origin already made relative to the camera. Adding the
// two in float32 is exact enough because both are small; the large numbers
// were cancelled out in double precision before anything reached the GPU.

struct Frame {
  viewProj    : mat4x4f,
  cameraEcef  : vec3f,
  near        : f32,
  sunDir      : vec3f,
  debugMode   : u32,
  horizon     : vec3f,
  fogDensity  : f32,
};

struct Tile {
  originRel : vec3f,   // tile origin minus camera position, metres
  _pad0     : f32,
  rect      : vec4f,   // west, south, east, north, degrees
  heights   : vec2f,   // min, max, metres
  _pad1     : vec2f,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<uniform> tile  : Tile;

struct VSOut {
  @builtin(position) clip   : vec4f,
  @location(0)       world  : vec3f,   // relative to the camera
  @location(1)       normal : vec3f,
  @location(2)       height : f32,
  @location(3)       uv     : vec2f,
  @location(4)       skirt  : f32,
};

// Octahedral decode. The encoded pair is not a unit vector until this runs,
// so the normalise at the end is required, not defensive.
fn octDecode(e : vec2f) -> vec3f {
  var v = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    let s = vec2f(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
    v = vec3f((1.0 - abs(vec2f(v.y, v.x))) * s, v.z);
  }
  return normalize(v);
}

@vertex
fn vs(@location(0) position : vec3f,
      @location(1) normal   : vec2f,
      @location(2) uvhs     : vec4f) -> VSOut {
  var out : VSOut;
  out.world  = position + tile.originRel;
  out.clip   = frame.viewProj * vec4f(out.world, 1.0);
  out.normal = octDecode(normal);
  out.height = mix(tile.heights.x, tile.heights.y, uvhs.z);
  out.uv     = uvhs.xy;
  out.skirt  = uvhs.w;
  return out;
}

fn tonemap(c : vec3f) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let tc = c / (c + 1.0);
  return mix(c / (l + 1.0), tc, tc);
}

// A rough Swiss cross-section: meadow, forest, bare rock, snow. Slope matters
// as much as altitude, because anything steep enough sheds both soil and snow.
fn groundColour(height : f32, slope : f32) -> vec3f {
  let meadow = vec3f(0.196, 0.263, 0.145);
  let forest = vec3f(0.129, 0.184, 0.110);
  let rock   = vec3f(0.310, 0.294, 0.271);
  let scree  = vec3f(0.404, 0.388, 0.361);
  let snow   = vec3f(0.878, 0.902, 0.925);

  var c = mix(meadow, forest, smoothstep(450.0, 900.0, height));
  c = mix(c, scree, smoothstep(1750.0, 2350.0, height));
  c = mix(c, snow, smoothstep(2500.0, 2900.0, height));
  // Steep ground is rock whatever the altitude.
  c = mix(c, rock, smoothstep(0.72, 0.42, slope));
  return c;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  // Absolute position only to get a local up; float32 is plenty for a direction.
  let up = normalize(frame.cameraEcef + in.world);
  let slope = dot(n, up);

  var albedo : vec3f;
  if (frame.debugMode == 1u) {
    albedo = n * 0.5 + 0.5;
  } else if (frame.debugMode == 2u) {
    let t = clamp(in.height / 4600.0, 0.0, 1.0);
    albedo = vec3f(t, t * t, 1.0 - t);
  } else {
    albedo = groundColour(in.height, slope);
    if (frame.debugMode == 3u) {
      // Tile edges, from the tile-local coordinates the mesh already carries.
      let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
      albedo = mix(vec3f(0.9, 0.25, 0.2), albedo, smoothstep(0.0, 0.006, edge));
    }
  }

  let sun = max(dot(n, frame.sunDir), 0.0);
  // Sky fill from above plus a dim bounce, so shadowed faces read as shape
  // rather than as black holes.
  let ambient = 0.28 + 0.22 * max(slope, 0.0);
  var colour = albedo * (sun * 1.35 + ambient);

  // Skirt geometry exists only to plug the seams between tiles; darkening it
  // slightly makes any that pokes into view obvious instead of confusing.
  colour *= mix(1.0, 0.72, in.skirt);

  // Distance haze towards the same horizon colour the sky uses, so ground and
  // sky meet rather than butt against each other.
  let dist = length(in.world);
  let fog = 1.0 - exp(-dist * frame.fogDensity);
  colour = mix(colour, frame.horizon, clamp(fog, 0.0, 1.0));

  let p = vec2u(in.clip.xy);
  let dither = (f32((p.x * 7u + p.y * 23u) & 15u) / 15.0 - 0.5) / 255.0;
  return vec4f(tonemap(colour) + dither, 1.0);
}
