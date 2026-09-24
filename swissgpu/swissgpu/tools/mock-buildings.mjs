/* mock-buildings.mjs — a stand-in for swisstopo's building tileset.
 *
 * Never loaded by the app. Serves nested 3D Tiles the way swissBUILDINGS3D is
 * organised: a root tileset over a patch near Locarno whose four children are
 * external tilesets, each refining by REPLACE from a coarse tile (flat-roofed
 * boxes) to four detailed ones (gabled houses and the odd tower block). The
 * root refines by ADD, so both refinement modes are exercised.
 *
 * Every tile is a real b3dm: feature table with BATCH_LENGTH and RTC_CENTER,
 * a batch table with OBJEKTART and EGID as swisstopo names them, and a y-up
 * glTF 2.0 inside. Detailed tiles rotate through three encodings, plain
 * accessors, EXT_meshopt_compression and KHR_draco_mesh_compression, since
 * which one the real service uses is not documented. One building per tile is
 * marked underground and must not be drawn. Houses stand on the same height
 * field the stand-in terrain is built from.
 */

import { createRequire } from 'node:module';
import { geodeticToEcef, enuBasis, DEG } from '../js/core/math.js';
import { height, TOWN, townGrid, houseCentre, HOUSE_HALF } from './mock-data.mjs';

const require = createRequire(import.meta.url);
const GLOBAL = '/home/claude/.npm-global/lib/node_modules';
const draco3d = require(process.env.DRACO_MODULE || `${GLOBAL}/draco3dgltf`);
const { MeshoptEncoder } = await import(process.env.MESHOPT_MODULE || `${GLOBAL}/meshoptimizer/meshopt_encoder.js`);
await MeshoptEncoder.ready;
const dracoEncoder = await draco3d.createEncoderModule({});

export const BUILDINGS_PATH = '/ch.swisstopo.swissbuildings3d.3d/v1/';

/* The patch that has buildings: the stand-in town of mock-data.mjs, whose
 * roofs the stand-in aerial photos also show. */
export const AREA = TOWN;
export const ENCODINGS = ['plain', 'meshopt', 'draco'];

const quarter = (r, q) => {
  const mx = (r.west + r.east) / 2, my = (r.south + r.north) / 2;
  return {
    west: q & 1 ? mx : r.west, east: q & 1 ? r.east : mx,
    south: q & 2 ? my : r.south, north: q & 2 ? r.north : my,
  };
};
const region = (r, minH, maxH) => [r.west * DEG, r.south * DEG, r.east * DEG, r.north * DEG, minH, maxH];

/* ---- the tilesets --------------------------------------------------------- */

function rootTileset() {
  return {
    asset: { version: '1.0', gltfUpAxis: 'Y' },
    geometricError: 2000,
    root: {
      boundingVolume: { region: region(AREA, 0, 3500) },
      geometricError: 400,
      refine: 'ADD',
      children: [0, 1, 2, 3].map((q) => ({
        boundingVolume: { region: region(quarter(AREA, q), 0, 3500) },
        geometricError: 150,
        content: { uri: `sub/${q}/tileset.json` },
      })),
    },
  };
}

function subTileset(q) {
  const r = quarter(AREA, q);
  return {
    asset: { version: '1.0', gltfUpAxis: 'Y' },
    geometricError: 150,
    root: {
      boundingVolume: { region: region(r, 0, 3500) },
      geometricError: 60,
      refine: 'REPLACE',
      content: { uri: 'coarse.b3dm' },
      children: [0, 1, 2, 3].map((c) => ({
        boundingVolume: { region: region(quarter(r, c), 0, 3500) },
        geometricError: 0,
        content: { uri: `${c}.b3dm` },
      })),
    },
  };
}

/* ---- houses --------------------------------------------------------------- */

/** Houses whose centres fall inside a rectangle, on the town's grid. */
function housesIn(r) {
  const out = [];
  const { cols, rows } = townGrid();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const { lon, lat } = houseCentre(i, j);
      if (lon < r.west || lon >= r.east || lat < r.south || lat >= r.north) continue;
      const id = j * cols + i;
      out.push({ lon, lat, id, tower: id % 11 === 5 });
    }
  }
  return out;
}

/* Triangles per house: four walls of two, and a gabled roof (two slopes of
 * two, two gable ends) or a flat one of two. */
const trianglesOf = (h, detailed) => 8 + (detailed && !h.tower ? 6 : 2);

