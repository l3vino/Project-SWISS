// label.wgsl — the name of a search flight's destination, over the place (js/engine/passes/label.js).
// Joined after common.wgsl, atmosphere.wgsl and frame.wgsl.
//
// The label's atlas is drawn as quads put where the place lands on the
// screen, their corners on whole pixels so the text stays as sharp as it was
// drawn. Texels are read exactly, one per pixel: no filtering, no blur. The
// atlas is premultiplied; so is the output.
//
// Instances 0 to 4 are drawn over everything (their pipeline does not test
// depth): on the place, the name (0) and the distance under it (1); off the
// screen or behind the eye (Stage 5.7, his words: "make sure that the label
// is noticeble also when not in sight (so basically like a side screen
// label/arrow)"; 5.8b: "more modern and minimalist"), a round glass chip at
// the edge with a white chevron pointing the way the place lies (4), and the
// name (2) and the distance (3) beside it on the inside. Instance 5 is the
// ring, its glow and the line rising from it, at the place's own depth, so
// terrain and buildings in front of the place hide them (its pipeline tests
// 'greater': reverse-Z). That depth is taken a little nearer the eye than
// the place (STEM_NEARER of its distance, STEM_LEAST metres at least), or
// the ground just in front of the place, seen at a grazing angle, would cut
// the ring in half.
//
// The distance is written with the atlas's strip of characters: label.js
// says which cells, in order, and where each starts along the line (each
// cell has room round it for its shadow, which may reach into its
// neighbours', so every cell a pixel falls in is laid over the last).
//
// The way the place lies is its direction across the view, from the clip
// position before dividing by w, so it holds behind the eye too: there the
// chevron points the way to turn. As the place nears the edge, one fades
// into the other over `fade` pixels either side of the chip's line, so
// nothing jumps.

struct Label {
  anchorRel  : vec3f,   // the place minus the camera, metres
  alpha      : f32,
  scale      : f32,     // render pixels per CSS pixel
  count      : f32,     // characters in the distance
  digitsW    : f32,     // its row, pixels, the cells' room included
  glyphY     : f32,     // the characters' row in the atlas: its top ...
  glyphH     : f32,     // ... and height
  nameW      : f32,     // the name on the place, in the atlas
  nameH      : f32,
  asideW     : f32,     // the name beside the chip
  asideH     : f32,
  nameY      : f32,     // rows' tops in the atlas
  asideY     : f32,
  stemY      : f32,
  stemSize   : vec2f,   // the ring and its line, in the atlas
  stemAnchor : vec2f,   // the ring's middle in it
  nameX      : f32,
  nameTop    : f32,     // from the place on the screen: the name's top ...
  digitsTop  : f32,     // ... and the distance's
  chipR      : f32,     // off the screen: the chip's radius,
  inset      : f32,     // its middle in from the edge,
  chipGap    : f32,     // the gap to the text,
  fade       : f32,     // the fade between on and off the screen,
  lines      : f32,     // from the name's row to the distance's beside it
  chevron    : f32,     // the chevron's arm
  stroke     : f32,     // and its stroke
  pad        : f32,     // round every piece in the atlas
  _pad       : f32,
  glyphs     : array<vec4f, 8>,   // the distance's characters: atlas x, cell width, start along the row
};

@group(1) @binding(0) var<uniform> label : Label;
@group(1) @binding(1) var image : texture_2d<f32>;

const STEM_NEARER = 0.03;
const STEM_LEAST = 10.0;
const CHIP_FILL = vec4f(0.055, 0.071, 0.102, 0.45);   // dark glass (sRGB, as label.js draws)
const CHIP_RIM = 0.25;                               // its white rim's opacity
const CHIP_SHADE = 0.3;                              // the soft shadow round it
const CHIP_SHADE_WIDTH = 8.0;                        // CSS pixels
const OFF_SCREEN = vec4f(2.0, 2.0, 0.0, 1.0);

