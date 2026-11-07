// terrain.wgsl — the ground. Joined after common.wgsl, frame.wgsl,
// imagery.wgsl and vector.wgsl.
//
// Vertices arrive as offsets from their own tile's origin, and the tile
// uniform carries that origin already made relative to the camera. Adding the
// two in float32 is exact enough because both are small; the large numbers
// were cancelled out in double precision before anything reached the GPU.
//
// The same trick places imagery: each tile carries its mapping onto the
// imagery's pixel grid relative to an anchor near the camera, and every
// vertex computes its own Mercator position from its tile coordinates.
//
// All colours here are linear light; present() makes them display values.

// A stretch of a tunnel's bore (js/engine/tunnels/cuts.js), in the tile's
// own frame (metres east, north and up from its origin): its middle at the
// floor at each end, and its outline there as drawn (sections.js outlineAt:
// a rectangle `half` either side up to `top`, the arch's ellipse over it,
// its middle archY up, archA across and archH up; archA 0 a flat roof). A
// negative top: the bore ends at that end (a portal's mouth, or its far
// end); elsewhere a stretch runs on a quarter of a metre past its ends, so
// no wedge is left where the bore turns between two.
struct Cut {
  a     : vec3f,
  halfA : f32,
  b     : vec3f,
  halfB : f32,
  outA  : vec4f,   // top, archY, archA, archH at a
  outB  : vec4f,   // and at b
};

struct Tile {
  originRel : vec3f,   // tile origin minus camera position, metres
  level     : f32,     // quadtree level, for the debug view
  rect      : vec4f,   // west, south, east, north, degrees
  heights   : vec2f,   // min, max, metres
  mercX     : vec2f,   // west edge and width, imagery reference pixels
  mercY     : vec3f,   // y(v) = x + y v + z v^2, imagery reference pixels
  mask      : u32,     // quarters drawn by finer children instead: bit 0 east, bit 1 north
  // The tile's frame where a bore reaches it (east, north and up at its middle) and which of the cuts are its.
  east      : vec3f,
  cutFirst  : u32,
  north     : vec3f,
  cutCount  : u32,
  up        : vec3f,
  cutTop    : f32,     // the highest any of its bores reaches (the frame's up, metres)
  cutBox    : vec4f,   // and how far across they reach: least east, north, most east, north (the frame, metres)
};

@group(1) @binding(0) var<uniform> tile : Tile;
@group(1) @binding(1) var<storage, read> cuts : array<Cut>;

struct VSOut {
  @builtin(position) clip   : vec4f,
  @location(0)       world  : vec3f,   // relative to the camera
  @location(1)       normal : vec3f,
  @location(2)       height : f32,
  @location(3)       uv     : vec2f,
  @location(4)       skirt  : f32,
  @location(5)       merc   : vec2f,   // imagery reference pixels from the anchor
  @location(6) @interpolate(flat) mask  : u32,
  @location(7) @interpolate(flat) level : f32,
  @location(8)       local  : vec3f,   // in the tile's frame (east, north, up from its origin), where a bore reaches it
};

// Octahedral decode. The encoded pair is not a unit vector until this runs,
// so the normalise at the end is required, not defensive.
fn octDecode(e : vec2f) -> vec3f {
  var v = vec3f(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) {
    let s = vec2f(select(-1.0, 1.0, v.x >= 0.0), select(-1.0, 1.0, v.y >= 0.0));
    v = vec3f((1.0 - abs(vec2f(v.y, v.x))) * s, v.z);
  }
  return normalize(v);
}

@vertex
fn vs(@location(0) position : vec3f,
      @location(1) normal   : vec2f,
      @location(2) uvhs     : vec4f) -> VSOut {
  var out : VSOut;
  out.world  = position + tile.originRel;
  out.clip   = frame.viewProj * vec4f(out.world, 1.0);
  out.normal = octDecode(normal);
  out.height = mix(tile.heights.x, tile.heights.y, uvhs.z);
  out.uv     = uvhs.xy;
  out.skirt  = uvhs.w;
  // Longitude is linear in Mercator; latitude follows the tile's fitted curve.
  let v = uvhs.y;
  out.merc = vec2f(tile.mercX.x + uvhs.x * tile.mercX.y,
                   tile.mercY.x + v * (tile.mercY.y + v * tile.mercY.z));
  out.mask = tile.mask;
  out.level = tile.level;
  // (Zero where no bore reaches the tile: its frame is left unset then.)
  out.local = vec3f(dot(position, tile.east), dot(position, tile.north), dot(position, tile.up));
  return out;
}

