/* qm.c — Cesium Quantized Mesh 1.0 into a GPU-ready mesh.
 *
 * The wire format is a triangulated irregular network: vertices carry a
 * position quantised to 16 bits inside the tile's own rectangle, encoded as
 * zigzag deltas, and indices are high-water-mark encoded. Both schemes are
 * sequential by nature, so the decode is a tight scalar pass rather than
 * anything vectorised.
 *
 * Output is one interleaved vertex buffer in the layout the terrain shader
 * expects, plus an index buffer, plus a small result header. Positions are
 * float32 offsets from a per-tile origin, because absolute ECEF metres do not
 * survive float32: at Switzerland's distance from the earth's centre the
 * spacing between representable float32 values is about half a metre.
 *
 *   offset  0   position   float32x3   metres, relative to the tile origin
 *   offset 12   normal     snorm16x2   octahedral encoding
 *   offset 16   uvhs       unorm16x4   u, v, normalised height, skirt flag
 *   stride 24
 */

#include "core.h"

#define QM_HEADER_BYTES 88
#define QM_MAX 32767.0
#define VERTEX_STRIDE 24

/* Status codes, surfaced to JavaScript rather than trapping. */
enum { QM_OK = 0, QM_SHORT = 1, QM_BAD_COUNT = 2, QM_OOM = 3, QM_TRUNCATED = 4 };

typedef struct {
  double originX, originY, originZ;              /*  0 tile origin, absolute ECEF */
  double boundX, boundY, boundZ, boundRadius;    /* 24 bounding sphere, origin-relative */
  float  minHeight, maxHeight;                   /* 56 */
  u32 vertexCount, indexCount;                   /* 64 */
  u32 vertexOffset, indexOffset;                 /* 72 */
  u32 indexIsU32, status;                        /* 80 */
} QmResult;                                      /* 88 bytes */

/* ---- small helpers ------------------------------------------------------- */

static void zigzag_delta(u16 *p, u32 count) {
  u16 acc = 0;
  for (u32 i = 0; i < count; i++) {
    u16 z = p[i];
    acc = (u16)(acc + (u16)((z >> 1) ^ (u16) - (i32)(z & 1)));
    p[i] = acc;
  }
}

/* Sorts an edge's vertex indices by how far along the edge they sit, so the
 * skirt can be stitched as a strip. Edges hold tens of entries at most, which
 * is where insertion sort wins outright. */
static void sort_edge(u32 *idx, u32 n, const u16 *key) {
  for (u32 i = 1; i < n; i++) {
    u32 v = idx[i];
    u16 k = key[v];
    u32 j = i;
    while (j > 0 && key[idx[j - 1]] > k) { idx[j] = idx[j - 1]; j--; }
    idx[j] = v;
  }
}

/* Octahedral normal encoding: a unit vector in two signed 16-bit numbers,
 * which costs 4 bytes instead of 12 and is exact enough that no lighting
 * artefact is visible. */
static void oct_encode(double x, double y, double z, i16 *out2) {
  double l = m_abs(x) + m_abs(y) + m_abs(z);
  if (l == 0.0) { out2[0] = 0; out2[1] = 0; return; }
  double px = x / l, py = y / l;
  if (z < 0.0) {
    double sx = px >= 0.0 ? 1.0 : -1.0;
    double sy = py >= 0.0 ? 1.0 : -1.0;
    double nx = (1.0 - m_abs(py)) * sx;
    double ny = (1.0 - m_abs(px)) * sy;
    px = nx; py = ny;
  }
  double a = px * 32767.0, b = py * 32767.0;
  out2[0] = (i16)(a < 0 ? a - 0.5 : a + 0.5);
  out2[1] = (i16)(b < 0 ? b - 0.5 : b + 0.5);
}

INLINE u16 to_unorm16(double q) {
  /* Quantized mesh uses 0..32767; the vertex format uses 0..65535. */
  double v = q * (65535.0 / 32767.0);
  if (v < 0) v = 0;
  if (v > 65535.0) v = 65535.0;
  return (u16)(v + 0.5);
}

