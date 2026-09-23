// sky.wgsl — placeholder gradient, and the seat the atmosphere takes in step 3.
//
// Drawn as a single oversized triangle rather than a quad: one primitive, no
// shared edge down the middle, and the rasteriser clips the excess for free.
// It writes no depth, so it costs one full-screen fill and nothing else.

struct Frame {
  resolution : vec2f,
  time       : f32,
  sunElev    : f32,   // radians above the horizon
};

@group(0) @binding(0) var<uniform> frame : Frame;

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0)        uv : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  // (0,0) (2,0) (0,2) in UV space -> a triangle covering the whole viewport.
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out : VSOut;
  out.uv = uv;
  out.pos = vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
  return out;
}

// Rec.709 luminance-preserving conversion out of linear light.
fn tonemap(c : vec3f) -> vec3f {
  // Reinhard-Jodie: cheap, keeps highlights from clipping to white.
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let tc = c / (c + 1.0);
  return mix(c / (l + 1.0), tc, tc);
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  // uv.y is 0 at the top of the screen.
  let h = 1.0 - in.uv.y;

  let zenith  = vec3f(0.075, 0.16, 0.38);
  // Shared with the terrain's fog colour, so ground fades into sky rather than
  // meeting it at a line.
  let horizon = vec3f(0.52, 0.62, 0.72);

  // No painted ground. Terrain covers everything below the horizon, and where
  // it has not streamed in yet the gap should read as distance, not as a hole.
  var col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.55));

  let aspect = frame.resolution.x / frame.resolution.y;
  let sunDir = vec2f(0.72, 0.42 + sin(frame.sunElev) * 0.12);
  let d = distance(in.uv * vec2f(aspect, 1.0), sunDir * vec2f(aspect, 1.0));
  col += vec3f(1.0, 0.86, 0.66) * exp(-d * 9.0) * 0.3;

  // Ordered dither before the 8-bit store, so the gradient has no banding.
  let p = vec2u(in.pos.xy);
  let dither = (f32((p.x * 7u + p.y * 23u) & 15u) / 15.0 - 0.5) / 255.0;

  return vec4f(tonemap(col) + dither, 1.0);
}
