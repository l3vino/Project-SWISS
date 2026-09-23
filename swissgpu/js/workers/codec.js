/* codec.js — a decode thread.
 *
 * Fetches bytes and turns them into things the GPU can take. Results go back
 * as transferable buffers, so nothing is copied on the way out.
 *
 * Each of these threads holds its own wasm instance and therefore its own
 * heap, which is why the arena can be reset wholesale at the start of every
 * job instead of freeing anything.
 */

import { Endpoint } from '../core/rpc.js';
import { instantiateCore } from '../core/wasm.js';

const rpc = new Endpoint(self, 'codec');
let core = null;

rpc.on('init', ({ wasmModule }) => {
  core = instantiateCore(wasmModule);
  const failure = core.selftest();
  if (failure !== 0) throw new Error(`wasm core self-test failed with code ${failure}`);
  return { version: core.version, capacity: core.capacity, name: self.name };
});

/**
 * Fetch one Quantized Mesh tile and decode it into GPU-ready buffers.
 *
 * An absent tile is an ordinary answer here, not an error: coverage is ragged
 * at every border and the caller wants "no tile" without an exception. Object
 * stores answer 403 rather than 404 for a key that is not there, since
 * admitting the difference would leak what the bucket contains, so both mean
 * the same thing to us.
 */
rpc.on('terrain-tile', async ({ url, rect }) => {
  const response = await fetch(url);
  if (response.status === 404 || response.status === 403 || response.status === 204) {
    return { missing: true };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 92) return { missing: true };

  core.reset();
  const src = core.write(bytes);
  const resultOffset = core.alloc(core.exports.qm_result_size());

  const status = core.exports.qm_decode(
    src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north, resultOffset);
  // The decoder grows the arena, which detaches every view we were holding.
  core.sync();
  if (status !== 0) throw new Error(`quantized mesh decode failed (${status})`);

  const r = new DataView(core.buffer, resultOffset, 88);
  const vertexCount = r.getUint32(64, true);
  const indexCount = r.getUint32(68, true);
  const vertexOffset = r.getUint32(72, true);
  const indexOffset = r.getUint32(76, true);
  const indexIsU32 = r.getUint32(80, true) === 1;

  // slice() copies out of wasm memory into buffers we can hand over.
  const vertices = core.buffer.slice(vertexOffset, vertexOffset + vertexCount * 24);

  // A 16-bit index count is odd whenever the triangle count is, which makes the
  // byte length two short of a multiple of four, and writeBuffer rejects that
  // outright. Round up here rather than at the call site: the arena pads every
  // allocation to sixteen bytes, so the extra bytes are inside this same block,
  // and drawIndexed still uses the true count.
  const indexBytes = (indexCount * (indexIsU32 ? 4 : 2) + 3) & ~3;
  const indices = core.buffer.slice(indexOffset, indexOffset + indexBytes);

  return {
    vertices, indices, indexCount, indexIsU32,
    origin: [r.getFloat64(0, true), r.getFloat64(8, true), r.getFloat64(16, true)],
    radius: r.getFloat64(48, true),
    minHeight: r.getFloat32(56, true),
    maxHeight: r.getFloat32(60, true),
    $transfer: [vertices, indices],
  };
});

/** Round-trips a buffer through wasm memory to prove transfers are zero-copy. */
rpc.on('echo', ({ bytes }) => {
  core.reset();
  const off = core.write(new Uint8Array(bytes));
  const out = core.u8.slice(off, off + bytes.byteLength).buffer;
  return { bytes: out, used: core.used, $transfer: [out] };
});

rpc.on('status', () => ({
  name: self.name,
  used: core?.used ?? 0,
  capacity: core?.capacity ?? 0,
}));

// Handlers are registered, so this thread can be given work.
rpc.announce();
