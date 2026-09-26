/* tile-content.js — one 3D Tiles tile into the building vertex format.
 *
 * Runs on a decode thread. Unwraps the container (b3dm, or plain glb as in
 * 3D Tiles 1.1), reads the glTF, works out the matrix that places each
 * primitive on the earth, and hands the heavy per-vertex work to the C core
 * (wasm/src/mesh.c): transform into the tile's local east-north-up frame,
 * quantise to twelve bytes a vertex, measure each building, drop hidden
 * buildings' triangles, give every wall its facing. In between, each
 * building gets its look from the adapter's rules (appearance.js), eight
 * bytes the shader reads. Tiles near the camera also get a collision grid
 * over the drawn triangles (wasm/src/solid.c), so what you bump into is
 * exactly what is drawn.
 *
 * The placement chain is the one every 3D Tiles runtime uses:
 *   tile transform × RTC centre × glTF y-up to z-up × node matrices
 * with the RTC centre taken from the feature table, or from the older
 * CESIUM_RTC glTF extension.
 */

import { parseB3dm, featureTableFloats, batchColumn } from './b3dm.js';
import { parseGlb, readMeshes } from './gltf.js';
import { mat4d, Y_UP_TO_Z_UP, X_UP_TO_Z_UP, geodeticToEcef, enuBasis } from '../core/math.js';
import { describeBuildings, METRIC } from '../engine/features/appearance.js';

const HIDDEN_KINDS = 1 << 15;

const MAGIC_B3DM = 0x6d643362;
const MAGIC_GLTF = 0x46546c67;

export const BUILDING_VERTEX_BYTES = 12;

/**
 * @param core      this thread's wasm Core (js/core/wasm.js)
 * @param buffer    the tile's bytes
 * @param transform 16 numbers, the tile's accumulated transform from tileset.json
 * @param upAxis    'Y' (glTF's own), 'Z' or 'X', from the tileset's asset
 * @param frame     { lon, lat, height }: origin of the local frame to express positions in
 * @param attributes the adapter's description of its batch table and of how
 *                  its buildings look (see adapters/swisstopo-buildings.js)
 * @param solid     also build the collision grid (see wasm/src/solid.c)
 */
