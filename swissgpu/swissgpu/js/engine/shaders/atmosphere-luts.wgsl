// atmosphere-luts.wgsl — the compute passes that fill the atmosphere's tables
// and work out the light everything is lit by. Joined after atmosphere.wgsl
// and frame.wgsl, whose uniform, sampler and transmittance table it reads.
//
// Transmittance and multiple scattering depend only on the air, so they are
// made once. The sky view depends on the camera's height and the sun, the
// aerial perspective on where the camera looks, and the light on the sun and
// the ground below: those are redone as they change, a fraction of a
// millisecond each.

@group(0) @binding(6) var multiScatterLut : texture_2d<f32>;

@group(1) @binding(0) var transmittanceOut : texture_storage_2d<rgba16float, write>;
@group(1) @binding(1) var multiScatterOut : texture_storage_2d<rgba16float, write>;
@group(1) @binding(2) var skyViewOut : texture_storage_2d<rgba16float, write>;
@group(1) @binding(3) var aerialOut : texture_storage_3d<rgba16float, write>;
@group(1) @binding(4) var<storage, read_write> lightOut : Light;

fn transmittanceTo(r : f32, mu : f32) -> vec3f {
  return textureSampleLevel(transmittanceLut, lutSampler, transmittanceUv(r, mu), 0.0).rgb;
}

fn multiScatter(r : f32, sunMu : f32) -> vec3f {
  return textureSampleLevel(multiScatterLut, lutSampler, multiScatterUv(r, sunMu), 0.0).rgb;
}

// Where the camera is, for the tables: never below the ground or above the
// top of the air, which the tables are not made for.
fn clampR(r : f32) -> f32 {
  return clamp(r, BOTTOM + 0.002, TOP - 0.01);
}

// Light scattered towards the eye along a ray through the air, and how much
// of what lies beyond comes through: the one integral every table is made of.
struct Scattered {
  light      : vec3f,
  throughput : vec3f,
  multiAsOne : vec3f,   // for the multiple-scattering table only
};

// Marches `steps` samples from o along d for `dist` km, towards the eye at o.
// `sun` points to the sun. Includes the light scattered more than once, from
// the multiple-scattering table.
fn scatter(o : vec3f, d : vec3f, dist : f32, steps : i32, sun : vec3f) -> Scattered {
  var out = Scattered(vec3f(0.0), vec3f(1.0), vec3f(0.0));
  let cosTheta = dot(d, sun);
  let phaseR = rayleighPhase(cosTheta);
  let phaseM = miePhase(cosTheta);
  let dt = dist / f32(steps);
  for (var i = 0; i < steps; i++) {
    let x = o + d * ((f32(i) + 0.3) * dt);
    let h = max(sqrt(dot(x, x)), BOTTOM);
    let up = x / h;
    let m = medium(h - BOTTOM);
    let sunMu = dot(sun, up);
    // The earth's own shadow: no direct sun below its horizon.
    let lit = select(1.0, 0.0, raySphere(x, sun, BOTTOM) > 0.0);
    let s = lit * transmittanceTo(h, sunMu) * (m.rayleigh * phaseR + m.mie * phaseM)
          + multiScatter(h, sunMu) * m.scattering;
    // Exact over the step for the light, given constant air within it.
    let stepT = exp(-m.extinction * dt);
    let ext = max(m.extinction, vec3f(1e-7));
    out.light += out.throughput * (s - s * stepT) / ext;
    out.throughput *= stepT;
  }
  return out;
}

// The same for making the multiple-scattering table itself, which cannot
// read it: single scattering with light spread evenly in every direction,
// and how much of the light scattered at all reaches the eye.
fn scatterOnce(o : vec3f, d : vec3f, dist : f32, steps : i32, sun : vec3f) -> Scattered {
  var out = Scattered(vec3f(0.0), vec3f(1.0), vec3f(0.0));
  let phase = 1.0 / (4.0 * PI);
  let dt = dist / f32(steps);
  for (var i = 0; i < steps; i++) {
    let x = o + d * ((f32(i) + 0.3) * dt);
    let h = max(sqrt(dot(x, x)), BOTTOM);
    let m = medium(h - BOTTOM);
    let lit = select(1.0, 0.0, raySphere(x, sun, BOTTOM) > 0.0);
    let s = lit * transmittanceTo(h, dot(sun, x / h)) * m.scattering * phase;
    let stepT = exp(-m.extinction * dt);
    let ext = max(m.extinction, vec3f(1e-7));
    out.light += out.throughput * (s - s * stepT) / ext;
    out.multiAsOne += out.throughput * (m.scattering - m.scattering * stepT) / ext;
    out.throughput *= stepT;
  }
  return out;
}

// How far a ray from o along d stays in the air: to the ground if it hits it,
// otherwise to the top.
fn airLength(o : vec3f, d : vec3f) -> f32 {
  let ground = raySphere(o, d, BOTTOM);
  if (ground > 0.0) { return ground; }
  return max(raySphere(o, d, TOP), 0.0);
}

