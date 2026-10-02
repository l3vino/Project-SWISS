/* cables.js (pass) — cable cars: their ropes and pylons.
 *
 * The building tilesets decode them (js/formats/lines.js, from the tubes the
 * data models them as) into rope pieces and the pylons' steel members, the
 * same records, in each tile's local frame, kept in one storage buffer per
 * tile. Per tile, a 64-byte block at its own dynamic offset says where that
 * frame sits relative to the camera, as the buildings pass does; the
 * geometry is made in the vertex shader from the records
 * (shaders/cables.wgsl), so a tile costs one draw, blended over everything
 * drawn so far and tested against it, without writing depth: thin steel
 * covers part of a pixel, and an anti-aliased line says how much.
 *
 * Most frames show no cable car at all: then no render pass is begun.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';

const MAX_TILES = 256;
const BLOCK_STRIDE = 256;          // minimum dynamic-offset alignment
const BLOCK_FLOATS = BLOCK_STRIDE / 4;
const BLOCK_BYTES = 64;            // what the shader reads of each slot
const ROPE_VERTICES = 6;           // one ribbon

export class CablesPass {
  static async create(device, { format, timer, tilesets, frame }) {
    const module = await loadShader(device, 'cables', ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'cables.wgsl']);
    const blockLayout = device.createBindGroupLayout({
      label: 'cable-block',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BLOCK_BYTES } }],
    });
    const dataLayout = device.createBindGroupLayout({
      label: 'cable-data',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, blockLayout, dataLayout] });
    const ropes = await device.createRenderPipelineAsync({
      label: 'cable-ropes', layout,
      vertex: { module, entryPoint: 'vsRope' },
      fragment: {
        module, entryPoint: 'fsRope',
        // Premultiplied: the shader has already scaled the colour by coverage.
        targets: [{ format, blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' },
    });
    return new CablesPass(device, { ropes, blockLayout, dataLayout, timer, tilesets, frame });
  }

  constructor(device, { ropes, blockLayout, dataLayout, timer, tilesets, frame }) {
    this.device = device;
    this.pipeline = ropes;
    this.dataLayout = dataLayout;
    this.timer = timer;
    this.tilesets = tilesets;
    this.frame = frame;
    this.data = new Float32Array(MAX_TILES * BLOCK_FLOATS);
    this.buffer = device.createBuffer({
      label: 'cable-blocks', size: MAX_TILES * BLOCK_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.blocks = device.createBindGroup({
      label: 'cable-blocks', layout: blockLayout,
      entries: [{ binding: 0, resource: { buffer: this.buffer, size: BLOCK_BYTES } }],
    });
    this.draws = [];
    this.ropes = 0;               // drawn this frame, for the probe
    this.pylons = 0;
  }

  /* Each tile's buffer gets its bind group the first time it is drawn. */
  #bindGroup(cables) {
    return cables.bind ??= this.device.createBindGroup({
      label: 'cable-data', layout: this.dataLayout,
      entries: [{ binding: 0, resource: { buffer: cables.buffer, offset: 0, size: cables.bytes } }],
    });
  }

  update({ camera }) {
    this.draws.length = 0;
    this.ropes = this.pylons = 0;
    if (!camera) return;
    for (const tileset of this.tilesets) {
      if (!tileset.enabled) continue;
      for (const node of tileset.visible) {
        if (node.gpu.cables && this.draws.length < MAX_TILES) this.draws.push(node);
      }
    }
    const p = camera.position, d = this.data;
    for (let i = 0; i < this.draws.length; i++) {
      const g = this.draws[i].gpu, o = i * BLOCK_FLOATS;
      d[o + 0] = g.origin[0] - p[0];
      d[o + 1] = g.origin[1] - p[1];
      d[o + 2] = g.origin[2] - p[2];
      d.set(g.east, o + 4);
      d.set(g.north, o + 8);
      d.set(g.up, o + 12);
      this.ropes += g.cables.ropes;
      this.pylons += g.cables.pylons;
    }
    if (this.draws.length) this.device.queue.writeBuffer(this.buffer, 0, d, 0, this.draws.length * BLOCK_FLOATS);
  }

  record(encoder, colorView, depthView) {
    if (!this.draws.length) return;
    const d = this.desc ??= {
      label: 'cables',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('cables');
    const pass = encoder.beginRenderPass(d);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setPipeline(this.pipeline);
    for (let i = 0; i < this.draws.length; i++) {
      const c = this.draws[i].gpu.cables;
      pass.setBindGroup(1, this.blocks, [i * BLOCK_STRIDE]);
      pass.setBindGroup(2, this.#bindGroup(c));
      pass.draw(ROPE_VERTICES, c.ropes + c.members);
    }
    pass.end();
  }
}
