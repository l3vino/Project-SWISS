/* view.js — what the camera can see this frame, worked out once and shared.
 *
 * Everything that streams by level of detail asks the same few questions:
 * is this bounding sphere inside the frustum, how far is this volume from the
 * eye, is it past the horizon, and how many pixels does a metre of error cover
 * from here. Answering them from one object keeps terrain, buildings and the
 * layers still to come consistent with each other, and extracts the frustum
 * once per frame rather than once per layer.
 *
 * `version` changes only when the answers do, so a layer can skip its whole
 * traversal while the camera stands still.
 *
 * The view can also carry a focus: a vertical cylinder around the walker
 * that layers load in full detail whether it is on screen or not, because
 * physics touches what is behind you as much as what is in front.
 */

import { radiiAt, geodeticToEcef, enuBasis, DEG, WGS84_A } from '../core/math.js';

/* Metres. Peaks this high can rise above the horizon from far beyond it. */
const HIGHEST_TERRAIN = 4800;

export class View {
  constructor() {
    this.camera = null;
    this.planes = new Float64Array(20);   // left, right, bottom, top, near: xyz normal, w offset
    this.viewProj = null;
    this.pixelsPerRadian = 1;             // viewport height over 2 tan(fovY / 2)
    this.mPerDegLat = 111000;             // metres per degree around the camera
    this.mPerDegLon = 77000;
    this.horizon = Infinity;              // metres beyond which nothing is drawn
    this.rawHorizon = Infinity;           // ... before the view distance setting caps it
    this.maxDistance = Infinity;          // the view distance setting, metres
    this.version = 0;
    this.focus = null;                    // { lon, lat, radius, center, up, mPerDegLat, mPerDegLon }
    this.last = { lon: NaN, lat: NaN, height: NaN, yaw: NaN, pitch: NaN, ppr: NaN, aspect: NaN, ground: NaN };
  }

  /**
   * Once per frame, after the camera has moved.
   * @param ground  lowest ground height known below the camera, for the horizon
   * @returns true if anything a layer depends on changed
   */
  update(camera, { viewHeight, fovY, aspect, near }, ground = 0) {
    const ppr = viewHeight / (2 * Math.tan(fovY / 2));
    const L = this.last;
    if (camera.lon === L.lon && camera.lat === L.lat && camera.height === L.height &&
        camera.yaw === L.yaw && camera.pitch === L.pitch && ppr === L.ppr &&
        aspect === L.aspect && ground === L.ground && this.camera === camera) {
      return false;
    }
    L.lon = camera.lon; L.lat = camera.lat; L.height = camera.height;
    L.yaw = camera.yaw; L.pitch = camera.pitch; L.ppr = ppr; L.aspect = aspect; L.ground = ground;

    this.camera = camera;
    this.pixelsPerRadian = ppr;
    const { meridian, primeVertical } = radiiAt(camera.lat);
    this.mPerDegLat = meridian * DEG;
    this.mPerDegLon = primeVertical * Math.cos(camera.lat * DEG) * DEG;
    this.viewProj = camera.matrices(aspect, fovY, near);
    this.#extractPlanes(this.viewProj);

    // The eye's own horizon over the ground below it, plus the distance from
    // which the highest peaks still rise above theirs.
    this.rawHorizon = Math.sqrt(2 * WGS84_A * Math.max(1, camera.height - ground)) +
      Math.sqrt(2 * WGS84_A * HIGHEST_TERRAIN);
    this.horizon = Math.min(this.rawHorizon, this.maxDistance);
    this.version++;
    return true;
  }

  /** The view distance setting: nothing farther is drawn or fetched. */
  setMaxDistance(metres) {
    const m = metres > 0 ? metres : Infinity;
    if (m === this.maxDistance) return;
    this.maxDistance = m;
    this.horizon = Math.min(this.rawHorizon, m);
    this.version++;
  }

  /**
   * Where physics needs everything loaded: a vertical cylinder `radius`
   * metres around a point, or nothing (lon null) while flying high. A new
   * focus counts as a new view.
   */
  setFocus(lon, lat, radius) {
    const F = this.focus;
    if (lon == null) {
      if (F) { this.focus = null; this.version++; }
      return;
    }
    if (F && F.lon === lon && F.lat === lat && F.radius === radius) return;
    // Reused while it follows the walker, which is every frame they move.
    const f = this.focusStore ??= { center: new Float64Array(3), east: new Float64Array(3),
      north: new Float64Array(3), up: new Float64Array(3), radii: { meridian: 0, primeVertical: 0 } };
    const { meridian, primeVertical } = radiiAt(lat, f.radii);
    f.lon = lon; f.lat = lat; f.radius = radius;
    geodeticToEcef(lon, lat, 0, f.center);
    enuBasis(lon, lat, f.east, f.north, f.up);
    f.mPerDegLat = meridian * DEG;
    f.mPerDegLon = primeVertical * Math.cos(lat * DEG) * DEG;
    this.focus = f;
    this.version++;
  }