// ---- transmittance: once ------------------------------------------------------

@compute @workgroup_size(8, 8)
fn transmittance(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= 256u || id.y >= 64u) { return; }
  let p = transmittanceParams((vec2f(id.xy) + 0.5) / vec2f(256.0, 64.0));
  let o = vec3f(0.0, 0.0, p.x);
  let d = vec3f(sqrt(max(0.0, 1.0 - p.y * p.y)), 0.0, p.y);
  let dist = max(raySphere(o, d, TOP), 0.0);
  let steps = 40;
  let dt = dist / f32(steps);
  var depth = vec3f(0.0);
  for (var i = 0; i < steps; i++) {
    let x = o + d * ((f32(i) + 0.5) * dt);
    depth += medium(sqrt(dot(x, x)) - BOTTOM).extinction * dt;
  }
  textureStore(transmittanceOut, id.xy, vec4f(exp(-depth), 1.0));
}

// ---- multiple scattering: once --------------------------------------------------
// Hillaire's section 5.5: for each height and sun angle, the light reaching a
// point after one more bounce, gathered from 64 directions by one workgroup,
// summed as the geometric series of every further bounce.

var<workgroup> gatherLight : array<vec3f, 64>;
var<workgroup> gatherMulti : array<vec3f, 64>;

// Evenly spread directions over the sphere.
fn fibonacciSphere(i : u32, n : u32) -> vec3f {
  let z = 1.0 - (2.0 * f32(i) + 1.0) / f32(n);
  let r = sqrt(max(0.0, 1.0 - z * z));
  let phi = f32(i) * 2.39996323;
  return vec3f(r * cos(phi), r * sin(phi), z);
}

@compute @workgroup_size(64)
fn multipleScattering(@builtin(workgroup_id) wg : vec3u, @builtin(local_invocation_index) i : u32) {
  let uv = (vec2f(wg.xy) + 0.5) / 32.0;
  let sunMu = fromSub(uv.x, 32.0) * 2.0 - 1.0;
  let r = BOTTOM + clamp(fromSub(uv.y, 32.0), 0.0, 1.0) * (TOP - BOTTOM) + 0.002;
  let o = vec3f(0.0, 0.0, min(r, TOP - 0.01));
  let sun = vec3f(sqrt(max(0.0, 1.0 - sunMu * sunMu)), 0.0, sunMu);
  let d = fibonacciSphere(i, 64u);

  let ground = raySphere(o, d, BOTTOM);
  let s = scatterOnce(o, d, airLength(o, d), 20, sun);
  var l = s.light;
  // Where the ray meets the ground, the ground lit by the sun reflects some.
  if (ground > 0.0) {
    let x = o + d * ground;
    let up = normalize(x);
    l += s.throughput * transmittanceTo(BOTTOM, dot(sun, up)) * max(dot(up, sun), 0.0) * GROUND_ALBEDO / PI;
  }
  gatherLight[i] = l;
  gatherMulti[i] = s.multiAsOne;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (i < stride) {
      gatherLight[i] += gatherLight[i + stride];
      gatherMulti[i] += gatherMulti[i + stride];
    }
    workgroupBarrier();
  }
  if (i == 0u) {
    // Averages over the sphere: an isotropic phase times the full solid angle.
    let second = gatherLight[0] / 64.0;
    let f = gatherMulti[0] / 64.0;
    textureStore(multiScatterOut, wg.xy, vec4f(second / (1.0 - f), 1.0));
  }
}

// ---- sky view: when the camera's height or the sun changes ----------------------

@compute @workgroup_size(8, 8)
fn skyView(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= 192u || id.y >= 108u) { return; }
  let r = clampR(frame.cameraR);
  let p = skyViewParams(r, (vec2f(id.xy) + 0.5) / vec2f(192.0, 108.0));
  let sinView = sqrt(max(0.0, 1.0 - p.viewMu * p.viewMu));
  let sinAz = sqrt(max(0.0, 1.0 - p.sunViewCos * p.sunViewCos));
  let d = vec3f(sinView * p.sunViewCos, sinView * sinAz, p.viewMu);
  let sunMu = frame.sunLocal.z;
  let sun = vec3f(sqrt(max(0.0, 1.0 - sunMu * sunMu)), 0.0, sunMu);
  let o = vec3f(0.0, 0.0, r);
  let s = scatter(o, d, airLength(o, d), 30, sun);
  textureStore(skyViewOut, id.xy, vec4f(s.light, 1.0));
}

// ---- aerial perspective: every frame ------------------------------------------------
// One ray per column of froxels, marched slice by slice, each slice storing
// the light scattered in so far and how much of what lies there comes through.

