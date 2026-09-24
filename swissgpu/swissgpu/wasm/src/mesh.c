/* mesh.c — building meshes into the compact vertex format the GPU draws.
 *
 * A 3D Tiles tile arrives as glTF: float positions in the model's own frame,
 * a chain of matrices that places them on the earth, and a feature id per
 * vertex saying which building each belongs to. This turns that into twelve
 * bytes a vertex:
 *
 *   offset 0   unorm16 x4   east, north, up inside the tile's box; height of
 *                           this vertex above its building's lowest point
 *   offset 8   uint16  x2   building info (kind << 12 | tint), unused
 *
 * Positions are expressed in a local east-north-up frame at the tile, not in
 * earth-centred axes, so that "up" is an axis: the box is then tight in
 * height, and the shader can tell roofs from walls and walls from the ground
 * line without any other data. Sixteen bits over a box a few hundred metres
 * wide is millimetre precision.
 *
 * Three passes, called per tile from the decode thread:
 *   mesh_transform  per primitive: model space to local metres, growing the box
 *   mesh_quantize   once: every vertex into the box, with its building's info
 *   mesh_indices    once: drop hidden buildings' triangles, narrow to 16 bits
 */

#include "core.h"

#define STRIDE_U16 6

/**
 * @param posOff    float32 x3 per vertex, model space
 * @param matOff    16 doubles, column-major: model space to earth-centred metres
 * @param frameOff  12 doubles: origin, east, north, up of the tile's local frame
 * @param outOff    float32 x3 per vertex: local east, north, up, metres
 * @param boundsOff 6 floats, min xyz then max xyz, widened to include these
 */
EXPORT void mesh_transform(u32 posOff, u32 count, u32 matOff, u32 frameOff, u32 outOff, u32 boundsOff) {
  const float *p = (const float *)PTR(posOff);
  const double *m = (const double *)PTR(matOff);
  const double *f = (const double *)PTR(frameOff);
  float *out = (float *)PTR(outOff);
  float *b = (float *)PTR(boundsOff);

  for (u32 i = 0; i < count; i++) {
    double x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    /* Earth-centred position, less the frame origin, all in doubles: the
     * origin is millions of metres away and float32 would keep none of it. */
    double ex = m[0] * x + m[4] * y + m[8] * z + m[12] - f[0];
    double ey = m[1] * x + m[5] * y + m[9] * z + m[13] - f[1];
    double ez = m[2] * x + m[6] * y + m[10] * z + m[14] - f[2];
    float lx = (float)(ex * f[3] + ey * f[4] + ez * f[5]);
    float ly = (float)(ex * f[6] + ey * f[7] + ez * f[8]);
    float lz = (float)(ex * f[9] + ey * f[10] + ez * f[11]);
    out[i * 3] = lx; out[i * 3 + 1] = ly; out[i * 3 + 2] = lz;
    if (lx < b[0]) b[0] = lx;
    if (ly < b[1]) b[1] = ly;
    if (lz < b[2]) b[2] = lz;
    if (lx > b[3]) b[3] = lx;
    if (ly > b[4]) b[4] = ly;
    if (lz > b[5]) b[5] = lz;
  }
}

INLINE u16 quantize(float v, float lo, float span) {
  float t = span > 0.0f ? (v - lo) / span : 0.0f;
  if (t < 0.0f) t = 0.0f;
  if (t > 1.0f) t = 1.0f;
  return (u16)(t * 65535.0f + 0.5f);
}

/* Heights above a building's base are stored in 1/100 of 655.35 m steps. */
#define BASE_RANGE 655.35f

/**
 * @param localOff     float32 x3 per vertex from mesh_transform
 * @param boundsOff    the final box
 * @param featOff      u32 feature id per vertex, or 0 when there are none
 * @param featureCount features in the tile
 * @param infoOff      u16 per feature: kind << 12 | tint, or 0
 * @param lowestOff    float scratch, one per feature
 * @param outOff       u16 x6 per vertex, the format at the top of this file
 */
EXPORT void mesh_quantize(u32 localOff, u32 count, u32 boundsOff, u32 featOff, u32 featureCount,
                          u32 infoOff, u32 lowestOff, u32 outOff) {
  const float *l = (const float *)PTR(localOff);
  const float *b = (const float *)PTR(boundsOff);
  const u32 *feat = featOff ? (const u32 *)PTR(featOff) : 0;
  const u16 *info = infoOff ? (const u16 *)PTR(infoOff) : 0;
  float *lowest = (float *)PTR(lowestOff);
  u16 *out = (u16 *)PTR(outOff);
  u32 features = featureCount ? featureCount : 1u;

  /* Each building's lowest point: where its walls meet the ground. */
  for (u32 k = 0; k < features; k++) lowest[k] = 3.0e38f;
  for (u32 i = 0; i < count; i++) {
    u32 k = feat ? feat[i] : 0;
    if (k >= features) k = 0;
    if (l[i * 3 + 2] < lowest[k]) lowest[k] = l[i * 3 + 2];
  }

  float sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2];
  for (u32 i = 0; i < count; i++) {
    u32 k = feat ? feat[i] : 0;
    if (k >= features) k = 0;
    u16 *v = out + i * STRIDE_U16;
    v[0] = quantize(l[i * 3], b[0], sx);
    v[1] = quantize(l[i * 3 + 1], b[1], sy);
    v[2] = quantize(l[i * 3 + 2], b[2], sz);
    v[3] = quantize(l[i * 3 + 2] - lowest[k], 0.0f, BASE_RANGE);
    v[4] = info ? info[k] : 0;
    v[5] = 0;
  }
}

/**
 * Copies triangles into the output, dropping those whose buildings are of a
 * hidden kind (underground, or marked invisible in the source), and narrows
 * indices to 16 bits when every vertex fits.
 *
 * @param hiddenKinds  bit k set: kind k is not drawn
 * Returns the number of indices written.
 */
EXPORT u32 mesh_indices(u32 idxOff, u32 count, u32 featOff, u32 featureCount, u32 infoOff,
                        u32 hiddenKinds, u32 outOff, u32 narrow) {
  const u32 *idx = (const u32 *)PTR(idxOff);
  const u32 *feat = featOff ? (const u32 *)PTR(featOff) : 0;
  const u16 *info = infoOff ? (const u16 *)PTR(infoOff) : 0;
  u16 *out16 = (u16 *)PTR(outOff);
  u32 *out32 = (u32 *)PTR(outOff);
  u32 w = 0;
  for (u32 t = 0; t + 2 < count; t += 3) {
    if (feat && info && hiddenKinds) {
      u32 k = feat[idx[t]];
      if (k < featureCount && ((hiddenKinds >> (info[k] >> 12)) & 1u)) continue;
    }
    for (u32 j = 0; j < 3; j++) {
      if (narrow) out16[w++] = (u16)idx[t + j]; else out32[w++] = idx[t + j];
    }
  }
  return w;
}
