/* codec.js — a decode thread.
 *
 * Fetches bytes and turns them into things the GPU can take. Results go back
 * as transferable buffers, so nothing is copied on the way out.
 *
 * Each of these threads holds its own wasm instance and therefore its own
 * heap, which is why the arena can be reset wholesale at the start of every
 * job instead of freeing anything.
 *
 * Every job may be called off (scheduler.js): its handler gets an
 * AbortSignal, which aborts the download; a result finished anyway is not
 * sent back (rpc.js). What a service's answer means (nothing there, try
 * again later, the file) is decided once, in core/net.js. Jobs carry the
 * Fetch Priority their class asks for: high for physics, low for preloading.
 */

import { Endpoint } from '../core/rpc.js';
import { fetchFile, fetchBytes, bodyOf } from '../core/net.js';
import { instantiateCore } from '../core/wasm.js';
import { decodeFeatureTile } from '../formats/tile-content.js';
import { decodeVectorTile } from '../formats/vector-tile.js';
import { PIECE_FLOATS } from '../engine/vector/pieces.js';
import { planBoxes, quarters, identifyUrl, readAnswer, matchWidths, segmentsHash } from '../formats/road-widths.js';
import { buildIndex, indexBuffers, quickHash, INDEX_FORMAT } from '../formats/tileset-index.js';
import { cacheGet, cachePut } from './index-cache.js';
import { BufferPool } from '../core/buffer-pool.js';
import { BUILD } from '../build.js';

const rpc = new Endpoint(self, 'codec');
const decoder = new TextDecoder();
let core = null;

/* Buffers results travel in (core/buffer-pool.js): the render thread sends
 * them back once their contents are on the GPU, and results nobody wanted
 * any more come back here too. What the render thread keeps for good (ground
 * and collision data) is copied out exactly and never comes back. */
const spare = new BufferPool();
const pooled = (source) => spare.copy(source);
rpc.on('recycle', ({ buffers }) => { for (const b of buffers) spare.give(b); });
rpc.discard = (items) => { for (const item of items) spare.give(item); };

rpc.on('init', ({ wasmModule }) => {
  core = instantiateCore(wasmModule);
  const failure = core.selftest();
  if (failure !== 0) throw new Error(`wasm core self-test failed with code ${failure}`);
  return { version: core.version, capacity: core.capacity, name: self.name, build: BUILD };
});

/**
 * Fetch one Quantized Mesh tile and decode it into GPU-ready buffers; with
 * `roads` (pieces from engine/vector/pieces.js), the roads, tracks, paths
 * and railway beds over it cut in first (wasm/src/shape.c); with `ground`,
 * also the lookup data physics stands on (see 'terrain-ground'), from the
 * same parse in the same call, so it stands on exactly these triangles.
 *
 * An absent tile is an ordinary answer here, not an error: coverage is ragged
 * at every border and the caller wants "no tile" without an exception.
 */
rpc.on('terrain-tile', async ({ url, rect, skirt, accept, priority, ground, roads }, signal) => {
  let response = await fetchFile(url, { signal, priority, headers: accept ? { accept } : undefined, pass: accept ? [406] : undefined });
  // A server that will not negotiate the extension list still has the tile;
  // ask plainly, and tell the caller to stop asking for extensions.
  const acceptRejected = response?.status === 406;
  if (acceptRejected) response = await fetchFile(url, { signal, priority });
  if (!response) return { missing: true, acceptRejected };

  const bytes = new Uint8Array(await bodyOf(response, signal));
  if (bytes.byteLength < 92) return { missing: true, acceptRejected };
  const result = decodeTerrain(bytes, rect, skirt, url, roads, ground);
  result.acceptRejected = acceptRejected;
  return result;
});

/* Road pieces into wasm memory: [offset, count]. */
function writeRoads(roads) {
  if (!roads || roads.length < PIECE_FLOATS) return [0, 0];
  return [core.write(new Uint8Array(roads.buffer, roads.byteOffset, roads.byteLength)), Math.floor(roads.length / PIECE_FLOATS)];
}

/* What shaping did (ShapeStats in wasm/src/qm.h), or null if nothing was asked. */
function shapeStats(r, at, asked) {
  if (!asked) return null;
  const u = (i) => r.getUint32(at + i * 4, true);
  return { pieces: u(1), used: u(2), skipped: u(3), vertices: u(4), triangles: u(5), addedVertices: u(6),
    addedTriangles: u(7), moved: u(8), cut: r.getFloat32(at + 36, true), fill: r.getFloat32(at + 40, true), dropped: u(11), flipped: u(12) };
}

