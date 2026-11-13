/* solid.c — what you bump into and stand on, in a building tile.
 *
 * Collision uses exactly the triangles the renderer draws, the same way the
 * ground does (see ground.c): walls you can see are walls you cannot walk
 * through, and a roof you land on is the roof in the picture. Finding the few
 * triangles near a walker among the tens of thousands in a tile needs an
 * index, so this files every triangle under the cells of a uniform grid over
 * the tile's box that its footprint touches, in compressed sparse row form:
 * cell starts, then one flat list of triangle numbers.
 *
 * "Touches" is exact, not the footprint's bounding box: a long diagonal
 * triangle, like the side of a cable car's rope running up a slope for
 * hundreds of metres, crosses a thin band of cells, where its box would
 * cover a whole square of them and hand it to every query in that square.
 *
 * It reads the vertex format mesh.c writes, twelve bytes a vertex with the
 * position quantised to sixteen bits across the box, so the grid works on
 * those integers directly, and the render thread keeps one copy of the
 * vertices for drawing and colliding alike. Built on a decode thread with the
 * rest of the tile; the lookups run on the render thread.
 */

#include "core.h"

#define STRIDE_U16 6

typedef struct {
  u32 grid;               /*  0  cells per side, a power of two */
  u32 cellStartOffset;    /*  4  u32[grid * grid + 1] */
  u32 cellTrisOffset;     /*  8  u32[cellTrisCount] */
  u32 cellTrisCount;      /* 12 */
  u32 triangleCount;      /* 16 */
  u32 status;             /* 20  0 ok, 1 out of memory */
  u32 reserved[2];        /* 24 */
} SolidIndex;             /* 32 bytes */

/* About two triangles per cell. Building walls are thin in plan, so a wall
 * lands in a row of cells rather than a block of them. */
static u32 grid_size(u32 triangles) {
  u32 g = 4;
  while (g < 256 && g * g * 2u < triangles) g <<= 1;
  return g;
}

INLINE u32 min3(u32 a, u32 b, u32 c) { u32 m = a < b ? a : b; return m < c ? m : c; }
INLINE u32 max3(u32 a, u32 b, u32 c) { u32 m = a > b ? a : b; return m > c ? m : c; }

INLINE u32 index_at(const void *idx, u32 narrow, u32 i) {
  return narrow ? (u32)((const u16 *)idx)[i] : ((const u32 *)idx)[i];
}

/*
 * Whether the line through p and q keeps a square [x0,x1]x[y0,y1] entirely
 * off the triangle p, q, r (seen from above). Along the line's normal, p and
 * q sit at 0 and r at `side`; the triangle spans 0..side there. A triangle
 * seen edge-on, a wall, has side 0 and is the segment itself. Integer
 * coordinates, so everything is exact.
 */
INLINE int edge_separates(i64 px, i64 py, i64 qx, i64 qy, i64 rx, i64 ry,
                          i64 x0, i64 y0, i64 x1, i64 y1) {
  i64 nx = py - qy, ny = qx - px;
  if (nx == 0 && ny == 0) return 0;               /* p and q coincide */
  i64 e = nx * px + ny * py;
  i64 side = nx * rx + ny * ry - e;
  i64 lo = nx * (nx > 0 ? x0 : x1) + ny * (ny > 0 ? y0 : y1) - e;
  i64 hi = nx * (nx > 0 ? x1 : x0) + ny * (ny > 0 ? y1 : y0) - e;
  i64 tmin = side < 0 ? side : 0, tmax = side > 0 ? side : 0;
  return hi < tmin || lo > tmax;
}

/* Whether a triangle's footprint touches cell (cx, cy), edges included. The
 * cells tried lie inside the footprint's box already, which settles the two
 * axis directions; the three edge normals settle the rest (separating axes). */
