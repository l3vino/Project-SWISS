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
 * Two optional extensions are read when a tile carries them: per-vertex
 * normals, used as they are, and a metadata JSON whose location is handed
 * back so JavaScript can parse it (it says which finer tiles exist).
 *
 *   offset  0   position   float32x3   metres, relative to the tile origin
 *   offset 12   normal     snorm16x2   octahedral encoding
 *   offset 16   uvhs       unorm16x4   u, v, normalised height, skirt flag
 *   stride 24
 */

#include "qm.h"

#define VERTEX_STRIDE 24

typedef struct {
  double originX, originY, originZ;              /*  0 tile origin, absolute ECEF */
  double boundX, boundY, boundZ, boundRadius;    /* 24 bounding sphere, origin-relative */
  float  minHeight, maxHeight;                   /* 56 */
  u32 vertexCount, indexCount;                   /* 64 */
  u32 vertexOffset, indexOffset;                 /* 72 */
  u32 indexIsU32, status;                        /* 80 */
  u32 metadataOffset, metadataLength;            /* 88 the metadata extension's JSON, if any */
  u32 serverNormals, reserved;                   /* 96 1 when the tile carried its own normals */
} QmResult;                                      /* 104 bytes */

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

/* One mesh vertex in the layout at the top of this file. */
INLINE void write_vertex(u8 *out, const double *pos, const i16 *oct, u16 u, u16 v, u16 h) {
  float p[3] = { (float)pos[0], (float)pos[1], (float)pos[2] };
  memcpy(out + 0, p, 12);
  memcpy(out + 12, oct, 4);
  u16 uvhs[4] = { to_unorm16(u), to_unorm16(v), to_unorm16(h), 0 };
  memcpy(out + 16, uvhs, 8);
}

/* ---- the parser ---------------------------------------------------------- */

u32 qm_parse(u8 *src, u32 srcLen, QmMesh *m, int withEdges) {
  memset(m, 0, sizeof(QmMesh));
  if (srcLen < QM_HEADER_BYTES + 4) return QM_SHORT;

  /* Header: centre (unused), height range, bounding sphere, horizon point. */
  m->minHeight = rd_f32(src + 24);
  m->maxHeight = rd_f32(src + 28);
  m->boundX = rd_f64(src + 32);
  m->boundY = rd_f64(src + 40);
  m->boundZ = rd_f64(src + 48);
  m->boundRadius = rd_f64(src + 56);

  u32 p = QM_HEADER_BYTES;
  u32 vCount = rd_u32(src + p); p += 4;
  if (vCount == 0 || vCount > (1u << 22)) return QM_BAD_COUNT;
  if (p + vCount * 6u > srcLen) return QM_TRUNCATED;

  m->vertexCount = vCount;
  m->u = (u16 *)(src + p);
  m->v = m->u + vCount;
  m->h = m->v + vCount;
  zigzag_delta(m->u, vCount);
  zigzag_delta(m->v, vCount);
  zigzag_delta(m->h, vCount);
  p += vCount * 6u;

  /* Indices widen past 65536 vertices, and their section is padded to their
   * own width. */
  u32 wide = vCount > 65536u;
  u32 stride = wide ? 4u : 2u;
  p = (p + (stride - 1u)) & ~(stride - 1u);
  if (p + 4u > srcLen) return QM_TRUNCATED;

  u32 triCount = rd_u32(src + p); p += 4;
  u32 idxCount = triCount * 3u;
  if (triCount == 0 || p + idxCount * stride > srcLen) return QM_TRUNCATED;

  /* High-water-mark decoding. For 16-bit tiles the subtraction wraps modulo
   * 65536, exactly as the reference decoder does by writing into a 16-bit
   * array. Without the mask, an index the encoder did not introduce in order
   * decodes to a huge 32-bit number and the triangle is silently lost. */
  u32 *tris = (u32 *)PTR(arena_alloc(idxCount * 4u));
  if (!tris) return QM_OOM;
  {
    u32 highest = 0;
    u32 mask = wide ? 0xFFFFFFFFu : 0xFFFFu;
    for (u32 i = 0; i < idxCount; i++) {
      u32 code = wide ? rd_u32(src + p + i * 4u) : rd_u16(src + p + i * 2u);
      tris[i] = (highest - code) & mask;
      if (code == 0) highest++;
    }
  }
  p += idxCount * stride;
  m->triangleCount = triCount;
  m->tris = tris;

  if (!withEdges) return QM_OK;

  /* Four edge index lists: west, south, east, north. */
  for (int e = 0; e < 4; e++) {
    if (p + 4u > srcLen) return QM_TRUNCATED;
    u32 n = rd_u32(src + p); p += 4;
    if (p + n * stride > srcLen) return QM_TRUNCATED;
    u32 *list = (u32 *)PTR(arena_alloc((n ? n : 1u) * 4u));
    if (!list) return QM_OOM;
    for (u32 i = 0; i < n; i++) {
      list[i] = wide ? rd_u32(src + p + i * 4u) : rd_u16(src + p + i * 2u);
    }
    p += n * stride;
    m->edges[e] = list;
    m->edgeCount[e] = n;
  }

  /* Extensions: an id byte and a little-endian u32 length, then the data, to
   * the end of the file. They are optional and the mesh above is complete
   * without them, so a damaged one ends the scan rather than the tile. */
  while (p + 5u <= srcLen) {
    u32 id = src[p];
    u32 len = rd_u32(src + p + 1u);
    p += 5u;
    if (len > srcLen - p) break;
    if (id == QM_EXT_OCT_NORMALS && len >= vCount * 2u) {
      m->normals = src + p;
    } else if (id == QM_EXT_METADATA && len >= 4u) {
      u32 jsonLength = rd_u32(src + p);
      if (jsonLength <= len - 4u) {
        m->metadataOffset = OFF(src + p + 4u);
        m->metadataLength = jsonLength;
      }
    }
    p += len;
  }
  return QM_OK;
}

