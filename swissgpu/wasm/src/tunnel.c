/* tunnel.c — the inside of a tunnel as a mesh: its cross-section swept
 * along its line, the collar round each portal, a cap where it stops.
 *
 * The render thread (js/engine/tunnels/) knows where a tunnel runs (its
 * line from the vector tiles, traced from portal to portal), how high (the
 * ground at its portals, the grade between, the table's culminations) and
 * what its cross-section is (sections.js: rules by kind and length, and a
 * table of the longest Swiss tunnels); this builds the triangles for the
 * stretch near the camera. A ring of the cross-section at every point given
 * (and every `ringStep` metres between), upright (tunnels climb a few
 * percent: the rings are not tilted with the grade), facing the way along
 * (at a corner, the mean of the ways either side). The cross-section is a
 * closed loop in metres across (to the right of the way along) and up from
 * the floor (the top of the rails or the road), counter-clockwise seen
 * along the way, so the triangles face inwards (the pass culls back faces:
 * from outside, through the opened terrain, nothing but the inside shows).
 * Corners of the cross-section marked `crease` (where a wall meets the
 * floor) get a vertex per side, so the light breaks there.
 *
 * Where several tracks or carriageways share the bore, it is wider there
 * (groups.js): each point carries how far right of the line the bore's
 * middle is and how much wider than one line's section it is. The loop is
 * stretched across by that, and its vault (above `spring`, where the walls
 * end) rises with the square root of the stretch: a wider span, a higher
 * arch.
 *
 * At a portal the tube runs on `collarDepth` metres out of the hillside
 * (per end, from the ground there: js/engine/tunnels/fit.js; its floor
 * rising as its approach does, `rise` a metre) and ends in a
 * collar: a face `collar` metres wide round the opening (not over the
 * floor), facing out; its outer side runs back along the tube `shell`
 * metres, over every ring it passes (the concrete over the vault where the
 * ground is lower than it), closed where it ends; and, where the portal is
 * a face cut into a slope, two wing walls from its sides out along the
 * approach, `wingTop` metres high at the collar.
 * A long road tunnel's ventilation ceiling (`ceiling` metres up, at that
 * height however wide the bore) is a slab across between the walls, facing
 * down: the loop stays the whole vault, the air ducts above the slab.
 *
 * Where the tunnel stops (a dead end) it is closed by a wall; where it runs
 * on beyond what is built, by a dark cap (the shader draws it as the dark
 * far down a tunnel); where it opens into another tube, not at all.
 *
 * Vertices, 48 bytes: position (float32x3, metres from the spec's ECEF
 * origin), normal and material (snorm16x4: the inward normal, the material
 * number in w), metres along the tunnel (float32: the lamps and the
 * daylight at the portals go by it), metres across and up of the cross-
 * section (float32x2), Web Mercator position (float32x2, reference pixels
 * from the spec's origin: the roads and rails drawn on the floor), the way
 * along there (snorm16x4, earth-centred: where the lamps are), and the bore
 * there (snorm16x2: its middle right of the line / 64 m, how many times one
 * line's section wide less one / 16: the lamps go with the bore). Indices
 * u32.
 */

#include "core.h"

/* Optimised for size, as shape.c: a tunnel's mesh is made once on a decode
 * thread, and every thread downloads and compiles the wasm at its start. */
#pragma clang attribute push (__attribute__((minsize)), apply_to = function)

#define TUNNEL_STRIDE 52u

typedef struct {
  u32 pointCount, profileCount;
  u32 flags;           /* per end two bits (end 0 bits 0–1, end 1 bits 2–3): END_* */
  float spring;        /* metres up where the walls end and the vault begins */
  double originX, originY, originZ;   /* ECEF metres the positions are relative to */
  float ringStep, collar, ceiling;    /* metres; ceiling: a flat slab across at that height, 0 none */
  float collarDepth[2];   /* per end: metres the tube runs on out of its portal to the collar */
  float shell[2];         /* per end: metres the collar's outer side runs back along the tube from the collar */
  float wingTop[2];       /* per end: metres up the wing walls' top is at the collar, 0 none */
  float rise[2];          /* per end: the floor's rise a metre out of the portal (its approach's), to the collar */
} TunnelSpec;             /* 88 bytes */

enum { END_JOIN = 0, END_PORTAL = 1, END_WALL = 2, END_DARK = 3 };

/* A point of the line: degrees, metres above the ellipsoid (the floor),
 * metres along the tunnel, its Web Mercator position (reference pixels from
 * the spec's origin), reference pixels per metre there, metres right of the
 * line the bore's middle is, how many times one line's section wide the
 * bore is. 9 doubles. */
