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
 * the early depth test that a discard would cost. Tiles a tunnel portal
 * is near (engine/tunnels/tunnels.js, within its reach) go through a third,
 * which draws both sides (from inside a tunnel the ground round its portal
 * is seen from beneath) and leaves the ground out inside the openings that
 * reach the tile (up to two a tile, the nearest the camera; 5.17d: by the
 * opening's own extent, where 5.17c took every portal within 60 m and in a
 * town the third left its opening shut).
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { tileMapping } from '../imagery/mercator.js';
import { TERRAIN_VERTEX_LAYOUT, TILE_UNIFORM_STRIDE, TILE_UNIFORM_FLOATS } from '../terrain/format.js';
import { enuBasis, geodeticToEcef } from '../../core/math.js';
import { cutsInFrame, cutsReach, nearestFirst, CUT_FLOATS, CUT_MOST, CUT_HEADER, CUT_SLOT_FLOATS, CUT_SLOT_BYTES } from '../tunnels/cuts.js';

const MAX_TILES = 1024;
/* What the shader reads of a tile's slot: its 64 bytes and two portals of 96 (all of its 256). */
const TILE_BYTES = 256;
const PORTAL_FLOATS = 24;
const PORTALS_AT = 16;
const PORTALS_PER_TILE = 2;
/* The portals nearest the camera opened at all, and the coarsest tiles opened (an opening on a coarser tile is a
 * pixel or two away). */
const PORTALS_MOST = 24;
const PORTAL_LEAST_LEVEL = 13;
/* The ground cut along the tunnels' whole bores (5.17k): a uniform buffer of CUT_SLOTS slots made once and never made
 * again, one for each tile a bore reaches (CUT_SLOT_BYTES: its frame, how many pieces and how far they reach in a
 * 16-float header, then CUT_MOST pieces, the nearest the camera first; bore.wgsl CutSlot), bound with a dynamic
 * offset as the tile's own slot is (5.17e's storage buffer of every tile's pieces after one another, rewritten and
 * made again as it grew, went with his GPU being reset). Tiles past CUT_SLOTS fall back to 5.17d's openings at the
 * portals. A tile's pieces are put nearest first again once the camera has moved RESORT metres; none are drawn where
 * the widest would look under CUT_PIXELS wide. */
const CUT_SLOTS = 96;
const RESORT = 40, CUT_PIXELS = 0.75;
let cutIds = 0;

export class TerrainPass {
  static async create(device, { format, timer, terrain, imagery, vector, tunnels, frame, view = null }) {
    const module = await loadShader(device, 'terrain',
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'vector.wgsl', 'bore.wgsl', 'terrain.wgsl']);

