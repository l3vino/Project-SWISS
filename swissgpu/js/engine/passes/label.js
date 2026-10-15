/* label.js (pass) — the name of a search flight's destination, over the place.
 *
 * Stage 5.5 (his words: "show the text of the destination above it, so that
 * when you fly you can see it clearly above the destination"); Stage 5.6:
 * "place label should have just the text (visible with maybe a slight
 * outline white or black, just to make it readable/visible). line and point
 * of the label should be a bit more transparent and not visible through
 * things"; Stage 5.7: "The destination name's white line should be blue,
 * fading from 100% from ground to 0%. Also make sure that the label is
 * noticeble also when not in sight (so basically like a side screen
 * label/arrow)". So: the name in white with a thin dark outline (it reads on
 * snow and on forest alike), on a short stem down to a dot on the place, the
 * same size on the screen however far away. The stem is the flight path's
 * blue, whole on the place and fading out towards the name. The name is
 * drawn over everything, so mountains in between do not hide it; the stem
 * and the dot are hidden by whatever stands in front of the place: the
 * image's name rows are drawn with no depth test and its stem rows tested
 * at the place's own depth. Off the screen or behind the eye, an arrow at
 * the edge of the screen points the way the place lies, with the name beside
 * it (LABEL.aside; shaders/label.wgsl). It is drawn once per flight with the
 * 2D canvas (an OffscreenCanvas, here in the render thread), in the
 * interface's font, and written to a texture; each frame only where the
 * place is from the camera and the opacity are written (64 bytes). Its
 * corner on a whole pixel.
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
  font: (px) => `600 ${px}px "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`,
  text: 16,              // the name's size
  widest: 380,           // longer names end in an ellipsis
  outline: 3.5,          // the outline's stroke (half of it shows outside the letters)
  gap: 4,                // between the name and the stem
  stem: 30,              // from the name down to the place
  dot: 4,                // the dot on the place, radius
  margin: 3,
  ink: '#ffffff',
  outlineInk: 'rgba(6, 10, 14, 0.82)',
  accent: [61, 139, 255],          // the flight path's blue (sRGB; shaders/label.wgsl, ARROW_COLOUR)
  shade: [5, 8, 11, 0.55],         // under the stem
  // Off the screen: the arrow's tip this far in from the edge, its length,
  // the gap between it and the name, and how far either side of the tip's
  // line the place fades from one to the other.
  aside: { inset: 30, arrow: 20, gap: 6, fade: 14 },
};
const UNIFORM_BYTES = 64;

export class LabelPass {
  static async create(device, { format, timer, frame }) {
    const module = await loadShader(device, 'label', ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'label.wgsl']);
    const layout = device.createBindGroupLayout({
      label: 'label',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] });
    // The name over everything; the stem and the dot behind what stands in
    // front of the place (reverse-Z: in front is 'greater').
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
    this.uniform = device.createBuffer({ label: 'label', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.block = new Float32Array(UNIFORM_BYTES / 4);
    this.anchor = new Float64Array(3);   // the place, earth-centred, set by render.js
    this.alpha = 0;
    this.text = '';
    this.scale = 0;
    this.texture = null;
    this.bindGroup = null;
    this.size = [0, 0];
    this.at = [0, 0];
    this.split = 0;                      // the image's first row of the stem
    this.drawn = false;                  // for the probe
    // Drawn on the CPU, so reading it back is a copy; the font is loaded now,
    // while the app loads, not on the first flight (in the rig the first text
    // a worker draws took 0.7 s).
    this.canvas = new OffscreenCanvas(1, 1);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    const t0 = performance.now();
    drawLabel(this.canvas, this.ctx, 'Zürich, Genève', 1);
    this.warmUp = performance.now() - t0;
  }

  /** The name to show, at `scale` render pixels per CSS pixel; drawn again only when either changes. */
  setText(text, scale) {
    if (text === this.text && scale === this.scale) return;
    this.text = text;
    this.scale = scale;
    this.texture?.destroy();
    this.texture = null;
    if (!text) return;
    const t0 = performance.now();
    const image = drawLabel(this.canvas, this.ctx, text, scale);
    const t1 = performance.now();
    this.size[0] = image.width;
    this.size[1] = image.height;
    this.at[0] = image.anchorX;
    this.at[1] = image.anchorY;
    this.split = image.split;
    this.texture = this.device.createTexture({
      label: 'label', size: [image.width, image.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // The canvas gives straight alpha; the shader blends premultiplied.
    const pixels = this.ctx.getImageData(0, 0, image.width, image.height).data;
    for (let i = 0; i < pixels.length; i += 4) {
      const a = pixels[i + 3];
      if (a === 255) continue;
      pixels[i] = (pixels[i] * a + 127) / 255;
      pixels[i + 1] = (pixels[i + 1] * a + 127) / 255;
      pixels[i + 2] = (pixels[i + 2] * a + 127) / 255;
    }
    const t2 = performance.now();
    this.device.queue.writeTexture({ texture: this.texture }, pixels, { bytesPerRow: 4 * image.width }, [image.width, image.height]);
    const t3 = performance.now();
    this.timings = { draw: t1 - t0, read: t2 - t1, upload: t3 - t2 };
    this.bindGroup = this.device.createBindGroup({
      label: 'label', layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.texture.createView() }],
    });
  }

  update({ camera }) {
    this.drawn = Boolean(this.texture) && this.alpha > 0.003 && !!camera;
    if (!this.drawn) return;
    const b = this.block, p = camera.position;
    b[0] = this.anchor[0] - p[0];
    b[1] = this.anchor[1] - p[1];
    b[2] = this.anchor[2] - p[2];
    b[3] = this.alpha;
    b[4] = this.size[0];
    b[5] = this.size[1];
    b[6] = this.at[0];
    b[7] = this.at[1];
    b[8] = this.split;
    b[9] = this.scale;
    const a = LABEL.aside, s = this.scale;
    b[12] = a.inset * s;
    b[13] = a.arrow * s;
    b[14] = a.gap * s;
    b[15] = a.fade * s;
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
    // Instances 0 to 2, over everything: the name on the place, and off the
    // screen the name beside the arrow and the arrow; 3, at the place's
    // depth: the stem and the dot (shaders/label.wgsl).
    pass.setPipeline(p.text);
    pass.draw(6, 3, 0, 0);
    pass.setPipeline(p.stem);
    pass.draw(6, 1, 0, 3);
    pass.end();
  }
}

