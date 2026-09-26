// materials.wgsl — building materials, drawn once at start-up into a
// texture array, one layer each. Every layer tiles seamlessly: all the noise
// here repeats on the layer's edge.
//
// A texel holds what the facade shader needs to make a plain colour look like
// the material:
//   r   how much lighter or darker than the building's colour, halved
//       (0.5 is the colour itself)
//   g   joints: mortar between stones and bricks, the gaps between boards,
//       tie holes in concrete; the shader gives them a colour of their own
//   b a the surface's slope along the wall and up it, quartered and centred
//       (0.5 is flat), for lighting the relief
//
// Layer order and the size each covers on a wall, in metres, must match
// MATERIAL_SIZE in buildings.wgsl and MATERIALS in js/engine/features/materials.js.

const SIZE : u32 = 512u;

@group(0) @binding(0) var dest : texture_storage_2d_array<rgba8unorm, write>;

// World size of each layer, metres along the wall and up it.
const LAYER_SIZE = array<vec2f, 9>(
  vec2f(2.0, 2.0),    // plaster
  vec2f(2.0, 2.0),    // roughcast
  vec2f(2.4, 2.4),    // rubble stone
  vec2f(3.0, 1.8),    // ashlar
  vec2f(1.25, 1.2),   // brick
  vec2f(2.0, 2.0),    // vertical boards
  vec2f(2.0, 1.8),    // logs
  vec2f(3.0, 3.0),    // concrete
  vec2f(2.0, 2.0),    // metal cladding
);

// ---- periodic noise ----------------------------------------------------------

fn hash3(x : u32, y : u32, z : u32) -> u32 {
  var h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ (z * 0xcb1ab31fu);
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}

fn wrap(c : vec2i, period : vec2i) -> vec2u {
  return vec2u(((c % period) + period) % period);
}

fn rand(c : vec2i, period : vec2i, seed : u32) -> f32 {
  let w = wrap(c, period);
  return f32(hash3(w.x, w.y, seed) >> 8u) / 16777216.0;
}

fn rand2(c : vec2i, period : vec2i, seed : u32) -> vec2f {
  return vec2f(rand(c, period, seed), rand(c, period, seed ^ 0x5bd1e995u));
}

// Value noise over `period` cells across the layer; p in [0, 1).
fn vnoise(p : vec2f, period : vec2i, seed : u32) -> f32 {
  let q = p * vec2f(period);
  let i = vec2i(floor(q));
  let f = fract(q);
  let s = f * f * (3.0 - 2.0 * f);
  let a = rand(i, period, seed);
  let b = rand(i + vec2i(1, 0), period, seed);
  let c = rand(i + vec2i(0, 1), period, seed);
  let d = rand(i + vec2i(1, 1), period, seed);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// Octaves of it, each twice as fine. 0..1, averaging a half.
fn fbm(p : vec2f, period : vec2i, octaves : i32, seed : u32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var norm = 0.0;
  var c = period;
  for (var o = 0; o < octaves; o++) {
    sum += amp * vnoise(p, c, seed + u32(o) * 1013u);
    norm += amp;
    amp *= 0.5;
    c *= 2;
  }
  return sum / norm;
}

// ---- the materials -------------------------------------------------------------
// Each takes the position in metres within its layer and returns the
// brightness factor, the joint mask and the surface height in metres.

struct Texel {
  shade  : f32,
  joint  : f32,
  height : f32,
};

// Smooth render: broad trowel variation and a fine sand grain.
fn plaster(m : vec2f, size : vec2f) -> Texel {
  let p = m / size;
  let broad = fbm(p, vec2i(4), 4, 11u);
  let grain = fbm(p, vec2i(96), 2, 23u);
  return Texel(1.0 + 0.12 * (broad - 0.5) + 0.07 * (grain - 0.5), 0.0,
               0.0012 * grain + 0.0015 * broad);
}

// Thrown render, as on older houses south of the Alps: a coarse, pitted skin.
fn roughcast(m : vec2f, size : vec2f) -> Texel {
  let p = m / size;
  let broad = fbm(p, vec2i(4), 4, 31u);
  let grain = fbm(p, vec2i(64), 3, 37u);
  let pits = pow(vnoise(p, vec2i(180), 41u), 4.0);
  return Texel(1.0 + 0.16 * (broad - 0.5) + 0.12 * (grain - 0.5) - 0.18 * pits, 0.0,
               0.004 * grain - 0.003 * pits + 0.002 * broad);
}

// Nearest and second-nearest of a jittered grid of points, in metres, and the
// cell of the nearest: stones laid in mortar.
struct Cells {
  f1   : f32,
  f2   : f32,
  cell : vec2i,
};

fn voronoi(m : vec2f, size : vec2f, grid : vec2i, seed : u32) -> Cells {
  let cellSize = size / vec2f(grid);
  let q = m / cellSize;
  let base = vec2i(floor(q));
  var out = Cells(1e9, 1e9, vec2i(0));
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = base + vec2i(i, j);
      let point = (vec2f(c) + 0.15 + 0.7 * rand2(c, grid, seed)) * cellSize;
      let d = distance(point, m);
      if (d < out.f1) { out.f2 = out.f1; out.f1 = d; out.cell = c; }
      else if (d < out.f2) { out.f2 = d; }
    }
  }
  return out;
}

