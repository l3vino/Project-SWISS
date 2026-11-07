/* bounds.js — bounding spheres for the volumes streamed data arrives in.
 *
 * Culling tests spheres, because a sphere against a plane is one dot product.
 * The volumes themselves come in three shapes: geodetic regions (terrain tiles
 * and most 3D Tiles), oriented boxes and spheres. These turn each into a
 * sphere that is guaranteed to contain it.
 */

import { geodeticToEcef, DEG, WGS84_A, WGS84_E2 } from '../core/math.js';

const scratch = new Float64Array(3);

/**
 * A sphere around a rectangle in degrees and a height range in metres.
 * Writes the centre (absolute ECEF) into `center` and returns the radius.
 */
export function regionSphere(rect, minHeight, maxHeight, center) {
  const span = Math.max(rect.east - rect.west, rect.north - rect.south);
  if (span >= 45) {
    // Continent-sized regions: nothing tighter than the earth itself is
    // worth computing, and these are never culled anyway.
    center[0] = center[1] = center[2] = 0;
    return WGS84_A + Math.max(0, maxHeight) + 1000;
  }
  geodeticToEcef((rect.west + rect.east) / 2, (rect.south + rect.north) / 2, (minHeight + maxHeight) / 2, center);
  let radius = 0;
  for (let i = 0; i < 3; i++) {
    const lon = rect.west + (i / 2) * (rect.east - rect.west);
    for (let j = 0; j < 3; j++) {
      const lat = rect.south + (j / 2) * (rect.north - rect.south);
      for (let k = 0; k < 2; k++) {
        geodeticToEcef(lon, lat, k ? maxHeight : minHeight, scratch);
        radius = Math.max(radius, Math.hypot(scratch[0] - center[0], scratch[1] - center[1], scratch[2] - center[2]));
      }
    }
  }
  // Between sampled points the surface bulges by the sagitta of their spacing.
  return radius + WGS84_A * (1 - Math.cos((span / 4) * DEG));
}

/**
 * The same as regionSphere, ten times cheaper and a little looser: for the
 * thousands of tiles in a tileset file at once (formats/tileset-index.js).
 * The region is measured in the tangent frame at its centre: half its width
 * at the latitude nearest the equator, half its height, and half its height
 * range plus how far the earth curves away under its half-diagonal; regions
 * a few kilometres across come out within a percent of regionSphere.
 */
export function regionBound(rect, minHeight, maxHeight, center) {
  const span = Math.max(rect.east - rect.west, rect.north - rect.south);
  if (span >= 2) return regionSphere(rect, minHeight, maxHeight, center);
  const midLat = (rect.south + rect.north) / 2;
  geodeticToEcef((rect.west + rect.east) / 2, midLat, (minHeight + maxHeight) / 2, center);
  // Generous radii of curvature: the largest the ellipsoid has (at the
  // poles, a / sqrt(1 - e²)), times the height over it; the smallest (the
  // meridian's at the equator, a (1 - e²)) for how fast the surface drops.
  const r = (WGS84_A / Math.sqrt(1 - WGS84_E2) + Math.max(0, maxHeight)) * 1.0001;
  const widest = Math.min(Math.abs(rect.south), Math.abs(rect.north)) * (rect.south * rect.north > 0 ? 1 : 0);
  const halfX = 0.5 * (rect.east - rect.west) * DEG * r * Math.cos(widest * DEG);
  const halfY = 0.5 * (rect.north - rect.south) * DEG * r;
  const drop = (halfX * halfX + halfY * halfY) / (2 * WGS84_A * (1 - WGS84_E2));
  const halfZ = 0.5 * Math.max(0, maxHeight - minHeight) + drop;
  return Math.sqrt(halfX * halfX + halfY * halfY + halfZ * halfZ) * 1.001 + 0.01;
}

/** A sphere around an oriented box given as a centre and three half-axes. */
export function boxRadius(axes) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += axes[i] * axes[i];
  return Math.sqrt(sum);
}