/*
 * The label's image, onto `canvas` (resized to fit): the name, white with a
 * thin dark outline, and under it the stem and the dot on the place, in
 * device pixels. Returns its size, where on it the place is, and the first
 * row of the stem (the rows above are the name's).
 */
function drawLabel(canvas, ctx, text, scale) {
  const L = LABEL, s = scale;
  ctx.font = L.font(L.text * s);
  // Too long: cut at a character and end in an ellipsis.
  let shown = text.trim();
  const room = L.widest * s;
  if (ctx.measureText(shown).width > room) {
    while (shown.length > 1 && ctx.measureText(`${shown}…`).width > room) shown = shown.slice(0, -1);
    shown = `${shown.trimEnd()}…`;
  }
  const metrics = ctx.measureText(shown);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || 0.75 * L.text * s);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || 0.2 * L.text * s);
  const outline = L.outline * s, rim = Math.ceil(outline / 2) + 1;
  const margin = Math.ceil(L.margin * s), dot = L.dot * s;
  const textW = Math.ceil(metrics.width) + 2 * rim, textH = ascent + descent + 2 * rim;
  const gap = Math.round(L.gap * s), stem = Math.round(L.stem * s);
  const width = Math.max(textW, Math.ceil(2 * dot) + 4) + 2 * margin;
  const height = margin + textH + gap + stem + Math.ceil(2 * dot) + margin;
  // Resizing clears the canvas and resets its state.
  canvas.width = width;
  canvas.height = height;
  const cx = width / 2, top = margin + textH + gap, anchorY = top + stem + Math.ceil(dot);
  // The stem, blue over a faint dark edge, both whole on the place and
  // fading out towards the name; the dot on the place.
  const fading = ([r, g, b, a = 1]) => {
    const ramp = ctx.createLinearGradient(0, top, 0, anchorY);
    ramp.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0)`);
    ramp.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${a})`);
    return ramp;
  };
  ctx.lineCap = 'round';
  ctx.strokeStyle = fading(L.shade);
  ctx.lineWidth = 4 * s;
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.lineTo(cx, anchorY);
  ctx.stroke();
  ctx.strokeStyle = fading(L.accent);
  ctx.lineWidth = 2 * s;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, anchorY, dot, 0, 2 * Math.PI);
  ctx.fillStyle = `rgb(${L.accent.join(', ')})`;
  ctx.fill();
  ctx.lineWidth = 1.5 * s;
  ctx.strokeStyle = L.ink;
  ctx.stroke();
  // The name: its outline first, round at the corners, then the letters.
  ctx.font = L.font(L.text * s);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const baseline = margin + rim + ascent;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = outline;
  ctx.strokeStyle = L.outlineInk;
  ctx.strokeText(shown, cx, baseline);
  ctx.fillStyle = L.ink;
  ctx.fillText(shown, cx, baseline);
  return { width, height, anchorX: cx, anchorY, split: margin + textH + Math.floor(gap / 2) };
}
