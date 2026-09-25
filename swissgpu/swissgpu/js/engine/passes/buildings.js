/* buildings.js (pass) — draws the building tiles the tilesets selected.
 *
 * One indexed draw per tile, each with a 128-byte block in a shared uniform
 * buffer at its own dynamic offset: the tile frame's origin relative to the
 * camera (subtracted in doubles, like the terrain's), its three axes, the box
 * its vertices are quantised into, where its buildings' records start in the
 * shared feature pool, and where the frame sits on the imagery grid so roofs
 * can sample the aerial photograph. The pool and the material textures are
 * bound once for every tile.
 *
 * Nothing is culled by winding. Building data is not reliably wound, and the
 * inside of a wall is the right thing to see when standing in a building.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { mercX, mercY, worldPixels } from '../imagery/mercator.js';
import { radiiAt, DEG } from '../../core/math.js';

const MAX_BLOCKS = 2048;
const BLOCK_STRIDE = 256;          // minimum dynamic-offset alignment
const BLOCK_FLOATS = BLOCK_STRIDE / 4;
const BLOCK_BYTES = 128;           // what the shader reads of each slot

export const BUILDING_VERTEX_LAYOUT = {
  arrayStride: 12,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'unorm16x4' },   // east, north, up, height above base
    { shaderLocation: 1, offset: 8, format: 'uint16x2' },    // building number in the tile, wall facing
  ],
};

export class BuildingsPass {
  /**
   * @param features   the shared record of every loaded building (features/feature-pool.js)
   * @param materials  the material textures (material-library.js)
   */
  static async create(device, { format, timer, tilesets, imagery, frame, features, materials }) {
    const module = await loadShader(device, 'buildings',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'buildings.wgsl']);
    const blockLayout = device.createBindGroupLayout({
      label: 'building-block',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BLOCK_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const pipeline = await device.createRenderPipelineAsync({
      label: 'buildings',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frame.layout, blockLayout, imagery.layout] }),
      vertex: { module, entryPoint: 'vs', buffers: [BUILDING_VERTEX_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    return new BuildingsPass(device, pipeline, blockLayout, { timer, tilesets, imagery, frame, features, materials });
  }

  constructor(device, pipeline, blockLayout, { timer, tilesets, imagery, frame, features, materials }) {
    this.device = device;
    this.pipeline = pipeline;
    this.blockLayout = blockLayout;
    this.timer = timer;
    this.tilesets = tilesets;
    this.imagery = imagery;
    this.frame = frame;
    this.features = features;
    this.materials = materials;
    this.data = new Float32Array(MAX_BLOCKS * BLOCK_FLOATS);
    this.words = new Uint32Array(this.data.buffer);
    this.buffer = device.createBuffer({
      label: 'building-blocks', size: MAX_BLOCKS * BLOCK_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bind = null;
    this.bindVersion = -1;
    this.draws = [];
  }

  /* The pool's buffer is replaced when it grows; the bind group follows. */
  #bindGroup() {
    if (this.bind && this.bindVersion === this.features.version) return this.bind;
    this.bindVersion = this.features.version;
    this.bind = this.device.createBindGroup({
      label: 'building-block', layout: this.blockLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer, size: BLOCK_BYTES } },
        { binding: 1, resource: { buffer: this.features.buffer } },
        { binding: 2, resource: this.materials.view },
        { binding: 3, resource: this.materials.sampler },
      ],
    });
    return this.bind;
  }

  update({ camera }) {
    this.draws.length = 0;
    if (!camera) return;
    for (const tileset of this.tilesets) {
      if (!tileset.enabled) continue;
      for (const node of tileset.visible) this.draws.push(node);
    }
    // Near to far, so the depth test rejects more of what is drawn later.
    this.draws.sort((a, b) => a.distance - b.distance);
    if (this.draws.length > MAX_BLOCKS) this.draws.length = MAX_BLOCKS;

    const p = camera.position, d = this.data, imagery = this.imagery, anchor = imagery.anchor;
    for (let i = 0; i < this.draws.length; i++) {
      const node = this.draws[i], g = node.gpu, o = i * BLOCK_FLOATS;
      d[o + 0] = g.origin[0] - p[0];
      d[o + 1] = g.origin[1] - p[1];
      d[o + 2] = g.origin[2] - p[2];
      d[o + 3] = node.depth;
      d.set(g.east, o + 4);
      this.words[o + 7] = g.featureBase;
      d.set(g.north, o + 8);
      d.set(g.up, o + 12);
      d.set(g.boxMin, o + 16);
      d.set(g.boxSize, o + 20);
      if (imagery.enabled) {
        if (!g.mercator || g.mercator.zoom !== imagery.zMax) g.mercator = frameMercator(node.frame, imagery.zMax);
        const m = g.mercator;
        d[o + 24] = m.x0 - anchor.x;
        d[o + 25] = m.y0 - anchor.y;
        d[o + 26] = m.ax;
        d[o + 27] = m.by;
        d[o + 28] = m.kx;
        d[o + 29] = m.cy;
        d[o + 30] = m.parallel;
      }
    }
    if (this.draws.length) {
      this.device.queue.writeBuffer(this.buffer, 0, d, 0, this.draws.length * BLOCK_FLOATS);
    }
  }

  record(encoder, colorView, depthView) {
    const pass = encoder.beginRenderPass({
      label: 'buildings',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: this.timer?.writes('buildings'),
    });
    if (this.draws.length) {
      const bind = this.#bindGroup();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.frame.bindGroup);
      pass.setBindGroup(2, this.imagery.bindGroup);
      for (let i = 0; i < this.draws.length; i++) {
        const g = this.draws[i].gpu;
        pass.setBindGroup(1, bind, [i * BLOCK_STRIDE]);
        pass.setVertexBuffer(0, g.vbuf);
        pass.setIndexBuffer(g.ibuf, g.indexFormat);
        pass.drawIndexed(g.indexCount);
      }
    }
    pass.end();
  }
}

/**
 * Where a tile's frame origin sits on the imagery's reference pixel grid, and
 * how that grid stretches around it: pixels per metre east and north, the
 * east scale's growth with distance north (meridians converge), the north
 * scale's curvature (Mercator stretches towards the pole), and the curve of
 * the parallel itself: a point due east on the frame's flat plane lies south
 * of the origin's latitude by x² tan φ / 2N, a metre at 3.5 km. The radii
 * are taken at the frame's own height: metres measured 2,000 m up span a
 * little more angle than metres at sea level, which is otherwise a metre of
 * error across a mountain tile. Altogether a fraction of a reference pixel
 * across a tile a few kilometres wide.
 */
function frameMercator(frame, zoom) {
  const S = worldPixels(zoom);
  const phi = frame.lat * DEG;
  const radii = radiiAt(frame.lat);
  const M = radii.meridian + frame.height, N = radii.primeVertical + frame.height;
  const c = Math.cos(phi);
  return {
    zoom,
    x0: mercX(frame.lon) * S,
    y0: mercY(frame.lat) * S,
    ax: S / (2 * Math.PI * N * c),
    kx: Math.tan(phi) / M,
    by: -S / (2 * Math.PI * M * c),
    cy: (-S * Math.sin(phi)) / (4 * Math.PI * c * c * M * M),
    parallel: Math.tan(phi) / (2 * N),
  };
}
