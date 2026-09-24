/* sky.js — the first pass, and the template every later pass follows.
 *
 * A pass owns its pipeline and its bind group, exposes `record(encoder, view)`,
 * and knows nothing about the frame loop. Shader source is fetched from a .wgsl
 * file so shaders stay editable without touching JavaScript.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';

export class SkyPass {
  static async create(device, { format, timer }) {
    const module = await loadShader(device, 'sky', ['common.wgsl', 'sky.wgsl']);

    const pipeline = await device.createRenderPipelineAsync({
      label: 'sky',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      // The pass attaches depth so terrain inherits a cleared buffer, and a
      // pipeline's attachment state has to match its pass exactly. Sky is
      // background: it neither tests nor writes depth.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
    });

    return new SkyPass(device, pipeline, timer);
  }

  constructor(device, pipeline, timer) {
    this.device = device;
    this.pipeline = pipeline;
    this.timer = timer;

    // 16 bytes: vec2 resolution, time, sun elevation. Uniform buffers must be
    // a multiple of 16 anyway, so this is one aligned write per frame.
    this.uniforms = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'sky-frame',
    });
    this.scratch = new Float32Array(4);
    this.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    });
  }

  update({ width, height, time, sunElev = 0.4 }) {
    this.scratch[0] = width;
    this.scratch[1] = height;
    this.scratch[2] = time;
    this.scratch[3] = sunElev;
    this.device.queue.writeBuffer(this.uniforms, 0, this.scratch);
  }

  record(encoder, colorView, depthView) {
    const pass = encoder.beginRenderPass({
      label: 'sky',
      colorAttachments: [{
        view: colorView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      // Cleared here so terrain in step 1 draws into a prepared depth buffer.
      depthStencilAttachment: depthView ? {
        view: depthView,
        depthClearValue: 0.0,   // reverse-Z
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      } : undefined,
      timestampWrites: this.timer?.writes('sky'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
