/* flight-path.js — the shape of a flight: where it goes, how high, and how
 * progress runs in time. Plain geometry with no state of the app, used by
 * controllers/flyto.js and by anything else that moves along a planned path.
 *
 * Plane    an azimuthal equidistant projection centred on a point (Snyder,
 *          "Map Projections: A Working Manual", 1987, pp. 191-202):
 *          distances and directions from the centre are true, and within a
 *          few hundred kilometres everything else is true to a small
 *          fraction of a percent. Routes are worked out in it and mapped back
 *          point by point, so they reach any distance, the other side of the
 *          world included.
 * Route    a take-off straight, a turn, a straight, a turn and a final
 *          straight: the shortest way from one point and heading to another
 *          that never turns tighter than given radii (Dubins 1957), from the
 *          four candidates that turn at both ends (left or right, straight,
 *          left or right), which always include a solution. The two turns
 *          may have different radii.
 * Profile  a height along a route, as a sum of smootherstep ramps, each long
 *          enough for its steepest slope to stay within a bound: climbs and
 *          descents start and end without a kink in height, slope or
 *          curvature.
 * Ease     time to progress, starting and stopping without a jolt: the speed
 *          rises along a smootherstep, holds, and falls the same way.
 *
 * Headings here are mathematical (radians from +x, anticlockwise); x is east
 * and y north in a Plane.
 */

import { DEG, radiiAt } from '../../core/math.js';

const TWO_PI = 2 * Math.PI;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Perlin's smootherstep, 0 to 1 over 0..1, flat to the second derivative at both ends. */
export function smootherstep(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (u * (6 * u - 15) + 10);
}

/* Its slope, steepest (15/8) at the middle. */
export function smootherstepSlope(u) {
  if (u <= 0 || u >= 1) return 0;
  return 30 * u * u * (u - 1) * (u - 1);
}

/* The steepest slope of a smootherstep ramp per unit of rise over run. */
export const SMOOTHER_PEAK = 15 / 8;

/* Its integral from 0 to u: 0.5 at u = 1. */
function smootherstepArea(u) {
  return u * u * u * u * (u * (u - 3) + 2.5);
}

/* An angle in [0, 2π), with a full turn's rounding error read as none. */
function sweepOf(a) {
  let s = a - TWO_PI * Math.floor(a / TWO_PI);
  if (s > TWO_PI - 1e-9) s = 0;
  return s;
}

/* ---- Plane ---------------------------------------------------------------- */

export class Plane {
  /** Centred on a longitude and latitude in degrees, on the sphere that fits
   * the ellipsoid there best (radius the mean of its two curvatures). */
  constructor(lon, lat) {
    this.lon0 = lon;
    this.lat0 = lat;
    const { meridian, primeVertical } = radiiAt(lat);
    this.radius = Math.sqrt(meridian * primeVertical);
    this.sin0 = Math.sin(lat * DEG);
    this.cos0 = Math.cos(lat * DEG);
  }

  /** Metres east (x) and north (y) of the centre, into `out`. */
  forward(lon, lat, out) {
    const phi = lat * DEG, dl = (lon - this.lon0) * DEG;
    const sp = Math.sin(phi), cp = Math.cos(phi), cdl = Math.cos(dl);
    // The angle at the earth's centre, by the haversine: exact for short distances.
    const h = Math.sin((phi - this.lat0 * DEG) / 2) ** 2 + this.cos0 * cp * Math.sin(dl / 2) ** 2;
    const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));
    const k = c < 1e-9 ? 1 : c / Math.sin(c);
    out.x = this.radius * k * cp * Math.sin(dl);
    out.y = this.radius * k * (this.cos0 * sp - this.sin0 * cp * cdl);
    return out;
  }

  /** Longitude and latitude in degrees of a point of the plane, into `out`. */
  inverse(x, y, out) {
    const rho = Math.hypot(x, y);
    if (rho < 1e-9) { out.lon = this.lon0; out.lat = this.lat0; return out; }
    const c = rho / this.radius, sc = Math.sin(c), cc = Math.cos(c);
    out.lat = Math.asin(clamp(cc * this.sin0 + (y * sc * this.cos0) / rho, -1, 1)) / DEG;
    let lon = this.lon0 + Math.atan2(x * sc, rho * this.cos0 * cc - y * this.sin0 * sc) / DEG;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    out.lon = lon;
    return out;
  }
}

