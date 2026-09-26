// frame.wgsl — the per-frame values every pass that draws the world reads,
// and the helpers they share, so terrain, buildings, the sky and whatever
// comes next agree on light, haze and debug colours. Joined after
// atmosphere.wgsl.

struct Frame {
  viewProj     : mat4x4f,   // camera-relative: the eye sits at the origin
  cameraEcef   : vec3f,
  near         : f32,
  sunDir       : vec3f,     // towards the sun, earth-centred axes
  debugMode    : u32,
  east         : vec3f,     // the camera's local axes, earth-centred
  viewDistance : f32,       // metres: nothing farther is drawn
  north        : vec3f,
  cameraR      : f32,       // the eye's distance from the earth's centre, km
  up           : vec3f,
  aerialReach  : f32,       // km the aerial perspective table reaches
  rayRight     : vec3f,     // from screen x to a view ray: right · tan(fov/2) · aspect
  groundR      : f32,       // the ground under the eye, km from the centre
  rayUp        : vec3f,     // from screen y to a view ray: up · tan(fov/2)
  width        : f32,       // render target, pixels
  rayForward   : vec3f,     // where the eye looks
  height       : f32,
  sunLocal     : vec3f,     // towards the sun, in the camera's east-north-up frame
  _pad         : f32,
};

// The light of the moment, worked out by the atmosphere (atmosphere-luts.wgsl)
// in display units: level ground in full sun comes to 1.
struct Light {
  sun   : vec4f,              // sunlight on a surface facing it; w: the exposure
  sky   : array<vec4f, 4>,    // sky and ground light as spherical harmonics, earth-centred
  level : vec4f,              // all the light on level ground
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(0) @binding(1) var lutSampler : sampler;
@group(0) @binding(2) var transmittanceLut : texture_2d<f32>;
@group(0) @binding(3) var skyViewLut : texture_2d<f32>;
@group(0) @binding(4) var aerialLut : texture_3d<f32>;
@group(0) @binding(5) var<storage, read> light : Light;

// Local up at a camera-relative position. Absolute position only to get a
// direction, which float32 is plenty for.
fn localUp(world : vec3f) -> vec3f {
  return normalize(frame.cameraEcef + world);
}

// ---- light ----

// Sunlight on a surface, coloured by the air it came through.
fn sunLight(n : vec3f) -> vec3f {
  return light.sun.rgb * max(dot(n, frame.sunDir), 0.0);
}

// Light from the whole sky, and from the ground for surfaces facing it.
fn skyLight(n : vec3f) -> vec3f {
  let s = light.sky;
  return max(s[0].rgb + s[1].rgb * n.x + s[2].rgb * n.y + s[3].rgb * n.z, vec3f(0.0));
}

fn modelledLight(n : vec3f) -> vec3f {
  return sunLight(n) + skyLight(n);
}

// A photograph already holds the real sun and its shadows. Lighting it again
// would darken every shaded slope twice, so level ground shows exactly as
// photographed and slopes take a quarter of the relief the model gives them.
fn photoLight(n : vec3f) -> vec3f {
  return mix(vec3f(1.0), modelledLight(n) / max(light.level.rgb, vec3f(1e-3)), 0.25);
}

// ---- sky ----

// The sky's radiance in a direction, per unit of sunlight, from the table
// made for the camera's height.
fn skyRadiance(dir : vec3f) -> vec3f {
  let l = vec3f(dot(dir, frame.east), dot(dir, frame.north), dot(dir, frame.up));
  let r = clamp(frame.cameraR, BOTTOM + 0.002, TOP - 0.01);
  let horizonMu = -sqrt(max(0.0, 1.0 - (BOTTOM * BOTTOM) / (r * r)));
  let flatView = length(l.xy);
  let flatSun = length(frame.sunLocal.xy);
  var sunViewCos = 1.0;
  if (flatView > 1e-5 && flatSun > 1e-5) { sunViewCos = dot(l.xy, frame.sunLocal.xy) / (flatView * flatSun); }
  let uv = skyViewUv(r, l.z, sunViewCos, l.z < horizonMu);
  return textureSampleLevel(skyViewLut, lutSampler, uv, 0.0).rgb;
}

// What a mirror facing `r` shows: the sky above the horizon, dim ground
// below it. For glass and, later, water.
fn skyReflection(r : vec3f, up : vec3f) -> vec3f {
  let sky = skyRadiance(r) * light.sun.w;
  let ground = light.level.rgb * 0.12;
  return mix(sky, ground, smoothstep(0.0, -0.12, dot(r, up)));
}

// ---- haze ----

// The air between the eye and a point: the light it scatters in is added,
// and the point shows through as much as the air lets it. Where the view
// distance cuts the world short, the last stretch fades into the sky behind.
fn applyAtmosphere(colour : vec3f, world : vec3f, pixel : vec2f) -> vec3f {
  let d = length(world);
  let uv = pixel / vec2f(frame.width, frame.height);
  let ap = textureSampleLevel(aerialLut, lutSampler, vec3f(uv, aerialSlice(d * 0.001, frame.aerialReach)), 0.0);
  var c = colour * ap.a + ap.rgb * light.sun.w;
  let fade = smoothstep(0.7 * frame.viewDistance, frame.viewDistance, d);
  if (fade > 0.0) { c = mix(c, skyRadiance(world / d) * light.sun.w, fade); }
  return c;
}

// ---- debug views ----

// A distinct hue per level.
fn levelColour(level : f32) -> vec3f {
  let h = fract(level * 0.137);
  let k = vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0);
  let rgb = clamp(abs(fract(vec3f(h) + k) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return rgb * rgb * 0.6 + 0.02;
}
