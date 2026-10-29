/* mvt.c — a vector tile's roads and rails, made findable from a pixel.
 *
 * Roads and railways are drawn per pixel (Thöny, Billeter and Pajarola,
 * "Large-scale pixel-precise deferred vector maps", 2018; DOOM 2016's
 * clustered decals are the same idea): every pixel of the ground works out
 * where it is on the map and tests the few line segments near it. For that
 * each tile needs its lines as plain segments and an index that lists, for
 * every cell of a grid laid over the tile, the segments that can reach into
 * it. Building that from a Mapbox Vector Tile is this file's work, on a
 * decode thread, so the render thread only copies one finished block to the
 * GPU.
 *
 * What happens, in order:
 *   1. The tile's protobuf is walked once to find the layers wanted (the
 *      transportation layer, and the building layer, whose density tells a
 *      town from the open country); every other layer is skipped by its
 *      length without being read.
 *   2. Each line feature's tags become small numbers through the adapter's
 *      code tables (the schema, built in js/formats/vector-tile.js from plain
 *      data such as js/adapters/swisstopo-transport.js), and its class and
 *      subclass decide its kind: motorway, footway, rail, tram... Features
 *      of no kind (map masks, things under construction) are dropped here.
 *   3. Pieces of the same road are joined into continuous lines: a vector
 *      tile cuts a road at every junction and every change of attribute (a
 *      bridge starts), but the dashes painted on it run on. Two pieces join
 *      where they meet end to end with nothing else of their kind there, or
 *      run straight on through a node where something else joins.
 *   4. Each line is cut where it crosses the tile's edge (a tile carries a
 *      32-unit margin of its neighbours' ground), and its length along the
 *      way is measured in metres for the dash pattern. Where a line runs on
 *      into the next tile the pattern must not jump, so at every crossing
 *      point the length is set to a value that depends only on where that
 *      point is on the map, which the neighbouring tile works out the same,
 *      and between two crossings the length is stretched by the fraction of
 *      a pattern needed to meet both (PERIOD: the Swiss dash patterns 3/3,
 *      3/6 and 6/12 m and 0.6 m sleepers all repeat every 18 m; at most
 *      half a pattern over the way between the crossings, under 1% for a
 *      line through a tile, a few per cent for one cutting a corner).
 *   5. The grid: 128 by 128 cells over the tile (13 m at zoom 14, 26 m at
 *      13). A segment is listed in every cell its widest possible drawing
 *      (the kind's largest half-width, plus a margin for anti-aliasing) can
 *      touch, and each cell's list is ordered by drawing priority, lowest
 *      first, so a pixel paints them in order without sorting anything.
 *      Measured on swisstopo's tiles at Zürich HB: 3.2 segments per cell
 *      on average, 18 at the 99th percentile, 41 at worst at zoom 14 (13 m
 *      cells); 4.3, 26 and 64 at zoom 13 (26 m cells). In the mountains
 *      (Airolo, Göschenen) four cells in five are empty.
 *
 * The block (BLOCK_*) is self-describing; js/engine/vector and the shaders
 * read it. Positions stay in tile units (extent 4096: 0.4 m at zoom 14 in
 * Switzerland); a block knows its metres per unit.
 */

#include "core.h"

typedef unsigned long long u64;

/* The common period of the dash patterns, metres: lengths along a line are
 * only meaningful modulo this, and are matched across tiles to it. */
#define PERIOD 18.0

/* Metres across the whole Web Mercator map at the latitude of Switzerland's
 * middle (46.8°): the dash anchors' scale (see the cut points below). */
#define ANCHOR_SCALE (40075016.686 * 0.68455)

/* Grid cells per side. */
#define GRID 128u

/* Building density grid per side (for "in town"). */
#define DENSITY 32u

/* Most segments a block indexes: references are 16-bit. */
#define MAX_SEGMENTS 65535u

/* Joins through a node where other things meet need the two pieces to run
 * on nearly straight: their directions out of the node at least this far
 * apart (cosine). */
#define STRAIGHT_ON -0.7f

/* ---- the output ---------------------------------------------------------- */

#define BLOCK_MAGIC 0x31425456u   /* 'VTB1' */
#define BLOCK_VERSION 1u

typedef struct {
  u32 magic, version;             /*  0 */
  u32 segmentCount, lineCount;    /*  8 */
  u32 grid;                       /* 16  cells per side */
  u32 cellsOff;                   /* 20  bytes from the block's start: u32[grid*grid], start << 8 | count */
  u32 refsOff;                    /* 24  u16 segment numbers, every cell's run in turn */
  u32 refCount;                   /* 28 */
  u32 segmentsOff;                /* 32  Segment[segmentCount] */
  u32 linesOff;                   /* 36  Line[lineCount] */
  u32 densityOff;                 /* 40  u8[DENSITY*DENSITY], buildings per cell */
  u32 density;                    /* 44  DENSITY */
  float metresPerUnit;            /* 48 */
  u32 extent;                     /* 52 */
  u32 zoom;                       /* 56 */
  u32 dropped;                    /* 60  references or segments that did not fit */
} BlockHeader;                    /* 64 bytes */

/* Eight words, as the shaders read them. */
typedef struct {
  float ax, ay, bx, by;           /* tile units */
  float s0, s1;                   /* length along the line at a and b, metres (see 4. above) */
  u32 attr;                       /* ATTR_* */
  u32 link;                       /* LINK_* */
} Segment;

typedef struct {
  u32 first, count;               /* its segments, in order along it */
  float length;                   /* metres, as measured */
  u32 flags;                      /* LINE_* | kind << 8 */
} Line;

