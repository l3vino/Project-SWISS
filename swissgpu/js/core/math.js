/* math.js — geodesy and matrices, in double precision on the CPU.
 *
 * Positions are WGS84 ECEF metres held in Float64Array. Switzerland sits about
 * 4.3 million metres from the earth's centre, where float32 spacing is ~0.5 m,
 * so anything that touches world position stays f64 here and is only narrowed
 * to f32 after it has been made relative to the camera.
 */

export const WGS84_A = 6378137.0;            // semi-major axis, metres
export const WGS84_F = 1 / 298.257223563;    // flattening
export const WGS84_B = WGS84_A * (1 - WGS84_F);
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const DEG = Math.PI / 180;

/* ---- vec3 (Float64Array of 3) ------------------------------------------- */
export const vec3 = {
  make: (x = 0, y = 0, z = 0) => Float64Array.of(x, y, z),
  set: (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; },
  copy: (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; },
  add: (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; },
  sub: (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; },
  scale: (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; },
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  cross: (o, a, b) => {
    const x = a[1] * b[2] - a[2] * b[1];
    const y = a[2] * b[0] - a[0] * b[2];
    const z = a[0] * b[1] - a[1] * b[0];
    o[0] = x; o[1] = y; o[2] = z; return o;
  },
  normalize: (o, a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o;
  },
};

/* ---- geodetic <-> ECEF --------------------------------------------------- */

/** Longitude/latitude in degrees, height in metres above the ellipsoid. */
export function geodeticToEcef(lonDeg, latDeg, height, out = new Float64Array(3)) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  out[0] = (n + height) * cosLat * Math.cos(lon);
  out[1] = (n + height) * cosLat * Math.sin(lon);
  out[2] = (n * (1 - WGS84_E2) + height) * sinLat;
  return out;
}

/** Bowring's method: accurate to well under a millimetre, no iteration. */
export function ecefToGeodetic(p, out = { lon: 0, lat: 0, height: 0 }) {
  const [x, y, z] = p;
  const r = Math.hypot(x, y);
  const ep2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  const theta = Math.atan2(z * WGS84_A, r * WGS84_B);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const lat = Math.atan2(z + ep2 * WGS84_B * st * st * st,
                         r - WGS84_E2 * WGS84_A * ct * ct * ct);
  const sinLat = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  out.lon = Math.atan2(y, x) / DEG;
  out.lat = lat / DEG;
  out.height = r / Math.cos(lat) - n;
  return out;
}

/**
 * The ellipsoid's two principal radii of curvature at a latitude: how many
 * metres one radian of latitude (meridian) and one radian of longitude at the
 * equator of that parallel (prime vertical) are worth. Converting metres of
 * movement into degrees needs both, because the earth is not a sphere.
 */
export function radiiAt(latDeg, out = { meridian: 0, primeVertical: 0 }) {
  const s = Math.sin(latDeg * DEG);
  const w = 1 - WGS84_E2 * s * s;
  out.primeVertical = WGS84_A / Math.sqrt(w);
  out.meridian = WGS84_A * (1 - WGS84_E2) / (w * Math.sqrt(w));
  return out;
}

/** Local east/north/up basis at a geodetic point. Rows of the ENU rotation. */
export function enuBasis(lonDeg, latDeg, east = new Float64Array(3),
                         north = new Float64Array(3), up = new Float64Array(3)) {
  const lon = lonDeg * DEG, lat = latDeg * DEG;
  const sl = Math.sin(lon), cl = Math.cos(lon);
  const sb = Math.sin(lat), cb = Math.cos(lat);
  vec3.set(east, -sl, cl, 0);
  vec3.set(north, -sb * cl, -sb * sl, cb);
  vec3.set(up, cb * cl, cb * sl, sb);
  return { east, north, up };
}

/* ---- Web Mercator -------------------------------------------------------- */
/* Imagery arrives in EPSG:3857 while terrain tiles are geodetic, so terrain
 * vertices carry their Mercator coordinate rather than anything being warped. */

export const MERCATOR_MAX_LAT = 85.051128779806604;

export function lonToMercatorX(lonDeg) { return (lonDeg + 180) / 360; }

