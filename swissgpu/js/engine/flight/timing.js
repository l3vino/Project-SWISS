/* timing.js — how fast a search flight goes along its path.
 *
 * One bell per flight (Stage 5.5, his words: "relatively slowly at the
 * beginning, max speed halfway and then relatively slow at the end"): the
 * flight's progress follows the minimum-jerk curve, Perlin's smootherstep
 * 10u³ − 15u⁴ + 6u⁵ of the time (the way people move their arms, Flash &
 * Hogan 1985, and Cesium's default flyTo easing): speed and acceleration
 * start and end at zero, the speed rises without a kink to its peak exactly
 * halfway (1.875 times the mean) and falls the same way. Nothing else
 * changes the pace: no slowing for turns, no re-plans, so the speed never
 * jumps.
 *
 * Progress is measured in what the eye sees, not in metres: σ, the path's
 * length in heights above the ground (plus PACE.offset), ∫ ds / (h + offset).
 * Flying along, σ grows by the ground passing under you in heights; going
 * straight up or down, by the log of the height (a zoom): the measure van
 * Wijk and Nuij's map flights keep steady ("Smooth and efficient zooming and
 * panning", 2003). So a flight climbing from the street to 2 km and on is as
 * calm at the start as on the way, and the bell's peak, PACE.peak heights a
 * second, is the fastest the ground ever streams past. Long trips fly higher,
 * so they cover more kilometres at the same look. The height is above a
 * smooth line from the ground at the start to the ground at the end
 * (plan.js), not above the real ground under the path: over a ridge the
 * flight keeps its pace (his words, Stage 5.7: "Over the mountains the speed
 * does not have to slow down!"), and its speed in metres a second rises to
 * the middle and falls after it, never dipping on the way.
 *
 * The bell's length T is the longest of: the pace (1.875 σ / peak, the peak
 * being PACE.peak, or more where even the straight way there would take
 * longer than paceCap allows for the distance, so low hops do not crawl:
 * allowedPeak, the same for every route between the same ends, so a longer
 * route always takes longer), the turns (the view, always on the path's
 * heading, turns no faster than COMFORT.turnRate, and its turning changes no
 * faster than COMFORT.turnAccel: about where motion sickness starts, 18°/s
 * and 15°/s², "The onset threshold of cybersickness in constant and
 * accelerating optical flow", Applied Sciences 2020) and DURATION.least.
 * Then the Flight speed setting plays it faster or slower, and Longest
 * flight caps it.
 */

const DEG = Math.PI / 180;

/*
 * peak     the fastest the ground streams past, at the middle: heights a second
 * offset   metres added to the height above the ground (the pace near it)
 * zoom     going up or down counts this many times less than going along
 *          (van Wijk and Nuij's ρ). Their users preferred 1.42, about √2,
 *          for maps seen from straight above, where rising zooms the whole
 *          picture; looking ahead, as here, rising barely moves the middle of
 *          the view. Stage 5.6, his words: "liftoff and landing should take
 *          less time": 4, so a climb or a descent takes about half the
 *          σ it took (and, the bell being slow at its ends, a quarter to a
 *          third less time; 2.5 gave only a tenth to a fifth)
 */
export const PACE = { peak: 1.5, offset: 6, zoom: 4 };

/* The path's turning: at most this fast, and changing at most this fast
 * (the camera, which looks along it, has no limits of its own: his words,
 * Stage 5.7, "camera does not have a max turning speed"). */
export const COMFORT = { turnRate: 20 * DEG, turnAccel: 15 * DEG };


/* A flight lasts at least `least` seconds, and its pace may make it last at
 * most base + perDecade · log10(1 + distance / unit) seconds (7 s at a few
 * metres, 10.9 at 500 m, 18.5 at 20 km): close to the ground the pace alone
 * would crawl. */
export const DURATION = { least: 3, base: 7, perDecade: 5, unit: 100 };

/** The bell: progress (0..1) at a share u of the time. */
export function bell(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * u * (u * (6 * u - 15) + 10);
}

/** Its rate: d bell / du (peak 1.875 at the middle). */
export function bellRate(u) {
  if (u <= 0 || u >= 1) return 0;
  const v = u * (1 - u);
  return 30 * v * v;
}