// Rubble walls: field stones of every size and shade, deep mortar joints.
fn rubble(m : vec2f, size : vec2f) -> Texel {
  let grid = vec2i(6, 9);
  let v = voronoi(m, size, grid, 53u);
  let edge = 0.5 * (v.f2 - v.f1);                      // metres to the joint's middle
  let p = m / size;
  let wobble = 0.006 * (vnoise(p, vec2i(40), 59u) - 0.5);
  let joint = 1.0 - smoothstep(0.010, 0.018, edge + wobble);
  let tone = rand(v.cell, grid, 61u);
  let stone = (0.72 + 0.6 * tone) * (1.0 + 0.16 * (fbm(p, vec2i(48), 3, 67u) - 0.5));
  let bulge = smoothstep(0.0, 0.07, edge) * (0.018 + 0.012 * tone)
            + 0.003 * fbm(p, vec2i(64), 2, 71u);
  return Texel(mix(stone, 1.0, joint), joint, bulge * (1.0 - joint));
}

// Cut stone in courses, blocks staggered from row to row.
fn ashlar(m : vec2f, size : vec2f) -> Texel {
  let rows = 6;
  let perRow = 4;
  let rowH = size.y / f32(rows);
  let row = i32(floor(m.y / rowH));
  let shift = rand(vec2i(row, 0), vec2i(rows, 1), 73u);
  let blockW = size.x / f32(perRow);
  let x = m.x / blockW + shift;
  let block = vec2i(i32(floor(x)) % perRow, row);
  let fx = fract(x) * blockW;
  let fy = m.y - f32(row) * rowH;
  let toEdge = min(min(fx, blockW - fx), min(fy, rowH - fy));
  let joint = 1.0 - smoothstep(0.004, 0.008, toEdge);
  let p = m / size;
  let tone = rand(block, vec2i(perRow, rows), 79u);
  let chisel = fbm(p, vec2i(80), 3, 83u);
  let shade = (0.86 + 0.28 * tone) * (1.0 + 0.1 * (chisel - 0.5));
  let bevel = smoothstep(0.004, 0.02, toEdge) * 0.008 + 0.0015 * chisel;
  return Texel(mix(shade, 1.0, joint), joint, bevel * (1.0 - joint));
}

