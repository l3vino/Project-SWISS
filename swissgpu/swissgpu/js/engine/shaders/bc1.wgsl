// bc1.wgsl — aerial photos into BC1 blocks, on the GPU, as they arrive.
//
// BC1 stores each 4x4 block of pixels in 8 bytes: two 16-bit endpoint colours
// and a 2-bit index per pixel choosing one of four colours on the line between
// them. That is 4 bits per pixel against 32 for plain RGBA, which is what lets
// a deep stack of imagery levels stay resident.
//
// Quality comes from where the endpoints sit. This fits the line through the
// block's colours along their principal axis, then refines the endpoints once
// by least squares against the indices that line produced: the same approach
// as the well-known offline encoders, cheap enough to run per tile on arrival.
// The plain per-channel bounding box is tried as well and the block keeps
// whichever pair reproduces it better, so no block is ever worse than the
// simplest encoder would make it.
//
// Colours are encoded as stored, in sRGB, and sampled back through the
// bc1-rgba-unorm-srgb format, so filtering and lighting happen in linear light.

@group(0) @binding(0) var source : texture_2d_array<f32>;           // one tile per layer
@group(0) @binding(1) var<storage, read_write> blocks : array<vec2u>; // 64 x 64 per tile

const BLOCKS_PER_SIDE : u32 = 64u;   // a 256 px tile
const BLOCKS_PER_TILE : u32 = 4096u;

struct Encoded {
  block : vec2u,   // the 8 bytes as stored: both endpoints, then the indices
  error : f32,     // squared error over the block, to choose between candidates
};

fn pack565(c : vec3f) -> u32 {
  let q = vec3u(round(clamp(c, vec3f(0.0), vec3f(1.0)) * vec3f(31.0, 63.0, 31.0)));
  return (q.x << 11u) | (q.y << 5u) | q.z;
}

// Expanded the way the hardware expands it: bit replication, not division.
fn unpack565(v : u32) -> vec3f {
  let r = (v >> 11u) & 31u;
  let g = (v >> 5u) & 63u;
  let b = v & 31u;
  return vec3f(f32((r << 3u) | (r >> 2u)), f32((g << 2u) | (g >> 4u)), f32((b << 3u) | (b >> 2u))) / 255.0;
}

fn distance2(a : vec3f, b : vec3f) -> f32 { let d = a - b; return dot(d, d); }

// Index of the nearest palette entry, in BC1's order: 0 and 1 are the
// endpoints, 2 is two thirds of the way from 0, 3 is one third.
fn nearest(c : vec3f, p0 : vec3f, p1 : vec3f, p2 : vec3f, p3 : vec3f) -> u32 {
  var best = 0u;
  var bestD = distance2(c, p0);
  let d1 = distance2(c, p1); if (d1 < bestD) { bestD = d1; best = 1u; }
  let d2 = distance2(c, p2); if (d2 < bestD) { bestD = d2; best = 2u; }
  let d3 = distance2(c, p3); if (d3 < bestD) { best = 3u; }
  return best;
}

// Share of endpoint 0 in each palette entry.
fn weightOf(index : u32) -> f32 {
  return select(select(select(1.0 / 3.0, 2.0 / 3.0, index == 2u), 0.0, index == 1u), 1.0, index == 0u);
}

// Quantises a pair of endpoints and picks every pixel's index against the
// colours the hardware will actually decode, not the unquantised ones.
fn encodePair(px : ptr<function, array<vec3f, 16>>, a : vec3f, b : vec3f) -> Encoded {
  var c0 = pack565(a);
  var c1 = pack565(b);
  // Four-colour mode needs the first endpoint to be the larger number.
  if (c0 < c1) { let t = c0; c0 = c1; c1 = t; }
  let p0 = unpack565(c0);
  let p1 = unpack565(c1);

  var out : Encoded;
  out.error = 0.0;
  if (c0 == c1) {
    // One colour: index 0 decodes to it in either mode.
    for (var i = 0u; i < 16u; i++) { out.error += distance2((*px)[i], p0); }
    out.block = vec2u(c0 | (c1 << 16u), 0u);
    return out;
  }

  let p2 = (2.0 * p0 + p1) / 3.0;
  let p3 = (p0 + 2.0 * p1) / 3.0;
  var bits = 0u;
  for (var i = 0u; i < 16u; i++) {
    let c = (*px)[i];
    let k = nearest(c, p0, p1, p2, p3);
    bits |= k << (2u * i);
    out.error += distance2(c, select(select(select(p3, p2, k == 2u), p1, k == 1u), p0, k == 0u));
  }
  out.block = vec2u(c0 | (c1 << 16u), bits);
  return out;
}