#define POINT_DOUBLES 9u
/* A point of the cross-section: metres across, metres up, material, crease. 4 floats. */
#define PROFILE_FLOATS 4u
#define PROFILE_MOST 128u

typedef struct {
  u32 vertexCount, indexCount;
  u32 verticesOff, indicesOff;
  u32 status, rings, reserved0, reserved1;
} TunnelResult;                                   /* 32 bytes */

enum { TUNNEL_OK = 0, TUNNEL_BAD = 1, TUNNEL_OOM = 2 };

/* Materials (tunnel.wgsl reads them). */
enum { MAT_FLOOR = 1, MAT_WALKWAY = 2, MAT_WALL = 3, MAT_VAULT = 4, MAT_COLLAR = 5, MAT_DARK = 6, MAT_CEILING = 7 };

typedef struct { double x, y, z; } V3;
INLINE V3 v3(double x, double y, double z) { V3 r = { x, y, z }; return r; }
INLINE V3 add(V3 a, V3 b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
INLINE V3 sub(V3 a, V3 b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
INLINE V3 scale(V3 a, double s) { return v3(a.x * s, a.y * s, a.z * s); }
INLINE V3 cross(V3 a, V3 b) { return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x); }
INLINE double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/* East, north and up at a place (unit vectors, ECEF). */
static void enu(double lonRad, double latRad, V3 *e, V3 *n, V3 *u) {
  double sl = m_sin(lonRad), cl = m_cos(lonRad), sp = m_sin(latRad), cp = m_cos(latRad);
  *e = v3(-sl, cl, 0);
  *n = v3(-sp * cl, -sp * sl, cp);
  *u = v3(cp * cl, cp * sl, sp);
}

typedef struct {
  u8 *v;              /* vertices */
  u32 *idx;
  u32 nv, ni, capV, capI;
  double ox, oy, oz;  /* origin */
} Out;

INLINE i16 snorm(double x) {
  if (x > 1) x = 1;
  if (x < -1) x = -1;
  double q = x * 32767.0;
  return (i16)(q < 0 ? q - 0.5 : q + 0.5);
}

/* The way along and the bore (middle, width) of the ring being written (put_vertex's last fields). */
static V3 way;
static double boreOff, boreWide;

/* The cross-section as drawn: each point once, a creased one twice (the edge before it and the edge after it each
 * with its own normal); its material (of the edge leaving it) and whether it joins the next by a face. */
static u32 nr;
static float ra[2 * PROFILE_MOST], rh[2 * PROFILE_MOST], rna[2 * PROFILE_MOST], rnh[2 * PROFILE_MOST], rm[2 * PROFILE_MOST];
static u8 joinNext[2 * PROFILE_MOST];

__attribute__((noinline)) static void put_vertex(Out *o, V3 p, V3 n, double material, double along, double a, double h, double mx, double my) {
  u8 *w = o->v + o->nv * TUNNEL_STRIDE;
  float f[3] = { (float)(p.x - o->ox), (float)(p.y - o->oy), (float)(p.z - o->oz) };
  memcpy(w, f, 12);
  i16 s[4] = { snorm(n.x), snorm(n.y), snorm(n.z), (i16)material };
  memcpy(w + 12, s, 8);
  float g[5] = { (float)along, (float)a, (float)h, (float)mx, (float)my };
  memcpy(w + 20, g, 20);
  i16 t[6] = { snorm(way.x), snorm(way.y), snorm(way.z), 0, snorm(boreOff / 64.0), snorm((boreWide - 1.0) / 16.0) };
  memcpy(w + 40, t, 12);
  o->nv++;
}

INLINE void tri(Out *o, u32 a, u32 b, u32 c) {
  o->idx[o->ni++] = a; o->idx[o->ni++] = b; o->idx[o->ni++] = c;
}

/* A flat quad of the collar's concrete facing `n` (its corners in order round it, either way: turned to face n). */
static void quad(Out *o, V3 a, V3 b, V3 c, V3 d, V3 n, double along, double mx, double my) {
  if (dot(cross(sub(b, a), sub(c, a)), n) < 0) { V3 t = b; b = d; d = t; }
  u32 base = o->nv;
  put_vertex(o, a, n, MAT_COLLAR, along, 0, 0, mx, my);
  put_vertex(o, b, n, MAT_COLLAR, along, 0, 0, mx, my);
  put_vertex(o, c, n, MAT_COLLAR, along, 0, 0, mx, my);
  put_vertex(o, d, n, MAT_COLLAR, along, 0, 0, mx, my);
  tri(o, base, base + 1u, base + 2u);
  tri(o, base, base + 2u, base + 3u);
}

/* Wing walls (metres, radians): from the collar's sides out along the approach, flaring away from it, their top
 * falling from the spec's wingTop to WING_END over the floor, a footing WING_FOOT below the floor. */
#define WING_LONG 8.0
#define WING_THICK 0.6
#define WING_FOOT 3.0
#define WING_END 1.2
#define WING_COS 0.9135   /* cos 24° */
#define WING_SIN 0.4067

/* One ring: where it is, which way it faces, along how far, how wide. */
typedef struct {
  double lon, lat, h, s, mx, my, ppm, off, wide;
  double te, tn;      /* the way along, horizontal, east and north */
} Ring;

/* Where a ring is and its frame: centre (ECEF), right, up, along. */
typedef struct { V3 c, right, up, along; } Frame;

__attribute__((noinline)) static Frame frame_of(const Ring *R) {
  Frame f;
  V3 E, N, U;
  enu(R->lon * DEG2RAD, R->lat * DEG2RAD, &E, &N, &U);
  double c3[3];
  geodetic_to_ecef(R->lon * DEG2RAD, R->lat * DEG2RAD, R->h, c3);
  f.c = v3(c3[0], c3[1], c3[2]);
  /* Right of the way along: (tn, -te) in east and north. */
  f.right = add(scale(E, R->tn), scale(N, -R->te));
  f.along = add(scale(E, R->te), scale(N, R->tn));
  f.up = U;
  return f;
}

/* The cross-section as drawn at a ring: a point's place across and up, and
 * its normal (the loop stretched across by `wide`, the vault above `spring`
 * by its square root; normals by the inverse of that stretch). */
typedef struct { double a, h, na, nh; } Placed;

__attribute__((noinline)) static Placed placed(const Ring *R, double spring, float a, float h, float na, float nh) {
  Placed p;
  double sa = R->wide > 0.05 ? R->wide : 1.0, sh = h > spring ? m_sqrt(sa) : 1.0;
  p.a = R->off + a * sa;
  p.h = h > spring ? spring + (h - spring) * sh : h;
  double ma = na / sa, mh = nh / sh, l = m_sqrt(ma * ma + mh * mh);
  p.na = l > 1e-12 ? ma / l : 0; p.nh = l > 1e-12 ? mh / l : 1;
  return p;
}

/* A ring between two points, a share f of the way from A to B. */
static void ring_between(Ring *R, const double *A, const double *B, double f) {
  R->lon = A[0] + (B[0] - A[0]) * f; R->lat = A[1] + (B[1] - A[1]) * f; R->h = A[2] + (B[2] - A[2]) * f;
  R->s = A[3] + (B[3] - A[3]) * f; R->mx = A[4] + (B[4] - A[4]) * f; R->my = A[5] + (B[5] - A[5]) * f;
  R->ppm = A[6] + (B[6] - A[6]) * f; R->off = A[7] + (B[7] - A[7]) * f; R->wide = A[8] + (B[8] - A[8]) * f;
}

/* A ring a share f of the way from ring A to ring B. */
static void ring_lerp(Ring *R, const Ring *A, const Ring *B, double f) {
  R->lon = A->lon + (B->lon - A->lon) * f; R->lat = A->lat + (B->lat - A->lat) * f; R->h = A->h + (B->h - A->h) * f;
  R->s = A->s + (B->s - A->s) * f; R->mx = A->mx + (B->mx - A->mx) * f; R->my = A->my + (B->my - A->my) * f;
  R->ppm = A->ppm + (B->ppm - A->ppm) * f; R->off = A->off + (B->off - A->off) * f; R->wide = A->wide + (B->wide - A->wide) * f;
  double te = A->te + (B->te - A->te) * f, tn = A->tn + (B->tn - A->tn) * f, l = m_sqrt(te * te + tn * tn);
  R->te = l > 1e-9 ? te / l : B->te; R->tn = l > 1e-9 ? tn / l : B->tn;
}

/* A ring `d` metres beyond ring N along its way (d < 0: before it), its floor `dh` higher. */
static void ring_beyond(Ring *R, const Ring *N, double d, double dh) {
  double latr = N->lat * DEG2RAD;
  double de = N->te * d, dn = N->tn * d;
  *R = *N;
  R->lon = N->lon + de / (WGS84_A * m_cos(latr)) / DEG2RAD; R->lat = N->lat + dn / WGS84_A / DEG2RAD;
  R->s = N->s + d; R->mx = N->mx + de * N->ppm; R->my = N->my - dn * N->ppm; R->h = N->h + dh;
}

/* The outer loop round ring R's loop, `cw` out from it over the walls and the vault (the collar's outer side),
 * facing out; returns its first vertex. */
static u32 outer_loop(Out *o, const Ring *R, double spring, double cw) {
  Frame F = frame_of(R);
  way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
  u32 base = o->nv;
  for (u32 k = 0; k < nr; k++) {
    Placed q = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]);
    double oa = q.a - q.na * cw, oh = q.h - q.nh * cw;
    if (oh < 0) oh = 0;
    V3 p = add(F.c, add(scale(F.right, oa), scale(F.up, oh)));
    V3 n = add(scale(F.right, -q.na), scale(F.up, -q.nh));
    put_vertex(o, p, n, MAT_COLLAR, R->s, oa, oh, R->mx + R->tn * oa * R->ppm, R->my + R->te * oa * R->ppm);
  }
  return base;
}