// Brick in running bond: 24 × 6.5 cm faces, centimetre joints.
fn brick(m : vec2f, size : vec2f) -> Texel {
  let perRow = 5;
  let rows = 16;
  let w = size.x / f32(perRow);
  let h = size.y / f32(rows);
  let row = i32(floor(m.y / h));
  let x = m.x / w + select(0.0, 0.5, (row & 1) == 1);
  let b = vec2i(i32(floor(x)) % perRow, row);
  let fx = fract(x) * w;
  let fy = m.y - f32(row) * h;
  let toEdge = min(min(fx, w - fx), min(fy, h - fy));
  let joint = 1.0 - smoothstep(0.004, 0.006, toEdge);
  let p = m / size;
  let tone = rand(b, vec2i(perRow, rows), 89u);
  let burnt = select(1.0, 0.62, rand(b, vec2i(perRow, rows), 97u) < 0.12);
  let shade = (0.8 + 0.4 * tone) * burnt * (1.0 + 0.12 * (fbm(p, vec2i(64), 2, 101u) - 0.5));
  let face = smoothstep(0.004, 0.009, toEdge) * 0.006;
  return Texel(mix(shade, 1.12, joint), joint, face);
}

// Vertical boarding, as on barns and the upper floors of chalets.
fn boards(m : vec2f, size : vec2f) -> Texel {
  let count = 10;
  let w = size.x / f32(count);
  let i = i32(floor(m.x / w));
  let fx = m.x - f32(i) * w;
  let toGap = min(fx, w - fx);
  let joint = 1.0 - smoothstep(0.004, 0.008, toGap);
  let p = m / size;
  let tone = rand(vec2i(i, 0), vec2i(count, 1), 103u);
  let grain = vnoise(p + vec2f(0.0, tone), vec2i(160, 6), 107u);
  let streak = vnoise(p, vec2i(40, 3), 109u);
  let shade = (0.8 + 0.4 * tone) * (0.85 + 0.3 * grain) * (0.9 + 0.2 * streak);
  let relief = smoothstep(0.004, 0.015, toGap) * 0.006 + 0.0012 * grain;
  return Texel(mix(shade, 0.25, joint), joint, relief);
}

// Round logs laid one on another: the log house of the high valleys.
fn logs(m : vec2f, size : vec2f) -> Texel {
  let count = 10;
  let h = size.y / f32(count);
  let i = i32(floor(m.y / h));
  let t = (m.y - f32(i) * h) / h;
  let round = sqrt(max(0.0, 1.0 - (2.0 * t - 1.0) * (2.0 * t - 1.0)));
  let joint = 1.0 - smoothstep(0.12, 0.3, round);
  let p = m / size;
  let tone = rand(vec2i(0, i), vec2i(1, count), 113u);
  let grain = vnoise(p + vec2f(tone, 0.0), vec2i(5, 200), 127u);
  let shade = (0.8 + 0.4 * tone) * (0.85 + 0.3 * grain) * mix(0.75, 1.0, round);
  return Texel(mix(shade, 0.3, joint), joint, 0.035 * round + 0.001 * grain);
}

// Board-marked concrete with tie holes, blotchy the way a pour dries.
fn concrete(m : vec2f, size : vec2f) -> Texel {
  let p = m / size;
  let blotch = fbm(p, vec2i(3), 4, 131u);
  let boards = 30;
  let row = i32(floor(p.y * f32(boards)));
  let boardTone = rand(vec2i(0, row), vec2i(1, boards), 137u);
  let seam = 1.0 - smoothstep(0.0, 0.08, min(fract(p.y * f32(boards)), 1.0 - fract(p.y * f32(boards))));
  let holes = 6;
  let hole = distance(fract(p * f32(holes)), vec2f(0.5)) * size.x / f32(holes);
  let tie = 1.0 - smoothstep(0.010, 0.014, hole);
  let grain = fbm(p, vec2i(96), 2, 139u);
  let shade = (1.0 + 0.2 * (blotch - 0.5) + 0.05 * (boardTone - 0.5) + 0.06 * (grain - 0.5)) * (1.0 - 0.08 * seam);
  return Texel(mix(shade, 0.45, tie), tie, 0.001 * (1.0 - seam) + 0.0008 * grain - 0.01 * tie);
}

