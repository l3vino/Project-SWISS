/* format.js — the terrain vertex layout, written down once.
 *
 * The C decoder writes it, the shader reads it, and this file is what keeps
 * the two honest. Twenty-four bytes:
 *
 *   0   position  float32x3   metres from the tile origin
 *   12  normal    snorm16x2   octahedral; needs normalising after decode
 *   16  uvhs      unorm16x4   u, v, normalised height, skirt flag
 *
 * Positions could be quantised into the tile's own box for sixteen bytes. That
 * is worth doing once the streaming behaviour is settled, not before: a bug in
 * a quantisation scale reads exactly like a bug in the projection.
 */

export const VERTEX_STRIDE = 24;

export const TERRAIN_VERTEX_LAYOUT = {
  arrayStride: VERTEX_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'snorm16x2' },
    { shaderLocation: 2, offset: 16, format: 'unorm16x4' },
  ],
};

/** One 256-byte slot per tile, the minimum alignment for a dynamic offset.
 *  The shader reads the first 64 bytes; see the Tile struct in terrain.wgsl. */
export const TILE_UNIFORM_STRIDE = 256;
export const TILE_UNIFORM_FLOATS = TILE_UNIFORM_STRIDE / 4;
