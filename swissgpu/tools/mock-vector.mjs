/* mock-vector.mjs — a stand-in for swisstopo's vector tiles
 * (ch.swisstopo.base.vt), for the verification rig and the decoder tests.
 *
 * Never loaded by the app. Every tile is a genuine Mapbox Vector Tile 2.1
 * (protobuf, extent 4096, a 32-unit buffer of the neighbours' ground, lines
 * clipped to it), with the transportation layer's fields as the real service
 * names them and a building layer, over a made-up network round the stand-in
 * town near Locarno (mock-data.mjs):
 *   - its streets every 60 m between the houses, minor, every tenth
 *     tertiary or secondary, the middle one primary, each cut at every
 *     junction the way the real tiles cut them (the decoder joins them);
 *   - a double tram track down one street;
 *   - a double-track railway south of the town with a tunnel (layer -1) and
 *     a bridge (layer 1), and a siding beside it;
 *   - a motorway north of it, one line per carriageway, one-way each, and a
 *     ramp down to the main street;
 *   - a road over the stand-in bridge (mock-buildings.mjs, BRIDGE), on it;
 *   - a mountain path with steps, a footway and an unpaved track.
 * The same features at every zoom, as base.vt has them at 13 and 14.
 *
 * And swisstopo's identify service for the landscape model's roads over
 * the same network (identifyAnswer): every road with a width class, every
 * third street of the grid the 3 m class (drawn 3.5 m), the others the 4 m
 * class (5.2 m), the main streets wider; answers capped at 200 rows like
 * the real one.
 */

import { gzipSync } from 'node:zlib';
import { mercX, mercY } from '../js/engine/imagery/mercator.js';
import { TOWN, townGrid, houseCentre, HOUSE_HALF } from './mock-data.mjs';
import { BRIDGE } from './mock-buildings.mjs';

export const VECTOR_TILEJSON_HOST = 'vectortiles.geo.admin.ch';
export const VECTOR_PATH = '/tiles/ch.swisstopo.base.vt/v1.0.0/';
export const VECTOR_TILEJSON = {
  tilejson: '2.0.0', name: 'Basiskarte_v1.0.0 (stand-in)', format: 'pbf', scheme: 'xyz', minzoom: 0, maxzoom: 14,
  bounds: [3.57, 44.18, 13.66, 48.88],
  tiles: [0, 1, 2, 3, 4].map((i) => `https://vectortiles${i}.geo.admin.ch${VECTOR_PATH}{z}/{x}/{y}.pbf`),
};

const EXTENT = 4096, BUFFER = 32;
const M_LAT = 111132;
const M_LON = 111320 * Math.cos((46.17 * Math.PI) / 180);
/* Metres east and north of the town's south-west corner, to degrees. */
const at = (e, n) => [TOWN.west + e / M_LON, TOWN.south + n / M_LAT];
const STREET = 60;

/* ---- the network, in metres from the town's corner ----------------------- */

/* The railway's line and where its tunnel and bridge are (metres east), for the tests. */
export const RAIL = { north: -700, spacing: 4.5, from: -5000, to: 8000, tunnel: [4000, 5500], bridge: [-2000, -1800] };
export const MOTORWAY = { north: 3600, spacing: 14, from: -5000, to: 8000 };
export const TRAM_STREET = 20;

/* swissTLM3D's width classes (OBJEKTART) the stand-in roads have. */
const TLM = { minor: 10, narrow: 11, tertiary: 10, secondary: 9, primary: 8, motorway: 2, footway: 16, path: 15, steps: 16, track: 11 };

/** Every line feature: { points: [[e, n]...], tags, tlm (its width class in the landscape model) }. Built once. */
export const NETWORK = buildNetwork();

