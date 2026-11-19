// sky.wgsl — the sky: in each direction, what the atmosphere's sky view
// table holds for the camera's height, and the sun's disc. Joined after
// common.wgsl, atmosphere.wgsl and frame.wgsl. Colours are linear light;
// present() encodes them.
//
// Drawn as a single oversized triangle rather than a quad: one primitive, no
// shared edge down the middle, and the rasteriser clips the excess for free.
// It writes no depth, so it costs one full-screen fill and nothing else.

struct VSOut {
  @builtin(position) pos : vec4f,
  @location(0)       ndc : vec2f,
};

@vertex
fn vs(@builtin(vertex_index) i : u32) -> VSOut {
  // (0,0) (2,0) (0,2) in UV space -> a triangle covering the whole viewport.
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out : VSOut;
  out.ndc = uv * 2.0 - 1.0;
  out.pos = vec4f(out.ndc, 0.0, 1.0);
  return out;
}

// A unit of sunlight spread over the sun's disc.
const SUN_RADIANCE : f32 = 1.0 / (2.0 * PI * (1.0 - SUN_COS_RADIUS));

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  let dir = normalize(frame.rayForward + in.ndc.x * frame.rayRight + in.ndc.y * frame.rayUp);
  var col = skyRadiance(dir);

  // The sun, dimmed by the air in front of it, darker towards its rim.
  let c = dot(dir, frame.sunDir);
  if (c > SUN_COS_RADIUS) {
    let r = clamp(frame.cameraR, BOTTOM + 0.002, TOP - 0.01);
    let t = textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(r, dot(dir, frame.up)), 0.0).rgb;
    let rim = clamp((1.0 - c) / (1.0 - SUN_COS_RADIUS), 0.0, 1.0);
    let limb = 1.0 - 0.6 * (1.0 - sqrt(1.0 - rim));
    col += t * limb * SUN_RADIANCE;
  }
  return present(col * light.sun.w, in.pos.xy);
}
