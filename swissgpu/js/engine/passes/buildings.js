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
 *
 * Where a tunnel runs through what is built (Stage 5.17d: a castle's wall
 * modelled down into the hill over a railway's tunnel), the tile is drawn
 * with fsCut, which leaves out whatever lies inside the bore: each tube's
 * cut (tunnels/cuts.js) as segments in the tile's own frame, those that
 * reach its box, in a storage buffer shared by every tile (the block says
 * which). Only those few tiles pay for the discard, which would otherwise
 * cost every building's pixels their early depth test.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { mercX, mercY, worldPixels } from '../imagery/mercator.js';
import { radiiAt, DEG } from '../../core/math.js';
import { cutsInFrame, CUT_FLOATS } from '../tunnels/cuts.js';

const MAX_BLOCKS = 2048;
const BLOCK_STRIDE = 256;          // minimum dynamic-offset alignment
const BLOCK_FLOATS = BLOCK_STRIDE / 4;
const BLOCK_BYTES = 128;           // what the shader reads of each slot

/* Near to far, so the depth test rejects more of what is drawn later. */
const nearFirst = (a, b) => a.distance - b.distance;
/* Each tile's cuts get a number when made: the shared buffer goes up again only when the tiles' numbers change. */
let cutIds = 0;

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
  static async create(device, { format, timer, tilesets, imagery, vector, frame, features, materials, tunnels = null }) {
    const module = await loadShader(device, 'buildings',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'vector.wgsl', 'buildings.wgsl']);
    const blockLayout = device.createBindGroupLayout({
      label: 'building-block',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: BLOCK_BYTES } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, blockLayout, imagery.layout, vector.layout] });
    const describe = (label, entryPoint) => ({
      label, layout,
      vertex: { module, entryPoint: 'vs', buffers: [BUILDING_VERTEX_LAYOUT] },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const [pipeline, cutPipeline] = await Promise.all([
      device.createRenderPipelineAsync(describe('buildings', 'fs')),
      device.createRenderPipelineAsync(describe('buildings-cut', 'fsCut')),
    ]);
    return new BuildingsPass(device, pipeline, cutPipeline, blockLayout, { timer, tilesets, imagery, vector, frame, features, materials, tunnels });
  }

  constructor(device, pipeline, cutPipeline, blockLayout, { timer, tilesets, imagery, vector, frame, features, materials, tunnels }) {
    this.device = device;
    this.pipeline = pipeline;
    this.cutPipeline = cutPipeline;
    this.blockLayout = blockLayout;
    this.timer = timer;
    this.tilesets = tilesets;
    this.imagery = imagery;
    this.vector = vector;         // roads and paths on bridge decks (vector.wgsl)
    this.frame = frame;
    this.features = features;
    this.materials = materials;
    this.tunnels = tunnels;       // the bores cut out of what is built (tunnels/tunnels.js `cuts`)
    this.data = new Float32Array(MAX_BLOCKS * BLOCK_FLOATS);
    this.words = new Uint32Array(this.data.buffer);
    this.buffer = device.createBuffer({
      label: 'building-blocks', size: MAX_BLOCKS * BLOCK_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // The cuts of the tiles drawn, one after another (each tile's first and count in its block), grown as needed.
    this.cutData = new Float32Array(64 * CUT_FLOATS);
    this.cutBuffer = this.#cutStore(this.cutData.byteLength);
    this.cutSig = '';
    this.cutTiles = 0;            // tiles drawn with a cut this frame, for the performance panel
    this.bind = null;
    this.bindVersion = -1;
    this.bindCuts = null;
    this.draws = [];
    this.triangles = 0;           // drawn this frame, for the performance panel
  }

  #cutStore(bytes) {
    return this.device.createBuffer({ label: 'building-cuts', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  /* The pool's buffer is replaced when it grows, and the cuts' buffer; the bind group follows. */
  #bindGroup() {
    if (this.bind && this.bindVersion === this.features.version && this.bindCuts === this.cutBuffer) return this.bind;
    this.bindVersion = this.features.version;
    this.bindCuts = this.cutBuffer;
    this.bind = this.device.createBindGroup({
      label: 'building-block', layout: this.blockLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer, size: BLOCK_BYTES } },
        { binding: 1, resource: { buffer: this.features.buffer } },
        { binding: 2, resource: this.materials.view },
        { binding: 3, resource: this.materials.sampler },
        { binding: 4, resource: { buffer: this.cutBuffer } },
      ],
    });
    return this.bind;
  }

  /* A tile's cuts (CUT_FLOATS a segment, in its frame), or null: the bores' segments that reach its box. Kept on its
   * GPU record until the tunnels change. */
  #cutsOf(g) {
    const t = this.tunnels;
    if (!t || !t.enabled || !t.cuts.length) return null;
    if (g.cut && g.cut.version === t.cutVersion) return g.cut.data;
    const frame = g.cutFrame ??= { origin: g.origin, east: g.east, north: g.north, up: g.up };
    const out = cutsInFrame(t.cuts, frame, g.boxMin, g.boxSize, false);
    g.cut = { version: t.cutVersion, data: out.length ? Float32Array.from(out) : null, id: ++cutIds };
    return g.cut.data;
  }

  update({ camera }) {
    this.draws.length = 0;
    if (!camera) return;
    for (const tileset of this.tilesets) {
      if (!tileset.enabled) continue;
      // Tiles of cable cars only have nothing for this pass (passes/cables.js).
      // A layer of bridges (the adapter's `decks`) has roads on its decks.
      for (const node of tileset.visible) {
        if (!node.gpu.indexCount) continue;
        // (On its GPU record: a node's own `decks` are the deck tops the
        // terrain asks for, features/decks.js.)
        node.gpu.deckFaces = Boolean(tileset.spec.decks);
        this.draws.push(node);
      }
    }
    this.draws.sort(nearFirst);
    if (this.draws.length > MAX_BLOCKS) this.draws.length = MAX_BLOCKS;
    this.triangles = 0;

    const p = camera.position, d = this.data, imagery = this.imagery, anchor = imagery.anchor;
    let cutCount = 0, sig = '';
    this.cutTiles = 0;
    for (let i = 0; i < this.draws.length; i++) {
      const node = this.draws[i], g = node.gpu, o = i * BLOCK_FLOATS;
      this.triangles += g.indexCount / 3;
      d[o + 0] = g.origin[0] - p[0];
      d[o + 1] = g.origin[1] - p[1];
      d[o + 2] = g.origin[2] - p[2];
      d[o + 3] = node.depth;
      d.set(g.east, o + 4);
      this.words[o + 7] = g.featureBase;
      d.set(g.north, o + 8);
      this.words[o + 11] = g.deckFaces ? 1 : 0;
      d.set(g.up, o + 12);
      d.set(g.boxMin, o + 16);
      d.set(g.boxSize, o + 20);
      // Its cuts (fsCut), after the others' in the shared buffer.
      const cuts = this.#cutsOf(g), segments = cuts ? cuts.length / CUT_FLOATS : 0;
      this.words[o + 15] = cutCount;
      this.words[o + 19] = segments;
      g.cutDrawn = segments;
      if (segments) {
        if ((cutCount + segments) * CUT_FLOATS > this.cutData.length) {
          const grown = new Float32Array(Math.max(this.cutData.length * 2, (cutCount + segments) * CUT_FLOATS));
          grown.set(this.cutData);
          this.cutData = grown;
        }
        this.cutData.set(cuts, cutCount * CUT_FLOATS);
        cutCount += segments;
        sig += `${g.cut.id},`;
        this.cutTiles++;
      }
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
    // The cuts go up only when which tiles have them, or theirs, changed.
    if (cutCount && sig !== this.cutSig) {
      if (this.cutData.byteLength > this.cutBuffer.size) {
        this.cutBuffer.destroy();
        this.cutBuffer = this.#cutStore(this.cutData.byteLength);
      }
      this.device.queue.writeBuffer(this.cutBuffer, 0, this.cutData, 0, cutCount * CUT_FLOATS);
    }
    this.cutSig = sig;
  }

  record(encoder, colorView, depthView) {
    const d = this.desc ??= {
      label: 'buildings',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('buildings');
    const pass = encoder.beginRenderPass(d);
    if (this.draws.length) {
      const bind = this.#bindGroup();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.frame.bindGroup);
      pass.setBindGroup(2, this.imagery.bindGroup);
      pass.setBindGroup(3, this.vector.bindGroup);
      let cutting = false;
      for (let i = 0; i < this.draws.length; i++) {
        const g = this.draws[i].gpu;
        // A tile with a bore through it: fsCut (only there: its discard costs early depth testing).
        if ((g.cutDrawn > 0) !== cutting) {
          cutting = g.cutDrawn > 0;
          pass.setPipeline(cutting ? this.cutPipeline : this.pipeline);
        }
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
