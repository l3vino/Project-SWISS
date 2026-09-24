/* gltf.js — the parts of glTF 2.0 that streamed city models use.
 *
 * Binary glTF is a JSON chunk describing accessors, meshes and a node
 * hierarchy, and a binary chunk holding the numbers. This reads every
 * triangle primitive of the default scene into flat float positions, an
 * optional feature id per vertex and 32-bit indices, each with the matrix
 * that places it. That is everything untextured geometry such as buildings
 * needs; materials and textures are ignored.
 *
 * Three ways of packing the numbers are understood:
 *   plain accessors, including KHR_mesh_quantization's integer positions;
 *   EXT_meshopt_compression, which compresses whole buffer views;
 *   KHR_draco_mesh_compression, which replaces a primitive's attributes.
 * The decoders for the last two load on first use (meshopt.js, draco.js), so
 * a service that uses neither never downloads them.
 */

import { loadMeshopt } from './meshopt.js';
import { loadDraco, decodeDraco } from './draco.js';
import { mat4d } from '../core/math.js';

const GLB_MAGIC = 0x46546c67;   // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const TYPED = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
/* Largest value of each normalised integer type. */
const NORMALIZED_MAX = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/* Where feature ids live, in the order 3D Tiles has named them over time. */
const FEATURE_ATTRIBUTES = ['_BATCHID', '_FEATURE_ID_0', 'BATCHID'];

const TRIANGLES = 4, TRIANGLE_STRIP = 5, TRIANGLE_FAN = 6;

const text = new TextDecoder();

/** Splits binary glTF into its JSON and binary chunks. */
export function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not binary glTF');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF ${version}.0 is not supported, only 2.0`);
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12, json = null, bin = null;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkType === CHUNK_JSON) json = JSON.parse(text.decode(bytes.subarray(start, start + chunkLength)));
    else if (chunkType === CHUNK_BIN) bin = bytes.subarray(start, start + chunkLength);
    offset = start + chunkLength;
  }
  if (!json) throw new Error('binary glTF without a JSON chunk');
  return { json, bin };
}

/**
 * Every triangle primitive in the default scene.
 * @returns {Promise<{ primitives: Array<{positions: Float32Array, featureIds: Uint32Array|null,
 *   indices: Uint32Array, matrix: Float64Array}>, encoding: string, rtc: number[]|null }>}
 */
export async function readMeshes({ json, bin }) {
  const used = new Set(json.extensionsUsed || []);
  const buffers = (json.buffers || []).map((b, i) => resolveBuffer(b, i, bin));
  // Load whichever decoders this file needs before touching any data, so
  // everything after is synchronous.
  const meshopt = used.has('EXT_meshopt_compression') || used.has('KHR_meshopt_compression')
    ? await loadMeshopt() : null;
  const draco = used.has('KHR_draco_mesh_compression') ? await loadDraco() : null;

  const views = viewReader(json, buffers, meshopt);
  const primitives = [];
  let quantized = false;

  for (const { primitive, matrix } of scenePrimitives(json)) {
    const mode = primitive.mode ?? TRIANGLES;
    if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) continue;
    const attrs = primitive.attributes || {};
    const featureName = FEATURE_ATTRIBUTES.find((name) => name in attrs) ?? null;
    let positions, featureIds = null, indices;

    const compressed = primitive.extensions?.KHR_draco_mesh_compression;
    if (compressed && draco) {
      const wanted = { POSITION: compressed.attributes.POSITION };
      if (featureName && featureName in compressed.attributes) wanted[featureName] = compressed.attributes[featureName];
      const decoded = decodeDraco(draco, views(compressed.bufferView).bytes, wanted);
      positions = decoded.POSITION;
      // An integer attribute comes back as its raw values; apply the
      // accessor's normalisation, if it asks for one, as plain data would.
      const accessor = json.accessors[attrs.POSITION];
      if (accessor?.normalized && NORMALIZED_MAX[accessor.componentType]) {
        const s = 1 / NORMALIZED_MAX[accessor.componentType];
        for (let i = 0; i < positions.length; i++) positions[i] = Math.max(positions[i] * s, -1);
      }
      if (featureName && decoded[featureName]) featureIds = toIds(decoded[featureName]);
      indices = decoded.indices;
    } else {
      if (attrs.POSITION === undefined) continue;
      const accessor = json.accessors[attrs.POSITION];
      if (accessor.componentType !== 5126) quantized = true;
      positions = readAccessor(json, views, attrs.POSITION, Float32Array);
      if (featureName) featureIds = toIds(readAccessor(json, views, attrs[featureName], Float32Array));
      const count = positions.length / 3;
      indices = primitive.indices !== undefined
        ? readAccessor(json, views, primitive.indices, Uint32Array)
        : Uint32Array.from({ length: count }, (_, i) => i);
    }
    if (mode !== TRIANGLES) indices = toTriangleList(indices, mode);
    primitives.push({ positions, featureIds, indices, matrix });
  }

  const encoding = draco ? 'draco' : meshopt ? 'meshopt' : quantized ? 'quantized' : 'plain';
  const rtc = json.extensions?.CESIUM_RTC?.center ?? null;
  return { primitives, encoding, rtc };
}

