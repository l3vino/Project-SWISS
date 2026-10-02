/* ground.c — what a walking camera stands on.
 *
 * Physics stands on exactly the triangles the renderer draws. A coarse tile
 * can sit tens of metres off the true ground, and standing on anything else
 * would put you visibly inside or above the mountain you are looking at. When
 * finer tiles arrive, the surface you stand on refines with them.
 *
 * A tile holds tens of thousands of triangles, so finding the one under a
 * point needs an index. This builds a uniform grid over the tile's quantized
 * coordinates and files every triangle under each cell its bounding box
 * touches, in compressed sparse row form: one array of cell starts, one flat
 * array of triangle numbers. A lookup then tests the handful of triangles in
 * one cell. The lookup itself runs in JavaScript on the render thread, where
 * the data has to live anyway; building the index is the heavy part and
 * happens here, on a decode thread.
 */

#include "qm.h"

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

/* Cells per side: about two triangles per cell, as a power of two so the cell
 * of a 15-bit coordinate is a multiply and a shift. */
static u32 grid_size(u32 triangles) {
  u32 g = 8;
  while (g < 128 && g * g * 2u < triangles) g <<= 1;
  return g;
}

INLINE u32 cell_of(u32 q, u32 shift) {
  /* q is 0..32767; (q * g) >> 15 lands in 0..g-1 for any power-of-two g. */
  return q >> shift;
}

INLINE u32 min3(u32 a, u32 b, u32 c) { u32 m = a < b ? a : b; return m < c ? m : c; }
INLINE u32 max3(u32 a, u32 b, u32 c) { u32 m = a > b ? a : b; return m > c ? m : c; }

/**
 * @param srcOff  tile bytes in linear memory, consumed by the parse
 * @param resOff  where to write the QmGround header
 */
EXPORT u32 qm_ground(u32 srcOff, u32 srcLen, u32 resOff) {
  QmGround *res = (QmGround *)PTR(resOff);
  memset(res, 0, sizeof(QmGround));

  QmMesh m;
  u32 status = qm_parse((u8 *)PTR(srcOff), srcLen, &m, 0);
  if (status != QM_OK) return (res->status = status);

  u32 n = m.vertexCount, tc = m.triangleCount;
  u32 g = grid_size(tc);
  u32 shift = 15u;
  for (u32 s = g; s > 1; s >>= 1) shift--;      /* 15 - log2(g) */
  u32 cells = g * g;

  /* ---- indices, narrowed when they fit ---- */
  u32 narrow = n <= 65536u;
  u32 iOff = arena_alloc(tc * 3u * (narrow ? 2u : 4u));
  if (!iOff) return (res->status = QM_OOM);
  if (narrow) {
    u16 *out = (u16 *)PTR(iOff);
    for (u32 i = 0; i < tc * 3u; i++) out[i] = (u16)m.tris[i];
  } else {
    memcpy(PTR(iOff), m.tris, tc * 12u);
  }

  /* ---- pass 1: how many triangles land in each cell ---- */
  u32 startOff = arena_alloc((cells + 1u) * 4u);
  if (!startOff) return (res->status = QM_OOM);
  u32 *start = (u32 *)PTR(startOff);
  memset(start, 0, (cells + 1u) * 4u);

  u32 total = 0;
  for (u32 t = 0; t < tc; t++) {
    u32 a = m.tris[t * 3], b = m.tris[t * 3 + 1], c = m.tris[t * 3 + 2];
    if (a >= n || b >= n || c >= n) continue;
    u32 x0 = cell_of(min3(m.u[a], m.u[b], m.u[c]), shift);
    u32 x1 = cell_of(max3(m.u[a], m.u[b], m.u[c]), shift);
    u32 y0 = cell_of(min3(m.v[a], m.v[b], m.v[c]), shift);
    u32 y1 = cell_of(max3(m.v[a], m.v[b], m.v[c]), shift);
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++) start[y * g + x + 1u]++;
    total += (x1 - x0 + 1u) * (y1 - y0 + 1u);
  }

  /* Prefix sum: start[i] becomes the first slot of cell i. */
  for (u32 i = 1; i <= cells; i++) start[i] += start[i - 1u];

  /* ---- pass 2: file each triangle under its cells ---- */
  u32 listOff = arena_alloc((total ? total : 1u) * 4u);
  u32 cursorOff = arena_alloc(cells * 4u);
  if (!listOff || !cursorOff) return (res->status = QM_OOM);
  u32 *list = (u32 *)PTR(listOff);
  u32 *cursor = (u32 *)PTR(cursorOff);
  memcpy(cursor, start, cells * 4u);

  for (u32 t = 0; t < tc; t++) {
    u32 a = m.tris[t * 3], b = m.tris[t * 3 + 1], c = m.tris[t * 3 + 2];
    if (a >= n || b >= n || c >= n) continue;
    u32 x0 = cell_of(min3(m.u[a], m.u[b], m.u[c]), shift);
    u32 x1 = cell_of(max3(m.u[a], m.u[b], m.u[c]), shift);
    u32 y0 = cell_of(min3(m.v[a], m.v[b], m.v[c]), shift);
    u32 y1 = cell_of(max3(m.v[a], m.v[b], m.v[c]), shift);
    for (u32 y = y0; y <= y1; y++)
      for (u32 x = x0; x <= x1; x++) list[cursor[y * g + x]++] = t;
  }

  res->minHeight = m.minHeight;
  res->maxHeight = m.maxHeight;
  res->vertexCount = n;
  res->triangleCount = tc;
  res->uvhOffset = OFF(m.u);
  res->indexOffset = iOff;
  res->indexIsU32 = narrow ? 0u : 1u;
  res->grid = g;
  res->cellStartOffset = startOff;
  res->cellTrisOffset = listOff;
  res->cellTrisCount = total;
  res->status = QM_OK;
  return QM_OK;
}

EXPORT u32 qm_ground_size(void) { return (u32)sizeof(QmGround); }
