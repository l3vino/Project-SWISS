/* path.js (pass) — a search flight's path, drawn in the world.
 *
 * A blue glass tube along the way still ahead, with beads on it every
 * PATH.bead heights (shaders/path.wgsl says how it is lit and hazed, and
 * how transparent: Stage 5.6 made it fainter). The camera flies along its
 * middle, looking along it (plan.js). A
 * flight's plan gives its points (engine/flight/plan.js, FlightPlan.line:
 * evenly in σ, so as far apart on the screen high up as low down, with the
 * tube's radius in metres); render.js puts them on the earth and hands them
 * over with show(), once per plan and again when a late change reshapes
 * what is ahead (flight.js). They are kept in one storage buffer as offsets
 * from the first, in float32, and each frame only the first's place relative
 * to the camera, the flight's time and the line's opacity are written (80
 * bytes).
 *
 * Four draws, all instanced quads with no vertex buffers, blended over
 * everything and not writing depth: the tube and its beads where something
 * stands in front of them (faint, dashed), then where nothing does.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';

export const PATH = {
  most: 1024,                    // points at most (plan.js LINE.most)
  colour: [0.06, 0.32, 1.0],     // the glass, linear
  minWidth: 2,                   // CSS pixels: never drawn thinner (fainter instead)
  hidden: 0.3,                   // opacity behind mountains and buildings
  bead: 1.5,                     // heights (σ) from one bead to the next
  ahead: 0.3,                    // seconds before the flight reaches a point that it fades out over
  // Radii from the eye: hidden this close, whole from this far. The line runs
  // along the camera's own path (plan.js LINE, Stage 5.6), 0.0035 heights
  // thick, and the view looks along it: it comes in from the middle of the
  // view, whole some 0.4 heights ahead, a tunnel curving away.
  near: [30, 110],
  far: 60000,                    // metres: faded out towards this distance
};
const UNIFORM_BYTES = 80;
const POINT_FLOATS = 8;

export class PathPass {
  static async create(device, { format, timer, frame }) {
    const module = await loadShader(device, 'path', ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'path.wgsl']);
    const layout = device.createBindGroupLayout({
      label: 'path',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: UNIFORM_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, layout] });
    // Premultiplied: the shaders return colour × opacity.
    const blend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    // Reverse-Z: in front of what is drawn is 'greater', behind it 'less'.
    const make = (label, vs, fs, depthCompare) => device.createRenderPipelineAsync({
      label, layout: pipelineLayout,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare },
    });
    const [tube, bead, tubeHidden, beadHidden] = await Promise.all([
      make('path-tube', 'vsTube', 'fsTube', 'greater'),
      make('path-beads', 'vsBead', 'fsBead', 'greater'),
      make('path-tube-hidden', 'vsTube', 'fsTubeHidden', 'less'),
      make('path-beads-hidden', 'vsBead', 'fsBeadHidden', 'less'),
    ]);
    return new PathPass(device, { pipelines: { tube, bead, tubeHidden, beadHidden }, layout, timer, frame });
  }

  constructor(device, { pipelines, layout, timer, frame }) {
    this.device = device;
    this.pipelines = pipelines;
    this.timer = timer;
    this.frame = frame;
    this.uniform = device.createBuffer({ label: 'path', size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.buffer = device.createBuffer({ label: 'path-points', size: PATH.most * POINT_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bindGroup = device.createBindGroup({
      label: 'path', layout,
      entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.buffer } }],
    });
    this.data = new Float32Array(PATH.most * POINT_FLOATS);
    this.block = new Float32Array(UNIFORM_BYTES / 4);
    this.origin = new Float64Array(3);
    this.count = 0;
    this.beads = 0;
    this.beadEvery = 1;
    this.now = 0;                          // seconds into the plan the line was made from
    this.alpha = 0;                        // the line's opacity, set by render.js
    this.scale = 1;                        // render pixels per CSS pixel
    this.drawn = false;                    // for the probe
  }

  /**
   * A new line: { n, ecef (three doubles a point, earth-centred), t (when
   * the flight passes each), radius (metres), sigma (σ along), step (σ from
   * one point to the next) }.
   */
  show(line) {
    const n = Math.min(line.n, PATH.most), d = this.data, o = this.origin, e = line.ecef;
    if (n > 0) { o[0] = e[0]; o[1] = e[1]; o[2] = e[2]; }
    for (let k = 0; k < n; k++) {
      const i = POINT_FLOATS * k;
      d[i] = e[3 * k] - o[0];
      d[i + 1] = e[3 * k + 1] - o[1];
      d[i + 2] = e[3 * k + 2] - o[2];
      d[i + 3] = line.t[k];
      d[i + 4] = line.radius[k];
      d[i + 5] = line.sigma[k];
    }
    if (n > 0) this.device.queue.writeBuffer(this.buffer, 0, d, 0, POINT_FLOATS * n);
    this.count = n;
    // Beads evenly from one end to the other, the last on the end.
    const ideal = PATH.bead / Math.max(1e-6, line.step);
    this.beads = n > 1 ? Math.max(1, Math.round((n - 1) / ideal)) : 0;
    this.beadEvery = n > 1 ? (n - 1) / this.beads : 1;
  }

  clear() { this.count = 0; this.beads = 0; }

  update({ camera }) {
    this.drawn = this.count > 1 && this.alpha > 0.003 && !!camera;
    if (!this.drawn) return;
    const b = this.block, p = camera.position, c = PATH.colour;
    b[0] = this.origin[0] - p[0];
    b[1] = this.origin[1] - p[1];
    b[2] = this.origin[2] - p[2];
    b[3] = this.now;
    b[4] = c[0]; b[5] = c[1]; b[6] = c[2];
    b[7] = this.alpha;
    b[8] = PATH.ahead;
    b[9] = PATH.minWidth;
    b[10] = PATH.hidden;
    b[11] = this.beadEvery;
    b[12] = this.count;
    b[13] = PATH.far;
    b[14] = this.scale;
    b[15] = PATH.near[0];
    b[16] = PATH.near[1];
    this.device.queue.writeBuffer(this.uniform, 0, b);
  }

  record(encoder, colorView, depthView) {
    if (!this.drawn) return;
    const d = this.desc ??= {
      label: 'path',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('path');
    const pass = encoder.beginRenderPass(d), p = this.pipelines, segments = this.count - 1;
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(1, this.bindGroup);
    if (PATH.hidden > 0) {
      pass.setPipeline(p.tubeHidden);
      pass.draw(6, segments);
      pass.setPipeline(p.beadHidden);
      pass.draw(6, this.beads);
    }
    pass.setPipeline(p.tube);
    pass.draw(6, segments);
    pass.setPipeline(p.bead);
    pass.draw(6, this.beads);
    pass.end();
  }
}
