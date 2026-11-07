/* label.js (pass) — the name of a search flight's destination, over the place.
 *
 * Stage 5.5 (his words: "show the text of the destination above it, so that
 * when you fly you can see it clearly above the destination"); 5.6: "just
 * the text (visible with maybe a slight outline white or black, just to make
 * it readable/visible). line and point of the label should be a bit more
 * transparent and not visible through things"; 5.7: "The destination name's
 * white line should be blue, fading from 100% from ground to 0%. Also make
 * sure that the label is noticeble also when not in sight (so basically like
 * a side screen label/arrow)"; 5.8b: "remake the label marker and arrow to be
 * more modern and minimalist looking" (his pick of two mockups: A).
 *
 * So, on the place: a small blue dot in a thin white ring with a soft blue
 * glow round it, a hairline of the flight path's blue rising from it and
 * fading out, and above it the name, white, with the distance to the place
 * under it, smaller and a little dimmer; both read on snow and on forest
 * alike through a soft shadow (no hard outline). The same size on the screen
 * however far away. The text is drawn over everything, so mountains in
 * between do not hide it; the line, the ring and the glow are hidden by
 * whatever stands in front of the place (their rows tested at the place's
 * own depth). Off the screen or behind the eye: a small round glass chip at
 * the edge of the screen with a white chevron in it pointing the way the
 * place lies, and the name and the distance beside it, on the inside
 * (shaders/label.wgsl).
 *
 * Everything is drawn once per flight with the 2D canvas (an OffscreenCanvas,
 * here in the render thread) into one texture, an atlas: the name at two
 * sizes, the ring and its line, and the strip of characters the distance is
 * written with ("0123456789.km " in the distance's size and weight, each in
 * its own cell). Each frame only the place's position from the camera, the
 * opacity and the distance's characters (which cells, where) are written:
 * 256 bytes, nothing drawn on the CPU. Quads' corners land on whole pixels.
 *
 * The canvas is drawn on the CPU (willReadFrequently) and its pixels written
 * with writeTexture: copyExternalImageToTexture from a canvas the GPU draws
 * waits for the GPU to finish what it is doing, and in the rig that held the
 * render thread for 1.7 s at the start of the first flight. The canvas and
 * its font are made once, while the app loads.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';

/* Sizes in CSS pixels. */
export const LABEL = {
  font: (weight, px) => `${weight} ${px}px "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`,
  name: { px: 16, weight: 600, ink: '#ffffff' },        // on the place
  aside: { px: 14, weight: 600, ink: '#ffffff' },       // beside the chip
  digits: { px: 12, weight: 500, ink: 'rgba(255, 255, 255, 0.82)' },
  widest: 380,             // longer names end in an ellipsis
  // Under the glyphs, for reading on anything: a wide soft shadow and a tight one.
  shadows: [{ blur: 6, y: 1, alpha: 0.6 }, { blur: 1.5, y: 0, alpha: 0.4 }],
  pad: 8,                  // round every piece in the atlas, for its shadow
  gap: 1,                  // between the name and the distance
  lift: 5,                 // between the distance and the top of the line
  stem: 40,                // the line, from the ring up
  core: 3.6,               // the dot's radius
  ring: 6.2,               // the white ring's radius ...
  ringWidth: 1.5,          // ... and its width
  glow: 15,                // the glow's radius
  glowAlpha: 0.3,
  accent: [61, 139, 255],  // the flight path's blue (sRGB; shaders/label.wgsl, CHIP)
  // Off the screen: the chip's middle this far in from the edge, its radius,
  // the gap between it and the text, the fade between the two (either side
  // of the chip's line), the gap between the name and the distance there,
  // and the chevron's arm and stroke.
  chip: { inset: 30, radius: 16, gap: 10, fade: 14, lines: 1, chevron: 7, stroke: 2.2 },
};
/* The characters the distance is written with, in the atlas's order. */
const GLYPHS = '0123456789.km ';
const MAX_GLYPHS = 8;
const UNIFORM_FLOATS = 64;

