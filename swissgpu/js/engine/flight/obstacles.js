/* obstacles.js — how high anything can be, for a flight to stay above it.
 *
 * One question, answered as an upper bound and never as an estimate: the
 * height nothing within r metres of a point reaches above. A flight that
 * keeps above it hits nothing, whatever has loaded so far; better data only
 * lowers it.
 *
 *   ground      the terrain's own bound (terrain/terrain.js, upperBound):
 *               the highest point of each loaded tile over a 16 x 16 grid,
 *               plus a margin for detail the tile's level leaves out. Where
 *               no terrain is loaded at all, Everest.
 *   layers      each 3D Tiles layer's bound (features/tileset.js,
 *               upperBound): a loaded tile's grid of highest points, else
 *               the top of its bounding volume, as deep as the tree is
 *               known. What has not loaded could be the tallest building
 *               there is, but no more: TALLEST_BUILT above the ground.
 *   zones       around the start and the landing, exactly: the triangles
 *               (and cable ropes) gathered there for collision
 *               (features/solid.js), in place of the layers' volumes.
 *
 * Nothing is ever higher than EVEREST: wherever little is known, a flight
 * passes over it all.
 *
 * Two more questions go with it: what is there as best known (estimate: how
 * high the ground is with half the margin, and what has loaded), which sets
 * a flight's pace without the bound's caution slowing it to a crawl; and
 * what has certainly loaded (known), which a flight under way watches.
 */

/* Metres: the highest ground on earth, and the most anything built stands
 * above the ground near it (Switzerland's tallest building is 205 m). */
export const EVEREST = 8849;
export const TALLEST_BUILT = 300;

export class Obstacles {
  /**
   * @param terrain  anything with upperBound(lon, lat, r): metres, NaN where unknown
   * @param layers   upperBound(lon, lat, r, cap) per building layer (-Infinity:
   *                 nothing there; NaN: unknown; nothing unknown above `cap`)
   */
  constructor(terrain, layers) {
    this.terrain = terrain;
    this.layers = layers;
    this.zones = [];
    this.calls = 0;           // questions asked, for the probe
    this.bound = this.bound.bind(this);
    this.known = this.known.bind(this);
    this.estimate = this.estimate.bind(this);
  }

  /**
   * Exact solids around a point, out to `reach` metres: a SolidWorld whose
   * `prepare` gathered at least that far (its origin is the point).
   */
  addZone(solids, reach) {
    const o = solids.origin;
    this.zones.push({ solids, reach, lon: o.lon, lat: o.lat, height: o.height });
  }

  clearZones() { this.zones.length = 0; }

  /** The height nothing within `radius` metres of (lon, lat) reaches above. */
  bound(lon, lat, radius = 0) {
    this.calls++;
    let ground = this.terrain.upperBound(lon, lat, radius);
    if (!(ground < EVEREST)) ground = EVEREST;
    let top = ground;
    const zone = this.#zoneFor(lon, lat, radius);
    if (zone) {
      const s = zone.solids;
      const h = s.highest((lon - zone.lon) * s.mPerDegLon, (lat - zone.lat) * s.mPerDegLat, radius);
      if (h + zone.height > top) top = h + zone.height;
    } else {
      const built = this.built(lon, lat, radius, ground);
      if (built > top) top = built;
    }
    return top < EVEREST ? top : EVEREST;
  }

  /**
   * The height nothing built within `radius` metres of (lon, lat) reaches
   * above, from the layers alone (a loaded tile's grid of highest points,
   * else its volume's top; what is unknown, up to TALLEST_BUILT above
   * `ground`), -Infinity where nothing is. Also what decides whether physics
   * needs what stands round a flyer (workers/render.js, the focus).
   */
  built(lon, lat, radius, ground) {
    const cap = ground + TALLEST_BUILT;
    let top = -Infinity;
    for (const layer of this.layers) {
      let h = layer.upperBound(lon, lat, radius, cap);
      if (Number.isNaN(h)) h = cap;
      if (h > top) top = h;
    }
    return top;
  }

  /**
   * How high what is within `radius` metres of (lon, lat) reaches, as best
   * known: the terrain's estimate (sea level where nothing has loaded) and
   * what has loaded of everything else. What a flight's speed follows.
   */
  estimate(lon, lat, radius = 0) {
    let top = this.terrain.estimate ? this.terrain.estimate(lon, lat, radius) : this.terrain.upperBound(lon, lat, radius);
    if (!(top > -Infinity)) top = 0;
    const known = this.known(lon, lat, radius);
    return known > top ? known : top;
  }

  /**
   * The highest thing within `radius` metres of (lon, lat) that has
   * certainly loaded (a layer's content, or a zone's triangles and ropes),
   * -Infinity if none. Nothing else: not the ground, whose truth does not
   * change when tiles come and go, and not what might stand where nothing
   * has loaded. A flight under way compares it with what it planned for, so
   * only something new that is really there lifts it (flight.js, the watch).
   */
  known(lon, lat, radius = 0) {
    this.calls++;
    const zone = this.#zoneFor(lon, lat, radius);
    if (zone) {
      const s = zone.solids;
      return s.highest((lon - zone.lon) * s.mPerDegLon, (lat - zone.lat) * s.mPerDegLat, radius) + zone.height;
    }
    let top = -Infinity;
    for (const layer of this.layers) {
      const h = layer.knownTop ? layer.knownTop(lon, lat, radius) : -Infinity;
      if (h > top) top = h;
    }
    return top;
  }

  /* The zone the whole circle lies in, if any (the square round it, to be safe). */
  #zoneFor(lon, lat, radius) {
    for (const z of this.zones) {
      const s = z.solids;
      const dx = (lon - z.lon) * s.mPerDegLon, dy = (lat - z.lat) * s.mPerDegLat;
      if (Math.sqrt(dx * dx + dy * dy) + radius * 1.42 <= z.reach) return z;
    }
    return null;
  }
}
