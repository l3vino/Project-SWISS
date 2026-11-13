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

// A tunnel portal the terrain is opened at (js/engine/tunnels/tunnels.js,
// fit.js): inside the tunnel's outline as drawn (sections.js outlineAt: a
// rectangle up to `spring`, the arch's ellipse over it), from `before`
// metres outside the portal (its collar) to `depth` metres in (where the
// ground is over the vault, never past the tube), bending with the tube,
// and above its floor (the tube's floor is there from the collar in: the
// road running in, pinned a hair under it, stays under it; 5.17c kept the
// ground within 0.3 m over the floor, a sliver standing in the mouth).
struct Portal {
  origin : vec3f,   // the portal's floor minus the camera, metres
  grade  : f32,     // the floor's rise per metre into the tunnel
  inward : vec3f,   // into the tunnel, level, earth-centred
  half   : f32,     // half the outline's width up to `spring`, metres
  right  : vec3f,   // right of the way in
  spring : f32,     // metres up the rectangle reaches
  up     : vec3f,
  bend   : f32,     // the middle turns right: bend · along² / 2 metres
  offset : f32,     // the opening's middle at the portal, metres right of `origin`
  before : f32,
  depth  : f32,
  archY  : f32,     // the arch: its ellipse's middle (metres up), half-width and half-height; archA 0: a flat roof
  archA  : f32,
  archH  : f32,
  rise   : f32,     // out of the portal the floor rises as its approach does: this a metre out
  _p1    : f32,
};

struct Tile {
  originRel : vec3f,   // tile origin minus camera position, metres
  level     : f32,     // quadtree level, for the debug view
  rect      : vec4f,   // west, south, east, north, degrees
  heights   : vec2f,   // min, max, metres
  mercX     : vec2f,   // west edge and width, imagery reference pixels
  mercY     : vec3f,   // y(v) = x + y v + z v^2, imagery reference pixels
  mask      : u32,     // quarters drawn by finer children instead: bit 0 east, bit 1 north; bits 8, 9: portals[0], [1] used
  portals   : array<Portal, 2>,
};

@group(1) @binding(0) var<uniform> tile : Tile;

// The ground cut along a tunnel's whole bore (5.17k): bore.wgsl's slot of the pieces reaching this tile (cutSlot).

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
  @location(8)       rel    : vec3f,   // from the tile's origin, metres (earth-centred axes): for the bore cut
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
  out.rel    = position;
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
  return shade(in, dpdx(in.merc), dpdy(in.merc), false, facetOf(in.world), false);
}

// For a tile only partly replaced by finer children: the quarters they cover
// are left to them. Only these few tiles pay for the discard, which would
// otherwise cost every terrain pixel its early depth test.
@fragment
fn fsMasked(in : VSOut) -> @location(0) vec4f {
  // Derivatives first, while control flow is still uniform.
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let facet = facetOf(in.world);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  return shade(in, dmx, dmy, false, facet, false);
}

// Whether a point (camera-relative) is inside a portal's opening: its
// outline exactly (a couple of centimetres more, so no sliver of ground is
// left on the tunnel's walls; any more would open the ground beside them).
fn inPortal(p : Portal, world : vec3f) -> bool {
  let d = world - p.origin;
  let along = dot(d, p.inward);
  if (along < -p.before || along > p.depth) { return false; }
  let a = dot(d, p.right) - p.offset - 0.5 * p.bend * along * along;
  let h = dot(d, p.up) - select(p.grade * along, -p.rise * along, along < 0.0);
  if (h < 0.02) { return false; }
  if (h <= p.spring) { return abs(a) <= p.half + 0.02; }
  if (p.archA <= 0.0) { return false; }
  let x = a / (p.archA + 0.02);
  let y = (h - p.archY) / (p.archH + 0.02);
  return x * x + y * y <= 1.0;
}

// For a tile a tunnel portal touches: the ground inside the tunnel's
// opening is left out, so the tunnel shows through it. Also does fsMasked's
// work: these few tiles pay for the discard, which would otherwise cost
// every terrain pixel its early depth test. Drawn from both sides (the
// pipeline culls nothing): seen from inside a tunnel, or through one, the
// ground round its portal (an embankment's slope beside the way out) is
// above the line of sight, met from beneath; shown as the earth it is, dark
// rock in its own shade (5.17c showed the photo of what lies over it, a
// road's asphalt and lines, lit from below: it read as sky), not seen
// through. From above nothing changes: a height field's first surface on
// any ray from over it is a front face.
@fragment
fn fsPortal(in : VSOut, @builtin(front_facing) front : bool) -> @location(0) vec4f {
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let facet = facetOf(in.world);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  if (((in.mask >> 8u) & 1u) != 0u && inPortal(tile.portals[0], in.world)) { discard; }
  if (((in.mask >> 9u) & 1u) != 0u && inPortal(tile.portals[1], in.world)) { discard; }
  var seen = in;
  if (!front) { seen.normal = -in.normal; }
  return shade(seen, dmx, dmy, !front, facet, false);
}

