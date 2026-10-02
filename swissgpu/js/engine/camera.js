/* camera.js — where you are and where you are looking.
 *
 * Held as longitude, latitude, height and two angles rather than as a position
 * and a quaternion. On a planet that is the representation that stays honest:
 * "up" is a property of where you stand, altitude is a number you can persist
 * and reason about, and there is no drift to renormalise away. A third angle,
 * roll, banks the view the way an aircraft banks into a turn; only flights
 * to a place set it (controllers/flyto.js), and it levels out on its own.
 *
 * The camera does not decide how it moves. Controllers do (flying, walking,
 * and later vehicles), all through the same few calls: translate in metres
 * along the local frame, set a height, look around.
 *
 * Rendering is camera-relative. The view matrix carries rotation only and the
 * camera sits at the origin, so geometry is drawn as offsets from the eye.
 * That is what keeps float32 vertex positions usable at planetary distances.
 */

import { mat4, vec3, geodeticToEcef, enuBasis, clamp, DEG, radiiAt } from '../core/math.js';

/* Movement keys arrive as a bitmask, which is one small number per change
 * instead of a set to serialise every frame. */
export const KEY = {
  FORWARD: 1, LEFT: 2, BACK: 4, RIGHT: 8,
  UP: 16, DOWN: 32, SPRINT: 64,
};

/* Vertical field of view. One value, shared by the projection and by the
 * imagery clipmap's sense of how big a pixel is on the ground. */
export const FOV_Y = 60 * DEG;

const MAX_PITCH = 89 * DEG;
/* A bank left over when a flight is interrupted levels out at this pace
 * (seconds to fall to about a third). */
const LEVEL_SECONDS = 0.25;
const ORIGIN = [0, 0, 0];
const MIN_SPEED = 1;
const MAX_SPEED = 20000;
const MIN_HEIGHT = -450;      // below the Dead Sea shore, the lowest dry land
const MAX_HEIGHT = 400000;

export class Camera {
  constructor({ lon = 0, lat = 0, height = 1000, yaw = 0, pitch = -0.25, speed = 120 } = {}) {
    this.lon = lon;
    this.lat = lat;
    this.height = height;
    this.yaw = yaw;      // radians, 0 looks north
    this.pitch = pitch;  // radians, negative looks down
    this.roll = 0;       // radians, positive banks right (the right side of the view goes down)
    this.speed = speed;  // flight speed in metres per second, scroll adjusts it
    this.mode = 'fly';   // set by whoever owns the controllers

    this.position = new Float64Array(3);
    this.east = new Float64Array(3);
    this.north = new Float64Array(3);
    this.up = new Float64Array(3);
    this.forward = new Float64Array(3);
    this.viewUp = new Float64Array(3);   // the up of the picture: the local up, banked by roll
    this.right = new Float64Array(3);

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
   * Move by metres along the local east, north and up directions.
   *
   * Metres become degrees through the ellipsoid's two radii of curvature at
   * this latitude. For the few metres a controller moves per step this is
   * exact to well under a millimetre.
   */
  translate(dEast, dNorth, dUp = 0) {
    if (dEast === 0 && dNorth === 0 && dUp === 0) return;
    this.offsetLonLat(dEast, dNorth, this);
    if (this.lon > 180) this.lon -= 360;
    if (this.lon < -180) this.lon += 360;
    this.height = clamp(this.height + dUp, MIN_HEIGHT, MAX_HEIGHT);
    this.moved = true;
    this.#updateOrigin();
  }

  /** Where a horizontal move would land, without making it. */
  offsetLonLat(dEast, dNorth, out = { lon: 0, lat: 0 }) {
    const { meridian, primeVertical } = radiiAt(this.lat, this.#radii);
    const lat = this.lat;
    out.lat = clamp(lat + (dNorth / meridian) / DEG, -85, 85);
    out.lon = this.lon + (dEast / (primeVertical * Math.cos(lat * DEG))) / DEG;
    return out;
  }

  #radii = { meridian: 0, primeVertical: 0 };
  #target = vec3.make(0, 0, 0);

  setHeight(height) {
    const h = clamp(height, MIN_HEIGHT, MAX_HEIGHT);
    if (h === this.height) return;
    this.height = h;
    this.moved = true;
    this.#updateOrigin();
  }

  /**
   * Brings the view back to level after a flight that banked it was cut
   * short. Called every frame no flight drives the camera.
   */
  level(dt) {
    if (this.roll === 0) return;
    this.roll = Math.abs(this.roll) < 1e-4 ? 0 : this.roll * Math.exp(-dt / LEVEL_SECONDS);
    this.moved = true;
  }

  /**
   * Rotation-only view times a reverse-Z projection with no far plane. A bank
   * turns the picture's up about the line of sight towards the right:
   * right = forward × up, level up = right × forward, banked up = level up
   * cos(roll) + right sin(roll).
   */
  matrices(aspect, fovY, near) {
    const target = this.#target, f = this.forward, u = this.viewUp;
    target[0] = f[0]; target[1] = f[1]; target[2] = f[2];
    if (this.roll === 0) {
      vec3.copy(u, this.up);
    } else {
      const r = this.right;
      vec3.normalize(r, vec3.cross(r, f, this.up));
      vec3.cross(u, r, f);
      const c = Math.cos(this.roll), s = Math.sin(this.roll);
      for (let i = 0; i < 3; i++) u[i] = u[i] * c + r[i] * s;
    }
    mat4.lookAt(this.view, ORIGIN, target, u);
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
    const { lon, lat, height, yaw, pitch, roll, speed, mode } = this;
    return { lon, lat, height, yaw, pitch, roll, speed, mode };
  }

  /* Called every frame of a flight to a place, so it assigns rather than
   * building an object to merge. */
  apply(state) {
    if (!state) return;
    this.lon = state.lon;
    this.lat = state.lat;
    this.height = state.height;
    if (state.yaw != null) this.yaw = state.yaw;
    if (state.pitch != null) this.pitch = state.pitch;
    this.roll = state.roll ?? 0;
    if (state.speed != null) this.speed = state.speed;
    this.moved = true;
    this.#updateOrigin();
  }
}