/** The distance as shown: metres to 100 m (to ten under 1 km), then km to a tenth under 10 km, then whole km. */
export function formatDistance(metres) {
  const d = Math.max(0, metres);
  if (d < 100) return `${Math.round(d)} m`;
  if (d < 995) return `${Math.round(d / 10) * 10} m`;
  if (d < 9950) return `${(d / 1000).toFixed(1)} km`;
  return `${Math.round(d / 1000)} km`;
}

export class LabelPass {
  static async create(device, { format, timer, frame }) {
    const module = await loadShader(device, 'label', ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'label.wgsl']);
    const layout = device.createBindGroupLayout({
      label: 'label',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: UNIFORM_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] });
    // The text and the chip over everything; the line, the ring and the
    // glow behind what stands in front of the place (reverse-Z: 'greater').
    const make = (label, depthCompare) => device.createRenderPipelineAsync({
      label, layout: pipelineLayout,
      vertex: { module, entryPoint: 'vsLabel' },
      fragment: {
        module, entryPoint: 'fsLabel',
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
    });
    const [text, stem] = await Promise.all([make('label-text', 'always'), make('label-stem', 'greater')]);
    return new LabelPass(device, { pipelines: { text, stem }, layout, timer, frame });
  }

  constructor(device, { pipelines, layout, timer, frame }) {
    this.device = device;
    this.pipelines = pipelines;
    this.layout = layout;
    this.timer = timer;
    this.frame = frame;
    this.uniform = device.createBuffer({ label: 'label', size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.block = new Float32Array(UNIFORM_FLOATS);
    this.anchor = new Float64Array(3);   // the place, earth-centred, set by render.js
    this.alpha = 0;
    this.text = '';
    this.scale = 0;
    this.texture = null;
    this.bindGroup = null;
    this.atlas = null;
    this.shown = '';                      // the distance as last written
    this.drawn = false;                   // for the probe
    // Drawn on the CPU, so reading it back is a copy; the font is loaded now,
    // while the app loads, not on the first flight (in the rig the first text
    // a worker draws took 0.7 s).
    this.canvas = new OffscreenCanvas(1, 1);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const t0 = performance.now();
    drawAtlas(this.canvas, this.ctx, 'Zürich, Genève', 1);
    this.warmUp = performance.now() - t0;
  }

  /** The name to show, at `scale` render pixels per CSS pixel; drawn again only when either changes. */
  setText(text, scale) {
    if (text === this.text && scale === this.scale) return;
    this.text = text;
    this.scale = scale;
    this.texture?.destroy();
    this.texture = null;
    this.shown = '';
    if (!text) return;
    const t0 = performance.now();
    const atlas = drawAtlas(this.canvas, this.ctx, text, scale);
    const t1 = performance.now();
    this.atlas = atlas;
    this.texture = this.device.createTexture({
      label: 'label', size: [atlas.width, atlas.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // The canvas gives straight alpha; the shader blends premultiplied.
    const pixels = this.ctx.getImageData(0, 0, atlas.width, atlas.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      if (a === 255) continue;
      pixels[i] = (pixels[i] * a + 127) / 255;
      pixels[i + 1] = (pixels[i + 1] * a + 127) / 255;
      pixels[i + 2] = (pixels[i + 2] * a + 127) / 255;
    }
    const t2 = performance.now();
    this.device.queue.writeTexture({ texture: this.texture }, pixels, { bytesPerRow: 4 * atlas.width }, [atlas.width, atlas.height]);
    const t3 = performance.now();
    this.timings = { draw: t1 - t0, read: t2 - t1, upload: t3 - t2 };
    this.bindGroup = this.device.createBindGroup({
      label: 'label', layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.texture.createView() }],
    });
    this.#static();
  }

  /* What stays put for a flight: where everything is in the atlas and where
   * it goes round the place (floats 4..31; shaders/label.wgsl, Label). */
  #static() {
    const b = this.block, a = this.atlas, L = LABEL, s = this.scale, c = L.chip;
    b[4] = s;
    b[7] = a.glyphs.y;
    b[8] = a.glyphs.h;
    b[9] = a.name.w; b[10] = a.name.h; b[11] = a.aside.w;
    b[12] = a.aside.h; b[13] = a.name.y; b[14] = a.aside.y; b[15] = a.stem.y;
    b[16] = a.stem.w; b[17] = a.stem.h; b[18] = a.stem.anchorX; b[19] = a.stem.anchorY;
    // From the place on the screen: the name's and the distance's tops.
    const digitsTop = -a.stem.anchorY + a.stem.top - Math.round(L.lift * s) - a.glyphs.h + a.pad;
    b[20] = 0; b[21] = digitsTop - Math.round(L.gap * s) - a.name.h + 2 * a.pad; b[22] = digitsTop;
    b[23] = c.radius * s;
    b[24] = c.inset * s; b[25] = c.gap * s; b[26] = c.fade * s; b[27] = Math.round(c.lines * s) - 2 * a.pad;
    b[28] = c.chevron * s; b[29] = c.stroke * s; b[30] = a.pad; b[31] = 0;
  }

  /* The distance's characters (floats 5, 6 and 32..63): which atlas cell
   * each is, and where its cell starts along the line. */
  #distance(text) {
    const b = this.block, g = this.atlas.glyphs;
    let pen = 0, n = 0;
    for (const ch of text) {
      if (n >= MAX_GLYPHS) break;
      const cell = g.cells[GLYPHS.indexOf(ch)];
      if (!cell) continue;
      const o = 32 + 4 * n;
      b[o] = cell.x; b[o + 1] = cell.w; b[o + 2] = pen; b[o + 3] = 0;
      pen += cell.advance;
      n++;
    }
    b[5] = n;
    b[6] = pen + 2 * this.atlas.pad;
  }

  update({ camera }) {
    this.drawn = Boolean(this.texture) && this.alpha > 0.003 && !!camera;
    if (!this.drawn) return;
    const b = this.block, p = camera.position;
    b[0] = this.anchor[0] - p[0];
    b[1] = this.anchor[1] - p[1];
    b[2] = this.anchor[2] - p[2];
    b[3] = this.alpha;
    const shown = formatDistance(Math.hypot(b[0], b[1], b[2]));
    if (shown !== this.shown) { this.shown = shown; this.#distance(shown); }
    this.device.queue.writeBuffer(this.uniform, 0, b);
  }

  record(encoder, colorView, depthView) {
    if (!this.drawn) return;
    const d = this.desc ??= {
      label: 'label',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('label');
    const pass = encoder.beginRenderPass(d), p = this.pipelines;
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.bindGroup);
    // Instances 0 to 4, over everything: on the place the name and the
    // distance; off the screen the name, the distance and the chip; 5, at
    // the place's depth: the line, the ring and the glow (shaders/label.wgsl).
    pass.setPipeline(p.text);
    pass.draw(6, 5, 0, 0);
    pass.setPipeline(p.stem);
    pass.draw(6, 1, 0, 5);
    pass.end();
  }
}

/* Text with LABEL's soft shadows under it, its left at x, baseline at y. */
function shadowed(ctx, text, x, y, ink, s) {
  for (const sh of LABEL.shadows) {
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${sh.alpha})`;
    ctx.shadowBlur = sh.blur * s;
    ctx.shadowOffsetY = sh.y * s;
    ctx.fillStyle = ink;
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

/*
 * The atlas, onto `canvas` (resized to fit), in device pixels, rows from the
 * top: the name on the place, the name beside the chip, the distance's
 * characters, the ring and its line. Every piece has LABEL.pad round it for
 * its shadow. Returns where each is: { width, height, pad, name, aside
 * ({ y, w, h }), glyphs ({ y, h, cells: [{ x, w, advance }] }), stem ({ y,
 * w, h, anchorX, anchorY (the ring's middle), top (the line's top) }) }.
 */
function drawAtlas(canvas, ctx, text, scale) {
  const L = LABEL, s = scale, pad = Math.ceil(L.pad * s);
  const measure = (font, t) => { ctx.font = font; return ctx.measureText(t); };
  // The name, cut at a character and ended in an ellipsis if too long.
  const nameFont = L.font(L.name.weight, L.name.px * s), asideFont = L.font(L.aside.weight, L.aside.px * s);
  const digitsFont = L.font(L.digits.weight, L.digits.px * s);
  let shown = text.trim();
  const room = L.widest * s;
  if (measure(nameFont, shown).width > room) {
    while (shown.length > 1 && measure(nameFont, `${shown}…`).width > room) shown = shown.slice(0, -1);
    shown = `${shown.trimEnd()}…`;
  }
  const line = (font, t, px) => {
    const m = measure(font, t);
    const ascent = Math.ceil(m.actualBoundingBoxAscent || 0.75 * px), descent = Math.ceil(m.actualBoundingBoxDescent || 0.22 * px);
    return { w: Math.ceil(m.width) + 2 * pad, h: ascent + descent + 2 * pad, ascent };
  };
  const name = line(nameFont, shown, L.name.px * s), aside = line(asideFont, shown, L.aside.px * s);
  // The characters, each in its own cell; one height for all (the digits').
  const dm = measure(digitsFont, '0123456789k');
  const dAscent = Math.ceil(dm.actualBoundingBoxAscent || 0.75 * L.digits.px * s);
  const dDescent = Math.ceil(Math.max(dm.actualBoundingBoxDescent || 0, 0.05 * L.digits.px * s));
  const cells = [];
  let x = 0;
  for (const ch of GLYPHS) {
    const advance = measure(digitsFont, ch).width;
    const w = Math.ceil(advance) + 2 * pad;
    cells.push({ x, w, advance });
    x += w;
  }
  const glyphs = { h: dAscent + dDescent + 2 * pad, cells };
  const glow = Math.ceil(L.glow * s), stemLength = Math.round(L.stem * s);
  const stem = { w: 2 * glow + 2 * pad, h: 2 * pad + stemLength + Math.ceil(L.ring * s) + glow };
  const width = Math.max(name.w, aside.w, x, stem.w);
  name.y = 0;
  aside.y = name.y + name.h;
  glyphs.y = aside.y + aside.h;
  stem.y = glyphs.y + glyphs.h;
  const height = stem.y + stem.h;
  // Resizing clears the canvas and resets its state.
  canvas.width = width;
  canvas.height = height;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = nameFont;
  shadowed(ctx, shown, pad, name.y + pad + name.ascent, L.name.ink, s);
  ctx.font = asideFont;
  shadowed(ctx, shown, pad, aside.y + pad + aside.ascent, L.aside.ink, s);
  ctx.font = digitsFont;
  GLYPHS.split('').forEach((ch, i) => { if (ch !== ' ') shadowed(ctx, ch, cells[i].x + pad, glyphs.y + pad + dAscent, L.digits.ink, s); });
  // The ring, its glow and the line rising from it, fading out.
  const [r, g, b] = L.accent;
  const cx = stem.w / 2, cy = stem.y + pad + stemLength + Math.ceil(L.ring * s), top = stem.y + pad;
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${L.glowAlpha})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, glow, 0, 2 * Math.PI);
  ctx.fill();
  const ramp = ctx.createLinearGradient(0, top, 0, cy - L.ring * s);
  ramp.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
  ramp.addColorStop(1, `rgba(${r}, ${g}, ${b}, 1)`);
  ctx.fillStyle = ramp;
  const hair = 1.5 * s;
  ctx.fillRect(cx - hair / 2, top, hair, cy - L.ring * s - top);
  ctx.beginPath();
  ctx.arc(cx, cy, L.core * s, 0, 2 * Math.PI);
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, L.ring * s, 0, 2 * Math.PI);
  ctx.lineWidth = L.ringWidth * s;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  return {
    width, height, pad, name: { y: name.y, w: name.w, h: name.h }, aside: { y: aside.y, w: aside.w, h: aside.h }, glyphs,
    stem: { y: stem.y, w: stem.w, h: stem.h, anchorX: cx, anchorY: cy - stem.y, top: top - stem.y },
  };
}
