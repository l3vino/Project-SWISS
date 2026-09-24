// common.wgsl — what every pass that writes to the screen shares.
//
// Shading happens in linear light. Colours only become display values here,
// at the very end: compress the range, then encode to sRGB, then dither
// before the 8-bit store so smooth gradients do not band.

// Reinhard-Jodie: cheap, keeps highlights from clipping to white and keeps
// saturated colours from shifting hue the way per-channel Reinhard does.
fn tonemap(c : vec3f) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let tc = c / (c + 1.0);
  return mix(c / (l + 1.0), tc, tc);
}

// The exact sRGB transfer function, not a 2.2 approximation, so photographs
// decoded by an -srgb texture come back out as the same values.
fn encodeSrgb(c : vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let lo = x * 12.92;
  let hi = 1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, x <= vec3f(0.0031308));
}

// Scene colour in, final pixel out. `exposure` lifts linear values so the
// tone curve's shoulder does not darken everything below white.
fn present(linear : vec3f, pixel : vec2f) -> vec4f {
  let exposure = 1.2;
  let p = vec2u(pixel);
  let dither = (f32((p.x * 7u + p.y * 23u) & 15u) / 15.0 - 0.5) / 255.0;
  return vec4f(encodeSrgb(tonemap(linear * exposure)) + dither, 1.0);
}