function buildNetwork() {
  const out = [];
  const add = (points, tags, tlm = TLM[tags.subclass === 'steps' ? 'steps' : tags.class]) => out.push({ points, tags, tlm });
  const { cols, rows } = townGrid();
  const width = cols * STREET, height = rows * STREET;
  // Streets, one feature per block, as the real tiles cut them at junctions.
  for (let i = 0; i <= cols; i++) {
    const cls = i === Math.floor(cols / 2) ? 'primary' : i % 10 === 0 ? 'secondary' : 'minor';
    const tlm = cls === 'minor' && i % 3 === 1 ? TLM.narrow : TLM[cls];
    for (let j = 0; j < rows; j++) add([[i * STREET, j * STREET], [i * STREET, (j + 1) * STREET]], { class: cls, surface: 'paved' }, tlm);
  }
  for (let j = 0; j <= rows; j++) {
    const cls = j % 10 === 0 ? 'tertiary' : 'minor';
    const tlm = cls === 'minor' && j % 3 === 1 ? TLM.narrow : TLM[cls];
    for (let i = 0; i < cols; i++) add([[i * STREET, j * STREET], [(i + 1) * STREET, j * STREET]], { class: cls, surface: 'paved' }, tlm);
  }
  // Two tram tracks down one street, a stop's length apart.
  for (const side of [-1.6, 1.6]) {
    for (let e = 0; e < width; e += 3 * STREET) {
      add([[e, TRAM_STREET * STREET + side], [Math.min(width, e + 3 * STREET), TRAM_STREET * STREET + side]], { class: 'transit', subclass: 'tram' });
    }
  }
  // The railway: two tracks, cut where a tunnel or a bridge starts and ends.
  const R = RAIL;
  const marks = [R.from, R.bridge[0], R.bridge[1], R.tunnel[0], R.tunnel[1], R.to];
  for (const n of [R.north, R.north - R.spacing]) {
    for (let k = 0; k + 1 < marks.length; k++) {
      const a = marks[k], b = marks[k + 1];
      const tags = { class: 'rail', subclass: 'rail' };
      if (a === R.tunnel[0]) Object.assign(tags, { brunnel: 'tunnel', layer: -1 });
      if (a === R.bridge[0]) Object.assign(tags, { brunnel: 'bridge', layer: 1 });
      // Long stretches in pieces of 400 m, as long features are in the real tiles.
      for (let e = a; e < b; e += 400) add([[e, n], [Math.min(b, e + 400), n]], tags);
    }
  }
  // A siding south of the tracks, leaving and joining them.
  const s = R.north - R.spacing;
  add([[1000, s], [1060, s - 6], [1540, s - 6], [1600, s]], { class: 'rail', subclass: 'rail', service: 'siding' });
  // The motorway: each carriageway one way, the northern one westwards.
  const M = MOTORWAY;
  for (let e = M.from; e < M.to; e += 500) {
    add([[Math.min(M.to, e + 500), M.north + M.spacing], [e, M.north + M.spacing]], { class: 'motorway', oneway: 1, surface: 'paved' });
    add([[e, M.north], [Math.min(M.to, e + 500), M.north]], { class: 'motorway', oneway: 1, surface: 'paved' });
  }
  // Its ramp down to the main street.
  const main = Math.floor(cols / 2) * STREET;
  add([[main, M.north], [main + 20, M.north - 100], [main, height]], { class: 'motorway', ramp: 1, oneway: 1, surface: 'paved' });
  // The road over the bridge, the deck its middle part.
  const be = (BRIDGE.start.lon - TOWN.west) * M_LON, bn = (BRIDGE.start.lat - TOWN.south) * M_LAT;
  add([[be - 80, bn], [be, bn]], { class: 'secondary', surface: 'paved' });
  add([[be, bn], [be + BRIDGE.length, bn]], { class: 'secondary', surface: 'paved', brunnel: 'bridge', layer: 1 });
  add([[be + BRIDGE.length, bn], [be + BRIDGE.length + 80, bn]], { class: 'secondary', surface: 'paved' });
  // Up the hill from the north-east corner: a path, with steps on the way.
  add([[width, height], [width + 120, height + 160]], { class: 'path', sac_scale: 'hiking' });
  add([[width + 120, height + 160], [width + 150, height + 200]], { class: 'path', subclass: 'steps' });
  add([[width + 150, height + 200], [width + 400, height + 600], [width + 380, height + 900]], { class: 'path', sac_scale: 'mountain_hiking' });
  // A footway across a block, and an unpaved track out west.
  add([[2 * STREET, 2 * STREET], [3 * STREET, 3 * STREET]], { class: 'footway' });
  add([[0, 25 * STREET], [-600, 26 * STREET], [-1500, 28 * STREET]], { class: 'track', surface: 'unpaved' });
  return out;
}

