/* camera.js — where you are and where you are looking.
 *
 * Held as longitude, latitude, height and two angles rather than as a position
 * and a quaternion. On a planet that is the representation that stays honest:
 * "up" is a property of where you stand, altitude is a number you can persist
 * and reason about, and there is no drift to renormalise away.
 *
 * Rendering is camera-relative. The view matrix carries rotation only and the
 * camera sits at the origin, so geometry is drawn as offsets from the eye.
 * That is what keeps float32 vertex positions usable at planetary distances.
 */

import { mat4, vec3, geodeticToEcef, enuBasis, clamp, DEG,
         WGS84_A, WGS84_E2 } from '../core/math.js';

/* Movement keys arrive as a bitmask, which is one small number per change
 * instead of a set to serialise every frame. */
export const KEY = {
  FORWARD: 1, LEFT: 2, BACK: 4, RIGHT: 8,
  UP: 16, DOWN: 32, SPRINT: 64,
};

const MAX_PITCH = 89 * DEG;
/* Ctrl held with a movement key. In flight this is a plain multiplier; walking
 * will use its own realistic pair of speeds. */
const SPRINT_MULTIPLIER = 3;
const MIN_SPEED = 1;
const MAX_SPEED = 20000;

export class Camera {
  constructor({ lon = 0, lat = 0, height = 1000, yaw = 0, pitch = -0.25, speed = 120 } = {}) {
    this.lon = lon;
    this.lat = lat;
    this.height = height;
    this.yaw = yaw;      // radians, 0 looks north
    this.pitch = pitch;  // radians, negative looks down
    this.speed = speed;  // metres per second, scroll adjusts it
    this.sprinting = false;
    this.mode = 'fly';

    this.position = new Float64Array(3);
    this.east = new Float64Array(3);
    this.north = new Float64Array(3);
    this.up = new Float64Array(3);
    this.forward = new Float64Array(3);

    this.view = mat4.make();
    this.proj = mat4.make();
    this.viewProj = mat4.make();

    this.moved = true;
    this.#updateOrigin();
  }

