// path.wgsl — a search flight's path, drawn in the world (js/engine/passes/path.js).
// Joined after common.wgsl, atmosphere.wgsl and frame.wgsl.
//
// A blue glass tube along the way still ahead, with brighter beads on it
// every so often (Stage 5.5, his words: "more of a blue transparent
// continuous lines with some points, and make it feel like it's in the
// world"; Stage 5.6: "more transparent", and the camera flies down its
// middle, so you look along the tube curving away). In the world means: its thickness is in metres (plan.js, LINE:
// a share of the height above the ground there), so it thins with distance
// like everything else; it is lit by the sun and the sky as a cylinder, its
// rim brighter and more opaque than its middle, as glass is (Fresnel); and
// the air hazes it like the terrain behind it (applyAtmosphere). Where it is
// thinner than a few pixels the cylinder no longer shows, only its rim's
// sheen, so it is drawn as a thread as opaque and light as a rim; thinner
// than its least width it is drawn that wide and only as opaque as the share
// it covers (Persson, "Phone-wire AA", 2012), but never fainter than
// COVER_LEAST, so the way stays readable to its end. Mountains and buildings
// hide it, but it shows faintly through them, dashed (Mapbox's
// line-occlusion-opacity), so the way stays readable. Near the eye it fades
// out, so the camera, which flies along it, never looks through its inside.
//
// One quad per segment, pushed apart on the screen across the path, its
// ends turned to the joint's mean direction so the segments meet without a
// gap or an overlap; an end behind the eye is moved along its segment onto
// the near plane. No vertex buffers. A late move of the end (flight.js) is
// already in the points: render.js puts the line on the earth again when
// one comes.

struct Path {
  originRel : vec3f,   // the first point minus the camera, metres
  now       : f32,     // the flight's time, seconds
  colour    : vec3f,   // the glass, linear
  alpha     : f32,     // the whole line's opacity (faded in and out)
  ahead     : f32,     // seconds before the flight reaches a point that it fades out over
  minWidth  : f32,     // pixels: never drawn thinner
  hidden    : f32,     // opacity behind things
  beadEvery : f32,     // points from one bead to the next
  count     : f32,     // points
  far       : f32,     // metres: faded out towards this
  scale     : f32,     // render pixels per CSS pixel
  nearFrom  : f32,     // radii from the eye: hidden this close,
  nearTo    : f32,     // and whole from this far
};

@group(1) @binding(0) var<uniform> path : Path;
@group(1) @binding(1) var<storage, read> points : array<vec4f>;   // per point: (offset, time), (radius, σ, -, -)

const DASHES = 3.0;                 // dashes behind things, per height (σ) along
const COVER_LEAST = 0.35;           // a line or bead thinner than its least width: never fainter than this share
const THREAD = vec2f(1.0, 4.0);     // half widths, pixels: a thread up to the first, a tube from the second
const THREAD_RIM = 0.55;            // how much of a rim a thread looks
const BEAD_SIZE = 1.6;              // a bead's radius, in the tube's
const BEAD_NEAR = 2.0;              // a bead fades out this many times further from the eye than the tube
const BEAD_ALPHA = 0.6;             // a bead's opacity
const GLASS = vec2f(0.12, 0.4);     // the glass's opacity: face on, and added towards the rim (rim^1.5)
const OFF_SCREEN = vec4f(2.0, 2.0, 0.0, 1.0);

struct Point {
  at     : vec3f,    // camera-relative
  time   : f32,
  radius : f32,
  sigma  : f32,
};

fn pointAt(i : u32) -> Point {
  let a = points[2u * i];
  let b = points[2u * i + 1u];
  var p : Point;
  p.at = path.originRel + a.xyz;
  p.time = a.w;
  p.radius = b.x;
  p.sigma = b.y;
  return p;
}

