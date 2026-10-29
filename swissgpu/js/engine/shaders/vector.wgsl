// vector.wgsl — the roads and railways under a pixel, from the vector tiles
// on the GPU (js/engine/vector/tiles.js; the block layout is in
// js/formats/vector-tile.js). Joined after imagery.wgsl, whose reference
// pixels it shares.
//
// A pixel's place on the map is the imagery anchor (an integer pixel of the
// finest imagery zoom, the camera's) plus the small offset every terrain
// pixel already carries for the photos. So which tile it is in, and where
// in that tile, comes out of integer arithmetic: exact anywhere on the map,
// whatever float32 could hold, and nothing to rewrite when the camera moves.
// Each zoom has a window of 8 × 8 tiles round the camera; a page table says
// where in the pool each one's block starts, or that it is not there.
//
// Inside a tile, the pixel's cell of the block's grid lists the segments
// that can reach it, lowest drawing priority first, so painting them in
// order puts each over the ones below it without sorting anything.

const VT_ABSENT : u32 = 0xffffffffu;
const VT_WINDOW : u32 = 8u;
// The `enabled` word: on at all, and which Layers are drawn; a kind's flags
// (js/engine/vector/tiles.js writes both).
const VT_ON          : u32 = 1u;
const VT_LAYER_ROADS : u32 = 2u;
const VT_LAYER_PATHS : u32 = 4u;
const VT_REVEAL      : u32 = 8u;   // not drawn itself, but shows the photo over a road (rails, until 5.17b)
// Materials (the adapter's names: js/adapters/swisstopo-transport.js).
const VT_ASPHALT : u32 = 1u;
const VT_FOOTWAY : u32 = 2u;
const VT_GRAVEL  : u32 = 3u;
const VT_TRACK   : u32 = 4u;
const VT_DIRT    : u32 = 5u;
const VT_STEPS   : u32 = 6u;

struct VectorKind {
  colour   : vec3f,   // the data view's (linear)
  maxHalf  : f32,     // the widest it is listed in the grid for, half of it (m)
  half     : f32,     // half its width where its own is not known (m)
  material : u32,     // VT_ASPHALT…, 0: not drawn
  flags    : u32,     // VT_LAYER_ROADS, VT_LAYER_PATHS, VT_REVEAL
  rail     : f32,     // half the gauge for a railway (m), 0 for anything else
};

struct VectorInfo {
  anchor  : vec2u,              // the imagery anchor, reference pixels
  zRef    : u32,                // the zoom of the reference pixels
  enabled : u32,                // VT_ON | the layers drawn
  levels  : array<vec4u, 2>,    // zoom, window origin x and y (tiles), window size; 0 the detail zoom
  kinds   : array<VectorKind, 64>,
  widths  : array<vec4f, 4>,    // half-widths by width class: a road's own (attr bits 28-31), 0 none
};

@group(3) @binding(0) var<uniform> vtInfo : VectorInfo;
@group(3) @binding(1) var<storage, read> vtPages : array<u32>;
@group(3) @binding(2) var<storage, read> vtPool : array<u32>;

// Where a pixel is on one tile.
struct VectorSpot {
  block : u32,        // the block's first word in the pool, VT_ABSENT if not loaded
  p     : vec2f,      // tile units from the tile's north-west corner, y southwards
  units : f32,        // tile units per reference pixel
};