// Trapezoidal sheet cladding, ribs every 20 cm.
fn metal(m : vec2f, size : vec2f) -> Texel {
  let count = 10;
  let x = fract(m.x / (size.x / f32(count)));
  // Crest, flank, pan, flank.
  var h = 0.0;
  if (x < 0.2) { h = 1.0; }
  else if (x < 0.3) { h = 1.0 - (x - 0.2) / 0.1; }
  else if (x < 0.9) { h = 0.0; }
  else { h = (x - 0.9) / 0.1; }
  let p = m / size;
  let streak = vnoise(p, vec2i(60, 2), 149u);
  let shade = 1.0 + 0.08 * (streak - 0.5) + 0.04 * (fbm(p, vec2i(8), 3, 151u) - 0.5);
  return Texel(shade, 0.0, 0.035 * h);
}

fn material(layer : u32, m : vec2f, size : vec2f) -> Texel {
  switch layer {
    case 0u: { return plaster(m, size); }
    case 1u: { return roughcast(m, size); }
    case 2u: { return rubble(m, size); }
    case 3u: { return ashlar(m, size); }
    case 4u: { return brick(m, size); }
    case 5u: { return boards(m, size); }
    case 6u: { return logs(m, size); }
    case 7u: { return concrete(m, size); }
    default: { return metal(m, size); }
  }
}

// One texel of one layer: the material at its centre. Its slope comes next,
// from the heights around it, so every texel is worked out only once.
@group(0) @binding(2) var heights : texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn generate(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= SIZE || id.y >= SIZE) { return; }
  let layer = id.z;
  let size = LAYER_SIZE[layer];
  let texel = size / f32(SIZE);
  // Texture rows run down the image and walls run up: row 0 is the top.
  let m = (vec2f(f32(id.x), f32(SIZE - 1u - id.y)) + 0.5) * texel;
  let c = material(layer, m, size);
  textureStore(heights, vec2u(id.xy), layer, vec4f(c.shade, c.joint, c.height, 0.0));
}

@group(0) @binding(3) var generated : texture_2d_array<f32>;

// The slope along the wall and up it, from the heights a texel either side,
// wrapping at the edges as the texture does.
@compute @workgroup_size(8, 8, 1)
fn finish(@builtin(global_invocation_id) id : vec3u) {
  if (id.x >= SIZE || id.y >= SIZE) { return; }
  let l = i32(id.z);
  let size = LAYER_SIZE[id.z];
  let texel = size / f32(SIZE);
  let n = i32(SIZE);
  let p = vec2i(id.xy);
  let c = textureLoad(generated, p, l, 0);
  let east = textureLoad(generated, vec2i((p.x + 1) % n, p.y), l, 0).b;
  let west = textureLoad(generated, vec2i((p.x + n - 1) % n, p.y), l, 0).b;
  // Row numbers grow downwards, heights up the wall grow upwards.
  let above = textureLoad(generated, vec2i(p.x, (p.y + n - 1) % n), l, 0).b;
  let below = textureLoad(generated, vec2i(p.x, (p.y + 1) % n), l, 0).b;
  let slope = vec2f((east - west) / (2.0 * texel.x), (above - below) / (2.0 * texel.y));
  let s = clamp(slope * 0.25 + 0.5, vec2f(0.0), vec2f(1.0));
  textureStore(dest, vec2u(id.xy), id.z, vec4f(clamp(c.r * 0.5, 0.0, 1.0), c.g, s.x, s.y));
}

// ---- mipmaps -------------------------------------------------------------------

@group(0) @binding(1) var source : texture_2d_array<f32>;

// Each texel of the next level averages four of the one before: brightness,
// joints and slopes alike, so relief flattens with distance as it should.
@compute @workgroup_size(8, 8, 1)
fn downsample(@builtin(global_invocation_id) id : vec3u) {
  let dims = textureDimensions(dest);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  let s = vec2i(id.xy) * 2;
  let l = i32(id.z);
  let sum = textureLoad(source, s, l, 0) + textureLoad(source, s + vec2i(1, 0), l, 0)
          + textureLoad(source, s + vec2i(0, 1), l, 0) + textureLoad(source, s + vec2i(1, 1), l, 0);
  textureStore(dest, vec2u(id.xy), id.z, sum * 0.25);
}