// From a to b by k.
fn between(a : Point, b : Point, k : f32) -> Point {
  var p : Point;
  p.at = mix(a.at, b.at, k);
  p.time = mix(a.time, b.time, k);
  p.radius = mix(a.radius, b.radius, k);
  p.sigma = mix(a.sigma, b.sigma, k);
  return p;
}

// How visible the line is at time `t`, `d` metres from the eye, where its
// radius is `r` metres; `nearer` scales the fade round the eye (a bead,
// wider than the tube, fades out further off: BEAD_NEAR).
fn fadeAt(t : f32, d : f32, r : f32, nearer : f32) -> f32 {
  let ahead = smoothstep(0.0, path.ahead, t - path.now);
  let near = smoothstep(nearer * path.nearFrom, nearer * path.nearTo, d / max(r, 1e-4));
  let far = 1.0 - smoothstep(0.5 * path.far, path.far, d);
  return path.alpha * ahead * near * far;
}

fn focalPixels() -> f32 { return 0.5 * frame.height / length(frame.rayUp); }
fn halfScreen() -> vec2f { return 0.5 * vec2f(frame.width, frame.height); }

// Where a point in front of the eye lands on the screen, pixels from the middle.
fn onScreen(p : vec3f) -> vec2f {
  let c = frame.viewProj * vec4f(p, 1.0);
  return c.xy / c.w * halfScreen();
}

// The depth a point's size on the screen is worked out from: its own,
// except far off to the side (over 60° from the middle of the view, never on
// the screen), where a depth near nothing would make it vast.
fn farEnough(depth : f32, p : vec3f) -> f32 { return max(depth, 0.5 * length(p)); }

fn unit2(v : vec2f) -> vec2f {
  let l = length(v);
  return select(vec2f(0.0), v / l, l > 1e-6);
}

// ---- the tube ----

struct TubeOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,
  @location(1) @interpolate(linear) across : f32,   // pixels from the middle
  @location(2) @interpolate(linear) core : f32,     // half its solid width, pixels
  @location(3) @interpolate(linear) cover : f32,    // how much of the minimum width it really fills
  @location(4) tangent : vec3f,
  @location(5) time : f32,
  @location(6) radius : f32,
  @location(7) sigma : f32,
};