// The spot at reference-pixel offset `merc` on level `level`'s zoom.
fn vectorSpot(level : u32, merc : vec2f) -> VectorSpot {
  var out : VectorSpot;
  out.block = VT_ABSENT;
  let L = vtInfo.levels[level];
  if (L.w == 0u || L.x > vtInfo.zRef + 8u) { return out; }
  let shift = 8u + vtInfo.zRef - L.x;   // log2 of reference pixels per tile
  let whole = floor(merc);
  let px = vec2u(vec2i(vtInfo.anchor) + vec2i(whole));
  let tile = px >> vec2u(shift);
  // Unsigned: a tile before the window's corner wraps to a huge number.
  let rel = tile - L.yz;
  if (any(rel >= vec2u(L.w))) { return out; }
  let entry = vtPages[level * VT_WINDOW * VT_WINDOW + rel.y * VT_WINDOW + rel.x];
  if (entry == VT_ABSENT) { return out; }
  let inside = vec2f(px & vec2u((1u << shift) - 1u)) + (merc - whole);
  out.units = f32(vtPool[entry + 13u]) / f32(1u << shift);
  out.p = inside * out.units;
  out.block = entry;
  return out;
}

// The finest tile loaded under a pixel: the detail zoom's, else the
// overview's. `level` comes back as which it was.
fn vectorFind(merc : vec2f, level : ptr<function, u32>) -> VectorSpot {
  var spot = vectorSpot(0u, merc);
  *level = 0u;
  if (spot.block == VT_ABSENT) {
    spot = vectorSpot(1u, merc);
    *level = 1u;
  }
  return spot;
}

// A block's header, the part a pixel needs.
struct VectorBlock {
  grid     : u32,
  cells    : u32,     // first word of the cell table
  refs     : u32,     // first word of the references
  segments : u32,     // first word of the segments
  extent   : f32,     // tile units across
  metres   : f32,     // metres per tile unit
};

fn vectorBlock(b : u32) -> VectorBlock {
  var h : VectorBlock;
  h.grid = vtPool[b + 4u];
  h.cells = b + vtPool[b + 5u] / 4u;
  h.refs = b + vtPool[b + 6u] / 4u;
  h.segments = b + vtPool[b + 8u] / 4u;
  h.extent = f32(vtPool[b + 13u]);
  h.metres = bitcast<f32>(vtPool[b + 12u]);
  return h;
}

// The cell under p: its first reference and how many.
fn vectorCell(h : VectorBlock, p : vec2f) -> vec2u {
  let g = h.grid;
  let c = min(vec2u(max(p, vec2f(0.0)) * (f32(g) / h.extent)), vec2u(g - 1u));
  let word = vtPool[h.cells + c.y * g + c.x];
  return vec2u(word >> 8u, word & 255u);
}

// Reference i: a segment's number (16 bits, two to a word).
fn vectorRef(h : VectorBlock, i : u32) -> u32 {
  return (vtPool[h.refs + (i >> 1u)] >> ((i & 1u) * 16u)) & 0xffffu;
}

struct VectorSegment {
  a     : vec2f,      // tile units
  b     : vec2f,
  along : vec2f,      // metres along the line at a and at b (the dash phase)
  attr  : u32,        // kind, bridge or tunnel, layer… (ATTR in vector-tile.js)
  link  : u32,        // its line, and what its ends meet (LINK)
};

fn vectorSegment(h : VectorBlock, s : u32) -> VectorSegment {
  let o = h.segments + s * 8u;
  var g : VectorSegment;
  g.a = vec2f(bitcast<f32>(vtPool[o]), bitcast<f32>(vtPool[o + 1u]));
  g.b = vec2f(bitcast<f32>(vtPool[o + 2u]), bitcast<f32>(vtPool[o + 3u]));
  g.along = vec2f(bitcast<f32>(vtPool[o + 4u]), bitcast<f32>(vtPool[o + 5u]));
  g.attr = vtPool[o + 6u];
  g.link = vtPool[o + 7u];
  return g;
}

// From p to the segment: the distance (tile units) and how far along it the
// nearest point is (0 at a, 1 at b).
fn segmentDistance(p : vec2f, a : vec2f, b : vec2f) -> vec2f {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return vec2f(length(p - a - ab * t), t);
}