/** Its second derivative. */
export function bellAccel(u) {
  if (u <= 0 || u >= 1) return 0;
  return 60 * u * (1 - u) * (1 - 2 * u);
}

/* The bell's inverse at 1024 steps of progress, by bisection once. */
const INVERSE = new Float64Array(1025);
for (let i = 1; i < 1024; i++) {
  let lo = 0, hi = 1;
  for (let it = 0; it < 56; it++) {
    const mid = (lo + hi) / 2;
    if (bell(mid) < i / 1024) lo = mid;
    else hi = mid;
  }
  INVERSE[i] = (lo + hi) / 2;
}
INVERSE[1024] = 1;

/** The share of the time at which the bell reaches progress y (0..1):
 * read from the table, then polished by Newton's method. */
export function bellInverse(y) {
  if (y <= 0) return 0;
  if (y >= 1) return 1;
  const f = y * 1024, i = Math.min(1023, Math.floor(f));
  let u = INVERSE[i] + (INVERSE[i + 1] - INVERSE[i]) * (f - i);
  for (let it = 0; it < 4; it++) {
    const d = bellRate(u);
    if (!(d > 1e-12)) break;
    const next = u - (bell(u) - y) / d;
    if (!(next > 0 && next < 1)) break;
    if (Math.abs(next - u) < 1e-15) { u = next; break; }
    u = next;
  }
  return u;
}

/* The bell's rate where its progress is y, from a table (pricing routes
 * asks it often). */
const RATE_TABLE = new Float64Array(257);
for (let i = 0; i <= 256; i++) RATE_TABLE[i] = bellRate(bellInverse(i / 256));

/** The bell's rate (d progress / d share of time) where its progress is y. */
export function bellRateAtProgress(y) {
  if (y <= 0 || y >= 1) return 0;
  const f = y * 256, i = Math.min(255, Math.floor(f)), t = f - i;
  return RATE_TABLE[i] + (RATE_TABLE[i + 1] - RATE_TABLE[i]) * t;
}

/** The fastest the bell goes between progress ya and yb. */
export function fastestBetween(ya, yb) {
  if (ya <= 0.5 && yb >= 0.5) return 1.875;
  return Math.max(bellRateAtProgress(ya), bellRateAtProgress(yb));
}

/** The longest the pace may make a flight of this distance last. */
export function paceCap(distance) {
  return DURATION.base + DURATION.perDecade * Math.log10(1 + Math.max(0, distance) / DURATION.unit);
}

/**
 * The perceived length of a straight segment `flat` metres across and
 * `rise` metres up or down, whose height above the ground goes from a to b
 * (both plus PACE.offset, metres): ∫ dl / height, the rise weighed down by
 * PACE.zoom, for a height changing linearly along it.
 */
export function segmentSigma(flat, rise, a, b) {
  const length = Math.sqrt(flat * flat + (rise / PACE.zoom) ** 2);
  if (!(length > 0)) return 0;
  const d = b - a;
  if (Math.abs(d) < 1e-9 * Math.max(a, b)) return length / ((a + b) / 2);
  return (length * Math.log(b / a)) / d;
}

/**
 * The fastest the ground may stream past on a trip (heights a second):
 * PACE.peak, or more where even the straight way there (`sigmaStraight`)
 * would take longer than paceCap allows for the distance. The same for every
 * route between the same ends, so a longer route always takes longer.
 */
export function allowedPeak(sigmaStraight, distance) {
  return Math.max(PACE.peak, (1.875 * sigmaStraight) / paceCap(distance));
}

/**
 * The bell's length for a path of perceived length `sigma` at a peak pace
 * of `peak` heights a second, or longer where `turns(T)` (the fastest the
 * view would turn, and the fastest its turning would change, at length T, in
 * rad/s and rad/s²) says the turns need more; at least DURATION.least.
 * Both turn quantities scale as 1/T and 1/T², so one evaluation at T0 says
 * how long they need.
 */
export function naturalDuration(sigma, peak, turns) {
  const T0 = Math.max((1.875 * sigma) / peak, DURATION.least);
  if (!turns) return T0;
  const { rate, accel } = turns(T0);
  return Math.max(T0, (T0 * rate) / COMFORT.turnRate, T0 * Math.sqrt(accel / COMFORT.turnAccel));
}