@vertex
fn vsTube(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> TubeOut {
  var out : TubeOut;
  let n = u32(path.count);
  let ends = array<u32, 6>(0u, 0u, 1u, 1u, 0u, 1u);
  let sides = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let j0 = min(ii, n - 1u);
  let j1 = min(ii + 1u, n - 1u);
  var a = pointAt(j0);
  var b = pointAt(j1);
  let near = frame.near * 1.5;
  let da = dot(a.at, frame.rayForward);
  let db = dot(b.at, frame.rayForward);
  // Passed, wholly behind the eye, or wholly within the fade round the eye
  // (where it would cover the screen many times over, all of it unseen):
  // nothing (no area).
  let closeA = length(a.at) < path.nearFrom * a.radius;
  let closeB = length(b.at) < path.nearFrom * b.radius;
  if (b.time < path.now || (da < near && db < near) || (closeA && closeB)) {
    out.clip = OFF_SCREEN;
    return out;
  }
  // An end behind the eye: moved along the segment onto the near plane.
  let clipA = da < near;
  let clipB = db < near;
  if (clipA) { a = between(a, b, (near - da) / (db - da)); }
  if (clipB) { b = between(b, a, (near - db) / (da - db)); }
  let sa = onScreen(a.at);
  let sb = onScreen(b.at);
  // Wholly off one side of the screen (a quad is at most the screen's height
  // wide): nothing. An end far off to the side would otherwise stretch a
  // long quad across pixels it never shows.
  let margin = halfScreen() + vec2f(0.5 * frame.height + 2.0);
  if ((sa.x > margin.x && sb.x > margin.x) || (sa.x < -margin.x && sb.x < -margin.x) ||
      (sa.y > margin.y && sb.y > margin.y) || (sa.y < -margin.y && sb.y < -margin.y)) {
    out.clip = OFF_SCREEN;
    return out;
  }
  let own = unit2(sb - sa);
  // The joint's mean direction, as the neighbouring segment works it out.
  var dir = own;
  let e = ends[vi];
  var p = a;
  if (e == 0u) {
    if (!clipA && j0 > 0u) {
      let q = pointAt(j0 - 1u).at;
      if (dot(q, frame.rayForward) >= near) { dir = unit2(own + unit2(sa - onScreen(q))); }
    }
  } else {
    p = b;
    if (!clipB && j1 + 1u < n) {
      let q = pointAt(j1 + 1u).at;
      if (dot(q, frame.rayForward) >= near) { dir = unit2(own + unit2(onScreen(q) - sb)); }
    }
  }
  if (dot(dir, dir) < 0.5) { dir = select(vec2f(1.0, 0.0), own, dot(own, own) > 0.5); }
  let normal = vec2f(-dir.y, dir.x);
  let c = frame.viewProj * vec4f(p.at, 1.0);
  let width = 2.0 * p.radius * focalPixels() / farEnough(c.w, p.at);
  let least = path.minWidth * path.scale;
  let solid = min(max(width, least), frame.height);
  let reach = 0.5 * solid + 1.0;
  let side = sides[vi];
  out.clip = vec4f(c.xy + normal * (side * reach) / halfScreen() * c.w, c.zw);
  out.world = p.at;
  out.across = side * reach;
  out.core = 0.5 * solid;
  out.cover = clamp(width / least, COVER_LEAST, 1.0);
  out.tangent = normalize(b.at - a.at + vec3f(1e-9));
  out.time = p.time;
  out.radius = p.radius;
  out.sigma = p.sigma;
  return out;
}

// The glass at a point: its colour (display values) and opacity, not yet
// premultiplied.
fn glass(world : vec3f, tangent : vec3f, across : f32, core : f32, pixel : vec2f) -> vec4f {
  let toEye = normalize(-world);
  let k = clamp(across / max(core, 1e-3), -1.0, 1.0);
  let facing = sqrt(max(0.0, 1.0 - k * k));
  // The cylinder's normal there: from the side across it, round to the eye.
  // (Looking straight down the tube, as the camera flying along it does,
  // there is no side: the normal is then the eye's direction.)
  var sideways = cross(tangent, toEye);
  sideways = sideways / max(length(sideways), 1e-6);
  let n = normalize(sideways * k + toEye * max(facing, 1e-3));
  let thread = 1.0 - smoothstep(THREAD.x, THREAD.y, core);
  let rim = mix(1.0 - facing, THREAD_RIM, thread);
  var colour = path.colour * (0.3 + 0.7 * (sunLight(n) + skyLight(n))) + path.colour * 0.18;
  // The sun's glint off the glass.
  let h = normalize(frame.sunDir + toEye);
  colour += light.sun.rgb * pow(max(dot(n, h), 0.0), 60.0) * 0.5;
  // A cooler, brighter rim: the sky reflected at a grazing angle.
  colour = mix(colour, skyReflection(reflect(-toEye, n), localUp(world)) + path.colour * 0.25, rim * rim * 0.6);
  let opacity = GLASS.x + GLASS.y * rim * sqrt(rim);
  let c = present(applyAtmosphere(colour, world, pixel), pixel);
  return vec4f(c.rgb, opacity);
}

@fragment
fn fsTube(in : TubeOut) -> @location(0) vec4f {
  let edge = clamp(in.core + 0.5 - abs(in.across), 0.0, 1.0);
  let fade = fadeAt(in.time, length(in.world), in.radius, 1.0) * edge * in.cover;
  if (fade < 0.002) { discard; }
  let g = glass(in.world, in.tangent, in.across, in.core, in.clip.xy);
  let alpha = g.a * fade;
  return vec4f(g.rgb * alpha, alpha);
}

// Behind a mountain or a building: faint, and dashed.
@fragment
fn fsTubeHidden(in : TubeOut) -> @location(0) vec4f {
  let edge = clamp(in.core + 0.5 - abs(in.across), 0.0, 1.0);
  let dash = step(0.45, fract(in.sigma * DASHES));
  let fade = fadeAt(in.time, length(in.world), in.radius, 1.0) * path.hidden * dash * edge * in.cover;
  if (fade < 0.002) { discard; }
  let g = glass(in.world, in.tangent, in.across, in.core, in.clip.xy);
  let alpha = (0.35 + 0.65 * g.a) * fade;
  return vec4f(g.rgb * alpha, alpha);
}

// ---- the beads ----

struct BeadOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,
  @location(1) corner : vec2f,     // -1..1 across the bead
  @location(2) @interpolate(flat) time : f32,
  @location(3) @interpolate(flat) pixels : f32,   // the bead's radius on the screen
  @location(4) @interpolate(flat) cover : f32,
  @location(5) @interpolate(flat) radius : f32,
};

