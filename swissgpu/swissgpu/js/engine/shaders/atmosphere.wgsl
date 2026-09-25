// atmosphere.wgsl — one model of the air, for the sky, the light and the
// haze. Only functions and constants: each pass that uses them declares its
// own bindings (frame.wgsl for drawing, atmosphere-luts.wgsl for the tables).
//
// This is Sébastien Hillaire's method ("A Scalable and Production Ready Sky
// and Atmosphere Rendering Technique", EGSR 2020), the one Unreal Engine
// uses: the air as Rayleigh scattering (the blue of the sky), Mie scattering
// (haze, and the glow around the sun) and ozone absorption, each with a
// density that falls off with height, over a spherical earth. A few small
// tables stand in for the integrals, which is what makes it cheap:
//
//   transmittance     256 × 64      how much light survives a straight path
//                                   out of the air, by height and angle
//   multiple scatter   32 × 32      light scattered more than once, by height
//                                   and the sun's angle
//   sky view          192 × 108     the sky around the camera, by direction
//   aerial             32 × 32 × 32 the haze between the camera and every
//   perspective                     point in view: the light it adds and how
//                                   much of the point shows through
//
// Distances are in kilometres. Positions are relative to the earth's centre
// in a frame whose z is up at the camera; radiance is per unit of sunlight
// arriving at the top of the air.

const PI : f32 = 3.14159265358979;

const BOTTOM : f32 = 6360.0;      // sea level, km from the centre
const TOP    : f32 = 6460.0;      // where the air ends, as far as light cares

const RAYLEIGH_SCATTERING = vec3f(5.802e-3, 13.558e-3, 33.1e-3);   // per km at sea level
const RAYLEIGH_HEIGHT     : f32 = 8.0;                                 // km
const MIE_SCATTERING      = vec3f(3.996e-3);
const MIE_EXTINCTION      = vec3f(4.440e-3);
const MIE_HEIGHT          : f32 = 1.2;
const MIE_G               : f32 = 0.8;
const OZONE_ABSORPTION    = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
const GROUND_ALBEDO       = vec3f(0.3);

// The sun: a disc a little over half a degree across.
const SUN_COS_RADIUS : f32 = 0.99998918;    // cos 0.2665°

struct Medium {
  scattering : vec3f,
  extinction : vec3f,
  rayleigh   : vec3f,
  mie        : vec3f,
};

// What the air is like `h` km above sea level.
fn medium(h : f32) -> Medium {
  let hh = max(h, 0.0);
  let rd = exp(-hh / RAYLEIGH_HEIGHT);
  let md = exp(-hh / MIE_HEIGHT);
  // Ozone lies in a layer peaking 25 km up, 30 km thick.
  let od = max(0.0, 1.0 - abs(hh - 25.0) / 15.0);
  var m : Medium;
  m.rayleigh = RAYLEIGH_SCATTERING * rd;
  m.mie = MIE_SCATTERING * md;
  m.scattering = m.rayleigh + m.mie;
  m.extinction = m.rayleigh + MIE_EXTINCTION * md + OZONE_ABSORPTION * od;
  return m;
}