INLINE int touches_cell(const u16 *A, const u16 *B, const u16 *C, u32 cx, u32 cy, u32 shift) {
  i64 x0 = (i64)cx << shift, y0 = (i64)cy << shift;
  i64 x1 = x0 + ((i64)1 << shift), y1 = y0 + ((i64)1 << shift);
  i64 ax = A[0], ay = A[1], bx = B[0], by = B[1], qx = C[0], qy = C[1];
  return !edge_separates(ax, ay, bx, by, qx, qy, x0, y0, x1, y1) &&
         !edge_separates(bx, by, qx, qy, ax, ay, x0, y0, x1, y1) &&
         !edge_separates(qx, qy, ax, ay, bx, by, x0, y0, x1, y1);
}

/**
 * @param vertexOff   u16 x6 per vertex, as mesh_quantize writes them
 * @param idxOff      the drawn triangles' indices, u16 when `narrow`, else u32
 * @param resOff      where to write the SolidIndex header
 */
EXPORT u32 mesh_solid(u32 vertexOff, u32 vertexCount, u32 idxOff, u32 indexCount, u32 narrow, u32 resOff) {
  SolidIndex *res = (SolidIndex *)PTR(resOff);
  memset(res, 0, sizeof(SolidIndex));
  const u16 *v = (const u16 *)PTR(vertexOff);
  const void *idx = PTR(idxOff);
  u32 tc = indexCount / 3u;
  u32 g = grid_size(tc);
  u32 shift = 16u;
  for (u32 s = g; s > 1; s >>= 1) shift--;       /* 16 - log2(g) */
  u32 cells = g * g;

  /* ---- pass 1: how many triangles land in each cell ---- */
  u32 startOff = arena_alloc((cells + 1u) * 4u);
  if (!startOff) return (res->status = 1);
  u32 *start = (u32 *)PTR(startOff);
  memset(start, 0, (cells + 1u) * 4u);

  u32 total = 0;
  for (u32 t = 0; t < tc; t++) {
    u32 a = index_at(idx, narrow, t * 3), b = index_at(idx, narrow, t * 3 + 1), c = index_at(idx, narrow, t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const u16 *A = v + a * STRIDE_U16, *B = v + b * STRIDE_U16, *C = v + c * STRIDE_U16;
    u32 x0 = min3(A[0], B[0], C[0]) >> shift, x1 = max3(A[0], B[0], C[0]) >> shift;
    u32 y0 = min3(A[1], B[1], C[1]) >> shift, y1 = max3(A[1], B[1], C[1]) >> shift;
    u32 single = x0 == x1 && y0 == y1;
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++)
        if (single || touches_cell(A, B, C, x, y, shift)) { start[y * g + x + 1u]++; total++; }
  }
  for (u32 i = 1; i <= cells; i++) start[i] += start[i - 1u];

  /* ---- pass 2: file each triangle under its cells ---- */
  u32 listOff = arena_alloc((total ? total : 1u) * 4u);
  u32 cursorOff = arena_alloc(cells * 4u);
  if (!listOff || !cursorOff) return (res->status = 1);
  u32 *list = (u32 *)PTR(listOff);
  u32 *cursor = (u32 *)PTR(cursorOff);
  memcpy(cursor, start, cells * 4u);

  for (u32 t = 0; t < tc; t++) {
    u32 a = index_at(idx, narrow, t * 3), b = index_at(idx, narrow, t * 3 + 1), c = index_at(idx, narrow, t * 3 + 2);
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
    const u16 *A = v + a * STRIDE_U16, *B = v + b * STRIDE_U16, *C = v + c * STRIDE_U16;
    u32 x0 = min3(A[0], B[0], C[0]) >> shift, x1 = max3(A[0], B[0], C[0]) >> shift;
    u32 y0 = min3(A[1], B[1], C[1]) >> shift, y1 = max3(A[1], B[1], C[1]) >> shift;
    u32 single = x0 == x1 && y0 == y1;
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++)
        if (single || touches_cell(A, B, C, x, y, shift)) list[cursor[y * g + x]++] = t;
  }

  res->grid = g;
  res->cellStartOffset = startOff;
  res->cellTrisOffset = listOff;
  res->cellTrisCount = total;
  res->triangleCount = tc;
  return 0;
}

EXPORT u32 mesh_solid_size(void) { return (u32)sizeof(SolidIndex); }
