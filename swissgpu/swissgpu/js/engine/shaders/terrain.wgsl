// terrain.wgsl — the ground. Joined after common.wgsl, frame.wgsl and
// imagery.wgsl.
//
// Vertices arrive as offsets from their own tile's origin, and the tile
// uniform carries that origin already made relative to the camera. Adding the
// two in float32 is exact enough because both are small; the large numbers
// were cancelled out in double precision before anything reached the GPU.
//
// The same trick places imagery: each tile carries its mapping onto the
// imagery's pixel grid relative to an anchor near the camera, and every
// vertex computes its own Mercator position from its tile coordinates.
//
// All colours here are linear light; present() makes them display values.

struct Tile {
  originRel : vec3f,   // tile origin minus camera position, metres
  level     : f32,     // quadtree level, for the debug view
  rect      : vec4f,   // west, south, east, north, degrees
  heights   : vec2f,   // min, max, metres
  mercX     : vec2f,   // west edge and width, imagery reference pixels
  mercY     : vec3f,   // y(v) = x + y v + z v^2, imagery reference pixels
  mask      : u32,     // quarters drawn by finer children instead: bit 0 east, bit 1 north
};

@group(1) @binding(0) var<uniform> tile : Tile;

struct VSOut {
  @builtin(position) clip   : vec4f,
  @location(0)       world  : vec3f,   // relative to the camera
  @location(1)       normal : vec3f,
  @location(2)       height : f32,
  @location(3)       uv     : vec2f,
  @location(4)       skirt  : f32,
  @location(5)       merc   : vec2f,   // imagery reference pixels from the anchor
  @location(6) @interpolate(flat) mask  : u32,
  @location(7) @interpolate(flat) level : f32,
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
  // Longitude is linear in Mercator; latitude follows the tile's fitted curve.
  let v = uvhs.y;
  out.merc = vec2f(tile.mercX.x + uvhs.x * tile.mercX.y,
                   tile.mercY.x + v * (tile.mercY.y + v * tile.mercY.z));
  out.mask = tile.mask;
  out.level = tile.level;
  return out;
}

// Where no imagery exists: a rough Swiss cross-section by altitude and slope.
// Slope matters as much as altitude, because anything steep enough sheds both
// soil and snow.
fn groundColour(height : f32, slope : f32) -> vec3f {
  let meadow = vec3f(0.0319, 0.0562, 0.0185);
  let forest = vec3f(0.0151, 0.0283, 0.0116);
  let rock   = vec3f(0.0783, 0.0703, 0.0597);
  let scree  = vec3f(0.1357, 0.1246, 0.1072);
  let snow   = vec3f(0.7446, 0.7914, 0.8378);

  var c = mix(meadow, forest, smoothstep(450.0, 900.0, height));
  c = mix(c, scree, smoothstep(1750.0, 2350.0, height));
  c = mix(c, snow, smoothstep(2500.0, 2900.0, height));
  c = mix(c, rock, smoothstep(0.72, 0.42, slope));
  return c;
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  return shade(in, dpdx(in.merc), dpdy(in.merc));
}

// For a tile only partly replaced by finer children: the quarters they cover
// are left to them. Only these few tiles pay for the discard, which would
// otherwise cost every terrain pixel its early depth test.
@fragment
fn fsMasked(in : VSOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is still uniform.
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  return shade(in, dmx, dmy);
}

fn shade(in : VSOut, dmx : vec2f, dmy : vec2f) -> vec4f {
  let photo = sampleImagery(in.merc, dmx, dmy);

  let n = normalize(in.normal);
  let up = localUp(in.world);
  let slope = dot(n, up);
  let modelled = modelledLight(n, up);

  var albedo : vec3f;
  var light = modelled;
  if (frame.debugMode == 1u) {
    albedo = (n * 0.5 + 0.5) * (n * 0.5 + 0.5);
  } else if (frame.debugMode == 2u) {
    let t = clamp(in.height / 4600.0, 0.0, 1.0);
    albedo = vec3f(t, t * t, 1.0 - t) * vec3f(t, t * t, 1.0 - t);
  } else if (frame.debugMode == 4u) {
    albedo = select(vec3f(0.02), levelColour(photo.level), photo.found > 0.0);
  } else if (frame.debugMode == 5u) {
    // Terrain levels: a hue per quadtree level, with each tile outlined.
    let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
    albedo = mix(vec3f(0.01), levelColour(in.level), smoothstep(0.0, 0.01, edge));
  } else {
    albedo = mix(groundColour(in.height, slope), photo.colour, photo.found);
    light = mix(modelled, photoLight(modelled), photo.found);
    if (frame.debugMode == 3u) {
      let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
      albedo = mix(vec3f(0.7874, 0.0509, 0.0331), albedo, smoothstep(0.0, 0.006, edge));
    }
  }

  var colour = albedo * light;

  // Skirt geometry exists only to plug the seams between tiles; darkening it
  // slightly makes any that pokes into view obvious instead of confusing.
  colour *= mix(1.0, 0.72, in.skirt);

  return present(applyFog(colour, in.world), in.clip.xy);
}