/* The one house per tile that is marked underground and must not be drawn. */
const HIDDEN_INDEX = 3;

/**
 * One house as triangles in local metres around its ground point: walls, and
 * either a gabled roof or, for towers and coarse tiles, a flat one.
 */
function houseTriangles(h, detailed) {
  const w = HOUSE_HALF.east, d = HOUSE_HALF.north;   // half footprint, east and north
  const eaves = h.tower ? 28 : 6.5;
  const ridge = detailed && !h.tower ? eaves + 4 : eaves;
  const corners = [[-w, -d], [w, -d], [w, d], [-w, d]];
  // The footprint's lowest ground, sunk a little: walls meet the terrain.
  const { east, north } = localScale(h);
  const base = Math.min(...corners.map(([x, y]) => height(h.lon + x / east, h.lat + y / north))) - 0.4;
  const tris = [];
  const P = (x, y, z) => [x, y, base + z];
  // Walls, counter-clockwise seen from outside.
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = corners[k], [bx, by] = corners[(k + 1) % 4];
    tris.push(P(ax, ay, 0), P(bx, by, 0), P(bx, by, eaves));
    tris.push(P(ax, ay, 0), P(bx, by, eaves), P(ax, ay, eaves));
  }
  if (ridge > eaves) {
    // Ridge along east-west; gable triangles on the east and west walls.
    tris.push(P(-w, -d, eaves), P(w, -d, eaves), P(w, 0, ridge));
    tris.push(P(-w, -d, eaves), P(w, 0, ridge), P(-w, 0, ridge));
    tris.push(P(w, d, eaves), P(-w, d, eaves), P(-w, 0, ridge));
    tris.push(P(w, d, eaves), P(-w, 0, ridge), P(w, 0, ridge));
    tris.push(P(w, -d, eaves), P(w, d, eaves), P(w, 0, ridge));
    tris.push(P(-w, d, eaves), P(-w, -d, eaves), P(-w, 0, ridge));
  } else {
    tris.push(P(-w, -d, eaves), P(w, -d, eaves), P(w, d, eaves));
    tris.push(P(-w, -d, eaves), P(w, d, eaves), P(-w, d, eaves));
  }
  return tris;
}

function localScale(h) {
  return { east: 111320 * Math.cos(h.lat * DEG), north: 111132 };
}

/**
 * All houses of a tile as one indexed mesh in glTF's y-up frame relative to
 * an RTC centre, one feature id per house.
 */
function tileMesh(houses, detailed, rtc) {
  const positions = [], batch = [], indices = [];
  houses.forEach((h, feature) => {
    const origin = geodeticToEcef(h.lon, h.lat, 0);
    const { east, north, up } = enuBasis(h.lon, h.lat);
    for (const [x, y, z] of houseTriangles(h, detailed)) {
      // Local metres to earth-centred, less the RTC centre ...
      const X = origin[0] + east[0] * x + north[0] * y + up[0] * (z) - rtc[0];
      const Y = origin[1] + east[1] * x + north[1] * y + up[1] * (z) - rtc[1];
      const Z = origin[2] + east[2] * x + north[2] * y + up[2] * (z) - rtc[2];
      // ... then z-up to glTF's y-up: the inverse of (x, y, z) -> (x, -z, y).
      indices.push(positions.length / 3);
      positions.push(X, Z, -Y);
      batch.push(feature);
    }
  });
  return { positions: new Float32Array(positions), batch: new Float32Array(batch), indices: new Uint32Array(indices) };
}

/* ---- glTF and b3dm -------------------------------------------------------- */

const pad4 = (n) => (n + 3) & ~3;

function glb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length), binLength = pad4(bin.length);
  const out = Buffer.alloc(12 + 8 + jsonLength + (bin.length ? 8 + binLength : 0));
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12); out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  if (bin.length) {
    const o = 20 + jsonLength;
    out.writeUInt32LE(binLength, o); out.writeUInt32LE(0x004e4942, o + 4);
    Buffer.from(bin.buffer, bin.byteOffset, bin.length).copy(out, o + 8);
  }
  return out;
}

function minMax(p) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let c = 0; c < 3; c++) {
    min[c] = Math.min(min[c], p[i + c]); max[c] = Math.max(max[c], p[i + c]);
  }
  return { min, max };
}

