// imagery.wgsl — sampling the aerial-photo clipmap.
//
// Positions are in reference pixels: pixels of the finest imagery level,
// counted from an anchor near the camera (see js/engine/imagery/mercator.js).
// Each level is a toroidal window of tiles in one layer of a texture array;
// a residency table says which tile each slot holds, and a texel is only
// trusted if its slot holds exactly the tile that covers this spot. Otherwise
// the lookup falls through to the next coarser level, so streaming shows as
// blur, never as holes or someone else's tile.

const IMAGERY_TILE : f32 = 256.0;

struct ImageryLevel {
  origin   : vec2f,   // window's north-west corner, reference pixels from the anchor
  wrap     : vec2f,   // where that corner sits in the toroidal texture, in texels
  tile     : vec2u,   // the corner tile's index, for the residency check
  invScale : f32,     // level texels per reference pixel
  live     : u32,     // 1 when this level is sampled at all right now
};

struct Imagery {
  levels  : array<ImageryLevel, 16>,
  zMax    : f32,      // zoom of the reference pixel grid
  zMin    : f32,      // zoom of level 0
  count   : u32,
  top     : u32,      // finest level worth sampling from here
  window  : u32,      // tiles per window side
  texels  : f32,      // texels per texture side: window * 256
  enabled : u32,
  bias    : f32,      // zoom levels of softening, from the sharpness setting
  aniso   : f32,      // anisotropic taps at most (the sampler's; 5.18f: the photo filtering setting)
  band    : f32,      // half the band round a change of level two levels are blended in (0.5: everywhere)
  _p0     : f32,
  _p1     : f32,
};

@group(2) @binding(0) var imageryTex : texture_2d_array<f32>;
@group(2) @binding(1) var imagerySampler : sampler;
@group(2) @binding(2) var<uniform> imagery : Imagery;
@group(2) @binding(3) var<storage, read> residency : array<vec2u>;

struct ImagerySample {
  colour : vec3f,     // linear light
  found  : f32,       // 1 where imagery exists, 0 where nothing is loaded
  level  : f32,       // zoom actually used, for the debug view
};

// One level's texel at p, or found = 0 if this level cannot answer here.
fn imageryLevel(i : u32, p : vec2f, dx : vec2f, dy : vec2f) -> vec4f {
  let L = imagery.levels[i];
  if (L.live == 0u) { return vec4f(0.0); }

  // Texels from the window's corner. A one-texel margin keeps bilinear
  // filtering from reaching outside the window.
  let t = (p - L.origin) * L.invScale;
  let size = imagery.texels;
  if (any(t < vec2f(1.0)) || any(t > vec2f(size - 1.0))) { return vec4f(0.0); }

  let tile = L.tile + vec2u(t / IMAGERY_TILE);
  let n = imagery.window;
  let slot = tile % vec2u(n);
  if (any(residency[(i * n + slot.y) * n + slot.x] != tile)) { return vec4f(0.0); }

  // Gradients in the same units as the coordinate, so anisotropic filtering
  // sees the pixel's true footprint on this level.
  let g = L.invScale / size;
  let c = textureSampleGrad(imageryTex, imagerySampler, (L.wrap + t) / size, i, dx * g, dy * g);
  return vec4f(c.rgb, 1.0);
}

// The photo at p blurred to about `f` reference pixels across (rgb, and
// w = 1 where there is one): what made surfaces take their colours from.
fn photoBlur(p : vec2f, f : f32) -> vec4f {
  let s = sampleImagery(p, vec2f(f, 0.0), vec2f(0.0, f));
  return vec4f(s.colour, s.found);
}

// p and its screen-space derivatives, all in reference pixels. The
// derivatives come in as arguments because they must be taken in uniform
// control flow, and the level walk below is anything but.
// The most levels a pixel walks down from the one it wants (sampleImagery).
const IMAGERY_WALK : i32 = 24;

fn sampleImagery(p : vec2f, dx : vec2f, dy : vec2f) -> ImagerySample {
  var out : ImagerySample;
  out.colour = vec3f(0.0);
  out.found = 0.0;
  out.level = 0.0;
  if (imagery.enabled == 0u) { return out; }

  // The level follows the short axis of the pixel's footprint on the ground;
  // anisotropic filtering takes up to `aniso` taps along the long one.
  let lx = length(dx);
  let ly = length(dy);
  let footprint = max(max(lx, ly) / max(imagery.aniso, 1.0), min(lx, ly));
  let zoom = imagery.zMax - log2(max(footprint, 1e-6)) - imagery.bias;
  let top = f32(imagery.top);
  let want = clamp(zoom - imagery.zMin, 0.0, top);
  // The nearest level, and the one beside it blended in across a band round each change of level (5.18f): with a
  // band of 0.5 the two either side of the zoom wanted, in its fraction, everywhere (trilinear, as up to 5.18e: two
  // samples a pixel); with less, one level alone between the bands ("brilinear"), half and half at the change itself,
  // so it stays a gradient, not a line.
  let nearest = min(floor(want + 0.5), top);
  let off = want - nearest;
  let band = max(imagery.band, 1e-3);
  let w = 0.5 * clamp((abs(off) - (0.5 - band)) / band, 0.0, 1.0);
  let besideUp = off > 0.0 && nearest < top;
  let besideDown = off < 0.0 && nearest > 0.0;
  let wanted = clamp(i32(nearest), 0, IMAGERY_WALK);

  // Every loop a pixel runs is bounded by a constant (5.17g; lost when 5.17i went back to 5.17d's shaders, put back in
  // 5.17o after his RTX 2080 Ti was reset again): IMAGERY_WALK levels down at most.
  var level = wanted;
  var walked = 0;
  loop {
    if (level < 0 || walked > IMAGERY_WALK) { return out; }
    walked++;
    let c = imageryLevel(u32(level), p, dx, dy);
    if (c.w > 0.0) {
      out.colour = c.rgb;
      out.found = 1.0;
      out.level = imagery.zMin + f32(level);
      // The level beside it, where the pixel is in a band (only where the nearest itself answered: while a finer
      // level streams in, the coarser stands alone).
      if (level == wanted && w > 0.0 && (besideUp || besideDown)) {
        let other = select(level - 1, level + 1, besideUp);
        let f = imageryLevel(u32(other), p, dx, dy);
        if (f.w > 0.0) {
          out.colour = mix(c.rgb, f.rgb, w);
          out.level += select(-w, w, besideUp);
        }
      }
      return out;
    }
    level -= 1;
  }
}
