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
 * Lines a source models as tubes (cable cars: the adapter's `lines` rules)
 * are taken back to lines here (lines.js) and come out as ropes and pylons
 * (the pylons' steel members drawn the same way as the ropes) for the
 * cables pass; their tubes are neither drawn nor solid.
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
import { tubeAxes, ropeGeometry } from './lines.js';
import { exactCopy } from '../core/buffer-pool.js';

const HIDDEN = 15;
const HIDDEN_KINDS = 1 << HIDDEN;

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
 * @param copy      makes the typed arrays that are handed over (a decode
 *                  thread's pooled buffers, core/buffer-pool.js); whatever is
 *                  kept for collision is copied exactly instead
 */
export async function decodeFeatureTile(core, buffer, { transform, upAxis = 'Y', frame, attributes = {}, solid = false, copy = exactCopy }) {
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
  const lines = lineFeatures(attributes.lines, batchTable, batchBinary, featureCount, types);
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

  // Tubes that are lines: their axes, as ropes and pylons, before anything
  // else is allocated (which could move wasm memory under the view).
  let cables = null;
  if (lines) {
    core.sync();
    cables = extractLines(core.f32.subarray(localOff / 4, localOff / 4 + vertexCount * 3), features, indices, lines);
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
  if (lines) for (let f = 0; f < featureCount; f++) if (lines[f]) kinds[f] = HIDDEN;
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
  // Nothing left to draw as a mesh (a tile of cable cars only): no vertices.
  const drawn = kept > 0 ? finalCount : 0;
  // A tile with a collision grid keeps its triangles on the render thread.
  const out = grid ? exactCopy : copy;
  const vertices = out(core.u8.subarray(vertexOff, vertexOff + drawn * BUILDING_VERTEX_BYTES));
  // writeBuffer wants multiples of four bytes; the arena's padding covers it.
  const indexBytes = (kept * (narrow ? 2 : 4) + 3) & ~3;
  const indexBuffer = out(core.u8.subarray(idxOutOff, idxOutOff + indexBytes));
  const recordsOut = copy(records);
  if (cables) {
    cables.ropes = copy(cables.ropes);
    cables.pylons = copy(cables.pylons);
    cables.members = copy(cables.members);
  }

  const transfer = [vertices.buffer, indexBuffer.buffer, recordsOut.buffer];
  if (grid) transfer.push(grid.cellStart, grid.cellTris);
  if (cables) transfer.push(cables.ropes.buffer, cables.pylons.buffer, cables.members.buffer);
  return {
    vertices, indices: indexBuffer, vertexCount: drawn, indexCount: kept, indexFormat: narrow ? 'uint16' : 'uint32',
    origin: Array.from(origin), east: Array.from(east), north: Array.from(north), up: Array.from(up),
    boxMin: bounds.slice(0, 3), boxMax: bounds.slice(3, 6),
    encoding, features: featureCount, typesSeen,
    records: recordsOut,
    solid: grid,
    cables,
    $transfer: transfer,
  };
}

/*
 * Which features are lines modelled as tubes, by the adapter's rules
 * ({ radius, unless, keep, styles, default }): a positive `radius` column
 * value and nothing in the `unless` column, and not a type listed in `keep`.
 * Returns, per feature, null or { radius, style }; null if there are none.
 */
function lineFeatures(spec, table, binary, count, types) {
  if (!spec?.radius) return null;
  const radius = batchColumn(table, binary, spec.radius, count);
  if (!radius) return null;
  const unless = spec.unless ? batchColumn(table, binary, spec.unless, count) : null;
  let out = null;
  for (let f = 0; f < count; f++) {
    const r = Number(radius[f]);
    if (!(r > 0) || (unless && unless[f] != null)) continue;
    const type = types ? Number(types[f]) : NaN;
    if (spec.keep?.includes(type)) continue;
    (out ??= new Array(count).fill(null))[f] = { radius: r, style: spec.styles?.[type] ?? spec.default ?? {} };
  }
  return out;
}

/* The ropes and pylons of every line feature: each feature's vertices and
 * triangles gathered from all primitives (a tube's spheres and cylinders
 * can be separate ones), its axes found, its style applied. */
function extractLines(positions, features, indices, lines) {
  const vertices = new Map(), triangles = new Map();
  for (let v = 0; v < features.length; v++) {
    const f = features[v];
    if (!lines[f]) continue;
    let list = vertices.get(f);
    if (!list) vertices.set(f, (list = []));
    list.push(v);
  }
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const f = features[indices[t]];
    if (!lines[f]) continue;
    let list = triangles.get(f);
    if (!list) triangles.set(f, (list = []));
    list.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  const out = { ropes: [], pylons: [], members: [] };
  for (const [f, list] of vertices) {
    ropeGeometry(tubeAxes(positions, list, triangles.get(f) ?? [], lines[f].radius), lines[f].style, out);
  }
  if (!out.ropes.length) return null;
  return { ropes: new Float32Array(out.ropes), pylons: new Float32Array(out.pylons), members: new Float32Array(out.members) };
}