/* The tile's own normals are octahedral pairs in 0..255. The vertex format
 * uses the same octahedral mapping in signed 16 bits, so converting is a
 * rescale, not a decode and re-encode. */
INLINE i16 oct_unorm8_to_snorm16(u8 value) {
  double s = (double)value * (2.0 / 255.0) - 1.0;
  double q = s * 32767.0;
  return (i16)(q < 0 ? q - 0.5 : q + 0.5);
}

/* ---- the decoder --------------------------------------------------------- */

/**
 * @param srcOff       tile bytes in linear memory (modified in place while decoding)
 * @param skirtHeight  how far the edge curtain hangs, metres; 0 picks a default
 * @param resOff       where to write the QmResult
 * Returns the status code, also stored in the result.
 */
EXPORT u32 qm_decode(u32 srcOff, u32 srcLen,
                     double west, double south, double east, double north,
                     double skirtHeight, u32 resOff) {
  QmResult *res = (QmResult *)PTR(resOff);
  memset(res, 0, sizeof(QmResult));

  QmMesh mesh;
  u32 status = qm_parse((u8 *)PTR(srcOff), srcLen, &mesh, 1);
  if (status != QM_OK) return (res->status = status);

  float minH = mesh.minHeight, maxH = mesh.maxHeight;
  double bx = mesh.boundX, by = mesh.boundY, bz = mesh.boundZ, br = mesh.boundRadius;
  u32 vCount = mesh.vertexCount;
  u16 *uArr = mesh.u, *vArr = mesh.v, *hArr = mesh.h;
  u32 idxCount = mesh.triangleCount * 3u;
  u32 *tris = mesh.tris;
  u32 **edges = mesh.edges;
  u32 *edgeCount = mesh.edgeCount;

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

  /* ---- normals ----
   * Best from the tile itself: the service computes them from the full
   * elevation model rather than from this simplified mesh, and neighbouring
   * tiles agree along their shared edge, so lighting has no seams. */
  if (mesh.normals) {
    for (u32 i = 0; i < vCount; i++) {
      i16 oct[2] = { oct_unorm8_to_snorm16(mesh.normals[i * 2]),
                     oct_unorm8_to_snorm16(mesh.normals[i * 2 + 1]) };
      write_vertex(vb + i * VERTEX_STRIDE, pos + i * 3, oct, uArr[i], vArr[i], hArr[i]);
    }
  } else {
    /* Otherwise from accumulated face normals. Averaging stops at the tile's
     * edge, so these do show faint seams where tiles meet. */
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
      i16 oct[2]; oct_encode(nx, ny, nz, oct);
      write_vertex(vb + i * VERTEX_STRIDE, pos + i * 3, oct, uArr[i], vArr[i], hArr[i]);
    }
  }

  /* ---- skirt ----
   * Edge vertices are duplicated and pushed straight down along the ellipsoid
   * normal. Without this, neighbouring tiles at different detail levels show a
   * hairline of sky between them. The caller sizes it to the largest step two
   * neighbouring levels can have, so fine tiles get short curtains. */
  double skirtDrop = skirtHeight;
  if (!(skirtDrop > 0.0)) {
    skirtDrop = hSpan * 0.25;
    if (skirtDrop < 60.0) skirtDrop = 60.0;
  }

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
    /* Every curtain faces out of its tile, the side a crack is seen from, so
     * back faces can be culled. The edges are sorted south to north and west
     * to east, which winds the west and north curtains outward as they are
     * and the south and east ones inward, so those two are flipped. */
    int flip = (e == 1 || e == 2);
    for (u32 i = 0; i + 1 < n; i++) {
      u32 a = edges[e][i], b = edges[e][i + 1], c = base + i + 1, d = base + i;
      u32 quad[6] = { a, b, c, a, c, d };
      if (flip) { quad[1] = c; quad[2] = b; quad[4] = d; quad[5] = c; }
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
  res->metadataOffset = mesh.metadataOffset;
  res->metadataLength = mesh.metadataLength;
  res->serverNormals = mesh.normals ? 1u : 0u;
  res->status = QM_OK;
  return QM_OK;
}

EXPORT u32 qm_result_size(void) { return (u32)sizeof(QmResult); }
EXPORT u32 qm_vertex_stride(void) { return VERTEX_STRIDE; }