  /**
   * Horizontal metres from the focus's axis to a tileset volume (see
   * features/tileset.js), zero when it reaches the axis, Infinity without a
   * focus. Height does not count: a building is in reach whatever the
   * altitude of the eye above it while arriving.
   */
  focusDistance(volume) {
    const F = this.focus;
    if (!F) return Infinity;
    if (volume.kind === 'region') {
      const r = volume.rect;
      const lon = F.lon < r.west ? r.west : F.lon > r.east ? r.east : F.lon;
      const lat = F.lat < r.south ? r.south : F.lat > r.north ? r.north : F.lat;
      return Math.hypot((lon - F.lon) * F.mPerDegLon, (lat - F.lat) * F.mPerDegLat);
    }
    if (!Number.isFinite(volume.radius)) return 0;
    const c = volume.center, u = F.up;
    const dx = c[0] - F.center[0], dy = c[1] - F.center[1], dz = c[2] - F.center[2];
    const along = dx * u[0] + dy * u[1] + dz * u[2];
    const h = Math.hypot(dx - along * u[0], dy - along * u[1], dz - along * u[2]);
    return Math.max(0, h - volume.radius);
  }

  /**
   * The five planes of the view (the far one is at infinity), from the
   * camera-relative view-projection matrix: the standard row combinations,
   * with the near plane where reverse-Z puts it.
   */
  #extractPlanes(m) {
    const P = this.planes;
    const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    const set = (k, a, s, b) => {
      const x = a[0] + s * b[0], y = a[1] + s * b[1], z = a[2] + s * b[2], w = a[3] + s * b[3];
      const l = Math.hypot(x, y, z) || 1;
      P[k] = x / l; P[k + 1] = y / l; P[k + 2] = z / l; P[k + 3] = w / l;
    };
    set(0, r3, 1, r0);     // left
    set(4, r3, -1, r0);    // right
    set(8, r3, 1, r1);     // bottom
    set(12, r3, -1, r1);   // top
    set(16, r3, -1, r2);   // near: depth 1 there, falling towards 0 at infinity
  }

  /** Whether a sphere, centre in absolute ECEF metres, touches the frustum. */
  sphereVisible(center, radius) {
    const p = this.camera.position, P = this.planes;
    const x = center[0] - p[0], y = center[1] - p[1], z = center[2] - p[2];
    for (let i = 0; i < 20; i += 4) {
      if (P[i] * x + P[i + 1] * y + P[i + 2] * z + P[i + 3] < -radius) return false;
    }
    return true;
  }

  /** Metres from the eye to the nearest point of a rectangle (degrees) and height range. */
  regionDistance(r, minHeight, maxHeight) {
    const c = this.camera;
    const lon = c.lon < r.west ? r.west : c.lon > r.east ? r.east : c.lon;
    const lat = c.lat < r.south ? r.south : c.lat > r.north ? r.north : c.lat;
    const dx = (lon - c.lon) * this.mPerDegLon;
    const dy = (lat - c.lat) * this.mPerDegLat;
    const h = c.height;
    const dz = h < minHeight ? minHeight - h : h > maxHeight ? h - maxHeight : 0;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Metres from the eye to an oriented box: a centre and three half-axis
   * vectors, all absolute ECEF, zero inside it.
   */
  boxDistance(center, axes) {
    const p = this.camera.position;
    const dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
    let sum = 0;
    for (let i = 0; i < 9; i += 3) {
      const ax = axes[i], ay = axes[i + 1], az = axes[i + 2];
      const len = Math.hypot(ax, ay, az);
      if (len === 0) continue;
      const along = (dx * ax + dy * ay + dz * az) / len;
      const outside = Math.abs(along) - len;
      if (outside > 0) sum += outside * outside;
    }
    return Math.sqrt(sum);
  }

  /** Metres from the eye to a sphere's surface, zero inside it. */
  sphereDistance(center, radius) {
    const p = this.camera.position;
    return Math.max(0, Math.hypot(center[0] - p[0], center[1] - p[1], center[2] - p[2]) - radius);
  }
}
