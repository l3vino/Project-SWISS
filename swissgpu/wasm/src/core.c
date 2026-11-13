/* core.c — memory substrate for every thread.
 *
 * Compiled once to wasm32 (see build.sh), compiled once more by the browser,
 * then instantiated separately in each worker so every thread owns a private
 * linear memory. No libc, no allocator beyond a bump arena: allocation is a
 * pointer add, and freeing is resetting that pointer between tile jobs.
 */

#include "core.h"

#define WASM_PAGE 65536u

/* wasm-ld places this symbol just past the static data segment. */
extern u8 __heap_base;

static u8 *arena_ptr  = 0;
static u8 *arena_base = 0;
static u32 arena_cap  = 0;

/* ---- freestanding intrinsics -------------------------------------------- */
/* clang lowers struct copies and array fills to these even with -nostdlib. */

void *memcpy(void *dst, const void *src, unsigned long n) {
  u8 *d = (u8 *)dst;
  const u8 *s = (const u8 *)src;
  while (n--) *d++ = *s++;
  return dst;
}

void *memset(void *dst, int v, unsigned long n) {
  u8 *d = (u8 *)dst;
  while (n--) *d++ = (u8)v;
  return dst;
}

/* ---- arena --------------------------------------------------------------- */

static u32 heap_end(void) {
  return __builtin_wasm_memory_size(0) * WASM_PAGE;
}

/* Grow linear memory so that `need` bytes are available past arena_ptr. */
static int arena_reserve(u32 need) {
  u32 want = OFF(arena_ptr) + need;
  u32 have = heap_end();
  if (want <= have) return 1;
  u32 pages = (want - have + WASM_PAGE - 1u) / WASM_PAGE;
  if (__builtin_wasm_memory_grow(0, pages) == (unsigned long)-1) return 0;
  arena_cap = heap_end() - OFF(arena_base);
  return 1;
}

EXPORT void arena_init(void) {
  arena_base = &__heap_base;
  /* 16-byte align so v128 loads on arena memory are always aligned. */
  arena_base = (u8 *)PTR((OFF(arena_base) + 15u) & ~15u);
  arena_ptr = arena_base;
  arena_cap = heap_end() - OFF(arena_base);
}

/* Returns a byte offset into linear memory, or 0 on failure. */
EXPORT u32 arena_alloc(u32 bytes) {
  if (!arena_base) arena_init();
  bytes = (bytes + 15u) & ~15u;
  if (!arena_reserve(bytes)) return 0;
  u8 *p = arena_ptr;
  arena_ptr += bytes;
  return OFF(p);
}

/* Drop every allocation at once. Called between tile jobs. */
EXPORT void arena_reset(void) { arena_ptr = arena_base; }

EXPORT u32 arena_used(void) { return (u32)(arena_ptr - arena_base); }

EXPORT u32 arena_capacity(void) { return arena_cap; }

/* ---- primitives used by the terrain decoder ------------------------------ */

/* Quantized-mesh stores u/v/height as zigzag-encoded deltas. Decoding is a
 * running sum, so it is inherently sequential; keep it tight rather than wide. */
EXPORT void zigzag_delta_decode_u16(u32 offset, u32 count) {
  u16 *p = (u16 *)PTR(offset);
  u16 acc = 0;
  for (u32 i = 0; i < count; i++) {
    u16 z = p[i];
    acc = (u16)(acc + (u16)((z >> 1) ^ (u16) - (i32)(z & 1)));
    p[i] = acc;
  }
}

/* Quantized-mesh indices use high-water-mark encoding. */
EXPORT void high_water_decode_u16(u32 offset, u32 count) {
  u16 *p = (u16 *)PTR(offset);
  u16 highest = 0;
  for (u32 i = 0; i < count; i++) {
    u16 code = p[i];
    p[i] = (u16)(highest - code);
    if (code == 0) highest++;
  }
}

EXPORT void high_water_decode_u32(u32 offset, u32 count) {
  u32 *p = (u32 *)PTR(offset);
  u32 highest = 0;
  for (u32 i = 0; i < count; i++) {
    u32 code = p[i];
    p[i] = highest - code;
    if (code == 0) highest++;
  }
}

/* ---- identity + self test ------------------------------------------------ */

EXPORT u32 core_version(void) { return 0x000100; } /* 0.1.0 */

/* Exercises SIMD, the arena, and both decoders so a worker can prove its
 * instance is live and correct before it accepts real work. Returns 0 on pass. */
EXPORT u32 core_selftest(void) {
  arena_init();

  u32 off = arena_alloc(64);
  if (!off) return 1;
  if (off & 15u) return 2;

  u16 *v = (u16 *)PTR(off);
  /* zigzag(+1, -1, +2) applied from 0 -> 1, 0, 2 */
  v[0] = 2; v[1] = 1; v[2] = 4;
  zigzag_delta_decode_u16(off, 3);
  if (v[0] != 1 || v[1] != 0 || v[2] != 2) return 3;

  v[0] = 0; v[1] = 0; v[2] = 1;
  high_water_decode_u16(off, 3);
  if (v[0] != 0 || v[1] != 1 || v[2] != 1) return 4;

  /* v128 lane sum: fails to link or traps if simd128 is unavailable. */
  typedef int v4i __attribute__((__vector_size__(16)));
  v4i a = {1, 2, 3, 4}, b = {10, 20, 30, 40};
  v4i c = a + b;
  if (c[0] + c[1] + c[2] + c[3] != 110) return 5;

  arena_reset();
  if (arena_used() != 0) return 6;
  return 0;
}
