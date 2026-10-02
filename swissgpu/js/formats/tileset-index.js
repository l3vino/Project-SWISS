/* tileset-index.js — a 3D Tiles tileset file as a compact index.
 *
 * Runs on a decode thread. A tileset file is JSON describing a tree: for
 * swissBUILDINGS3D, files of 6–10 MB with tens of thousands of tiles each.
 * Parsing one and building an object per tile on the render thread cost
 * 52 + 113 ms there for one file, a visible stall; here it costs nothing the
 * picture waits for, and what crosses over is a few typed arrays, in the
 * spirit of 3D Tiles 1.1's implicit tiling (whose subtree files carry tile
 * availability as bit streams rather than JSON objects).
 *
 * Tiles are numbered breadth first, so a tile's children are consecutive:
 * `first[i]` and `count[i]` name them. Per tile:
 *   kind      bits 0–1 the bounding volume (VOLUME), bits 2–3 the content
 *             (CONTENT), bit 4 set for ADD refinement
 *   error     geometric error, metres (inherited when a tile has none)
 *   sphere    a bounding sphere, ECEF centre and radius, worked out here so
 *             culling needs no trigonometry on the render thread
 *   volumeAt  where its volume's numbers start in `volumes`: a region as
 *             west, south, east, north (degrees), lowest and highest height;
 *             a box as centre and three half-axes; a sphere as centre, radius
 *             (boxes and spheres already through the tile's transform)
 *   transformAt  its accumulated transform in `transforms` (16 numbers,
 *             column-major), or -1 for none
 *   uriAt     its content URI's bytes in `strings`, from uriAt[i] to
 *             uriAt[i + 1] (empty: no content), relative to the file
 * The render thread (features/tileset.js) makes tile objects from this only
 * when its walk first reaches them, and resolves URIs only when it asks for
 * a tile's content.
 */

import { regionBound } from '../engine/bounds.js';
import { mat4d, DEG } from '../core/math.js';

/* Bumped whenever the layout changes, so cached indexes of an older layout
 * are never read. */
export const INDEX_FORMAT = 1;

export const VOLUME = { NONE: 0, REGION: 1, BOX: 2, SPHERE: 3 };
export const CONTENT = { NONE: 0, TILE: 1, TILESET: 2 };
export const ADD = 16;

const IDENTITY = mat4d.identity();
const encoder = new TextEncoder();

/**
 * @param json       the parsed tileset file
 * @param transform  16 numbers: the transform its root continues (the
 *                   referring tile's, for a file referenced by another), or null
 * @param refine     the refinement its root inherits
 * @param geometricError  the error its root inherits
 */