/* Two outer loops (A before B along the tube) joined over the walls and the vault, facing out (the tube's own
 * faces between its rings, turned round). */
static void join_out(Out *o, u32 A, u32 B) {
  for (u32 k = 0; k < nr; k++) {
    u32 k2 = (k + 1) % nr;
    if (!joinNext[k] || rm[k] <= MAT_WALKWAY || rm[k2] <= MAT_WALKWAY) continue;
    u32 a = A + k, b = A + k2, c = B + k2, d = B + k;
    tri(o, a, c, b);
    tri(o, a, d, c);
  }
}

/* A face `cw` wide round ring R's loop over the walls and the vault, facing along the way (dir 1) or against
 * it (-1): a collar's face at a portal, the closed end of its outer side in the hill. */
static void annulus(Out *o, const Ring *R, double spring, double cw, double dir) {
  Frame F = frame_of(R);
  way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
  V3 n = scale(F.along, dir);
  u32 base = o->nv;
  for (u32 k = 0; k < nr; k++) {
    Placed q = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]);
    put_vertex(o, add(F.c, add(scale(F.right, q.a), scale(F.up, q.h))), n, MAT_COLLAR, R->s, q.a, q.h,
      R->mx + R->tn * q.a * R->ppm, R->my + R->te * q.a * R->ppm);
    double oa = q.a - q.na * cw, oh = q.h - q.nh * cw;
    if (oh < 0) oh = 0;
    put_vertex(o, add(F.c, add(scale(F.right, oa), scale(F.up, oh))), n, MAT_COLLAR, R->s, oa, oh,
      R->mx + R->tn * oa * R->ppm, R->my + R->te * oa * R->ppm);
  }
  for (u32 k = 0; k < nr; k++) {
    u32 k2 = (k + 1) % nr;
    if (!joinNext[k] || rm[k] <= MAT_WALKWAY || rm[k2] <= MAT_WALKWAY) continue;
    u32 i0 = base + k * 2u, o0 = i0 + 1u, i1 = base + k2 * 2u, o1 = i1 + 1u;
    /* The loop runs counter-clockwise seen along the way. */
    if (dir < 0) { tri(o, i0, o0, o1); tri(o, i0, o1, i1); }
    else { tri(o, i0, o1, o0); tri(o, i0, i1, o1); }
  }
}

