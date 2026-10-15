// label.wgsl — the name of a search flight's destination, over the place (js/engine/passes/label.js).
// Joined after common.wgsl, atmosphere.wgsl and frame.wgsl.
//
// The label's image is drawn as quads, each its own rows of it, put where
// the place lands on the screen, their corner on a whole pixel so the text
// stays as sharp as it was drawn. Texels are read exactly, one per pixel: no
// filtering, no blur. The image is premultiplied; so is the output.
//
// Instance 0 is the name, above `split`: drawn over everything (its
// pipeline does not test depth). Instance 3 is the stem and the dot below
// it, at the place's own depth, so terrain and buildings in front of the
// place hide them (its pipeline tests 'greater': reverse-Z). That depth is
// taken a little nearer the eye than the place (STEM_NEARER of its distance,
// STEM_LEAST metres at least), or the ground just in front of the place, seen
// at a grazing angle, would cut the dot in half.
//
// Off the screen, or behind the eye (Stage 5.7, his words: "make sure that
// the label is noticeble also when not in sight (so basically like a side
// screen label/arrow)"): an arrow at the edge of the screen, its tip
// `edge.x` in from it, pointing the way the place lies (instance 2, drawn
// here from its outline: the path's blue, a white rim, a soft dark edge),
// and the name again beside it, on the inside (instance 1), both over
// everything. The way the place lies is its direction across the view, so
// behind the eye the arrow points the way to turn. As the place nears the
// edge, one fades into the other over `edge.w` pixels either side of the
// arrow's line, so nothing jumps.

struct Label {
  anchorRel : vec3f,   // the place minus the camera, metres
  alpha     : f32,
  size      : vec2f,   // the image, pixels
  anchor    : vec2f,   // the place in the image, pixels from its top left
  split     : f32,     // the image's first row of the stem
  scale     : f32,     // render pixels per CSS pixel
  _pad      : vec2f,
  edge      : vec4f,   // off the screen, pixels: the arrow's tip in from the edge, its length, the gap to the name, the fade
};

@group(1) @binding(0) var<uniform> label : Label;
@group(1) @binding(1) var image : texture_2d<f32>;

const STEM_NEARER = 0.03;
const STEM_LEAST = 10.0;
const ARROW_COLOUR = vec3f(0.239, 0.545, 1.0);   // the path's blue, as label.js draws the stem (sRGB)
const ARROW_WIDTH = 0.62;                        // the arrow's half width, in its length
const ARROW_ROUND = 1.5;                         // CSS pixels: its corners rounded
const ARROW_RIM = 1.5;                           // CSS pixels: its white rim
const ARROW_SHADE = 2.5;                         // CSS pixels: the dark edge round it
const OFF_SCREEN = vec4f(2.0, 2.0, 0.0, 1.0);

struct LabelOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,                          // pixels from the image's top left, or across the arrow
  @location(1) @interpolate(flat) fade : f32,
  @location(2) @interpolate(flat) arrow : u32,      // 1: the arrow, drawn from its outline
};

// The way the place lies across the view, pixels (y down), unit length:
// from the clip position, which is the view's direction before dividing by
// w, so it holds behind the eye too.
fn sideways(c : vec4f) -> vec2f {
  let d = vec2f(c.x * frame.width, -c.y * frame.height);
  let n = length(d);
  return select(vec2f(0.0, 1.0), d / n, n > 1e-6);
}

// Where the arrow's tip goes: from the middle of the screen along `d` to
// `inset` pixels in from its edge.
fn edgePoint(d : vec2f, half : vec2f, inset : f32) -> vec2f {
  let room = max(half - vec2f(inset), vec2f(1.0));
  let t = min(room.x / max(abs(d.x), 1e-6), room.y / max(abs(d.y), 1e-6));
  return half + d * t;
}