export function buildIndex(json, { transform = null, refine = 'REPLACE', geometricError = 0 } = {}) {
  const root = json?.root;
  if (!root || typeof root !== 'object') throw new Error('tileset has no root tile');

  // Breadth first: every tile's children end up next to each other. Their
  // content URIs are gathered on the way, to size the string table once.
  const order = [root], parentOf = [-1], kidCount = [], uriOf = [];
  let chars = 0;
  for (let i = 0; i < order.length; i++) {
    const t = order[i], kids = t.children;
    let k = 0;
    if (Array.isArray(kids)) {
      for (let j = 0; j < kids.length; j++) {
        const c = kids[j];
        if (c && typeof c === 'object') { order.push(c); parentOf.push(i); k++; }
      }
    }
    kidCount.push(k);
    // `uri`, `url` in pre-1.0 tilesets, the first of 1.1's `contents`.
    const uri = t.content?.uri ?? t.content?.url ?? t.contents?.[0]?.uri;
    const ok = typeof uri === 'string' && uri.length > 0;
    uriOf.push(ok ? uri : null);
    if (ok) chars += uri.length;
  }
  const n = order.length;
  const kind = new Uint8Array(n);
  const error = new Float32Array(n);
  const first = new Uint32Array(n);
  const count = new Uint32Array(n);
  const sphere = new Float64Array(n * 4);
  const volumeAt = new Uint32Array(n);
  const transformAt = new Int32Array(n);
  const uriAt = new Uint32Array(n + 1);
  const volumes = new Float64Array(n * 12);
  const transforms = [];
  // UTF-8 takes at most three bytes for each UTF-16 unit.
  const text = new Uint8Array(chars * 3);
  const matrices = new Array(n);
  let used = 0, uriBytes = 0, next = 1;
  const center = new Float64Array(3);
  const rect = { west: 0, south: 0, east: 0, north: 0 };

  // The inherited transform, if any, is the root's unless it has its own.
  let base = -1, baseMatrix = null;
  if (transform) {
    baseMatrix = Float64Array.from(transform);
    base = 0;
    transforms.push(...baseMatrix);
  }
  const rootRefine = String(refine).toUpperCase() === 'ADD';

  for (let i = 0; i < n; i++) {
    const t = order[i], p = parentOf[i];
    first[i] = next;
    count[i] = kidCount[i];
    next += kidCount[i];

    error[i] = Number.isFinite(t.geometricError) ? t.geometricError : p < 0 ? geometricError : error[p];
    const add = t.refine == null ? (p < 0 ? rootRefine : (kind[p] & ADD) !== 0) : String(t.refine).toUpperCase() === 'ADD';

    // The accumulated transform: the parent's, times this tile's own.
    let m = p < 0 ? baseMatrix : matrices[p];
    let at = p < 0 ? base : transformAt[p];
    if (Array.isArray(t.transform) && t.transform.length === 16) {
      m = mat4d.multiply(m ?? IDENTITY, Float64Array.from(t.transform));
      at = transforms.length / 16;
      transforms.push(...m);
    }
    matrices[i] = m;
    transformAt[i] = at;

    // The bounding volume, and a sphere around it.
    const bv = t.boundingVolume;
    volumeAt[i] = used;
    let vk = VOLUME.NONE, radius = Infinity;
    center[0] = center[1] = center[2] = 0;
    const region = bv?.region, box = bv?.box, ball = bv?.sphere;
    if (Array.isArray(region) && region.length >= 6) {
      // Regions ignore the tile transform, as the specification says.
      rect.west = region[0] / DEG; rect.south = region[1] / DEG;
      rect.east = region[2] / DEG; rect.north = region[3] / DEG;
      volumes[used] = rect.west; volumes[used + 1] = rect.south;
      volumes[used + 2] = rect.east; volumes[used + 3] = rect.north;
      volumes[used + 4] = region[4]; volumes[used + 5] = region[5];
      used += 6;
      radius = regionBound(rect, region[4], region[5], center);
      vk = VOLUME.REGION;
    } else if (Array.isArray(box) && box.length >= 12) {
      const mm = m ?? IDENTITY;
      mat4d.transformPoint(mm, box[0], box[1], box[2], center);
      volumes[used] = center[0]; volumes[used + 1] = center[1]; volumes[used + 2] = center[2];
      let sum = 0;
      for (let a = 0; a < 3; a++) {
        const v = mat4d.transformVector(mm, box[3 + a * 3], box[4 + a * 3], box[5 + a * 3]);
        volumes[used + 3 + a * 3] = v[0]; volumes[used + 4 + a * 3] = v[1]; volumes[used + 5 + a * 3] = v[2];
        sum += v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      }
      used += 12;
      radius = Math.sqrt(sum);
      vk = VOLUME.BOX;
    } else if (Array.isArray(ball) && ball.length >= 4) {
      const mm = m ?? IDENTITY;
      mat4d.transformPoint(mm, ball[0], ball[1], ball[2], center);
      const scale = Math.max(Math.hypot(mm[0], mm[1], mm[2]), Math.hypot(mm[4], mm[5], mm[6]), Math.hypot(mm[8], mm[9], mm[10]));
      radius = ball[3] * scale;
      volumes[used] = center[0]; volumes[used + 1] = center[1]; volumes[used + 2] = center[2]; volumes[used + 3] = radius;
      used += 4;
      vk = VOLUME.SPHERE;
    }
    sphere[i * 4] = center[0];
    sphere[i * 4 + 1] = center[1];
    sphere[i * 4 + 2] = center[2];
    sphere[i * 4 + 3] = radius;

    let ck = CONTENT.NONE;
    uriAt[i] = uriBytes;
    const uri = uriOf[i];
    if (uri) {
      uriBytes += encoder.encodeInto(uri, text.subarray(uriBytes)).written;
      ck = /\.json($|[?#])/i.test(uri) ? CONTENT.TILESET : CONTENT.TILE;
    }
    kind[i] = vk | (ck << 2) | (add ? ADD : 0);
  }
  uriAt[n] = uriBytes;

  const index = {
    format: INDEX_FORMAT,
    tiles: n,
    kind, error, first, count, sphere, volumeAt, transformAt, uriAt,
    strings: text.slice(0, uriBytes),
    volumes: volumes.slice(0, used),
    transforms: Float64Array.from(transforms),
    asset: { version: json.asset?.version ?? null, gltfUpAxis: json.asset?.gltfUpAxis ?? null },
    extensionsRequired: Array.isArray(json.extensionsRequired) ? json.extensionsRequired.map(String) : [],
  };
  index.bytes = indexBytes(index);
  return index;
}

/** The buffers an index is made of, for transferring it. */
export function indexBuffers(index) {
  return [index.kind, index.error, index.first, index.count, index.sphere, index.volumeAt, index.transformAt,
    index.uriAt, index.strings, index.volumes, index.transforms].map((a) => a.buffer);
}

export function indexBytes(index) {
  let sum = 0;
  for (const b of indexBuffers(index)) sum += b.byteLength;
  return sum;
}

/** A short hash of a file's bytes (FNV-1a over at most the first and last
 * 64 KB and the length), standing in for a validator the server did not send. */
export function quickHash(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let h = 0x811c9dc5;
  const mix = (from, to) => {
    for (let i = from; i < to; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); }
  };
  const part = 65536;
  if (u8.length <= 2 * part) mix(0, u8.length);
  else { mix(0, part); mix(u8.length - part, u8.length); }
  return `${u8.length.toString(36)}-${(h >>> 0).toString(36)}`;
}