/* ---- the decoder --------------------------------------------------------- */

/**
 * @param srcOff  tile bytes in linear memory (modified in place while decoding)
 * @param resOff  where to write the QmResult
 * Returns the status code, also stored in the result.
 */
EXPORT u32 qm_decode(u32 srcOff, u32 srcLen,
                     double west, double south, double east, double north,
                     u32 resOff) {
  QmResult *res = (QmResult *)PTR(resOff);
  memset(res, 0, sizeof(QmResult));

  u8 *src = (u8 *)PTR(srcOff);
  if (srcLen < QM_HEADER_BYTES + 4) return (res->status = QM_SHORT);

  /* Header: centre, height range, bounding sphere, horizon occlusion point. */
  double cx = rd_f64(src +  0), cy = rd_f64(src +  8), cz = rd_f64(src + 16);
  float minH = rd_f32(src + 24), maxH = rd_f32(src + 28);
  double bx = rd_f64(src + 32), by = rd_f64(src + 40), bz = rd_f64(src + 48);
  double br = rd_f64(src + 56);
  (void)cx; (void)cy; (void)cz;

  u32 p = QM_HEADER_BYTES;
  u32 vCount = rd_u32(src + p); p += 4;
  if (vCount == 0 || vCount > (1u << 22)) return (res->status = QM_BAD_COUNT);
  if (p + vCount * 6u > srcLen) return (res->status = QM_TRUNCATED);

  u16 *uArr = (u16 *)(src + p);
  u16 *vArr = uArr + vCount;
  u16 *hArr = vArr + vCount;
  zigzag_delta(uArr, vCount);
  zigzag_delta(vArr, vCount);
  zigzag_delta(hArr, vCount);
  p += vCount * 6u;

  /* Indices widen past 65536 vertices, and their section is padded to their
   * own width. */
  u32 wide = vCount > 65536u;
  u32 stride = wide ? 4u : 2u;
  p = (p + (stride - 1u)) & ~(stride - 1u);
  if (p + 4u > srcLen) return (res->status = QM_TRUNCATED);

  u32 triCount = rd_u32(src + p); p += 4;
  u32 idxCount = triCount * 3u;
  if (triCount == 0 || p + idxCount * stride > srcLen) return (res->status = QM_TRUNCATED);

  /* High-water-mark decoding, in place. */
  u32 *tris = (u32 *)PTR(arena_alloc(idxCount * 4u));
  if (!tris) return (res->status = QM_OOM);
  {
    u32 highest = 0;
    for (u32 i = 0; i < idxCount; i++) {
      u32 code = wide ? rd_u32(src + p + i * 4u) : rd_u16(src + p + i * 2u);
      tris[i] = highest - code;
      if (code == 0) highest++;
    }
  }
  p += idxCount * stride;

  /* Four edge index lists, used to build the skirt. */
  u32 *edges[4]; u32 edgeCount[4];
  for (int e = 0; e < 4; e++) {
    if (p + 4u > srcLen) return (res->status = QM_TRUNCATED);
    u32 n = rd_u32(src + p); p += 4;
    if (p + n * stride > srcLen) return (res->status = QM_TRUNCATED);
    u32 *list = (u32 *)PTR(arena_alloc((n ? n : 1u) * 4u));
    if (!list) return (res->status = QM_OOM);
    for (u32 i = 0; i < n; i++) {
      list[i] = wide ? rd_u32(src + p + i * 4u) : rd_u16(src + p + i * 2u);
    }
    p += n * stride;
    edges[e] = list; edgeCount[e] = n;
  }
  /* west and east vary with latitude, south and north with longitude. */
  sort_edge(edges[0], edgeCount[0], vArr);
  sort_edge(edges[1], edgeCount[1], uArr);
  sort_edge(edges[2], edgeCount[2], vArr);
  sort_edge(edges[3], edgeCount[3], uArr);

  /* ---- allocate output ---- */
  u32 skirtVerts = edgeCount[0] + edgeCount[1] + edgeCount[2] + edgeCount[3];
  u32 skirtQuads = 0;
  for (int e = 0; e < 4; e++) if (edgeCount[e] > 1) skirtQuads += edgeCount[e] - 1;

  u32 outVerts = vCount + skirtVerts;
  u32 outIndices = idxCount + skirtQuads * 6u;
  u32 narrow = outVerts <= 65535u;

  u32 vOff = arena_alloc(outVerts * VERTEX_STRIDE);
  u32 iOff = arena_alloc(outIndices * (narrow ? 2u : 4u));
  if (!vOff || !iOff) return (res->status = QM_OOM);
  u8 *vb = (u8 *)PTR(vOff);

  /* ---- dequantise the mesh vertices ---- */
  double lonSpan = (east - west) * DEG2RAD, latSpan = (north - south) * DEG2RAD;
  double lon0 = west * DEG2RAD, lat0 = south * DEG2RAD;
  double hSpan = (double)maxH - (double)minH;

  /* The bounding-sphere centre doubles as the tile origin: it is already the
   * middle of the geometry, which keeps the float32 offsets small. */
  res->originX = bx; res->originY = by; res->originZ = bz;

  /* Positions are needed twice, for output and for the normal pass, so keep a
   * double-precision copy rather than reading back from float32. */
  double *pos = (double *)PTR(arena_alloc(vCount * 24u));
  if (!pos) return (res->status = QM_OOM);

  for (u32 i = 0; i < vCount; i++) {
    double lon = lon0 + (uArr[i] / QM_MAX) * lonSpan;
    double lat = lat0 + (vArr[i] / QM_MAX) * latSpan;
    double h = (double)minH + (hArr[i] / QM_MAX) * hSpan;
    double e[3];
    geodetic_to_ecef(lon, lat, h, e);
    pos[i * 3 + 0] = e[0] - bx;
    pos[i * 3 + 1] = e[1] - by;
    pos[i * 3 + 2] = e[2] - bz;
  }

  /* ---- normals from accumulated face normals ----
   * The format can carry oct-encoded normals as an extension, but only when
   * the client asks for them with a custom Accept header, which would force a
   * CORS preflight on every tile. Deriving them here is cheaper than that. */
  double *nrm = (double *)PTR(arena_alloc(vCount * 24u));
  if (!nrm) return (res->status = QM_OOM);
  memset(nrm, 0, vCount * 24u);

  for (u32 t = 0; t < idxCount; t += 3) {
    u32 a = tris[t], b = tris[t + 1], c = tris[t + 2];
    if (a >= vCount || b >= vCount || c >= vCount) continue;
    double ux = pos[b * 3] - pos[a * 3];
    double uy = pos[b * 3 + 1] - pos[a * 3 + 1];
    double uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    double wx = pos[c * 3] - pos[a * 3];
    double wy = pos[c * 3 + 1] - pos[a * 3 + 1];
    double wz = pos[c * 3 + 2] - pos[a * 3 + 2];
    /* Left unnormalised on purpose: the cross product's length is twice the
     * triangle area, which weights big triangles more and is what you want. */
    double nx = uy * wz - uz * wy;
    double ny = uz * wx - ux * wz;
    double nz = ux * wy - uy * wx;
    nrm[a * 3] += nx; nrm[a * 3 + 1] += ny; nrm[a * 3 + 2] += nz;
    nrm[b * 3] += nx; nrm[b * 3 + 1] += ny; nrm[b * 3 + 2] += nz;
    nrm[c * 3] += nx; nrm[c * 3 + 1] += ny; nrm[c * 3 + 2] += nz;
  }

  for (u32 i = 0; i < vCount; i++) {
    double nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
    double l = m_sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    else {
      /* A degenerate fan: fall back to the outward ellipsoid direction. */
      double ax = pos[i * 3] + bx, ay = pos[i * 3 + 1] + by, az = pos[i * 3 + 2] + bz;
      double al = m_sqrt(ax * ax + ay * ay + az * az);
      nx = ax / al; ny = ay / al; nz = az / al;
    }
    u8 *v = vb + i * VERTEX_STRIDE;
    float px = (float)pos[i * 3], py = (float)pos[i * 3 + 1], pz = (float)pos[i * 3 + 2];
    memcpy(v + 0, &px, 4); memcpy(v + 4, &py, 4); memcpy(v + 8, &pz, 4);
    i16 oct[2]; oct_encode(nx, ny, nz, oct);
    memcpy(v + 12, oct, 4);
    u16 uvhs[4] = { to_unorm16(uArr[i]), to_unorm16(vArr[i]), to_unorm16(hArr[i]), 0 };
    memcpy(v + 16, uvhs, 8);
  }

  /* ---- skirt ----
   * Edge vertices are duplicated and pushed straight down along the ellipsoid
   * normal. Without this, neighbouring tiles at different detail levels show a
   * hairline of sky between them. */
  double skirtDrop = hSpan * 0.25;
  if (skirtDrop < 60.0) skirtDrop = 60.0;

  u32 next = vCount;
  u32 *idxOut32 = (u32 *)PTR(iOff);
  u16 *idxOut16 = (u16 *)PTR(iOff);
  u32 w = 0;
  for (u32 i = 0; i < idxCount; i++) {
    if (narrow) idxOut16[w++] = (u16)tris[i]; else idxOut32[w++] = tris[i];
  }

  for (int e = 0; e < 4; e++) {
    u32 n = edgeCount[e];
    if (n < 2) { next += n; continue; }
    u32 base = next;
    for (u32 i = 0; i < n; i++) {
      u32 srcV = edges[e][i];
      if (srcV >= vCount) srcV = 0;
      double ax = pos[srcV * 3] + bx, ay = pos[srcV * 3 + 1] + by, az = pos[srcV * 3 + 2] + bz;
      double al = m_sqrt(ax * ax + ay * ay + az * az);
      u8 *v = vb + (base + i) * VERTEX_STRIDE;
      float px = (float)(pos[srcV * 3] - (ax / al) * skirtDrop);
      float py = (float)(pos[srcV * 3 + 1] - (ay / al) * skirtDrop);
      float pz = (float)(pos[srcV * 3 + 2] - (az / al) * skirtDrop);
      memcpy(v + 0, &px, 4); memcpy(v + 4, &py, 4); memcpy(v + 8, &pz, 4);
      memcpy(v + 12, vb + srcV * VERTEX_STRIDE + 12, 4);   /* reuse the normal */
      u16 uvhs[4] = { to_unorm16(uArr[srcV]), to_unorm16(vArr[srcV]),
                      to_unorm16(hArr[srcV]), 65535 };      /* flagged as skirt */
      memcpy(v + 16, uvhs, 8);
    }
    for (u32 i = 0; i + 1 < n; i++) {
      u32 a = edges[e][i], b = edges[e][i + 1], c = base + i + 1, d = base + i;
      u32 quad[6] = { a, b, c, a, c, d };
      for (int k = 0; k < 6; k++) {
        if (narrow) idxOut16[w++] = (u16)quad[k]; else idxOut32[w++] = quad[k];
      }
    }
    next += n;
  }

  res->boundX = 0; res->boundY = 0; res->boundZ = 0;
  res->boundRadius = br + skirtDrop;
  res->minHeight = minH;
  res->maxHeight = maxH;
  res->vertexCount = outVerts;
  res->indexCount = w;
  res->vertexOffset = vOff;
  res->indexOffset = iOff;
  res->indexIsU32 = narrow ? 0u : 1u;
  res->status = QM_OK;
  return QM_OK;
}

EXPORT u32 qm_result_size(void) { return (u32)sizeof(QmResult); }
EXPORT u32 qm_vertex_stride(void) { return VERTEX_STRIDE; }