@vertex
fn vsLabel(@builtin(vertex_index) vi : u32, @builtin(instance_index) part : u32) -> LabelOut {
  var out : LabelOut;
  out.arrow = 0u;
  out.clip = OFF_SCREEN;
  if (label.alpha <= 0.0) { return out; }
  let c = frame.viewProj * vec4f(label.anchorRel, 1.0);
  let screen = vec2f(frame.width, frame.height);
  let half = 0.5 * screen;
  let d = sideways(c);
  let tip = edgePoint(d, half, label.edge.x);
  // How far off the screen the place is: 0 well inside the arrow's line, 1
  // well past it or behind the eye.
  var aside = 1.0;
  var p = vec2f(0.0);
  if (c.w > frame.near) {
    p = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * screen;
    let past = max(abs(p.x - half.x) - (half.x - label.edge.x), abs(p.y - half.y) - (half.y - label.edge.x));
    aside = smoothstep(-label.edge.w, label.edge.w, past);
  }
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let k = corners[vi];
  var px : vec2f;
  var depth = 0.0;
  if (part == 2u) {
    // The arrow: a square round it, turned to point along d.
    if (aside <= 0.0) { return out; }
    let span = label.edge.y;
    let box = span * 1.6 + 2.0 * (ARROW_SHADE + 1.0) * label.scale;
    let local = (k - 0.5) * box;
    let centre = tip - d * (0.5 * span);
    px = centre + d * local.x + vec2f(-d.y, d.x) * local.y;
    out.uv = local;
    out.arrow = 1u;
    out.fade = label.alpha * aside;
  } else if (part == 1u) {
    // The name beside the arrow, on the inside of it, kept on the screen.
    if (aside <= 0.0) { return out; }
    let box = vec2f(label.size.x, label.split);
    let reach = abs(d.x) * 0.5 * box.x + abs(d.y) * 0.5 * box.y;
    let margin = vec2f(2.0 * label.scale);
    let centre = clamp(tip - d * (label.edge.y + label.edge.z + reach), 0.5 * box + margin, screen - 0.5 * box - margin);
    let corner = floor(centre - 0.5 * box + 0.5);
    out.uv = k * box;
    px = corner + out.uv;
    out.fade = label.alpha * aside;
  } else {
    // On the place: the name (0) over everything, the stem and the dot (3)
    // at the place's depth, a little nearer.
    if (c.w <= frame.near || aside >= 1.0) { return out; }
    let corner = floor(p - label.anchor + 0.5);
    let stem = part == 3u;
    let top = select(0.0, label.split, stem);
    let bottom = select(label.split, label.size.y, stem);
    out.uv = vec2f(k.x * label.size.x, mix(top, bottom, k.y));
    px = corner + out.uv;
    let w = max(frame.near, c.w - max(STEM_NEARER * c.w, STEM_LEAST));
    depth = select(0.0, min(1.0, frame.near / w), stem);
    out.fade = label.alpha * (1.0 - aside);
  }
  out.clip = vec4f(px.x / screen.x * 2.0 - 1.0, 1.0 - px.y / screen.y * 2.0, depth, 1.0);
  return out;
}

// Signed distance from a triangle (Inigo Quilez): negative inside.
fn triangleDistance(p : vec2f, a : vec2f, b : vec2f, c : vec2f) -> f32 {
  let e0 = b - a; let e1 = c - b; let e2 = a - c;
  let v0 = p - a; let v1 = p - b; let v2 = p - c;
  let q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  let q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  let q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  let s = sign(e0.x * e2.y - e0.y * e2.x);
  let m = min(min(vec2f(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                  vec2f(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                  vec2f(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(m.x) * sign(m.y);
}

// The arrow, from its outline: pointing along +x, its tip half its length
// ahead of the middle, its corners rounded; the blue inside a white rim
// inside a soft dark edge, smoothed over a pixel.
fn arrowColour(p : vec2f) -> vec4f {
  let s = label.scale;
  let span = label.edge.y;
  let rounding = ARROW_ROUND * s;
  let tip = vec2f(0.5 * span - rounding, 0.0);
  let back = -0.5 * span + rounding;
  let wide = ARROW_WIDTH * span - rounding;
  let d = triangleDistance(p, tip, vec2f(back, wide), vec2f(back, -wide)) - rounding;
  let rim = ARROW_RIM * s;
  let inside = 1.0 - smoothstep(-rim - 0.5, -rim + 0.5, d);
  let body = 1.0 - smoothstep(-0.5, 0.5, d);
  let shade = 0.45 * (1.0 - smoothstep(0.0, ARROW_SHADE * s, d));
  let colour = mix(vec3f(1.0), ARROW_COLOUR, inside) * body;
  let a = body + (1.0 - body) * shade;
  return vec4f(colour, a);
}

@fragment
fn fsLabel(in : LabelOut) -> @location(0) vec4f {
  if (in.arrow == 1u) {
    return arrowColour(in.uv) * in.fade;
  }
  let size = vec2i(label.size);
  let texel = clamp(vec2i(floor(in.uv)), vec2i(0), size - vec2i(1));
  return textureLoad(image, texel, 0) * in.fade;
}