    const tileLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                  buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: TILE_BYTES } },
                // The tile's slot of the bores' pieces (5.17k: CUT_SLOTS above).
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,
                  buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CUT_SLOT_BYTES } }],
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
    const [whole, masked, portal, cut] = await Promise.all([
      device.createRenderPipelineAsync(describe('terrain', 'fs')),
      device.createRenderPipelineAsync(describe('terrain-masked', 'fsMasked')),
      // Both sides: the ground round a portal seen from inside the tunnel is met from beneath (terrain.wgsl fsPortal).
      device.createRenderPipelineAsync(describe('terrain-portal', 'fsPortal', 'none')),
      // And along the whole bore (fsCut).
      device.createRenderPipelineAsync(describe('terrain-cut', 'fsCut', 'none')),
    ]);

    return new TerrainPass(device, { whole, masked, portal, cut }, { tileLayout, timer, terrain, imagery, vector, tunnels, frame, view });
  }

  constructor(device, pipelines, { tileLayout, timer, terrain, imagery, vector, tunnels, frame, view = null }) {
    this.device = device;
    this.pipelines = pipelines;
    this.timer = timer;
    this.terrain = terrain;
    this.imagery = imagery;
    this.vector = vector;
    this.tunnels = tunnels;
    this.frame = frame;
    this.view = view;
    this.kinds = new Uint8Array(MAX_TILES);   // per draw: 0 whole, 1 masked, 2 with portals, 3 cut along the bores
    this.portalScratch = [];
    this.openGround = true;       // whether the ground is opened at the tunnels at all (Graphics → Diagnostics)
    this.boreCut = true;          // and along their whole bores (off: at their portals only, 5.17d's way)
    this.scratch = { e: new Float64Array(3), n: new Float64Array(3), u: new Float64Array(3) };

    // The bores' pieces of the tiles drawn: a slot each (CUT_SLOTS above), which slot each draw has, and what the
    // buffer holds (rewritten when that changes).
    this.cutData = new Float32Array(CUT_SLOTS * CUT_SLOT_FLOATS);
    this.cutU32 = new Uint32Array(this.cutData.buffer);
    this.cutBuffer = device.createBuffer({ label: 'terrain-cut-slots', size: CUT_SLOTS * CUT_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cutSlots = new Uint8Array(MAX_TILES);
    this.cutSig = '';
    this.cutTiles = 0;            // drawn cut this frame, and their pieces (for the probe and a loss's report)
    this.cutSegments = 0;
    this.axes = { e: new Float64Array(3), n: new Float64Array(3), u: new Float64Array(3) };

    this.tileData = new Float32Array(MAX_TILES * TILE_UNIFORM_FLOATS);
    this.tileU32 = new Uint32Array(this.tileData.buffer);
    this.tileBuffer = device.createBuffer({
      size: MAX_TILES * TILE_UNIFORM_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'terrain-tiles',
    });
    this.tileBind = device.createBindGroup({
      layout: tileLayout,
      entries: [{ binding: 0, resource: { buffer: this.tileBuffer, size: TILE_BYTES } },
                { binding: 1, resource: { buffer: this.cutBuffer, size: CUT_SLOT_BYTES } }],
    });

    this.draws = [];
    this.triangles = 0;           // drawn this frame, for the performance panel
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
    const d = this.tileData;
    // (None with `openGround` off: Graphics → Diagnostics, to find what a GPU does not take.)
    const portals = this.openGround ? this.#nearPortals(p) : (this.portalScratch.length = 0, this.portalScratch);
    const tunnels = this.tunnels;
    const cuts = this.openGround && this.boreCut && tunnels?.enabled && tunnels.cuts?.length ? tunnels.cuts : null;
    let slots = 0, sig = '';
    this.cutSegments = 0;
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
      // The bores reaching it (5.17k), in a slot of its own; else 5.17d's openings at the portals.
      const segs = cuts && slots < CUT_SLOTS ? this.#cutsOf(t, tunnels, p) : null;
      this.cutSlots[i] = 0;
      if (segs) {
        this.#fillSlot(slots, t, segs);
        this.cutSlots[i] = slots++;
        sig += `${t.cut.id},`;
      }
      const bits = !segs && portals.length && t.z >= PORTAL_LEAST_LEVEL ? this.#portalsFor(t, portals, o) : 0;
      this.tileU32[o + 15] = t.mask | (bits & 0x300);
      this.kinds[i] = segs ? 3 : bits ? 2 : t.mask !== 0 ? 1 : 0;
      this.draws.push(t);
      this.triangles += t.indexCount / 3;
    }
    if (count) {
      this.device.queue.writeBuffer(this.tileBuffer, 0, this.tileData, 0, count * TILE_UNIFORM_FLOATS);
    }
    this.cutTiles = slots;
    // The slots in use, when what they hold has changed (the slot a tile has may change from frame to frame).
    if (slots && sig !== this.cutSig) {
      this.device.queue.writeBuffer(this.cutBuffer, 0, this.cutData, 0, slots * CUT_SLOT_FLOATS);
      this.device.journal?.note('written', 'terrain cut slots', slots * CUT_SLOT_BYTES);
    }
    this.cutSig = slots ? sig : '';
  }

  /* A slot of the cuts' buffer for tile t: its frame, how many pieces and how far they reach, the nearest CUT_MOST. */
  #fillSlot(k, t, segs) {
    const d = this.cutData, u = this.cutU32, o = k * CUT_SLOT_FLOATS, f = t.cutFrame, c = t.cut;
    const n = Math.min(CUT_MOST, segs.length / CUT_FLOATS);
    d[o] = f.east[0]; d[o + 1] = f.east[1]; d[o + 2] = f.east[2]; u[o + 3] = n;
    d[o + 4] = f.north[0]; d[o + 5] = f.north[1]; d[o + 6] = f.north[2]; d[o + 7] = c.top;
    d[o + 8] = f.up[0]; d[o + 9] = f.up[1]; d[o + 10] = f.up[2]; d[o + 11] = 0;
    d.set(c.box, o + 12);
    d.set(n * CUT_FLOATS < segs.length ? segs.subarray(0, n * CUT_FLOATS) : segs, o + CUT_HEADER);
    this.cutSegments += n;
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
      c = t.cut = { version: tunnels.cutVersion, frame: f, data: out.length ? Float32Array.from(out) : null, id: ++cutIds, sortedAt: null, ...cutsReach(out) };
    }
    if (!c.data) return null;
    // More than a slot holds: the nearest the camera first, and again once the camera has moved RESORT metres.
    if (c.data.length > CUT_MOST * CUT_FLOATS) {
      const at = c.sortedAt;
      if (!at || Math.hypot(camera[0] - at[0], camera[1] - at[1], camera[2] - at[2]) > RESORT) {
        nearestFirst(c.data, f, camera);
        c.sortedAt = [camera[0], camera[1], camera[2]];
        c.id = ++cutIds;
      }
    }
    // The camera's distance from the tile's box (its frame): too far for the widest bore to show, nothing to cut.
    const dx = camera[0] - f.origin[0], dy = camera[1] - f.origin[1], dz = camera[2] - f.origin[2];
    const q = [dx * f.east[0] + dy * f.east[1] + dz * f.east[2], dx * f.north[0] + dy * f.north[1] + dz * f.north[2],
      dx * f.up[0] + dy * f.up[1] + dz * f.up[2]];
    let gap = 0;
    for (let k = 0; k < 3; k++) gap += Math.max(0, f.lo[k] - q[k], q[k] - f.lo[k] - f.size[k]) ** 2;
    const perRadian = this.view?.pixelsPerRadian ?? 1000;
    if ((2 * c.widest * perRadian) / Math.max(1, Math.sqrt(gap)) < CUT_PIXELS) return null;
    return c.data;
  }

  /* The portals near enough to open the terrain at, each with its frame relative to the camera this frame. */
  #nearPortals(p) {
    const out = this.portalScratch;
    out.length = 0;
    const list = this.tunnels?.enabled ? this.tunnels.portals : null;
    if (!list?.length) return out;
    const { e, n, u } = this.axes;
    for (const q of list) {
      const dx = q.ecef[0] - p[0], dy = q.ecef[1] - p[1], dz = q.ecef[2] - p[2];
      q.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (q.distance > 8000) continue;
      enuBasis(q.lon, q.lat, e, n, u);
      q.rel ??= new Float64Array(3); q.inward ??= new Float64Array(3); q.right ??= new Float64Array(3); q.up ??= new Float64Array(3);
      q.rel[0] = dx; q.rel[1] = dy; q.rel[2] = dz;
      for (let k = 0; k < 3; k++) {
        q.inward[k] = e[k] * q.dirX + n[k] * q.dirY;
        // Right of the way in: (dirY, -dirX) east and north.
        q.right[k] = e[k] * q.dirY - n[k] * q.dirX;
        q.up[k] = u[k];
      }
      // How far round the portal the tiles are drawn from both sides, and its opening reaches, in degrees (a
      // portal's place never changes).
      if (!q.box) {
        const box = (r) => {
          const dl = r / (111320 * Math.cos((q.lat * Math.PI) / 180)), dt = r / 111132;
          return [q.lon - dl, q.lat - dt, q.lon + dl, q.lat + dt];
        };
        q.box = box(q.reach ?? 60 + q.half);
        q.openBox = box(q.open ?? q.reach ?? 60 + q.half);
      }
      out.push(q);
    }
    out.sort((a, b) => a.distance - b.distance);
    if (out.length > PORTALS_MOST) out.length = PORTALS_MOST;
    return out;
  }

  /* Up to two openings reaching a tile, nearest first, written into its slot: their bits in the mask (8, 9); bit 10
   * where a portal is near enough for both sides to be drawn (0: none). */
  #portalsFor(t, portals, o) {
    const r = t.rect, d = this.tileData;
    const touches = (b) => !(b[0] > r.east || b[2] < r.west || b[1] > r.north || b[3] < r.south);
    let bits = 0, used = 0;
    for (const q of portals) {
      if (used >= PORTALS_PER_TILE) break;
      if (!touches(q.box)) continue;
      bits |= 1 << 10;
      if (!touches(q.openBox)) continue;
      const w = o + PORTALS_AT + used * PORTAL_FLOATS;
      // terrain.wgsl Portal.
      d[w] = q.rel[0]; d[w + 1] = q.rel[1]; d[w + 2] = q.rel[2]; d[w + 3] = q.grade;
      d[w + 4] = q.inward[0]; d[w + 5] = q.inward[1]; d[w + 6] = q.inward[2]; d[w + 7] = q.half;
      d[w + 8] = q.right[0]; d[w + 9] = q.right[1]; d[w + 10] = q.right[2]; d[w + 11] = q.spring;
      d[w + 12] = q.up[0]; d[w + 13] = q.up[1]; d[w + 14] = q.up[2]; d[w + 15] = q.bend ?? 0;
      d[w + 16] = q.offset; d[w + 17] = q.before; d[w + 18] = q.depth;
      d[w + 19] = q.archY ?? 0; d[w + 20] = q.archA ?? 0; d[w + 21] = q.archH ?? 0; d[w + 22] = q.rise ?? 0; d[w + 23] = 0;
      bits |= 1 << (8 + used);
      used++;
    }
    return bits;
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
      // Whole tiles first, near to far, then the few partly covered ones, then those with portals, then those cut along
      // the bores.
      const pipelines = [this.pipelines.whole, this.pipelines.masked, this.pipelines.portal, this.pipelines.cut];
      const offsets = this.offsets ??= [0, 0];
      for (let k = 0; k < 4; k++) {
        let bound = false;
        for (let i = 0; i < this.draws.length; i++) {
          const t = this.draws[i];
          if (this.kinds[i] !== k) continue;
          if (!bound) { pass.setPipeline(pipelines[k]); bound = true; }
          offsets[0] = i * TILE_UNIFORM_STRIDE;
          offsets[1] = this.cutSlots[i] * CUT_SLOT_BYTES;
          pass.setBindGroup(1, this.tileBind, offsets);
          pass.setVertexBuffer(0, t.vbuf);
          pass.setIndexBuffer(t.ibuf, t.indexFormat);
          pass.drawIndexed(t.indexCount);
        }
      }
    }
    pass.end();
  }
}