struct LabelOut {
  @builtin(position) clip : vec4f,
  @location(0) uv : vec2f,                          // atlas pixels, the distance's row, or round the chip
  @location(1) @interpolate(flat) fade : f32,
  @location(2) @interpolate(flat) kind : u32,       // 0: atlas, 1: the distance, 2: the chip
  @location(3) @interpolate(flat) way : vec2f,      // the chip's: where the place lies
};

// The way the place lies across the view, pixels (y down), unit length.
fn sideways(c : vec4f) -> vec2f {
  let d = vec2f(c.x * frame.width, -c.y * frame.height);
  let n = length(d);
  return select(vec2f(0.0, 1.0), d / n, n > 1e-6);
}

// Where the chip's middle goes: from the middle of the screen along `d` to
// `inset` pixels in from its edge.
fn edgePoint(d : vec2f, half : vec2f, inset : f32) -> vec2f {
  let room = max(half - vec2f(inset), vec2f(1.0));
  let t = min(room.x / max(abs(d.x), 1e-6), room.y / max(abs(d.y), 1e-6));
  return half + d * t;
}

@vertex
fn vsLabel(@builtin(vertex_index) vi : u32, @builtin(instance_index) part : u32) -> LabelOut {
  var out : LabelOut;
  out.kind = 0u;
  out.way = vec2f(1.0, 0.0);
  out.clip = OFF_SCREEN;
  if (label.alpha <= 0.0) { return out; }
  let c = frame.viewProj * vec4f(label.anchorRel, 1.0);
  let screen = vec2f(frame.width, frame.height);
  let half = 0.5 * screen;
  let d = sideways(c);
  // How far off the screen the place is: 0 well inside the chip's line, 1
  // well past it or behind the eye.
  var aside = 1.0;
  var p = vec2f(0.0);
  if (c.w > frame.near) {
    p = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * screen;
    let past = max(abs(p.x - half.x) - (half.x - label.inset), abs(p.y - half.y) - (half.y - label.inset));
    aside = smoothstep(-label.fade, label.fade, past);
  }
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
                                vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0));
  let k = corners[vi];
  var px : vec2f;
  var depth = 0.0;
  if (part >= 2u && part <= 4u) {
    // Off the screen: the chip, and the name over the distance beside it,
    // on the inside, kept on the screen.
    if (aside <= 0.0) { return out; }
    out.fade = label.alpha * aside;
    let chip = edgePoint(d, half, label.inset);
    if (part == 4u) {
      let box = 2.0 * (label.chipR + CHIP_SHADE_WIDTH * label.scale + 1.0);
      out.uv = (k - 0.5) * box;
      out.kind = 2u;
      out.way = d;
      px = chip + out.uv;
    } else {
      let pad = label.pad;
      let imageW = max(label.asideW, label.digitsW);
      let imageH = label.asideH + label.lines + label.glyphH;
      let seen = vec2f(imageW, imageH) - vec2f(2.0 * pad);
      let reach = abs(d.x) * 0.5 * seen.x + abs(d.y) * 0.5 * seen.y;
      let margin = vec2f(2.0 * label.scale);
      let centre = clamp(chip - d * (label.chipR + label.chipGap + reach), 0.5 * seen + margin, screen - 0.5 * seen - margin);
      if (part == 2u) {
        let size = vec2f(label.asideW, label.asideH);
        let corner = floor(centre - vec2f(0.5 * size.x, 0.5 * imageH) + 0.5);
        out.uv = k * size + vec2f(0.0, label.asideY);
        px = corner + k * size;
      } else {
        let size = vec2f(label.digitsW, label.glyphH);
        let corner = floor(centre + vec2f(-0.5 * size.x, -0.5 * imageH + label.asideH + label.lines) + 0.5);
        out.uv = k * size;
        out.kind = 1u;
        px = corner + k * size;
      }
    }
  } else {
    // On the place: the name and the distance (0, 1) over everything, the
    // ring and its line (5) at the place's depth, a little nearer.
    if (c.w <= frame.near || aside >= 1.0) { return out; }
    out.fade = label.alpha * (1.0 - aside);
    if (part == 0u) {
      let size = vec2f(label.nameW, label.nameH);
      let corner = floor(p + vec2f(label.nameX - 0.5 * size.x, label.nameTop) + 0.5);
      out.uv = k * size + vec2f(0.0, label.nameY);
      px = corner + k * size;
    } else if (part == 1u) {
      let size = vec2f(label.digitsW, label.glyphH);
      let corner = floor(p + vec2f(-0.5 * size.x, label.digitsTop) + 0.5);
      out.uv = k * size;
      out.kind = 1u;
      px = corner + k * size;
    } else {
      let corner = floor(p - label.stemAnchor + 0.5);
      out.uv = k * label.stemSize + vec2f(0.0, label.stemY);
      px = corner + k * label.stemSize;
      let w = max(frame.near, c.w - max(STEM_NEARER * c.w, STEM_LEAST));
      depth = min(1.0, frame.near / w);
    }
  }
  out.clip = vec4f(px.x / screen.x * 2.0 - 1.0, 1.0 - px.y / screen.y * 2.0, depth, 1.0);
  return out;
}