// Where no imagery exists: a rough Swiss cross-section by altitude and slope.
// Slope matters as much as altitude, because anything steep enough sheds both
// soil and snow.
fn groundColour(height : f32, slope : f32) -> vec3f {
  let meadow = vec3f(0.0319, 0.0562, 0.0185);
  let forest = vec3f(0.0151, 0.0283, 0.0116);
  let rock   = vec3f(0.0783, 0.0703, 0.0597);
  let scree  = vec3f(0.1357, 0.1246, 0.1072);
  let snow   = vec3f(0.7446, 0.7914, 0.8378);

  var c = mix(meadow, forest, smoothstep(450.0, 900.0, height));
  c = mix(c, scree, smoothstep(1750.0, 2350.0, height));
  c = mix(c, snow, smoothstep(2500.0, 2900.0, height));
  c = mix(c, rock, smoothstep(0.72, 0.42, slope));
  return c;
}

// How far a cut or fill face looks away from the road for its colours
// (metres): past the face's top on most cuts, past its toe on most fills.
const FACE_LOOK_M : f32 = 3.0;

// A face the photo cannot show (taken from above, its pixels smear down a
// cliff, or over the face cut beside a road): its colours blurred to a
// metre or more (`blur`, photoBlur's, taken from the ground beside a cut or
// fill), with a grain on the face and its height, anchored to the map:
// rock's for `rock` 1, earth's (fainter) for 0. The grain is the face seen
// from the east or west (north and height) and from the north or south
// (east and height), blended by which way the face looks, so its beds stay
// level however the triangles turn: one direction along the face per
// pixel, as 5.16b first had it, bent them into chevrons where two
// triangles met.
fn faceLook(merc : vec2f, height : f32, n : vec3f, blur : vec4f, rock : f32) -> vec3f {
  let base = select(vec3f(0.075, 0.070, 0.062), blur.rgb, blur.w > 0.0);
  // Metres east and north from a point fixed on the map (the anchor's
  // reference pixel, wrapped every 65536 of them).
  let whole = floor(merc);
  let wrapped = (vtInfo.anchor + vec2u(vec2i(whole))) & vec2u(65535u);
  let p = (vec2f(wrapped) + (merc - whole)) * vtMetresPerRef() * vec2f(1.0, -1.0) + vec2f(16384.0);
  let h = abs(vec2f(dot(n, frame.east), dot(n, frame.north)));
  let h4 = h * h * h * h + vec2f(1e-6);
  let w = h4 / (h4.x + h4.y);
  // Four octaves, each seen both ways: grains of 0.6 and 1.7 m, beds 6 m
  // long and 1.2 m high, blocks of 5 m.
  var scale = array<vec2f, 4>(vec2f(0.6), vec2f(1.7), vec2f(6.0, 1.2), vec2f(5.0));
  var weight = array<f32, 4>(0.30, 0.25, 0.25, 0.15);
  var g = 0.0;
  for (var i = 0u; i < 8u; i++) {
    let k = i >> 1u;
    let east = (i & 1u) == 1u;
    let uv = vec2f(select(p.y, p.x, east), height + 8192.0);
    g += weight[k] * select(w.x, w.y, east) * (vtNoise(uv / scale[k], 65536u) - 0.5);
  }
  return base * (1.0 + g * mix(0.8, 1.6, rock));
}

@fragment
fn fs(in : VSOut) -> @location(0) vec4f {
  return shade(in, dpdx(in.merc), dpdy(in.merc), false);
}

// For a tile only partly replaced by finer children: the quarters they cover
// are left to them. Only these few tiles pay for the discard, which would
// otherwise cost every terrain pixel its early depth test.
@fragment
fn fsMasked(in : VSOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is still uniform.
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  return shade(in, dmx, dmy, false);
}

