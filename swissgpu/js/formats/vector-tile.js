/* vector-tile.js — one Mapbox Vector Tile into a block the GPU can search.
 *
 * Runs on a decode thread. The heavy part is C (wasm/src/mvt.c): the
 * protobuf, the joins, the cuts at the tile's edge, the grid. Here the
 * adapter's plain description of its layer (e.g. adapters/swisstopo-
 * transport.js) becomes the binary tables the C reads (the schema, made
 * once per thread), and the finished block is copied out for the render
 * thread, which uploads it as it is.
 *
 * The block's layout (all little-endian, 16-byte aligned sections; the
 * shaders read it as u32 words, js/engine/shaders/vector.wgsl):
 *   header    16 words (BLOCK below)
 *   cells     grid × grid words: first reference << 8 | count (lowest
 *             drawing priority first)
 *   refs      u16 segment numbers
 *   segments  8 words each: a.x, a.y, b.x, b.y in tile units, the length
 *             along the line at a and at b in metres (the dash phase),
 *             attributes (ATTR), and the line and its ends (LINK)
 *   lines     4 words each: first segment, count, length, flags | kind << 8
 *   density   density × density bytes, buildings per cell
 */

const encoder = new TextEncoder();

/* Header word offsets. */
export const BLOCK = {
  MAGIC: 0x31425456, VERSION: 1, HEADER_BYTES: 64, SEGMENT_WORDS: 8, LINE_WORDS: 4,
  magic: 0, version: 1, segmentCount: 2, lineCount: 3, grid: 4, cellsOff: 5, refsOff: 6, refCount: 7,
  segmentsOff: 8, linesOff: 9, densityOff: 10, density: 11, metresPerUnit: 12, extent: 13, zoom: 14, dropped: 15,
};

/* A segment's attribute word. */
export const ATTR = {
  kind: (a) => a & 63, brunnel: (a) => (a >>> 6) & 3, layer: (a) => ((a >>> 8) & 15) - 8,
  surface: (a) => (a >>> 12) & 3, oneway: (a) => (a >>> 14) & 3, ramp: (a) => (a >>> 16) & 1,
  service: (a) => (a >>> 17) & 7, sac: (a) => (a >>> 20) & 7, flags: (a) => (a >>> 23) & 15, town: (a) => (a >>> 27) & 1,
};
export const BRUNNEL = { none: 0, bridge: 1, tunnel: 2, ford: 3 };

/* A segment's link word. */
export const LINK = {
  line: (l) => l & 0xffff, degreeA: (l) => (l >>> 16) & 7, degreeB: (l) => (l >>> 19) & 7,
  cutA: (l) => (l >>> 22) & 1, cutB: (l) => (l >>> 23) & 1, endA: (l) => (l >>> 24) & 1, endB: (l) => (l >>> 25) & 1,
};

const ROLES = ['class', 'subclass', 'brunnel', 'layer', 'surface', 'service', 'oneway', 'ramp', 'sac'];
/* The schema word holding the town threshold, set per tile for its zoom. */
const SCHEMA_TOWN = 11;
const FAMILIES = { road: 1, rail: 2, other: 3 };

/**
 * The adapter's description as numbered tables: class and subclass names
 * with their codes, which kind each pair is (first matching rule), and each
 * kind's properties (kind 0 is "not drawn"). Also what the render thread
 * needs to know about kinds (the debug view's colours).
 */
