/* shape.c — roads, tracks, paths and railway beds cut into a terrain tile.
 *
 * swisstopo's elevation model has every road as a level ledge across the
 * slope it climbs (measured above Airolo: 0 to 13% across on 2 m data), but
 * the streamed terrain mesh keeps that ledge only in its finest levels; from
 * level 14 down the road lies on the bare hillside, tilted 26 to 79% (his
 * words: "if a road is on the side of a mountain, and it's really tilted
 * because of the terrain, delete the terrain above the road, so that road is
 * not tilted"). So a tile near the camera is reshaped as it is decoded, the
 * way Bruneton and Neyret shape terrain under vector features ("Real-time
 * rendering and editing of vector-based terrains", Eurographics 2008):
 *
 *   h = b · h_road + (1 − b) · h_terrain
 *
 * where h_road is the road's height along its centreline (its z-profile) and
 * b is 1 across the width held level and falls to 0 over a band on either
 * side: above the road the hillside is cut down to it, below it is filled up
 * to it. Their terrain is a height grid; this one is a triangle mesh, so the
 * mesh is first given vertices and edges exactly where the shape changes
 * (each piece's centreline, the edges of its level width, and the outer edges
 * of its bands) by splitting the triangles those lines cross. Every split
 * keeps the old surface exactly (a point on an edge or in a triangle gets the
 * height the flat triangle had there), so until the heights are changed the
 * mesh is the same terrain with more vertices; then every vertex takes the
 * height the rule gives it. The result is still one surface: roads are drawn
 * on it per pixel, physics stands on it (ground.c reshapes with the same
 * pieces, so it stands on exactly the triangles drawn), flights clear it.
 *
 * The z-profiles: the terrain under each line's centreline, as the mesh has
 * it (a coarse tile's surface can be a metre or two off, but level across
 * and at most that far off is what matters here); never steeper along the
 * line than its kind allows (a motorway 8%, a railway 4%: errors of a coarse
 * mesh are smoothed out); and where a line runs into a more important one
 * (a side road joining a main road on a slope, a road crossing a railway),
 * it takes that one's height there and leaves it at no more than its own
 * grade (Bruneton and Neyret enforce the same at junctions). Lines are shaped
 * most important first, so every line meets an already finished one.
 *
 * Bands: as wide as a 45° cut or a 34° fill (1:1.5) needs to reach the
 * terrain from the edge of the level width, so on a hillside steeper than
 * earth stands the face is steeper too, as rock is cut. Since Stage 5.16b
 * (his words: "try to soothen out the edgy slopes") the cross-section is
 * measured every SAMPLE_STEP metres along each line and smoothed along it
 * like the profile, where it used to be one band and one face per piece:
 * two pieces side by side could take faces of 45° and 76°, and the vertices
 * between them jumped by metres (the saw-teeth on the Gotthard road). The
 * face is rounded where it leaves the level width and where it meets the
 * ground (a cut's crest convex, a fill's toe concave, over ROUND metres:
 * US highway practice rounds over 1.5 to 3 m), and a line of vertices runs
 * along each crest, so the top of a cut is a clean curve, not the zigzag of
 * whatever triangles were there. A piece whose terrain is already level
 * across (most of a town) changes nothing and is not inserted at all.
 * Where the bands of several roads reach a point, the surfaces each would
 * make alone are blended (see the vertex rule), so one road's face never
 * stops in a wall where another's begins.
 *
 * Distances along a line (the pieces' s0, s1) are true distances along it
 * from its start in its vector tile (js/formats/vector-tile.js
 * segmentArcs), rising along every line: the profiles and the
 * cross-sections are sampled and smoothed by them.
 *
 * Pins: where a line comes off a bridge, the render thread knows the height
 * of the bridge's deck there (swisstopo's 3D bridge, as drawn) and how it
 * slopes, and sends them as a pin, a piece of negative priority: the line's
 * profile takes that height there, goes on at the deck's grade, and eases
 * back onto its own over a ramp that changes its grade by PIN_GRADE at most
 * (between PIN_RAMP and PIN_RAMP_MOST metres), so the road meets the deck
 * instead of dipping with the ground under the bridge's last metres. A
 * deck more than PIN_MOST off the road's own height there does not meet
 * it (a viaduct ending in the air over a road beneath) and is left alone.
 *
 * Every vertex on a face is marked (m->face: cut or fill, and how much), so
 * the shader colours faces from the ground beside them rather than from the
 * photo's road and kerb smeared over them.
 */

#include "qm.h"

/* Optimised for size: this runs once a tile on a decode thread, and every
 * thread downloads and compiles the wasm at its start. */
#pragma clang attribute push (__attribute__((minsize)), apply_to = function)

#define NONE 0xFFFFFFFFu
#define Q 32767.0
/* Quantized units: points this close are one point. Positions end up as
 * whole units, so anything finer than half of one is lost anyway, and
 * snapping to it keeps triangles from turning into slivers that rounding
 * would flip (a unit is 0.6 cm on a level-18 tile, 1.9 cm on a level-15). */
#define EPS 0.75
#define CUT_SLOPE 1.0             /* tan 45° */
#define FILL_SLOPE 0.6667         /* tan 34°: 1:1.5 */
#define BAND_MIN 0.5              /* metres */
#define BAND_MAX 25.0
/* A piece whose ground across its level width rises or falls less than
 * this (a fraction of its half-width; a road's own camber is 2 to 3%), and
 * never less than LEVEL_MIN metres, is already level and left as it is. */
#define LEVEL_SLOPE 0.04
#define LEVEL_MIN 0.05
#define BAND_LINE 1.0             /* metres: a band narrower than this gets no line of its own */
#define PROBE 4.0                 /* metres beyond the level width the hillside's slope is read over */
#define FACE_MOST 4.0             /* the steepest face, rise per metre (76°) */
#define SAMPLE_STEP 2.0           /* metres between profile samples along a line */
#define SMOOTH 6.0                /* metres either way the profile is smoothed over */
#define GAP 4.5                   /* metres between samples beyond which a line has left the tile */
#define MITRE_MOST 2.0            /* an offset line's corner reaches at most this many offsets out */
#define XS_SMOOTH 6.0             /* metres either way a cross-section (band, face, crest) is smoothed over */
#define XS_STEP 6.0               /* metres between the points of a crest or band line along a piece */
#define ROUND 1.5                 /* metres over which a face is rounded into the ground (FHWA's default 5 ft) */
#define FOOT 0.5                  /* metres over which a face leaves the level width */
#define EARTH_CUT 0.7             /* a hillside steeper than this (35°) is cut as rock, earth at 45° */
#define EARTH_FILL 0.5            /* and one falling away steeper than this (27°) is filled as rock */
#define CREST_LINE 0.8            /* metres: a crest nearer the level width gets no line of its own */
#define PIN_RAMP 12.0             /* metres: a pin eases back onto the profile over this at least */
#define PIN_GRADE 0.06            /* and changes the grade by this at most */
#define PIN_RAMP_MOST 40.0        /* but over this at most */
#define PIN_MOST 5.0              /* metres: a deck this far off the road's own height does not meet it */

/* ---- a triangulation that can be split ------------------------------------ */

typedef struct {
  double *x, *y, *z;        /* quantized u and v, height in metres */
  u8 *fresh;                /* 1 for a vertex added here */
  u32 *vtri;                /* a triangle containing the vertex */
  u32 n, cap;
  u32 *t;                   /* 3 vertices per triangle, counter-clockwise seen from above */
  u32 *adj;                 /* 3 per triangle: the neighbour across edge k (vertex k to k+1) */
  u32 tn, tcap;
  u32 last;                 /* where the last search ended: the next one starts there */
  int oom;
} Tin;

static void *take(u32 bytes, int *oom) {
  u32 off = arena_alloc(bytes ? bytes : 16u);
  if (!off) { *oom = 1; return 0; }
  return PTR(off);
}

/* Word copies: memcpy in core.c is a byte loop. */
static void copy_words(void *dst, const void *src, u32 bytes) {
  u32 *d = (u32 *)dst;
  const u32 *s = (const u32 *)src;
  for (u32 i = 0, n = bytes >> 2; i < n; i++) d[i] = s[i];
  for (u32 i = bytes & ~3u; i < bytes; i++) ((u8 *)dst)[i] = ((const u8 *)src)[i];
}

static int grow_vertices(Tin *T, u32 need) {
  if (need <= T->cap) return 1;
  u32 cap = T->cap * 2u;
  if (cap < need) cap = need;
  double *x = (double *)take(cap * 8u, &T->oom), *y = (double *)take(cap * 8u, &T->oom), *z = (double *)take(cap * 8u, &T->oom);
  u8 *fr = (u8 *)take(cap, &T->oom);
  u32 *vt = (u32 *)take(cap * 4u, &T->oom);
  if (T->oom) return 0;
  copy_words(x, T->x, T->n * 8u); copy_words(y, T->y, T->n * 8u); copy_words(z, T->z, T->n * 8u);
  copy_words(fr, T->fresh, T->n); copy_words(vt, T->vtri, T->n * 4u);
  T->x = x; T->y = y; T->z = z; T->fresh = fr; T->vtri = vt; T->cap = cap;
  return 1;
}