/* A portal's threshold (Stage 5.17e): at the mouth, under the floor and the walkways from their edge down
 * THRESHOLD metres, and under the collar's face beside them (the walls' feet), facing out. The road in front is
 * pinned a hair under the floor (js/engine/vector/portals.js) and the ground under the floor is cut away
 * (terrain.wgsl FLOOR_UNDER): a line of sight over the road's edge went on under the floor and into the walkways'
 * open ends, and met nothing (the sky in slivers along the bottom of the mouth). */
#define THRESHOLD 0.6

static void threshold(Out *o, const Ring *R, double spring, double cw, double dir) {
  Frame F = frame_of(R);
  way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
  V3 n = scale(F.along, dir);
  double lo = 1e30, hi = -1e30, hLo = 0, hHi = 0;
  for (u32 k = 0; k < nr; k++) {
    u32 k2 = (k + 1) % nr;
    if (!joinNext[k] || (rm[k] > MAT_WALKWAY && rm[k2] > MAT_WALKWAY)) continue;
    Placed p = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]), q = placed(R, spring, ra[k2], rh[k2], rna[k2], rnh[k2]);
    if (p.a < lo) { lo = p.a; hLo = p.h; }
    if (p.a > hi) { hi = p.a; hHi = p.h; }
    if (q.a < lo) { lo = q.a; hLo = q.h; }
    if (q.a > hi) { hi = q.a; hHi = q.h; }
    if (m_abs(p.a - q.a) < 1e-4) continue;
    quad(o, add(F.c, add(scale(F.right, p.a), scale(F.up, p.h))), add(F.c, add(scale(F.right, q.a), scale(F.up, q.h))),
      add(F.c, add(scale(F.right, q.a), scale(F.up, -THRESHOLD))), add(F.c, add(scale(F.right, p.a), scale(F.up, -THRESHOLD))),
      n, R->s, R->mx, R->my);
  }
  if (!(lo < hi)) return;
  for (int side = -1; side <= 1; side += 2) {
    const double a = side < 0 ? lo : hi, h = side < 0 ? hLo : hHi, b = a + (double)side * cw;
    quad(o, add(F.c, add(scale(F.right, a), scale(F.up, h))), add(F.c, add(scale(F.right, b), scale(F.up, h))),
      add(F.c, add(scale(F.right, b), scale(F.up, -THRESHOLD))), add(F.c, add(scale(F.right, a), scale(F.up, -THRESHOLD))),
      n, R->s, R->mx, R->my);
  }
}