@compute @workgroup_size(8, 8)
fn aerial(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= 32u || id.y >= 32u) { return; }
  let ndc = vec2f((f32(id.x) + 0.5) / 32.0 * 2.0 - 1.0, 1.0 - (f32(id.y) + 0.5) / 32.0 * 2.0);
  let world = normalize(frame.rayForward + ndc.x * frame.rayRight + ndc.y * frame.rayUp);
  let d = vec3f(dot(world, frame.east), dot(world, frame.north), dot(world, frame.up));
  let r = clampR(frame.cameraR);
  let o = vec3f(0.0, 0.0, r);
  let sunL = frame.sunLocal;
  let cosTheta = dot(d, sunL);
  let phaseR = rayleighPhase(cosTheta);
  let phaseM = miePhase(cosTheta);
  var light = vec3f(0.0);
  var throughput = vec3f(1.0);
  var t = 0.0;
  for (var k = 0u; k < 32u; k++) {
    let end = aerialDepth(f32(k) + 0.5, frame.aerialReach);
    // Two samples per slice: slices far out are kilometres deep.
    let dt = (end - t) * 0.5;
    for (var j = 0; j < 2; j++) {
      let x = o + d * (t + (f32(j) + 0.5) * dt);
      let h = max(sqrt(dot(x, x)), BOTTOM);
      let up = x / h;
      let m = medium(h - BOTTOM);
      let sunMu = dot(sunL, up);
      let lit = select(1.0, 0.0, raySphere(x, sunL, BOTTOM) > 0.0);
      let s = lit * transmittanceTo(h, sunMu) * (m.rayleigh * phaseR + m.mie * phaseM)
            + multiScatter(h, sunMu) * m.scattering;
      let stepT = exp(-m.extinction * dt);
      let ext = max(m.extinction, vec3f(1e-7));
      light += throughput * (s - s * stepT) / ext;
      throughput *= stepT;
    }
    t = end;
    textureStore(aerialOut, vec3u(id.xy, k), vec4f(light, dot(throughput, vec3f(1.0 / 3.0))));
  }
}

// ---- the light: when the sun or the ground below changes -----------------------
// Sunlight arriving at the ground under the camera, and the light from the
// sky and from the ground around, as first-order spherical harmonics in
// earth-centred axes, so shaders evaluate them with their normals as they
// are. Exposure is set so level ground in full sun comes out at 1: aerial
// photos then show exactly as photographed.

var<workgroup> gatherSh : array<array<vec3f, 4>, 64>;

@compute @workgroup_size(64)
fn ambient(@builtin(local_invocation_index) i : u32) {
  let r = clampR(frame.groundR);
  let o = vec3f(0.0, 0.0, r);
  let sunL = frame.sunLocal;
  let sunT = transmittanceTo(r, sunL.z);
  let d = fibonacciSphere(i, 64u);
  let ground = raySphere(o, d, BOTTOM);
  var l : vec3f;
  if (ground > 0.0 || d.z < 0.0) {
    // The ground around, lit by the sun and the sky: an albedo of 0.2.
    l = vec3f(0.2) * sunT * max(sunL.z, 0.0) / PI * 1.25;
  } else {
    l = scatter(o, d, airLength(o, d), 24, sunL).light;
  }
  let w = frame.east * d.x + frame.north * d.y + frame.up * d.z;
  let solid = 4.0 * PI / 64.0;
  gatherSh[i][0] = l * (0.282095 * solid);
  gatherSh[i][1] = l * (0.488603 * w.x * solid);
  gatherSh[i][2] = l * (0.488603 * w.y * solid);
  gatherSh[i][3] = l * (0.488603 * w.z * solid);
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (i < stride) {
      for (var k = 0; k < 4; k++) { gatherSh[i][k] += gatherSh[i + stride][k]; }
    }
    workgroupBarrier();
  }
  if (i == 0u) {
    // Radiance coefficients to irradiance ones (Ramamoorthi and Hanrahan):
    // E(n) = c0 + c1 . n, for the cosine-weighted hemisphere around n.
    let c0 = gatherSh[0][0] * (PI * 0.282095);
    let k1 = 2.0 * PI / 3.0 * 0.488603;
    let c1 = gatherSh[0][1] * k1;
    let c2 = gatherSh[0][2] * k1;
    let c3 = gatherSh[0][3] * k1;
    let up = frame.up;
    let skyUp = max(c0 + c1 * up.x + c2 * up.y + c3 * up.z, vec3f(0.0));
    let level = sunT * max(sunL.z, 0.0) + skyUp;
    let exposure = PI / max(dot(level, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
    let k = exposure / PI;
    lightOut.sun = vec4f(sunT * k, exposure);
    lightOut.sky[0] = vec4f(c0 * k, 0.0);
    lightOut.sky[1] = vec4f(c1 * k, 0.0);
    lightOut.sky[2] = vec4f(c2 * k, 0.0);
    lightOut.sky[3] = vec4f(c3 * k, 0.0);
    lightOut.level = vec4f(level * k, 1.0);
  }
}
