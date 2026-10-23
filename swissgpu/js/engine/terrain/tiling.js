/* tiling.js — the TMS global-geodetic grid the terrain arrives on.
 *
 * Level zero is two tiles, each 180° square, covering the whole ellipsoid.
 * Every level after that halves both axes. Longitude and latitude are linear
 * in this scheme, which is the reason it pairs well with a mesh format: a
 * tile's rectangle is exact arithmetic, not a projection.
 *
 * Row order counts from the south, the TMS convention, which is the opposite
 * of the XYZ tiles used for imagery. Getting this backwards puts Switzerland
 * in the southern hemisphere, so it is worth stating loudly.
 */

export const ROOT_X = 2;
export const ROOT_Y = 1;

export const tilesX = (z) => ROOT_X << z;
export const tilesY = (z) => ROOT_Y << z;

export const tileWidth = (z) => 360 / tilesX(z);
export const tileHeight = (z) => 180 / tilesY(z);

export function tileRect(z, x, y) {
  const w = tileWidth(z), h = tileHeight(z);
  const west = -180 + x * w;
  const south = -90 + y * h;
  return { west, south, east: west + w, north: south + h };
}

/** Which tile contains a coordinate, clamped to the grid. */
export function tileAt(z, lon, lat) {
  const nx = tilesX(z), ny = tilesY(z);
  const x = Math.min(nx - 1, Math.max(0, Math.floor(((lon + 180) / 360) * nx)));
  const y = Math.min(ny - 1, Math.max(0, Math.floor(((lat + 90) / 180) * ny)));
  return { x, y };
}

/**
 * A tile identity as one number, so the cache can be a Map with a primitive
 * key rather than a string that has to be built and hashed every frame.
 * Levels stay under 21, which keeps this inside the exact integer range.
 */
export function tileKey(z, x, y) {
  return z * 4398046511104 + x * 2097152 + y; // 2^42 and 2^21
}

/** Metres per tile edge at the equator, a rough size for budgeting. */
export function tileSpanMetres(z) {
  return (40075017 / tilesX(z));
}