// Whether a point (the tile's frame) is inside a tunnel's bore: its outline
// exactly (a couple of centimetres more, so no sliver of ground is left on
// the tunnel's walls; any more would open the ground beside them), from
// FLOOR_UNDER under its floor up (ground lying at the floor's height inside
// a tube, as by a portal, showed through its floor in patches: the two at
// one depth; the road running in, pinned a hair under the floor at the
// portal, is outside the bore and stays).
const FLOOR_UNDER : f32 = 0.3;
// At most this many of a tile's segments are looked at (passes/terrain.js keeps the nearest first): a hard bound on
// a pixel's work, whatever the data (5.17f: a frame that takes the GPU too long has the driver reset it, and Chrome
// turns WebGPU off for a site that lost its GPU twice).
const CUT_MOST : u32 = 128u;

fn inBore(p : vec3f) -> bool {
  // Outside the reach of every bore in this tile, its box and its top (most of its pixels: the ground over the
  // tunnels and the rest of the tile), nothing to look at.
  if (p.z > tile.cutTop || any(p.xy < tile.cutBox.xy) || any(p.xy > tile.cutBox.zw)) { return false; }
  let last = tile.cutFirst + min(tile.cutCount, CUT_MOST);
  for (var i = tile.cutFirst; i < last; i++) {
    let c = cuts[i];
    let ab = c.b.xy - c.a.xy;
    let len = length(ab);
    if (len < 1e-3) { continue; }
    let dir = ab / len;
    let along = dot(p.xy - c.a.xy, dir);
    let before = select(0.25, 0.0, c.outA.x < 0.0);
    let past = select(0.25, 0.0, c.outB.x < 0.0);
    if (along < -before || along > len + past) { continue; }
    let t = clamp(along / len, 0.0, 1.0);
    let h = p.z - mix(c.a.z, c.b.z, t);
    if (h < -FLOOR_UNDER) { continue; }
    let across = dot(p.xy - c.a.xy, vec2f(dir.y, -dir.x));
    let o = mix(vec4f(abs(c.outA.x), c.outA.yzw), vec4f(abs(c.outB.x), c.outB.yzw), t);
    if (h <= o.x) {
      if (abs(across) <= mix(c.halfA, c.halfB, t) + 0.02) { return true; }
      continue;
    }
    if (o.z <= 0.0) { continue; }
    let x = across / (o.z + 0.02);
    let y = (h - o.y) / (o.w + 0.02);
    if (x * x + y * y <= 1.0) { return true; }
  }
  return false;
}

// For a tile a tunnel's bore reaches (or near a portal): the ground inside
// the bore is left out, so the tunnel shows through it and nothing of the
// ground stands inside it. Also does fsMasked's work: these few tiles pay
// for the discard, which would otherwise cost every terrain pixel its early
// depth test. Drawn from both sides (the pipeline culls nothing): seen from
// inside a tunnel, or through one, the ground round its portal (an
// embankment's slope beside the way out) is above the line of sight, met
// from beneath; shown as the earth it is, dark rock in its own shade (5.17c
// showed the photo of what lies over it, a road's asphalt and lines, lit
// from below: it read as sky), not seen through. From above nothing
// changes: a height field's first surface on any ray from over it is a
// front face.
@fragment
fn fsCut(in : VSOut, @builtin(front_facing) front : bool) -> @location(0) vec4f {
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  if (inBore(in.local)) { discard; }
  var seen = in;
  if (!front) { seen.normal = -in.normal; }
  return shade(seen, dmx, dmy, !front);
}