function concat(parts) {
  const total = parts.reduce((s, p) => s + pad4(p.byteLength), 0);
  const out = new Uint8Array(total);
  const offsets = [];
  let o = 0;
  for (const p of parts) {
    offsets.push(o);
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += pad4(p.byteLength);
  }
  return { bytes: out, offsets };
}

function gltfPlain({ positions, batch, indices }) {
  const count = positions.length / 3;
  const idx = count <= 65535 ? Uint16Array.from(indices) : indices;
  const { bytes, offsets } = concat([positions, batch, idx]);
  return glb({
    asset: { version: '2.0', generator: 'swissgpu mock' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', ...minMax(positions) },
      { bufferView: 1, componentType: 5126, count, type: 'SCALAR' },
      { bufferView: 2, componentType: idx instanceof Uint16Array ? 5123 : 5125, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: batch.byteLength, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: idx.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bytes.length }],
  }, bytes);
}

/* gltfpack's layout: compressed data in the GLB's own buffer, and a fallback
 * buffer with no data that the uncompressed views notionally live in. */
function gltfMeshopt({ positions, batch, indices }) {
  const count = positions.length / 3;
  const encoded = [
    MeshoptEncoder.encodeGltfBuffer(new Uint8Array(positions.buffer), count, 12, 'ATTRIBUTES'),
    MeshoptEncoder.encodeGltfBuffer(new Uint8Array(batch.buffer), count, 4, 'ATTRIBUTES'),
    MeshoptEncoder.encodeGltfBuffer(new Uint8Array(indices.buffer), indices.length, 4, 'TRIANGLES'),
  ];
  const { bytes, offsets } = concat(encoded);
  const plain = [positions.byteLength, batch.byteLength, indices.byteLength];
  let fallbackOffset = 0;
  const views = [12, 4, 4].map((stride, i) => {
    const view = {
      buffer: 1, byteOffset: fallbackOffset, byteLength: plain[i],
      ...(i < 2 ? { byteStride: stride } : {}),
      extensions: { EXT_meshopt_compression: {
        buffer: 0, byteOffset: offsets[i], byteLength: encoded[i].byteLength,
        byteStride: stride, count: i < 2 ? count : indices.length, mode: i < 2 ? 'ATTRIBUTES' : 'TRIANGLES',
      } },
    };
    fallbackOffset += pad4(plain[i]);
    return view;
  });
  return glb({
    asset: { version: '2.0', generator: 'swissgpu mock (meshopt)' },
    extensionsUsed: ['EXT_meshopt_compression'], extensionsRequired: ['EXT_meshopt_compression'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: 'VEC3', ...minMax(positions) },
      { bufferView: 1, componentType: 5126, count, type: 'SCALAR' },
      { bufferView: 2, componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [
      { byteLength: bytes.length },
      { byteLength: fallbackOffset, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
  }, bytes);
}

function gltfDraco({ positions, batch, indices }) {
  const m = dracoEncoder;
  const encoder = new m.Encoder(), builder = new m.MeshBuilder(), mesh = new m.Mesh();
  const points = positions.length / 3;
  builder.AddFacesToMesh(mesh, indices.length / 3, indices);
  const position = builder.AddFloatAttributeToMesh(mesh, m.POSITION, points, 3, positions);
  const feature = builder.AddFloatAttributeToMesh(mesh, m.GENERIC, points, 1, batch);
  encoder.SetAttributeQuantization(m.POSITION, 16);
  encoder.SetSpeedOptions(5, 5);
  const out = new m.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = out.GetValue(i) & 0xff;
  m.destroy(out); m.destroy(mesh); m.destroy(builder); m.destroy(encoder);
  if (!length) throw new Error('Draco encoding failed');

  return glb({
    asset: { version: '2.0', generator: 'swissgpu mock (draco)' },
    extensionsUsed: ['KHR_draco_mesh_compression'], extensionsRequired: ['KHR_draco_mesh_compression'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{
      attributes: { POSITION: 0, _BATCHID: 1 }, indices: 2, mode: 4,
      extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: position, _BATCHID: feature } } },
    }] }],
    accessors: [
      { componentType: 5126, count: points, type: 'VEC3', ...minMax(positions) },
      { componentType: 5126, count: points, type: 'SCALAR' },
      { componentType: 5125, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.length }],
    buffers: [{ byteLength: pad4(data.length) }],
  }, data);
}