/* A Quantized Mesh tile into 24-byte vertices and indices (wasm/src/qm.c),
 * shaped by `roads` if given, and with physics' index if `withGround`. */
function decodeTerrain(bytes, rect, skirt, url, roads = null, withGround = false) {
  const start = performance.now();
  core.reset();
  const src = core.write(bytes);
  const [roadsOff, roadCount] = writeRoads(roads);
  const groundOff = withGround ? core.alloc(core.exports.qm_ground_size()) : 0;
  const resultSize = core.exports.qm_result_size();
  const resultOffset = core.alloc(resultSize);

  const status = core.exports.qm_decode(src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north,
    skirt || 0, roadsOff, roadCount, groundOff, resultOffset);
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

  // Copied out of wasm memory into buffers that can be handed over.
  const vertices = pooled(core.u8.subarray(vertexOffset, vertexOffset + vertexCount * 24));

  // A 16-bit index count is odd whenever the triangle count is, which makes the
  // byte length two short of a multiple of four, and writeBuffer rejects that
  // outright. Round up here rather than at the call site: the arena pads every
  // allocation to sixteen bytes, so the extra bytes are inside this same block,
  // and drawIndexed still uses the true count.
  const indexBytes = (indexCount * (indexIsU32 ? 4 : 2) + 3) & ~3;
  const indices = pooled(core.u8.subarray(indexOffset, indexOffset + indexBytes));

  // The highest point over each cell of a grid on the tile, quantized like
  // its heights (qm.c, qm_tops): what a flight over it must clear.
  const side = core.exports.qm_tops_size(), topsAt = r.getUint32(100, true);
  const tops = new Uint16Array(side * side);
  tops.set(new Uint16Array(core.buffer, topsAt, side * side));

  const result = {
    vertices, indices, indexCount, indexIsU32, tops,
    origin: [r.getFloat64(0, true), r.getFloat64(8, true), r.getFloat64(16, true)],
    radius: r.getFloat64(48, true),
    minHeight: r.getFloat32(56, true),
    maxHeight: r.getFloat32(60, true),
    serverNormals: r.getUint32(96, true) === 1,
    available,
    shape: shapeStats(r, 104, roadCount > 0),
    ms: 0,
    $transfer: [vertices.buffer, indices.buffer, tops.buffer],
  };
  if (groundOff) {
    result.ground = groundOut(groundOff);
    result.$transfer.push(...result.ground.$transfer);
    delete result.ground.$transfer;
  }
  result.ms = performance.now() - start;
  return result;
}

/**
 * The lookup data physics needs to stand on a tile: its quantized vertices,
 * its triangles, and a grid that finds the triangle under a point quickly
 * (wasm/src/ground.c). Normally made with the tile itself ('terrain-tile'
 * with `ground`); this job is for a tile loaded before physics needed it,
 * fetched again by URL with the same headers, which the HTTP cache normally
 * answers without the network.
 */
rpc.on('terrain-ground', async ({ url, rect, roads, accept, priority }, signal) => {
  const bytes = await fetchBytes(url, { signal, priority, headers: accept ? { accept } : undefined });
  if (!bytes) return { missing: true };
  return groundIndex(new Uint8Array(bytes), rect, roads);
});

/* The index alone, shaped with the same pieces as the tile was drawn with. */
function groundIndex(bytes, rect, roads = null) {
  core.reset();
  const src = core.write(bytes);
  const [roadsOff, roadCount] = writeRoads(roads);
  const resultOffset = core.alloc(core.exports.qm_ground_size());
  const status = core.exports.qm_ground(src, bytes.byteLength, rect.west, rect.south, rect.east, rect.north,
    roadsOff, roadCount, resultOffset);
  core.sync();
  if (status !== 0) throw new Error(`ground index failed (${status})`);
  return groundOut(resultOffset);
}

