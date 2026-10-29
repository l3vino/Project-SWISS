/* mathf.c — the transcendentals a freestanding build has to bring itself.
 *
 * Only sine and cosine are needed, and only for |x| <= pi, which is all a
 * longitude or latitude in radians can be. That bounds the argument reduction
 * to four quadrants and removes the need for anything like Payne-Hanek.
 *
 * The kernels are the classic fdlibm minimax polynomials on [-pi/4, pi/4],
 * accurate to about one unit in the last place of a double. Accuracy matters
 * here: a relative error of 1e-9 in a sine is 4 millimetres of terrain in the
 * wrong place, and it would show up as tiles not meeting each other.
 */

#include "core.h"

/* pi/2 split into two doubles so the reduction keeps its low-order bits. */
#define PIO2_HI 1.57079632679489655800e+00
#define PIO2_LO 6.12323399573676603587e-17

static double kernel_sin(double x) {
  const double S1 = -1.66666666666666324348e-01, S2 =  8.33333333332248946124e-03;
  const double S3 = -1.98412698298579493134e-04, S4 =  2.75573137070700676789e-06;
  const double S5 = -2.50507602534068634195e-08, S6 =  1.58969099521155010221e-10;
  double z = x * x;
  double r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + x * z * (S1 + z * r);
}

static double kernel_cos(double x) {
  const double C1 =  4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03;
  const double C3 =  2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07;
  const double C5 =  2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  double z = x * x;
  double r = C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))));
  return 1.0 - 0.5 * z + z * z * r;
}

/* Reduce x into [-pi/4, pi/4] and report which quadrant it came from. */
static int reduce(double x, double *out) {
  double q = x * (2.0 / M_PI_);
  int n = (int)(q < 0 ? q - 0.5 : q + 0.5);
  *out = (x - n * PIO2_HI) - n * PIO2_LO;
  return n & 3;
}

double m_sin(double x) {
  double r;
  switch (reduce(x, &r)) {
    case 0:  return kernel_sin(r);
    case 1:  return kernel_cos(r);
    case 2:  return -kernel_sin(r);
    default: return -kernel_cos(r);
  }
}

double m_cos(double x) {
  double r;
  switch (reduce(x, &r)) {
    case 0:  return kernel_cos(r);
    case 1:  return -kernel_sin(r);
    case 2:  return -kernel_cos(r);
    default: return kernel_sin(r);
  }
}

void geodetic_to_ecef(double lonRad, double latRad, double height, double *out3) {
  double sinLat = m_sin(latRad), cosLat = m_cos(latRad);
  double sinLon = m_sin(lonRad), cosLon = m_cos(lonRad);
  double n = WGS84_A / m_sqrt(1.0 - WGS84_E2 * sinLat * sinLat);
  out3[0] = (n + height) * cosLat * cosLon;
  out3[1] = (n + height) * cosLat * sinLon;
  out3[2] = (n * (1.0 - WGS84_E2) + height) * sinLat;
}

/* Exported only so the JS test harness can check the kernels against Math. */
EXPORT double math_sin(double x) { return m_sin(x); }
EXPORT double math_cos(double x) { return m_cos(x); }