@compute @workgroup_size(8, 8, 1)
fn encode(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= BLOCKS_PER_SIDE || id.y >= BLOCKS_PER_SIDE) { return; }
  let layer = id.z;
  let corner = id.xy * 4u;

  var px : array<vec3f, 16>;
  var mean = vec3f(0.0);
  var boxLo = vec3f(1.0);
  var boxHi = vec3f(0.0);
  for (var i = 0u; i < 16u; i++) {
    let c = textureLoad(source, corner + vec2u(i & 3u, i >> 2u), layer, 0).rgb;
    px[i] = c;
    mean += c;
    boxLo = min(boxLo, c);
    boxHi = max(boxHi, c);
  }
  mean /= 16.0;

  // ---- principal axis of the colours: power iteration on the covariance ----
  var cov0 = vec3f(0.0);   // xx xy xz
  var cov1 = vec3f(0.0);   // yy yz zz
  for (var i = 0u; i < 16u; i++) {
    let d = px[i] - mean;
    cov0 += d.x * d;
    cov1 += vec3f(d.y * d.y, d.y * d.z, d.z * d.z);
  }
  var axis = boxHi - boxLo;
  if (dot(axis, axis) < 1e-10) { axis = vec3f(0.577, 0.577, 0.577); }
  for (var k = 0; k < 4; k++) {
    let next = vec3f(dot(cov0, axis),
                     cov0.y * axis.x + cov1.x * axis.y + cov1.y * axis.z,
                     cov0.z * axis.x + cov1.y * axis.y + cov1.z * axis.z);
    let l = length(next);
    if (l > 1e-10) { axis = next / l; }
  }
  axis = normalize(axis);

  // ---- endpoints at the extremes along the axis ----
  var lo = 1e9;
  var hi = -1e9;
  for (var i = 0u; i < 16u; i++) {
    let t = dot(px[i] - mean, axis);
    lo = min(lo, t);
    hi = max(hi, t);
  }
  var e0 = mean + axis * hi;
  var e1 = mean + axis * lo;

  // ---- one least-squares refinement against the indices they produce ----
  // Skipped for a block that is one colour, and whenever the pixels do not
  // spread over at least two palette weights: the system is then singular,
  // and rounding noise alone would decide the endpoints.
  if (hi - lo > 0.5 / 255.0) {
    let p2 = (2.0 * e0 + e1) / 3.0;
    let p3 = (e0 + 2.0 * e1) / 3.0;
    var a00 = 0.0; var a01 = 0.0; var a11 = 0.0;
    var b0 = vec3f(0.0); var b1 = vec3f(0.0);
    for (var i = 0u; i < 16u; i++) {
      let w = weightOf(nearest(px[i], e0, e1, p2, p3));
      a00 += w * w; a01 += w * (1.0 - w); a11 += (1.0 - w) * (1.0 - w);
      b0 += w * px[i]; b1 += (1.0 - w) * px[i];
    }
    let det = a00 * a11 - a01 * a01;
    if (det > 0.01 * a00 * a11) {
      e0 = (a11 * b0 - a01 * b1) / det;
      e1 = (a00 * b1 - a01 * b0) / det;
    }
  }

  let fitted = encodePair(&px, e0, e1);
  let boxed = encodePair(&px, boxHi, boxLo);
  // select() takes scalars and vectors only, so choose the block, not the struct.
  let best = select(fitted.block, boxed.block, boxed.error < fitted.error);

  blocks[layer * BLOCKS_PER_TILE + id.y * BLOCKS_PER_SIDE + id.x] = best;
}
