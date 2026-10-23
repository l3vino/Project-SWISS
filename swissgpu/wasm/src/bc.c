/* bc.c — aerial photos into GPU block-compressed tiles, on a decode thread.
 *
 * A 256 x 256 RGBA tile goes in, 4096 blocks come out, ready for a single
 * writeTexture on the render thread. Encoding here rather than in a compute
 * shader keeps the render thread's share of a photo to one small copy: no
 * image upload, no compute pass, nothing that can make a frame late while
 * the decode threads, which exist for exactly this, do the work in parallel.
 *
 *   bc7_encode_tile  BC7 mode 6: two endpoints at 8-bit precision (seven bits
 *                    a channel and a shared low bit), sixteen shades between
 *                    them per 4x4 block. 16 bytes a block. The High setting.
 *   bc1_encode_tile  BC1: two 5:6:5 endpoints and four shades. 8 bytes a
 *                    block, half the memory, visibly grainier. Standard.
 *
 * Both fit the line through a block's colours along their principal axis
 * and refine its ends once by least squares against the weights the line
 * gives, then pick each pixel's index against the colours the hardware will
 * actually decode. Colours stay in sRGB as stored; the textures are sampled
 * through -srgb formats, so filtering happens in linear light.
 */

#include "core.h"

#define TILE 256u
#define BLOCKS 64u

INLINE float fsqrt(float x) { return __builtin_sqrtf(x); }
INLINE float fclamp(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }
INLINE int iround(float v) { return (int)(v + 0.5f); }   /* v >= 0 */

/* The block's 16 pixels as floats 0..255, and the line through them. */
typedef struct {
  float px[16][3];
  float mean[3];
  float axis[3];
  float lo, hi;            /* extent along the axis, from the mean */
} Block;