/* Where a portal's collar's outer side runs: the rings a..b it passes (in order along the tube) and, where it
 * ends between two rings, a ring there (`last`). */
typedef struct { u32 a, b, have; Ring last; } Span;

static void span_of(Span *S, const Ring *rings, u32 nring, u32 end, double len) {
  S->have = 0;
  if (end == 0) {
    const double s0 = rings[0].s;
    S->a = 0; S->b = 0;
    while (S->b + 1 < nring && rings[S->b + 1].s - s0 < len) S->b++;
    if (S->b + 1 < nring) {
      const Ring *A = &rings[S->b], *B = &rings[S->b + 1];
      double ds = B->s - A->s;
      ring_lerp(&S->last, A, B, ds > 1e-9 ? (s0 + len - A->s) / ds : 0);
      S->have = 1;
    }
  } else {
    const double s0 = rings[nring - 1].s;
    S->b = nring - 1; S->a = S->b;
    while (S->a > 0 && s0 - rings[S->a - 1].s < len) S->a--;
    if (S->a > 0) {
      const Ring *A = &rings[S->a - 1], *B = &rings[S->a];
      double ds = B->s - A->s;
      ring_lerp(&S->last, A, B, ds > 1e-9 ? (s0 - len - A->s) / ds : 0);
      S->have = 1;
    }
  }
}

/**
 * Builds the mesh for `spec` from its points and cross-section into the
 * arena; the result's offsets point at the vertices and indices. Returns
 * the status.
 */
