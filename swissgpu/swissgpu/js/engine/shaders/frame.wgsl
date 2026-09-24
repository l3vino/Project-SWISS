// frame.wgsl — the per-frame values every scene pass reads, and the few
// helpers they share, so terrain, buildings and whatever comes next agree on
// lighting, haze and debug colours. Joined after common.wgsl.

struct Frame {
  viewProj    : mat4x4f,   // camera-relative: the eye sits at the origin
  cameraEcef  : vec3f,
  near        : f32,
  sunDir      : vec3f,     // towards the sun, earth-centred axes
  debugMode   : u32,
  horizon     : vec3f,     // linear light, the sky's colour at the horizon
  fogDensity  : f32,
};

@group(0) @binding(0) var<uniform> frame : Frame;

// Local up at a camera-relative position. Absolute position only to get a
// direction, which float32 is plenty for.
fn localUp(world : vec3f) -> vec3f {
  return normalize(frame.cameraEcef + world);
}

// Sun on a surface plus sky fill from above and a dim bounce, so faces turned
// away from the sun read as shape rather than as black holes.
fn modelledLight(n : vec3f, up : vec3f) -> f32 {
  let sun = max(dot(n, frame.sunDir), 0.0);
  let ambient = 0.28 + 0.22 * max(dot(n, up), 0.0);
  return sun * 1.35 + ambient;
}

// A photograph already contains the real sun and its shadows. Lighting it
// fully again would darken every shaded slope twice, so photographed surfaces
// take only a quarter of the modelled light, enough to keep relief readable.
fn photoLight(modelled : f32) -> f32 {
  return mix(1.0, modelled, 0.25);
}

// Distance haze towards the horizon colour the sky uses, so ground and sky
// meet rather than butt against each other.
fn applyFog(colour : vec3f, world : vec3f) -> vec3f {
  let fog = 1.0 - exp(-length(world) * frame.fogDensity);
  return mix(colour, frame.horizon, clamp(fog, 0.0, 1.0));
}

// Debug views: a distinct hue per level.
fn levelColour(level : f32) -> vec3f {
  let h = fract(level * 0.137);
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let rgb = clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return rgb * rgb * 0.6 + 0.02;
}
