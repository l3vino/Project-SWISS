// bore.wgsl — the room tunnels' bores take (js/engine/tunnels/cuts.js), as a slot of pieces in a uniform buffer made
// once, bound with a dynamic offset (group 1, binding 1). Joined before terrain.wgsl (the ground cut along every
// bore, 5.17k) and tunnel.wgsl (a tube left out where it lies inside another's bore, 5.17m).
//
// 5.17e had the ground's pieces in a storage buffer of every tile's after one another, rewritten and at times made
// again as it grew, and on his GPU, an RTX 2080 Ti, the device was reset from then on. A slot: its frame (east,
// north and up at its middle, from the origin its vertices are relative to), how many pieces, how far they reach
// (top, box), and up to CUT_MOST pieces, the nearest the camera first. A piece: from a to b (its floor), half its
// width up to `top` (its walls), the arch over them (archY its ellipse's middle, archA its half-width, archH its
// half-height); a negative top: the bore ends there (no quarter metre past it, as where two pieces meet). Since
// 5.17n exactly the room the mesh has (tunnel.c): beside the floor, beyond `inner`, the walkways `kerb` high, the
// room on them; under the arch's middle a bored tube's lower half `lowR` high (not stretched up with a wide bore).
struct Cut {
  a     : vec3f,
  halfA : f32,
  b     : vec3f,
  halfB : f32,
  outA  : vec4f,   // top, archY, archA, archH at a
  outB  : vec4f,   // and at b
  low   : vec4f,   // inner at a, inner at b, kerb, lowR (0: archH under the middle too)
};
const CUT_MOST : u32 = 31u;
struct CutSlot {
  east  : vec3f,
  count : u32,
  north : vec3f,
  top   : f32,
  up    : vec3f,
  _p0   : f32,
  box   : vec4f,   // least east, north, most east, north its pieces reach
  list  : array<Cut, 31>,
};
@group(1) @binding(1) var<uniform> cutSlot : CutSlot;

// A point (`rel`: metres from the slot's origin, earth-centred axes) in the slot's frame, and whether it lies within
// the reach of its pieces at all (their box and their top: most pixels do not, and look at none of them).
fn slotPoint(rel : vec3f) -> vec4f {
  let p = vec3f(dot(rel, cutSlot.east), dot(rel, cutSlot.north), dot(rel, cutSlot.up));
  let near = !(p.z > cutSlot.top || any(p.xy < cutSlot.box.xy) || any(p.xy > cutSlot.box.zw));
  return vec4f(p, select(0.0, 1.0, near));
}

// A point of the slot's frame against piece c: x its height over what it stands on there (the floor, or beside it the
// walkways' top), y 1 where it lies along the piece (a quarter metre past its ends where it runs on into the next)
// and within its outline, `grow` metres more all round (less, where negative), the arch's radii times `fit` (a mesh's
// arch is a polygon inside its ellipse, by under 1 % of its radii): within its walls up to their top, or under its
// arch; else 0. Below the floor counts as within: the caller says from how far under it.
fn cutAt(c : Cut, p : vec3f, grow : f32, fit : f32) -> vec2f {
  let ab = c.b.xy - c.a.xy;
  let len = length(ab);
  if (len < 1e-3) { return vec2f(0.0); }
  let dir = ab / len;
  let along = dot(p.xy - c.a.xy, dir);
  let before = select(0.25, 0.0, c.outA.x < 0.0);
  let past = select(0.25, 0.0, c.outB.x < 0.0);
  if (along < -before || along > len + past) { return vec2f(0.0); }
  let t = clamp(along / len, 0.0, 1.0);
  let h = p.z - mix(c.a.z, c.b.z, t);
  let across = abs(dot(p.xy - c.a.xy, vec2f(dir.y, -dir.x)));
  let o = mix(vec4f(abs(c.outA.x), c.outA.yzw), vec4f(abs(c.outB.x), c.outB.yzw), t);
  // Beside the floor the walkways: what stands there stands on them.
  let x = h - select(0.0, c.low.z, across > mix(c.low.x, c.low.y, t) + grow);
  // Within its walls (up to their top), or else under its arch.
  if (h <= o.x + grow && across <= mix(c.halfA, c.halfB, t) + grow) { return vec2f(x, 1.0); }
  if (h <= o.x || o.z <= 0.0) { return vec2f(x, 0.0); }
  // (Under 0 in a mesh's slot of the bores meeting it: a tube it opens into, cuts.js; its lowR is −1 − that.)
  let lowR = select(c.low.w, -1.0 - c.low.w, c.low.w < 0.0);
  let lower = select(o.w, lowR, h < o.y && lowR > 0.0);
  let ex = across / max(o.z * fit + grow, 0.01);
  let ey = (h - o.y) / max(lower * fit + grow, 0.01);
  return vec2f(x, select(0.0, 1.0, ex * ex + ey * ey <= 1.0));
}
