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

/* The highest point over each cell of a QM_TOPS x QM_TOPS grid laid on a
 * tile (qm.c, qm_tops): what a flight passing over the tile must clear. */
#define QM_TOPS 16u

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
  /* After shaping (shape.c): the vertices the tile came with keep their
   * numbers, so its normals still fit them; `recompute` flags those whose
   * normal must be worked out from the shaped triangles (and every new one). */
  const u8 *recompute;              /* one byte per vertex, or null */
  /* And which vertices lie on a cut or fill face beside a road: 128 none,
   * above for a cut (the ground lowered), below for a fill, as far from
   * 128 as the vertex is on the face (the shader's colours). Or null. */
  const u8 *face;
  u32    originalCount;
} QmMesh;

/* A piece of road, track, path or railway bed as the render thread sends it
 * (js/engine/vector/pieces.js): ten floats. One of negative priority is a
 * pin (shape.c): the height `s1` for its line at `s0` along it, going on at
 * `grade` (rise per metre of s). */
typedef struct {
  float u0, v0, u1, v1;   /* its ends, in the tile's quantized units (0..32767 spans the tile; may lie beyond it) */
  float s0, s1;           /* metres along its line at the ends */
  float half;             /* metres either side of the centreline held level */
  float grade;            /* the steepest it may climb along its line, a fraction */
  float priority;         /* where pieces meet or overlap, the higher one is shaped first and wins */
  float line;             /* the line it belongs to (an integer) */
} RoadPiece;

/* What shaping did, for the performance panel and the tests. */
typedef struct {
  u32 status;
  u32 pieces, used, skipped;    /* given, inserted, left out as already level */
  u32 vertices, triangles;      /* before shaping */
  u32 addedVertices, addedTriangles;
  u32 moved;                    /* vertices whose height changed */
  float worstCut, worstFill;    /* metres the ground was lowered and raised at most */
  u32 dropped;                  /* slivers folded by rounding and left out (they cover no ground) */
  u32 flipped;                  /* slivers folded by rounding, mended by flipping an edge */
  u32 merged;                   /* vertices rounded onto another, made one with it */
  u32 reserved[2];
} ShapeStats;                   /* 64 bytes */

/* The ground index physics stands on (ground.c). */
typedef struct {
  float minHeight, maxHeight;     /*  0 */
  u32 vertexCount, triangleCount; /*  8 */
  u32 uvhOffset;                  /* 16  u16 u[n], v[n], h[n], contiguous */
  u32 indexOffset;                /* 20 */
  u32 indexIsU32;                 /* 24 */
  u32 grid;                       /* 28  cells per side */
  u32 cellStartOffset;            /* 32  u32[grid * grid + 1] */
  u32 cellTrisOffset;             /* 36  u32[cellTrisCount] */
  u32 cellTrisCount;              /* 40 */
  u32 status;                     /* 44 */
  u32 reserved[4];                /* 48 */
} QmGround;                       /* 64 bytes */

/* Builds it over a parsed tile, in the arena. */
u32 ground_build(const QmMesh *m, QmGround *res);

/*
 * Cuts roads, tracks, paths and railway beds into a parsed tile (shape.c).
 * `mu`, `mv`: metres per quantized unit east and north.
 */
u32 qm_shape(QmMesh *m, const RoadPiece *pieces, u32 count, double mu, double mv, ShapeStats *st);

/* Metres per quantized unit east and north of a tile, at its middle. */
void qm_unit_metres(double west, double south, double east, double north, double *mu, double *mv);

/*
 * Decodes the header, vertices and triangles of one tile. The vertex arrays
 * are decoded in place inside `src`, so the source bytes are consumed: parse a
 * fresh copy for each use. Edge lists, and the extensions after them, are read
 * only when `withEdges` is set, since only the renderer needs them.
 */
u32 qm_parse(u8 *src, u32 len, QmMesh *m, int withEdges);

#endif