/* ---- buffers and accessors ------------------------------------------------ */

function resolveBuffer(buffer, index, bin) {
  if (buffer.uri === undefined) return index === 0 ? bin : null;
  const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(buffer.uri);
  if (!m) return null;   // tiles are self-contained in practice; external files are not fetched
  if (!m[1]) return new TextEncoder().encode(decodeURIComponent(m[2]));
  const raw = atob(m[2]);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* Buffer views on demand, decompressing meshopt ones once each. */
function viewReader(json, buffers, meshopt) {
  const cache = new Map();
  return (index) => {
    if (cache.has(index)) return cache.get(index);
    const v = json.bufferViews[index];
    const ext = v.extensions?.EXT_meshopt_compression ?? v.extensions?.KHR_meshopt_compression;
    let result;
    if (ext && meshopt) {
      const source = buffers[ext.buffer];
      const start = ext.byteOffset ?? 0;
      const target = new Uint8Array(ext.count * ext.byteStride);
      meshopt.decodeGltfBuffer(target, ext.count, ext.byteStride,
        source.subarray(start, start + ext.byteLength), ext.mode, ext.filter);
      result = { bytes: target, stride: ext.byteStride };
    } else {
      const source = buffers[v.buffer];
      if (!source) throw new Error(`glTF buffer ${v.buffer} is not available`);
      const start = v.byteOffset ?? 0;
      result = { bytes: source.subarray(start, start + v.byteLength), stride: v.byteStride ?? 0 };
    }
    cache.set(index, result);
    return result;
  };
}

/**
 * An accessor's values as a flat typed array of `Out` (Float32Array or
 * Uint32Array), normalised integers scaled into -1..1 or 0..1 as the
 * specification defines.
 */
function readAccessor(json, views, index, Out) {
  const a = json.accessors[index];
  const n = COMPONENTS[a.type];
  const out = new Out(a.count * n);
  if (a.bufferView === undefined) return out;   // all zeros; sparse-only accessors are not used by buildings
  if (a.sparse) console.warn('[gltf] sparse accessors are not supported; values may be wrong');

  const Typed = TYPED[a.componentType];
  const size = Typed.BYTES_PER_ELEMENT;
  const view = views(a.bufferView);
  const stride = view.stride || n * size;
  const base = view.bytes.byteOffset + (a.byteOffset ?? 0);
  const scale = a.normalized && NORMALIZED_MAX[a.componentType] ? 1 / NORMALIZED_MAX[a.componentType] : 0;

  // Tightly packed and aligned: read through a typed view, no per-value calls.
  if (stride === n * size && base % size === 0) {
    const src = new Typed(view.bytes.buffer, base, a.count * n);
    if (scale) for (let i = 0; i < src.length; i++) out[i] = Math.max(src[i] * scale, -1);
    else out.set(src);
    return out;
  }
  const dv = new DataView(view.bytes.buffer, base);
  const get = GETTERS[a.componentType];
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < n; c++) {
      const value = get(dv, i * stride + c * size);
      out[i * n + c] = scale ? Math.max(value * scale, -1) : value;
    }
  }
  return out;
}

const GETTERS = {
  5120: (d, o) => d.getInt8(o), 5121: (d, o) => d.getUint8(o),
  5122: (d, o) => d.getInt16(o, true), 5123: (d, o) => d.getUint16(o, true),
  5125: (d, o) => d.getUint32(o, true), 5126: (d, o) => d.getFloat32(o, true),
};

/* Feature ids are integers however they were stored; floats are rounded. */
function toIds(values) {
  const out = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(values[i]);
  return out;
}

function toTriangleList(indices, mode) {
  const out = [];
  for (let i = 2; i < indices.length; i++) {
    if (mode === TRIANGLE_STRIP) {
      // Every other triangle of a strip is wound the other way round.
      if (i % 2 === 0) out.push(indices[i - 2], indices[i - 1], indices[i]);
      else out.push(indices[i - 1], indices[i - 2], indices[i]);
    } else {
      out.push(indices[0], indices[i - 1], indices[i]);
    }
  }
  return Uint32Array.from(out);
}

/* ---- the node hierarchy --------------------------------------------------- */

/** Each mesh primitive of the default scene with its node's world matrix. */
function* scenePrimitives(json) {
  const nodes = json.nodes || [];
  let roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!roots) {
    // No scene: every node that is nobody's child.
    const children = new Set(nodes.flatMap((n) => n.children || []));
    roots = nodes.map((_, i) => i).filter((i) => !children.has(i));
  }
  const stack = roots.map((i) => [i, mat4d.identity()]);
  while (stack.length) {
    const [i, parent] = stack.pop();
    const node = nodes[i];
    if (!node) continue;
    const matrix = mat4d.multiply(parent, mat4d.fromNode(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh]?.primitives || []) yield { primitive, matrix };
    }
    for (const child of node.children || []) stack.push([child, matrix]);
  }
}