/* ---- tiles ------------------------------------------------------------------ */

/* A point in tile units (not rounded), y down. */
function project(lonLat, z, x, y) {
  const n = 2 ** z;
  return [(mercX(lonLat[0]) * n - x) * EXTENT, (mercY(lonLat[1]) * n - y) * EXTENT];
}

/* Liang–Barsky: the part of a-b inside the square [lo, hi]², or null. */
function clip(a, b, lo, hi) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy], q = [a[0] - lo, hi - a[0], a[1] - lo, hi - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1], t0 > 0, t1 < 1];
}

/* A line's pieces inside the tile and its buffer, in whole units. */
function clipLine(points, z, x, y) {
  const lo = -BUFFER, hi = EXTENT + BUFFER;
  const pts = points.map((p) => project(at(p[0], p[1]), z, x, y));
  const runs = [];
  let run = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const c = clip(pts[i], pts[i + 1], lo, hi);
    if (!c) { run = null; continue; }
    const [a, b, cutA, cutB] = c;
    if (!run || cutA) { run = []; runs.push(run); run.push(a.map(Math.round)); }
    run.push(b.map(Math.round));
    if (cutB) run = null;
  }
  // Points that rounded together are one.
  return runs.map((r) => r.filter((p, k) => k === 0 || p[0] !== r[k - 1][0] || p[1] !== r[k - 1][1])).filter((r) => r.length >= 2);
}

/* The houses' footprints, as the building layer's polygons. */
function buildings(z, x, y) {
  const { cols, rows } = townGrid();
  const out = [];
  const lo = -BUFFER, hi = EXTENT + BUFFER;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const c = houseCentre(i, j);
      const de = HOUSE_HALF.east / M_LON, dn = HOUSE_HALF.north / M_LAT;
      const ring = [[c.lon - de, c.lat - dn], [c.lon + de, c.lat - dn], [c.lon + de, c.lat + dn], [c.lon - de, c.lat + dn]]
        .map((p) => project(p, z, x, y).map(Math.round));
      if (ring.every((p) => p[0] < lo || p[0] > hi || p[1] < lo || p[1] > hi)) continue;
      out.push(ring);
    }
  }
  return out;
}

/* ---- the protobuf --------------------------------------------------------------- */

class Writer {
  constructor() { this.bytes = []; }
  varint(v) {
    while (v > 127) { this.bytes.push((v % 128) | 128); v = Math.floor(v / 128); }
    this.bytes.push(v);
  }
  key(field, wire) { this.varint(field * 8 + wire); }
  message(field, write) {
    const inner = new Writer();
    write(inner);
    this.key(field, 2);
    this.varint(inner.bytes.length);
    for (const b of inner.bytes) this.bytes.push(b);
  }
  string(field, text) {
    const b = Buffer.from(String(text), 'utf8');
    this.key(field, 2); this.varint(b.length);
    for (const c of b) this.bytes.push(c);
  }
  packed(field, values) {
    const inner = new Writer();
    for (const v of values) inner.varint(v);
    this.key(field, 2); this.varint(inner.bytes.length);
    for (const b of inner.bytes) this.bytes.push(b);
  }
}

const zz = (v) => (v < 0 ? -2 * v - 1 : 2 * v);
const command = (id, count) => (id & 7) | (count << 3);

/* A geometry's commands: lines (MoveTo, LineTo) or rings (and ClosePath). */
function geometry(parts, rings) {
  const out = [];
  let cx = 0, cy = 0;
  for (const pts of parts) {
    out.push(command(1, 1), zz(pts[0][0] - cx), zz(pts[0][1] - cy));
    cx = pts[0][0]; cy = pts[0][1];
    out.push(command(2, pts.length - 1));
    for (let i = 1; i < pts.length; i++) {
      out.push(zz(pts[i][0] - cx), zz(pts[i][1] - cy));
      cx = pts[i][0]; cy = pts[i][1];
    }
    if (rings) out.push(command(7, 1));
  }
  return out;
}

