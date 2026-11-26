/* profile.c — a railway line's height profile from the ground along it (Stage 5.18d).
 *
 * Each terrain tile used to take a line's height from its own mesh (shape.c), and tiles of different levels of detail
 * disagree by up to ~1.7 m where they meet: the track stepped at their edges. So every railway line gets one profile,
 * made once from the finest ground along it (the tunnels' thread reads the terrain's finest level every few metres
 * along each stretch of the line on the ground: js/engine/tunnels/rail-profiles.js), and every tile cut along it takes
 * its height from that (shape.c, a line's given profile). This makes the profile from those readings: a reading
 * standing off the median of the five round it by more than SPIKE taken as that median (a wall, an abutment); a dip
 * under the line's bridge over a road or a stream, which the bare ground has, spanned (span_dips, 5.18n); then
 * smoothed over SMOOTH metres either way, as shape.c smooths a line's own (a line fitted under a tent, so a steady
 * grade stays true up to the stretch's ends); and kept only where the straight
 * line between its kept neighbours strays from it by more than TOL, at most LONGEST metres apart, as track.c keeps its
 * sections. No grade is imposed: a railway is as steep as the ground it was built on (the Uetlibergbahn climbs 7.9%
 * on standard gauge, and the steepest of the ground along it is what a profile must follow).
 */

#include "core.h"

#define SPIKE 1.5       /* metres a reading may stand off the median of the five round it */
#define SMOOTH 6.0      /* metres either way the tent reaches */
#define GAP 4.5         /* readings farther apart than this are not smoothed across */
#define TOL 0.012       /* metres a point left out may stray from the line between its kept neighbours */
#define LONGEST 40.0    /* metres between kept points at most */
#define BRIDGE 30.0     /* metres either way a dip may reach and be spanned: dips under 60 m across (span_dips) */
#define DIP 1.0         /* metres a dip must lie under its filling at its deepest to be spanned */
#define RIM 0.05        /* metres its filling may stand over the ground where a spanned dip ends (its rims) */

/* The median of five (or fewer, at the ends). */
static double median5(const double *z, u32 from, u32 to) {
  double v[5];
  u32 n = 0;
  for (u32 i = from; i < to && n < 5u; i++) v[n++] = z[i];
  for (u32 i = 1; i < n; i++) {
    double x = v[i];
    u32 j = i;
    while (j > 0 && v[j - 1u] > x) { v[j] = v[j - 1u]; j--; }
    v[j] = x;
  }
  return n & 1u ? v[n / 2u] : 0.5 * (v[n / 2u - 1u] + v[n / 2u]);
}

/* Dips spanned (5.18n): swissALTI3D is bare ground, without what is built on it, so where a road or a stream passes
 * under a railway (the railway's bridge over it left out) the ground along the line has a notch, and the track went
 * down into it (by the Ceneri base tunnel's north portal 5.8 m over 24 m, where a road passes under three tracks). No
 * railway dips like that: a dip narrower than 2·BRIDGE (where a closing of the readings, everything under BRIDGE either
 * way filled, stands over them) lying more than DIP under that filling at its deepest, with its rims on the ground
 * either side within the run, becomes the straight line between its rims. A railway's own sag (vertical curves of
 * kilometres' radius) lies under its closing by a few decimetres at most; a run's ends (where a descent's closing would
 * stand over it) are left as they are. Runs of readings at most GAP apart, each on its own; dil, clo: scratch. */
static void span_dips(const double *s, double *z, u32 m, double *dil, double *clo) {
  for (u32 a = 0; a < m;) {
    u32 b = a + 1u;
    while (b < m && s[b] - s[b - 1u] <= GAP) b++;
    /* The closing: the highest within BRIDGE either way, then the lowest of those within BRIDGE either way. */
    for (u32 i = a, lo = a, hi = a; i < b; i++) {
      while (s[i] - s[lo] > BRIDGE) lo++;
      while (hi + 1u < b && s[hi + 1u] - s[i] <= BRIDGE) hi++;
      double v = z[lo];
      for (u32 j = lo + 1u; j <= hi; j++) if (z[j] > v) v = z[j];
      dil[i] = v;
    }
    for (u32 i = a, lo = a, hi = a; i < b; i++) {
      while (s[i] - s[lo] > BRIDGE) lo++;
      while (hi + 1u < b && s[hi + 1u] - s[i] <= BRIDGE) hi++;
      double v = dil[lo];
      for (u32 j = lo + 1u; j <= hi; j++) if (dil[j] < v) v = dil[j];
      clo[i] = v;
    }
    /* Each stretch lying more than RIM under the closing: spanned where its deepest is more than DIP under it and its
     * rims lie within the run. */
    for (u32 i = a; i < b;) {
      if (!(clo[i] - z[i] > RIM)) { i++; continue; }
      u32 e = i;
      double deepest = 0;
      while (e < b && clo[e] - z[e] > RIM) { if (clo[e] - z[e] > deepest) deepest = clo[e] - z[e]; e++; }
      if (deepest > DIP && i > a && e < b) {
        const u32 l = i - 1u, r = e;
        for (u32 k = i; k < e; k++) z[k] = z[l] + (z[r] - z[l]) * (s[k] - s[l]) / (s[r] - s[l]);
      }
      i = e;
    }
    a = b;
  }
}

