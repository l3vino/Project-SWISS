/* format.js — the terrain vertex layout, written down once.
 *
 * The C decoder writes it, the shader reads it, and this file is what keeps
 * the two honest. Twenty-four bytes:
 *
 *   0   position  float32x3   metres from the tile origin
 *   12  normal    snorm16x2   octahedral; needs normalising after decode
 *   16  uvhs      unorm16x4   u, v, normalised height, and a skirt's 1 or the surface's 0.25 (0 to 0.5 on faces cut or filled beside a road: wasm/src/qm.c)
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

/* The railway's track built over a tile (5.18b: wasm/src/track.c, drawn by the terrain pass with shaders/track.wgsl).
 * Twenty-eight bytes:
 *
 *   0   position  float32x3   metres from the tile origin (the tile's own)
 *   12  uv        unorm16x2   where it lies on the tile (the quarters finer tiles draw instead)
 *   16  along     float32     metres along its line: the sleepers
 *   20  across    snorm16x2   metres right of the track's middle and half its gauge, both / TRACK_SPAN
 *   24  kind      unorm8x4    bed, rail or rack (/ 255); 255 flush at a level crossing, down to 0 the full bed; how
 *                             far up its profile (0 a rail's foot or the bed's toe, 255 a head or the bed's top); 0
 */
export const TRACK_STRIDE = 28;
export const TRACK_SPAN = 4;

export const TRACK_VERTEX_LAYOUT = {
  arrayStride: TRACK_STRIDE,
  attributes: [
    { shaderLocation: 0, offset: 0,  format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'unorm16x2' },
    { shaderLocation: 2, offset: 16, format: 'float32' },
    { shaderLocation: 3, offset: 20, format: 'snorm16x2' },
    { shaderLocation: 4, offset: 24, format: 'unorm8x4' },
  ],
};
