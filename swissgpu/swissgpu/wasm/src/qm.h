/* qm.h — the Quantized Mesh 1.0 wire format, parsed once.
 *
 * Two consumers read the same tile: the renderer (qm.c), which turns it into
 * GPU vertices, and the ground index (ground.c), which turns it into something
 * a walking camera can stand on. Both go through qm_parse so there is exactly
 * one place that knows the byte layout.
 */
#ifndef QM_H
#define QM_H

#include "core.h"

#define QM_HEADER_BYTES 88
#define QM_MAX 32767.0

/* Extension ids from the specification. */
#define QM_EXT_OCT_NORMALS 1
#define QM_EXT_WATER_MASK  2
#define QM_EXT_METADATA    4

/* Status codes, surfaced to JavaScript rather than trapping. */
enum { QM_OK = 0, QM_SHORT = 1, QM_BAD_COUNT = 2, QM_OOM = 3, QM_TRUNCATED = 4 };

typedef struct {
  float  minHeight, maxHeight;      /* metres, the range the 16-bit heights span */
  double boundX, boundY, boundZ;    /* bounding sphere centre, absolute ECEF */
  double boundRadius;
  u32    vertexCount;
  u16   *u, *v, *h;                 /* decoded in place, 0..32767 each, contiguous */
  u32    triangleCount;
  u32   *tris;                      /* 3 per triangle, arena-allocated */
  u32   *edges[4];                  /* west, south, east, north vertex lists */
  u32    edgeCount[4];
  /* Extensions, found only when edges are parsed, since they follow them. */
  const u8 *normals;                /* oct-encoded, two bytes per vertex, or null */
  u32    metadataOffset;            /* the metadata extension's JSON text, or 0 */
  u32    metadataLength;
} QmMesh;

/*
 * Decodes the header, vertices and triangles of one tile. The vertex arrays
 * are decoded in place inside `src`, so the source bytes are consumed: parse a
 * fresh copy for each use. Edge lists, and the extensions after them, are read
 * only when `withEdges` is set, since only the renderer needs them.
 */
u32 qm_parse(u8 *src, u32 len, QmMesh *m, int withEdges);

#endif