static int grow_triangles(Tin *T, u32 need) {
  if (need <= T->tcap) return 1;
  u32 cap = T->tcap * 2u;
  if (cap < need) cap = need;
  u32 *t = (u32 *)take(cap * 12u, &T->oom), *a = (u32 *)take(cap * 12u, &T->oom);
  if (T->oom) return 0;
  copy_words(t, T->t, T->tn * 12u); copy_words(a, T->adj, T->tn * 12u);
  T->t = t; T->adj = a; T->tcap = cap;
  return 1;
}

INLINE double orient(double ax, double ay, double bx, double by, double cx, double cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/* The neighbour `tri` points to `from` across some edge: now to `to`. */
static void repoint(Tin *T, u32 tri, u32 from, u32 to) {
  if (tri == NONE) return;
  for (u32 k = 0; k < 3; k++) if (T->adj[tri * 3 + k] == from) { T->adj[tri * 3 + k] = to; return; }
}

static u32 add_vertex(Tin *T, double x, double y, double z) {
  if (!grow_vertices(T, T->n + 1u)) return NONE;
  u32 v = T->n++;
  T->x[v] = x; T->y[v] = y; T->z[v] = z;
  T->fresh[v] = 1;
  T->vtri[v] = NONE;
  return v;
}

static void set_tri(Tin *T, u32 t, u32 a, u32 b, u32 c, u32 na, u32 nb, u32 nc) {
  T->t[t * 3] = a; T->t[t * 3 + 1] = b; T->t[t * 3 + 2] = c;
  T->adj[t * 3] = na; T->adj[t * 3 + 1] = nb; T->adj[t * 3 + 2] = nc;
}

/* Splits edge k of triangle t (from its vertex k to k + 1) at (x, y), and
 * the triangle across it; the new vertex keeps the surface's height there. */
static u32 split_edge(Tin *T, u32 t, u32 k, double x, double y) {
  if (!grow_triangles(T, T->tn + 2u)) return NONE;
  u32 A = T->t[t * 3 + k], B = T->t[t * 3 + (k + 1) % 3], C = T->t[t * 3 + (k + 2) % 3];
  u32 s = T->adj[t * 3 + k], nBC = T->adj[t * 3 + (k + 1) % 3], nCA = T->adj[t * 3 + (k + 2) % 3];
  double ex = T->x[B] - T->x[A], ey = T->y[B] - T->y[A], l2 = ex * ex + ey * ey;
  double f = l2 > 0 ? ((x - T->x[A]) * ex + (y - T->y[A]) * ey) / l2 : 0.5;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  u32 w = add_vertex(T, T->x[A] + ex * f, T->y[A] + ey * f, T->z[A] + (T->z[B] - T->z[A]) * f);
  if (w == NONE) return NONE;
  u32 t1 = T->tn++;
  if (s == NONE) {
    set_tri(T, t, A, w, C, NONE, t1, nCA);
    set_tri(T, t1, w, B, C, NONE, nBC, t);
    repoint(T, nBC, t, t1);
  } else {
    u32 k2 = 0;
    while (k2 < 3 && !(T->t[s * 3 + k2] == B && T->t[s * 3 + (k2 + 1) % 3] == A)) k2++;
    if (k2 == 3) { T->oom = 2; return NONE; }   /* not a manifold edge */
    u32 D = T->t[s * 3 + (k2 + 2) % 3];
    u32 nAD = T->adj[s * 3 + (k2 + 1) % 3], nDB = T->adj[s * 3 + (k2 + 2) % 3];
    u32 s1 = T->tn++;
    set_tri(T, t, A, w, C, s1, t1, nCA);
    set_tri(T, t1, w, B, C, s, nBC, t);
    set_tri(T, s, B, w, D, t1, s1, nDB);
    set_tri(T, s1, w, A, D, t, nAD, s);
    repoint(T, nBC, t, t1);
    repoint(T, nAD, s, s1);
    T->vtri[D] = s;
  }
  T->vtri[A] = t; T->vtri[B] = t1; T->vtri[C] = t; T->vtri[w] = t;
  return w;
}

/* Splits triangle t at a point inside it. */
static u32 split_triangle(Tin *T, u32 t, double x, double y) {
  if (!grow_triangles(T, T->tn + 2u)) return NONE;
  u32 A = T->t[t * 3], B = T->t[t * 3 + 1], C = T->t[t * 3 + 2];
  u32 nAB = T->adj[t * 3], nBC = T->adj[t * 3 + 1], nCA = T->adj[t * 3 + 2];
  /* The height the flat triangle has there. */
  double d = orient(T->x[A], T->y[A], T->x[B], T->y[B], T->x[C], T->y[C]);
  double la = orient(x, y, T->x[B], T->y[B], T->x[C], T->y[C]) / d;
  double lb = orient(T->x[A], T->y[A], x, y, T->x[C], T->y[C]) / d;
  double z = la * T->z[A] + lb * T->z[B] + (1 - la - lb) * T->z[C];
  u32 w = add_vertex(T, x, y, z);
  if (w == NONE) return NONE;
  u32 t1 = T->tn++, t2 = T->tn++;
  set_tri(T, t, A, B, w, nAB, t1, t2);
  set_tri(T, t1, B, C, w, nBC, t2, t);
  set_tri(T, t2, C, A, w, nCA, t, t1);
  repoint(T, nBC, t, t1);
  repoint(T, nCA, t, t2);
  T->vtri[A] = t; T->vtri[B] = t; T->vtri[C] = t1; T->vtri[w] = t;
  return w;
}

/* The triangle containing (x, y), walking from the last one found. */
static u32 locate(Tin *T, double x, double y) {
  u32 t = T->last < T->tn ? T->last : 0;
  for (u32 step = 0; step < T->tn * 2u + 64u; step++) {
    const u32 *v = &T->t[t * 3];
    u32 next = NONE;
    for (u32 j = 0; j < 3; j++) {
      u32 k = (step + j) % 3;   /* a rotating first edge: no walking in circles */
      u32 a = v[k], b = v[(k + 1) % 3];
      if (orient(T->x[a], T->y[a], T->x[b], T->y[b], x, y) < -1e-7) { next = T->adj[t * 3 + k]; break; }
    }
    if (next == NONE) break;    /* inside, or past the tile's edge: the nearest there is */
    t = next;
  }
  T->last = t;
  return t;
}

/* The height of the surface at (x, y), as the mesh now is. */
static double height_at(Tin *T, double x, double y) {
  if (x < 0) x = 0;
  if (x > Q) x = Q;
  if (y < 0) y = 0;
  if (y > Q) y = Q;
  u32 t = locate(T, x, y);
  u32 A = T->t[t * 3], B = T->t[t * 3 + 1], C = T->t[t * 3 + 2];
  double d = orient(T->x[A], T->y[A], T->x[B], T->y[B], T->x[C], T->y[C]);
  if (d == 0) return T->z[A];
  double la = orient(x, y, T->x[B], T->y[B], T->x[C], T->y[C]) / d;
  double lb = orient(T->x[A], T->y[A], x, y, T->x[C], T->y[C]) / d;
  return la * T->z[A] + lb * T->z[B] + (1 - la - lb) * T->z[C];
}

/* A vertex at (x, y): an existing one within EPS, else a new one splitting
 * the edge or the triangle it lies on. */
static u32 insert_point(Tin *T, double x, double y) {
  u32 t = locate(T, x, y);
  const u32 *v = &T->t[t * 3];
  for (u32 k = 0; k < 3; k++) {
    double dx = T->x[v[k]] - x, dy = T->y[v[k]] - y;
    if (dx * dx + dy * dy < EPS * EPS) return v[k];
  }
  for (u32 k = 0; k < 3; k++) {
    u32 a = v[k], b = v[(k + 1) % 3];
    double ex = T->x[b] - T->x[a], ey = T->y[b] - T->y[a], l = m_sqrt(ex * ex + ey * ey);
    if (l <= 0) continue;
    double dist = orient(T->x[a], T->y[a], T->x[b], T->y[b], x, y) / l;
    double f = ((x - T->x[a]) * ex + (y - T->y[a]) * ey) / (l * l);
    if (dist < EPS && f > 0 && f < 1) return split_edge(T, t, k, x, y);
  }
  return split_triangle(T, t, x, y);
}

/* Where vertex v sits in triangle t, or 3. */
INLINE u32 corner(const Tin *T, u32 t, u32 v) {
  return T->t[t * 3] == v ? 0u : T->t[t * 3 + 1] == v ? 1u : T->t[t * 3 + 2] == v ? 2u : 3u;
}

/* The triangle round v that the way from v towards (qx, qy) enters; its
 * corner index of v comes back in *at. */
static u32 fan_towards(Tin *T, u32 v, double qx, double qy, u32 *at) {
  u32 start = T->vtri[v];
  if (start == NONE || corner(T, start, v) == 3) return NONE;
  double vx = T->x[v], vy = T->y[v];
  for (int dir = 0; dir < 2; dir++) {
    u32 t = start;
    for (u32 guard = 0; guard < 256 && t != NONE; guard++) {
      u32 i = corner(T, t, v);
      if (i == 3) break;
      u32 B = T->t[t * 3 + (i + 1) % 3], C = T->t[t * 3 + (i + 2) % 3];
      double ob = orient(vx, vy, T->x[B], T->y[B], qx, qy);
      double oc = orient(vx, vy, T->x[C], T->y[C], qx, qy);
      if (ob >= 0 && oc <= 0) { *at = i; return t; }
      /* Counter-clockwise round v across the edge into v, clockwise across the one out of it. */
      u32 next = dir == 0 ? T->adj[t * 3 + (i + 2) % 3] : T->adj[t * 3 + i];
      if (next == start) break;
      t = next;
    }
  }
  return NONE;
}

/* Inserts the segment from (px, py) to (qx, qy) as a chain of edges. The
 * vertices along it, in order, go to `chain` (at most `most`); returns how
 * many. */
static u32 insert_segment(Tin *T, double px, double py, double qx, double qy, u32 *chain, u32 most) {
  u32 vp = insert_point(T, px, py);
  if (vp == NONE) return 0;
  u32 vq = insert_point(T, qx, qy);
  if (vq == NONE) return 0;
  u32 count = 0;
  if (count < most) chain[count++] = vp;
  u32 v = vp;
  for (u32 guard = 0; guard < 65536 && v != vq && !T->oom; guard++) {
    qx = T->x[vq]; qy = T->y[vq];
    u32 i, t = fan_towards(T, v, qx, qy, &i);
    if (t == NONE) break;
    u32 B = T->t[t * 3 + (i + 1) % 3], C = T->t[t * 3 + (i + 2) % 3];
    double vx = T->x[v], vy = T->y[v];
    double dx = qx - vx, dy = qy - vy, len = m_sqrt(dx * dx + dy * dy);
    if (len < EPS) break;
    u32 next = NONE;
    if (B == vq || C == vq) next = vq;
    else {
      /* Straight through a corner of the triangle: on to it. */
      double ob = orient(vx, vy, T->x[B], T->y[B], qx, qy) / len;
      double oc = orient(vx, vy, T->x[C], T->y[C], qx, qy) / len;
      if (m_abs(ob) < EPS && (T->x[B] - vx) * dx + (T->y[B] - vy) * dy > 0) next = B;
      else if (m_abs(oc) < EPS && (T->x[C] - vx) * dx + (T->y[C] - vy) * dy > 0) next = C;
      else {
        /* Through the far edge, B to C. */
        double ex = T->x[C] - T->x[B], ey = T->y[C] - T->y[B];
        double den = dx * ey - dy * ex;
        if (den == 0) break;
        double s = ((T->x[B] - vx) * dy - (T->y[B] - vy) * dx) / den;
        double el = m_sqrt(ex * ex + ey * ey);
        if (s * el < EPS) next = B;
        else if ((1 - s) * el < EPS) next = C;
        else next = split_edge(T, t, (i + 1) % 3, T->x[B] + ex * s, T->y[B] + ey * s);
      }
    }
    if (next == NONE || next == v) break;
    v = next;
    if (count < most) chain[count++] = v;
  }
  return count;
}

/* Twice the area of a triangle in whole quantized units (positive
 * counter-clockwise), exactly. */
INLINE i64 area_q(const u16 *U, const u16 *V, u32 a, u32 b, u32 c) {
  return ((i64)U[b] - (i64)U[a]) * ((i64)V[c] - (i64)V[a]) - ((i64)V[b] - (i64)V[a]) * ((i64)U[c] - (i64)U[a]);
}

/* The part of the segment a to b inside the tile's square, as fractions of
 * it; 0 if none. */
static int clip_square(double ax, double ay, double bx, double by, double *t0, double *t1) {
  double dx = bx - ax, dy = by - ay;
  double p[4] = { -dx, dx, -dy, dy }, q[4] = { ax, Q - ax, ay, Q - ay };
  *t0 = 0; *t1 = 1;
  for (int k = 0; k < 4; k++) {
    if (p[k] == 0) { if (q[k] < 0) return 0; continue; }
    double r = q[k] / p[k];
    if (p[k] < 0) { if (r > *t1) return 0; if (r > *t0) *t0 = r; }
    else { if (r < *t0) return 0; if (r < *t1) *t1 = r; }
  }
  return *t1 - *t0 > 1e-9;
}

/* ---- lines and their z-profiles ------------------------------------------- */

/* How a face from the edge of the level width meets the ground: up where
 * the ground there is `rise` metres above the middle (a cut), down where it
 * is below (a fill), the ground going on outwards at `slope` (rise per
 * metre, up positive). Earth is cut at 45° and filled at 1:1.5 unless the
 * hillside itself is steeper than earth stands (EARTH_CUT, EARTH_FILL):
 * then the face is steeper than it by half again, as cuts in rock are (and
 * swissALTI3D's own road cuts: at 2,190 m above Airolo the ground rises 6 m
 * in the first metre beside the road), at most FACE_MOST. Gives the face's
 * slope, how far out it meets the ground (`meet`: a cut's crest, a fill's
 * toe), and the band: past that by a fifth and by the rounding, so the band
 * is never too narrow (one too wide costs nothing: the face meets the
 * ground first). */
static double band_for(double rise, double slope, double *face, double *meet) {
  int cut = rise > 0;
  double out = cut ? slope : -slope;          /* how the ground goes on away from the road */
  double least = cut ? CUT_SLOPE : FILL_SLOPE;
  double f = out < (cut ? EARTH_CUT : EARTH_FILL) ? least : 1.5 * out;
  if (f < least) f = least;
  if (f > FACE_MOST) f = FACE_MOST;
  *face = f;
  double gap = f - out, need = m_abs(rise);
  double m = gap > 0.05 ? need / gap : BAND_MAX;
  if (m > BAND_MAX) m = BAND_MAX;
  *meet = m;
  double band = gap > 0.05 ? 1.2 * m + 0.3 : BAND_MAX;
  if (band < m + ROUND) band = m + ROUND;
  return band < BAND_MIN ? BAND_MIN : band > BAND_MAX ? BAND_MAX : band;
}

/* Smooth minimum and maximum (polynomial, Quilez): equal to min and max
 * where a and b are more than k apart, a rounded joint where they are not. */
INLINE double smin(double a, double b, double k) {
  double lo = a < b ? a : b;
  if (k <= 0) return lo;
  double h = k - m_abs(a - b);
  if (h <= 0) return lo;
  h /= k;
  return lo - h * h * k * 0.25;
}
INLINE double smax(double a, double b, double k) { return -smin(-a, -b, k); }
INLINE double ease01(double t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/* Whether samples j - 1 and j of a line follow on from each other: in
 * order along it, and GAP apart at most (a line can leave the tile and come
 * back far on). */
INLINE int follows(const double *s, u32 j) { double d = s[j] - s[j - 1]; return d >= 0 && d <= GAP; }

/* Along a line's samples (s ascending): `out` gets each value's tent
 * average over r metres either way, of the most within r first when
 * `most`; only across samples that follow on from each other. `tmp`:
 * scratch. */
static void smooth_along(const double *s, const double *in, double *out, double *tmp, u32 n, double r, int most) {
  const double *src = in;
  if (most) {
    for (u32 i = 0; i < n; i++) {
      double v = in[i];
      for (u32 j = i; j > 0 && follows(s, j) && s[i] - s[j - 1] <= r; j--) if (in[j - 1] > v) v = in[j - 1];
      for (u32 j = i; j + 1 < n && follows(s, j + 1) && s[j + 1] - s[i] <= r; j++) if (in[j + 1] > v) v = in[j + 1];
      tmp[i] = v;
    }
    src = tmp;
  }
  for (u32 i = 0; i < n; i++) {
    double z = src[i], w = 1.0;
    for (u32 j = i; j > 0 && follows(s, j) && s[i] - s[j - 1] < r; j--) {
      double k = 1.0 - (s[i] - s[j - 1]) / r;
      z += k * src[j - 1]; w += k;
    }
    for (u32 j = i; j + 1 < n && follows(s, j + 1) && s[j + 1] - s[i] < r; j++) {
      double k = 1.0 - (s[j + 1] - s[i]) / r;
      z += k * src[j + 1]; w += k;
    }
    out[i] = z / w;
  }
}

typedef struct {
  u32 first, count;         /* its samples in the profile arrays */
  float priority, grade;
  u32 done;
} LineProfile;

/* A piece, ready to measure against: in metres from its start. */
typedef struct {
  double ax, ay;            /* start, quantized units */
  double ux, uy;            /* along it, a unit vector in metres */
  double len;               /* metres */
  double half, bandL, bandR;
  double faceL, faceR;      /* the slope of the face out of each side (rise or fall per metre) */
  double s0, s1;
  double in0, in1;          /* the stretch of s inside the tile (its profile is sampled only there) */
  u32 line;                 /* index into the line table */
  u32 used;                 /* inserted (not already level) */
  u32 level;                /* in the tile and level already: its width is left as it is */
} Prep;

/* Height of a line's profile at distance s along it. */
static double profile_at(const LineProfile *L, const double *ps, const double *pz, double s) {
  u32 a = L->first, n = L->count;
  if (n == 0) return 0;
  if (s <= ps[a]) return pz[a];
  if (s >= ps[a + n - 1]) return pz[a + n - 1];
  u32 lo = 0, hi = n - 1;
  while (hi - lo > 1) { u32 mid = (lo + hi) >> 1; if (ps[a + mid] <= s) lo = mid; else hi = mid; }
  double s0 = ps[a + lo], s1 = ps[a + hi];
  double f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
  return pz[a + lo] + (pz[a + hi] - pz[a + lo]) * f;
}

/* The distance along its line of the point `along` metres into a piece,
 * kept to the stretch inside the tile: a point near the tile's edge can lie
 * beside the part of a piece that leaves it, where the line's profile has
 * no samples (the next ones may be where it comes back, far on). */
INLINE double piece_s(const Prep *P, double along) {
  double s = P->s0 + (P->s1 - P->s0) * (P->len > 0 ? along / P->len : 0);
  return s < P->in0 ? P->in0 : s > P->in1 ? P->in1 : s;
}

/* Where a point is against a piece: distance across (metres, signed: left
 * of its direction positive) and along (metres from its start, clamped). */
INLINE void measure(const Prep *P, double mu, double mv, double x, double y, double *across, double *along) {
  double dx = (x - P->ax) * mu, dy = (y - P->ay) * mv;
  double t = dx * P->ux + dy * P->uy;
  if (t < 0) t = 0;
  if (t > P->len) t = P->len;
  double cx = dx - P->ux * t, cy = dy - P->uy * t;
  double d = m_sqrt(cx * cx + cy * cy);
  *across = (P->ux * cy - P->uy * cx) >= 0 ? d : -d;
  *along = t;
}

/* The bucket grid pieces are found by: 32 x 32 cells over the tile. */
#define GRID 32u
#define CELL (32768.0 / GRID)

/* ---- the call ---------------------------------------------------------------- */

void qm_unit_metres(double west, double south, double east, double north, double *mu, double *mv) {
  double lat = 0.5 * (south + north) * DEG2RAD, sl = m_sin(lat), cl = m_cos(lat);
  double w = 1.0 - WGS84_E2 * sl * sl, rw = m_sqrt(w);
  double primeVertical = WGS84_A / rw, meridian = WGS84_A * (1.0 - WGS84_E2) / (w * rw);
  *mu = (east - west) * DEG2RAD * primeVertical * cl / Q;
  *mv = (north - south) * DEG2RAD * meridian / Q;
}

/**
 * Shapes a parsed tile in place. `mu`, `mv`: metres per quantized unit east
 * and north. The vertices the mesh had keep their numbers (so the tile's own
 * normals still belong to them); new ones follow, and `m->recompute` flags
 * every vertex whose normal must be worked out again.
 */
u32 qm_shape(QmMesh *m, const RoadPiece *pieces, u32 count, double mu, double mv, ShapeStats *st) {
  memset(st, 0, sizeof(ShapeStats));
  st->pieces = count;
  st->vertices = m->vertexCount;
  st->triangles = m->triangleCount;
  if (!count) return 0;
  int oom = 0;
  const double hSpan = (double)m->maxHeight - (double)m->minHeight;

  /* The mesh, mutable. */
  Tin T;
  memset(&T, 0, sizeof(Tin));
  u32 n0 = m->vertexCount, tn0 = m->triangleCount;
  T.cap = n0 + n0 / 2u + 256u;
  T.tcap = tn0 + tn0 / 2u + 512u;
  T.x = (double *)take(T.cap * 8u, &oom); T.y = (double *)take(T.cap * 8u, &oom); T.z = (double *)take(T.cap * 8u, &oom);
  T.fresh = (u8 *)take(T.cap, &oom); T.vtri = (u32 *)take(T.cap * 4u, &oom);
  T.t = (u32 *)take(T.tcap * 12u, &oom); T.adj = (u32 *)take(T.tcap * 12u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 i = 0; i < n0; i++) {
    T.x[i] = m->u[i]; T.y[i] = m->v[i];
    T.z[i] = (double)m->minHeight + (m->h[i] / Q) * hSpan;
    T.fresh[i] = 0; T.vtri[i] = NONE;
  }
  T.n = n0;
  /* Triangles, counter-clockwise; adjacency through a table of directed edges. */
  u32 good = 0;
  for (u32 t = 0; t < tn0; t++) {
    u32 a = m->tris[t * 3], b = m->tris[t * 3 + 1], c = m->tris[t * 3 + 2];
    if (a >= n0 || b >= n0 || c >= n0 || a == b || b == c || c == a) continue;
    if (orient(T.x[a], T.y[a], T.x[b], T.y[b], T.x[c], T.y[c]) < 0) { u32 s = b; b = c; c = s; }
    T.t[good * 3] = a; T.t[good * 3 + 1] = b; T.t[good * 3 + 2] = c;
    good++;
  }
  T.tn = good;
  u32 hcap = 16;
  while (hcap < good * 6u) hcap <<= 1;
  u32 *hkey0 = (u32 *)take(hcap * 4u, &oom), *hkey1 = (u32 *)take(hcap * 4u, &oom), *hval = (u32 *)take(hcap * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 i = 0; i < hcap; i++) hval[i] = NONE;
  for (u32 t = 0; t < good; t++) {
    for (u32 k = 0; k < 3; k++) {
      u32 a = T.t[t * 3 + k], b = T.t[t * 3 + (k + 1) % 3];
      u32 h = (a * 73856093u ^ b * 19349663u) & (hcap - 1u);
      while (hval[h] != NONE) h = (h + 1u) & (hcap - 1u);
      hkey0[h] = a; hkey1[h] = b; hval[h] = t * 3 + k;
    }
    for (u32 k = 0; k < 3; k++) T.vtri[T.t[t * 3 + k]] = t;
  }
  for (u32 t = 0; t < good; t++) {
    for (u32 k = 0; k < 3; k++) {
      u32 a = T.t[t * 3 + k], b = T.t[t * 3 + (k + 1) % 3];
      u32 h = (b * 73856093u ^ a * 19349663u) & (hcap - 1u), nb = NONE;
      while (hval[h] != NONE) {
        if (hkey0[h] == b && hkey1[h] == a) { nb = hval[h] / 3u; break; }
        h = (h + 1u) & (hcap - 1u);
      }
      T.adj[t * 3 + k] = nb;
    }
  }

  /* Lines: their order by priority, their profiles. */
  u32 maxLine = 0;
  for (u32 i = 0; i < count; i++) { u32 l = (u32)pieces[i].line; if (l > maxLine) maxLine = l; }
  if (maxLine > (1u << 22)) return (st->status = QM_BAD_COUNT);
  u32 *lineIndex = (u32 *)take((maxLine + 1u) * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 i = 0; i <= maxLine; i++) lineIndex[i] = NONE;
  u32 nlines = 0;
  for (u32 i = 0; i < count; i++) { u32 l = (u32)pieces[i].line; if (lineIndex[l] == NONE) lineIndex[l] = nlines++; }
  LineProfile *lines = (LineProfile *)take(nlines * sizeof(LineProfile), &oom);
  Prep *prep = (Prep *)take(count * sizeof(Prep), &oom);
  if (oom) return (st->status = QM_OOM);
  memset(lines, 0, nlines * sizeof(LineProfile));

  /* Each piece measured; the ones whose ground is already level across are left out. */
  for (u32 i = 0; i < count; i++) {
    const RoadPiece *R = &pieces[i];
    Prep *P = &prep[i];
    P->line = lineIndex[(u32)R->line];
    P->used = 0;
    P->level = 0;
    if (R->priority < 0) continue;            /* a pin (see the top): applied with the profiles */
    LineProfile *L = &lines[P->line];
    if (R->priority > L->priority) L->priority = R->priority;
    L->grade = R->grade;
    P->ax = R->u0; P->ay = R->v0;
    double dx = (R->u1 - R->u0) * mu, dy = (R->v1 - R->v0) * mv;
    P->len = m_sqrt(dx * dx + dy * dy);
    P->ux = P->len > 0 ? dx / P->len : 1; P->uy = P->len > 0 ? dy / P->len : 0;
    P->half = R->half; P->s0 = R->s0; P->s1 = R->s1;
    P->bandL = P->bandR = BAND_MIN;
    P->faceL = P->faceR = 0;
    double t0, t1;
    if (P->len < 0.05 || !clip_square(R->u0, R->v0, R->u1, R->v1, &t0, &t1)) continue;
    {
      double a = R->s0 + (R->s1 - R->s0) * t0, b = R->s0 + (R->s1 - R->s0) * t1;
      P->in0 = a < b ? a : b; P->in1 = a < b ? b : a;
    }
    /* Across the piece at three places: how far the ground at the edges of
     * the level width is above or below the middle, and how it slopes on
     * beyond them; so how far out a 45° cut (or a 1:1.5 fill) from each
     * edge meets the ground again: the band. Where the hillside is as steep
     * as the face, they never meet: the widest band, its last quarter a
     * steep step back to the ground (a rock cut). */
    double worst = 0;
    for (u32 k = 0; k < 3; k++) {
      double f = t0 + (t1 - t0) * (0.1 + 0.4 * k);
      double cx = R->u0 + (R->u1 - R->u0) * f, cy = R->v0 + (R->v1 - R->v0) * f;
      double nx = -P->uy / mu, ny = P->ux / mv;   /* a metre to the left, quantized units */
      double h = P->half, o = P->half + PROBE;
      double zc = height_at(&T, cx, cy);
      double zl = height_at(&T, cx + nx * h, cy + ny * h), zr = height_at(&T, cx - nx * h, cy - ny * h);
      double zl2 = height_at(&T, cx + nx * o, cy + ny * o), zr2 = height_at(&T, cx - nx * o, cy - ny * o);
      double fl, fr, ml, mr;
      double bl = band_for(zl - zc, (zl2 - zl) / PROBE, &fl, &ml), br = band_for(zr - zc, (zr2 - zr) / PROBE, &fr, &mr);
      if (bl > P->bandL) P->bandL = bl;
      if (br > P->bandR) P->bandR = br;
      if (fl > P->faceL) P->faceL = fl;
      if (fr > P->faceR) P->faceR = fr;
      if (m_abs(zl - zc) > worst) worst = m_abs(zl - zc);
      if (m_abs(zr - zc) > worst) worst = m_abs(zr - zc);
    }
    if (P->bandL > BAND_MAX) P->bandL = BAND_MAX;
    if (P->bandR > BAND_MAX) P->bandR = BAND_MAX;
    if (worst < LEVEL_MIN || worst < LEVEL_SLOPE * P->half) { st->skipped++; P->level = 1; continue; }
    P->used = 1;
    st->used++;
  }

  /* Each line's used pieces in order along it, as runs of pieces that
   * follow on from each other. Along every run, every SAMPLE_STEP metres
   * inside the tile: the terrain under its middle (its profile), and across
   * it the ground at the edges of its level width and PROBE metres beyond,
   * read into the face either side (band_for). Then, those smoothed along
   * the line, each run goes into the mesh as continuous lines offset from
   * its middle (mitred at its corners, so neighbouring pieces' edges never
   * cross at a bend): the edges of its level width, and where its bands are
   * wide enough the crests of its faces and the bands' outer edges. Its
   * middle needs no line of its own: the level width is flat across. */
  u32 *order = (u32 *)take(count * 4u + 4u, &oom);
  u32 *lineStart = (u32 *)take((nlines + 1u) * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  memset(lineStart, 0, (nlines + 1u) * 4u);
  for (u32 i = 0; i < count; i++) if (prep[i].used) lineStart[prep[i].line + 1u]++;
  for (u32 l = 0; l < nlines; l++) lineStart[l + 1u] += lineStart[l];
  {
    u32 *fill = (u32 *)take(nlines * 4u + 4u, &oom);
    if (oom) return (st->status = QM_OOM);
    copy_words(fill, lineStart, nlines * 4u);
    for (u32 i = 0; i < count; i++) if (prep[i].used) order[fill[prep[i].line]++] = i;
  }
  for (u32 l = 0; l < nlines; l++) {     /* insertion sort by distance along: tens of pieces a line */
    u32 *o = order + lineStart[l], n = lineStart[l + 1u] - lineStart[l];
    for (u32 i = 1; i < n; i++) {
      u32 v = o[i], j = i;
      double s0 = prep[v].s0 < prep[v].s1 ? prep[v].s0 : prep[v].s1;
      while (j > 0 && (prep[o[j - 1]].s0 < prep[o[j - 1]].s1 ? prep[o[j - 1]].s0 : prep[o[j - 1]].s1) > s0) { o[j] = o[j - 1]; j--; }
      o[j] = v;
    }
  }
  /* The runs: [runFrom, runTo) into each line's order. */
  u32 *runFrom = (u32 *)take(count * 4u + 4u, &oom), *runTo = (u32 *)take(count * 4u + 4u, &oom);
  u32 *runLine = (u32 *)take(count * 4u + 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  u32 nruns = 0;
  for (u32 l = 0; l < nlines; l++) {
    u32 *o = order + lineStart[l], n = lineStart[l + 1u] - lineStart[l];
    for (u32 a = 0; a < n;) {
      u32 b = a + 1u;
      while (b < n) {
        const RoadPiece *E = &pieces[o[b - 1u]], *F = &pieces[o[b]];
        double gx = F->u0 - E->u1, gy = F->v0 - E->v1;
        if (gx * gx + gy * gy > 1.0 || m_abs(F->s0 - E->s1) > 0.5) break;
        b++;
      }
      runFrom[nruns] = a; runTo[nruns] = b; runLine[nruns] = l; nruns++;
      a = b;
    }
  }

  /* Samples: s, the middle's height, and per side the band, the face's
   * slope and where it meets the ground. */
  u32 sampleCap = 4096, nsamples = 0;
  double *sampS = (double *)take(sampleCap * 8u, &oom), *sampZ = (double *)take(sampleCap * 8u, &oom);
  double *sampX = (double *)take(sampleCap * 6u * 8u, &oom);
  u32 *sampLine = (u32 *)take(sampleCap * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 r = 0; r < nruns; r++) {
    u32 l = runLine[r], *o = order + lineStart[l];
    for (u32 k = runFrom[r]; k < runTo[r]; k++) {
      const RoadPiece *R = &pieces[o[k]];
      const Prep *P = &prep[o[k]];
      u32 steps = (u32)(P->len / SAMPLE_STEP) + 1u;
      double nx = -P->uy / mu, ny = P->ux / mv;   /* a metre to the left, quantized units */
      for (u32 j = k > runFrom[r] ? 1u : 0u; j <= steps; j++) {
        double f = (double)j / steps;
        double x = R->u0 + (R->u1 - R->u0) * f, y = R->v0 + (R->v1 - R->v0) * f;
        if (x < 0 || y < 0 || x > Q || y > Q) continue;
        if (nsamples >= sampleCap) {
          u32 cap = sampleCap * 2u;
          double *s2 = (double *)take(cap * 8u, &oom), *z2 = (double *)take(cap * 8u, &oom), *x2 = (double *)take(cap * 6u * 8u, &oom);
          u32 *l2 = (u32 *)take(cap * 4u, &oom);
          if (oom) return (st->status = QM_OOM);
          copy_words(s2, sampS, nsamples * 8u); copy_words(z2, sampZ, nsamples * 8u);
          copy_words(x2, sampX, nsamples * 6u * 8u); copy_words(l2, sampLine, nsamples * 4u);
          sampS = s2; sampZ = z2; sampX = x2; sampLine = l2; sampleCap = cap;
        }
        double h = P->half, ofs = P->half + PROBE;
        double zc = height_at(&T, x, y);
        double zl = height_at(&T, x + nx * h, y + ny * h), zr = height_at(&T, x - nx * h, y - ny * h);
        double zl2 = height_at(&T, x + nx * ofs, y + ny * ofs), zr2 = height_at(&T, x - nx * ofs, y - ny * ofs);
        double *X = sampX + nsamples * 6u;
        X[0] = band_for(zl - zc, (zl2 - zl) / PROBE, &X[2], &X[4]);
        X[1] = band_for(zr - zc, (zr2 - zr) / PROBE, &X[3], &X[5]);
        sampS[nsamples] = P->s0 + (P->s1 - P->s0) * f;
        sampZ[nsamples] = zc;
        sampLine[nsamples] = l;
        nsamples++;
      }
    }
  }

  /* Samples grouped by line (they came in order along each): s, the
   * profile (smoothed, then anchored), the raw terrain, and the smoothed
   * cross-section: bands, faces and meeting points, left and right. */
  u32 ns8 = nsamples * 8u + 8u;
  double *ps = (double *)take(ns8, &oom), *pz = (double *)take(ns8, &oom), *praw = (double *)take(ns8, &oom);
  double *pbl = (double *)take(ns8, &oom), *pbr = (double *)take(ns8, &oom);
  double *pfl = (double *)take(ns8, &oom), *pfr = (double *)take(ns8, &oom);
  double *pml = (double *)take(ns8, &oom), *pmr = (double *)take(ns8, &oom);
  double *scratchA = (double *)take(ns8, &oom), *scratchB = (double *)take(ns8, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 i = 0; i < nsamples; i++) lines[sampLine[i]].count++;
  for (u32 l = 0, at = 0; l < nlines; l++) { lines[l].first = at; at += lines[l].count; lines[l].count = 0; }
  {
    double *raw6[6] = { pbl, pbr, pfl, pfr, pml, pmr };
    for (u32 i = 0; i < nsamples; i++) {
      LineProfile *L = &lines[sampLine[i]];
      u32 at = L->first + L->count++;
      ps[at] = sampS[i]; praw[at] = pz[at] = sampZ[i];
      for (u32 c = 0; c < 6; c++) raw6[c][at] = sampX[i * 6u + c];
    }
    /* Smoothed along each line: bands and meeting points by the most
     * within XS_SMOOTH first (never narrower than a neighbour needs), the
     * faces' slopes as they are; then all by a tent over XS_SMOOTH. */
    for (u32 l = 0; l < nlines; l++) {
      u32 first = lines[l].first, n = lines[l].count;
      if (n < 2) continue;
      for (u32 c = 0; c < 6; c++) {
        double *a = raw6[c] + first;
        for (u32 i = 0; i < n; i++) scratchA[i] = a[i];
        smooth_along(ps + first, scratchA, a, scratchB, n, XS_SMOOTH, c < 2 || c >= 4);
      }
    }
  }
  /* What each piece's bands reach at most, for the buckets: its own three
   * probes, or the smoothed bands along it if wider. */
  for (u32 i = 0; i < count; i++) {
    Prep *P = &prep[i];
    if (!P->used) continue;
    const LineProfile *L = &lines[P->line];
    double lo = (P->s0 < P->s1 ? P->s0 : P->s1) - 1.0, hi = (P->s0 < P->s1 ? P->s1 : P->s0) + 1.0;
    for (u32 k = L->first, e = L->first + L->count; k < e; k++) {
      if (ps[k] < lo || ps[k] > hi) continue;
      if (pbl[k] > P->bandL) P->bandL = pbl[k];
      if (pbr[k] > P->bandR) P->bandR = pbr[k];
    }
  }

  /* The offset lines. */
  u32 chainCap = 8192;
  u32 *chain = (u32 *)take(chainCap * 4u, &oom);
  /* A run's corners: position (quantized units), the mitre (a unit normal
   * scaled so the offset there is right on both pieces), the level width. */
  u32 cornerCap = 256;
  double *cx = (double *)take(cornerCap * 8u, &oom), *cy = (double *)take(cornerCap * 8u, &oom);
  double *mx = (double *)take(cornerCap * 8u, &oom), *my = (double *)take(cornerCap * 8u, &oom);
  double *ch = (double *)take(cornerCap * 8u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 r = 0; r < nruns && !T.oom; r++) {
    u32 l = runLine[r], *o = order + lineStart[l] + runFrom[r];
    u32 m = runTo[r] - runFrom[r];       /* pieces; corners m + 1 */
    const LineProfile *Ln = &lines[l];
    if (m + 1u > cornerCap) {
      u32 cap = (m + 1u) * 2u;
      cx = (double *)take(cap * 8u, &oom); cy = (double *)take(cap * 8u, &oom);
      mx = (double *)take(cap * 8u, &oom); my = (double *)take(cap * 8u, &oom);
      ch = (double *)take(cap * 8u, &oom);
      if (oom) return (st->status = QM_OOM);
      cornerCap = cap;
    }
    for (u32 k = 0; k <= m; k++) {
      const Prep *A = k > 0 ? &prep[o[k - 1u]] : 0, *B = k < m ? &prep[o[k]] : 0;
      const RoadPiece *R = B ? &pieces[o[k]] : &pieces[o[k - 1u]];
      cx[k] = B ? R->u0 : R->u1; cy[k] = B ? R->v0 : R->v1;
      /* Left normals of the pieces either side (metres), and their mitre. */
      double ax = A ? -A->uy : -B->uy, ay = A ? A->ux : B->ux;
      double bx = B ? -B->uy : ax, by = B ? B->ux : ay;
      double sx = ax + bx, sy = ay + by, sl = m_sqrt(sx * sx + sy * sy);
      double nx = sl > 1e-6 ? sx / sl : bx, ny = sl > 1e-6 ? sy / sl : by;
      double c = nx * bx + ny * by, scale = c > 1.0 / MITRE_MOST ? 1.0 / c : MITRE_MOST;
      mx[k] = nx * scale / mu; my[k] = ny * scale / mv;
      ch[k] = A && B ? (A->half > B->half ? A->half : B->half) : (A ? A->half : B->half);
    }
    /* Per piece, cut to the tile: the level width's edges straight from
     * corner to corner; the crests (where a face meets the ground, rounded
     * over ROUND either side) and, where a rock face never meets it, the
     * band's edge (the step back down), through points every XS_STEP metres
     * where the cross-section changes along the piece, so they follow it.
     * Elsewhere the rounded face joins the ground smoothly and its band's
     * edge needs no line. */
    for (u32 k = 0; k < m && !T.oom; k++) {
      const Prep *P = &prep[o[k]];
      const RoadPiece *R = &pieces[o[k]];
      double pnx = -P->uy / mu, pny = P->ux / mv;
      u32 parts = 1u;
      {
        double lo = (P->s0 < P->s1 ? P->s0 : P->s1), hi = (P->s0 < P->s1 ? P->s1 : P->s0);
        double most = -1e30, least = 1e30;
        for (u32 q = Ln->first, e = Ln->first + Ln->count; q < e; q++) {
          if (ps[q] < lo || ps[q] > hi) continue;
          double a = pml[q] > pmr[q] ? pml[q] : pmr[q], b = pml[q] < pmr[q] ? pml[q] : pmr[q];
          if (a > most) most = a;
          if (b < least) least = b;
        }
        if (most - least > 0.3) parts = (u32)(P->len / XS_STEP) + 1u;
      }
      for (u32 side = 0; side < 6 && !T.oom; side++) {
        double sign = (side & 1u) ? -1.0 : 1.0;
        u32 what = side >> 1;            /* 0 the level width, 1 the crest, 2 the band */
        u32 n2 = what == 0 ? 1u : parts;
        for (u32 q = 0; q < n2 && !T.oom; q++) {
          double f0 = (double)q / n2, f1 = (double)(q + 1u) / n2;
          double ox[2], oy[2];
          int skip = 0;
          for (u32 e = 0; e < 2; e++) {
            double f = e ? f1 : f0;
            double px = R->u0 + (R->u1 - R->u0) * f, py = R->v0 + (R->v1 - R->v0) * f;
            /* At the piece's ends, the corners' mitres; between, its own normal. */
            double nxq = f <= 0 ? mx[k] : f >= 1 ? mx[k + 1u] : pnx;
            double nyq = f <= 0 ? my[k] : f >= 1 ? my[k + 1u] : pny;
            double half = f <= 0 ? ch[k] : f >= 1 ? ch[k + 1u] : P->half;
            double sq = piece_s(P, f * P->len);
            double o2 = half;
            if (what) {
              double band = profile_at(Ln, ps, sign > 0 ? pbl : pbr, sq);
              double meet = profile_at(Ln, ps, sign > 0 ? pml : pmr, sq);
              if (what == 1) { if (meet < CREST_LINE || band - meet < 0.5 || band < BAND_LINE) skip = 1; o2 = half + meet; }
              else { if (band < BAND_LINE || meet < 0.75 * band) skip = 1; o2 = half + band; }
            }
            ox[e] = px + nxq * o2 * sign; oy[e] = py + nyq * o2 * sign;
          }
          if (what && (skip || !Ln->count)) continue;
          double t0, t1;
          if (!clip_square(ox[0], oy[0], ox[1], oy[1], &t0, &t1)) continue;
          insert_segment(&T, ox[0] + (ox[1] - ox[0]) * t0, oy[0] + (oy[1] - oy[0]) * t0,
                         ox[0] + (ox[1] - ox[0]) * t1, oy[0] + (oy[1] - oy[0]) * t1, chain, chainCap);
        }
      }
    }
  }
  if (T.oom) return (st->status = T.oom == 2 ? QM_BAD_COUNT : QM_OOM);

  /* Pieces into buckets, for finding the ones near a point. */
  u32 *bucketCount = (u32 *)take((GRID * GRID + 1u) * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  memset(bucketCount, 0, (GRID * GRID + 1u) * 4u);
  u32 *bucketStart = (u32 *)take((GRID * GRID + 1u) * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  u32 total = 0;
  u32 *bucketList = 0;
  for (int pass = 0; pass < 2; pass++) {
    if (pass) {
      for (u32 c = 0, at = 0; c < GRID * GRID; c++) { bucketStart[c] = at; at += bucketCount[c]; bucketCount[c] = 0; }
      bucketList = (u32 *)take(total * 4u + 4u, &oom);
      if (oom) return (st->status = QM_OOM);
    }
    for (u32 i = 0; i < count; i++) {
      Prep *P = &prep[i];
      if (!P->used && !P->level) continue;
      const RoadPiece *R = &pieces[i];
      double reach = P->half + (P->used ? (P->bandL > P->bandR ? P->bandL : P->bandR) : 0);
      double rx = reach / mu + 1, ry = reach / mv + 1;
      double x0 = (R->u0 < R->u1 ? R->u0 : R->u1) - rx, x1 = (R->u0 > R->u1 ? R->u0 : R->u1) + rx;
      double y0 = (R->v0 < R->v1 ? R->v0 : R->v1) - ry, y1 = (R->v0 > R->v1 ? R->v0 : R->v1) + ry;
      i32 i0 = (i32)(x0 / CELL), i1 = (i32)(x1 / CELL), j0 = (i32)(y0 / CELL), j1 = (i32)(y1 / CELL);
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 > (i32)GRID - 1) i1 = GRID - 1;
      if (j1 > (i32)GRID - 1) j1 = GRID - 1;
      for (i32 j = j0; j <= j1; j++) for (i32 k = i0; k <= i1; k++) {
        u32 c = (u32)j * GRID + (u32)k;
        if (pass) bucketList[bucketStart[c] + bucketCount[c]] = i;
        bucketCount[c]++;
        if (!pass) total++;
      }
    }
  }

  /* Profiles, most important line first: the terrain under it, smoothed a
   * little, never steeper than its grade allows; pinned where it meets a
   * bridge's deck; where it runs inside the level width of a line already
   * finished, that line's height there, and from there no steeper than its
   * grade (the cones round those anchors). */
  double *pinW = (double *)take(ns8, &oom), *pinOff = (double *)take(ns8, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 done = 0; done < nlines; done++) {
    u32 best = NONE;
    for (u32 l = 0; l < nlines; l++) if (!lines[l].done && (best == NONE || lines[l].priority > lines[best].priority)) best = l;
    LineProfile *L = &lines[best];
    if (!L->count) { L->done = 1; continue; }
    u32 first = L->first, n = L->count;
    double g = L->grade > 0 ? L->grade : 1.0;
    /* The anchored heights (1e30: none). */
    double *az = (double *)take(n * 8u + 8u, &oom);
    if (oom) return (st->status = QM_OOM);
    for (u32 i = 0; i < n; i++) az[i] = 1e30;
    u32 anchored = 0;
    for (u32 i = 0; i < count; i++) {
      Prep *P = &prep[i];
      if (!P->used || P->line != best) continue;
      const RoadPiece *R = &pieces[i];
      for (u32 k = 0; k < n; k++) {
        double s = ps[first + k];
        double lo = P->s0 < P->s1 ? P->s0 : P->s1, hi2 = P->s0 < P->s1 ? P->s1 : P->s0;
        if (s < lo - 1e-6 || s > hi2 + 1e-6 || hi2 - lo <= 0) continue;
        double f = (s - P->s0) / (P->s1 - P->s0);
        double x = R->u0 + (R->u1 - R->u0) * f, y = R->v0 + (R->v1 - R->v0) * f;
        /* Inside a finished line's level width? */
        i32 ci = (i32)(x / CELL), cj = (i32)(y / CELL);
        if (ci < 0 || cj < 0 || ci >= (i32)GRID || cj >= (i32)GRID) continue;
        u32 c = (u32)cj * GRID + (u32)ci;
        for (u32 b = bucketStart[c], e = b + bucketCount[c]; b < e; b++) {
          Prep *O = &prep[bucketList[b]];
          if (!O->used || O->line == best || !lines[O->line].done) continue;
          double across, along;
          measure(O, mu, mv, x, y, &across, &along);
          if (m_abs(across) > O->half) continue;
          double z = profile_at(&lines[O->line], ps, pz, piece_s(O, along));
          /* Far above or below: one passes over the other (the bridge or
           * the underpass itself is no piece, but its approaches come this
           * close), not a junction. At a junction on a slope the two can
           * differ by the hillside's rise across the other's width. */
          if (m_abs(praw[first + k] - z) > 0.6 * O->half + 1.0) continue;
          if (az[k] > 1e29) anchored++;
          az[k] = z;
          break;
        }
      }
    }
    /* The profile: the terrain under it, smoothed over its neighbours; at
     * an anchor, the finished line's height, and from there back onto its
     * own profile over a ramp no steeper than its grade (on top of the
     * terrain's own climb), so a side road leaves a main road at its level
     * and rejoins its own ground a little further on, rather than cutting a
     * trench wherever the hillside climbs faster than a road may. */
    double *raw = praw + first, *out = pz + first, *s = ps + first;
    smooth_along(s, raw, out, scratchB, n, SMOOTH, 0);
    /* Pins: the deck's height and grade where the line comes off a bridge,
     * eased in (the strongest pin wins where two reach). */
    for (u32 k = 0; k < n; k++) { pinW[k] = 0; pinOff[k] = 0; }
    u32 pinned = 0;
    for (u32 i = 0; i < count; i++) {
      const RoadPiece *R = &pieces[i];
      if (R->priority >= 0 || prep[i].line != best) continue;
      double sp = R->s0, delta = R->s1 - profile_at(L, ps, pz, sp);
      if (m_abs(delta) > PIN_MOST) continue;
      double ramp = m_abs(delta) / PIN_GRADE;
      if (ramp < PIN_RAMP) ramp = PIN_RAMP;
      if (ramp > PIN_RAMP_MOST) ramp = PIN_RAMP_MOST;
      for (u32 k = 0; k < n; k++) {
        double d = m_abs(s[k] - sp);
        if (d >= ramp) continue;
        double w = 1.0 - ease01(d / ramp);
        if (w > pinW[k]) { pinW[k] = w; pinOff[k] = (R->s1 + R->grade * (s[k] - sp) - out[k]) * w; }
      }
      pinned++;
    }
    if (pinned) for (u32 k = 0; k < n; k++) out[k] += pinOff[k];
    if (anchored) {
      double *base = (double *)take(n * 8u + 8u, &oom);
      if (oom) return (st->status = QM_OOM);
      for (u32 i = 0; i < n; i++) base[i] = out[i];
      for (u32 i = 0; i < n; i++) {
        if (az[i] < 1e29) { out[i] = az[i]; continue; }
        /* The nearest anchor on either side decides; the larger offset of the two wins. */
        double off = 0, weight = 0;
        for (u32 k = 0; k < n; k++) {
          if (az[k] > 1e29) continue;
          double delta = az[k] - base[k];
          double ramp = m_abs(delta) / g;
          if (ramp < 8.0) ramp = 8.0;
          double d = m_abs(s[i] - s[k]);
          if (d >= ramp) continue;
          double w = 1 - d / ramp;
          if (w > weight) { weight = w; off = delta * w; }
        }
        out[i] = base[i] + off;
      }
    }
    L->done = 1;
  }

  /* Every vertex near a used piece takes the height the rule gives it.
   * Inside a level width, that width's height: the most important line's
   * where several hold it, then the nearer one's. Outside them, each band
   * that reaches it gives the surface its own road alone would make there
   * (below), and they are blended: by how much each changes the ground
   * there, and by how near the vertex is to that road against how far its
   * band reaches, the weight growing without bound at the level width's
   * edge. So the surface is continuous everywhere: a band giving way to
   * another (between the two legs of a hairpin, a road and the path beside
   * it, a junction) no longer jumps from one road's face to the other's,
   * which left walls metres high where one road's fill met the next one's
   * cut (5.16b's first draft: "pick the band the vertex is deepest in");
   * each road's own surface takes over at its edge, and a band that leaves
   * the ground as it was weighs nothing. */
  u32 moved = 0;
  double worstCut = 0, worstFill = 0;
  u8 *recompute = (u8 *)take(T.n + 4u, &oom);
  u8 *faceCode = (u8 *)take(T.n + 4u, &oom);
  double *zNew = (double *)take(T.n * 8u + 8u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 v = 0; v < T.n; v++) {
    zNew[v] = T.z[v];
    recompute[v] = T.fresh[v];
    faceCode[v] = 128;
    double x = T.x[v], y = T.y[v];
    i32 ci = (i32)(x / CELL), cj = (i32)(y / CELL);
    if (ci < 0) ci = 0;
    if (cj < 0) cj = 0;
    if (ci >= (i32)GRID) ci = GRID - 1;
    if (cj >= (i32)GRID) cj = GRID - 1;
    u32 c = (u32)cj * GRID + (u32)ci;
    const double zt = T.z[v];
    double zLevel = 0, prLevel = -1, dLevel = 1e30;
    double sumW = 0, sumWD = 0, wMost = 0, inMost = 0;
    int level = 0, keep = 0;
    for (u32 b = bucketStart[c], e = b + bucketCount[c]; b < e; b++) {
      Prep *P = &prep[bucketList[b]];
      double across, along;
      measure(P, mu, mv, x, y, &across, &along);
      double d = m_abs(across);
      /* A road already level here: no other one's face reshapes it. */
      if (!P->used) { if (d <= P->half) keep = 1; continue; }
      const LineProfile *Ln = &lines[P->line];
      if (!Ln->count) continue;
      double sv = piece_s(P, along);
      double zp = profile_at(Ln, ps, pz, sv);
      if (d <= P->half) {
        double pr = Ln->priority;
        if (!level || pr > prLevel || (pr == prLevel && d < dLevel)) { zLevel = zp; prLevel = pr; dLevel = d; }
        level = 1;
        continue;
      }
      double band = profile_at(Ln, ps, across >= 0 ? pbl : pbr, sv), in = d - P->half;
      if (in >= band) continue;
      /* This road's own surface: beyond its level width the face, cut down
       * into the hillside or filled out below at its slope (band_for),
       * leaving the level width over FOOT metres and rounded into the
       * ground over ROUND (a smooth minimum for a cut's crest, maximum for
       * a fill's toe), until it meets the ground (Bruneton and Neyret blend
       * the two instead, which on a steep hillside makes the face steeper
       * than any cut could stand). Past three quarters of the band, back to
       * the ground (a rock face that never meets it ends in a step). */
      double f = profile_at(Ln, ps, across >= 0 ? pfl : pfr, sv);
      int cut = zt > zp;
      double rise = in < FOOT ? f * in * in / (2.0 * FOOT) : f * (in - 0.5 * FOOT);
      double face = cut ? zp + rise : zp - rise;
      double k = ROUND * f * ease01(in / (2.0 * ROUND));
      double zs = cut ? smin(face, zt, k) : smax(face, zt, k);
      double t = in / band, q = t <= 0.75 ? 0 : (t - 0.75) * 4.0;
      if (q > 1) q = 1;
      zs += (zt - zs) * q * q * (3 - 2 * q);
      double dzs = zs - zt;
      if (m_abs(dzs) < 1e-6) continue;
      double r = (1.0 - t) / (t > 1e-6 ? t : 1e-6), w = m_abs(dzs) * r * r;
      sumW += w; sumWD += w * dzs;
      if (w > wMost) { wMost = w; inMost = in; }
    }
    double z;
    if (level) z = zLevel;
    else if (keep || sumW <= 0) continue;
    else {
      z = zt + sumWD / sumW;
      /* On a face: which kind, and how much (the shader's colours). */
      double dzv = m_abs(z - zt);
      double w = ease01(inMost / 0.8) * ease01((dzv - 0.03) / 0.3);
      if (w > 0) faceCode[v] = (u8)(128.0 + (z < zt ? 127.0 : -127.0) * w + 0.5);
    }
    double dz = z - T.z[v];
    if (dz < worstFill) worstFill = dz;
    if (dz > worstCut) worstCut = dz;
    if (m_abs(dz) > 0.002) { recompute[v] = 1; moved++; }
    zNew[v] = z;
  }
  st->moved = moved;
  st->worstCut = (float)-worstFill;   /* deepest cut: the ground lowered (dz < 0) */
  st->worstFill = (float)worstCut;    /* highest fill: the ground raised (dz > 0) */

  /* Back into the parsed tile: contiguous quantized arrays, triangles,
   * edge lists by position. */
  u32 n = T.n, tn = T.tn;
  u16 *uvh = (u16 *)take(n * 6u, &oom);
  u32 *tris = (u32 *)take(tn * 12u, &oom);
  if (oom) return (st->status = QM_OOM);
  u16 *U = uvh, *V = uvh + n, *H = uvh + 2u * n;
  for (u32 v = 0; v < n; v++) {
    double x = T.x[v] + 0.5, y = T.y[v] + 0.5;
    U[v] = (u16)(x < 0 ? 0 : x > Q ? Q : x);
    V[v] = (u16)(y < 0 ? 0 : y > Q ? Q : y);
    double h = hSpan > 0 ? (zNew[v] - (double)m->minHeight) / hSpan * Q + 0.5 : 0;
    H[v] = (u16)(h < 0 ? 0 : h > Q ? Q : h);
  }
  /* Rounded to whole units, a sliver can fold flat or over. One with a
   * corner on (or past) its long edge is flipped with the triangle across
   * that edge, which leaves two good ones and the surface closed; the few
   * that cannot be (two corners rounded onto one point) are dropped, and
   * they cover no ground. */
  for (u32 pass = 0; pass < 4; pass++) {
    u32 fixed = 0, bad = 0;
    for (u32 t = 0; t < tn; t++) {
      if (area_q(U, V, T.t[t * 3], T.t[t * 3 + 1], T.t[t * 3 + 2]) > 0) continue;
      bad++;
      /* Its edges, longest first. */
      u32 ks[3] = { 0, 1, 2 };
      i64 len[3];
      for (u32 k = 0; k < 3; k++) {
        u32 p0 = T.t[t * 3 + k], p1 = T.t[t * 3 + (k + 1) % 3];
        i64 dx = (i64)U[p1] - (i64)U[p0], dy = (i64)V[p1] - (i64)V[p0];
        len[k] = dx * dx + dy * dy;
      }
      for (u32 i = 0; i < 2; i++) for (u32 j = i + 1; j < 3; j++) if (len[ks[j]] > len[ks[i]]) { u32 x = ks[i]; ks[i] = ks[j]; ks[j] = x; }
      for (u32 e = 0; e < 3; e++) {
        u32 k = ks[e], nb = T.adj[t * 3 + k];
        if (nb == NONE) continue;
        u32 A = T.t[t * 3 + k], B = T.t[t * 3 + (k + 1) % 3], C = T.t[t * 3 + (k + 2) % 3];
        u32 j = 0;
        while (j < 3 && !(T.t[nb * 3 + j] == B && T.t[nb * 3 + (j + 1) % 3] == A)) j++;
        if (j == 3) continue;
        u32 D = T.t[nb * 3 + (j + 2) % 3];
        if (area_q(U, V, C, A, D) <= 0 || area_q(U, V, D, B, C) <= 0) continue;
        u32 nBC = T.adj[t * 3 + (k + 1) % 3], nCA = T.adj[t * 3 + (k + 2) % 3];
        u32 nAD = T.adj[nb * 3 + (j + 1) % 3], nDB = T.adj[nb * 3 + (j + 2) % 3];
        set_tri(&T, t, C, A, D, nCA, nAD, nb);
        set_tri(&T, nb, D, B, C, nDB, nBC, t);
        repoint(&T, nAD, nb, t);
        repoint(&T, nBC, t, nb);
        fixed++;
        break;
      }
    }
    st->flipped += fixed;
    if (!bad || !fixed) break;
  }
  /* Two vertices rounded onto one point are one vertex: the slivers
   * between them vanish and their neighbours meet (the vertex the tile
   * came with, or the first one made, keeps the place). */
  u32 *same = (u32 *)take(n * 4u + 4u, &oom);
  u32 hcap2 = 16;
  while (hcap2 < n * 2u) hcap2 <<= 1;
  u32 *hpos = (u32 *)take(hcap2 * 4u, &oom), *hvtx = (u32 *)take(hcap2 * 4u, &oom);
  if (oom) return (st->status = QM_OOM);
  for (u32 i = 0; i < hcap2; i++) hvtx[i] = NONE;
  u32 merged = 0;
  for (u32 v = 0; v < n; v++) {
    u32 key = ((u32)U[v] << 16) | V[v];
    u32 h = (key * 2654435761u) & (hcap2 - 1u);
    while (hvtx[h] != NONE && hpos[h] != key) h = (h + 1u) & (hcap2 - 1u);
    if (hvtx[h] == NONE) { hpos[h] = key; hvtx[h] = v; same[v] = v; }
    else { same[v] = hvtx[h]; merged++; }
  }
  /* A flat sliver left (its corners in a line, the flip not possible) is
   * dropped too, its middle corner first set to the height of the long
   * edge it lies on: its neighbours then meet along that edge without a
   * crack. */
  for (u32 t = 0; t < tn; t++) {
    u32 a = same[T.t[t * 3]], b = same[T.t[t * 3 + 1]], c = same[T.t[t * 3 + 2]];
    if (a == b || b == c || c == a || area_q(U, V, a, b, c) > 0) continue;
    u32 v3[3] = { a, b, c };
    i64 best = -1;
    u32 k0 = 0;
    for (u32 k = 0; k < 3; k++) {
      u32 p0 = v3[k], p1 = v3[(k + 1) % 3];
      i64 dx = (i64)U[p1] - (i64)U[p0], dy = (i64)V[p1] - (i64)V[p0];
      if (dx * dx + dy * dy > best) { best = dx * dx + dy * dy; k0 = k; }
    }
    u32 p0 = v3[k0], p1 = v3[(k0 + 1) % 3], mid = v3[(k0 + 2) % 3];
    if (best <= 0 || mid < n0) continue;     /* the tile's own vertices keep their heights */
    double ex = (double)U[p1] - U[p0], ey = (double)V[p1] - V[p0];
    double f = (((double)U[mid] - U[p0]) * ex + ((double)V[mid] - V[p0]) * ey) / (double)best;
    if (f < 0) f = 0;
    if (f > 1) f = 1;
    H[mid] = (u16)((double)H[p0] + ((double)H[p1] - H[p0]) * f + 0.5);
  }
  u32 kept = 0;
  for (u32 t = 0; t < tn; t++) {
    u32 a = same[T.t[t * 3]], b = same[T.t[t * 3 + 1]], c = same[T.t[t * 3 + 2]];
    if (a == b || b == c || c == a || area_q(U, V, a, b, c) <= 0) continue;
    tris[kept * 3] = a; tris[kept * 3 + 1] = b; tris[kept * 3 + 2] = c;
    kept++;
  }
  st->dropped = tn - kept;
  st->merged = merged;
  tn = kept;
  u32 counts[4] = { 0, 0, 0, 0 };
  for (u32 v = 0; v < n; v++) {
    if (same[v] != v) continue;
    if (U[v] == 0) counts[0]++;
    if (V[v] == 0) counts[1]++;
    if (U[v] == (u16)Q) counts[2]++;
    if (V[v] == (u16)Q) counts[3]++;
  }
  for (int e = 0; e < 4; e++) {
    m->edges[e] = (u32 *)take(counts[e] * 4u + 4u, &oom);
    m->edgeCount[e] = 0;
  }
  if (oom) return (st->status = QM_OOM);
  for (u32 v = 0; v < n; v++) {
    if (same[v] != v) continue;
    if (U[v] == 0) m->edges[0][m->edgeCount[0]++] = v;
    if (V[v] == 0) m->edges[1][m->edgeCount[1]++] = v;
    if (U[v] == (u16)Q) m->edges[2][m->edgeCount[2]++] = v;
    if (V[v] == (u16)Q) m->edges[3][m->edgeCount[3]++] = v;
  }
  m->u = U; m->v = V; m->h = H;
  m->vertexCount = n;
  m->tris = tris;
  m->triangleCount = tn;
  m->recompute = recompute;
  m->face = faceCode;
  m->originalCount = n0;
  st->addedVertices = n - n0;
  st->addedTriangles = tn > tn0 ? tn - tn0 : 0;
  return (st->status = QM_OK);
}

#pragma clang attribute pop
