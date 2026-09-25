/* flyto.js — a smooth flight to a place, for search results.
 *
 * The path is the one van Wijk and Nuij showed to be optimal for moving
 * across a map while zooming ("Smooth and efficient zooming and panning",
 * 2003): it rises while it travels and comes down as it arrives, trading
 * height for ground covered so that the view moves at a steady apparent
 * speed. It is what Google Earth and the map libraries use. Here the "width
 * of view" grows with the height above the ground, plus a little, so that
 * starting or ending on the ground does not make the climb to cruising height
 * look like a zoom through many orders of magnitude.
 *
 * The flight is kinematic: position, height, heading and pitch are functions
 * of time, eased in and out. It looks along the path, tips down to see where
 * it is going, and levels out at the end. Any key or mouse movement hands
 * control back where it is. The tiles at the destination are asked for when
 * it starts, so they are there when it lands.
 */

import { DEG } from '../../core/math.js';

const RHO = 1.2;               // van Wijk's curvature: 1.42 is theirs; lower flies flatter
const MIN_SECONDS = 1.5;
const MAX_SECONDS = 10;
const SECONDS_PER_UNIT = 1.1;  // flight time per unit of path length S
const MAX_HEIGHT = 800000;     // metres; beyond this the curve only wastes time
const EARTH_RADIUS = 6371000;
/* Width of view for a height above the ground: a 60° view sees about three
 * times its height across; the offset is the "plus a little". */
const toWidth = (h) => 3 * (h + 50);
const toHeight = (w) => w / 3 - 50;

/** The van Wijk-Nuij path from width w0 to w1 across a distance d. */
function zoomPath(w0, w1, d) {
  const rho2 = RHO * RHO, rho4 = rho2 * rho2;
  if (d < 1e-3) {
    const S = Math.abs(Math.log(w1 / w0)) / RHO;
    const sign = w1 < w0 ? -1 : 1;
    return { S, at: (s) => ({ u: 0, w: w0 * Math.exp(sign * RHO * s) }) };
  }
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d * d) / (2 * w0 * rho2 * d);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d * d) / (2 * w1 * rho2 * d);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  const coshR0 = Math.cosh(r0), sinhR0 = Math.sinh(r0);
  return {
    S,
    at: (s) => ({
      u: (w0 / (rho2 * d)) * (coshR0 * Math.tanh(RHO * s + r0) - sinhR0),   // fraction of the way
      w: (w0 * coshR0) / Math.cosh(RHO * s + r0),
    }),
  };
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/* Great-circle geometry on a sphere: plenty for a camera path. */
function centralAngle(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearing(a, b) {
  const p1 = a.lat * DEG, p2 = b.lat * DEG, dl = (b.lon - a.lon) * DEG;
  return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
}

/** The point a fraction f of the way along the great circle from a to b. */
function along(a, b, delta, f, out) {
  if (delta < 1e-9) { out.lon = a.lon; out.lat = a.lat; return out; }
  const p1 = a.lat * DEG, l1 = a.lon * DEG, p2 = b.lat * DEG, l2 = b.lon * DEG;
  const A = Math.sin((1 - f) * delta) / Math.sin(delta), B = Math.sin(f * delta) / Math.sin(delta);
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  out.lat = Math.atan2(z, Math.hypot(x, y)) / DEG;
  out.lon = Math.atan2(y, x) / DEG;
  return out;
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class FlyTo {
  constructor() {
    this.active = false;
    this.point = { lon: 0, lat: 0 };
  }

  /**
   * @param camera   where it starts
   * @param target   { lon, lat, ground, arrive } — ground height there (best
   *                 known, metres), and the height above it to end at
   * @param startGround ground height under the camera now
   */
  start(camera, target, startGround) {
    const from = { lon: camera.lon, lat: camera.lat };
    const delta = centralAngle(from, target);
    const d = delta * EARTH_RADIUS;
    const h0 = Math.max(0, camera.height - startGround);
    const h1 = Math.max(0, target.arrive);
    this.path = zoomPath(toWidth(h0), toWidth(h1), d);
    this.duration = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, this.path.S * SECONDS_PER_UNIT));
    this.from = from;
    this.to = { lon: target.lon, lat: target.lat };
    this.delta = delta;
    this.distance = d;
    this.ground0 = startGround;
    this.ground1 = target.ground;
    this.yaw0 = camera.yaw;
    this.pitch0 = camera.pitch;
    this.heading = d > 1 ? bearing(from, target) : camera.yaw;
    this.endPitch = target.endPitch ?? -0.1;
    this.time = 0;
    this.active = true;
    this.label = target.label || '';
  }

  cancel() { this.active = false; }

  /** Moves the camera along the flight; returns true on the step it lands. */
  step(dt, camera, floorAt) {
    if (!this.active) return false;
    this.time += dt;
    const t = Math.min(1, this.time / this.duration);
    const e = ease(t);
    const { u, w } = this.path.at(e * this.path.S);
    const f = Math.max(0, Math.min(1, u));
    along(this.from, this.to, this.delta, f, this.point);

    // Height over a ground that blends from here to there, and never below
    // what is known of the terrain under the path.
    const ground = this.ground0 + (this.ground1 - this.ground0) * f;
    let height = ground + Math.min(toHeight(w), MAX_HEIGHT);
    const floor = floorAt(this.point.lon, this.point.lat);
    if (floor != null && height < floor + 20) height = floor + 20;

    // Turn onto the path's heading in the first fifth, look down towards the
    // destination while travelling, and level out over the last fifth.
    const turn = Math.min(1, t / 0.2);
    const yaw = this.yaw0 + wrap(this.heading - this.yaw0) * ease(turn);
    const remaining = this.distance * (1 - f);
    const lookDown = -Math.atan2(height - this.ground1, Math.max(remaining, 1));
    const cruise = Math.max(-0.9, Math.min(-0.15, lookDown));
    const pitch = t < 0.2 ? this.pitch0 + (cruise - this.pitch0) * ease(turn)
      : t > 0.8 ? cruise + (this.endPitch - cruise) * ease((t - 0.8) / 0.2)
      : cruise;
    camera.apply({ lon: this.point.lon, lat: this.point.lat, height, yaw, pitch });

    if (t >= 1) { this.active = false; return true; }
    return false;
  }
}
