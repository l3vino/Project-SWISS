/* geo.js — positions on the earth and a flat map to plan in.
 *
 * wrapAngle  an angle into [-π, π)
 * offset     the point some metres east and north of another, through the
 *            ellipsoid's radii of curvature there (exact to well under a
 *            millimetre for the few metres it is used for)
 * Plane      an azimuthal equidistant projection centred on a point (Snyder,
 *            "Map Projections: A Working Manual", 1987, pp. 191-202), on the
 *            sphere that fits the ellipsoid best there: distances and
 *            directions from the centre are true, and within a few hundred
 *            kilometres everything else is true to a small fraction of a
 *            percent. Paths are planned in it and mapped back point by
 *            point, so they reach any distance, the other side of the world
 *            included.
 *
 * Headings are azimuths: radians clockwise from north, as the camera's yaw.
 * In a Plane, x is east and y north, so a heading h points along
 * (sin h, cos h) and a positive turn is to the right.
 */

import { DEG, radiiAt, clamp } from './math.js';

const TWO_PI = 2 * Math.PI;

export function wrapAngle(a) {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}

const scratchRadii = { meridian: 0, primeVertical: 0 };

/** The point `east` and `north` metres from (lon, lat), into `out`. */
export function offset(lon, lat, east, north, out) {
  const { meridian, primeVertical } = radiiAt(lat, scratchRadii);
  out.lat = lat + north / (meridian * DEG);
  out.lon = lon + east / (primeVertical * Math.cos(lat * DEG) * DEG);
  return out;
}

export class Plane {
  /** Centred on a longitude and latitude in degrees. */
  constructor(lon, lat) {
    this.lon0 = lon;
    this.lat0 = lat;
    const { meridian, primeVertical } = radiiAt(lat);
    // The sphere whose radius is the mean of the ellipsoid's two curvatures there.
    this.radius = Math.sqrt(meridian * primeVertical);
    this.sin0 = Math.sin(lat * DEG);
    this.cos0 = Math.cos(lat * DEG);
    this.scratch = { lon: 0, lat: 0, x: 0, y: 0 };
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

  /** Longitude and latitude of a point of the plane, into `out`. */
  inverse(x, y, out) {
    const rho = Math.sqrt(x * x + y * y);
    if (rho < 1e-9) {
      out.lon = this.lon0;
      out.lat = this.lat0;
      return out;
    }
    const c = rho / this.radius, sc = Math.sin(c), cc = Math.cos(c);
    out.lat = Math.asin(clamp(cc * this.sin0 + (y * sc * this.cos0) / rho, -1, 1)) / DEG;
    let lon = this.lon0 + Math.atan2(x * sc, rho * this.cos0 * cc - y * this.sin0 * sc) / DEG;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    out.lon = lon;
    return out;
  }

  /** The heading in the plane of a true azimuth at (lon, lat): where a metre along it lands. */
  headingAt(lon, lat, azimuth) {
    const s = this.scratch;
    this.forward(lon, lat, s);
    const x0 = s.x, y0 = s.y;
    offset(lon, lat, Math.sin(azimuth), Math.cos(azimuth), s);
    this.forward(s.lon, s.lat, s);
    return Math.atan2(s.x - x0, s.y - y0);
  }

  /** The true azimuth of a heading in the plane at (x, y): the other way round. */
  azimuthAt(x, y, heading) {
    const s = this.scratch;
    this.inverse(x, y, s);
    const lon0 = s.lon, lat0 = s.lat;
    this.inverse(x + Math.sin(heading), y + Math.cos(heading), s);
    let dLon = s.lon - lon0;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const { meridian, primeVertical } = radiiAt(lat0, scratchRadii);
    return Math.atan2(dLon * DEG * primeVertical * Math.cos(lat0 * DEG), (s.lat - lat0) * DEG * meridian);
  }
}