/* attr */
#define ATTR_KIND(a)      ((a) & 63u)
#define ATTR_BRUNNEL_SHIFT 6      /* 0 none, 1 bridge, 2 tunnel, 3 ford */
#define ATTR_LAYER_SHIFT   8      /* layer + 8, 0..15 */
#define ATTR_SURFACE_SHIFT 12     /* 0 unknown, 1 paved, 2 unpaved */
#define ATTR_ONEWAY_SHIFT  14     /* 0 both ways, 1 along a to b, 2 against */
#define ATTR_RAMP          (1u << 16)
#define ATTR_SERVICE_SHIFT 17     /* 3 bits, the schema's codes */
#define ATTR_SAC_SHIFT     20     /* 3 bits */
#define ATTR_FLAGS_SHIFT   23     /* 4 bits a subclass sets (a gallery, a covered bridge) */
#define ATTR_TOWN          (1u << 27)

/* link */
#define LINK_LINE(l)      ((l) & 0xFFFFu)
#define LINK_DEG_A_SHIFT  16      /* pieces meeting at a, 3 bits, 7 or more as 7 */
#define LINK_DEG_B_SHIFT  19
#define LINK_CUT_A        (1u << 22)   /* a is where the line crosses the tile's edge */
#define LINK_CUT_B        (1u << 23)
#define LINK_END_A        (1u << 24)   /* a is an end of its line */
#define LINK_END_B        (1u << 25)

#define LINE_LOOP     1u
#define LINE_CUT_START 2u
#define LINE_CUT_END   4u

/* What the call reports. */
typedef struct {
  u32 status;                     /*  0  MVT_* */
  u32 blockOff, blockSize;        /*  4 */
  u32 features, skipped;          /* 12  line features kept, features of no kind or not lines */
  u32 parts, segments, lines;     /* 20 */
  u32 refs, cuts, dropped;        /* 32 */
  u32 buildings;                  /* 44  features of the density layer */
  u32 reserved[4];                /* 48 */
} MvtResult;                      /* 64 bytes */

#define MVT_OK 0u
#define MVT_BAD 1u
#define MVT_MEMORY 2u
#define MVT_NO_LAYER 3u

/* ---- the schema (written by js/formats/vector-tile.js) -------------------- */

#define SCHEMA_MAGIC 0x5354564Du  /* 'MVTS' */
enum { ROLE_CLASS, ROLE_SUBCLASS, ROLE_BRUNNEL, ROLE_LAYER, ROLE_SURFACE, ROLE_SERVICE, ROLE_ONEWAY, ROLE_RAMP, ROLE_SAC, ROLES };
#define MAX_FIELDS 16u

typedef struct {
  u32 magic;
  u32 layerNameOff, densityNameOff;
  u32 fieldCount, fieldsOff;
  u32 classCount, subclassCount, kindTableOff;
  u32 kindCount, kindsOff;
  u32 subclassFlagsOff;
  u32 townTenths;                 /* buildings per hectare round a segment that make it "in town", ×10 */
  u32 reserved[4];
} Schema;

typedef struct { u32 nameOff, role, valueCount, valuesOff; } SchemaField;
typedef struct { float halfWidth; u8 priority, family, flags, pad; } SchemaKind;

/* A length-prefixed string in the schema. */
typedef struct { const u8 *s; u32 n; } Str;

static Str schema_str(const u8 *base, u32 off) {
  Str r;
  r.n = off ? rd_u32(base + off) : 0;
  r.s = base + off + 4;
  return r;
}

INLINE int str_eq(Str a, Str b) {
  if (a.n != b.n) return 0;
  for (u32 i = 0; i < a.n; i++) if (a.s[i] != b.s[i]) return 0;
  return 1;
}

/* ---- protobuf -------------------------------------------------------------- */

typedef struct { const u8 *p, *end; int bad; } Pb;

static u64 pb_varint(Pb *b) {
  u64 v = 0;
  u32 shift = 0;
  while (b->p < b->end) {
    u8 c = *b->p++;
    v |= (u64)(c & 0x7f) << shift;
    if (c < 0x80) return v;
    shift += 7;
    if (shift > 63) break;
  }
  b->bad = 1;
  return 0;
}

/* Reads a field's key; 0 at the end. */
INLINE u32 pb_key(Pb *b) { return b->p < b->end && !b->bad ? (u32)pb_varint(b) : 0; }

static Pb pb_sub(Pb *b) {
  Pb s;
  u64 n = pb_varint(b);
  s.p = b->p;
  s.bad = b->bad;
  if (n > (u64)(b->end - b->p)) { b->bad = 1; s.end = s.p; s.bad = 1; return s; }
  s.end = b->p + n;
  b->p += n;
  return s;
}

static void pb_skip(Pb *b, u32 wire) {
  switch (wire) {
    case 0: pb_varint(b); break;
    case 1: b->p += 8; break;
    case 2: { u64 n = pb_varint(b); if (n > (u64)(b->end - b->p)) b->bad = 1; else b->p += n; } break;
    case 5: b->p += 4; break;
    default: b->bad = 1; break;
  }
  if (b->p > b->end) b->bad = 1;
}

INLINE i32 zigzag(u32 n) { return (i32)(n >> 1) ^ -(i32)(n & 1); }

/* ---- small helpers ---------------------------------------------------------- */

static void *take(u32 bytes, int *oom) {
  u32 off = arena_alloc(bytes ? bytes : 16);
  if (!off) { *oom = 1; return 0; }
  return PTR(off);
}

INLINE float f_min(float a, float b) { return a < b ? a : b; }
INLINE float f_max(float a, float b) { return a > b ? a : b; }
INLINE i32 i_min(i32 a, i32 b) { return a < b ? a : b; }
INLINE i32 i_max(i32 a, i32 b) { return a > b ? a : b; }

/* Copies whole words: the arrays copied here are word-aligned, and the
 * byte loop in core.c would take four times as long over a few hundred KB. */
static void copy_words(void *dst, const void *src, u32 bytes) {
  u32 *d = (u32 *)dst;
  const u32 *s = (const u32 *)src;
  for (u32 i = 0, n = bytes >> 2; i < n; i++) d[i] = s[i];
}