/* JSON sections are padded with spaces so the next one starts 8-byte aligned. */
function paddedJson(value, start) {
  const raw = Buffer.from(JSON.stringify(value));
  const end = Math.ceil((start + raw.length) / 8) * 8;
  return Buffer.concat([raw, Buffer.alloc(end - start - raw.length, 0x20)]);
}

function b3dm(glbBytes, featureTable, batchTable) {
  const ft = paddedJson(featureTable, 28);
  const bt = paddedJson(batchTable, 28 + ft.length);
  const header = Buffer.alloc(28);
  const total = 28 + ft.length + bt.length + glbBytes.length;
  header.write('b3dm', 0, 'ascii');
  header.writeUInt32LE(1, 4); header.writeUInt32LE(total, 8);
  header.writeUInt32LE(ft.length, 12); header.writeUInt32LE(0, 16);
  header.writeUInt32LE(bt.length, 20); header.writeUInt32LE(0, 24);
  return Buffer.concat([header, ft, bt, glbBytes]);
}

function tileContent(rect, detailed, encoding) {
  const houses = housesIn(rect);
  const mid = { lon: (rect.west + rect.east) / 2, lat: (rect.south + rect.north) / 2 };
  const rtc = Array.from(geodeticToEcef(mid.lon, mid.lat, height(mid.lon, mid.lat)));
  const mesh = tileMesh(houses, detailed, rtc);
  const encode = { plain: gltfPlain, meshopt: gltfMeshopt, draco: gltfDraco }[encoding];
  const types = houses.map((h, k) => (k === HIDDEN_INDEX ? 'Unterirdisches Gebaeude' : h.tower ? 'Hochhaus' : 'Gebaeude Einzelhaus'));
  return b3dm(encode(mesh),
    { BATCH_LENGTH: houses.length, RTC_CENTER: rtc },
    { OBJEKTART: types, EGID: houses.map((h) => 190000000 + h.id) });
}

/* ---- serving ------------------------------------------------------------- */

/** Where a content path's houses are, and whether it is a detailed tile. */
function tileOf(rel) {
  let m;
  if ((m = rel.match(/^sub\/([0-3])\/coarse\.b3dm$/))) return { rect: quarter(AREA, Number(m[1])), detailed: false };
  if ((m = rel.match(/^sub\/([0-3])\/([0-3])\.b3dm$/))) {
    return { rect: quarter(quarter(AREA, Number(m[1])), Number(m[2])), detailed: true };
  }
  return null;
}

/**
 * How many triangles a content tile should draw once its underground house
 * is dropped, and how many it holds in total, for checking the decoder end
 * to end. Takes the tile's URL or path.
 */
export function expectedTriangles(url) {
  const path = new URL(url, 'https://3d.geo.admin.ch').pathname;
  const tile = path.startsWith(BUILDINGS_PATH) && tileOf(path.slice(BUILDINGS_PATH.length));
  if (!tile) return null;
  const houses = housesIn(tile.rect);
  const all = houses.reduce((s, h) => s + trianglesOf(h, tile.detailed), 0);
  const hidden = houses[HIDDEN_INDEX] ? trianglesOf(houses[HIDDEN_INDEX], tile.detailed) : 0;
  return { drawn: all - hidden, all, detailed: tile.detailed };
}

const cache = new Map();

/**
 * Answers a request path under BUILDINGS_PATH.
 * @returns {{ status, body, type, encoding? } | null}
 */
export function serveBuildings(path) {
  if (cache.has(path)) return cache.get(path);
  const rel = path.slice(BUILDINGS_PATH.length);
  let result = null;
  let m;
  const tile = tileOf(rel);
  if (rel === 'tileset.json') {
    result = { status: 200, type: 'application/json', body: JSON.stringify(rootTileset()) };
  } else if ((m = rel.match(/^sub\/([0-3])\/tileset\.json$/))) {
    result = { status: 200, type: 'application/json', body: JSON.stringify(subTileset(Number(m[1]))) };
  } else if (tile) {
    // Detailed tiles rotate through the three encodings; coarse ones are plain.
    const d = tile.detailed && rel.match(/^sub\/([0-3])\/([0-3])\.b3dm$/);
    const encoding = d ? ENCODINGS[(Number(d[1]) + Number(d[2])) % 3] : 'plain';
    result = { status: 200, type: 'application/octet-stream', encoding,
      body: tileContent(tile.rect, tile.detailed, encoding) };
  }
  if (result) cache.set(path, result);
  return result;
}