/**
 * The profile of one stretch of a line from readings along it.
 * @param sOff, zOff  the readings: metres along the line (rising) and the ground there, float64 each (NaN: none)
 * @param n           how many
 * @param outOff      where the profile goes: [s, z] pairs, float32 (room for n pairs)
 * Returns how many pairs were written (0 with fewer than two readings).
 */
EXPORT u32 rail_profile(u32 sOff, u32 zOff, u32 n, u32 outOff) {
  const double *s0 = (const double *)PTR(sOff), *z0 = (const double *)PTR(zOff);
  float *out = (float *)PTR(outOff);
  u32 o1 = arena_alloc(n * 8u + 8u), o2 = arena_alloc(n * 8u + 8u), o3 = arena_alloc(n * 8u + 8u), o4 = arena_alloc(n + 8u);
  u32 o5 = arena_alloc(n * 8u + 8u), o6 = arena_alloc(n * 8u + 8u);
  if (!o1 || !o2 || !o3 || !o4 || !o5 || !o6) return 0;
  double *s = (double *)PTR(o1), *z = (double *)PTR(o2), *sm = (double *)PTR(o3);
  u8 *keep = (u8 *)PTR(o4);
  /* The readings known. */
  u32 m = 0;
  for (u32 i = 0; i < n; i++) if (z0[i] == z0[i] && s0[i] == s0[i]) { s[m] = s0[i]; z[m] = z0[i]; m++; }
  if (m < 2u) return 0;
  /* Spikes: a reading far off the median of the five round it is that median. */
  for (u32 i = 0; i < m; i++) {
    const u32 from = i >= 2u ? i - 2u : 0, to = i + 3u < m ? i + 3u : m;
    const double med = median5(z, from, to);
    sm[i] = m_abs(z[i] - med) > SPIKE ? med : z[i];
  }
  /* Dips under a railway's bridge spanned (span_dips). */
  span_dips(s, sm, m, (double *)PTR(o5), (double *)PTR(o6));
  /* Smoothed: at each reading, a straight line fitted to the readings within SMOOTH metres either way (in order and
   * at most GAP apart), weighted by a tent, and its height there: away from the ends the tent's average, and true to
   * a steady grade right up to them (an average there leaned towards the side it had readings on: 10 cm at 7.9%). */
  for (u32 i = 0; i < m; i++) {
    double sw = 1.0, sd = 0, sdd = 0, sz = sm[i], sdz = 0;
    for (u32 j = i; j > 0 && s[j] - s[j - 1u] <= GAP && s[i] - s[j - 1u] < SMOOTH; j--) {
      const double d = s[j - 1u] - s[i], q = 1.0 + d / SMOOTH;
      sw += q; sd += q * d; sdd += q * d * d; sz += q * sm[j - 1u]; sdz += q * d * sm[j - 1u];
    }
    for (u32 j = i; j + 1u < m && s[j + 1u] - s[j] <= GAP && s[j + 1u] - s[i] < SMOOTH; j++) {
      const double d = s[j + 1u] - s[i], q = 1.0 - d / SMOOTH;
      sw += q; sd += q * d; sdd += q * d * d; sz += q * sm[j + 1u]; sdz += q * d * sm[j + 1u];
    }
    const double den = sw * sdd - sd * sd;
    z[i] = den > 1e-9 ? (sz * sdd - sd * sdz) / den : sz / sw;
  }
  /* Kept where the line between the kept ones either side strays from it by more than TOL (both ends always, and
   * either side of a gap). */
  for (u32 i = 0; i < m; i++) keep[i] = (u8)(i == 0 || i + 1u == m || s[i + 1u] - s[i] > GAP || s[i] - s[i - 1u] > GAP);
  u32 last = 0;
  for (u32 k = 1; k + 1u < m; k++) {
    if (keep[k]) { last = k; continue; }
    const u32 j = k + 1u;
    int fits = s[j] - s[last] <= LONGEST;
    for (u32 q = last + 1u; fits && q < j; q++) {
      const double t = (s[q] - s[last]) / (s[j] - s[last]);
      fits = m_abs(z[last] + (z[j] - z[last]) * t - z[q]) <= TOL;
    }
    if (!fits) { keep[k] = 1; last = k; }
  }
  u32 w = 0;
  for (u32 i = 0; i < m; i++) {
    if (!keep[i]) continue;
    out[2u * w] = (float)s[i];
    out[2u * w + 1u] = (float)z[i];
    w++;
  }
  return w;
}
