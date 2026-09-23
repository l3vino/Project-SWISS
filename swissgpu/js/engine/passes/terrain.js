/* terrain.js (pass) — draws whatever the tile cache has resident.
 *
 * One indexed draw per tile. Each needs its own origin, rectangle and height
 * range, which is a dynamic offset into a single uniform buffer rather than a
 * bind group per tile: bind groups are expensive to create and tiles come and
 * go constantly, while a 256-byte slot is just an offset.
 *
 * The per-tile origins are recomputed every frame because they are relative to
 * the camera, and the camera moves. That is the floating origin: the large
 * coordinates are cancelled in double precision on the CPU and the GPU only
 * ever sees small numbers.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { TERRAIN_VERTEX_LAYOUT, TILE_UNIFORM_STRIDE, TILE_UNIFORM_FLOATS } from '../terrain/format.js';

const MAX_TILES = 1024;
const FRAME_FLOATS = 32; // mat4 + 3 vec4-aligned blocks

export class TerrainPass {
  static async create(device, { format, timer, terrain }) {
    const url = new URL('../shaders/terrain.wgsl', import.meta.url);
    const code = await (await fetch(url)).text();
    const module = device.createShaderModule({ code, label: 'terrain' });

    const info = await module.getCompilationInfo();
    for (const m of info.messages) {
      if (m.type === 'error') throw new Error(`terrain.wgsl:${m.lineNum}: ${m.message}`);
    }

    const frameLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                  buffer: { type: 'uniform' } }],
    });
    const tileLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 } }],
    });

    const pipeline = await device.createRenderPipelineAsync({
      label: 'terrain',
      layout: device.createPipelineLayout({ bindGroupLayouts: [frameLayout, tileLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [TERRAIN_VERTEX_LAYOUT] },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      // Skirts are stitched without regard for winding, so nothing is culled
      // yet. Tightening this is a 1b job, once the mesh is proven.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });

    return new TerrainPass(device, pipeline, { frameLayout, tileLayout, timer, terrain });
  }

  constructor(device, pipeline, { frameLayout, tileLayout, timer, terrain }) {
    this.device = device;
    this.pipeline = pipeline;
    this.timer = timer;
    this.terrain = terrain;
    this.debugMode = 0;

    this.frameData = new Float32Array(FRAME_FLOATS);
    // debugMode is a u32 inside a float buffer; take the view once, not per frame.
    this.frameU32 = new Uint32Array(this.frameData.buffer);
    this.frameBuffer = device.createBuffer({
      size: FRAME_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'terrain-frame',
    });
    this.frameBind = device.createBindGroup({
      layout: frameLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });

    this.tileData = new Float32Array(MAX_TILES * TILE_UNIFORM_FLOATS);
    this.tileBuffer = device.createBuffer({
      size: MAX_TILES * TILE_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'terrain-tiles',
    });
    this.tileBind = device.createBindGroup({
      layout: tileLayout,
      entries: [{ binding: 0, resource: { buffer: this.tileBuffer, size: 64 } }],
    });

    this.draws = [];
  }

  update({ camera, width, height, fovY = 1.0472, near = 1 }) {
    if (!camera) return;

    const viewProj = camera.matrices(width / Math.max(1, height), fovY, near);
    this.frameData.set(viewProj, 0);

    const p = camera.position;
    this.frameData[16] = p[0]; this.frameData[17] = p[1]; this.frameData[18] = p[2];
    this.frameData[19] = near;

    const sun = camera.sunDirection();
    this.frameData[20] = sun[0]; this.frameData[21] = sun[1]; this.frameData[22] = sun[2];
    this.frameU32[23] = this.debugMode;

    // Matches the sky's horizon so the two blend where they meet.
    this.frameData[24] = 0.52; this.frameData[25] = 0.62; this.frameData[26] = 0.72;
    this.frameData[27] = 4.5e-6;

    this.device.queue.writeBuffer(this.frameBuffer, 0, this.frameData, 0, FRAME_FLOATS);

    // Per-tile records, packed into their dynamic-offset slots.
    this.draws.length = 0;
    const tiles = this.terrain.visible;
    const count = Math.min(tiles.length, MAX_TILES);
    for (let i = 0; i < count; i++) {
      const t = tiles[i];
      const o = i * TILE_UNIFORM_FLOATS;
      // The subtraction happens in doubles; only the small result is narrowed.
      this.tileData[o + 0] = t.origin[0] - p[0];
      this.tileData[o + 1] = t.origin[1] - p[1];
      this.tileData[o + 2] = t.origin[2] - p[2];
      this.tileData[o + 4] = t.rect.west;
      this.tileData[o + 5] = t.rect.south;
      this.tileData[o + 6] = t.rect.east;
      this.tileData[o + 7] = t.rect.north;
      this.tileData[o + 8] = t.minHeight;
      this.tileData[o + 9] = t.maxHeight;
      this.draws.push(t);
    }
    if (count) {
      this.device.queue.writeBuffer(this.tileBuffer, 0, this.tileData, 0, count * TILE_UNIFORM_FLOATS);
    }
  }

  record(encoder, colorView, depthView) {
    const pass = encoder.beginRenderPass({
      label: 'terrain',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: this.timer?.writes('terrain'),
    });

    if (this.draws.length) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.frameBind);
      for (let i = 0; i < this.draws.length; i++) {
        const t = this.draws[i];
        pass.setBindGroup(1, this.tileBind, [i * TILE_UNIFORM_STRIDE]);
        pass.setVertexBuffer(0, t.vbuf);
        pass.setIndexBuffer(t.ibuf, t.indexFormat);
        pass.drawIndexed(t.indexCount);
      }
    }
    pass.end();
  }
}
