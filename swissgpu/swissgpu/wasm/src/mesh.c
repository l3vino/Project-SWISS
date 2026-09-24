/* mesh.c — building meshes into the compact vertex format the GPU draws.
 *
 * A 3D Tiles tile arrives as glTF: float positions in the model's own frame,
 * a chain of matrices that places them on the earth, and a feature id per
 * vertex saying which building each belongs to. This turns that into twelve
 * bytes a vertex:
 *
 *   offset 0   unorm16 x4   east, north, up inside the tile's box; height of
 *                           this vertex above its building's lowest point
 *   offset 8   uint16  x2   building info (kind << 12 | tint); the facing of
 *                           the wall this vertex starts, as a diamond angle
 *
 * Positions are expressed in a local east-north-up frame at the tile, not in
 * earth-centred axes, so that "up" is an axis: the box is then tight in
 * height, and the shader can tell roofs from walls and walls from the ground
 * line without any other data. Sixteen bits over a box a few hundred metres
 * wide is millimetre precision.
 *
 * The passes, called per tile from the decode thread:
 *   mesh_transform  per primitive: model space to local metres, growing the box
 *   mesh_quantize   once: every vertex into the box, with its building's info
 *   mesh_indices    once: drop hidden buildings' triangles, narrow to 16 bits
 *   mesh_facets     once: give every wall triangle its exact facing
 *   mesh_narrow     once, when every vertex fits: 32-bit indices to 16
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

/* ---- wall facings ------------------------------------------------------- */

/*
 * The facade shader lays windows out along each wall, which needs the wall's
 * direction. Taken from screen-space derivatives it wobbles by a ten-
 * thousandth of a radian from pixel to pixel, which is nothing for lighting
 * but decimetres of jitter in a window hundreds of metres from the tile's
 * origin. So every wall triangle gets its facing here, exactly, in the spare
 * sixteen bits of its first vertex, which the shader reads without
 * interpolation. A vertex shared by walls facing different ways can only
 * carry one facing: the triangle's corners are rotated (keeping its winding)
 * until one carries its own, and if none can, that corner is duplicated.
 *
 * Facings are horizontal directions folded into one half-plane, since the
 * shader does not care which side a wall faces, stored as a diamond angle:
 * the direction's position around the unit diamond, 0..2 across the half,
 * in sixteen-bit steps. Monotonic, exact to invert, and needs no atan2.
 */

#define FACET_WALL_MAX_NZ 0.9     /* flatter than this is a roof or a floor */
#define FACET_TOLERANCE 8u        /* codes this close are the same wall */

static u16 facet_code(double x, double y) {
  if (y < 0.0 || (y == 0.0 && x < 0.0)) { x = -x; y = -y; }
  double d = x >= 0.0 ? y / (x + y) : 1.0 - x / (-x + y);
  u32 c = (u32)(d * 16384.0 + 0.5);
  return (u16)(c & 0xFFFFu);
}

INLINE u32 same_facet(u16 a, u16 b) {
  u16 d = (u16)(a - b);
  return d <= FACET_TOLERANCE || d >= (u16)(0u - FACET_TOLERANCE);
}

/**
 * @param localOff    float32 x3 per original vertex, from mesh_transform
 * @param vertexOff   packed vertices (mesh_quantize), room for `capacity`
 * @param idxOff      u32 indices of the kept triangles, rewritten in place
 * @param claimedOff  scratch, one byte per vertex of capacity
 * Returns the vertex count afterwards.
 */
EXPORT u32 mesh_facets(u32 localOff, u32 vertexOff, u32 vertexCount, u32 capacity,
                       u32 idxOff, u32 indexCount, u32 claimedOff) {
  const float *l = (const float *)PTR(localOff);
  u16 *v = (u16 *)PTR(vertexOff);
  u32 *idx = (u32 *)PTR(idxOff);
  u8 *claimed = (u8 *)PTR(claimedOff);
  memset(claimed, 0, capacity);
  u32 n = vertexCount;

  for (u32 t = 0; t + 2 < indexCount; t += 3) {
    u32 a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    double ux = l[b * 3] - l[a * 3], uy = l[b * 3 + 1] - l[a * 3 + 1], uz = l[b * 3 + 2] - l[a * 3 + 2];
    double vx = l[c * 3] - l[a * 3], vy = l[c * 3 + 1] - l[a * 3 + 1], vz = l[c * 3 + 2] - l[a * 3 + 2];
    double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    double len = m_sqrt(nx * nx + ny * ny + nz * nz);
    if (len <= 0.0 || m_abs(nz) > FACET_WALL_MAX_NZ * len) continue;
    u16 code = facet_code(nx, ny);

    /* A corner that is free, or already faces this way, goes first. */
    u32 corner = 3;
    for (u32 k = 0; k < 3 && corner == 3; k++) {
      u32 w = idx[t + k];
      if (!claimed[w] || same_facet(v[w * STRIDE_U16 + 5], code)) corner = k;
    }
    if (corner == 3) {
      if (n >= capacity) continue;
      u16 *src = v + a * STRIDE_U16, *dst = v + n * STRIDE_U16;
      for (u32 j = 0; j < STRIDE_U16; j++) dst[j] = src[j];
      idx[t] = n++;
      corner = 0;
    }
    u32 r0 = idx[t + corner], r1 = idx[t + (corner + 1) % 3], r2 = idx[t + (corner + 2) % 3];
    idx[t] = r0; idx[t + 1] = r1; idx[t + 2] = r2;
    if (!claimed[r0]) { claimed[r0] = 1; v[r0 * STRIDE_U16 + 5] = code; }
  }
  return n;
}

/** 32-bit indices to 16, for when every vertex fits. `outOff` may equal `idxOff`. */
EXPORT void mesh_narrow(u32 idxOff, u32 count, u32 outOff) {
  const u32 *in = (const u32 *)PTR(idxOff);
  u16 *out = (u16 *)PTR(outOff);
  for (u32 i = 0; i < count; i++) out[i] = (u16)in[i];
}