// Distance from a point to a segment.
fn segment(p : vec2f, a : vec2f, b : vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - ab * t);
}

// The chip, from its outline: dark glass inside a faint white rim, a soft
// shadow round it, and a white chevron pointing along `d`, smoothed over a
// pixel. Premultiplied.
fn chipColour(p : vec2f, d : vec2f) -> vec4f {
  let s = label.scale;
  let r = label.chipR;
  let dist = length(p) - r;
  let body = 1.0 - smoothstep(-0.5, 0.5, dist);
  var c = vec4f(0.0, 0.0, 0.0, CHIP_SHADE * (1.0 - smoothstep(0.0, CHIP_SHADE_WIDTH * s, dist)) * (1.0 - body));
  let glass = vec4f(CHIP_FILL.rgb * CHIP_FILL.a, CHIP_FILL.a) * body;
  c = glass + c * (1.0 - glass.a);
  let rim = CHIP_RIM * (1.0 - smoothstep(0.0, s, abs(dist + 0.5 * s)));
  c = vec4f(rim) + c * (1.0 - rim);
  let q = vec2f(dot(p, d), dot(p, vec2f(-d.y, d.x)));
  let tip = vec2f(0.25 * r, 0.0);
  let a1 = tip - label.chevron * vec2f(0.697, 0.717);
  let a2 = tip - label.chevron * vec2f(0.697, -0.717);
  let sd = min(segment(q, a1, tip), segment(q, a2, tip));
  let chevron = 1.0 - smoothstep(0.5 * label.stroke - 0.5, 0.5 * label.stroke + 0.5, sd);
  return vec4f(chevron) + c * (1.0 - chevron);
}

@fragment
fn fsLabel(in : LabelOut) -> @location(0) vec4f {
  if (in.kind == 2u) {
    return chipColour(in.uv, in.way) * in.fade;
  }
  let size = vec2i(textureDimensions(image));
  if (in.kind == 1u) {
    // The distance: every character cell this pixel falls in, in order.
    var acc = vec4f(0.0);
    let n = u32(label.count);
    let y = i32(label.glyphY + floor(in.uv.y));
    for (var i = 0u; i < 8u; i++) {
      if (i >= n) { break; }
      let g = label.glyphs[i];
      let x = in.uv.x - g.z;
      if (x < 0.0 || x >= g.y) { continue; }
      let texel = clamp(vec2i(i32(g.x + floor(x)), y), vec2i(0), size - vec2i(1));
      let t = textureLoad(image, texel, 0);
      acc = t + acc * (1.0 - t.a);
    }
    return acc * in.fade;
  }
  let texel = clamp(vec2i(floor(in.uv)), vec2i(0), size - vec2i(1));
  return textureLoad(image, texel, 0) * in.fade;
}
