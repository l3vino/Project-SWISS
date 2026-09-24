/* mock-data.mjs — stand-ins for the remote services, for offline verification.
 *
 * Never loaded by the app. The verification rig uses these to answer the
 * requests the app would send to swisstopo, so the real code paths run end to
 * end on a machine that cannot reach the network. Terrain is synthetic but
 * well-formed: every tile is a genuine Quantized Mesh 1.0 file, encoded the
 * way the specification describes, over a height field that is continuous
 * across tile borders.
 */

import { geodeticToEcef, enuBasis, radiiAt, DEG } from '../js/core/math.js';

/* The real body served by 3d.geo.admin.ch, captured from the live service. */
export const LAYER_JSON = {
  attribution: '', bounds: [-180, -90, 180, 90], description: '',
  extensions: ['metadata', 'octvertexnormals'], format: 'quantized-mesh-1.0',
  maxzoom: 18, metadataAvailability: 10, minzoom: 0, name: '', projection: 'EPSG:4326',
  scheme: 'tms', tiles: ['20250101/{z}/{x}/{y}.terrain?v={version}'], version: '1.43646.0',
};

/* Swiss coverage, matching the adapter's bounds, so the border behaviour is real. */
const COVER = { west: 5.75, south: 45.7, east: 10.6, north: 47.9 };

/* Photos stop at the country's own extent, inside those bounds, the way the
 * real service returns blank tiles for the margin of its bounding box. */
const PHOTO_COVER = { west: 5.95, south: 45.82, east: 10.49, north: 47.81 };

/* The deepest level exists only west of this longitude, so the app has to
 * notice from the tiles' own availability metadata that it stops there, and
 * keep the coarser tile drawn over the rest. */
export const FINEST_WEST_OF = 8.75;
const MAX_LEVEL = LAYER_JSON.maxzoom;

/* Tile index ranges intersecting a rectangle at one level, rows from the south. */
function tileRange(z, rect) {
  const nx = 2 << z, ny = 1 << z;
  const clampX = (v) => Math.max(0, Math.min(nx - 1, v)), clampY = (v) => Math.max(0, Math.min(ny - 1, v));
  return {
    startX: clampX(Math.floor(((rect.west + 180) / 360) * nx)),
    endX: clampX(Math.ceil(((rect.east + 180) / 360) * nx) - 1),
    startY: clampY(Math.floor(((rect.south + 90) / 180) * ny)),
    endY: clampY(Math.ceil(((rect.north + 90) / 180) * ny) - 1),
  };
}

/** Which tiles this stand-in has: the covered area at every level, the finest only in part. */
function coverageAt(z) {
  if (z > MAX_LEVEL) return null;
  return tileRange(z, z === MAX_LEVEL ? { ...COVER, east: FINEST_WEST_OF } : COVER);
}

export function tileExists(z, x, y) {
  const r = coverageAt(z);
  return Boolean(r) && x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY;
}

/* The metadata a tile at a multiple of ten carries: which tiles of its own
 * subtree exist, for each of the next ten levels. */
function availabilityBelow(z, x, y) {
  const out = [];
  for (let level = z + 1; level <= z + LAYER_JSON.metadataAvailability; level++) {
    const r = coverageAt(level);
    const s = level - z;
    const sub = { startX: x << s, endX: ((x + 1) << s) - 1, startY: y << s, endY: ((y + 1) << s) - 1 };
    if (!r) { out.push([]); continue; }
    const cut = {
      startX: Math.max(r.startX, sub.startX), endX: Math.min(r.endX, sub.endX),
      startY: Math.max(r.startY, sub.startY), endY: Math.min(r.endY, sub.endY),
    };
    out.push(cut.startX <= cut.endX && cut.startY <= cut.endY ? [cut] : []);
  }
  return out;
}

