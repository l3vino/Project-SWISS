/* adapter.js — the contract a country plugs into.
 *
 * An adapter is pure description: where the bytes are, what shape they are in,
 * and which coordinate system they use. It contains no fetching and no
 * decoding, so a new country is a data file rather than a code change.
 *
 * Coverage is what makes borders work. A bounding box is the cheap first test;
 * an optional `coverage` predicate refines it for countries whose shape a box
 * describes badly. `priority` breaks ties where two adapters overlap, which is
 * the normal case along a border and the reason routing happens per tile
 * rather than once per session.
 */

/** @typedef {{west:number, south:number, east:number, north:number}} Rect */

const required = ['id', 'label', 'bounds'];

export function defineAdapter(spec) {
  for (const key of required) {
    if (!(key in spec)) throw new Error(`adapter "${spec.id || '?'}" is missing ${key}`);
  }
  const [w, s, e, n] = spec.bounds;
  if (!(w < e && s < n)) throw new Error(`adapter "${spec.id}" has inverted bounds`);

  const rect = { west: w, south: s, east: e, north: n };
  const refine = spec.coverage || null;

  return Object.freeze({
    priority: 0,
    home: null,
    features: [],
    search: null,
    attribution: '',
    ...spec,
    rect,

    /** Cheap reject before any request. */
    covers(lon, lat) {
      if (lon < w || lon > e || lat < s || lat > n) return false;
      return refine ? refine(lon, lat) : true;
    },

    /** Does this adapter have anything to say about the given area? */
    intersects(r) {
      return r.west <= e && r.east >= w && r.south <= n && r.north >= s;
    },

    /** Does it have data of this kind at all? */
    provides(kind) {
      if (kind === 'feature') return this.features.length > 0;
      return Boolean(this[kind]);
    },
  });
}

/** Substitutes {z}/{x}/{y} and any extra keys into a template URL. */
export function tileUrl(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`tile template wants {${k}}`);
    return vars[k];
  });
}

export const rectIntersects = (a, b) =>
  a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
