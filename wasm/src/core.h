/* core.h — shared declarations for the native core.
 *
 * Freestanding: no libc, no headers. Everything the C side needs is declared
 * here so each translation unit stays readable on its own.
 */
#ifndef CORE_H
#define CORE_H

#define EXPORT __attribute__((visibility("default"), used))
#define INLINE static inline __attribute__((always_inline))

typedef unsigned char      u8;
typedef unsigned short     u16;
typedef unsigned int       u32;
typedef signed char        i8;
typedef signed short       i16;
typedef signed int         i32;
typedef __UINTPTR_TYPE__   uptr;

/* Linear-memory addresses cross the wasm boundary as plain u32 offsets. */
#define PTR(off) ((void *)(uptr)(off))
#define OFF(ptr) ((u32)(uptr)(ptr))

void *memcpy(void *dst, const void *src, unsigned long n);
void *memset(void *dst, int v, unsigned long n);

/* arena */
void arena_init(void);
u32  arena_alloc(u32 bytes);
void arena_reset(void);
u32  arena_used(void);

/* unaligned readers: the quantized-mesh layout does not pad between sections */
INLINE u16 rd_u16(const u8 *p) { u16 v; memcpy(&v, p, 2); return v; }
INLINE u32 rd_u32(const u8 *p) { u32 v; memcpy(&v, p, 4); return v; }
INLINE float rd_f32(const u8 *p) { float v; memcpy(&v, p, 4); return v; }
INLINE double rd_f64(const u8 *p) { double v; memcpy(&v, p, 8); return v; }

/* math.c */
double m_sin(double x);
double m_cos(double x);
INLINE double m_sqrt(double x) { return __builtin_sqrt(x); }
INLINE double m_abs(double x) { return __builtin_fabs(x); }

#define WGS84_A  6378137.0
#define WGS84_E2 0.00669437999014132
#define M_PI_    3.14159265358979323846
#define DEG2RAD  0.017453292519943295

/* Geodetic to earth-centred earth-fixed, in metres. */
void geodetic_to_ecef(double lonRad, double latRad, double height, double *out3);

#endif