export function schemaTables(schema) {
  const classes = [''], subclasses = [''];
  const add = (list, name) => { if (name != null && !list.includes(name)) list.push(name); };
  for (const k of schema.kinds) { add(classes, k.class); add(subclasses, k.subclass); }
  for (const name of Object.keys(schema.flags || {})) add(subclasses, name);
  const C = classes.length, S = subclasses.length;
  const kindTable = new Uint8Array(C * S);
  for (let c = 1; c < C; c++) {
    for (let s = 0; s < S; s++) {
      const i = schema.kinds.findIndex((k) => (k.class == null || k.class === classes[c]) &&
        (k.subclass == null || k.subclass === subclasses[s]));
      kindTable[c * S + s] = i < 0 ? 0 : i + 1;
    }
  }
  // A rule with only a subclass (steps) matches whatever class it comes on.
  for (let s = 1; s < S; s++) {
    const i = schema.kinds.findIndex((k) => k.class == null && k.subclass === subclasses[s]);
    if (i < 0) continue;
    for (let c = 1; c < C; c++) kindTable[c * S + s] = i + 1;
  }
  const subFlags = new Uint8Array(S);
  for (const [name, bit] of Object.entries(schema.flags || {})) subFlags[subclasses.indexOf(name)] = bit & 15;
  const kinds = [{ id: 'none', half: 0, priority: 0, family: 0, colour: '#000000', width: 0, material: null, bench: 0, grade: 1, shape: false, gauge: 0 },
    ...schema.kinds.map((k) => ({
      id: k.id, half: k.half ?? 2, priority: k.priority ?? 0, family: FAMILIES[k.family] ?? 3, colour: k.colour ?? '#ffffff',
      // Drawn and shaped (5.15b): see the adapter's schema.
      width: k.width ?? 0, material: k.material ?? null, bench: k.bench ?? 0, grade: k.grade ?? 1,
      shape: k.shape ?? Boolean(k.material), gauge: k.gauge ?? 0,
    }))];
  return { classes, subclasses, kindTable, kinds, subFlags };
}

/** The binary schema mvt.c reads (see Schema there). */
export function schemaBlob(schema) {
  const t = schemaTables(schema);
  const parts = [];
  let size = 64;
  const reserve = (bytes) => { const at = size; size += (bytes + 3) & ~3; return at; };
  const strings = [];
  const str = (text) => {
    const bytes = encoder.encode(String(text));
    const at = reserve(4 + bytes.length);
    strings.push([at, bytes]);
    return at;
  };
  const fields = [];
  for (const role of ROLES) {
    const name = schema.fields?.[role];
    if (!name) continue;
    let values = [];
    if (role === 'class') values = t.classes.slice(1).map((n, i) => [n, i + 1]);
    else if (role === 'subclass') values = t.subclasses.slice(1).map((n, i) => [n, i + 1]);
    else if (schema.values?.[role]) values = Object.entries(schema.values[role]);
    fields.push({ name, role: ROLES.indexOf(role), values });
  }
  const layerName = str(schema.layer);
  const densityName = schema.density?.layer ? str(schema.density.layer) : 0;
  const fieldsOff = reserve(fields.length * 16);
  for (const f of fields) {
    f.nameOff = str(f.name);
    f.valuesOff = reserve(f.values.length * 8);
    f.valueOffs = f.values.map(([n, code]) => [str(n), code]);
  }
  const kindTableOff = reserve(t.kindTable.length);
  const kindsOff = reserve(t.kinds.length * 8);
  const subFlagsOff = reserve(t.subFlags.length);

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const w = (off, v) => dv.setUint32(off, v >>> 0, true);
  w(0, 0x5354564D); w(4, layerName); w(8, densityName); w(12, fields.length); w(16, fieldsOff);
  w(20, t.classes.length); w(24, t.subclasses.length); w(28, kindTableOff);
  w(32, t.kinds.length); w(36, kindsOff); w(40, subFlagsOff);
  w(SCHEMA_TOWN * 4, Math.round((schema.density?.town ?? 0) * 10));
  fields.forEach((f, i) => {
    const o = fieldsOff + i * 16;
    w(o, f.nameOff); w(o + 4, f.role); w(o + 8, f.values.length); w(o + 12, f.valuesOff);
    f.valueOffs.forEach(([s, code], j) => { w(f.valuesOff + j * 8, s); w(f.valuesOff + j * 8 + 4, code); });
  });
  for (const [at, bytes] of strings) { w(at, bytes.length); u8.set(bytes, at + 4); }
  u8.set(t.kindTable, kindTableOff);
  t.kinds.forEach((k, i) => {
    const o = kindsOff + i * 8;
    dv.setFloat32(o, k.half, true);
    u8[o + 4] = k.priority; u8[o + 5] = k.family; u8[o + 6] = 0; u8[o + 7] = 0;
  });
  u8.set(t.subFlags, subFlagsOff);
  return u8;
}