/* Physics' index (QmGround in wasm/src/qm.h), copied out of wasm memory. */
function groundOut(resultOffset) {
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

/* ---- 3D Tiles ---------------------------------------------------------- */

/**
 * A tileset file as a compact index (formats/tileset-index.js), from the
 * IndexedDB cache when this exact file of this exact release was indexed
 * before (index-cache.js), else fetched, parsed and indexed here. `version`
 * names the release (the root file's validator); without it nothing is
 * cached. The index's own `validator` is what files it refers to should be
 * cached under.
 */
rpc.on('tileset-index', async ({ url, transform = null, refine = 'REPLACE', geometricError = 0, version = null, priority }, signal) => {
  const key = version ? `${INDEX_FORMAT}|${version}|${url}|${JSON.stringify([transform, refine, geometricError])}` : null;
  if (key) {
    const hit = await cacheGet(key);
    if (hit?.format === INDEX_FORMAT) {
      hit.cached = true;
      hit.$transfer = indexBuffers(hit);
      return hit;
    }
  }
  const response = await fetchFile(url, { signal, priority });
  if (!response) return { missing: true };
  const bytes = await bodyOf(response, signal);
  let json;
  try {
    json = JSON.parse(decoder.decode(bytes));
  } catch (err) {
    throw new Error(`unreadable tileset ${url}: ${err.message}`);
  }
  const index = buildIndex(json, { transform, refine, geometricError });
  index.validator = response.headers.get('etag') || response.headers.get('last-modified') || quickHash(bytes);
  index.cached = false;
  if (key) await cachePut(key, index);
  index.$transfer = indexBuffers(index);
  return index;
});

/**
 * One 3D Tiles tile (b3dm or glb) into packed building vertices; see
 * js/formats/tile-content.js. Compressed tiles load their decoder on first use.
 */
rpc.on('feature-tile', async ({ url, transform, upAxis, frame, attributes, solid, decks, priority }, signal) => {
  const bytes = await fetchBytes(url, { signal, priority });
  if (!bytes) return { missing: true };
  return decodeFeatureTile(core, bytes, { transform, upAxis, frame, attributes, solid, decks, copy: pooled });
});

/**
 * A collision grid (wasm/src/solid.c) over a building tile's drawn
 * triangles, read back from its GPU buffers (features/tileset.js): the same
 * grid a decode with `solid` makes, without downloading and decoding the
 * tile again. The buffers go back with it.
 */
rpc.on('solid-grid', ({ vertices, indices, vertexCount, indexCount, narrow }) => {
  core.reset();
  const vOff = core.write(new Uint8Array(vertices));
  const iOff = core.write(new Uint8Array(indices));
  const headerOff = core.alloc(core.exports.mesh_solid_size());
  const status = core.exports.mesh_solid(vOff, vertexCount, iOff, indexCount, narrow ? 1 : 0, headerOff);
  core.sync();
  if (status !== 0) throw new Error(`collision grid failed (${status})`);
  const [cells, startOff, trisOff, refs] = core.u32.subarray(headerOff / 4, headerOff / 4 + 4);
  const cellStart = core.buffer.slice(startOff, startOff + (cells * cells + 1) * 4);
  const cellTris = core.buffer.slice(trisOff, trisOff + Math.max(1, refs) * 4);
  return {
    vertices, indices, solid: { cells, cellStart, cellTris },
    $transfer: [vertices, indices, cellStart, cellTris],
  };
});

/* ---- vector tiles ------------------------------------------------------ */

/**
 * One Mapbox Vector Tile into a block of line segments and the grid that
 * finds them from a pixel (formats/vector-tile.js, wasm/src/mvt.c), for
 * engine/vector. A service normally sends its tiles gzipped with a
 * Content-Encoding the browser undoes; some send the gzip itself, which is
 * undone here. An empty answer is a tile with nothing in it, not a missing
 * one.
 */
rpc.on('vector-tile', async ({ url, z, x, y, schema, margin, priority }, signal) => {
  const response = await fetchFile(url, { signal, priority });
  if (!response) return { missing: true };
  let bytes = new Uint8Array(await bodyOf(response, signal));
  if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
  return decodeVectorTile(core, bytes, { z, x, y, schema, margin, copy: pooled });
});

/**
 * Each road's own width class for a vector tile (formats/road-widths.js):
 * the landscape model's roads over it from the identify service, CALLS_AT_ONCE
 * calls at a time, a full answer split into four; matched onto the tile's
 * segments (`segments`: their words, a copy). Kept between sessions under
 * the tile and its segments, so a visit after the first makes no calls.
 */
/* Identify calls in flight for one tile (two until Stage 5.16b: a city tile's
 * 20 calls then took 10 answers' time). */
const CALLS_AT_ONCE = 3;
rpc.on('road-widths', async ({ z, x, y, segments, count, extent, metres, rules, spec, source, priority }, signal) => {
  const tile = { z, x, y, words: new Uint32Array(segments), count, extent, metres };
  const key = `road-widths|1|${source}|${z}/${x}/${y}|${segmentsHash(tile.words)}`;
  const hit = await cacheGet(key);
  if (hit?.codes instanceof Uint8Array && hit.codes.length === count) {
    return { codes: hit.codes, matched: hit.matched ?? 0, cached: true, calls: 0, bytes: 0, $transfer: [hit.codes.buffer] };
  }
  const roads = new Map();
  const queue = planBoxes(tile, rules.matchable);
  let calls = 0, full = 0, bytes = 0;
  const next = async () => {
    while (queue.length) {
      const box = queue.shift();
      const response = await fetchFile(identifyUrl(spec, box), { signal, priority });
      calls++;
      if (!response) continue;
      const body = await bodyOf(response, signal);
      bytes += body.byteLength;
      let json;
      try { json = JSON.parse(decoder.decode(body)); } catch { continue; }
      // A full answer may have left roads out: its quarters are asked instead.
      if (readAnswer(json, spec.field, rules.classes, roads) >= spec.limit) {
        const q = quarters(box, tile);
        if (q) { full++; queue.push(...q); }
      }
    }
  };
  await Promise.all(Array.from({ length: CALLS_AT_ONCE }, next));
  const { codes, matched, asked } = matchWidths(tile, roads, rules);
  await cachePut(key, { bytes: codes.byteLength, codes, matched });
  return { codes, matched, asked, roads: roads.size, calls, full, bytes, cached: false, $transfer: [codes.buffer] };
});

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---- imagery ---------------------------------------------------------- */

/* A uniform tile compresses to almost nothing, so only suspiciously small
 * files are looked at closely. Real photos of Switzerland rarely get this
 * small, and when they do (a lake, fresh snow) they are not pure white or
 * pure black, which is what a service's "nothing here" placeholder is. */
const BLANK_CANDIDATE_BYTES = 6000;
const TILE = 256;
let tileCanvas = null;

/** Every 32nd pixel of a decoded tile: nearly one colour, and white or black? */
function isBlank(rgba) {
  let lo = 255, hi = 0, sum = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * 32) {
    for (let c = 0; c < 3; c++) {
      const v = rgba[i + c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    n += 3;
  }
  const mean = sum / n;
  return hi - lo <= 6 && (mean >= 245 || mean <= 8);
}

/**
 * Fetch one imagery tile and prepare it here, off the render thread.
 *
 * With `encode` ('bc7' or 'bc1') the tile is decoded to pixels and block-
 * compressed by the C core (wasm/src/bc.c): the render thread then only
 * copies the finished blocks into the texture, a single small write per
 * tile. Without it, the result is an ImageBitmap for GPUs that cannot sample
 * compressed textures.
 *
 * Anything that is not a picture of the ground comes back as `missing`:
 * nothing at that address (outside the service's grid or coverage, see
 * core/net.js) or a blank placeholder.
 */
rpc.on('imagery-tile', async ({ url, size, encode, priority }, signal) => {
  const response = await fetchFile(url, { signal, priority });
  if (!response) return { missing: true };
  const blob = await bodyOf(response, signal, 'blob');
  if (blob.size === 0) return { missing: true };

  const bitmap = await createImageBitmap(blob, {
    resizeWidth: size, resizeHeight: size,
    premultiplyAlpha: 'none', colorSpaceConversion: 'none',
  });
  if (!encode && blob.size >= BLANK_CANDIDATE_BYTES) return { bitmap, $transfer: [bitmap] };

  // Pixels, through a canvas kept on the CPU so reading them back is cheap.
  tileCanvas ??= new OffscreenCanvas(TILE, TILE);
  const ctx = tileCanvas.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.drawImage(bitmap, 0, 0, TILE, TILE);
  const rgba = ctx.getImageData(0, 0, TILE, TILE).data;
  if (blob.size < BLANK_CANDIDATE_BYTES && isBlank(rgba)) { bitmap.close(); return { missing: true }; }
  if (!encode) return { bitmap, $transfer: [bitmap] };
  bitmap.close();

  core.reset();
  const src = core.write(rgba);
  const blockBytes = encode === 'bc7' ? 16 : 8;
  const out = core.alloc(4096 * blockBytes);
  if (encode === 'bc7') core.exports.bc7_encode_tile(src, out);
  else core.exports.bc1_encode_tile(src, out);
  core.sync();
  const blocks = pooled(core.u8.subarray(out, out + 4096 * blockBytes));
  return { blocks, codec: encode, $transfer: [blocks.buffer] };
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
  buffers: { ...spare.stats, kept: spare.kept },
}));

// Handlers are registered, so this thread can be given work.
rpc.announce();