fn rayleighPhase(c : f32) -> f32 {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Cornette-Shanks: a closer fit to real haze than plain Henyey-Greenstein.
fn miePhase(c : f32) -> f32 {
  let g = MIE_G;
  let k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}

// Distance along a ray from `o` in direction `d` to a sphere of radius r
// around the centre: the nearest crossing ahead, or -1 if there is none.
fn raySphere(o : vec3f, d : vec3f, r : f32) -> f32 {
  let b = dot(o, d);
  let c = dot(o, o) - r * r;
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  let s = sqrt(disc);
  if (-b - s >= 0.0) { return -b - s; }
  if (-b + s >= 0.0) { return -b + s; }
  return -1.0;
}

// ---- where things are in the tables ----

// Keeps samples off the outer half-texels, so lookups at the ends of a
// table's range read its first and last values rather than a blend with the
// clamp.
fn toSub(u : f32, size : f32) -> f32 { return (u + 0.5 / size) * (size / (size + 1.0)); }
fn fromSub(u : f32, size : f32) -> f32 { return (u - 0.5 / size) * (size / (size - 1.0)); }

// Transmittance, after Bruneton: height r and the cosine mu of the angle
// from straight up, to texture coordinates, spending texels where the answer
// changes fastest (near the horizon).
fn transmittanceUv(r : f32, mu : f32) -> vec2f {
  let H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  let rho = sqrt(max(0.0, r * r - BOTTOM * BOTTOM));
  let disc = r * r * (mu * mu - 1.0) + TOP * TOP;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = TOP - r;
  let dMax = rho + H;
  return vec2f((d - dMin) / (dMax - dMin), rho / H);
}

fn transmittanceParams(uv : vec2f) -> vec2f {
  let H = sqrt(TOP * TOP - BOTTOM * BOTTOM);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + BOTTOM * BOTTOM);
  let dMin = TOP - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0); }
  return vec2f(r, mu);
}

// Multiple scattering: the sun's cosine across, height up.
fn multiScatterUv(r : f32, sunMu : f32) -> vec2f {
  return vec2f(toSub(sunMu * 0.5 + 0.5, 32.0), toSub(clamp((r - BOTTOM) / (TOP - BOTTOM), 0.0, 1.0), 32.0));
}

// The sky view: across, the angle round from the sun (squared, so there are
// more texels near it); up, the angle from the zenith, squashed towards the
// horizon from both sides, where the sky changes fastest.
fn skyViewUv(r : f32, viewMu : f32, sunViewCos : f32, towardsGround : bool) -> vec2f {
  let horizonDist = sqrt(max(r * r - BOTTOM * BOTTOM, 0.0));
  let beta = acos(clamp(horizonDist / r, -1.0, 1.0));
  let zenithHorizon = PI - beta;
  let angle = acos(clamp(viewMu, -1.0, 1.0));
  var v : f32;
  if (!towardsGround) {
    let c = clamp(angle / zenithHorizon, 0.0, 1.0);
    v = (1.0 - sqrt(1.0 - c)) * 0.5;
  } else {
    let c = clamp((angle - zenithHorizon) / beta, 0.0, 1.0);
    v = sqrt(c) * 0.5 + 0.5;
  }
  let u = sqrt(clamp(-sunViewCos * 0.5 + 0.5, 0.0, 1.0));
  return vec2f(toSub(u, 192.0), toSub(v, 108.0));
}

// A direction in the frame at the camera (z up), from a sky view texel.
struct SkyViewDir {
  viewMu     : f32,
  sunViewCos : f32,
};

fn skyViewParams(r : f32, uv : vec2f) -> SkyViewDir {
  let u = fromSub(uv.x, 192.0);
  let v = fromSub(uv.y, 108.0);
  let horizonDist = sqrt(max(r * r - BOTTOM * BOTTOM, 0.0));
  let beta = acos(clamp(horizonDist / r, -1.0, 1.0));
  let zenithHorizon = PI - beta;
  var out : SkyViewDir;
  if (v < 0.5) {
    let c = 1.0 - 2.0 * v;
    out.viewMu = cos(zenithHorizon * (1.0 - c * c));
  } else {
    let c = v * 2.0 - 1.0;
    out.viewMu = cos(zenithHorizon + beta * c * c);
  }
  out.sunViewCos = -(u * u * 2.0 - 1.0);
  return out;
}

// Aerial perspective slices are spaced by the square of their number, so the
// near ones, where haze changes fastest, are the thinnest.
const AERIAL_SLICES : f32 = 32.0;

fn aerialDepth(slice : f32, reach : f32) -> f32 {
  let w = slice / AERIAL_SLICES;
  return w * w * reach;
}

fn aerialSlice(distance : f32, reach : f32) -> f32 {
  return sqrt(clamp(distance / reach, 0.0, 1.0));
}