/** Metres across tile (z, x, y) of the Web Mercator grid, at its middle. */
export function tileMetres(z, y) {
  const n = 2 ** z;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)));
  return (40075016.686 * Math.cos(lat)) / n;
}

/**
 * How far along its line (metres, from the line's start in the tile) each
 * segment's first end is, for what needs a distance along a road (the
 * terrain under it, its bridges). The segments' own lengths (s0, s1) are
 * the dash pattern's: matched to the neighbouring tile wherever a line
 * crosses the tile's edge, so they start again there and are no distance
 * along it (a pass road's hairpin beside the edge crosses it twice, and two
 * stretches of one line had the same lengths: cut into the terrain, the one
 * took the other's heights, a hairpin's inside raised five metres).
 */
export function segmentArcs(block) {
  const u32 = new Uint32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const f32 = new Float32Array(block.buffer, block.byteOffset, block.byteLength >>> 2);
  const segs = u32[BLOCK.segmentsOff] / 4, lines = u32[BLOCK.linesOff] / 4, mpu = f32[BLOCK.metresPerUnit];
  const arcs = new Float32Array(u32[BLOCK.segmentCount]);
  for (let l = 0, n = u32[BLOCK.lineCount]; l < n; l++) {
    const first = u32[lines + l * 4], end = first + u32[lines + l * 4 + 1];
    let along = 0;
    for (let k = first; k < end; k++) {
      const o = segs + k * 8;
      arcs[k] = along;
      along += Math.hypot(f32[o + 2] - f32[o], f32[o + 3] - f32[o + 1]) * mpu;
    }
  }
  return arcs;
}

/* Schemas made on this thread, by id and revision. */
const blobs = new Map();

/**
 * @param core    this thread's wasm Core
 * @param bytes   the tile, unzipped
 * @param margin  metres a segment's cells reach beyond its widest drawing
 * @param copy    makes the array handed over (a pooled buffer)
 * @returns { block, size, stats, $transfer } — block null for a tile of no
 *          lines (stats.ms: the decoding's milliseconds)
 */
export function decodeVectorTile(core, bytes, { z, x, y, schema, margin = 2, copy = (a) => a.slice() }) {
  const start = performance.now();
  const key = `${schema.id}|${schema.revision ?? 0}`;
  let blob = blobs.get(key);
  if (!blob) blobs.set(key, (blob = schemaBlob(schema)));
  core.reset();
  const src = core.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const sch = core.write(blob);
  // The town threshold for this zoom (a coarser zoom may keep fewer buildings).
  const town = schema.density?.townByZoom?.[z] ?? schema.density?.town ?? 0;
  core.u32[sch / 4 + SCHEMA_TOWN] = Math.round(town * 10);
  const res = core.alloc(core.exports.mvt_result_size());
  const status = core.exports.mvt_decode(src, bytes.byteLength, sch, z, x, y, tileMetres(z, y), margin, res);
  core.sync();
  const r = core.u32.subarray(res / 4, res / 4 + 16);
  if (status !== 0) throw new Error(`vector tile ${z}/${x}/${y}: decode failed (${['', 'malformed', 'out of memory', 'no layer'][status] || status})`);
  const stats = { features: r[3], skipped: r[4], parts: r[5], segments: r[6], lines: r[7], refs: r[8], cuts: r[9],
    dropped: r[10], buildings: r[11], ms: 0 };
  const block = r[2] ? copy(core.u8.subarray(r[1], r[1] + r[2])) : null;
  stats.ms = performance.now() - start;
  return { block, size: block ? r[2] : 0, stats, $transfer: block ? [block.buffer] : [] };
}