/* Distance from a point to a segment, squared. */
static float seg_dist2(float px, float py, float ax, float ay, float bx, float by) {
  float dx = bx - ax, dy = by - ay;
  float l2 = dx * dx + dy * dy;
  float t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  float qx = ax + dx * t - px, qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

/* ---- one layer ---------------------------------------------------------------- */

typedef struct {
  Pb body;                        /* the layer message */
  u32 extent;
  u32 keyCount, valueCount, featureCount;
} LayerInfo;

typedef struct { const u8 *s; u32 n; u8 type; i64 i; } Value;   /* type 1 string, 2 number */

/* Scans a layer message: its extent and the counts of keys, values and
 * features (so the arrays can be sized), without decoding features. */
static void layer_scan(Pb body, LayerInfo *L) {
  L->body = body;
  L->extent = 4096;
  L->keyCount = L->valueCount = L->featureCount = 0;
  Pb b = body;
  for (u32 key; (key = pb_key(&b));) {
    u32 field = key >> 3, wire = key & 7;
    if (field == 5 && wire == 0) L->extent = (u32)pb_varint(&b);
    else if (field == 3 && wire == 2) { L->keyCount++; pb_skip(&b, wire); }
    else if (field == 4 && wire == 2) { L->valueCount++; pb_skip(&b, wire); }
    else if (field == 2 && wire == 2) { L->featureCount++; pb_skip(&b, wire); }
    else pb_skip(&b, wire);
  }
  if (!L->extent) L->extent = 4096;
}

/* The tables of a layer: keys as strings, values as strings or numbers. */
static void layer_tables(const LayerInfo *L, Str *keys, Value *values) {
  Pb b = L->body;
  u32 k = 0, v = 0;
  for (u32 key; (key = pb_key(&b));) {
    u32 field = key >> 3, wire = key & 7;
    if (field == 3 && wire == 2) {
      Pb s = pb_sub(&b);
      keys[k].s = s.p; keys[k].n = (u32)(s.end - s.p); k++;
    } else if (field == 4 && wire == 2) {
      Pb s = pb_sub(&b);
      Value *val = &values[v++];
      val->type = 0; val->n = 0; val->s = 0; val->i = 0;
      for (u32 vk; (vk = pb_key(&s));) {
        u32 vf = vk >> 3, vw = vk & 7;
        if (vf == 1 && vw == 2) { Pb t = pb_sub(&s); val->type = 1; val->s = t.p; val->n = (u32)(t.end - t.p); }
        else if ((vf == 4 || vf == 5) && vw == 0) { val->type = 2; val->i = (i64)pb_varint(&s); }
        else if (vf == 6 && vw == 0) { u64 z = pb_varint(&s); val->type = 2; val->i = (i64)((z >> 1) ^ (~(z & 1) + 1)); }
        else if (vf == 7 && vw == 0) { val->type = 2; val->i = (i64)pb_varint(&s); }
        else if (vf == 2 && vw == 5) { float f = rd_f32(s.p); s.p += 4; val->type = 2; val->i = (i64)f; }
        else if (vf == 3 && vw == 1) { double d = rd_f64(s.p); s.p += 8; val->type = 2; val->i = (i64)d; }
        else pb_skip(&s, vw);
      }
    } else {
      pb_skip(&b, wire);
    }
  }
}

/* ---- the density layer: buildings per cell ------------------------------------- */

static u32 density_from(const LayerInfo *L, u8 *grid, u32 extent) {
  Pb b = L->body;
  u32 count = 0;
  for (u32 key; (key = pb_key(&b));) {
    u32 field = key >> 3, wire = key & 7;
    if (field != 2 || wire != 2) { pb_skip(&b, wire); continue; }
    Pb f = pb_sub(&b);
    for (u32 fk; (fk = pb_key(&f));) {
      if ((fk >> 3) != 4 || (fk & 7) != 2) { pb_skip(&f, fk & 7); continue; }
      Pb g = pb_sub(&f);
      u32 cmd = (u32)pb_varint(&g);
      if ((cmd & 7) != 1 || (cmd >> 3) < 1) break;
      i32 x = zigzag((u32)pb_varint(&g)), y = zigzag((u32)pb_varint(&g));
      /* The layer's own extent, scaled to the transportation layer's. */
      if (L->extent != extent && L->extent) { x = (i32)((i64)x * extent / L->extent); y = (i32)((i64)y * extent / L->extent); }
      if (x >= 0 && y >= 0 && (u32)x < extent && (u32)y < extent) {
        u32 cx = (u32)x * DENSITY / extent, cy = (u32)y * DENSITY / extent;
        u8 *c = &grid[cy * DENSITY + cx];
        if (*c < 255) (*c)++;
        count++;
      }
      break;
    }
  }
  return count;
}

/* ---- nodes: where pieces meet --------------------------------------------------- */

typedef struct { i32 x, y; u32 first; u32 count; } Node;   /* first: the first piece end there */

static u32 node_find(Node *nodes, u32 *table, u32 mask, u32 *used, i32 x, i32 y) {
  u32 h = (((u32)x * 73856093u) ^ ((u32)y * 19349663u)) & mask;
  for (;;) {
    u32 n = table[h];
    if (n == 0xFFFFFFFFu) {
      n = (*used)++;
      nodes[n].x = x; nodes[n].y = y; nodes[n].first = 0xFFFFFFFFu; nodes[n].count = 0;
      table[h] = n;
      return n;
    }
    if (nodes[n].x == x && nodes[n].y == y) return n;
    h = (h + 1) & mask;
  }
}

/* The free end at the same node that end e would join: of its kind, another
 * piece's, and the most nearly opposite (at least STRAIGHT_ON where `strict`). */
static u32 best_end(u32 e, u32 first, const u32 *nextEnd, const i32 *link, const u32 *partAttr,
                    const float *outX, const float *outY, int strict) {
  u32 kind = ATTR_KIND(partAttr[e >> 1]), best = 0xFFFFFFFFu;
  float most = strict ? STRAIGHT_ON : 2.0f;
  for (u32 f = first; f != 0xFFFFFFFFu; f = nextEnd[f]) {
    if (f == e || link[f] >= 0 || (f >> 1) == (e >> 1) || ATTR_KIND(partAttr[f >> 1]) != kind) continue;
    float d = outX[e] * outX[f] + outY[e] * outY[f];
    if (d <= most) { most = d; best = f; }
  }
  return best;
}

/* ---- the call --------------------------------------------------------------------- */

/**
 * Decodes one tile.
 * @param srcOff, srcLen  the tile's bytes (already unzipped)
 * @param schemaOff       the code tables (see Schema)
 * @param z, x, y         which tile, for positions on the map (the dash anchors)
 * @param tileSize        metres across the tile at its middle (its units are
 *                        that over the layer's extent)
 * @param margin          metres added to every kind's half-width in the grid
 * @param resOff          where to write the MvtResult
 */
/* Optimised for size, not speed: this runs once a tile (a few ms), and the
 * wasm every thread downloads and compiles at its start is 9 KB smaller for
 * it (54 KB instead of 63 KB) at about 15% slower decoding. */
__attribute__((minsize)) EXPORT u32 mvt_decode(u32 srcOff, u32 srcLen, u32 schemaOff, u32 z, u32 x, u32 y,
                      double tileSize, double margin, u32 resOff) {
  MvtResult *res = (MvtResult *)PTR(resOff);
  memset(res, 0, sizeof(MvtResult));
  const u8 *sb = (const u8 *)PTR(schemaOff);
  const Schema *sc = (const Schema *)sb;
  if (sc->magic != SCHEMA_MAGIC || sc->fieldCount > MAX_FIELDS) return (res->status = MVT_BAD);
  int oom = 0;

  /* 1. Find the layers. */
  Str wantName = schema_str(sb, sc->layerNameOff), densityName = schema_str(sb, sc->densityNameOff);
  Pb tile = { (const u8 *)PTR(srcOff), (const u8 *)PTR(srcOff) + srcLen, 0 };
  LayerInfo lines, dens;
  int haveLines = 0, haveDensity = 0;
  for (u32 key; (key = pb_key(&tile));) {
    if ((key >> 3) != 3 || (key & 7) != 2) { pb_skip(&tile, key & 7); continue; }
    Pb layer = pb_sub(&tile);
    /* The name is field 1, normally first; look for it without decoding the rest. */
    Pb n = layer;
    Str name = { 0, 0 };
    for (u32 k; (k = pb_key(&n));) {
      if ((k >> 3) == 1 && (k & 7) == 2) { Pb s = pb_sub(&n); name.s = s.p; name.n = (u32)(s.end - s.p); break; }
      pb_skip(&n, k & 7);
    }
    if (!haveLines && str_eq(name, wantName)) { layer_scan(layer, &lines); haveLines = 1; }
    else if (!haveDensity && densityName.n && str_eq(name, densityName)) { layer_scan(layer, &dens); haveDensity = 1; }
  }
  if (tile.bad) return (res->status = MVT_BAD);

  const u32 E = haveLines ? lines.extent : 4096;
  const double mpu = tileSize / (double)E;
  u8 *density = (u8 *)take(DENSITY * DENSITY, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  memset(density, 0, DENSITY * DENSITY);
  if (haveDensity) res->buildings = density_from(&dens, density, E);

  u32 featureCount = haveLines ? lines.featureCount : 0;

  /* 2. Tags to codes. */
  Str *keys = 0; Value *values = 0;
  i32 keyField[256];
  u8 *valueCode = 0;                         /* [field][value] */
  u32 nk = 0, nv = 0;
  if (haveLines) {
    nk = lines.keyCount; nv = lines.valueCount;
    keys = (Str *)take(nk * sizeof(Str), &oom);
    values = (Value *)take(nv * sizeof(Value), &oom);
    valueCode = (u8 *)take(sc->fieldCount * nv + 1, &oom);
    if (oom) return (res->status = MVT_MEMORY);
    layer_tables(&lines, keys, values);
    for (u32 k = 0; k < 256; k++) keyField[k] = -1;
    const SchemaField *fields = (const SchemaField *)(sb + sc->fieldsOff);
    for (u32 k = 0; k < nk && k < 256; k++) {
      for (u32 f = 0; f < sc->fieldCount; f++) if (str_eq(keys[k], schema_str(sb, fields[f].nameOff))) { keyField[k] = (i32)f; break; }
    }
    /* Every string value, once per field it could belong to. */
    for (u32 f = 0; f < sc->fieldCount; f++) {
      const SchemaField *fd = &fields[f];
      const u8 *vals = sb + fd->valuesOff;
      for (u32 v = 0; v < nv; v++) {
        u8 code = 0;
        if (values[v].type == 1) {
          Str s = { values[v].s, values[v].n };
          for (u32 i = 0; i < fd->valueCount; i++) {
            if (str_eq(s, schema_str(sb, rd_u32(vals + i * 8)))) { code = (u8)rd_u32(vals + i * 8 + 4); break; }
          }
        }
        valueCode[f * nv + v] = code;
      }
    }
  }
  const SchemaField *fields = (const SchemaField *)(sb + sc->fieldsOff);
  const u8 *kindTable = sb + sc->kindTableOff;
  const SchemaKind *kinds = (const SchemaKind *)(sb + sc->kindsOff);
  const u8 *subFlags = sb + sc->subclassFlagsOff;

  /* Decode the features: pieces of line with their attributes. A vertex
   * takes at least two bytes of geometry, so the layer's size bounds them. */
  u32 layerBytes = haveLines ? (u32)(lines.body.end - lines.body.p) : 0;
  u32 vcap = layerBytes / 2 + 16, pcap = layerBytes / 4 + 16;
  i32 *vx = (i32 *)take(vcap * 4, &oom), *vy = (i32 *)take(vcap * 4, &oom);
  u32 *partFirst = (u32 *)take(pcap * 4, &oom), *partCount = (u32 *)take(pcap * 4, &oom), *partAttr = (u32 *)take(pcap * 4, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  u32 nverts = 0, nparts = 0;

  if (haveLines) {
    Pb b = lines.body;
    for (u32 key; (key = pb_key(&b));) {
      if ((key >> 3) != 2 || (key & 7) != 2) { pb_skip(&b, key & 7); continue; }
      Pb f = pb_sub(&b);
      Pb tags = { 0, 0, 0 }, geom = { 0, 0, 0 };
      u32 type = 0;
      for (u32 fk; (fk = pb_key(&f));) {
        u32 ff = fk >> 3, fw = fk & 7;
        if (ff == 2 && fw == 2) tags = pb_sub(&f);
        else if (ff == 3 && fw == 0) type = (u32)pb_varint(&f);
        else if (ff == 4 && fw == 2) geom = pb_sub(&f);
        else pb_skip(&f, fw);
      }
      if (type != 2 || !geom.p) { res->skipped++; continue; }
      /* Tags. */
      u32 code[ROLES] = { 0 };
      i32 num[ROLES] = { 0 };
      while (tags.p < tags.end && !tags.bad) {
        u32 k = (u32)pb_varint(&tags), v = (u32)pb_varint(&tags);
        if (k >= nk || k >= 256 || v >= nv || keyField[k] < 0) continue;
        u32 fi = (u32)keyField[k], role = fields[fi].role;
        if (role >= ROLES) continue;
        if (values[v].type == 2) num[role] = (i32)values[v].i;
        else code[role] = valueCode[fi * nv + v];
      }
      u32 cls = code[ROLE_CLASS], sub = code[ROLE_SUBCLASS];
      if (cls >= sc->classCount) cls = 0;
      if (sub >= sc->subclassCount) sub = 0;
      u32 kind = kindTable[cls * sc->subclassCount + sub];
      if (!kind || kind >= sc->kindCount) { res->skipped++; continue; }
      i32 layerValue = num[ROLE_LAYER];
      if (layerValue < -8) layerValue = -8;
      if (layerValue > 7) layerValue = 7;
      u32 oneway = num[ROLE_ONEWAY] == 1 ? 1u : num[ROLE_ONEWAY] == -1 ? 2u : 0u;
      u32 attr = kind
        | (code[ROLE_BRUNNEL] & 3u) << ATTR_BRUNNEL_SHIFT
        | (u32)(layerValue + 8) << ATTR_LAYER_SHIFT
        | (code[ROLE_SURFACE] & 3u) << ATTR_SURFACE_SHIFT
        | oneway << ATTR_ONEWAY_SHIFT
        | (num[ROLE_RAMP] ? ATTR_RAMP : 0u)
        | (code[ROLE_SERVICE] & 7u) << ATTR_SERVICE_SHIFT
        | (code[ROLE_SAC] & 7u) << ATTR_SAC_SHIFT
        | (subFlags[sub] & 15u) << ATTR_FLAGS_SHIFT;
      res->features++;
      /* Geometry: MoveTo starts a piece, LineTo goes on. */
      i32 cx = 0, cy = 0;
      u32 open = 0xFFFFFFFFu;
      while (geom.p < geom.end && !geom.bad) {
        u32 cmd = (u32)pb_varint(&geom), id = cmd & 7, n = cmd >> 3;
        if (id == 1 || id == 2) {
          for (u32 i = 0; i < n && geom.p < geom.end; i++) {
            cx += zigzag((u32)pb_varint(&geom));
            cy += zigzag((u32)pb_varint(&geom));
            if (id == 1) {
              if (nparts >= pcap) break;
              open = nparts++;
              partFirst[open] = nverts; partCount[open] = 0; partAttr[open] = attr;
            }
            if (open == 0xFFFFFFFFu || nverts >= vcap) continue;
            /* A point repeated adds nothing but a zero-length segment. */
            u32 c = partCount[open];
            if (c && vx[nverts - 1] == cx && vy[nverts - 1] == cy) continue;
            vx[nverts] = cx; vy[nverts] = cy; nverts++;
            partCount[open] = c + 1;
          }
        } else if (id != 7) {
          break;
        }
      }
    }
    if (b.bad) return (res->status = MVT_BAD);
  }
  /* Pieces of fewer than two points are no lines. */
  {
    u32 kept = 0;
    for (u32 p = 0; p < nparts; p++) {
      if (partCount[p] < 2) continue;
      partFirst[kept] = partFirst[p]; partCount[kept] = partCount[p]; partAttr[kept] = partAttr[p];
      kept++;
    }
    nparts = kept;
  }
  res->parts = nparts;

  /* 3. Nodes and joins. Ends are numbered 2p (a piece's first point) and
   * 2p + 1 (its last). */
  u32 nends = nparts * 2;
  u32 tcap = 16;
  while (tcap < nends * 2) tcap <<= 1;
  Node *nodes = (Node *)take((nends + 1) * sizeof(Node), &oom);
  u32 *table = (u32 *)take(tcap * 4, &oom);
  u32 *endNode = (u32 *)take(nends * 4 + 4, &oom), *nextEnd = (u32 *)take(nends * 4 + 4, &oom);
  i32 *link = (i32 *)take(nends * 4 + 4, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  for (u32 i = 0; i < tcap; i++) table[i] = 0xFFFFFFFFu;
  u32 nnodes = 0;
  for (u32 e = 0; e < nends; e++) {
    u32 p = e >> 1, v = (e & 1) ? partFirst[p] + partCount[p] - 1 : partFirst[p];
    u32 n = node_find(nodes, table, tcap - 1, &nnodes, vx[v], vy[v]);
    endNode[e] = n;
    nextEnd[e] = nodes[n].first;
    nodes[n].first = e;
    nodes[n].count++;
    link[e] = -1;
  }
  /* Each end's direction out of its node, along its piece. */
  float *outX = (float *)take(nends * 4 + 4, &oom), *outY = (float *)take(nends * 4 + 4, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  for (u32 e = 0; e < nends; e++) {
    u32 p = e >> 1, f = partFirst[p], c = partCount[p];
    u32 a = (e & 1) ? f + c - 1 : f, b = (e & 1) ? f + c - 2 : f + 1;
    float x = (float)(vx[b] - vx[a]), y = (float)(vy[b] - vy[a]);
    float l = __builtin_sqrtf(x * x + y * y);
    outX[e] = l > 0 ? x / l : 0; outY[e] = l > 0 ? y / l : 0;
  }
  /* At every node, the ends of each kind in pairs: an end and the one of its
   * kind most nearly opposite it, where each is the other's best and they run
   * on nearly straight. So a crossing of two streets of one kind joins both
   * ways across, and at a switch the track runs on while the branch is a line
   * of its own. Two ends alone at a node join whatever the angle. */
  for (u32 n = 0; n < nnodes; n++) {
    if (nodes[n].count < 2) continue;
    int strict = nodes[n].count > 2;
    for (u32 round = 0; round < 4; round++) {
      int joined = 0;
      for (u32 e = nodes[n].first; e != 0xFFFFFFFFu; e = nextEnd[e]) {
        if (link[e] >= 0) continue;
        u32 f = best_end(e, nodes[n].first, nextEnd, link, partAttr, outX, outY, strict);
        if (f == 0xFFFFFFFFu || best_end(f, nodes[n].first, nextEnd, link, partAttr, outX, outY, strict) != e) continue;
        link[e] = (i32)f;
        link[f] = (i32)e;
        joined = 1;
      }
      if (!joined) break;
    }
  }

  /* 4. Lines: walked from every free end, then the loops left over; each
   * piece in order and in the direction the walk meets it. */
  u32 *order = (u32 *)take(nparts * 4 + 4, &oom);         /* piece << 1 | reversed */
  u32 *lineStart = (u32 *)take((nparts + 1) * 4, &oom);
  u8 *visited = (u8 *)take(nparts + 1, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  memset(visited, 0, nparts + 1);
  u32 norder = 0, nlines = 0;
  for (int pass = 0; pass < 2; pass++) {
    for (u32 p = 0; p < nparts; p++) {
      if (visited[p]) continue;
      u32 e0 = 0xFFFFFFFFu;
      if (pass == 0) {
        if (link[2 * p] < 0) e0 = 2 * p;
        else if (link[2 * p + 1] < 0) e0 = 2 * p + 1;
        else continue;
      } else {
        e0 = 2 * p;
      }
      lineStart[nlines++] = norder;
      for (u32 e = e0;;) {
        u32 q = e >> 1;
        visited[q] = 1;
        order[norder++] = q << 1 | (e & 1);
        i32 f = link[e ^ 1];
        if (f < 0 || visited[(u32)f >> 1]) break;
        e = (u32)f;
      }
    }
  }
  lineStart[nlines] = norder;

  /* Segments: each line's pieces in turn, cut where the line crosses the
   * tile's edge. A crossing splits a segment there, so no segment lies on
   * both sides and the length along it stays linear between cuts. */
  u32 scap = nverts + 2 * nparts + 64;
  if (scap > MAX_SEGMENTS + 64) scap = MAX_SEGMENTS + 64;
  Segment *segs = (Segment *)take(scap * sizeof(Segment), &oom);
  Line *ln = (Line *)take((nlines + 1) * sizeof(Line), &oom);
  float *arc0 = (float *)take(scap * 4, &oom), *arc1 = (float *)take(scap * 4, &oom);
  /* Cut points along the current line: length there, and the anchor value. */
  u32 cutCap = 1024;
  double *cutAt = (double *)take(cutCap * 8, &oom), *cutAnchor = (double *)take(cutCap * 8, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  const float Ef = (float)E;
  const double gx0 = (double)x * E, gy0 = (double)y * E;
  const double anchorScale = ANCHOR_SCALE / (double)(1u << z) / (double)E;
  u32 nsegs = 0;
  for (u32 l = 0; l < nlines; l++) {
    u32 first = nsegs, ncuts = 0;
    double along = 0;
    u32 lineKind = 0;
    for (u32 k = lineStart[l]; k < lineStart[l + 1]; k++) {
      u32 p = order[k] >> 1, rev = order[k] & 1;
      u32 attr = partAttr[p];
      lineKind = ATTR_KIND(attr);
      if (rev) {
        /* Walked backwards: one-way means the other way along the segments. */
        u32 ow = (attr >> ATTR_ONEWAY_SHIFT) & 3u;
        if (ow) attr = (attr & ~(3u << ATTR_ONEWAY_SHIFT)) | ((3u - ow) << ATTR_ONEWAY_SHIFT);
      }
      u32 c = partCount[p], f = partFirst[p];
      for (u32 i = 0; i + 1 < c; i++) {
        u32 ia = rev ? f + c - 1 - i : f + i, ib = rev ? ia - 1 : ia + 1;
        float ax = (float)vx[ia], ay = (float)vy[ia], bx = (float)vx[ib], by = (float)vy[ib];
        /* Liang–Barsky against the tile's own square. */
        float t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay;
        float pp[4] = { -dx, dx, -dy, dy }, qq[4] = { ax, Ef - ax, ay, Ef - ay };
        int hits = 1;
        for (int s = 0; s < 4 && hits; s++) {
          if (pp[s] == 0) { if (qq[s] < 0) hits = 0; continue; }
          float r = qq[s] / pp[s];
          if (pp[s] < 0) { if (r > t1) hits = 0; else if (r > t0) t0 = r; }
          else { if (r < t0) hits = 0; else if (r < t1) t1 = r; }
        }
        float cuts[3]; u32 ncut = 0;
        if (hits) {
          if (t0 > 1e-6f && t0 < 1 - 1e-6f) cuts[ncut++] = t0;
          if (t1 > 1e-6f && t1 < 1 - 1e-6f && t1 > t0 + 1e-6f) cuts[ncut++] = t1;
        }
        cuts[ncut] = 1;
        float ta = 0;
        for (u32 j = 0; j <= ncut; j++) {
          float tb = cuts[j];
          if (nsegs >= MAX_SEGMENTS) { res->dropped++; break; }
          Segment *sg = &segs[nsegs];
          sg->ax = ax + dx * ta; sg->ay = ay + dy * ta;
          sg->bx = ax + dx * tb; sg->by = ay + dy * tb;
          sg->attr = attr;
          sg->link = (l & 0xFFFFu);
          float len = __builtin_sqrtf((sg->bx - sg->ax) * (sg->bx - sg->ax) + (sg->by - sg->ay) * (sg->by - sg->ay)) * (float)mpu;
          arc0[nsegs] = (float)along;
          along += len;
          arc1[nsegs] = (float)along;
          if (j < ncut) {
            /* The crossing: the anchor depends only on where it is on the map,
             * in the grid's units at one scale for every tile of this zoom
             * (ANCHOR_SCALE), never at this tile's own metres per unit: the
             * next tile's differs a little, and over the whole map a little
             * is kilometres. Close to metres, so the few tenths of a unit by
             * which the two tiles' crossing points differ (each clips the
             * line at its own margin) stay a few centimetres of pattern. */
            sg->link |= LINK_CUT_B;
            if (ncuts < cutCap) {
              double g = ((gx0 + sg->bx) + (gy0 + sg->by)) * anchorScale;
              g -= __builtin_floor(g / PERIOD) * PERIOD;
              cutAt[ncuts] = along; cutAnchor[ncuts] = g; ncuts++;
            }
            res->cuts++;
          }
          if (j > 0) sg->link |= LINK_CUT_A;
          nsegs++;
          ta = tb;
        }
      }
    }
    /* Lengths along the line: from the start where nothing crosses; from
     * the crossings outwards, and stretched between two of them, where it
     * does (see 4. at the top). */
    /* Which stretch a segment lies in is decided by its middle, and both its
     * ends follow that stretch's rule: at a crossing the two sides' values
     * may differ by whole periods, which no pattern can tell apart, but
     * inside one segment they must run evenly. */
    for (u32 s = first; s < nsegs; s++) {
      double mid = 0.5 * ((double)arc0[s] + arc1[s]);
      double base = 0, from = 0, k = 1;
      if (ncuts) {
        if (mid <= cutAt[0]) { base = cutAnchor[0]; from = cutAt[0]; }
        else if (mid >= cutAt[ncuts - 1]) { base = cutAnchor[ncuts - 1]; from = cutAt[ncuts - 1]; }
        else {
          u32 i = 0;
          while (i + 1 < ncuts && cutAt[i + 1] < mid) i++;
          double span = cutAt[i + 1] - cutAt[i];
          double delta = cutAnchor[i + 1] - cutAnchor[i] - span;
          delta -= __builtin_floor(delta / PERIOD + 0.5) * PERIOD;
          /* Too short a stretch to bend the pattern into step: left as it is. */
          k = span > 5 * PERIOD ? 1 + delta / span : 1;
          base = cutAnchor[i]; from = cutAt[i];
        }
      }
      segs[s].s0 = (float)(base + ((double)arc0[s] - from) * k);
      segs[s].s1 = (float)(base + ((double)arc1[s] - from) * k);
    }
    Line *L = &ln[l];
    L->first = first; L->count = nsegs - first; L->length = (float)along;
    u32 fl = lineKind << 8;
    if (nsegs > first) {
      if (segs[first].link & LINK_CUT_A) fl |= LINE_CUT_START;
      if (segs[nsegs - 1].link & LINK_CUT_B) fl |= LINE_CUT_END;
      /* A line whose last piece joins its first is a loop. */
      u32 lastPiece = order[lineStart[l + 1] - 1];
      i32 tail = link[((lastPiece >> 1) << 1) | ((lastPiece & 1) ^ 1)];
      if (tail >= 0 && ((u32)tail >> 1) == (order[lineStart[l]] >> 1)) fl |= LINE_LOOP;
    }
    L->flags = fl;
  }
  res->segments = nsegs;
  res->lines = nlines;

  /* Line ends: how many pieces meet there, for junction rules later. */
  for (u32 l = 0; l < nlines; l++) {
    Line *L = &ln[l];
    if (!L->count) continue;
    u32 k0 = lineStart[l], k1 = lineStart[l + 1] - 1;
    u32 e0 = (order[k0] >> 1) * 2 + (order[k0] & 1);
    u32 e1 = (order[k1] >> 1) * 2 + ((order[k1] & 1) ^ 1);
    u32 d0 = nodes[endNode[e0]].count, d1 = nodes[endNode[e1]].count;
    Segment *a = &segs[L->first], *b = &segs[L->first + L->count - 1];
    if (!(a->link & LINK_CUT_A)) a->link |= LINK_END_A | (d0 > 7 ? 7u : d0) << LINK_DEG_A_SHIFT;
    if (!(b->link & LINK_CUT_B)) b->link |= LINK_END_B | (d1 > 7 ? 7u : d1) << LINK_DEG_B_SHIFT;
  }

  /* In town: buildings per hectare round the segment's middle, over the
   * 3 x 3 density cells there (those inside the tile), at least the schema's
   * (whatever the zoom: its cells are 52 m at 14, 104 m at 13). */
  const double cellMetres = mpu * (double)E / DENSITY;
  const float perCell = (float)(sc->townTenths * 0.1 * cellMetres * cellMetres / 10000.0);
  for (u32 s = 0; sc->townTenths && s < nsegs; s++) {
    float mx = (segs[s].ax + segs[s].bx) * 0.5f, my = (segs[s].ay + segs[s].by) * 0.5f;
    i32 cx = (i32)(mx * DENSITY / Ef), cy = (i32)(my * DENSITY / Ef);
    u32 sum = 0, cells = 0;
    for (i32 j = cy - 1; j <= cy + 1; j++) for (i32 i = cx - 1; i <= cx + 1; i++) {
      if (i < 0 || j < 0 || i >= (i32)DENSITY || j >= (i32)DENSITY) continue;
      sum += density[j * DENSITY + (u32)i];
      cells++;
    }
    if (cells && (float)sum >= perCell * (float)cells) segs[s].attr |= ATTR_TOWN;
  }

  /* Nothing to draw: no block at all. The caller knows the tile holds no
   * lines and points it at one empty block every such tile shares. */
  if (!nsegs) return (res->status = MVT_OK);

  /* 5. The grid: count, place, order. */
  u32 *cellCount = (u32 *)take(GRID * GRID * 4, &oom), *cellStart = (u32 *)take((GRID * GRID + 1) * 4, &oom);
  if (oom) return (res->status = MVT_MEMORY);
  memset(cellCount, 0, GRID * GRID * 4);
  const float cell = Ef / GRID, half = cell * 0.70711f;
  for (int pass = 0; pass < 2; pass++) {
    u16 *refs = pass ? (u16 *)PTR(cellStart[GRID * GRID]) : 0;
    for (u32 s = 0; s < nsegs; s++) {
      const Segment *sg = &segs[s];
      float w = (kinds[ATTR_KIND(sg->attr)].halfWidth + (float)margin) / (float)mpu;
      float r = w + half, r2 = r * r;
      i32 i0 = i_max(0, (i32)((f_min(sg->ax, sg->bx) - w) / cell)), i1 = i_min((i32)GRID - 1, (i32)((f_max(sg->ax, sg->bx) + w) / cell));
      i32 j0 = i_max(0, (i32)((f_min(sg->ay, sg->by) - w) / cell)), j1 = i_min((i32)GRID - 1, (i32)((f_max(sg->ay, sg->by) + w) / cell));
      for (i32 j = j0; j <= j1; j++) {
        for (i32 i = i0; i <= i1; i++) {
          float px = ((float)i + 0.5f) * cell, py = ((float)j + 0.5f) * cell;
          if (seg_dist2(px, py, sg->ax, sg->ay, sg->bx, sg->by) > r2) continue;
          u32 c = (u32)j * GRID + (u32)i;
          if (pass) refs[cellStart[c] + cellCount[c]++] = (u16)s;
          else cellCount[c]++;
        }
      }
    }
    if (!pass) {
      u32 total = 0;
      for (u32 c = 0; c < GRID * GRID; c++) { cellStart[c] = total; total += cellCount[c]; cellCount[c] = 0; }
      res->refs = total;
      /* The references go straight into the block, after the cells. */
      u32 refsBytes = (total * 2 + 15u) & ~15u;
      u32 segBytes = nsegs * (u32)sizeof(Segment), lineBytes = (nlines * (u32)sizeof(Line) + 15u) & ~15u;
      u32 blockSize = (u32)sizeof(BlockHeader) + GRID * GRID * 4 + refsBytes + segBytes + lineBytes + DENSITY * DENSITY;
      u8 *block = (u8 *)take(blockSize, &oom);
      if (oom) return (res->status = MVT_MEMORY);
      res->blockOff = OFF(block);
      res->blockSize = blockSize;
      BlockHeader *h = (BlockHeader *)block;
      memset(h, 0, sizeof(BlockHeader));
      h->magic = BLOCK_MAGIC; h->version = BLOCK_VERSION;
      h->segmentCount = nsegs; h->lineCount = nlines; h->grid = GRID;
      h->cellsOff = (u32)sizeof(BlockHeader);
      h->refsOff = h->cellsOff + GRID * GRID * 4;
      h->refCount = total;
      h->segmentsOff = h->refsOff + refsBytes;
      h->linesOff = h->segmentsOff + segBytes;
      h->densityOff = h->linesOff + lineBytes;
      h->density = DENSITY;
      h->metresPerUnit = (float)mpu;
      h->extent = E;
      h->zoom = z;
      cellStart[GRID * GRID] = OFF(block + h->refsOff);   /* where pass 1 writes */
    }
  }
  BlockHeader *h = (BlockHeader *)PTR(res->blockOff);
  u8 *block = (u8 *)h;
  u16 *refs = (u16 *)(block + h->refsOff);
  u32 *cells = (u32 *)(block + h->cellsOff);
  /* Lowest priority first in every cell; a cell holding more than a byte
   * can count keeps its highest 255. */
  for (u32 c = 0; c < GRID * GRID; c++) {
    u32 start = cellStart[c], n = cellCount[c];
    u16 *r = refs + start;
    for (u32 i = 1; i < n; i++) {
      u16 v = r[i];
      u32 pv = kinds[ATTR_KIND(segs[v].attr)].priority;
      u32 j = i;
      while (j > 0 && kinds[ATTR_KIND(segs[r[j - 1]].attr)].priority > pv) { r[j] = r[j - 1]; j--; }
      r[j] = v;
    }
    if (n > 255) { res->dropped += n - 255; start += n - 255; n = 255; }
    cells[c] = start << 8 | n;
  }
  h->dropped = res->dropped;
  copy_words(block + h->segmentsOff, segs, nsegs * (u32)sizeof(Segment));
  copy_words(block + h->linesOff, ln, nlines * (u32)sizeof(Line));
  copy_words(block + h->densityOff, density, DENSITY * DENSITY);
  (void)featureCount;
  return (res->status = MVT_OK);
}

EXPORT u32 mvt_result_size(void) { return (u32)sizeof(MvtResult); }
EXPORT u32 mvt_block_header_size(void) { return (u32)sizeof(BlockHeader); }
EXPORT u32 mvt_segment_size(void) { return (u32)sizeof(Segment); }
