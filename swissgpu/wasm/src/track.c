/* track.c — a railway's track out in the open, built over a shaped tile (5.18b).
 *
 * His words on 5.18a: "put fake 3d rails even outside tunnels. make things always connect". Out in the open the
 * photo shows the track from above; near the camera it is built here instead, on exactly the ground the tile is
 * drawn with (after shape.c has cut the railway's level bench into it): a ballast bed BED_TOP high with sides of
 * 1 in BED_SLOPE, as wide as its sleepers and a SHOULDER either side, and the two rails standing on it (60E1: a
 * 72 mm head, 172 mm high, as in the tunnels: tunnel.c rails), a rack railway's rack between them. The sleepers
 * are drawn on the bed's top by the shader (track.wgsl), as they are on a tunnel's floor.
 *
 * Each piece of track (js/engine/vector/pieces.js: a railway's segment on the ground, clipped to the tile) is
 * sampled every STEP metres, the ground under its middle and under each of the bed's toes, and a section is kept
 * only where the ground's line bends by more than TOL, so a bed along an even grade takes one every few tens of
 * metres (and at most every LONGEST). Pieces meeting end to end (the next piece of a line, or the next road tile's
 * line at its edge) share their end section, turned to halve the bend and lengthened to keep the width, so the bed
 * runs on without a gap or an overlap; an end with nothing going on (a buffer stop, a bridge or a tunnel beyond)
 * is closed, one at the tile's edge or by another track (a switch) is not.
 *
 * Where a road crosses the railway on the level (one of the tile's road pieces meets a track's middle: bridges and
 * tunnels are never pieces), the bed sinks under the ground and the rails into it, their heads FLUSH_HIGH over it,
 * across the road's level width and CROSS_MARGIN either side, easing back over CROSS_RAMP: a level crossing, not
 * a wall across the road.
 *
 *   offset  0   position  float32x3  metres from the tile origin (qm.c's)
 *   offset 12   uv        unorm16x2  where it lies on the tile (terrain.wgsl's quarters)
 *   offset 16   along     float32    metres along its line (the sleepers)
 *   offset 20   across    snorm16x2  metres right of the track's middle, half its gauge; both / TRACK_SPAN
 *   offset 24   kind      unorm8x4   TRACK_BED, TRACK_RAIL or TRACK_RACK (/ 255); 255 at a level crossing
 *                                    (flush), down to 0 the full bed; how far up its profile (0 a rail's foot or
 *                                    the bed's toe, 255 its head or the bed's top: the shader's shadow under a
 *                                    rail's head, the grime at the bed's foot); 0
 *   stride 28
 */

#include "qm.h"

#define Q 32767.0
#define TRACK_STRIDE 28u
#define TRACK_SPAN 4.0

#define BED_TOP 0.30        /* the ballast's top over the bench (the ground shape.c leaves level) */
#define BED_FOOT 0.05       /* its toes under the ground */
#define BED_SLOPE 1.5       /* its sides: one up in 1.5 across */
#define BED_DROP 1.0        /* the most a toe hangs under the top where the ground falls away (a wall, an edge) */
#define SLEEPER_OVER 0.58   /* a sleeper's end beyond the gauge line (vector.wgsl vtTrack: 2.6 m under standard gauge) */
#define SHOULDER 0.40       /* ballast beyond the sleepers' ends: a bed 3.4 m wide under standard gauge */
#define RAIL_HEAD 0.036     /* half a rail's head (60E1: 72 mm), its inner edge on the gauge line */
#define RAIL_HIGH 0.172     /* a rail's height (60E1) */
#define RACK_HALF 0.05      /* a rack: 100 mm wide, its teeth a little over the rails' heads */
#define RACK_HIGH 0.20
#define FLUSH_HIGH 0.012    /* a rail's head over the road at a level crossing */
#define BED_SINK 0.05       /* and the bed's top under it */
#define BED_BIAS 0.001      /* metres a line's bed lies over the next one's (by its number), so two at a switch never flicker */

#define STEP 1.0            /* metres between the samples along a piece */
#define TOL 0.012           /* a section is left out where the line between its neighbours passes within this */
#define LONGEST 40.0        /* metres between sections at most */
#define JOIN 0.05           /* metres apart two ends may be and be one joint */
#define NEAR 1.5            /* an end this near another track's middle or end is at a switch: not closed */
#define CROSS_MARGIN 0.5    /* metres past a road's level width the track is flush */
#define CROSS_RAMP 3.0      /* metres it eases back to the full bed */
#define CROSS_ON 0.3        /* a crossing lies on a piece's line within this (metres) */
#define CROSS_STEEP 0.3     /* the shallowest crossing's sine counted (a long flush stretch at most 1 / this wide) */
#define CROSS_SIDE 0.1      /* under this sine a road runs alongside, not across */
#define CROSS_MOST 96u      /* level crossings a tile keeps at most */

