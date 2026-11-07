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
 *
 * Tiles a tunnel's bore reaches go through a third (5.17e), which leaves out
 * whatever of the ground lies inside the bore, exactly, along the whole tube
 * and at every level of detail (tunnels/cuts.js: the bores' segments that
 * reach the tile, in its own east-north-up frame, in a storage buffer shared
 * by every tile; the slot says which). 5.17d opened the ground only round
 * each portal, by an estimate of how far in the hillside reached, on the
 * finer tiles and two portals a tile: elsewhere the ground stood inside the
 * tubes, and a coarser tile drawn over a portal shut it. The third pipeline
 * draws both sides (from inside a tunnel, the ground round its portal is
 * seen from beneath), so tiles within a portal's reach go through it too.
 * Where the bore would be under a pixel wide on a tile, nothing is cut.
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { tileMapping } from '../imagery/mercator.js';
import { TERRAIN_VERTEX_LAYOUT, TILE_UNIFORM_STRIDE, TILE_UNIFORM_FLOATS } from '../terrain/format.js';
import { enuBasis, geodeticToEcef } from '../../core/math.js';
import { cutsInFrame, CUT_FLOATS } from '../tunnels/cuts.js';

const MAX_TILES = 1024;
/* What the shader reads of a tile's slot (terrain.wgsl Tile). */
const TILE_BYTES = 128;
/* Floats into a slot: the tile's frame (east, north, up) and its cuts' first and count. */
const FRAME_AT = 16;
/* The narrowest a bore may look on a tile (pixels) and still be cut out of it. */
const CUT_PIXELS = 0.75;
/* Segments a tile's pixels look at, at most (terrain.wgsl CUT_MOST), and metres round a segment's ends its bore may
 * reach past its outline (the run-on past a joint, the outline's margin). */
const CUT_MOST = 128, CUT_REACH = 0.5;
/* Each tile's cuts get a number when made: the shared buffer goes up again only when the tiles' numbers change. */
let cutIds = 0;

export class TerrainPass {
  static async create(device, { format, timer, terrain, imagery, vector, tunnels, frame, view = null }) {
    const module = await loadShader(device, 'terrain',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'vector.wgsl', 'terrain.wgsl']);