/* Cesium's octahedral encoding into two bytes, for the normals extension. */
function octEncode8(nx, ny, nz) {
  const l = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  let x = nx / l, y = ny / l;
  if (nz < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const toByte = (v) => Math.round((Math.max(-1, Math.min(1, v)) * 0.5 + 0.5) * 255);
  return [toByte(x), toByte(y)];
}

/* The height field's true normal at a point, in earth-centred coordinates,
 * with slopes measured in real metres so it matches the mesh built from it. */
function normalAt(lon, lat) {
  const e = 1e-5;
  const { meridian, primeVertical } = radiiAt(lat);
  const dhdE = (height(lon + e, lat) - height(lon - e, lat)) / (2 * e * DEG * primeVertical * Math.cos(lat * DEG));
  const dhdN = (height(lon, lat + e) - height(lon, lat - e)) / (2 * e * DEG * meridian);
  const { east, north, up } = enuBasis(lon, lat);
  const n = [0, 1, 2].map((i) => -dhdE * east[i] - dhdN * north[i] + up[i]);
  const l = Math.hypot(...n);
  return n.map((v) => v / l);
}

/** A plausible alpine height field in metres: valleys near 200 m, ridges near 3000 m. */
export function height(lon, lat) {
  const x = (lon - 8.8) * 77000, y = (lat - 46.2) * 111000;   // metres from Locarno, roughly
  const ridge = 1 - Math.abs(Math.sin(x / 5200) * Math.cos(y / 6100));
  const hills = 0.5 + 0.5 * Math.sin(x / 1300 + y / 1700) * Math.cos(y / 900 - x / 2300);
  return 210 + 2400 * ridge * ridge + 380 * hills;
}

/* ---- the stand-in town ---------------------------------------------------- */
/* Houses on a regular grid near Locarno. The building service
 * (mock-buildings.mjs) models them in 3D, and the aerial photos below show
 * their roofs from above as real photos do, so a roof textured from the photo
 * shows at a glance whether the projection lines up. */
export const TOWN = { west: 8.78, south: 46.155, east: 8.82, north: 46.185 };
export const TOWN_SPACING = 60;               // metres between house centres
export const HOUSE_HALF = { east: 6, north: 5 };
const TOWN_M_LAT = 111132;
const TOWN_M_LON = 111320 * Math.cos((46.17 * Math.PI) / 180);

export function townGrid() {
  return {
    cols: Math.floor(((TOWN.east - TOWN.west) * TOWN_M_LON) / TOWN_SPACING),
    rows: Math.floor(((TOWN.north - TOWN.south) * TOWN_M_LAT) / TOWN_SPACING),
  };
}

/** The centre of house (i, j) of the grid. */
export function houseCentre(i, j) {
  return {
    lon: TOWN.west + ((i + 0.5) * TOWN_SPACING) / TOWN_M_LON,
    lat: TOWN.south + ((j + 0.5) * TOWN_SPACING) / TOWN_M_LAT,
  };
}

/** Whether a point lies under a house's roof, seen from straight above. */
export function roofAt(lon, lat) {
  const { cols, rows } = townGrid();
  const i = Math.floor(((lon - TOWN.west) * TOWN_M_LON) / TOWN_SPACING);
  const j = Math.floor(((lat - TOWN.south) * TOWN_M_LAT) / TOWN_SPACING);
  if (i < 0 || j < 0 || i >= cols || j >= rows) return false;
  const c = houseCentre(i, j);
  return Math.abs((lon - c.lon) * TOWN_M_LON) <= HOUSE_HALF.east &&
         Math.abs((lat - c.lat) * TOWN_M_LAT) <= HOUSE_HALF.north;
}

const tileRect = (z, x, y) => {
  const w = 360 / (2 << z), h = 180 / (1 << z);
  const west = -180 + x * w, south = -90 + y * h;
  return { west, south, east: west + w, north: south + h };
};

/**
 * Encode one tile, or return null where the real service would have nothing.
 * `n` vertices per side on a regular grid, which is a valid (if unambitious)
 * triangulated irregular network. Every tile carries per-vertex normals, and
 * every tenth level its subtree's availability, the way swisstopo's do.
 */
export function encodeTerrainTile(z, x, y, n = 17) {
  if (!tileExists(z, x, y)) return null;
  const r = tileRect(z, x, y);

  const hs = [];
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h = height(r.west + (i / (n - 1)) * (r.east - r.west), r.south + (j / (n - 1)) * (r.north - r.south));
    hs.push(h); minH = Math.min(minH, h); maxH = Math.max(maxH, h);
  }
  if (maxH - minH < 1) maxH = minH + 1;

  const Q = 32767;
  const u = [], v = [], hq = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    u.push(Math.round((i / (n - 1)) * Q));
    v.push(Math.round((j / (n - 1)) * Q));
    hq.push(Math.round(((hs[j * n + i] - minH) / (maxH - minH)) * Q));
  }
  const gridTris = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    gridTris.push(a, b, c, b, d, c);
  }

  // High-water-mark encoding only works if vertices are numbered in the order
  // the index list first mentions them, which is what the specification
  // requires of real tiles. Renumber the grid to match.
  const order = new Int32Array(n * n).fill(-1);
  let next = 0;
  for (const k of gridTris) if (order[k] < 0) order[k] = next++;
  const permute = (arr) => { const out = new Array(arr.length); arr.forEach((val, k) => { out[order[k]] = val; }); return out; };
  const tris = gridTris.map((k) => order[k]);
  const [pu, pv, ph] = [permute(u), permute(v), permute(hq)];
  u.length = v.length = hq.length = 0;
  u.push(...pu); v.push(...pv); hq.push(...ph);

  const midLon = (r.west + r.east) / 2, midLat = (r.south + r.north) / 2;
  const centre = geodeticToEcef(midLon, midLat, (minH + maxH) / 2);
  let radius = 0;
  for (const lon of [r.west, r.east]) for (const lat of [r.south, r.north]) for (const hh of [minH, maxH]) {
    const p = geodeticToEcef(lon, lat, hh);
    radius = Math.max(radius, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]));
  }

  const zig = (arr) => { let prev = 0; return arr.map((val) => { const d = val - prev; prev = val; return ((d << 1) ^ (d >> 31)) & 0xffff; }); };
  const highWater = (idx) => { let hi = 0; return idx.map((val) => { const code = hi - val; if (code === 0) hi++; return code; }); };
  // The edge lists must be in grid order: the decoder sorts them anyway.
  const edges = [
    [...u.keys()].filter((k) => u[k] === 0),
    [...u.keys()].filter((k) => v[k] === 0),
    [...u.keys()].filter((k) => u[k] === Q),
    [...u.keys()].filter((k) => v[k] === Q),
  ];

  // Normals for the vertices in their final order, from the height field
  // itself rather than the mesh, as a service derives them from its full model.
  const octs = u.map((uq, k) => {
    const lon = r.west + (uq / Q) * (r.east - r.west), lat = r.south + (v[k] / Q) * (r.north - r.south);
    return octEncode8(...normalAt(lon, lat));
  });
  const metadata = z % LAYER_JSON.metadataAvailability === 0
    ? Buffer.from(JSON.stringify({ available: availabilityBelow(z, x, y) }))
    : null;

  const vCount = n * n;
  let size = 88 + 4 + vCount * 6;
  size += size % 2;                         // indices are 16-bit aligned
  size += 4 + tris.length * 2;
  for (const e of edges) size += 4 + e.length * 2;
  size += 5 + vCount * 2;
  if (metadata) size += 5 + 4 + metadata.length;

  const buf = Buffer.alloc(size);
  let o = 0;
  const f64 = (val) => { buf.writeDoubleLE(val, o); o += 8; };
  const f32 = (val) => { buf.writeFloatLE(val, o); o += 4; };
  const u32 = (val) => { buf.writeUInt32LE(val, o); o += 4; };
  const u16 = (val) => { buf.writeUInt16LE(val, o); o += 2; };
  const u8 = (val) => { buf.writeUInt8(val, o); o += 1; };

  f64(centre[0]); f64(centre[1]); f64(centre[2]);
  f32(minH); f32(maxH);
  f64(centre[0]); f64(centre[1]); f64(centre[2]); f64(radius);
  f64(0); f64(0); f64(0);                   // horizon occlusion point, unused by the app
  u32(vCount);
  for (const arr of [zig(u), zig(v), zig(hq)]) for (const val of arr) u16(val);
  o += o % 2;
  u32(tris.length / 3);
  for (const code of highWater(tris)) u16(code);
  for (const e of edges) { u32(e.length); for (const k of e) u16(k); }
  // Extension 1: oct-encoded normals, two bytes a vertex.
  u8(1); u32(vCount * 2);
  for (const [a, b] of octs) { u8(a); u8(b); }
  // Extension 4: metadata, a length-prefixed JSON document.
  if (metadata) { u8(4); u32(4 + metadata.length); u32(metadata.length); metadata.copy(buf, o); o += metadata.length; }
  return buf.subarray(0, o);
}