EXPORT u32 tunnel_mesh(u32 specOff, u32 pointsOff, u32 profileOff, u32 resOff) {
  const TunnelSpec *spec = (const TunnelSpec *)PTR(specOff);
  const double *pts = (const double *)PTR(pointsOff);
  const float *prof = (const float *)PTR(profileOff);
  TunnelResult *res = (TunnelResult *)PTR(resOff);
  memset(res, 0, sizeof(TunnelResult));
  const u32 np = spec->pointCount, nq = spec->profileCount;
  if (np < 2 || nq < 3 || nq > PROFILE_MOST) return (res->status = TUNNEL_BAD);
  const double step = spec->ringStep > 0.5f ? spec->ringStep : 25.0;
  const double spring = spec->spring;
  const u32 end0 = spec->flags & 3u, end1 = (spec->flags >> 2) & 3u;
  const double cw = spec->collar > 0 ? spec->collar : 0;

  /* The cross-section as drawn. */
  nr = 0;
  double ch = 0;                   /* the loop's mean height, for the caps' middle */
  for (u32 k = 0; k < nq; k++) {
    const float *P = prof + k * PROFILE_FLOATS;
    const float *A = prof + ((k + nq - 1) % nq) * PROFILE_FLOATS, *B = prof + ((k + 1) % nq) * PROFILE_FLOATS;
    /* Inward normals of the edges before and after: the loop runs
     * counter-clockwise, so inwards is the edge turned left. */
    double ea = P[0] - A[0], eh = P[1] - A[1], fa = B[0] - P[0], fh = B[1] - P[1];
    double la = m_sqrt(ea * ea + eh * eh), lf = m_sqrt(fa * fa + fh * fh);
    if (la <= 0 || lf <= 0) return (res->status = TUNNEL_BAD);
    double n1a = -eh / la, n1h = ea / la, n2a = -fh / lf, n2h = fa / lf;
    ch += P[1];
    if (P[3] > 0.5f) {
      ra[nr] = P[0]; rh[nr] = P[1]; rna[nr] = (float)n1a; rnh[nr] = (float)n1h; rm[nr] = A[2]; joinNext[nr] = 0; nr++;
      ra[nr] = P[0]; rh[nr] = P[1]; rna[nr] = (float)n2a; rnh[nr] = (float)n2h; rm[nr] = P[2]; joinNext[nr] = 1; nr++;
    } else {
      double sa = n1a + n2a, sh = n1h + n2h, ls = m_sqrt(sa * sa + sh * sh);
      ra[nr] = P[0]; rh[nr] = P[1]; rna[nr] = (float)(ls > 1e-9 ? sa / ls : n2a); rnh[nr] = (float)(ls > 1e-9 ? sh / ls : n2h);
      rm[nr] = P[2]; joinNext[nr] = 1; nr++;
    }
  }
  ch /= nq;

  /* Rings: at every point and every `step` metres between, the way along
   * there the mean of the pieces either side; at a portal, one out of it by
   * its collar depth. */
  const double depth0 = spec->collarDepth[0] > 0 ? spec->collarDepth[0] : 0, depth1 = spec->collarDepth[1] > 0 ? spec->collarDepth[1] : 0;
  u32 capR = 8;
  for (u32 i = 0; i + 1 < np; i++) capR += (u32)(m_abs(pts[(i + 1) * POINT_DOUBLES + 3] - pts[i * POINT_DOUBLES + 3]) / step) + 2u;
  u32 ringOff = arena_alloc(capR * (u32)sizeof(Ring));
  if (!ringOff) return (res->status = TUNNEL_OOM);
  Ring *rings = (Ring *)PTR(ringOff);
  const u32 lead = end0 == END_PORTAL && depth0 > 0 ? 1u : 0u;
  u32 nring = lead;                 /* room for the ring out of the hillside at the first end */
  double pte = 1, ptn = 0;
  for (u32 i = 0; i + 1 < np; i++) {
    const double *A = pts + i * POINT_DOUBLES, *B = pts + (i + 1) * POINT_DOUBLES;
    double latm = 0.5 * (A[1] + B[1]) * DEG2RAD;
    double de = (B[0] - A[0]) * DEG2RAD * WGS84_A * m_cos(latm), dn = (B[1] - A[1]) * DEG2RAD * WGS84_A;
    double l = m_sqrt(de * de + dn * dn);
    double te = l > 1e-9 ? de / l : pte, tn = l > 1e-9 ? dn / l : ptn;
    u32 parts = (u32)(m_abs(B[3] - A[3]) / step) + 1u;
    for (u32 j = 0; j < parts; j++) {
      Ring *R = &rings[nring++];
      ring_between(R, A, B, (double)j / parts);
      R->te = te; R->tn = tn;
      /* A corner: the mean of the ways either side. */
      if (j == 0 && i > 0) {
        double se = pte + te, sn = ptn + tn, ls = m_sqrt(se * se + sn * sn);
        if (ls > 1e-9) { R->te = se / ls; R->tn = sn / ls; }
      }
    }
    pte = te; ptn = tn;
  }
  {
    Ring *R = &rings[nring++];
    ring_between(R, pts + (np - 2) * POINT_DOUBLES, pts + (np - 1) * POINT_DOUBLES, 1.0);
    R->te = pte; R->tn = ptn;
  }
  /* (Out of the portal the floor follows its approach.) */
  if (lead) ring_beyond(&rings[0], &rings[1], -depth0, spec->rise[0] * depth0);
  if (end1 == END_PORTAL && depth1 > 0) { ring_beyond(&rings[nring], &rings[nring - 1], depth1, spec->rise[1] * depth1); nring++; }

  /* Each portal's collar: its outer side's span. */
  Span spans[2];
  u32 shellLoops = 0;
  for (u32 end = 0; end < 2; end++) {
    spans[end].a = 1; spans[end].b = 0; spans[end].have = 0;    /* none */
    if ((end == 0 ? end0 : end1) != END_PORTAL || cw <= 0 || spec->shell[end] <= 0) continue;
    span_of(&spans[end], rings, nring, end, spec->shell[end]);
    shellLoops += spans[end].b - spans[end].a + 1u + spans[end].have;
  }

  /* Room: the tube; per portal its collar's face, outer side and its closed end, its threshold and wing walls; per
   * cap its fan; the ceiling slab. */
  Out o;
  o.ox = spec->originX; o.oy = spec->originY; o.oz = spec->originZ;
  o.capV = nring * nr + shellLoops * nr + 2u * (2u * 2u * nr) + 2u * (4u * nr + 8u) + 2u * (nr + 1u) + 2u * 32u + 2u * nring + 16u;
  o.capI = (nring > 1 ? (nring - 1) * nr * 6u : 0) + shellLoops * nr * 6u + 2u * (2u * nr * 6u) + 2u * (6u * nr + 12u) +
    2u * (nr * 3u) + 2u * 48u + nring * 6u + 16u;
  u32 vOff = arena_alloc(o.capV * TUNNEL_STRIDE), iOff = arena_alloc(o.capI * 4u);
  if (!vOff || !iOff) return (res->status = TUNNEL_OOM);
  o.v = (u8 *)PTR(vOff); o.idx = (u32 *)PTR(iOff); o.nv = 0; o.ni = 0;

  /* The tube. */
  for (u32 r = 0; r < nring; r++) {
    const Ring *R = &rings[r];
    Frame F = frame_of(R);
    way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
    for (u32 k = 0; k < nr; k++) {
      Placed q = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]);
      V3 p = add(F.c, add(scale(F.right, q.a), scale(F.up, q.h)));
      V3 n = add(scale(F.right, q.na), scale(F.up, q.nh));
      /* The map position: right is (tn, -te) metres east and north; merc y runs south. */
      double mx = R->mx + R->tn * q.a * R->ppm, my = R->my + R->te * q.a * R->ppm;
      put_vertex(&o, p, n, rm[k], R->s, q.a, q.h, mx, my);
    }
  }
  for (u32 r = 0; r + 1 < nring; r++) {
    for (u32 k = 0; k < nr; k++) {
      if (!joinNext[k]) continue;
      u32 k2 = (k + 1) % nr;
      u32 a = r * nr + k, b = r * nr + k2, c = (r + 1) * nr + k2, d = (r + 1) * nr + k;
      tri(&o, a, b, c);
      tri(&o, a, c, d);
    }
  }

  /* The ceiling slab: per ring where the loop (as drawn there) crosses its
   * height on the left and on the right, joined ring to ring, facing down. */
  const double ceil = spec->ceiling;
  if (ceil > 0) {
    u32 first = o.nv, made = 0;
    for (u32 r = 0; r < nring; r++) {
      const Ring *R = &rings[r];
      Frame F = frame_of(R);
      way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
      double left = 0, right = 0;
      int haveL = 0, haveR = 0;
      for (u32 k = 0; k < nr; k++) {
        u32 k2 = (k + 1) % nr;
        Placed p = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]), q = placed(R, spring, ra[k2], rh[k2], rna[k2], rnh[k2]);
        if ((p.h - ceil) * (q.h - ceil) > 0 || p.h == q.h) continue;
        double a = p.a + (q.a - p.a) * (ceil - p.h) / (q.h - p.h);
        if (a > R->off && (!haveR || a > right)) { right = a; haveR = 1; }
        if (a < R->off && (!haveL || a < left)) { left = a; haveL = 1; }
      }
      if (!haveL || !haveR) { left = R->off; right = R->off; }
      V3 down = scale(F.up, -1.0);
      put_vertex(&o, add(F.c, add(scale(F.right, left), scale(F.up, ceil))), down, MAT_CEILING, R->s, left, ceil,
        R->mx + R->tn * left * R->ppm, R->my + R->te * left * R->ppm);
      put_vertex(&o, add(F.c, add(scale(F.right, right), scale(F.up, ceil))), down, MAT_CEILING, R->s, right, ceil,
        R->mx + R->tn * right * R->ppm, R->my + R->te * right * R->ppm);
      made++;
    }
    /* Facing down (the winding checked against the normal: which way is left depends on the ring's way). */
    for (u32 r = 0; r + 1 < made; r++) {
      u32 l0 = first + 2u * r, r0 = l0 + 1u, l1 = l0 + 2u, r1 = l0 + 3u;
      float A[3], B[3], C[3];
      i16 N[3];
      memcpy(A, o.v + l0 * TUNNEL_STRIDE, 12);
      memcpy(B, o.v + r0 * TUNNEL_STRIDE, 12);
      memcpy(C, o.v + l1 * TUNNEL_STRIDE, 12);
      memcpy(N, o.v + l0 * TUNNEL_STRIDE + 12, 6);
      V3 pl0 = v3(A[0], A[1], A[2]), pr0 = v3(B[0], B[1], B[2]), pl1 = v3(C[0], C[1], C[2]), n = v3(N[0], N[1], N[2]);
      if (dot(cross(sub(pr0, pl0), sub(pl1, pl0)), n) > 0) { tri(&o, l0, r0, r1); tri(&o, l0, r1, l1); }
      else { tri(&o, l0, r1, r0); tri(&o, l0, l1, r1); }
    }
  }

  for (u32 end = 0; end < 2; end++) {
    const u32 type = end == 0 ? end0 : end1;
    const Ring *R = end == 0 ? &rings[0] : &rings[nring - 1];
    const double dir = end == 0 ? -1.0 : 1.0;   /* outwards along the way */
    Frame F = frame_of(R);
    V3 out = scale(F.along, dir);
    way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;

    if (type == END_WALL || type == END_DARK) {
      /* A fan from the middle, facing into the tube. */
      u32 base = o.nv;
      double mid = R->off, mh = spring + (ch - spring) * (ch > spring ? m_sqrt(R->wide > 0.05 ? R->wide : 1.0) : 1.0);
      V3 n = scale(out, -1.0);
      u32 mat = type == END_WALL ? MAT_WALL : MAT_DARK;
      put_vertex(&o, add(F.c, add(scale(F.right, mid), scale(F.up, mh))), n, mat, R->s, mid, mh,
        R->mx + R->tn * mid * R->ppm, R->my + R->te * mid * R->ppm);
      for (u32 k = 0; k < nr; k++) {
        Placed q = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]);
        put_vertex(&o, add(F.c, add(scale(F.right, q.a), scale(F.up, q.h))), n, mat, R->s, q.a, q.h,
          R->mx + R->tn * q.a * R->ppm, R->my + R->te * q.a * R->ppm);
      }
      for (u32 k = 0; k < nr; k++) {
        if (!joinNext[k]) continue;
        u32 k2 = (k + 1) % nr;
        /* Seen from inside, the loop turns the other way at the first end. */
        if (end == 0) tri(&o, base, base + 1u + k2, base + 1u + k);
        else tri(&o, base, base + 1u + k, base + 1u + k2);
      }
      continue;
    }
    if (type != END_PORTAL || cw <= 0) continue;

    /* The collar: round the opening, over the walls and the vault (not the
     * floor or the walkways), a face `collar` metres wide facing out. */
    annulus(&o, R, spring, cw, dir);
    threshold(&o, R, spring, cw, dir);
    /* Its outer side, along the tube over every ring it passes, closed
     * where it ends (facing into the hill). */
    const Span *S = &spans[end];
    if (S->a <= S->b) {
      u32 prev = 0, have = 0;
      if (end == 1 && S->have) { prev = outer_loop(&o, &S->last, spring, cw); have = 1; }
      for (u32 r = S->a; r <= S->b; r++) {
        u32 cur = outer_loop(&o, &rings[r], spring, cw);
        if (have) join_out(&o, prev, cur);
        prev = cur; have = 1;
      }
      if (end == 0 && S->have) { u32 cur = outer_loop(&o, &S->last, spring, cw); join_out(&o, prev, cur); }
      annulus(&o, S->have ? &S->last : &rings[end == 0 ? S->b : S->a], spring, cw, -dir);
    }
    /* Wing walls either side, holding back the cut the approach runs in. */
    const double wt = spec->wingTop[end];
    if (wt <= 0) continue;
    way = F.along; boreOff = R->off; boreWide = R->wide > 0.05 ? R->wide : 1.0;
    double halfMax = 0;
    for (u32 k = 0; k < nr; k++) {
      Placed q = placed(R, spring, ra[k], rh[k], rna[k], rnh[k]);
      if (q.h <= spring + 1e-6 && m_abs(q.a - R->off) > halfMax) halfMax = m_abs(q.a - R->off);
    }
    for (int side = -1; side <= 1; side += 2) {
      const double sg = (double)side;
      V3 foot = add(F.c, scale(F.right, R->off + sg * (halfMax + cw)));
      V3 d = add(scale(out, WING_COS), scale(F.right, sg * WING_SIN));
      V3 nIn = sub(scale(out, WING_SIN), scale(F.right, sg * WING_COS));      /* towards the approach */
      V3 back = scale(nIn, -WING_THICK);
      V3 p0b = add(foot, scale(F.up, -WING_FOOT)), p0t = add(foot, scale(F.up, wt));
      V3 p1 = add(foot, scale(d, WING_LONG));
      V3 p1b = add(p1, scale(F.up, -WING_FOOT)), p1t = add(p1, scale(F.up, wt < WING_END ? wt : WING_END));
      double along = R->s + dir * 0.5 * WING_LONG;
      quad(&o, p0b, p0t, p1t, p1b, nIn, along, R->mx, R->my);
      quad(&o, add(p0b, back), add(p0t, back), add(p1t, back), add(p1b, back), scale(nIn, -1.0), along, R->mx, R->my);
      quad(&o, p0t, p1t, add(p1t, back), add(p0t, back), F.up, along, R->mx, R->my);
      quad(&o, p1b, p1t, add(p1t, back), add(p1b, back), d, along, R->mx, R->my);
    }
  }

  res->vertexCount = o.nv;
  res->indexCount = o.ni;
  res->verticesOff = vOff;
  res->indicesOff = iOff;
  res->rings = nring;
  return (res->status = TUNNEL_OK);
}

EXPORT u32 tunnel_spec_size(void) { return (u32)sizeof(TunnelSpec); }
EXPORT u32 tunnel_result_size(void) { return (u32)sizeof(TunnelResult); }
EXPORT u32 tunnel_stride(void) { return TUNNEL_STRIDE; }

#pragma clang attribute pop
