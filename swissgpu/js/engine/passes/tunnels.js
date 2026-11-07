/* tunnels.js (pass) — the insides of tunnels near the camera.
 *
 * engine/tunnels/tunnels.js keeps a mesh per tube (wasm/src/tunnel.c), in
 * metres from its own earth-centred origin; per mesh a 256-byte slot at its
 * own dynamic offset says where that origin is from the camera, where it is
 * on the imagery grid (for the roads painted on the floor), where its
 * portals and lamps are and what it is made of (shaders/tunnel.wgsl). One
 * indexed draw a mesh, back faces culled: the triangles face inwards, so
 * from outside nothing but the inside shows through the opened terrain
 * (terrain.wgsl fsCut) and the collar round it. Meshes outside the view
 * are not drawn; most frames have none at all, and then no pass is begun.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { EYE } from '../tunnels/tunnels.js';

const MAX_TUBES = 128;
const SLOT_STRIDE = 256;
const SLOT_FLOATS = SLOT_STRIDE / 4;
const SLOT_BYTES = 96;
export const TUNNEL_VERTEX_LAYOUT = {
  arrayStride: 52,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },   // position
    { shaderLocation: 1, offset: 12, format: 'snorm16x4' },  // normal, material
    { shaderLocation: 2, offset: 20, format: 'float32' },    // metres along
    { shaderLocation: 3, offset: 24, format: 'float32x2' },  // across, up
    { shaderLocation: 4, offset: 32, format: 'float32x2' },  // Mercator from the mesh's origin
    { shaderLocation: 5, offset: 40, format: 'snorm16x4' },  // the way along
    { shaderLocation: 6, offset: 48, format: 'snorm16x2' },  // the bore: its middle, its width
  ],
};

export class TunnelsPass {
  static async create(device, { format, timer, tunnels, view, imagery, vector, frame }) {
    const module = await loadShader(device, 'tunnel',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'vector.wgsl', 'tunnel.wgsl']);
    const slotLayout = device.createBindGroupLayout({
      label: 'tunnel-slot',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BYTES } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, slotLayout, imagery.layout, vector.layout] });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'tunnels', layout,
      vertex: { module, entryPoint: 'vs', buffers: [TUNNEL_VERTEX_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    return new TunnelsPass(device, { pipeline, slotLayout, timer, tunnels, view, imagery, vector, frame });
  }

  constructor(device, { pipeline, slotLayout, timer, tunnels, view, imagery, vector, frame }) {
    this.device = device;
    this.pipeline = pipeline;
    this.timer = timer;
    this.tunnels = tunnels;
    this.view = view;
    this.imagery = imagery;
    this.vector = vector;
    this.frame = frame;
    this.data = new Float32Array(MAX_TUBES * SLOT_FLOATS);
    this.words = new Uint32Array(this.data.buffer);
    this.buffer = device.createBuffer({
      label: 'tunnel-slots', size: MAX_TUBES * SLOT_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.slots = device.createBindGroup({
      label: 'tunnel-slots', layout: slotLayout,
      entries: [{ binding: 0, resource: { buffer: this.buffer, size: SLOT_BYTES } }],
    });
    this.draws = [];
    this.triangles = 0;           // drawn this frame, for the performance panel
  }

  update({ camera }) {
    this.draws.length = 0;
    this.triangles = 0;
    if (!camera || !this.tunnels.enabled) return;
    const p = camera.position, d = this.data, w = this.words, imagery = this.imagery, anchor = imagery.anchor;
    for (const m of this.tunnels.meshes) {
      if (this.draws.length >= MAX_TUBES) break;
      if (!this.view.sphereVisible(m.center, m.radius)) continue;
      const o = this.draws.length * SLOT_FLOATS;
      d[o] = m.origin[0] - p[0];
      d[o + 1] = m.origin[1] - p[1];
      d[o + 2] = m.origin[2] - p[2];
      d[o + 3] = m.lampStep;
      // The mesh's Mercator positions are at the zoom it was built for; the photos' may differ.
      const scale = imagery.enabled ? 2 ** (imagery.zMax - m.zoom) : 1;
      d[o + 4] = m.mercOrigin[0] * scale - anchor.x;
      d[o + 5] = m.mercOrigin[1] * scale - anchor.y;
      d[o + 6] = scale;
      d[o + 7] = m.inside ? 1 : 0;
      d[o + 8] = m.portals[0];
      d[o + 9] = m.portals[1];
      d[o + 10] = m.lamp[0];
      d[o + 11] = m.lamp[1];
      d.set(m.lampColour, o + 12);
      w[o + 15] = m.family;
      d.set(m.wall, o + 16);
      d[o + 19] = m.lampSize;
      d[o + 20] = m.spring;
      // The lamps' light against daylight (the eye adapts to it inside: tunnels.js EYE).
      d[o + 21] = EYE.interior;
      this.draws.push(m);
      this.triangles += m.indexCount / 3;
    }
    if (this.draws.length) this.device.queue.writeBuffer(this.buffer, 0, d, 0, this.draws.length * SLOT_FLOATS);
  }

  record(encoder, colorView, depthView) {
    if (!this.draws.length) return;
    const d = this.desc ??= {
      label: 'tunnels',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('tunnels');
    const pass = encoder.beginRenderPass(d);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(2, this.imagery.bindGroup);
    pass.setBindGroup(3, this.vector.bindGroup);
    for (let i = 0; i < this.draws.length; i++) {
      const m = this.draws[i];
      pass.setBindGroup(1, this.slots, [i * SLOT_STRIDE]);
      pass.setVertexBuffer(0, m.vbuf);
      pass.setIndexBuffer(m.ibuf, 'uint32');
      pass.drawIndexed(m.indexCount);
    }
    pass.end();
  }
}
