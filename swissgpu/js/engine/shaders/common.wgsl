// common.wgsl — what every pass that writes to the screen shares.
//
// Shading happens in linear light. Colours only become display values here,
// at the very end: roll off the highlights, then encode to sRGB, then dither
// before the 8-bit store so smooth gradients do not band.

// The highlight shoulder of Khronos's PBR Neutral tone mapper, without its
// toe: every colour whose brightest channel is below 0.8 comes out exactly as
// it went in, so aerial photographs look as photographed and painted walls
// keep their paint; brighter ones (the sun, its glare, glass catching it)
// roll off smoothly to white, losing a little saturation as they go, the way
// film does.
fn tonemap(c : vec3f) -> vec3f {
  let start = 0.8;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return c; }
  let d = 1.0 - start;
  let newPeak = 1.0 - d * d / (peak + d - start);
  let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
  return mix(c * (newPeak / peak), vec3f(newPeak), g);
}

// The exact sRGB transfer function, not a 2.2 approximation, so photographs
// decoded by an -srgb texture come back out as the same values.
fn encodeSrgb(c : vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

// Scene colour in, final pixel out. Exposure has already been applied: the
// atmosphere sets it so that level ground in full sun comes to 1.
fn present(linear : vec3f, pixel : vec2f) -> vec4f {
  let p = vec2u(pixel);
  let dither = (f32((p.x * 7u + p.y * 23u) & 15u) / 15.0 - 0.5) / 255.0;
  return vec4f(encodeSrgb(tonemap(max(linear, vec3f(0.0)))) + dither, 1.0);
}