enum { TRACK_BED = 0, TRACK_RAIL = 1, TRACK_RACK = 2 };
#define SECTION_MOST 16u    /* vertices a section has at most: the bed's 4, two rails' 8, a rack's 4 */

typedef struct {
  double u0, v0, du, dv;    /* the piece inside the tile, quantized units */
  double ex, ey;            /* its way, metres east and north (unit) */
  double len;               /* metres */
  double a0, a1;            /* metres along its line at its ends */
  double gauge;             /* half its gauge, metres */
  u32 flags, line;
  u8 edge[2];               /* the end is on the tile's edge */
  u8 joined[2];             /* another piece goes on from it */
  u8 near[2];               /* another track's middle or end is near it (a switch) */
  double rx[2], ry[2];      /* the right of the way at each end, metres east and north, as long as the mitre makes it */
} Piece;

typedef struct { double x, y, half; } Crossing;   /* metres east and north of the tile's corner; flush that far either way */

/* ---- the ground: the shaped triangles, by ground.c's grid ------------------------- */

typedef struct {
  const QmMesh *m;
  const u32 *start, *list;
  u32 g, shift;
  double h0, hs;            /* metres at height 0, metres a unit of height */
} Ground;

static double ground_at(const Ground *G, double u, double v) {
  if (u < 0) u = 0; else if (u > Q) u = Q;
  if (v < 0) v = 0; else if (v > Q) v = Q;
  u32 cx = (u32)u >> G->shift, cy = (u32)v >> G->shift;
  if (cx >= G->g) cx = G->g - 1u;
  if (cy >= G->g) cy = G->g - 1u;
  const QmMesh *m = G->m;
  const u32 c = cy * G->g + cx;
  double best = -1e30, h = 0;
  for (u32 k = G->start[c]; k < G->start[c + 1u]; k++) {
    const u32 t = G->list[k], a = m->tris[t * 3u], b = m->tris[t * 3u + 1u], d = m->tris[t * 3u + 2u];
    const double ua = m->u[a], va = m->v[a], ub = m->u[b], vb = m->v[b], ud = m->u[d], vd = m->v[d];
    const double den = (vb - vd) * (ua - ud) + (ud - ub) * (va - vd);
    if (den == 0.0) continue;
    const double l1 = ((vb - vd) * (u - ud) + (ud - ub) * (v - vd)) / den;
    const double l2 = ((vd - va) * (u - ud) + (ua - ud) * (v - vd)) / den;
    const double l3 = 1.0 - l1 - l2;
    double lo = l1 < l2 ? l1 : l2;
    if (l3 < lo) lo = l3;
    /* The triangle it is in; failing that (rounding on an edge) the one it is least outside of. */
    if (lo > best) {
      best = lo;
      h = l1 * m->h[a] + l2 * m->h[b] + l3 * m->h[d];
      if (lo >= -1e-9) break;
    }
  }
  return G->h0 + h * G->hs;
}

/* ---- helpers ------------------------------------------------------------------------ */

/* The part of a to b inside the tile's square, as fractions of it; 0 if none (shape.c clip_box). */
static int clip_tile(double ax, double ay, double bx, double by, double *t0, double *t1) {
  const double dx = bx - ax, dy = by - ay;
  const double p[4] = { -dx, dx, -dy, dy }, q[4] = { ax, Q - ax, ay, Q - ay };
  *t0 = 0; *t1 = 1;
  for (int k = 0; k < 4; k++) {
    if (p[k] == 0) { if (q[k] < 0) return 0; continue; }
    const double r = q[k] / p[k];
    if (p[k] < 0) { if (r > *t1) return 0; if (r > *t0) *t0 = r; }
    else { if (r < *t0) return 0; if (r < *t1) *t1 = r; }
  }
  return *t1 - *t0 > 1e-9;
}

INLINE int on_edge(double u, double v) { return u < 1e-3 || v < 1e-3 || u > Q - 1e-3 || v > Q - 1e-3; }

