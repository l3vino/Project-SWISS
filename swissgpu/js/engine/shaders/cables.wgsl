// cables.wgsl — cable cars: their ropes and pylons (js/engine/passes/cables.js).
// Joined after common.wgsl, atmosphere.wgsl and frame.wgsl.
//
// Both come from js/formats/lines.js, in the local east-north-up frame of
// the tile they arrived in, as the same records: straight pieces of rope,
// and the steel members of the pylons (legs, braces, poles and crossarms).
// The geometry is made here, with no vertex buffers.
//
// A piece is a ribbon facing the eye along it, as wide on screen as the
// rope or member really is, but never less than a pixel; one thinner than
// that is drawn a pixel wide and only as opaque as the share of the pixel it
// covers, which is what anti-aliased wires look like (Persson, "Phone-wire
// AA", 2012), so a lattice tower far away fades to the grey haze a real one
// becomes. Its edges fade over a pixel either side. Lit as the side of a
// cylinder facing the eye.

struct Tile {
  originRel : vec3f,   // the tile frame's origin minus the camera, metres
  _p0       : f32,
  east      : vec3f,   // the tile frame's axes, earth-centred
  _p1       : f32,
  north     : vec3f,
  _p2       : f32,
  up        : vec3f,
  _p3       : f32,
};

struct Rope {
  a : vec4f,   // one end, local metres; radius
  b : vec4f,   // the other end; albedo
};

@group(1) @binding(0) var<uniform> tile : Tile;
@group(2) @binding(0) var<storage, read> ropes : array<Rope>;

fn toWorld(p : vec3f) -> vec3f {
  return tile.originRel + tile.east * p.x + tile.north * p.y + tile.up * p.z;
}

// ---- ropes ----

struct RopeOut {
  @builtin(position) clip : vec4f,
  @location(0) world : vec3f,
  @location(1) @interpolate(linear) across : f32,   // pixels from the middle of the ribbon
  @location(2) @interpolate(linear) core : f32,     // half its solid width, pixels
  @location(3) @interpolate(linear) cover : f32,    // how much of a pixel-wide line the rope fills
  @location(4) @interpolate(flat) tangent : vec3f,
  @location(5) @interpolate(flat) albedo : f32,
};

@vertex
fn vsRope(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> RopeOut {
  let r = ropes[ii];
  var a = toWorld(r.a.xyz);
  var b = toWorld(r.b.xyz);
  var out : RopeOut;
  out.tangent = normalize(b - a);
  out.albedo = r.b.w;
  // Cut at the near plane, so both ends project: a piece wholly behind it
  // collapses out of view.
  let near = frame.near * 1.01;
  let da = dot(a, frame.rayForward);
  let db = dot(b, frame.rayForward);
  if (da < near && db < near) {
    out.clip = vec4f(2.0, 2.0, 0.0, 1.0);
    return out;
  }
  if (da < near) { a = mix(a, b, (near - da) / (db - da)); }
  if (db < near) { b = mix(b, a, (near - db) / (da - db)); }
  let ca = frame.viewProj * vec4f(a, 1.0);
  let cb = frame.viewProj * vec4f(b, 1.0);
  let half = 0.5 * vec2f(frame.width, frame.height);
  let sa = ca.xy / ca.w * half;
  let sb = cb.xy / cb.w * half;
  let d = sb - sa;
  let len = length(d);
  let dir = select(vec2f(1.0, 0.0), d / max(len, 1e-6), len > 1e-4);
  let normal = vec2f(-dir.y, dir.x);
  // The rope's width in pixels at this end: its diameter over the distance,
  // times the focal length in pixels.
  let focal = 0.5 * frame.height / length(frame.rayUp);
  let end = select(0.0, 1.0, vi == 2u || vi == 3u || vi == 5u);
  let side = select(-1.0, 1.0, vi == 1u || vi == 4u || vi == 5u);
  let c = mix(ca, cb, end);
  let width = 2.0 * r.a.w * focal / max(c.w, 1e-3);
  let solid = max(width, 1.0);
  let reach = 0.5 * solid + 1.0;
  out.clip = vec4f(c.xy + normal * (side * reach) / half * c.w, c.zw);
  out.world = mix(a, b, end);
  out.across = side * reach;
  out.core = 0.5 * solid;
  out.cover = min(width, 1.0);
  return out;
}

@fragment
fn fsRope(in : RopeOut) -> @location(0) vec4f {
  let edge = clamp(in.core + 0.5 - abs(in.across), 0.0, 1.0);
  let alpha = edge * in.cover;
  if (alpha < 0.002) { discard; }
  // The side of the rope facing the eye, tipped a little towards the sky.
  let toEye = normalize(-in.world);
  var n = toEye - in.tangent * dot(toEye, in.tangent);
  n = normalize(n * 0.8 + localUp(in.world) * 0.4);
  var colour = vec3f(in.albedo) * modelledLight(n);
  // Drawn steel glints along the rope where it lines up with the sun
  // (Kajiya and Kay's highlight for thin cylinders).
  let ts = dot(in.tangent, frame.sunDir);
  let te = dot(in.tangent, toEye);
  let glint = pow(max(0.0, sqrt(max(0.0, 1.0 - ts * ts)) * sqrt(max(0.0, 1.0 - te * te)) - ts * te), 60.0);
  colour += light.sun.rgb * glint * 0.4;
  if (frame.debugMode == 1u) { colour = vec3f(1.0, 0.2, 0.1); }
  let c = present(applyAtmosphere(colour, in.world, in.clip.xy), in.clip.xy);
  return vec4f(c.rgb * alpha, alpha);
}