export function latToMercatorY(latDeg) {
  const lat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, latDeg)) * DEG;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / (2 * Math.PI);
}

/* ---- mat4 (Float32Array of 16, column-major, GPU-ready) ------------------ */

export const mat4 = {
  make: () => new Float32Array(16),

  identity(o) {
    o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o;
  },

  multiply(o, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  },

  /**
   * Reverse-Z with an infinite far plane: near maps to 1, infinity to 0.
   *
   * Float32 depth has most of its precision near 0, and reversing the range
   * puts that precision where the distant geometry is. On a planet-scale scene
   * this is the difference between clean mountains at 60 km and solid z-fighting.
   * Pair it with a `greater` depth compare and a clear value of 0.
   */
  perspectiveReverseZ(o, fovYRadians, aspect, near) {
    const f = 1 / Math.tan(fovYRadians / 2);
    o.fill(0);
    o[0] = f / aspect;
    o[5] = f;
    o[11] = -1;
    o[14] = near;
    return o;
  },

  /** Right-handed view matrix looking from `eye` towards `target`. */
  lookAt(o, eye, target, up) {
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    const z0 = zx / l, z1 = zy / l, z2 = zz / l;
    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    l = Math.hypot(x0, x1, x2) || 1;
    x0 /= l; x1 /= l; x2 /= l;
    const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    o[0] = x0; o[1] = y0; o[2] = z0; o[3] = 0;
    o[4] = x1; o[5] = y1; o[6] = z1; o[7] = 0;
    o[8] = x2; o[9] = y2; o[10] = z2; o[11] = 0;
    o[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    o[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    o[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    o[15] = 1;
    return o;
  },
};

/* ---- mat4d (Float64Array of 16, column-major) --------------------------- */
/* For placing models on the earth, where a translation is millions of metres
 * and float32 would lose the metres. These never go to the GPU as they are. */

export const mat4d = {
  identity() {
    const o = new Float64Array(16);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },

  multiply(a, b, o = new Float64Array(16)) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  },

  translation(x, y, z) {
    const o = mat4d.identity();
    o[12] = x; o[13] = y; o[14] = z;
    return o;
  },

  /** A glTF node's local matrix: its `matrix`, or translation × rotation × scale. */
  fromNode(node) {
    if (node.matrix) return Float64Array.from(node.matrix);
    const [tx, ty, tz] = node.translation || [0, 0, 0];
    const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
    const [sx, sy, sz] = node.scale || [1, 1, 1];
    const o = new Float64Array(16);
    o[0] = (1 - 2 * (y * y + z * z)) * sx;
    o[1] = (2 * (x * y + z * w)) * sx;
    o[2] = (2 * (x * z - y * w)) * sx;
    o[4] = (2 * (x * y - z * w)) * sy;
    o[5] = (1 - 2 * (x * x + z * z)) * sy;
    o[6] = (2 * (y * z + x * w)) * sy;
    o[8] = (2 * (x * z + y * w)) * sz;
    o[9] = (2 * (y * z - x * w)) * sz;
    o[10] = (1 - 2 * (x * x + y * y)) * sz;
    o[12] = tx; o[13] = ty; o[14] = tz; o[15] = 1;
    return o;
  },

  /** Applies a matrix to a point. */
  transformPoint(m, x, y, z, out = new Float64Array(3)) {
    out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    return out;
  },

  /** Applies a matrix's rotation and scale to a direction. */
  transformVector(m, x, y, z, out = new Float64Array(3)) {
    out[0] = m[0] * x + m[4] * y + m[8] * z;
    out[1] = m[1] * x + m[5] * y + m[9] * z;
    out[2] = m[2] * x + m[6] * y + m[10] * z;
    return out;
  },
};

/* glTF is y-up; 3D Tiles and the earth-centred frame are z-up. A quarter turn
 * about x, which is what every 3D Tiles runtime applies: (x, y, z) becomes
 * (x, -z, y). */
export const Y_UP_TO_Z_UP = Float64Array.of(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
export const X_UP_TO_Z_UP = Float64Array.of(0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1);

export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate independent exponential smoothing. */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
