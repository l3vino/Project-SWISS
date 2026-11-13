/* tunnels.js (pass) — the insides of tunnels near the camera.
 *
 * engine/tunnels/tunnels.js keeps a mesh per tube (wasm/src/tunnel.c), in
 * metres from its own earth-centred origin; per mesh a 256-byte slot at its
 * own dynamic offset says where that origin is from the camera, where it is
 * on the imagery grid (for the roads painted on the floor), where its
 * portals and lamps are and what it is made of (shaders/tunnel.wgsl). One
 * indexed draw a mesh, back faces culled: the triangles face inwards, so
 * from outside nothing but the inside shows through the opened terrain
 * (terrain.wgsl fsCut, fsPortal) and the collar round it. Meshes outside the
 * view are not drawn; most frames have none at all, and then no pass is begun.
 *
 * Where tubes run into each other (5.17m: a branch, carriageways joining, two
 * tubes side by side becoming one; tunnels.js `meets`), each mesh has a slot of
 * the other bores' pieces reaching into it (bore.wgsl CutSlot, in its own frame)
 * at a second dynamic offset, and is drawn by fsMeet: what of it lies inside
 * another's bore is left out, and the two are one room. The rest bind an empty
 * slot and are drawn by fs, which discards nothing (a discard in a pipeline
 * costs all its pixels their early depth test).
 */

import { DEPTH_FORMAT } from '../gpu.js';
import { loadShader } from '../shaders.js';
import { EYE } from '../tunnels/tunnels.js';
import { nearestFirst, cutsReach, CUT_FLOATS, CUT_MOST, CUT_HEADER, CUT_SLOT_FLOATS, CUT_SLOT_BYTES } from '../tunnels/cuts.js';

const MAX_TUBES = 128;
const SLOT_STRIDE = 256;
const SLOT_FLOATS = SLOT_STRIDE / 4;
const SLOT_BYTES = 112;
/* Slots for the meshes another bore reaches into (5.17m), in one uniform buffer made once; slot 0 is empty, for all
 * the others. A mesh's pieces are put nearest the camera first again once it has moved MEET_RESORT metres (where
 * more than CUT_MOST reach into it). */
