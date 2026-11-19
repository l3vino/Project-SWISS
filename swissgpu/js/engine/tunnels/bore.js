/* bore.js — what the controllers ask of a tunnel's bore (Stage 5.18b), with
 * no imports so walking, flying and the airplane (and their tests in Node)
 * can use it.
 *
 * tunnels.js `boreAt(lon, lat, feet)` answers for a point inside a tube: its
 * floor and the ground to stand on there (a walkway is a kerb higher), the
 * vault over the point, how far right of the bore's middle the point is and
 * which way right is, and the outline as drawn (sections.js outlineAt: walls
 * to `wallTop` `wallHalf` either side, the arch's ellipse over them).
 */

/** The bore's half-width `up` metres over its floor (its outline as drawn), 0 above it. */
export function boreHalfAt(bore, up) {
  if (up <= bore.wallTop) return bore.wallHalf;
  if (!(bore.archA > 0)) return 0;
  const y = (up - bore.archY) / bore.archH;
  return Math.abs(y) >= 1 ? 0 : bore.archA * Math.sqrt(1 - y * y);
}

/**
 * How far right of the bore's middle a body may stand (its narrowest half-width over the body's height, less its
 * radius): from `from` to `to` metres over the floor.
 */
export function boreRoom(bore, from, to, radius) {
  let half = Infinity;
  for (let i = 0; i <= 4; i++) half = Math.min(half, boreHalfAt(bore, from + ((to - from) * i) / 4));
  return half - radius;
}

/**
 * The bore round a body, if it is inside it: its middle between the walls and its feet in the bore's lower part
 * (`headroom` metres under the vault at the least), so a body on the ground over a tunnel is never taken in.
 * @param tunnelAt  the physics' `tunnelAt` (tunnels.js boreAt), or undefined
 */
export function insideBore(tunnelAt, lon, lat, feet, headroom) {
  const b = tunnelAt?.(lon, lat, feet);
  if (!b || Math.abs(b.across) > b.half || feet > b.top - headroom || feet < b.floor - 0.6) return null;
  return b;
}