// Graphics → Diagnostics → Terrain view → Roads and rails (data): every line
// as it arrived, in its kind's colour, over the photo darkened; the band its
// widest drawing may cover shaded; bridges brighter, tunnels dashed (by the
// length along them, so the dashes run on across tiles where the phase is
// right); tiles outlined, the detail zoom's white, the overview's grey.
// `dmx`, `dmy`: merc's screen derivatives.
fn vectorDebug(merc : vec2f, dmx : vec2f, dmy : vec2f, base : vec3f) -> vec3f {
  if (vtInfo.enabled == 0u) { return base; }
  var level : u32;
  let spot = vectorFind(merc, &level);
  if (spot.block == VT_ABSENT) { return base * 0.35; }
  let h = vectorBlock(spot.block);
  // A screen pixel on the ground, tile units and metres.
  let pixelUnits = max(length(dmx), length(dmy)) * spot.units;
  let pixel = max(pixelUnits * h.metres, 1e-4);

  var colour = base * 0.45;
  let cell = vectorCell(h, spot.p);
  for (var i = 0u; i < cell.y; i++) {
    let g = vectorSegment(h, vectorRef(h, cell.x + i));
    let kind = vtInfo.kinds[g.attr & 63u];
    let d = segmentDistance(spot.p, g.a, g.b);
    let m = d.x * h.metres;
    let brunnel = (g.attr >> 6u) & 3u;
    let band = 1.0 - smoothstep(kind.maxHalf - pixel, kind.maxHalf + pixel, m);
    colour = mix(colour, kind.colour * 0.35, band * 0.5);
    var line = 1.0 - smoothstep(pixel, 2.0 * pixel, m);
    if (brunnel == 2u) {
      line *= step(0.5, fract(mix(g.along.x, g.along.y, d.y) / 6.0));
    }
    let c = select(kind.colour, min(kind.colour * 1.5 + vec3f(0.25), vec3f(1.0)), brunnel == 1u);
    colour = mix(colour, c, line);
  }

  let edge = min(min(spot.p.x, h.extent - spot.p.x), min(spot.p.y, h.extent - spot.p.y)) / max(pixelUnits, 1e-6);
  let outline = select(vec3f(0.25), vec3f(0.9), level == 0u);
  return mix(outline, colour, smoothstep(1.0, 2.0, edge));
}

// ---- roads on the ground ---------------------------------------------------
//
// Every terrain pixel near enough looks up the segments of its grid cell
// and goes through the roads, tracks, paths and steps that cover it, in
// drawing order, at each road's own width. Where the photo shows the road
// (asphalt, gravel, markings, patches, shadows: his plan for Stage 5.16b,
// "use satellite imagery on the roads"), the photo is the road: sharpened
// a little against its own blur, and where its pixels are magnified on the
// screen a grain finer than them is laid over it, so the road does not look
// smeared underfoot. Only where the photo over a road is green (trees or
// grass grown over it, vtMade) is a surface made here instead, blended in
// as far as the photo is: asphalt, gravel, two ruts with grass between, earth, stone steps,
// as bright as the photo there (within limits). The lines themselves show
// only in the data view (vectorDebug).
//
// Made surfaces are drawn out to where a screen pixel covers about a
// quarter of a metre of ground, and nothing at all past half a metre, so
// the cost is all near the camera, and forests and fields with no road in
// their grid cell cost one look-up.
//
// Coverage is the pixel's share of the road's width, worked out from how
// far one screen pixel moves across the road's edge (anisotropic: a road
// seen end-on keeps a sharp edge), so edges neither shimmer nor stair-step.
// All the pieces of a kind under a pixel (one road's, at a joint or where
// two of them cross) are painted once, with the most any of them covers,
// so a road has no seams at its joints. Bridges and tunnels are not on the
// ground and are not drawn there (a bridge's road is drawn on its deck, by
// the buildings' shader). Railways are not drawn yet; where one crosses a
// road (a level crossing, a tram in the street) its rails are set into it.
//
// Written so that each costly step has one call site (the noise, the
// surfaces, the painting, the blurred photo, which the caller samples):
// shader compilers inline every call, and on a software GPU a first draft
// with many of them stalled frames for long enough that the browser reset
// the device.

