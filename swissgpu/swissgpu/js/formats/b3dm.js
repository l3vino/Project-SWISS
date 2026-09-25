/* b3dm.js — the Batched 3D Model container from 3D Tiles 1.0.
 *
 * A 28-byte header, a feature table with values for the whole tile (how many
 * buildings it holds, an optional centre its coordinates are relative to), a
 * batch table with one row of attributes per building, and then the geometry
 * as binary glTF.
 *
 * Two header layouts from before 3D Tiles 1.0 are still found in the wild.
 * They are recognised the way Cesium recognises them: where a byte length
 * should be, their bytes read as a number far too large to be one, because
 * what is actually there is the start of JSON or of the glTF magic.
 */

const MAGIC = 0x6d643362;          // 'b3dm', little-endian
const LEGACY_THRESHOLD = 570425344; // 0x22000000: ASCII read as a length

const text = new TextDecoder();

function readJson(bytes, offset, length) {
  if (!length) return null;
  // Tables are padded with spaces, which JSON.parse ignores.
  return JSON.parse(text.decode(bytes.subarray(offset, offset + length)));
}

/**
 * @param {ArrayBuffer} buffer  the whole tile
 * @returns {{ batchLength, featureTable, featureTableBinary, batchTable, batchTableBinary, glb }}
 */
export function parseB3dm(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('not a b3dm tile');
  const version = view.getUint32(4, true);
  if (version !== 1) throw new Error(`b3dm version ${version} is not supported`);
  const byteLength = Math.min(view.getUint32(8, true), buffer.byteLength);

  let ftJson = view.getUint32(12, true);
  let ftBin = view.getUint32(16, true);
  let btJson = view.getUint32(20, true);
  let btBin = view.getUint32(24, true);
  let offset = 28;
  let batchLength = null;

  if (btJson >= LEGACY_THRESHOLD) {
    // [batchLength] [batchTableByteLength]
    offset = 20;
    batchLength = ftJson;
    btJson = ftBin;
    btBin = 0;
    ftJson = ftBin = 0;
  } else if (btBin >= LEGACY_THRESHOLD) {
    // [batchTableJsonByteLength] [batchTableBinaryByteLength] [batchLength]
    offset = 24;
    batchLength = btJson;
    btJson = ftJson;
    btBin = ftBin;
    ftJson = ftBin = 0;
  }

  const featureTable = readJson(bytes, offset, ftJson) || { BATCH_LENGTH: batchLength ?? 0 };
  offset += ftJson;
  const featureTableBinary = bytes.subarray(offset, offset + ftBin);
  offset += ftBin;
  const batchTable = readJson(bytes, offset, btJson);
  offset += btJson;
  const batchTableBinary = bytes.subarray(offset, offset + btBin);
  offset += btBin;

  if (byteLength - offset <= 0) throw new Error('b3dm tile holds no glTF');
  return {
    batchLength: featureTable.BATCH_LENGTH ?? batchLength ?? 0,
    featureTable,
    featureTableBinary,
    batchTable,
    batchTableBinary,
    glb: bytes.subarray(offset, byteLength),
  };
}

/**
 * A feature table value, stored inline as JSON or as a reference into the
 * binary body. `count` values of `components` floats come back as an array.
 */
export function featureTableFloats(table, binary, name, components) {
  const entry = table?.[name];
  if (entry == null) return null;
  if (Array.isArray(entry)) return entry.map(Number);
  if (typeof entry.byteOffset === 'number') {
    const view = new DataView(binary.buffer, binary.byteOffset + entry.byteOffset, components * 4);
    return Array.from({ length: components }, (_, i) => view.getFloat32(i * 4, true));
  }
  return null;
}

const COMPONENT_READERS = {
  BYTE: ['getInt8', 1], UNSIGNED_BYTE: ['getUint8', 1],
  SHORT: ['getInt16', 2], UNSIGNED_SHORT: ['getUint16', 2],
  INT: ['getInt32', 4], UNSIGNED_INT: ['getUint32', 4],
  FLOAT: ['getFloat32', 4], DOUBLE: ['getFloat64', 8],
};

/**
 * One batch table column, one value per feature, whether it is stored as a
 * JSON array or as scalars in the binary body. Null if absent.
 */
export function batchColumn(table, binary, name, count) {
  const column = table?.[name];
  if (column == null) return null;
  if (Array.isArray(column)) return column;
  const reader = COMPONENT_READERS[column.componentType];
  if (!reader || typeof column.byteOffset !== 'number' || column.type !== 'SCALAR') return null;
  const [method, size] = reader;
  const view = new DataView(binary.buffer, binary.byteOffset + column.byteOffset, count * size);
  return Array.from({ length: count }, (_, i) => view[method](i * size, true));
}
