/* terrain.js (pass) — draws the tiles the quadtree selected.
 *
 * One indexed draw per tile. Each needs its own origin, rectangle and height
 * range, which is a dynamic offset into a single uniform buffer rather than a
 * bind group per tile: bind groups are expensive to create and tiles come and
 * go constantly, while a 256-byte slot is just an offset.
 *
 * The per-tile origins are recomputed every frame because they are relative to
 * the camera, and the camera moves. That is the floating origin: the large
 * coordinates are cancelled in double precision on the CPU and the GPU only
 * ever sees small numbers. Each tile's mapping onto the imagery grid works
 * the same way, relative to the imagery anchor.
 *
 * Back faces are culled: the surface is wound counter-clockwise seen from
 * above and every skirt faces out of its tile, so nothing visible is lost.
 * Tiles only partly replaced by finer children go through a second pipeline
 * whose fragment shader discards the covered quarters; everything else keeps
 * the early depth test that a discard would cost.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { tileMapping } from '../imagery/mercator.js';
import { TERRAIN_VERTEX_LAYOUT, TILE_UNIFORM_STRIDE, TILE_UNIFORM_FLOATS } from '../terrain/format.js';

const MAX_TILES = 1024;

export class TerrainPass {
  static async create(device, { format, timer, terrain, imagery, frame }) {
    const module = await loadShader(device, 'terrain',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'terrain.wgsl']);

    const tileLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX,
                  buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 64 } }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, tileLayout, imagery.layout] });

    const describe = (label, entryPoint) => ({
      label,
      layout,
      vertex: { module, entryPoint: 'vs', buffers: [TERRAIN_VERTEX_LAYOUT] },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const [whole, masked] = await Promise.all([
      device.createRenderPipelineAsync(describe('terrain', 'fs')),
      device.createRenderPipelineAsync(describe('terrain-masked', 'fsMasked')),
    ]);

    return new TerrainPass(device, { whole, masked }, { tileLayout, timer, terrain, imagery, frame });
  }

  constructor(device, pipelines, { tileLayout, timer, terrain, imagery, frame }) {
    this.device = device;
    this.pipelines = pipelines;
    this.timer = timer;
    this.terrain = terrain;
    this.imagery = imagery;
    this.frame = frame;

    this.tileData = new Float32Array(MAX_TILES * TILE_UNIFORM_FLOATS);
    this.tileU32 = new Uint32Array(this.tileData.buffer);
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

  update({ camera }) {
    if (!camera) return;
    const p = camera.position;

    // Per-tile records, packed into their dynamic-offset slots in draw order.
    this.draws.length = 0;
    const tiles = this.terrain.visible;
    const count = Math.min(tiles.length, MAX_TILES);
    const imagery = this.imagery;
    const anchor = imagery.anchor;
    const d = this.tileData;
    for (let i = 0; i < count; i++) {
      const t = tiles[i];
      const o = i * TILE_UNIFORM_FLOATS;
      // The subtraction happens in doubles; only the small result is narrowed.
      d[o + 0] = t.origin[0] - p[0];
      d[o + 1] = t.origin[1] - p[1];
      d[o + 2] = t.origin[2] - p[2];
      d[o + 3] = t.z;
      d[o + 4] = t.rect.west;
      d[o + 5] = t.rect.south;
      d[o + 6] = t.rect.east;
      d[o + 7] = t.rect.north;
      d[o + 8] = t.minHeight;
      d[o + 9] = t.maxHeight;
      // Where this tile lands on the imagery grid. The mapping is computed
      // once per tile in absolute pixels; only the anchor moves.
      if (imagery.enabled) {
        if (t.imageryZoom !== imagery.zMax) {
          t.imageryMap = tileMapping(t.rect, imagery.zMax);
          t.imageryZoom = imagery.zMax;
        }
        const m = t.imageryMap;
        d[o + 10] = m.xWest - anchor.x;
        d[o + 11] = m.xSpan;
        d[o + 12] = m.y0 - anchor.y;
        d[o + 13] = m.b;
        d[o + 14] = m.c;
      }
      this.tileU32[o + 15] = t.mask;
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
      pass.setBindGroup(0, this.frame.bindGroup);
      pass.setBindGroup(2, this.imagery.bindGroup);
      // Whole tiles first, near to far, then the few partly covered ones.
      for (const masked of [false, true]) {
        let bound = false;
        for (let i = 0; i < this.draws.length; i++) {
          const t = this.draws[i];
          if ((t.mask !== 0) !== masked) continue;
          if (!bound) { pass.setPipeline(masked ? this.pipelines.masked : this.pipelines.whole); bound = true; }
          pass.setBindGroup(1, this.tileBind, [i * TILE_UNIFORM_STRIDE]);
          pass.setVertexBuffer(0, t.vbuf);
          pass.setIndexBuffer(t.ibuf, t.indexFormat);
          pass.drawIndexed(t.indexCount);
        }
      }
    }
    pass.end();
  }
}