// Whether a point of the ground is inside a tunnel's bore (the slot's pieces): within its walls up to their top,
// or under its arch; a couple of centimetres more, so no sliver of ground is left on its walls; from FLOOR_UNDER under
// its floor up, or beside it its walkways' top (ground lying at the floor's height inside a tube, as by a portal,
// showed through its floor in patches and on its entrance: the two at one depth; the road running in, pinned a hair
// under the floor at the portal, is outside the bore and stays). 1 inside one (left out); 2 on the floor of an open
// approach in front of a tube (5.17n, cuts.js addAprons: a piece with a negative kerb), within APRON_TOP of it; else 0.
// (5.17o dug the ground over the floor out of each portal away here too: holes, the ground being a surface with
// nothing under it; the excavation is now the terrain's own, vector/portals.js APRON.)
const FLOOR_UNDER : f32 = 0.3;
const APRON_TOP : f32 = 0.6;
const APRON_RGB : vec3f = vec3f(0.16, 0.15, 0.13);   // ballast, a road's shoulder
fn inBore(rel : vec3f) -> u32 {
  let q = slotPoint(rel);
  if (q.w == 0.0) { return 0u; }
  let last = min(cutSlot.count, CUT_MOST);
  var found = 0u;
  for (var i = 0u; i < last; i++) {
    let c = cutSlot.list[i];
    let apron = c.low.z < 0.0;
    let r = cutAt(c, q.xyz, select(0.02, 0.0, apron), 1.0);
    // (No early way out of the loop: one count of steps for every pixel.)
    let inside = r.y > 0.0;
    if (inside && !apron && r.x >= -FLOOR_UNDER) { found = 1u; }
    if (inside && apron && r.x >= -APRON_TOP && found == 0u) { found = 2u; }
  }
  return found;
}

// For a tile a tunnel's bore reaches (5.17k): the ground inside the bore is left out, all along it, so the tunnel
// shows through it at its mouth and nothing of the ground stands inside it (5.17d's openings, fsPortal, reach a few
// metres into a portal and two to a tile). Drawn from both sides as fsPortal is.
@fragment
fn fsCut(in : VSOut, @builtin(front_facing) front : bool) -> @location(0) vec4f {
  let dmx = dpdx(in.merc);
  let dmy = dpdy(in.merc);
  let facet = facetOf(in.world);
  let quarter = select(0u, 1u, in.uv.x >= 0.5) | select(0u, 2u, in.uv.y >= 0.5);
  if (((in.mask >> quarter) & 1u) != 0u) { discard; }
  let bore = inBore(in.rel);
  if (bore == 1u) { discard; }
  var seen = in;
  if (!front) { seen.normal = -in.normal; }
  return shade(seen, dmx, dmy, !front, facet, bore == 2u);
}

// The triangle's own normal (unnormalised, either way round), from how the position changes across the pixel.
fn facetOf(world : vec3f) -> vec3f {
  return cross(dpdx(world), dpdy(world));
}

// `under`: the ground met from beneath (fsPortal, fsCut). `facet`: facetOf, its triangle's own normal. `apron`: the
// floor of an open approach in front of a tunnel's tube (fsCut, inBore).
fn shade(in : VSOut, dmx : vec2f, dmy : vec2f, under : bool, facet : vec3f, apron : bool) -> vec4f {
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
  } else if (apron) {
    // The open approach in front of a tube (5.17n): the photo there shows the hillside over the real portal; its floor
    // as the tube's, ballast, the tunnel's own roads and tracks on it (vector.wgsl, as in the tube).
    let grain = vtNoise(in.merc * 1.5 + vec2f(1024.0), 65536u) - 0.5;
    albedo = vectorRoads(in.merc, dmx, dmy, APRON_RGB * (1.0 + 0.5 * grain), vec2f(1.0, 0.0), vec4f(0.0), VT_IN_TUNNEL);
    light = mix(modelled, photoLight(n), photo.found);
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
    // A face cut or filled is as steep as its own triangle (5.17m): its vertices' normals are shared with the level
    // and the ground either side, and on a cutting's wall 10 m high they leant as little as the ground does, so it
    // kept the photo's treetops, stretched down it (his 5.17l screenshot of the railway's cutting by Giubiasco).
    let fl = length(facet);
    let facetSlope = select(slope, abs(dot(facet, up)) / fl, fl > 1e-12);
    let steep = smoothstep(0.6, 0.42, select(slope, min(slope, facetSlope), face != 0.0));
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
      // And lit as its own triangle faces (turned to the side its vertices' normals are on).
      if (look > 0.0 && face != 0.0 && fl > 1e-12) {
        let own = facet / fl * select(-1.0, 1.0, dot(facet, n) >= 0.0);
        light = mix(light, mix(modelledLight(own), photoLight(own), photo.found), look);
      }
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
  // over it (5.17e had this; from 5.17i on, far off beyond a tunnel's mouth it took the sky's blue-grey: his 5.17l
  // screenshot from inside the railway tunnel by Giubiasco, a pale wedge across the way out).
  if (under) { return present(colour, in.clip.xy); }
  return present(applyAtmosphere(colour, in.world, in.clip.xy), in.clip.xy);
}