const MEET_SLOTS = 24;
const MEET_RESORT = 40;
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
      ['common.wgsl', 'atmosphere.wgsl', 'frame.wgsl', 'imagery.wgsl', 'vector.wgsl', 'bore.wgsl', 'tunnel.wgsl']);
    const slotLayout = device.createBindGroupLayout({
      label: 'tunnel-slot',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SLOT_BYTES } },
        // The other bores' pieces reaching into it (5.17m: MEET_SLOTS above).
        { binding: 1, visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CUT_SLOT_BYTES } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frame.layout, slotLayout, imagery.layout, vector.layout] });
    const describe = (label, entryPoint) => ({
      label, layout,
      vertex: { module, entryPoint: 'vs', buffers: [TUNNEL_VERTEX_LAYOUT] },
      fragment: { module, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const [pipeline, meetPipeline] = await Promise.all([
      device.createRenderPipelineAsync(describe('tunnels', 'fs')),
      device.createRenderPipelineAsync(describe('tunnels-meet', 'fsMeet')),
    ]);
    return new TunnelsPass(device, { pipeline, meetPipeline, slotLayout, timer, tunnels, view, imagery, vector, frame });
  }

  constructor(device, { pipeline, meetPipeline, slotLayout, timer, tunnels, view, imagery, vector, frame }) {
    this.device = device;
    this.pipeline = pipeline;
    this.meetPipeline = meetPipeline;
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
    // The meeting bores' slots (5.17m): made once, slot 0 left empty (no pieces); which slot each draw has.
    this.meetData = new Float32Array((MEET_SLOTS + 1) * CUT_SLOT_FLOATS);
    this.meetU32 = new Uint32Array(this.meetData.buffer);
    this.meetBuffer = device.createBuffer({
      label: 'tunnel-meet-slots', size: (MEET_SLOTS + 1) * CUT_SLOT_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.meetSlots = new Uint8Array(MAX_TUBES);
    this.meetList = [];
    this.meetSig = '';
    this.slots = device.createBindGroup({
      label: 'tunnel-slots', layout: slotLayout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer, size: SLOT_BYTES } },
        { binding: 1, resource: { buffer: this.meetBuffer, size: CUT_SLOT_BYTES } },
      ],
    });
    this.offsets = [0, 0];
    this.draws = [];
    this.triangles = 0;           // drawn this frame, for the performance panel
    this.meeting = 0;             // of them drawn with others' pieces (fsMeet), and how many pieces
    this.meetPieces = 0;
    this.meetCut = true;          // Graphics → Diagnostics → Cut the ground along tunnels (render.js): off, no fsMeet
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
      w[o + 15] = m.look;
      d.set(m.wall, o + 16);
      d[o + 19] = m.lampSize;
      d[o + 20] = m.spring;
      // The lamps' light against daylight (the eye adapts to it inside: tunnels.js EYE).
      d[o + 21] = EYE.interior;
      // What it is for (5.17n, sections.js lookFor): the floor between its walkways, their height, its ventilation
      // ceiling's, its flags and ways.
      d[o + 22] = m.inner;
      d[o + 23] = m.kerb;
      d[o + 24] = m.ceiling;
      w[o + 25] = m.flags;
      w[o + 26] = m.ways;
      this.draws.push(m);
      this.triangles += m.indexCount / 3;
    }
    if (this.draws.length) this.device.queue.writeBuffer(this.buffer, 0, d, 0, this.draws.length * SLOT_FLOATS);
    this.#meetSlots(p);
  }

  /* The slots of the drawn meshes other bores reach into (5.17m), filled and written when what they hold has changed
   * (which meshes have them, in which order, and what each holds). */
  #meetSlots(camera) {
    const list = this.meetList;
    let sig = '';
    list.length = 0;
    this.meetPieces = 0;
    for (let i = 0; i < this.draws.length; i++) {
      const q = this.meetCut && list.length < MEET_SLOTS ? this.#meetOf(this.draws[i], camera) : null;
      this.meetSlots[i] = q ? list.push(q) : 0;
      if (!q) continue;
      sig += `${q.id},`;
      this.meetPieces += Math.min(CUT_MOST, q.data.length / CUT_FLOATS);
    }
    this.meeting = list.length;
    if (list.length && sig !== this.meetSig) {
      // (Slot 0 stays empty: from the start, every float of it is 0.)
      list.forEach((q, k) => this.#fillMeet(k + 1, q));
      this.device.queue.writeBuffer(this.meetBuffer, CUT_SLOT_BYTES, this.meetData, CUT_SLOT_FLOATS, list.length * CUT_SLOT_FLOATS);
      this.device.journal?.note('written', 'tunnel meet slots', list.length * CUT_SLOT_BYTES);
    }
    this.meetSig = list.length ? sig : '';
  }

  /* A mesh's pieces of the bores reaching into it (tunnels.js meetsOf: in its frame), the nearest CUT_MOST first,
   * or null. */
  #meetOf(m, camera) {
    const q = this.tunnels.meetsOf?.(m);
    if (!q) return null;
    if (!q.box) Object.assign(q, cutsReach(q.data), { sortedAt: null, id: ++meetIds });
    if (q.data.length > CUT_MOST * CUT_FLOATS) {
      const at = q.sortedAt;
      if (!at || Math.hypot(camera[0] - at[0], camera[1] - at[1], camera[2] - at[2]) > MEET_RESORT) {
        nearestFirst(q.data, q.frame, camera);
        q.sortedAt = [camera[0], camera[1], camera[2]];
        q.id = ++meetIds;
      }
    }
    return q;
  }

  /* Slot k of the meeting bores' buffer: the mesh's frame, how many pieces and how far they reach, the pieces. */
  #fillMeet(k, q) {
    const d = this.meetData, u = this.meetU32, o = k * CUT_SLOT_FLOATS, f = q.frame;
    const n = Math.min(CUT_MOST, q.data.length / CUT_FLOATS);
    d[o] = f.east[0]; d[o + 1] = f.east[1]; d[o + 2] = f.east[2]; u[o + 3] = n;
    d[o + 4] = f.north[0]; d[o + 5] = f.north[1]; d[o + 6] = f.north[2]; d[o + 7] = q.top;
    d[o + 8] = f.up[0]; d[o + 9] = f.up[1]; d[o + 10] = f.up[2]; d[o + 11] = 0;
    d.set(q.box, o + 12);
    d.set(n * CUT_FLOATS < q.data.length ? q.data.subarray(0, n * CUT_FLOATS) : q.data, o + CUT_HEADER);
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
    pass.setBindGroup(0, this.frame.bindGroup);
    pass.setBindGroup(2, this.imagery.bindGroup);
    pass.setBindGroup(3, this.vector.bindGroup);
    // Those nothing reaches into first (fs), then those with others' pieces (fsMeet).
    const offsets = this.offsets;
    for (const meet of [false, true]) {
      let set = false;
      for (let i = 0; i < this.draws.length; i++) {
        if ((this.meetSlots[i] !== 0) !== meet) continue;
        if (!set) { pass.setPipeline(meet ? this.meetPipeline : this.pipeline); set = true; }
        const m = this.draws[i];
        offsets[0] = i * SLOT_STRIDE;
        offsets[1] = this.meetSlots[i] * CUT_SLOT_BYTES;
        pass.setBindGroup(1, this.slots, offsets);
        pass.setVertexBuffer(0, m.vbuf);
        pass.setIndexBuffer(m.ibuf, 'uint32');
        pass.drawIndexed(m.indexCount);
      }
    }
    pass.end();
  }
}

let meetIds = 0;