/* One layer: { name, features: [{ type, tags, parts }] }. */
function writeLayer(w, layer) {
  w.message(3, (l) => {
    l.key(15, 0); l.varint(2);
    l.string(1, layer.name);
    const keys = [], values = [], keyAt = new Map(), valueAt = new Map();
    const tagList = (tags) => {
      const out = [];
      for (const [k, v] of Object.entries(tags)) {
        if (!keyAt.has(k)) { keyAt.set(k, keys.length); keys.push(k); }
        const vk = `${typeof v}:${v}`;
        if (!valueAt.has(vk)) { valueAt.set(vk, values.length); values.push(v); }
        out.push(keyAt.get(k), valueAt.get(vk));
      }
      return out;
    };
    layer.features.forEach((f, i) => {
      const tags = tagList(f.tags);
      l.message(2, (m) => {
        m.key(1, 0); m.varint(i + 1);
        m.packed(2, tags);
        m.key(3, 0); m.varint(f.type);
        m.packed(4, geometry(f.parts, f.type === 3));
      });
    });
    for (const k of keys) l.string(3, k);
    for (const v of values) {
      l.message(4, (m) => {
        if (typeof v === 'number') { m.key(6, 0); m.varint(zz(v)); }
        else m.string(1, v);
      });
    }
    l.key(5, 0); l.varint(EXTENT);
  });
}

/**
 * One tile: its bytes, and the body to serve. Every third tile's body is
 * gzipped without saying so, which some services do and the decode thread
 * has to notice. A tile away from the network has no transportation layer
 * at all, as the real ones in the mountains have none.
 */
export function encodeVectorTile(z, x, y) {
  const transportation = [];
  for (const f of NETWORK) {
    for (const run of clipLine(f.points, z, x, y)) transportation.push({ type: 2, tags: f.tags, parts: [run] });
  }
  const houses = buildings(z, x, y).map((ring) => ({ type: 3, tags: { class: 'building' }, parts: [ring] }));
  const w = new Writer();
  // A layer the decoder must skip unread, first, as the real tiles have many.
  writeLayer(w, { name: 'landcover', features: [{ type: 3, tags: { class: 'grass' }, parts: [[[0, 0], [EXTENT, 0], [EXTENT, EXTENT], [0, EXTENT]]] }] });
  if (houses.length) writeLayer(w, { name: 'building', features: houses });
  if (transportation.length) writeLayer(w, { name: 'transportation', features: transportation });
  const bytes = Uint8Array.from(w.bytes);
  return { bytes, gzipped: (x + y) % 3 === 0, body: (x + y) % 3 === 0 ? gzipSync(bytes) : bytes, lines: transportation.length };
}

/* ---- the identify service ----------------------------------------------------- */

export const IDENTIFY_HOST = 'api3.geo.admin.ch';
export const IDENTIFY_PATH = '/rest/services/api/MapServer/identify';

/**
 * The landscape model's roads in the rectangle an identify call asks for
 * (geometry=w,s,e,n), as the real service answers them (GeoJSON, one row a
 * road, its OBJEKTART), at most 200 rows; null for any other call.
 */
export function identifyAnswer(url) {
  if (url.host !== IDENTIFY_HOST || url.pathname !== IDENTIFY_PATH) return null;
  if (!/swisstlm3d-strassen/.test(url.searchParams.get('layers') || '')) return null;
  const [w, s, e, n] = String(url.searchParams.get('geometry') || '').split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite)) return { status: 400, body: '{}' };
  const results = [];
  NETWORK.forEach((f, id) => {
    if (!f.tlm || results.length >= 200) return;
    const pts = f.points.map((p) => at(p[0], p[1]));
    // In the rectangle if any of its pieces' boxes meets it.
    const meets = pts.some((p, k) => k > 0 && Math.max(p[0], pts[k - 1][0]) >= w && Math.min(p[0], pts[k - 1][0]) <= e &&
      Math.max(p[1], pts[k - 1][1]) >= s && Math.min(p[1], pts[k - 1][1]) <= n);
    if (!meets) return;
    results.push({ type: 'Feature', featureId: 1000 + id, layerBodId: 'ch.swisstopo.swisstlm3d-strassen',
      geometry: { type: 'MultiLineString', coordinates: [pts.map((p) => [Number(p[0].toFixed(6)), Number(p[1].toFixed(6))])] },
      properties: { objektart: f.tlm } });
  });
  return { status: 200, body: JSON.stringify({ results }) };
}
