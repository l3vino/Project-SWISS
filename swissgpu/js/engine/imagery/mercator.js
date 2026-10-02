/* mercator.js — Web Mercator in double precision, for draping imagery.
 *
 * Imagery arrives as XYZ tiles in EPSG:3857 while terrain tiles are geodetic.
 * Rather than reprojecting any pixels, every terrain vertex is given its
 * Mercator position and the shader samples imagery there. Positions are in
 * "reference pixels": pixels of the finest imagery level, counted from an
 * anchor near the camera so they stay small enough for float32.
 *
 * Longitude maps to Mercator x linearly. Latitude does not, so across one
 * terrain tile y is fitted with a quadratic through the tile's south edge,
 * middle and north edge, computed here in doubles. Measured against the exact
 * curve at 10 cm per pixel: a z11 tile is off by 0.006 px, a z14 tile by
 * 0.00001 px, a z8 tile by about 3 px (30 cm) and a z7 tile by about 2 m.
 * The error falls with the cube of tile size, and the quadtree only draws
 * tiles that coarse tens of kilometres away, where a pixel covers more
 * ground than that. Close to the eye the fit is exact in practice.
 */

import { DEG, MERCATOR_MAX_LAT } from '../../core/math.js';

const TILE = 256;

/** Mercator x in [0, 1) from longitude in degrees. */
export const mercX = (lon) => (lon + 180) / 360;

/** Mercator y in [0, 1], 0 at the top (north), as XYZ tiles count it. */
export function mercY(lat) {
  const l = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * DEG;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / (2 * Math.PI);
}

/** Pixels per unit of Mercator at a zoom level. */
export const worldPixels = (zoom) => TILE * 2 ** zoom;

/** An XYZ tile's bounds in degrees, for routing it through the registry. */
export function xyzTileRect(z, x, y) {
  const n = 2 ** z;
  const lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) / DEG;
  return { west: lon(x), east: lon(x + 1), north: lat(y), south: lat(y + 1) };
}

/**
 * How one geodetic terrain tile maps onto the reference pixel grid, in
 * absolute pixels. Computed once per tile; the per-frame work is subtracting
 * the anchor.
 */
export function tileMapping(rect, zoom) {
  const s = worldPixels(zoom);
  const y = (lat) => mercY(lat) * s;
  const y0 = y(rect.south);                         // v = 0
  const y1 = y((rect.south + rect.north) / 2);      // v = 1/2
  const y2 = y(rect.north);                         // v = 1
  return {
    xWest: mercX(rect.west) * s,
    xSpan: (mercX(rect.east) - mercX(rect.west)) * s,
    // y(v) = y0 + b v + c v^2 through the three samples. b and c are
    // differences, so they are small and exact; only y0 needs the anchor.
    y0,
    b: -3 * y0 + 4 * y1 - y2,
    c: 2 * y0 - 4 * y1 + 2 * y2,
  };
}
