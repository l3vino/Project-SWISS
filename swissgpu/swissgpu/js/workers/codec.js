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
import { decodeFeatureTile } from '../formats/tile-content.js';

const rpc = new Endpoint(self, 'codec');
const decoder = new TextDecoder();
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
rpc.on('terrain-tile', async ({ url, rect, skirt, accept }) => {
  let response = await fetch(url, accept ? { headers: { accept } } : undefined);
  // A server that will not negotiate the extension list still has the tile;
  // ask plainly, and tell the caller to stop asking for extensions.
  const acceptRejected = response.status === 406 && Boolean(accept);
  if (acceptRejected) response = await fetch(url);
  if (response.status === 404 || response.status === 403 || response.status === 204) {
    return { missing: true, acceptRejected };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 92) return { missing: true, acceptRejected };

  core.reset();
  const src = core.write(bytes);
  const resultSize = core.exports.qm_result_size();
  const resultOffset = core.alloc(resultSize);

  const status = core.exports.qm_decode(
    src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north, skirt || 0, resultOffset);
  // The decoder grows the arena, which detaches every view we were holding.
  core.sync();
  if (status !== 0) throw new Error(`quantized mesh decode failed (${status})`);

  const r = new DataView(core.buffer, resultOffset, resultSize);
  const vertexCount = r.getUint32(64, true);
  const indexCount = r.getUint32(68, true);
  const vertexOffset = r.getUint32(72, true);
  const indexOffset = r.getUint32(76, true);
  const indexIsU32 = r.getUint32(80, true) === 1;

  // The metadata extension is JSON; only its location comes back from C.
  // What matters in it is which finer tiles exist below this one.
  let available = null;
  const metaLength = r.getUint32(92, true);
  if (metaLength > 0) {
    try {
      const text = decoder.decode(core.u8.subarray(r.getUint32(88, true), r.getUint32(88, true) + metaLength));
      available = JSON.parse(text).available ?? null;
    } catch (err) {
      console.warn(`[codec] unreadable tile metadata in ${url}: ${err.message}`);
    }
  }

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
    serverNormals: r.getUint32(96, true) === 1,
    available,
    acceptRejected,
    $transfer: [vertices, indices],
  };
});

/**
 * The lookup data physics needs to stand on a tile: its quantized vertices,
 * its triangles, and a grid that finds the triangle under a point quickly.
 * Built from the same bytes the renderer drew, fetched again by URL with the
 * same headers, which the HTTP cache normally answers without the network.
 */
rpc.on('terrain-ground', async ({ url, accept }) => {
  const response = await fetch(url, accept ? { headers: { accept } } : undefined);
  if (response.status === 404 || response.status === 403 || response.status === 204) {
    return { missing: true };
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());

  core.reset();
  const src = core.write(bytes);
  const resultOffset = core.alloc(core.exports.qm_ground_size());
  const status = core.exports.qm_ground(src, bytes.byteLength, resultOffset);
  core.sync();
  if (status !== 0) throw new Error(`ground index failed (${status})`);

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
});

/* ---- 3D Tiles ---------------------------------------------------------- */

/**
 * One 3D Tiles tile (b3dm or glb) into packed building vertices; see
 * js/formats/tile-content.js. Compressed tiles load their decoder on first use.
 */
rpc.on('feature-tile', async ({ url, transform, upAxis, frame, attributes, solid }) => {
  const response = await fetch(url);
  if (response.status === 404 || response.status === 403 || response.status === 204) return { missing: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return decodeFeatureTile(core, await response.arrayBuffer(), { transform, upAxis, frame, attributes, solid });
});

/* ---- imagery ---------------------------------------------------------- */

/* A uniform tile compresses to almost nothing, so only suspiciously small
 * files are looked at closely. Real photos of Switzerland rarely get this
 * small, and when they do (a lake, fresh snow) they are not pure white or
 * pure black, which is what a service's "nothing here" placeholder is. */
const BLANK_CANDIDATE_BYTES = 6000;
let probeCanvas = null;

async function isBlank(blob) {
  const tiny = await createImageBitmap(blob, { resizeWidth: 8, resizeHeight: 8, resizeQuality: 'low' });
  probeCanvas ??= new OffscreenCanvas(8, 8);
  const ctx = probeCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(tiny, 0, 0);
  tiny.close();
  const px = ctx.getImageData(0, 0, 8, 8).data;
  let lo = 255, hi = 0, sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = px[i + c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
  }
  const mean = sum / 192;
  return hi - lo <= 6 && (mean >= 245 || mean <= 8);
}

/**
 * Fetch one imagery tile and decode it here, off the render thread. The
 * result is an ImageBitmap, which moves to the render thread without a copy
 * and goes straight to the GPU from there.
 *
 * Anything that is not a picture of the ground comes back as `missing`: a
 * 4xx (outside the service's grid or coverage) or a blank placeholder.
 */
rpc.on('imagery-tile', async ({ url, size }) => {
  const response = await fetch(url);
  if ((response.status >= 400 && response.status < 500) || response.status === 204) return { missing: true };
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size === 0) return { missing: true };
  if (blob.size < BLANK_CANDIDATE_BYTES && await isBlank(blob)) return { missing: true };

  const bitmap = await createImageBitmap(blob, {
    resizeWidth: size, resizeHeight: size,
    premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  return { bitmap, $transfer: [bitmap] };
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
