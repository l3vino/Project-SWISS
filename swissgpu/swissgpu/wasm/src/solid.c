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
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++) start[y * g + x + 1u]++;
    total += (x1 - x0 + 1u) * (y1 - y0 + 1u);
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
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++) list[cursor[y * g + x]++] = t;
  }

  res->grid = g;
  res->cellStartOffset = startOff;
  res->cellTrisOffset = listOff;
  res->cellTrisCount = total;
  res->triangleCount = tc;
  return 0;
}

EXPORT u32 mesh_solid_size(void) { return (u32)sizeof(SolidIndex); }