/* Metres from (x, y) to the segment a, b. */
static double to_segment(double x, double y, double ax, double ay, double bx, double by) {
  const double dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  double t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const double ex = ax + dx * t - x, ey = ay + dy * t - y;
  return m_sqrt(ex * ex + ey * ey);
}

INLINE u16 unorm_of(double q) {
  double v = q * (65535.0 / Q);
  return (u16)(v < 0 ? 0 : v > 65535.0 ? 65535 : v + 0.5);
}

INLINE i16 snorm_of(double x) {
  double v = x / TRACK_SPAN * 32767.0;
  v = v < -32767.0 ? -32767.0 : v > 32767.0 ? 32767.0 : v;
  return (i16)(v < 0 ? v - 0.5 : v + 0.5);
}

INLINE u32 hash_u32(u32 x) {
  x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
  return x;
}

/* ---- the builder -------------------------------------------------------------------- */

typedef struct {
  u8 *vb;                   /* vertices, TRACK_STRIDE each */
  u32 *ib;                  /* indices, 32-bit while building */
  u32 nv, ni, capV, capI;
  /* The tile: its corners (degrees), its origin, metres a quantized unit. */
  double west, south, east, north, ox, oy, oz, mu, mv;
} Out;

/* A section's frame: its middle (earth-centred, from the tile origin), east, north and up there. */
typedef struct { double c[3], e[3], n[3], up[3], u, v, hc; } Frame;

static void frame_at(const Out *o, double u, double v, double h, Frame *F) {
  const double lon = (o->west + (u / Q) * (o->east - o->west)) * DEG2RAD;
  const double lat = (o->south + (v / Q) * (o->north - o->south)) * DEG2RAD;
  double p[3];
  geodetic_to_ecef(lon, lat, h, p);
  F->c[0] = p[0] - o->ox; F->c[1] = p[1] - o->oy; F->c[2] = p[2] - o->oz;
  const double sl = m_sin(lon), cl = m_cos(lon), sp = m_sin(lat), cp = m_cos(lat);
  F->e[0] = -sl; F->e[1] = cl; F->e[2] = 0;
  F->n[0] = -sp * cl; F->n[1] = -sp * sl; F->n[2] = cp;
  F->up[0] = cp * cl; F->up[1] = cp * sl; F->up[2] = sp;
  F->u = u; F->v = v; F->hc = h;
}

/* One vertex `a` metres right of the section's middle along (rx, ry) (metres east and north a metre right), `h`
 * metres high, `up` how far up its profile (0..255). */
static void put(Out *o, const Frame *F, double rx, double ry, double a, double h, double along, double gauge, u8 kind, u8 flush, u8 up) {
  u8 *w = o->vb + o->nv * TRACK_STRIDE;
  const double de = rx * a, dn = ry * a, dh = h - F->hc;
  float p[3];
  for (int k = 0; k < 3; k++) p[k] = (float)(F->c[k] + F->e[k] * de + F->n[k] * dn + F->up[k] * dh);
  memcpy(w, p, 12);
  const u16 uv[2] = { unorm_of(F->u + de / o->mu), unorm_of(F->v + dn / o->mv) };
  memcpy(w + 12, uv, 4);
  const float s = (float)along;
  memcpy(w + 16, &s, 4);
  const i16 ag[2] = { snorm_of(a), snorm_of(gauge) };
  memcpy(w + 20, ag, 4);
  w[24] = kind; w[25] = flush; w[26] = up; w[27] = 0;
  o->nv++;
}

INLINE void tri(Out *o, u32 a, u32 b, u32 c) { o->ib[o->ni++] = a; o->ib[o->ni++] = b; o->ib[o->ni++] = c; }

/* The quads between two sections' vertices (based at a and b), one for each face p..q of the profile. */
static void join_sections(Out *o, u32 a, u32 b, u32 count, int bed) {
  /* Faces in each profile of four: 0-1, 1-2, 2-3 (round the outline from the left foot over the top). */
  for (u32 base = bed ? 0u : 4u; base < count; base += 4u) {
    for (u32 f = 0; f < 3u; f++) {
      const u32 p = base + f, q = p + 1u;
      tri(o, a + p, a + q, b + q);
      tri(o, a + p, b + q, b + p);
    }
  }
}