export async function decodeFeatureTile(core, buffer, { transform, upAxis = 'Y', frame, attributes = {}, solid = false }) {
  const magic = new DataView(buffer).getUint32(0, true);
  let glb, featureTable = {}, featureBinary = new Uint8Array(0), batchTable = null, batchBinary = new Uint8Array(0);
  let batchLength = 0;
  if (magic === MAGIC_B3DM) {
    const b = parseB3dm(buffer);
    ({ glb, featureTable, batchTable } = b);
    featureBinary = b.featureTableBinary;
    batchBinary = b.batchTableBinary;
    batchLength = b.batchLength;
  } else if (magic === MAGIC_GLTF) {
    glb = new Uint8Array(buffer);
  } else {
    const tag = String.fromCharCode(...new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength)));
    throw new Error(`tile format "${tag}" is not supported (b3dm and glb are)`);
  }

  const { primitives, encoding, rtc: gltfRtc } = await readMeshes(parseGlb(glb));

  // tile transform × RTC centre × up-axis correction; node matrices follow.
  let placement = Float64Array.from(transform);
  const rtc = featureTableFloats(featureTable, featureBinary, 'RTC_CENTER', 3) ?? gltfRtc;
  if (rtc) placement = mat4d.multiply(placement, mat4d.translation(rtc[0], rtc[1], rtc[2]));
  const axis = upAxis === 'Z' ? null : upAxis === 'X' ? X_UP_TO_Z_UP : Y_UP_TO_Z_UP;
  if (axis) placement = mat4d.multiply(placement, axis);

  // The frame positions are expressed in: an origin and its east, north, up.
  const origin = geodeticToEcef(frame.lon, frame.lat, frame.height);
  const { east, north, up } = enuBasis(frame.lon, frame.lat);

  let vertexCount = 0, indexCount = 0, maxFeature = 0;
  for (const p of primitives) {
    vertexCount += p.positions.length / 3;
    indexCount += p.indices.length;
    if (p.featureIds) for (const id of p.featureIds) if (id > maxFeature) maxFeature = id;
  }
  const featureCount = Math.max(1, batchLength, maxFeature + 1);
  const empty = { vertexCount: 0, indexCount: 0, encoding, features: featureCount };
  if (!vertexCount || !indexCount) return empty;

  const types = attributes.type ? batchColumn(batchTable, batchBinary, attributes.type, featureCount) : null;
  const ids = attributes.id ? batchColumn(batchTable, batchBinary, attributes.id, featureCount) : null;
  // What the source calls its objects, for the console: which types a
  // layer really holds is how its rules get tuned.
  const typesSeen = types ? [...new Set(Array.from(types, String))].slice(0, 32) : [];

  /* ---- the C passes ---- */
  core.reset();
  const frameOff = core.alloc(96);
  const boundsOff = core.alloc(24);
  const localOff = core.alloc(vertexCount * 12);
  const matrixOff = core.alloc(128);
  core.sync();
  core.f64.set([...origin, ...east, ...north, ...up], frameOff / 8);
  core.f32.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], boundsOff / 4);

  const features = new Uint32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  let v = 0, i = 0;
  for (const p of primitives) {
    const count = p.positions.length / 3;
    const posOff = core.write(new Uint8Array(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength));
    core.sync();
    core.f64.set(mat4d.multiply(placement, p.matrix), matrixOff / 8);
    core.exports.mesh_transform(posOff, count, matrixOff, frameOff, localOff + v * 12, boundsOff);
    if (p.featureIds) features.set(p.featureIds, v);
    for (let k = 0; k < p.indices.length; k++) indices[i + k] = p.indices[k] + v;
    v += count;
    i += p.indices.length;
  }

  const featOff = core.write(new Uint8Array(features.buffer));
  const lowestOff = core.alloc(featureCount * 4);
  // Walls may need a few vertices of their own (mesh_facets); room for the
  // worst case, one per index.
  const capacity = vertexCount + indexCount;
  const vertexOff = core.alloc(capacity * BUILDING_VERTEX_BYTES);
  core.exports.mesh_quantize(localOff, vertexCount, boundsOff, featOff, featureCount, lowestOff, vertexOff);

  // Each building measured, then described by the adapter's rules; the
  // hidden ones are then dropped.
  const idxOff = core.write(new Uint8Array(indices.buffer));
  const metricsOff = core.alloc(featureCount * METRIC.STRIDE * 4);
  core.exports.mesh_features(localOff, vertexCount, idxOff, indexCount, featOff, featureCount, metricsOff);
  core.sync();
  const metrics = core.f32.slice(metricsOff / 4, metricsOff / 4 + featureCount * METRIC.STRIDE);
  const { records, kinds } = describeBuildings({
    count: featureCount, metrics, types, ids, frame, spec: attributes.appearance,
  });
  const kindsOff = core.write(kinds);
  const keptOff = core.alloc(indexCount * 4);
  const kept = core.exports.mesh_indices(idxOff, indexCount, featOff, featureCount, kindsOff,
    HIDDEN_KINDS, keptOff, 0);
  const claimedOff = core.alloc(capacity);
  const finalCount = core.exports.mesh_facets(localOff, vertexOff, vertexCount, capacity, keptOff, kept, claimedOff);
  const narrow = finalCount <= 65536;
  let idxOutOff = keptOff;
  if (narrow) {
    idxOutOff = core.alloc(Math.max(4, kept * 2));
    core.exports.mesh_narrow(keptOff, kept, idxOutOff);
  }

  let grid = null;
  if (solid && kept) {
    const headerOff = core.alloc(core.exports.mesh_solid_size());
    const status = core.exports.mesh_solid(vertexOff, finalCount, idxOutOff, kept, narrow ? 1 : 0, headerOff);
    core.sync();
    if (status === 0) {
      const [cells, startOff, trisOff, refs] = core.u32.subarray(headerOff / 4, headerOff / 4 + 4);
      grid = {
        cells,
        cellStart: core.buffer.slice(startOff, startOff + (cells * cells + 1) * 4),
        cellTris: core.buffer.slice(trisOff, trisOff + Math.max(1, refs) * 4),
      };
    }
  }
  core.sync();

  const bounds = Array.from(core.f32.subarray(boundsOff / 4, boundsOff / 4 + 6));
  const vertices = core.buffer.slice(vertexOff, vertexOff + finalCount * BUILDING_VERTEX_BYTES);
  // writeBuffer wants multiples of four bytes; the arena's padding covers it.
  const indexBytes = (kept * (narrow ? 2 : 4) + 3) & ~3;
  const indexBuffer = core.buffer.slice(idxOutOff, idxOutOff + indexBytes);

  return {
    vertices, indices: indexBuffer, vertexCount: finalCount, indexCount: kept, indexFormat: narrow ? 'uint16' : 'uint32',
    origin: Array.from(origin), east: Array.from(east), north: Array.from(north), up: Array.from(up),
    boxMin: bounds.slice(0, 3), boxMax: bounds.slice(3, 6),
    encoding, features: featureCount, typesSeen,
    records,
    solid: grid,
    $transfer: grid ? [vertices, indexBuffer, records.buffer, grid.cellStart, grid.cellTris]
      : [vertices, indexBuffer, records.buffer],
  };
}