  /**
   * Position and local frame. Only longitude, latitude and height change these,
   * so this runs when you move, not when you turn.
   */
  #updateOrigin() {
    geodeticToEcef(this.lon, this.lat, this.height, this.position);
    enuBasis(this.lon, this.lat, this.east, this.north, this.up);
    this.#updateForward();
  }

  /**
   * Where the eye points, from the two angles and the local frame. Turning the
   * mouse needs this and nothing else, which is why it is separate: a look
   * event costs four trig calls rather than a full geodetic conversion.
   */
  #updateForward() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    for (let i = 0; i < 3; i++) {
      this.forward[i] = this.east[i] * sy * cp + this.north[i] * cy * cp + this.up[i] * sp;
    }
    vec3.normalize(this.forward, this.forward);
  }

  look(dx, dy, sensitivity, invertY) {
    if (dx === 0 && dy === 0) return;
    this.yaw += dx * sensitivity;
    this.pitch += (invertY ? dy : -dy) * sensitivity;
    this.pitch = clamp(this.pitch, -MAX_PITCH, MAX_PITCH);
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    if (this.yaw < -Math.PI) this.yaw += 2 * Math.PI;
    this.moved = true;
    this.#updateForward();
  }

  /** Scroll changes speed geometrically, so it feels the same at 5 m/s and 5 km/s. */
  adjustSpeed(notches) {
    this.speed = clamp(this.speed * Math.exp(notches * 0.18), MIN_SPEED, MAX_SPEED);
  }

  /**
   * Flight: WASD moves in the local horizontal plane along the heading, and
   * altitude answers only to the up and down keys. Where the nose is pointing
   * does not drag you up or down, which is what makes level flight along a
   * valley possible without fighting the mouse.
   */
  update(dt, keys) {
    let f = 0, r = 0, u = 0;
    if (keys & KEY.FORWARD) f += 1;
    if (keys & KEY.BACK) f -= 1;
    if (keys & KEY.RIGHT) r += 1;
    if (keys & KEY.LEFT) r -= 1;
    if (keys & KEY.UP) u += 1;
    if (keys & KEY.DOWN) u -= 1;
    if (f === 0 && r === 0 && u === 0) { this.sprinting = false; return false; }

    // Diagonals should not be faster than the axes.
    const planar = Math.hypot(f, r);
    if (planar > 1) { f /= planar; r /= planar; }

    this.sprinting = (keys & KEY.SPRINT) !== 0;
    const step = this.speed * (this.sprinting ? SPRINT_MULTIPLIER : 1) * dt;
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    // Heading in the local frame: forward is (sin yaw, cos yaw), right is its
    // clockwise perpendicular.
    const dEast = (f * sy + r * cy) * step;
    const dNorth = (f * cy - r * sy) * step;

    const lat = this.lat * DEG;
    const sinLat = Math.sin(lat);
    const w = 1 - WGS84_E2 * sinLat * sinLat;
    const primeVertical = WGS84_A / Math.sqrt(w);          // east-west radius
    const meridian = WGS84_A * (1 - WGS84_E2) / (w * Math.sqrt(w)); // north-south radius

    this.lat = clamp(this.lat + (dNorth / meridian) / DEG, -85, 85);
    this.lon += (dEast / (primeVertical * Math.cos(lat))) / DEG;
    if (this.lon > 180) this.lon -= 360;
    if (this.lon < -180) this.lon += 360;
    this.height = clamp(this.height + u * step, -450, 400000);

    this.moved = true;
    this.#updateOrigin();
    return true;
  }

  /** Rotation-only view times a reverse-Z projection with no far plane. */
  matrices(aspect, fovY, near) {
    const target = vec3.make(this.forward[0], this.forward[1], this.forward[2]);
    mat4.lookAt(this.view, [0, 0, 0], target, this.up);
    mat4.perspectiveReverseZ(this.proj, fovY, aspect, near);
    mat4.multiply(this.viewProj, this.proj, this.view);
    return this.viewProj;
  }

  /**
   * A rough lon/lat box of what is in front of the camera, used to decide
   * which sources to query and which credits to show. Deliberately generous:
   * being slightly too wide costs nothing, being too narrow loses results.
   */
  viewRect(spanMetres = null) {
    const span = spanMetres ?? clamp(this.height * 6 + 15000, 20000, 600000);
    const dLat = (span / 111320);
    const dLon = dLat / Math.max(0.2, Math.cos(this.lat * DEG));
    return {
      west: this.lon - dLon, east: this.lon + dLon,
      south: clamp(this.lat - dLat, -90, 90), north: clamp(this.lat + dLat, -90, 90),
    };
  }

  /** Sun direction in ECEF, from a fixed azimuth and elevation for now. */
  sunDirection(azimuthDeg = 145, elevationDeg = 42, out = new Float64Array(3)) {
    const az = azimuthDeg * DEG, el = elevationDeg * DEG;
    const e = Math.sin(az) * Math.cos(el), n = Math.cos(az) * Math.cos(el), u = Math.sin(el);
    for (let i = 0; i < 3; i++) out[i] = this.east[i] * e + this.north[i] * n + this.up[i] * u;
    return vec3.normalize(out, out);
  }

  state() {
    const { lon, lat, height, yaw, pitch, speed, mode } = this;
    return { lon, lat, height, yaw, pitch, speed, mode };
  }

  apply(state) {
    if (!state) return;
    Object.assign(this, {
      lon: state.lon, lat: state.lat, height: state.height,
      yaw: state.yaw ?? this.yaw, pitch: state.pitch ?? this.pitch,
      speed: state.speed ?? this.speed,
    });
    this.moved = true;
    this.#updateOrigin();
  }
}