static void load_block(const u8 *rgba, u32 bx, u32 by, Block *b) {
  float lo[3] = { 255.f, 255.f, 255.f }, hi[3] = { 0.f, 0.f, 0.f };
  b->mean[0] = b->mean[1] = b->mean[2] = 0.f;
  for (u32 i = 0; i < 16; i++) {
    const u8 *p = rgba + (((by * 4u + (i >> 2)) * TILE) + bx * 4u + (i & 3u)) * 4u;
    for (u32 c = 0; c < 3; c++) {
      float v = (float)p[c];
      b->px[i][c] = v;
      b->mean[c] += v;
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  for (u32 c = 0; c < 3; c++) b->mean[c] *= 1.f / 16.f;

  /* Principal axis by power iteration on the covariance, from the box. */
  float xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (u32 i = 0; i < 16; i++) {
    float dx = b->px[i][0] - b->mean[0], dy = b->px[i][1] - b->mean[1], dz = b->px[i][2] - b->mean[2];
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  float ax = hi[0] - lo[0], ay = hi[1] - lo[1], az = hi[2] - lo[2];
  if (ax * ax + ay * ay + az * az < 1e-6f) { ax = ay = az = 0.577f; }
  for (int k = 0; k < 4; k++) {
    float nx = xx * ax + xy * ay + xz * az;
    float ny = xy * ax + yy * ay + yz * az;
    float nz = xz * ax + yz * ay + zz * az;
    float l = fsqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-6f) { ax = nx / l; ay = ny / l; az = nz / l; }
  }
  float l = fsqrt(ax * ax + ay * ay + az * az);
  b->axis[0] = ax / l; b->axis[1] = ay / l; b->axis[2] = az / l;

  b->lo = 1e30f; b->hi = -1e30f;
  for (u32 i = 0; i < 16; i++) {
    float t = (b->px[i][0] - b->mean[0]) * b->axis[0] + (b->px[i][1] - b->mean[1]) * b->axis[1] +
              (b->px[i][2] - b->mean[2]) * b->axis[2];
    if (t < b->lo) b->lo = t;
    if (t > b->hi) b->hi = t;
  }
}

/*
 * Least-squares ends of the line, given each pixel's share of the second
 * end. Leaves e0 and e1 alone when the system is too close to singular.
 */
static void refine(const Block *b, const float *share, float e0[3], float e1[3]) {
  float a00 = 0, a01 = 0, a11 = 0, b0[3] = { 0, 0, 0 }, b1[3] = { 0, 0, 0 };
  for (u32 i = 0; i < 16; i++) {
    float w = share[i], v = 1.f - w;
    a00 += v * v; a01 += v * w; a11 += w * w;
    for (u32 c = 0; c < 3; c++) { b0[c] += v * b->px[i][c]; b1[c] += w * b->px[i][c]; }
  }
  float det = a00 * a11 - a01 * a01;
  if (det <= 0.01f * a00 * a11) return;
  for (u32 c = 0; c < 3; c++) {
    e0[c] = (a11 * b0[c] - a01 * b1[c]) / det;
    e1[c] = (a00 * b1[c] - a01 * b0[c]) / det;
  }
}

/* ---- BC7 mode 6 --------------------------------------------------------- */

static const u32 W7[16] = { 0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64 };

typedef struct { u32 q[3]; u32 p; } Endpoint7;

/* Nearest storable endpoint, trying both low bits. */
static Endpoint7 quantise7(const float c[3]) {
  Endpoint7 best = { { 0, 0, 0 }, 0 };
  float bestErr = 1e30f;
  for (u32 p = 0; p < 2; p++) {
    Endpoint7 e;
    float err = 0.f;
    e.p = p;
    for (u32 k = 0; k < 3; k++) {
      float v = fclamp(c[k], 0.f, 255.f);
      int q = iround(fclamp((v - (float)p) * 0.5f, 0.f, 127.f));
      e.q[k] = (u32)q;
      float d = (float)(((u32)q << 1) | p) - v;
      err += d * d;
    }
    if (err < bestErr) { bestErr = err; best = e; }
  }
  return best;
}

INLINE void put(u32 *bits, u32 pos, u32 value, u32 count) {
  u32 word = pos >> 5, shift = pos & 31u;
  bits[word] |= value << shift;
  if (shift + count > 32u) bits[word + 1] |= value >> (32u - shift);
}

static void encode7(const Block *b, u32 *out) {
  float e0[3], e1[3];
  for (u32 c = 0; c < 3; c++) {
    e0[c] = b->mean[c] + b->axis[c] * b->lo;
    e1[c] = b->mean[c] + b->axis[c] * b->hi;
  }
  float span = b->hi - b->lo;
  if (span > 0.5f) {
    float share[16];
    for (u32 i = 0; i < 16; i++) {
      float t = ((b->px[i][0] - b->mean[0]) * b->axis[0] + (b->px[i][1] - b->mean[1]) * b->axis[1] +
                 (b->px[i][2] - b->mean[2]) * b->axis[2] - b->lo) / span;
      /* Snapped to the nearest of the sixteen weights. */
      u32 k = (u32)iround(fclamp(t, 0.f, 1.f) * 15.f);
      share[i] = (float)W7[k] / 64.f;
    }
    refine(b, share, e0, e1);
  }

  Endpoint7 q0 = quantise7(e0), q1 = quantise7(e1);
  u32 c0[3], c1[3];
  for (u32 c = 0; c < 3; c++) { c0[c] = (q0.q[c] << 1) | q0.p; c1[c] = (q1.q[c] << 1) | q1.p; }

  /* The palette the hardware decodes, then each pixel's nearest entry:
   * projected onto the line first, then that index and its neighbours
   * checked exactly. */
  float pal[16][3];
  for (u32 k = 0; k < 16; k++)
    for (u32 c = 0; c < 3; c++) pal[k][c] = (float)(((64u - W7[k]) * c0[c] + W7[k] * c1[c] + 32u) >> 6);
  float dir[3] = { pal[15][0] - pal[0][0], pal[15][1] - pal[0][1], pal[15][2] - pal[0][2] };
  float len2 = dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2];

  u32 idx[16];
  for (u32 i = 0; i < 16; i++) {
    const float *v = b->px[i];
    int guess = 0;
    if (len2 > 0.f) {
      float t = ((v[0] - pal[0][0]) * dir[0] + (v[1] - pal[0][1]) * dir[1] + (v[2] - pal[0][2]) * dir[2]) / len2;
      guess = iround(fclamp(t, 0.f, 1.f) * 15.f);
    }
    u32 best = (u32)guess;
    float bestE = 1e30f;
    int from = guess > 0 ? guess - 1 : 0, to = guess < 15 ? guess + 1 : 15;
    for (int k = from; k <= to; k++) {
      float d0 = pal[k][0] - v[0], d1 = pal[k][1] - v[1], d2 = pal[k][2] - v[2];
      float e = d0 * d0 + d1 * d1 + d2 * d2;
      if (e < bestE) { bestE = e; best = (u32)k; }
    }
    idx[i] = best;
  }

  /* The first pixel's index is stored in three bits, so it must be under 8:
   * otherwise swap the ends and mirror every index (the weights are
   * symmetric, so the decoded colours do not change). */
  if (idx[0] >= 8u) {
    Endpoint7 t = q0; q0 = q1; q1 = t;
    for (u32 i = 0; i < 16; i++) idx[i] = 15u - idx[i];
  }

  u32 bits[4] = { 0, 0, 0, 0 };
  put(bits, 0, 64u, 7);                     /* mode 6: six zero bits, then a one */
  put(bits, 7, q0.q[0], 7);  put(bits, 14, q1.q[0], 7);
  put(bits, 21, q0.q[1], 7); put(bits, 28, q1.q[1], 7);
  put(bits, 35, q0.q[2], 7); put(bits, 42, q1.q[2], 7);
  put(bits, 49, 127u, 7);    put(bits, 56, 127u, 7);   /* opaque */
  put(bits, 63, q0.p, 1);    put(bits, 64, q1.p, 1);
  put(bits, 65, idx[0], 3);
  for (u32 i = 1; i < 16; i++) put(bits, 68u + (i - 1u) * 4u, idx[i], 4);
  out[0] = bits[0]; out[1] = bits[1]; out[2] = bits[2]; out[3] = bits[3];
}

/** RGBA 256 x 256 at `rgbaOff` to 4096 BC7 blocks (64 KB) at `outOff`, row by row. */
EXPORT void bc7_encode_tile(u32 rgbaOff, u32 outOff) {
  const u8 *rgba = (const u8 *)PTR(rgbaOff);
  u32 *out = (u32 *)PTR(outOff);
  Block b;
  for (u32 by = 0; by < BLOCKS; by++)
    for (u32 bx = 0; bx < BLOCKS; bx++) {
      load_block(rgba, bx, by, &b);
      encode7(&b, out + (by * BLOCKS + bx) * 4u);
    }
}

/* ---- BC1 ---------------------------------------------------------------- */

INLINE u32 pack565(const float c[3]) {
  u32 r = (u32)iround(fclamp(c[0], 0.f, 255.f) * 31.f / 255.f);
  u32 g = (u32)iround(fclamp(c[1], 0.f, 255.f) * 63.f / 255.f);
  u32 b = (u32)iround(fclamp(c[2], 0.f, 255.f) * 31.f / 255.f);
  return (r << 11) | (g << 5) | b;
}

/* Expanded the way the hardware expands it: bit replication. */
INLINE void unpack565(u32 v, float out[3]) {
  u32 r = (v >> 11) & 31u, g = (v >> 5) & 63u, b = v & 31u;
  out[0] = (float)((r << 3) | (r >> 2));
  out[1] = (float)((g << 2) | (g >> 4));
  out[2] = (float)((b << 3) | (b >> 2));
}

/* Encodes with the given ends; returns the block's squared error. */
static float try1(const Block *b, const float a[3], const float z[3], u32 *out) {
  u32 c0 = pack565(a), c1 = pack565(z);
  if (c0 < c1) { u32 t = c0; c0 = c1; c1 = t; }   /* four-colour mode */
  float p[4][3];
  unpack565(c0, p[0]);
  unpack565(c1, p[1]);
  float err = 0.f;
  if (c0 == c1) {
    for (u32 i = 0; i < 16; i++)
      for (u32 c = 0; c < 3; c++) { float d = b->px[i][c] - p[0][c]; err += d * d; }
    out[0] = c0 | (c1 << 16); out[1] = 0;
    return err;
  }
  for (u32 c = 0; c < 3; c++) {
    p[2][c] = (2.f * p[0][c] + p[1][c]) / 3.f;
    p[3][c] = (p[0][c] + 2.f * p[1][c]) / 3.f;
  }
  u32 bits = 0;
  for (u32 i = 0; i < 16; i++) {
    u32 best = 0;
    float bestE = 1e30f;
    for (u32 k = 0; k < 4; k++) {
      float d0 = p[k][0] - b->px[i][0], d1 = p[k][1] - b->px[i][1], d2 = p[k][2] - b->px[i][2];
      float e = d0 * d0 + d1 * d1 + d2 * d2;
      if (e < bestE) { bestE = e; best = k; }
    }
    bits |= best << (2u * i);
    err += bestE;
  }
  out[0] = c0 | (c1 << 16);
  out[1] = bits;
  return err;
}

static void encode1(const Block *b, u32 *out) {
  float e0[3], e1[3];
  for (u32 c = 0; c < 3; c++) {
    e0[c] = b->mean[c] + b->axis[c] * b->hi;
    e1[c] = b->mean[c] + b->axis[c] * b->lo;
  }
  float span = b->hi - b->lo;
  if (span > 0.5f) {
    /* Palette order along the line from e1 to e0: shares of e0 are 0, 1/3,
     * 2/3, 1; `refine` takes shares of its second argument. */
    float share[16];
    for (u32 i = 0; i < 16; i++) {
      float t = ((b->px[i][0] - b->mean[0]) * b->axis[0] + (b->px[i][1] - b->mean[1]) * b->axis[1] +
                 (b->px[i][2] - b->mean[2]) * b->axis[2] - b->lo) / span;
      share[i] = (float)iround(fclamp(t, 0.f, 1.f) * 3.f) / 3.f;
    }
    refine(b, share, e1, e0);
  }
  u32 fitted[2], boxed[2];
  float fe = try1(b, e0, e1, fitted);
  /* The per-channel box too: never worse than the simplest encoder. */
  float lo[3] = { 255.f, 255.f, 255.f }, hi[3] = { 0.f, 0.f, 0.f };
  for (u32 i = 0; i < 16; i++)
    for (u32 c = 0; c < 3; c++) {
      if (b->px[i][c] < lo[c]) lo[c] = b->px[i][c];
      if (b->px[i][c] > hi[c]) hi[c] = b->px[i][c];
    }
  float be = try1(b, hi, lo, boxed);
  const u32 *best = be < fe ? boxed : fitted;
  out[0] = best[0]; out[1] = best[1];
}

/** RGBA 256 x 256 at `rgbaOff` to 4096 BC1 blocks (32 KB) at `outOff`, row by row. */
EXPORT void bc1_encode_tile(u32 rgbaOff, u32 outOff) {
  const u8 *rgba = (const u8 *)PTR(rgbaOff);
  u32 *out = (u32 *)PTR(outOff);
  Block b;
  for (u32 by = 0; by < BLOCKS; by++)
    for (u32 bx = 0; bx < BLOCKS; bx++) {
      load_block(rgba, bx, by, &b);
      encode1(&b, out + (by * BLOCKS + bx) * 2u);
    }
}