// `under`: the ground met from beneath (fsCut).
fn shade(in : VSOut, dmx : vec2f, dmy : vec2f, under : bool) -> vec4f {
  let photo = sampleImagery(in.merc, dmx, dmy);

  let n = normalize(in.normal);
  let up = localUp(in.world);
  let slope = dot(n, up);
  let modelled = modelledLight(n);

  var albedo : vec3f;
  var light = modelled;
  if (frame.debugMode == 1u) {
    albedo = (n * 0.5 + 0.5) * (n * 0.5 + 0.5);
  } else if (frame.debugMode == 2u) {
    let t = clamp(in.height / 4600.0, 0.0, 1.0);
    albedo = vec3f(t, t * t, 1.0 - t) * vec3f(t, t * t, 1.0 - t);
  } else if (frame.debugMode == 4u) {
    albedo = select(vec3f(0.02), levelColour(photo.level), photo.found > 0.0);
  } else if (frame.debugMode == 5u) {
    // Terrain levels: a hue per quadtree level, with each tile outlined.
    let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
    albedo = mix(vec3f(0.01), levelColour(in.level), smoothstep(0.0, 0.01, edge));
  } else if (under) {
    // The earth beside a tunnel's mouth, from inside it: rock, half lit.
    albedo = faceLook(in.merc, in.height, n, vec4f(0.0), 1.0);
    light = modelledLight(up) * 0.5;
  } else {
    albedo = mix(groundColour(in.height, slope), photo.colour, photo.found);
    light = mix(modelled, photoLight(n), photo.found);
    // Faces the photo cannot show (faceLook): any steeper than about 55°,
    // and those cut or filled beside a road (shape.c marks their vertices:
    // above 0 a cut, below a fill), whose colours come from the ground
    // beside them, up the hillside from a cut and down it from a fill,
    // where the photo has no road or kerb in it. Roads, tracks and paths
    // (vectorRoads). All take their colours from one sample of the photo
    // blurred, and only where one of them is drawn.
    let face = select(0.0, (in.skirt - 0.25) * 4.0, in.skirt < 0.5);
    let steep = smoothstep(0.6, 0.42, slope);
    // A face the photo shows green (grass or trees over the bank) keeps the
    // photo; one it shows in any other colour (the road's own pixels and its
    // kerb, beyond the level width) looks beside it. From above, a forest
    // track's banks were a blurred band through the trees.
    let leafy = vtMade(vec4f(photo.colour, photo.found));
    let look = select(0.0, max(steep, abs(face) * (1.0 - leafy)), frame.debugMode == 0u);
    var roads = vec2f(0.0);
    if (frame.debugMode == 0u || frame.debugMode == 3u) { roads = vectorReach(in.merc, dmx, dmy, photo); }
    // No road is steeper than about 55°: where a road's width in the data
    // is wider than its ledge, the wall or the cliff inside it shows rock,
    // not road (above Airolo the Gotthard road's width hangs over a 19 m
    // drop).
    roads.x *= smoothstep(0.42, 0.6, slope);
    if (look > 0.0 || roads.x > 0.0) {
      var at = in.merc;
      // The normal leans downhill: across the map, that way for a fill,
      // the other for a cut (merc's y runs south). The whole way from the
      // face's foot on: there, the photo has the road's edge, often in the
      // cut's own shadow (a dark streak along the Gotthard road's rock cut).
      let h = vec2f(dot(n, frame.east), dot(n, frame.north));
      if (abs(face) > 0.0 && length(h) > 0.02) {
        let away = normalize(h) * select(1.0, -1.0, face > 0.0);
        at = in.merc + vec2f(away.x, -away.y) * (FACE_LOOK_M * smoothstep(0.0, 0.25, abs(face)) / vtMetresPerRef());
      }
      let wide = select(32.0, 16.0, abs(face) > steep);
      let blur = photoBlur(at, max(select(6.0, wide, look > 0.0), max(length(dmx), length(dmy))));
      if (look > 0.0) { albedo = mix(albedo, faceLook(in.merc, in.height, n, blur, steep), look); }
      if (roads.x > 0.0) { albedo = vectorRoads(in.merc, dmx, dmy, albedo, roads, blur, VT_ON_GROUND); }
    }
    if (frame.debugMode == 3u) {
      let edge = min(min(in.uv.x, 1.0 - in.uv.x), min(in.uv.y, 1.0 - in.uv.y));
      albedo = mix(vec3f(0.7874, 0.0509, 0.0331), albedo, smoothstep(0.0, 0.006, edge));
    } else if (frame.debugMode == 6u) {
      // Roads and rails as the vector tiles have them.
      albedo = vectorDebug(in.merc, dmx, dmy, albedo);
    }
  }

  var colour = albedo * light;

  // Skirt geometry exists only to plug the seams between tiles; darkening it
  // slightly makes any that pokes into view obvious instead of confusing.
  // (Its flag is 1; the surface's 0 to 0.5, its faces: see qm.c.)
  colour *= mix(1.0, 0.72, saturate((in.skirt - 0.5) * 2.0));

  // The ground met from beneath is the earth the line of sight runs through, not ground seen across the air: no haze
  // over it (far off beyond a tunnel's mouth it took the sky's colour, a pale wedge at the bottom of the way out).
  if (under) { return present(colour, in.clip.xy); }
  return present(applyAtmosphere(colour, in.world, in.clip.xy), in.clip.xy);
}