const VT_PERIOD : f32 = 4096.0;   // the made surfaces repeat every this many reference pixels (≈ 420 m)
const VT_NONE : u32 = 0xffffffffu;

// Metres per reference pixel at the camera's latitude (near enough for
// anything drawn close by).
fn vtMetresPerRef() -> f32 {
  let lat = asin(clamp(frame.cameraEcef.z / length(frame.cameraEcef), -1.0, 1.0));
  return 40075016.686 * cos(lat) / exp2(f32(vtInfo.zRef) + 8.0);
}

// Hash of a lattice point, in [0, 1) (pcg2d: Jarzynski and Olano, 2020).
fn vtHash(p : vec2u) -> f32 {
  var v = p * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v = v ^ (v >> vec2u(16u));
  return f32(v.x >> 8u) * (1.0 / 16777216.0);
}

// Value noise on a lattice repeating every `period` cells (a power of two).
fn vtNoise(x : vec2f, period : u32) -> f32 {
  let i = floor(x);
  let f = x - i;
  let u = f * f * (3.0 - 2.0 * f);
  let m = vec2u(period - 1u);
  let c = vec2u(i);
  let a = vtHash(c & m);
  let b = vtHash((c + vec2u(1u, 0u)) & m);
  let d = vtHash((c + vec2u(0u, 1u)) & m);
  let e = vtHash((c + vec2u(1u, 1u)) & m);
  return mix(mix(a, b, u.x), mix(d, e, u.x), u.y);
}

// What painting the roads needs of a pixel.
struct RoadPixel {
  world  : vec2f,   // position, reference pixels, repeating every VT_PERIOD
  mpr    : f32,     // metres per reference pixel
  fp     : f32,     // the pixel's footprint on the ground along its longer axis, reference pixels
  dxm    : vec2f,   // metres the map moves per screen pixel, right and down
  dym    : vec2f,
  photo  : vec3f,   // the ground's colour here before any road: the photo's (or the made-up ground's)
  blur   : vec4f,   // the photo blurred to about 60 cm, and whether there is one
  made   : f32,     // how unlike a road the photo is here (vtMade): the made surface's share
  reach  : f32,     // made surfaces drawn here, 0 to 1 (vectorReach)
  detail : f32,     // the photo's pixels magnified here, 0 to 1: its sharpening and grain
};

// The grain every surface is made of: value noise at about 1, 4, 16 and
// 64 cm and 2.5 m (each between -0.5 and 0.5, faded out where the pixel is
// wider than its cells), its cells rounded to a power of two of reference
// pixels so that it repeats with the world coordinate.
struct Grain {
  fine  : vec4f,
  broad : f32,
};

fn vtGrain(px : RoadPixel) -> Grain {
  var g : array<f32, 5>;
  let c0 = log2(0.01 / px.mpr);
  for (var i = 0u; i < 5u; i++) {
    let cell = exp2(clamp(round(c0 + 2.0 * f32(i)), -6.0, 11.0));
    let fade = 1.0 - smoothstep(0.5 * cell, 1.5 * cell, px.fp);
    var n = 0.0;
    if (fade > 0.0) { n = (vtNoise(px.world / cell, u32(VT_PERIOD / cell)) - 0.5) * fade; }
    g[i] = n;
  }
  var out : Grain;
  out.fine = vec4f(g[0], g[1], g[2], g[3]);
  out.broad = g[4];
  return out;
}