/* ---- Route ---------------------------------------------------------------- */

/**
 * Shortest path of a turn of radius r1, a straight and a turn of radius r2
 * from (x0, y0) heading h0 to (x1, y1) heading h1. Turns are +1 left
 * (anticlockwise) and -1 right; each circle's centre is its radius to that
 * side of its end of the path. The straight leaves the first circle at the
 * heading h where both tangent points line up along it: with centres c1, c2
 * and v = c2 - c1, the points are c + t r (sin h, -cos h), so their
 * difference has no part across h when |v| sin(h - angle of v) = t1 r1 - t2 r2.
 */
export function dubins(x0, y0, h0, x1, y1, h1, r1, r2 = r1) {
  let best = null;
  for (const t1 of [1, -1]) {
    for (const t2 of [1, -1]) {
      const c1x = x0 - t1 * r1 * Math.sin(h0), c1y = y0 + t1 * r1 * Math.cos(h0);
      const c2x = x1 - t2 * r2 * Math.sin(h1), c2y = y1 + t2 * r2 * Math.cos(h1);
      const vx = c2x - c1x, vy = c2y - c1y, apart = Math.hypot(vx, vy);
      const q = t1 * r1 - t2 * r2;
      if (apart < 1e-9 || Math.abs(q) > apart) continue;
      const hs = Math.atan2(vy, vx) + Math.asin(q / apart);
      const straight = Math.sqrt(Math.max(0, apart * apart - q * q));
      const sweep1 = sweepOf(t1 * (hs - h0)), sweep2 = sweepOf(t2 * (h1 - hs));
      const length = r1 * sweep1 + r2 * sweep2 + straight;
      if (!best || length < best.length) best = { t1, t2, c1x, c1y, c2x, c2y, hs, straight, sweep1, sweep2, length };
    }
  }
  return best;
}

export class Route {
  /**
   * From (x0, y0) heading h0 to (x1, y1) heading h1: `takeoff` metres
   * straight on, the shortest turn-straight-turn with radii `radius` and
   * `radius2`, and `final` metres straight in. With no radius, a straight
   * line and nothing else.
   */
  constructor(x0, y0, h0, x1, y1, h1, { takeoff = 0, final = 0, radius = 0, radius2 = radius } = {}) {
    this.x0 = x0; this.y0 = y0;
    this.radius = radius;
    this.radius2 = radius2;
    if (!(radius > 0)) {
      this.path = null;
      this.h0 = this.h1 = Math.atan2(y1 - y0, x1 - x0);
      this.length = Math.hypot(x1 - x0, y1 - y0);
      this.takeoff = this.length;
      this.final = 0;
      this.marks = [this.length, this.length, this.length, this.length];
      this.sweep = 0;
      return;
    }
    this.h0 = h0; this.h1 = h1;
    this.takeoff = takeoff;
    this.final = final;
    this.ax = x0 + takeoff * Math.cos(h0); this.ay = y0 + takeoff * Math.sin(h0);
    this.bx = x1 - final * Math.cos(h1); this.by = y1 - final * Math.sin(h1);
    const p = this.path = dubins(this.ax, this.ay, h0, this.bx, this.by, h1, radius, radius2);
    const arc1 = radius * p.sweep1, arc2 = radius2 * p.sweep2;
    // Where each part ends, in metres along the route.
    this.marks = [takeoff, takeoff + arc1, takeoff + arc1 + p.straight, takeoff + arc1 + p.straight + arc2];
    this.length = this.marks[3] + final;
    this.sweep = p.sweep1 + p.sweep2;
    // Where the straight between the turns starts.
    this.sx = p.c1x + p.t1 * radius * Math.sin(p.hs);
    this.sy = p.c1y - p.t1 * radius * Math.cos(p.hs);
  }