/* ---- imagery ------------------------------------------------------------ */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require(process.env.SHARP_MODULE || '/home/claude/.npm-global/lib/node_modules/sharp');

/* The deepest zoom the stand-in serves. Anything finer answers 400, the way a
 * WMTS answers a zoom outside its matrix set, so the clipmap's handling of a
 * level that does not exist gets exercised on every run. */
export const IMAGERY_MAX_ZOOM = 19;

let blankTile = null;
const imageryCache = new Map();

/**
 * A synthetic aerial photo for one XYZ tile: coloured by the same height field
 * the terrain is built from, textured with stable noise, and overlaid with a
 * geographic grid every 0.01°. If imagery lands where it should, snow sits on
 * the peaks, and the grid lines run straight across tile and level borders.
 *
 * Returns { status, body }. Outside the covered area it serves a blank white
 * JPEG, the way many services fill tiles they have no data for.
 */
export async function encodeImageryTile(z, x, y) {
  if (z > IMAGERY_MAX_ZOOM) return { status: 400, body: Buffer.alloc(0) };
  const key = `${z}/${x}/${y}`;
  if (imageryCache.has(key)) return imageryCache.get(key);

  const n = 2 ** z;
  const lonOf = (px) => (px / (256 * n)) * 360 - 180;
  const latOf = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / (256 * n)))) * 180) / Math.PI;

  const west = lonOf(x * 256), east = lonOf((x + 1) * 256);
  const north = latOf(y * 256), south = latOf((y + 1) * 256);
  if (east < PHOTO_COVER.west || west > PHOTO_COVER.east || north < PHOTO_COVER.south || south > PHOTO_COVER.north) {
    blankTile ??= await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } }).jpeg({ quality: 80 }).toBuffer();
    return { status: 200, body: blankTile };
  }

  const raw = Buffer.alloc(256 * 256 * 3);
  const gridStep = 0.01;
  for (let j = 0; j < 256; j++) {
    const lat = latOf(y * 256 + j + 0.5);
    const latNext = latOf(y * 256 + j + 1.5);
    for (let i = 0; i < 256; i++) {
      const lon = lonOf(x * 256 + i + 0.5);
      const lonNext = lonOf(x * 256 + i + 1.5);
      const h = height(lon, lat);

      // Valley green, forest, rock, snow.
      let r, g, b;
      if (h < 700) { r = 72; g = 104; b = 52; }
      else if (h < 1600) { r = 44; g = 72; b = 38; }
      else if (h < 2500) { r = 128; g = 118; b = 104; }
      else { r = 236; g = 239; b = 243; }

      // Stable noise, keyed on the pixel's position at zoom 20, so every zoom
      // shows the same ground rather than new noise per level.
      const wx = Math.floor(((lon + 180) / 360) * 268435456);
      const wy = Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * 268435456);
      let s = (wx * 73856093) ^ (wy * 19349663);
      s = (s ^ (s >>> 13)) * 1274126177;
      const noise = ((s >>> 0) % 25) - 12;

      // A line wherever a pixel crosses a multiple of 0.01 degrees.
      const onGrid = Math.floor(lon / gridStep) !== Math.floor(lonNext / gridStep) ||
                     Math.floor(lat / gridStep) !== Math.floor(latNext / gridStep);
      // Clay-red roofs where the stand-in town's houses are.
      if (roofAt(lon, lat)) { r = 168; g = 64; b = 44; }
      const k = (j * 256 + i) * 3;
      if (onGrid) { raw[k] = 20; raw[k + 1] = 20; raw[k + 2] = 26; }
      else {
        raw[k] = Math.max(0, Math.min(255, r + noise));
        raw[k + 1] = Math.max(0, Math.min(255, g + noise));
        raw[k + 2] = Math.max(0, Math.min(255, b + noise));
      }
    }
  }
  const body = await sharp(raw, { raw: { width: 256, height: 256, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
  const result = { status: 200, body };
  imageryCache.set(key, result);
  return result;
}