    const tileLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TILE_BYTES } },
        // The bores' segments (tunnels/cuts.js), every tile's after one another.
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    // Group 3: the roads and railways under each pixel (engine/vector/tiles.js).
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, tileLayout, imagery.layout, vector.layout] });

    const describe = (label, entryPoint, cullMode = 'back') => ({
      label,
      layout,
      vertex: { module, entryPoint: 'vs', buffers: [TERRAIN_VERTEX_LAYOUT] },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode, frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const [whole, masked, cut] = await Promise.all([
      device.createRenderPipelineAsync(describe('terrain', 'fs')),
      device.createRenderPipelineAsync(describe('terrain-masked', 'fsMasked')),
      // Both sides: the ground round a portal seen from inside the tunnel is met from beneath (terrain.wgsl fsCut).
      device.createRenderPipelineAsync(describe('terrain-cut', 'fsCut', 'none')),
    ]);

    return new TerrainPass(device, { whole, masked, cut }, { tileLayout, timer, terrain, imagery, vector, tunnels, frame, view });
  }

  constructor(device, pipelines, { tileLayout, timer, terrain, imagery, vector, tunnels, frame, view }) {
    this.device = device;
    this.pipelines = pipelines;
    this.tileLayout = tileLayout;
    this.timer = timer;
    this.terrain = terrain;
    this.imagery = imagery;
    this.vector = vector;
    this.tunnels = tunnels;
    this.frame = frame;
    this.view = view;
    this.kinds = new Uint8Array(MAX_TILES);   // per draw: 0 whole, 1 masked, 2 cut (or near a portal)
    this.portalScratch = [];
    this.scratch = { e: new Float64Array(3), n: new Float64Array(3), u: new Float64Array(3) };

    this.tileData = new Float32Array(MAX_TILES * TILE_UNIFORM_FLOATS);
    this.tileU32 = new Uint32Array(this.tileData.buffer);
    this.tileBuffer = device.createBuffer({
      size: MAX_TILES * TILE_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'terrain-tiles',
    });
    // The cuts of the tiles drawn, one after another (each tile's first and count in its slot), grown as needed.
    this.cutData = new Float32Array(64 * CUT_FLOATS);
    this.cutBuffer = this.#cutStore(this.cutData.byteLength);
    this.cutSig = '';
    this.cutTiles = 0;            // tiles drawn with a cut this frame, for the performance panel
    this.cutSegments = 0;
    this.tileBind = this.#bind();

    this.draws = [];
    this.triangles = 0;           // drawn this frame, for the performance panel
  }

  #cutStore(bytes) {
    return this.device.createBuffer({ label: 'terrain-cuts', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  #bind() {
    return this.device.createBindGroup({
      layout: this.tileLayout,
      entries: [
        { binding: 0, resource: { buffer: this.tileBuffer, size: TILE_BYTES } },
        { binding: 1, resource: { buffer: this.cutBuffer } },
      ],
    });
  }

  update({ camera }) {
    if (!camera) return;
    const p = camera.position;

    // Per-tile records, packed into their dynamic-offset slots in draw order.
    this.draws.length = 0;
    this.triangles = 0;
    const tiles = this.terrain.visible;
    const count = Math.min(tiles.length, MAX_TILES);
    const imagery = this.imagery;
    const anchor = imagery.anchor;
    const d = this.tileData, w = this.tileU32;
    const tunnels = this.tunnels?.enabled ? this.tunnels : null;
    const cuts = tunnels?.cuts?.length ? tunnels.cuts : null;
    // (With the layer off, none: the list kept from the last frame it was on would still draw tiles two-sided.)
    if (!tunnels) this.portalScratch.length = 0;
    const portals = tunnels ? this.#nearPortals(p) : this.portalScratch;
    let cutCount = 0, sig = '';
    this.cutTiles = 0;
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
      w[o + 15] = t.mask;
      // The bores reaching it (seen at least CUT_PIXELS wide), and whether a portal is near enough for both its
      // sides to be drawn.
      const segs = cuts ? this.#cutsOf(t, tunnels, p) : null;
      const near = portals.length > 0 && this.#nearPortal(t, portals);
      let segments = 0;
      if (segs || near) {
        const f = this.#frameOf(t);
        d.set(f.east, o + FRAME_AT);
        d.set(f.north, o + FRAME_AT + 4);
        d.set(f.up, o + FRAME_AT + 8);
      }
      if (segs) {
        segments = segs.length / CUT_FLOATS;
        // How far its bores reach (the shader looks no further for most of its pixels).
        d[o + FRAME_AT + 11] = t.cut.top;
        d.set(t.cut.box, o + FRAME_AT + 12);
        if ((cutCount + segments) * CUT_FLOATS > this.cutData.length) {
          const grown = new Float32Array(Math.max(this.cutData.length * 2, (cutCount + segments) * CUT_FLOATS));
          grown.set(this.cutData);
          this.cutData = grown;
        }
        this.cutData.set(segs, cutCount * CUT_FLOATS);
        sig += `${t.cut.id},`;
        this.cutTiles++;
      }
      w[o + FRAME_AT + 3] = cutCount;
      w[o + FRAME_AT + 7] = segments;
      cutCount += segments;
      this.kinds[i] = segs || near ? 2 : t.mask !== 0 ? 1 : 0;
      this.draws.push(t);
      this.triangles += t.indexCount / 3;
    }
    this.cutSegments = cutCount;
    if (count) {
      this.device.queue.writeBuffer(this.tileBuffer, 0, this.tileData, 0, count * TILE_UNIFORM_FLOATS);
    }
    // The cuts go up only when which tiles have them, or theirs, changed.
    if (cutCount && sig !== this.cutSig) {
      if (this.cutData.byteLength > this.cutBuffer.size) {
        this.cutBuffer.destroy();
        this.cutBuffer = this.#cutStore(this.cutData.byteLength);
        this.tileBind = this.#bind();
      }
      this.device.queue.writeBuffer(this.cutBuffer, 0, this.cutData, 0, cutCount * CUT_FLOATS);
    }
    this.cutSig = sig;
  }

  /* A tile's frame: east, north and up at its middle, from its origin (the vertices' own), and its box in that frame
   * (its rectangle's corners at its least and most height). Kept on the tile. */
  #frameOf(t) {
    if (t.cutFrame && t.cutFrame.origin === t.origin) return t.cutFrame;
    const { e, n, u } = this.scratch, r = t.rect;
    enuBasis((r.west + r.east) / 2, (r.south + r.north) / 2, e, n, u);
    const f = { origin: t.origin, east: Float64Array.from(e), north: Float64Array.from(n), up: Float64Array.from(u), lo: [0, 0, 0], size: [0, 0, 0] };
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const lon of [r.west, r.east]) for (const lat of [r.south, r.north]) for (const h of [t.minHeight, t.maxHeight]) {
      const c = geodeticToEcef(lon, lat, h), dx = c[0] - t.origin[0], dy = c[1] - t.origin[1], dz = c[2] - t.origin[2];
      const q = [dx * e[0] + dy * e[1] + dz * e[2], dx * n[0] + dy * n[1] + dz * n[2], dx * u[0] + dy * u[1] + dz * u[2]];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
    }
    // (A tile's surface bulges between its corners as the earth does: a few metres on the coarsest.)
    const bulge = ((r.east - r.west) * 111320) ** 2 / (8 * 6371000) + 1;
    for (let k = 0; k < 3; k++) { f.lo[k] = lo[k] - (k === 2 ? bulge : 0); f.size[k] = hi[k] - lo[k] + (k === 2 ? 2 * bulge : 0); }
    t.cutFrame = f;
    return f;
  }

  /* A tile's cuts (CUT_FLOATS a segment, in its frame), or null: the bores' segments that reach its box, kept on the
   * tile until the tunnels change; none where the widest of them would look under CUT_PIXELS wide from here. */
  #cutsOf(t, tunnels, camera) {
    let c = t.cut;
    const f = this.#frameOf(t);
    if (!c || c.version !== tunnels.cutVersion || c.frame !== f) {
      const out = cutsInFrame(tunnels.cuts, f, f.lo, f.size, true);
      // More than the shader looks at (terrain.wgsl CUT_MOST): the nearest the camera first.
      if (out.length > CUT_MOST * CUT_FLOATS) nearestFirst(out, f, camera);
      c = t.cut = { version: tunnels.cutVersion, frame: f, data: out.length ? Float32Array.from(out) : null, id: ++cutIds, ...reachOf(out) };
    }
    if (!c.data) return null;
    if (this.view) {
      // The camera's distance from the tile's box (its frame).
      const f = t.cutFrame, dx = camera[0] - f.origin[0], dy = camera[1] - f.origin[1], dz = camera[2] - f.origin[2];
      const q = [dx * f.east[0] + dy * f.east[1] + dz * f.east[2], dx * f.north[0] + dy * f.north[1] + dz * f.north[2],
        dx * f.up[0] + dy * f.up[1] + dz * f.up[2]];
      let gap = 0;
      for (let k = 0; k < 3; k++) gap += Math.max(0, f.lo[k] - q[k], q[k] - f.lo[k] - f.size[k]) ** 2;
      if ((2 * c.widest * this.view.pixelsPerRadian) / Math.max(1, Math.sqrt(gap)) < CUT_PIXELS) return null;
    }
    return c.data;
  }

  /* The portals within 8 km, their reach's box (degrees) made once. */
  #nearPortals(p) {
    const out = this.portalScratch;
    out.length = 0;
    for (const q of this.tunnels.portals) {
      const dx = q.ecef[0] - p[0], dy = q.ecef[1] - p[1], dz = q.ecef[2] - p[2];
      if (dx * dx + dy * dy + dz * dz > 8000 * 8000) continue;
      if (!q.box) {
        const r = q.reach ?? 60, dl = r / (111320 * Math.cos((q.lat * Math.PI) / 180)), dt = r / 111132;
        q.box = [q.lon - dl, q.lat - dt, q.lon + dl, q.lat + dt];
      }
      out.push(q);
    }
    return out;
  }

  /* Whether a portal's reach touches a tile (it is drawn from both sides there). */
  #nearPortal(t, portals) {
    const r = t.rect;
    for (const q of portals) {
      const b = q.box;
      if (!(b[0] > r.east || b[2] < r.west || b[1] > r.north || b[3] < r.south)) return true;
    }
    return false;
  }

  record(encoder, colorView, depthView) {
    const d = this.desc ??= {
      label: 'terrain',
      colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: null, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: undefined,
    };
    d.colorAttachments[0].view = colorView;
    d.depthStencilAttachment.view = depthView;
    d.timestampWrites = this.timer?.writes('terrain');
    const pass = encoder.beginRenderPass(d);

    if (this.draws.length) {
      pass.setBindGroup(0, this.frame.bindGroup);
      pass.setBindGroup(2, this.imagery.bindGroup);
      // Read every frame: a new memory setting makes a new buffer.
      pass.setBindGroup(3, this.vector.bindGroup);
      // Whole tiles first, near to far, then the few partly covered ones, then those a bore reaches.
      const pipelines = [this.pipelines.whole, this.pipelines.masked, this.pipelines.cut];
      for (let k = 0; k < 3; k++) {
        let bound = false;
        for (let i = 0; i < this.draws.length; i++) {
          const t = this.draws[i];
          if (this.kinds[i] !== k) continue;
          if (!bound) { pass.setPipeline(pipelines[k]); bound = true; }
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

/* How far a tile's segments reach (their frame): { widest, top, box: [least east, north, most east, north] }. */
function reachOf(out) {
  let widest = 0, top = -Infinity;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < out.length; k += CUT_FLOATS) {
    widest = Math.max(widest, out[k + 3], out[k + 7], out[k + 10], out[k + 14]);
    for (let e = 0; e < 2; e++) {
      const p = k + 4 * e, o = k + 8 + 4 * e, r = Math.max(out[p + 3], out[o + 2]) + CUT_REACH;
      box[0] = Math.min(box[0], out[p] - r); box[1] = Math.min(box[1], out[p + 1] - r);
      box[2] = Math.max(box[2], out[p] + r); box[3] = Math.max(box[3], out[p + 1] + r);
      top = Math.max(top, out[p + 2] + Math.max(Math.abs(out[o]), out[o + 1] + out[o + 3]) + CUT_REACH);
    }
  }
  return { widest, top, box: Float32Array.from(box) };
}

/* A tile's segments, the nearest the camera first (in place). */
function nearestFirst(out, f, camera) {
  const dx = camera[0] - f.origin[0], dy = camera[1] - f.origin[1], dz = camera[2] - f.origin[2];
  const cx = dx * f.east[0] + dy * f.east[1] + dz * f.east[2], cy = dx * f.north[0] + dy * f.north[1] + dz * f.north[2];
  const n = out.length / CUT_FLOATS, order = [];
  for (let i = 0; i < n; i++) {
    const k = i * CUT_FLOATS, mx = (out[k] + out[k + 4]) / 2 - cx, my = (out[k + 1] + out[k + 5]) / 2 - cy;
    order.push([mx * mx + my * my, i]);
  }
  order.sort((a, b) => a[0] - b[0]);
  const copy = out.slice();
  order.forEach(([, i], j) => { for (let q = 0; q < CUT_FLOATS; q++) out[j * CUT_FLOATS + q] = copy[i * CUT_FLOATS + q]; });
}