fn vtLuminance(c : vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// The colours the surfaces are made in (linear); their brightness is then
// matched to the photo's (vtPaint).
const VT_ASPHALT_RGB  : vec3f = vec3f(0.115, 0.114, 0.110);
const VT_GRAVEL_RGB   : vec3f = vec3f(0.300, 0.270, 0.220);
const VT_EARTH_RGB    : vec3f = vec3f(0.200, 0.155, 0.110);
const VT_GRASS_RGB    : vec3f = vec3f(0.055, 0.085, 0.030);
const VT_STONE_RGB    : vec3f = vec3f(0.270, 0.260, 0.240);
const VT_STEEL_RGB    : vec3f = vec3f(0.250, 0.260, 0.280);   // a rail's head, polished by wheels
const VT_LIP_RGB      : vec3f = vec3f(0.110, 0.110, 0.115);   // a grooved rail's guard lip

// How unlike a road the photo is, 0 (it shows one) to 1 (trees or grass
// cover it): how much greener than both red and blue its chromaticity is,
// min(g - r, g - b). Measured on SWISSIMAGE round Airolo (666 points on road
// lines, 1 m across): paved roads stay under 0.012 at their 99th percentile,
// tracks under 0.021 at their 90th; above 0.06 every one was under trees or
// grass. Excess green (2g - r - b) cannot be used: it is as high on yellowish
// grey gravel and brown earth, whose blue is low too, as on grass. Grey of any
// brightness (asphalt, concrete, markings, shadows, which are bluish), browns
// and yellows (gravel, earth, crossings) and cars are what the photo shows of
// a road. No photo: nothing to show, so 1.
fn vtMade(blur : vec4f) -> f32 {
  if (blur.w <= 0.0) { return 1.0; }
  let c = blur.rgb / max(blur.r + blur.g + blur.b, 1e-5);
  return smoothstep(0.03, 0.06, min(c.g - c.r, c.g - c.b));
}

// What a kind's surface is under this road's own attributes: paved or not
// (base.vt's surface), in town or not (footways are paved in town).
fn vtSurface(material : u32, attr : u32) -> u32 {
  let surface = (attr >> 12u) & 3u;
  let town = ((attr >> 27u) & 1u) != 0u;
  var m = material;
  if (m == VT_FOOTWAY) { m = select(VT_GRAVEL, VT_ASPHALT, town); }
  if (surface == 1u && (m == VT_GRAVEL || m == VT_TRACK || m == VT_DIRT)) { m = VT_ASPHALT; }
  if (surface == 2u && m == VT_ASPHALT) { m = VT_GRAVEL; }
  return m;
}

// A thin band's share of a pixel: `d` metres from the band's middle, `w`
// half its width, `fw` metres a pixel spans across it.
fn vtBand(d : f32, w : f32, fw : f32) -> f32 {
  return saturate((w - d) / fw + 0.5) - saturate((-w - d) / fw + 0.5);
}

// One kind's pieces under the pixel, gathered (see vectorRoads).
struct RoadGroup {
  kind    : u32,
  cover   : f32,      // the most any of them covers
  nearest : f32,      // how far into its width the nearest is, its middle 0
  across  : f32,      // and where the pixel is against it: metres, left positive
  along   : f32,      // metres along its line
  half    : f32,
  attr    : u32,
  tangent : vec2f,
};

fn vtEmptyGroup(kind : u32) -> RoadGroup {
  var g : RoadGroup;
  g.kind = kind;
  g.cover = 0.0;
  g.nearest = 1e9;
  g.tangent = vec2f(1.0, 0.0);
  return g;
}

// Paints a gathered kind over the colour so far. A road: the photo, where it
// shows one (sharpened against its blur where its pixels are magnified, a
// grain finer than them over it), and a made surface as far as it does not
// (vtMade), as bright as the photo under it within limits, so a shadow
// stays and a canopy only darkens it; out to where made surfaces are drawn
// (reach). A railway: its rails set into the road (Ri60 grooved rails: a 55
// mm head outside the gauge line, the 42 mm groove inside it, then the
// guard lip; a level crossing's rails have their flangeway there too).
fn vtPaint(px : RoadPixel, g : RoadGroup, colour : vec3f) -> vec3f {
  if (g.cover <= 0.0) { return colour; }
  let kind = vtInfo.kinds[g.kind];
  let gr = vtGrain(px);
  let x = abs(g.across);
  let normal = vec2f(-g.tangent.y, g.tangent.x);
  let fw = max(length(vec2f(dot(normal, px.dxm), dot(normal, px.dym))), 1e-4);
  if ((kind.flags & VT_REVEAL) != 0u) {
    let cover = g.cover * px.reach;
    let head = vtBand(abs(x - (kind.rail + 0.0275)), 0.0275, fw);
    let groove = vtBand(abs(x - (kind.rail - 0.021)), 0.021, fw);
    let lip = vtBand(abs(x - (kind.rail - 0.048)), 0.006, fw);
    var c = mix(colour, vec3f(0.012), groove * cover);
    c = mix(c, VT_LIP_RGB, lip * cover);
    return mix(c, VT_STEEL_RGB * (1.0 + 0.6 * gr.fine.y), head * cover);
  }
  let m = vtSurface(kind.material, g.attr);
  let unpaved = m == VT_GRAVEL || m == VT_TRACK || m == VT_DIRT;
  // The photo's road, a little sharper, its grain coarser on unpaved roads.
  // Only its own detail is sharpened: the difference from its blur is held
  // within a quarter of the blur's brightness, so a strong edge beside the
  // road (a white verge, a kerb) does not ring dark along its side.
  let detail = clamp(px.photo - px.blur.rgb, -0.25 * px.blur.rgb, 0.25 * px.blur.rgb);
  let sharp = max(px.photo + 0.3 * detail, vec3f(0.0));
  let grain = select(1.0, 1.8, unpaved) * dot(gr.fine.xyz, vec3f(0.20, 0.12, 0.06));
  var out = mix(colour, sharp * (1.0 + grain), g.cover * px.detail * (1.0 - px.made));
  let share = g.cover * px.made * px.reach;
  if (share <= 0.0) { return out; }
  var c = VT_ASPHALT_RGB;
  var own = VT_ASPHALT_RGB;    // what the photo's brightness is matched against
  if (m == VT_ASPHALT) {
    // The aggregate's grain and a few lighter stones, the wear of years.
    c = VT_ASPHALT_RGB * (1.0 + dot(gr.fine, vec4f(0.55, 0.30, 0.14, 0.16)) + 0.10 * gr.broad +
      0.35 * smoothstep(0.32, 0.46, gr.fine.x));
  } else if (m == VT_GRAVEL) {
    let warm = gr.fine.y;
    c = VT_GRAVEL_RGB * vec3f(1.0 + 0.10 * warm, 1.0, 1.0 - 0.12 * warm) * (1.0 + dot(gr.fine, vec4f(0.80, 0.45, 0.0, 0.20)));
    own = VT_GRAVEL_RGB;
  } else if (m == VT_DIRT) {
    // Earth with small stones in it, grass growing in from the edges.
    c = VT_EARTH_RGB * (1.0 + dot(gr.fine, vec4f(0.0, 0.45, 0.35, 0.0)) + 0.20 * gr.broad);
    c = mix(c, VT_GRAVEL_RGB, 0.6 * smoothstep(0.30, 0.45, gr.fine.y));
    let edge = smoothstep(0.55, 1.0, x / max(g.half, 0.05) + 0.6 * gr.fine.z);
    c = mix(c, VT_GRASS_RGB * (1.0 + gr.fine.y), edge);
    own = mix(VT_EARTH_RGB, VT_GRASS_RGB, 0.25);
  } else if (m == VT_TRACK) {
    // Two wheel ruts of gravel, grass between them and along the edges.
    let rut = min(0.8, 0.55 * g.half);
    let soft = max(0.08, fw);
    let inRut = 1.0 - smoothstep(0.24 - soft, 0.24 + soft, abs(x - rut) + 0.08 * gr.fine.z);
    let gravel = VT_GRAVEL_RGB * (1.0 + 0.8 * gr.fine.x + 0.3 * gr.fine.w);
    let grass = VT_GRASS_RGB * (1.0 + 0.9 * gr.fine.y + 0.4 * gr.fine.w);
    c = mix(grass, gravel, inRut);
    own = mix(VT_GRAVEL_RGB, VT_GRASS_RGB, 0.6);
  } else if (m == VT_STEPS) {
    // A riser every 30 cm along the line: its shadow, then the step's nose.
    let ds = max(length(vec2f(dot(g.tangent, px.dxm), dot(g.tangent, px.dym))), 1e-4);
    let f = fract(g.along / 0.3);
    let lines = 1.0 - smoothstep(0.04, 0.08, ds);
    let riser = (1.0 - smoothstep(0.08 - ds / 0.3, 0.08 + ds / 0.3, f)) * lines;
    let nose = smoothstep(0.08, 0.10, f) * (1.0 - smoothstep(0.12, 0.16, f)) * lines;
    c = VT_STONE_RGB * (1.0 + 0.35 * gr.fine.y + 0.15 * gr.fine.z) * (1.0 - 0.45 * riser + 0.15 * nose);
    own = VT_STONE_RGB;
  }
  let tint = select(1.0, clamp(vtLuminance(px.blur.rgb) / vtLuminance(own), 0.4, 1.7), px.blur.w > 0.0);
  return mix(out, c * tint, share);
}

// How much of the roads to draw at a pixel: x, the made surfaces (a screen
// pixel covering under a quarter of a metre of ground across its shorter
// side, none past half a metre), y, the photo's own detail (its pixels, at
// the zoom it came from, over that side: twice or more, all of it). Both 0
// where there is no road tile or nothing in the pixel's cell. Cheap: the
// caller samples the blurred photo only where x is above 0.
fn vectorReach(merc : vec2f, dmx : vec2f, dmy : vec2f, photo : ImagerySample) -> vec2f {
  if ((vtInfo.enabled & VT_ON) == 0u || (vtInfo.enabled & (VT_LAYER_ROADS | VT_LAYER_PATHS)) == 0u) { return vec2f(0.0); }
  let shortest = max(min(length(dmx), length(dmy)), 1e-6);
  let reach = 1.0 - smoothstep(0.25, 0.5, shortest * vtMetresPerRef());
  if (reach <= 0.0) { return vec2f(0.0); }
  let texel = select(exp2(f32(vtInfo.zRef) - photo.level), 1e6, photo.found <= 0.0);
  var level : u32;
  let spot = vectorFind(merc, &level);
  if (spot.block == VT_ABSENT) { return vec2f(0.0); }
  let h = vectorBlock(spot.block);
  if (vectorCell(h, spot.p).y == 0u) { return vec2f(0.0); }
  return vec2f(reach, smoothstep(1.0, 2.0, texel / shortest));
}

// The ground's colour with the roads on it. `base`: the photo's (or the
// made-up ground's); `drawn`: vectorReach's answer; `blur`: the photo
// blurred to about 60 cm (rgb, and w > 0 if there is one), which tells
// whether the photo shows a road and sharpens it, and which the made
// surfaces take their brightness from; `dmx`, `dmy`: merc's screen
// derivatives. `deck`: the surface is a bridge's deck (buildings.wgsl),
// where only the bridges' roads are drawn; on the ground, they and the
// tunnels are not.
fn vectorRoads(merc : vec2f, dmx : vec2f, dmy : vec2f, base : vec3f, drawn : vec2f, blur : vec4f, deck : bool) -> vec3f {
  var level : u32;
  let spot = vectorFind(merc, &level);
  if (spot.block == VT_ABSENT || drawn.x <= 0.0) { return base; }
  let h = vectorBlock(spot.block);
  let cell = vectorCell(h, spot.p);

  var px : RoadPixel;
  let whole = floor(merc);
  let wrapped = (vtInfo.anchor + vec2u(vec2i(whole))) & vec2u(u32(VT_PERIOD) - 1u);
  px.world = vec2f(wrapped) + (merc - whole);
  px.mpr = spot.units * h.metres;
  px.fp = max(length(dmx), length(dmy));
  px.dxm = dmx * px.mpr;
  px.dym = dmy * px.mpr;
  px.photo = base;
  px.blur = blur;
  px.made = vtMade(blur);
  px.reach = drawn.x;
  px.detail = drawn.y;

  var colour = base;
  var painted = false;
  var g = vtEmptyGroup(VT_NONE);
  var i = 0u;
  loop {
    // The next piece that covers the pixel (VT_NONE at the end).
    var k = VT_NONE;
    var cover = 0.0;
    var across = 0.0;
    var along = 0.0;
    var half = 0.0;
    var attr = 0u;
    var tangent = vec2f(1.0, 0.0);
    loop {
      if (i >= cell.y) { break; }
      let o = h.segments + vectorRef(h, cell.x + i) * 8u;
      i++;
      let a32 = vtPool[o + 6u];
      let kk = a32 & 63u;
      let kind = vtInfo.kinds[kk];
      let reveal = (kind.flags & VT_REVEAL) != 0u;
      // Railways come last in the drawing order: with no road under the
      // pixel, there is nothing to set their rails into.
      if (reveal && !painted && g.cover <= 0.0) { i = cell.y; break; }
      let brunnel = (a32 >> 6u) & 3u;
      if ((!reveal && (kind.flags & vtInfo.enabled) == 0u) || (deck != (brunnel == 1u)) || brunnel == 2u) { continue; }
      let a = vec2f(bitcast<f32>(vtPool[o]), bitcast<f32>(vtPool[o + 1u]));
      let b = vec2f(bitcast<f32>(vtPool[o + 2u]), bitcast<f32>(vtPool[o + 3u]));
      let ab = b - a;
      let len2 = max(dot(ab, ab), 1e-12);
      let t = clamp(dot(spot.p - a, ab) / len2, 0.0, 1.0);
      let q = (spot.p - a - ab * t) * h.metres;
      let d = length(q);
      let code = a32 >> 28u;
      var w = min(select(kind.half, vtInfo.widths[code >> 2u][code & 3u], code != 0u), kind.maxHalf);
      if (d > w + 4.0 * px.fp * px.mpr + 0.5) { continue; }
      let tg = ab * inverseSqrt(len2);
      let s = mix(bitcast<f32>(vtPool[o + 4u]), bitcast<f32>(vtPool[o + 5u]), t);
      let n = vec2f(-tg.y, tg.x);
      var fw = max(length(vec2f(dot(n, px.dxm), dot(n, px.dym))), 1e-4);
      if (kind.material == VT_DIRT) {
        // A path's edge wanders and is soft: grass grows into it.
        w *= 0.85 + 0.3 * vtNoise(vec2f(fract(s / 1740.8) * 1024.0, f32(kk)), 1024u);
        fw = max(fw, 0.15 * w);
      }
      let c = vtBand(d, w, fw);
      if (c <= 0.0) { continue; }
      k = kk; cover = c; across = tg.x * q.y - tg.y * q.x; along = s; half = w; attr = a32; tangent = tg;
      break;
    }
    // A new kind, or the end: the one gathered so far is painted.
    if (k != g.kind || k == VT_NONE) {
      colour = vtPaint(px, g, colour);
      painted = painted || g.cover > 0.0;
      if (k == VT_NONE) { break; }
      g = vtEmptyGroup(k);
    }
    g.cover = max(g.cover, cover);
    let near = abs(across) / max(half, 1e-3);
    if (near < g.nearest) {
      g.nearest = near;
      g.across = across;
      g.along = along;
      g.half = half;
      g.attr = attr;
      g.tangent = tangent;
    }
  }
  return colour;
}