/* A closed end: each profile's outline as two triangles, facing back along the way (`first`) or on. */
static void close_end(Out *o, u32 s, u32 count, int first) {
  for (u32 base = 0; base < count; base += 4u) {
    if (first) { tri(o, s + base + 3u, s + base + 2u, s + base + 1u); tri(o, s + base + 3u, s + base + 1u, s + base); }
    else { tri(o, s + base, s + base + 1u, s + base + 2u); tri(o, s + base, s + base + 2u, s + base + 3u); }
  }
}

/* How flush the track is `s` metres along piece p (1 at a level crossing, 0 the full bed). */
static double flush_at(const Piece *p, double mu, double mv, const Crossing *cr, u32 ncr, double s) {
  double f = 0;
  const double x0 = p->u0 * mu, y0 = p->v0 * mv;
  for (u32 k = 0; k < ncr; k++) {
    const double dx = cr[k].x - x0, dy = cr[k].y - y0;
    if (m_abs(dx * p->ey - dy * p->ex) > CROSS_ON) continue;   /* not on this track */
    const double at = dx * p->ex + dy * p->ey;
    const double d = m_abs(s - at) - cr[k].half;
    const double g = d <= 0 ? 1.0 : 1.0 - d / CROSS_RAMP;
    if (g > f) f = g;
  }
  return f;
}

/* The places along piece p where a crossing's flush stretch and its easing begin and end (into `out`, at most 4
 * a crossing), sorted; returns how many. */
static u32 crossing_marks(const Piece *p, double mu, double mv, const Crossing *cr, u32 ncr, double *out, u32 most) {
  u32 n = 0;
  const double x0 = p->u0 * mu, y0 = p->v0 * mv;
  for (u32 k = 0; k < ncr && n + 4u <= most; k++) {
    const double dx = cr[k].x - x0, dy = cr[k].y - y0;
    if (m_abs(dx * p->ey - dy * p->ex) > CROSS_ON) continue;
    const double at = dx * p->ex + dy * p->ey, h = cr[k].half;
    const double m4[4] = { at - h - CROSS_RAMP, at - h, at + h, at + h + CROSS_RAMP };
    for (int j = 0; j < 4; j++) if (m4[j] > 1e-3 && m4[j] < p->len - 1e-3) out[n++] = m4[j];
  }
  for (u32 i = 1; i < n; i++) {
    const double v = out[i];
    u32 j = i;
    while (j > 0 && out[j - 1u] > v) { out[j] = out[j - 1u]; j--; }
    out[j] = v;
  }
  return n;
}

/**
 * Builds the track over a parsed and shaped tile. `G`: its ground (ground.c, over the same triangles). `tp`:
 * the track pieces (TrackPiece), `roads` the road pieces the tile was shaped with (for the level crossings).
 * Writes the vertices and indices into the arena and their place into `res`.
 */