@vertex
fn vsBead(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> BeadOut {
  var out : BeadOut;
  let n = u32(path.count);
  let i = min(u32(round(f32(ii + 1u) * path.beadEvery)), n - 1u);
  let p = pointAt(i);
  if (p.time < path.now || dot(p.at, frame.rayForward) < frame.near * 1.5 || length(p.at) < BEAD_NEAR * path.nearFrom * p.radius) {
    out.clip = OFF_SCREEN;
    return out;
  }
  let corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
                                vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let k = corners[vi];
  let c = frame.viewProj * vec4f(p.at, 1.0);
  // Wider than the tube, and never smaller than a little dot.
  let r = BEAD_SIZE * p.radius * focalPixels() / farEnough(c.w, p.at);
  let least = 1.4 * path.minWidth * path.scale;
  let pixels = max(r, least);
  let reach = pixels + 1.0;
  if (any(abs(c.xy / c.w * halfScreen()) > halfScreen() + vec2f(reach))) {
    out.clip = OFF_SCREEN;
    return out;
  }
  out.clip = vec4f(c.xy + k * reach / halfScreen() * c.w, c.zw);
  out.world = p.at;
  out.corner = k * reach / pixels;
  out.time = p.time;
  out.pixels = pixels;
  out.cover = clamp(r / least, COVER_LEAST, 1.0);
  out.radius = p.radius;
  return out;
}

fn bead(in : BeadOut, hidden : bool) -> vec4f {
  let d = length(in.corner);
  let edge = clamp((1.0 - d) * in.pixels + 0.5, 0.0, 1.0);
  var fade = fadeAt(in.time, length(in.world), in.radius, BEAD_NEAR) * in.cover * edge;
  if (hidden) { fade *= path.hidden; }
  if (fade < 0.002) { discard; }
  // A small glass sphere: its normal from where on it the pixel is.
  let toEye = normalize(-in.world);
  var right = cross(frame.rayUp, toEye);
  right = right / max(length(right), 1e-6);
  let upward = cross(toEye, right);
  let q = in.corner / max(d, 1.0);
  let n = normalize(right * q.x + upward * q.y + toEye * sqrt(max(0.0, 1.0 - dot(q, q))));
  let tint = mix(path.colour, vec3f(1.0), 0.45);
  var colour = tint * (0.35 + 0.65 * (sunLight(n) + skyLight(n))) + tint * 0.25;
  colour += light.sun.rgb * pow(max(dot(n, normalize(frame.sunDir + toEye)), 0.0), 40.0) * 0.6;
  let c = present(applyAtmosphere(colour, in.world, in.clip.xy), in.clip.xy);
  let alpha = BEAD_ALPHA * fade;
  return vec4f(c.rgb * alpha, alpha);
}

@fragment fn fsBead(in : BeadOut) -> @location(0) vec4f { return bead(in, false); }
@fragment fn fsBeadHidden(in : BeadOut) -> @location(0) vec4f { return bead(in, true); }
