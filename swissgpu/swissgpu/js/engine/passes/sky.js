/* sky.js — the first pass that draws, and the template every later pass follows.
 *
 * A pass owns its pipeline, exposes `record(encoder, colorView, depthView)`,
 * and knows nothing about the frame loop. Shader source is fetched from .wgsl
 * files so shaders stay editable without touching JavaScript. The sky reads
 * everything it needs from the frame's bind group: the camera's rays, the
 * atmosphere's sky view and the exposure.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';

export class SkyPass {
  static async create(device, { format, timer, frame }) {
    const module = await loadShader(device, 'sky', ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'sky.wgsl']);

    const pipeline = await device.createRenderPipelineAsync({
      label: 'sky',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      // The pass attaches depth so terrain inherits a cleared buffer, and a
      // pipeline's attachment state has to match its pass exactly. Sky is
      // background: it neither tests nor writes depth.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
    });

    return new SkyPass(pipeline, timer, frame);
  }

  constructor(pipeline, timer, frame) {
    this.pipeline = pipeline;
    this.timer = timer;
    this.frame = frame;
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
      // Cleared here so the passes after draw into a prepared depth buffer.
      depthStencilAttachment: depthView ? {
        view: depthView,
        depthClearValue: 0.0,   // reverse-Z
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      } : undefined,
      timestampWrites: this.timer?.writes('sky'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.draw(3);
    pass.end();
  }
}