  /** The point `s` metres along: { x, y, heading, curvature } into `out`
   * (curvature 1/radius, positive turning left). */
  at(s, out) {
    const m = this.marks;
    let r = this.radius;
    if (!this.path || s <= m[0]) {
      const k = Math.min(s, this.takeoff);
      out.x = this.x0 + k * Math.cos(this.h0);
      out.y = this.y0 + k * Math.sin(this.h0);
      out.heading = this.h0;
      out.curvature = 0;
      return out;
    }
    const p = this.path;
    let cx, cy, t, h;
    if (s <= m[1]) {
      t = p.t1; cx = p.c1x; cy = p.c1y;
      h = this.h0 + (t * (s - m[0])) / r;
    } else if (s <= m[2]) {
      const k = s - m[1];
      out.x = this.sx + k * Math.cos(p.hs);
      out.y = this.sy + k * Math.sin(p.hs);
      out.heading = p.hs;
      out.curvature = 0;
      return out;
    } else if (s <= m[3]) {
      t = p.t2; cx = p.c2x; cy = p.c2y; r = this.radius2;
      h = p.hs + (t * (s - m[2])) / r;
    } else {
      const k = Math.min(s, this.length) - m[3];
      out.x = this.bx + k * Math.cos(this.h1);
      out.y = this.by + k * Math.sin(this.h1);
      out.heading = this.h1;
      out.curvature = 0;
      return out;
    }
    // On a circle: the point whose tangent has heading h.
    out.x = cx + t * r * Math.sin(h);
    out.y = cy - t * r * Math.cos(h);
    out.heading = h;
    out.curvature = t / r;
    return out;
  }
}

/* ---- Profile -------------------------------------------------------------- */

export class Profile {
  /** Starting at `start`; ramps are added with `add`. */
  constructor(start) {
    this.start = start;
    this.ramps = [];
  }

  /** Rises by `rise` (negative to fall) between `from` and `from + length`. */
  add(from, length, rise) {
    if (rise !== 0 && length > 0) this.ramps.push(from, length, rise);
    return this;
  }

  /** Height and slope `s` along, into `out`: { height, slope }. */
  at(s, out) {
    const R = this.ramps;
    let height = this.start, slope = 0;
    for (let i = 0; i < R.length; i += 3) {
      const u = (s - R[i]) / R[i + 1];
      if (u <= 0) continue;
      if (u >= 1) { height += R[i + 2]; continue; }
      height += R[i + 2] * smootherstep(u);
      slope += (R[i + 2] * smootherstepSlope(u)) / R[i + 1];
    }
    out.height = height;
    out.slope = slope;
    return out;
  }
}

/* ---- Ease ----------------------------------------------------------------- */

export class Ease {
  /** The speed builds up over the first `rampIn` and dies down over the last
   * `rampOut` of the time, shares of the whole. */
  constructor(rampIn, rampOut) {
    this.a = clamp(rampIn, 0, 0.5);
    this.b = clamp(rampOut, 0, 0.5);
    // Speed in the middle: what makes the whole come to exactly 1.
    this.peak = 1 / (1 - (this.a + this.b) / 2);
  }

  /** Progress, 0 to 1, at a share `x` of the time. */
  at(x) {
    const { a, b, peak } = this;
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x < a) return peak * a * smootherstepArea(x / a);
    if (x > 1 - b) return 1 - peak * b * smootherstepArea((1 - x) / b);
    return peak * (a / 2 + (x - a));
  }

  /** Its rate of change: the speed, as a multiple of the average. */
  rate(x) {
    const { a, b, peak } = this;
    if (x <= 0 || x >= 1) return 0;
    if (x < a) return peak * smootherstep(x / a);
    if (x > 1 - b) return peak * smootherstep((1 - x) / b);
    return peak;
  }

  /** The share of the time at which progress reaches `p`. */
  inverse(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (this.at(mid) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
}