u32 track_build(const QmMesh *m, const QmGround *G, const TrackPiece *tp, u32 count, const RoadPiece *roads, u32 roadCount,
                double west, double south, double east, double north, double ox, double oy, double oz, TrackOut *res) {
  memset(res, 0, sizeof(TrackOut));
  if (!count) return QM_OK;

  Out o;
  memset(&o, 0, sizeof(Out));
  o.west = west; o.south = south; o.east = east; o.north = north; o.ox = ox; o.oy = oy; o.oz = oz;
  qm_unit_metres(west, south, east, north, &o.mu, &o.mv);
  const double mu = o.mu, mv = o.mv;

  Ground gr;
  gr.m = m;
  gr.start = (const u32 *)PTR(G->cellStartOffset);
  gr.list = (const u32 *)PTR(G->cellTrisOffset);
  gr.g = G->grid;
  gr.shift = 15u;
  for (u32 s = G->grid; s > 1u; s >>= 1) gr.shift--;
  gr.h0 = m->minHeight;
  gr.hs = ((double)m->maxHeight - (double)m->minHeight) / Q;

  /* ---- the pieces inside the tile ---- */
  Piece *P = (Piece *)PTR(arena_alloc(count * (u32)sizeof(Piece)));
  if (!P) return (res->status = QM_OOM);
  u32 n = 0;
  double bx0 = 1e30, by0 = 1e30, bx1 = -1e30, by1 = -1e30;
  for (u32 i = 0; i < count; i++) {
    const TrackPiece *q = &tp[i];
    if (!(q->gauge > 0.2)) continue;
    double t0, t1;
    if (!clip_tile(q->u0, q->v0, q->u1, q->v1, &t0, &t1)) continue;
    const double du = q->u1 - q->u0, dv = q->v1 - q->v0;
    const double whole = m_sqrt(du * mu * du * mu + dv * mv * dv * mv);
    if (whole * (t1 - t0) < 0.05) continue;
    Piece *p = &P[n];
    p->u0 = q->u0 + du * t0; p->v0 = q->v0 + dv * t0;
    p->du = du * (t1 - t0); p->dv = dv * (t1 - t0);
    p->len = whole * (t1 - t0);
    p->ex = du * mu / whole; p->ey = dv * mv / whole;
    p->a0 = q->a0 + (q->a1 - q->a0) * t0; p->a1 = q->a0 + (q->a1 - q->a0) * t1;
    p->gauge = q->gauge;
    p->flags = (u32)q->flags;
    p->line = (u32)q->line;
    p->edge[0] = (u8)(t0 > 1e-9 || on_edge(p->u0, p->v0));
    p->edge[1] = (u8)(t1 < 1.0 - 1e-9 || on_edge(p->u0 + p->du, p->v0 + p->dv));
    p->joined[0] = p->joined[1] = 0;
    p->near[0] = p->near[1] = 0;
    p->rx[0] = p->rx[1] = p->ey;          /* right of the way: (ey, -ex) */
    p->ry[0] = p->ry[1] = -p->ex;
    const double xa = p->u0 * mu, ya = p->v0 * mv, xb = (p->u0 + p->du) * mu, yb = (p->v0 + p->dv) * mv;
    if (xa < bx0) bx0 = xa; if (xb < bx0) bx0 = xb; if (xa > bx1) bx1 = xa; if (xb > bx1) bx1 = xb;
    if (ya < by0) by0 = ya; if (yb < by0) by0 = yb; if (ya > by1) by1 = ya; if (yb > by1) by1 = yb;
    n++;
  }
  if (!n) return QM_OK;

  /* ---- joints: ends that go on into another piece, and ends at a switch ---- */
  for (u32 i = 0; i < n; i++) {
    Piece *p = &P[i];
    for (int e = 0; e < 2; e++) {
      const double xi = (p->u0 + (e ? p->du : 0)) * mu, yi = (p->v0 + (e ? p->dv : 0)) * mv;
      const double oxi = e ? p->ex : -p->ex, oyi = e ? p->ey : -p->ey;   /* out of the piece at this end */
      double bestDot = -0.7;
      int bj = -1, bf = 0;
      for (u32 j = 0; j < n; j++) {
        if (j == i) continue;
        const Piece *q = &P[j];
        const double qx0 = q->u0 * mu, qy0 = q->v0 * mv, qx1 = (q->u0 + q->du) * mu, qy1 = (q->v0 + q->dv) * mv;
        if (!p->near[e] && to_segment(xi, yi, qx0, qy0, qx1, qy1) < NEAR) p->near[e] = 1;
        for (int f = 0; f < 2; f++) {
          const double xj = f ? qx1 : qx0, yj = f ? qy1 : qy0;
          const double d2 = (xi - xj) * (xi - xj) + (yi - yj) * (yi - yj);
          if (d2 > JOIN * JOIN) continue;
          /* Going on: the two ways out of the joint opposite. */
          const double dot = oxi * (f ? q->ex : -q->ex) + oyi * (f ? q->ey : -q->ey);
          if (dot < bestDot) { bestDot = dot; bj = (int)j; bf = f; }
        }
      }
      if (bj < 0) continue;
      const Piece *q = &P[bj];
      p->joined[e] = 1;
      /* The way through the joint as this piece runs, halving the bend; the right of it, as long as keeps the
       * bed's width across this piece. */
      const double s = (e != bf) ? 1.0 : -1.0;
      double tx = p->ex + s * q->ex, ty = p->ey + s * q->ey;
      const double tl = m_sqrt(tx * tx + ty * ty);
      if (tl < 1e-9) continue;
      tx /= tl; ty /= tl;
      const double k = ty * p->ey + tx * p->ex;   /* (ty, -tx) · (ey, -ex) */
      if (k < 0.5) continue;
      p->rx[e] = ty / k; p->ry[e] = -tx / k;
    }
  }

  /* ---- level crossings: the tile's roads that cross a track's middle on the ground ---- */
  Crossing *cr = (Crossing *)PTR(arena_alloc(CROSS_MOST * (u32)sizeof(Crossing)));
  if (!cr) return (res->status = QM_OOM);
  u32 ncr = 0;
  /* The railways' own lines (every piece given, in the tile or not), sorted: their road pieces are not roads, and
   * where two cross or part there is no road between them. */
  u32 *lines = (u32 *)PTR(arena_alloc(count * 4u));
  if (!lines) return (res->status = QM_OOM);
  u32 nl = 0;
  for (u32 i = 0; i < count; i++) {
    const u32 v = (u32)tp[i].line;
    u32 j = nl;
    while (j > 0 && lines[j - 1u] > v) j--;
    if (j > 0 && lines[j - 1u] == v) continue;
    for (u32 k = nl; k > j; k--) lines[k] = lines[k - 1u];
    lines[j] = v;
    nl++;
  }
  for (u32 r = 0; r < roadCount && ncr < CROSS_MOST; r++) {
    const RoadPiece *rp = &roads[r];
    if (rp->priority < 0 || !(rp->half > 0)) continue;   /* pins */
    const u32 line = (u32)rp->line;
    u32 lo = 0, hi = nl;
    while (lo < hi) { const u32 mid = (lo + hi) >> 1; if (lines[mid] < line) lo = mid + 1u; else hi = mid; }
    if (lo < nl && lines[lo] == line) continue;
    const double ax = rp->u0 * mu, ay = rp->v0 * mv, bx = rp->u1 * mu, by = rp->v1 * mv;
    if ((ax < bx0 - 1 && bx < bx0 - 1) || (ax > bx1 + 1 && bx > bx1 + 1) || (ay < by0 - 1 && by < by0 - 1) || (ay > by1 + 1 && by > by1 + 1)) continue;
    const double rx = bx - ax, ry = by - ay, rl = m_sqrt(rx * rx + ry * ry);
    if (rl < 0.1) continue;
    for (u32 i = 0; i < n && ncr < CROSS_MOST; i++) {
      const Piece *p = &P[i];
      const double px = p->u0 * mu, py = p->v0 * mv, qx = px + p->ex * p->len, qy = py + p->ey * p->len;
      if ((ax < px && ax < qx && bx < px && bx < qx) || (ax > px && ax > qx && bx > px && bx > qx)) continue;
      if ((ay < py && ay < qy && by < py && by < qy) || (ay > py && ay > qy && by > py && by > qy)) continue;
      /* Where the two middles meet. */
      const double den = p->ex * ry - p->ey * rx;
      const double sine = den / rl;
      if (m_abs(sine) < CROSS_SIDE) continue;   /* alongside */
      const double wx = ax - px, wy = ay - py;
      const double sp = (wx * ry - wy * rx) / den;            /* metres along the track */
      const double sr = (wx * p->ey - wy * p->ex) / den;      /* fraction along the road */
      if (sp < -0.01 || sp > p->len + 0.01 || sr < 0 || sr > 1) continue;
      const double ss = m_abs(sine) < CROSS_STEEP ? CROSS_STEEP : m_abs(sine);
      cr[ncr].x = px + p->ex * sp;
      cr[ncr].y = py + p->ey * sp;
      cr[ncr].half = (rp->half + CROSS_MARGIN) / ss;
      ncr++;
    }
  }
  res->crossings = ncr;

  /* ---- room: every sample a section, every section joined and its ends closed ---- */
  u32 most = 0, total = 0;
  for (u32 i = 0; i < n; i++) {
    const u32 k = (u32)(P[i].len / STEP) + 3u + 4u * ncr;
    if (k > most) most = k;
    total += k;
  }
  o.capV = total * SECTION_MOST;
  o.capI = total * 72u + n * 48u;
  const u32 vOff = arena_alloc(o.capV * TRACK_STRIDE), iOff = arena_alloc(o.capI * 4u);
  double *S = (double *)PTR(arena_alloc(most * 9u * 8u));
  u8 *keep = (u8 *)PTR(arena_alloc(most));
  if (!vOff || !iOff || !S || !keep) return (res->status = QM_OOM);
  o.vb = (u8 *)PTR(vOff);
  o.ib = (u32 *)PTR(iOff);
  /* Each sample: how far along, the bed's top, the left and right rails' heads and the rack's, the toes, how flush. */
  double *Ss = S, *Tt = S + most, *Hl = S + 2u * most, *Hr = S + 3u * most, *Hk = S + 4u * most;
  double *Tl = S + 5u * most, *Tr = S + 6u * most, *Sf = S + 7u * most, *marks = S + 8u * most;

  u32 sections = 0;
  for (u32 i = 0; i < n; i++) {
    const Piece *p = &P[i];
    const double g = p->gauge, rail = g + RAIL_HEAD;
    const double topHalf = g + SLEEPER_OVER + SHOULDER, toeHalf = topHalf + BED_SLOPE * (BED_TOP + BED_FOOT);
    const int rack = (p->flags & TRACK_PIECE_RACK) != 0;
    const u32 per = rack ? 16u : 12u;
    const double bias = (double)(hash_u32(p->line) & 3u) * BED_BIAS;

    /* The samples: every STEP metres, the ends, and where a crossing's flush stretch and easing begin and end. */
    const u32 nm = crossing_marks(p, mu, mv, cr, ncr, marks, 4u * ncr);
    u32 ns = 0, mk = 0;
    const u32 steps = (u32)(p->len / STEP);
    for (u32 k = 0; k <= steps + 1u; k++) {
      double s = k * STEP;
      if (s > p->len - 0.05 * STEP) s = p->len;
      while (mk < nm && marks[mk] < s - 1e-3) {
        if (!ns || marks[mk] > Ss[ns - 1u] + 1e-3) { Ss[ns] = marks[mk]; keep[ns] = 1; ns++; }
        mk++;
      }
      int marked = 0;
      while (mk < nm && marks[mk] <= s + 1e-3) { marked = 1; mk++; }
      if (!ns || s > Ss[ns - 1u] + 1e-3) { Ss[ns] = s; keep[ns] = (u8)marked; ns++; }
      else if (marked) keep[ns - 1u] = 1;
      if (s >= p->len) break;
    }
    keep[0] = keep[ns - 1u] = 1;

    /* The ground under each (across the end's own right at a joint): its middle, the rails, the bed's shoulders and
     * toes. The bed's top stands BED_TOP over the highest of the first three, so where the bench is not quite level
     * (beside a tile's edge, a crossing road's own level) it is never buried; at a level crossing it sinks BED_SINK
     * under the lowest, and each rail's head lies FLUSH_HIGH over the ground under it. */
    for (u32 k = 0; k < ns; k++) {
      const double f = Ss[k] / p->len;
      const double u = p->u0 + p->du * f, v = p->v0 + p->dv * f;
      const int end = k == 0 ? 0 : k == ns - 1u ? 1 : -1;
      const double qu = (end >= 0 ? p->rx[end] : p->ey) / mu, qv = (end >= 0 ? p->ry[end] : -p->ex) / mv;
      const double c = ground_at(&gr, u, v);
      const double rl = ground_at(&gr, u - qu * rail, v - qv * rail), rr = ground_at(&gr, u + qu * rail, v + qv * rail);
      const double sl = ground_at(&gr, u - qu * topHalf, v - qv * topHalf), sr = ground_at(&gr, u + qu * topHalf, v + qv * topHalf);
      double hi = c, lo = c;
      const double five[4] = { rl, rr, sl, sr };
      for (int q = 0; q < 4; q++) { if (five[q] > hi) hi = five[q]; if (five[q] < lo) lo = five[q]; }
      const double fl = ncr ? flush_at(p, mu, mv, cr, ncr, Ss[k]) : 0.0;
      const double full = hi + BED_TOP + bias;
      const double top = full * (1.0 - fl) + (lo - BED_SINK + bias) * fl;
      Tt[k] = top;
      Hl[k] = (full + RAIL_HIGH) * (1.0 - fl) + (rl + FLUSH_HIGH) * fl;
      Hr[k] = (full + RAIL_HIGH) * (1.0 - fl) + (rr + FLUSH_HIGH) * fl;
      Hk[k] = (full + RACK_HIGH) * (1.0 - fl) + (c + FLUSH_HIGH) * fl;
      double tl = ground_at(&gr, u - qu * toeHalf, v - qv * toeHalf) - BED_FOOT;
      double tr = ground_at(&gr, u + qu * toeHalf, v + qv * toeHalf) - BED_FOOT;
      tl = tl > top - 0.01 ? top - 0.01 : tl < top - BED_DROP ? top - BED_DROP : tl;
      tr = tr > top - 0.01 ? top - 0.01 : tr < top - BED_DROP ? top - BED_DROP : tr;
      Tl[k] = tl; Tr[k] = tr;
      Sf[k] = fl;
    }

    /* Left out where the line between the kept ones on either side passes within TOL of it. */
    u32 last = 0;
    for (u32 k = 1; k + 1u < ns; k++) {
      if (keep[k]) { last = k; continue; }
      const u32 j = k + 1u;
      int fits = Ss[j] - Ss[last] <= LONGEST;
      for (u32 q = last + 1u; fits && q < j; q++) {
        const double t = (Ss[q] - Ss[last]) / (Ss[j] - Ss[last]);
        fits = m_abs(Tt[last] + (Tt[j] - Tt[last]) * t - Tt[q]) <= TOL &&
               m_abs(Hl[last] + (Hl[j] - Hl[last]) * t - Hl[q]) <= TOL &&
               m_abs(Hr[last] + (Hr[j] - Hr[last]) * t - Hr[q]) <= TOL &&
               m_abs(Tl[last] + (Tl[j] - Tl[last]) * t - Tl[q]) <= TOL &&
               m_abs(Tr[last] + (Tr[j] - Tr[last]) * t - Tr[q]) <= TOL &&
               m_abs(Sf[last] + (Sf[j] - Sf[last]) * t - Sf[q]) <= 0.02;
      }
      if (!fits) { keep[k] = 1; last = k; }
    }

    /* The kept sections, each joined to the one before. */
    u32 prev = 0, have = 0;
    double prevF = 0;
    for (u32 k = 0; k < ns; k++) {
      if (!keep[k]) continue;
      const double f = Ss[k] / p->len;
      Frame F;
      frame_at(&o, p->u0 + p->du * f, p->v0 + p->dv * f, Tt[k], &F);
      const int end = k == 0 ? 0 : k == ns - 1u ? 1 : -1;
      const double rx = end >= 0 ? p->rx[end] : p->ey, ry = end >= 0 ? p->ry[end] : -p->ex;
      const double fl = Sf[k], top = Tt[k];
      const double along = p->a0 + (p->a1 - p->a0) * f;
      const u8 fb = (u8)(fl * 255.0 + 0.5);
      const u32 base = o.nv;
      put(&o, &F, rx, ry, -toeHalf, Tl[k], along, g, TRACK_BED, fb, 0);
      put(&o, &F, rx, ry, -topHalf, top, along, g, TRACK_BED, fb, 255);
      put(&o, &F, rx, ry, topHalf, top, along, g, TRACK_BED, fb, 255);
      put(&o, &F, rx, ry, toeHalf, Tr[k], along, g, TRACK_BED, fb, 0);
      for (int side = -1; side <= 1; side += 2) {
        const double c = side * rail, head = side < 0 ? Hl[k] : Hr[k];
        put(&o, &F, rx, ry, c - RAIL_HEAD, top, along, g, TRACK_RAIL, fb, 0);
        put(&o, &F, rx, ry, c - RAIL_HEAD, head, along, g, TRACK_RAIL, fb, 255);
        put(&o, &F, rx, ry, c + RAIL_HEAD, head, along, g, TRACK_RAIL, fb, 255);
        put(&o, &F, rx, ry, c + RAIL_HEAD, top, along, g, TRACK_RAIL, fb, 0);
      }
      if (rack) {
        put(&o, &F, rx, ry, -RACK_HALF, top, along, g, TRACK_RACK, fb, 0);
        put(&o, &F, rx, ry, -RACK_HALF, Hk[k], along, g, TRACK_RACK, fb, 255);
        put(&o, &F, rx, ry, RACK_HALF, Hk[k], along, g, TRACK_RACK, fb, 255);
        put(&o, &F, rx, ry, RACK_HALF, top, along, g, TRACK_RACK, fb, 0);
      }
      sections++;
      /* (The bed is left out where it lies wholly under a level crossing's road.) */
      if (have) join_sections(&o, prev, base, per, !(prevF > 0.999 && fl > 0.999));
      /* An end with nothing going on is closed: not at the tile's edge, a joint or a switch. */
      if (end >= 0 && !p->edge[end] && !p->joined[end] && !p->near[end] && fl < 0.999) close_end(&o, base, per, end == 0);
      prev = base; prevF = fl; have = 1;
    }
  }

  /* 16-bit indices where they reach, packed in place. */
  const u32 narrow = o.nv <= 65535u;
  if (narrow) {
    u16 *ib16 = (u16 *)o.ib;
    for (u32 i = 0; i < o.ni; i++) ib16[i] = (u16)o.ib[i];
  }
  res->vertexCount = o.nv;
  res->indexCount = o.ni;
  res->vertexOffset = vOff;
  res->indexOffset = iOff;
  res->indexIsU32 = narrow ? 0u : 1u;
  res->sections = sections;
  res->status = QM_OK;
  return QM_OK;
}
