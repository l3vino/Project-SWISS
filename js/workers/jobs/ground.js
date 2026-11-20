/* ground.js — physics' ground index of a terrain tile (wasm/src/ground.c), as any thread with the C core makes it:
 * the decode threads (workers/codec.js: with each tile physics may stand on, or alone for a tile loaded before it
 * was needed) and the tunnels' thread (workers/tunnels.js: the ground round the portals, 5.19a).
 *
 * Each function takes the thread's core (core/wasm.js instantiateCore) as its first argument; nothing here keeps
 * state between calls.
 */

import { fetchBytes } from '../../core/net.js';
import { PIECE_FLOATS } from '../../engine/vector/pieces.js';

/** Road pieces (engine/vector/pieces.js) into wasm memory: [offset, count]. */
export function writeRoads(core, roads) {
  if (!roads || roads.length < PIECE_FLOATS) return [0, 0];
  return [core.write(new Uint8Array(roads.buffer, roads.byteOffset, roads.byteLength)), Math.floor(roads.length / PIECE_FLOATS)];
}

/**
 * 'terrain-ground': the lookup data physics needs to stand on a tile (its quantized vertices, its triangles, and a
 * grid that finds the triangle under a point quickly). Normally made with the tile itself ('terrain-tile' with
 * `ground`); this job is for a tile loaded before physics needed it, fetched again by URL with the same headers,
 * which the HTTP cache normally answers without the network. { missing: true } where the service has no such tile.
 */
export async function groundJob(core, { url, rect, roads, accept, priority }, signal) {
  const bytes = await fetchBytes(url, { signal, priority, headers: accept ? { accept } : undefined });
  if (!bytes) return { missing: true };
  return groundIndex(core, new Uint8Array(bytes), rect, roads);
}

/** The index alone, shaped with the same pieces as the tile was drawn with. */
export function groundIndex(core, bytes, rect, roads = null) {
  core.reset();
  const src = core.write(bytes);
  const [roadsOff, roadCount] = writeRoads(core, roads);
  const resultOffset = core.alloc(core.exports.qm_ground_size());
  const status = core.exports.qm_ground(src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north,
    roadsOff, roadCount, resultOffset);
  core.sync();
  if (status !== 0) throw new Error(`ground index failed (${status})`);
  return groundOut(core, resultOffset);
}

/** Physics' index (QmGround in wasm/src/qm.h), copied out of wasm memory into buffers of its own (transferred). */
export function groundOut(core, resultOffset) {
  const r = new DataView(core.buffer, resultOffset, 64);
  const vertexCount = r.getUint32(8, true);
  const triangleCount = r.getUint32(12, true);
  const uvhOffset = r.getUint32(16, true);
  const indexOffset = r.getUint32(20, true);
  const indexIsU32 = r.getUint32(24, true) === 1;
  const grid = r.getUint32(28, true);
  const cellStartOffset = r.getUint32(32, true);
  const cellTrisOffset = r.getUint32(36, true);
  const cellTrisCount = r.getUint32(40, true);

  const copy = (offset, length) => core.buffer.slice(offset, offset + length);
  const uvh = copy(uvhOffset, vertexCount * 6);
  const indices = copy(indexOffset, triangleCount * 3 * (indexIsU32 ? 4 : 2));
  const cellStart = copy(cellStartOffset, (grid * grid + 1) * 4);
  const cellTris = copy(cellTrisOffset, cellTrisCount * 4);

  return {
    minHeight: r.getFloat32(0, true),
    maxHeight: r.getFloat32(4, true),
    vertexCount, triangleCount, indexIsU32, grid,
    uvh, indices, cellStart, cellTris,
    $transfer: [uvh, indices, cellStart, cellTris],
  };
}
