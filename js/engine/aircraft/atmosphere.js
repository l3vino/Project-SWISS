/* atmosphere.js — the International Standard Atmosphere (ISO 2533, the US
 * Standard Atmosphere 1976 below 20 km): temperature falling 6.5 K a
 * kilometre from 15 °C at sea level to the tropopause at 11 km, constant
 * -56.5 °C above it; pressure from the hydrostatic equation; density from
 * the ideal gas; the speed of sound from the temperature. Heights are
 * geopotential metres above mean sea level (the difference from geometric
 * height is 0.3% at 20 km). Above 20 km the stratosphere's second layer is
 * not modelled: the isothermal layer carries on, a few per cent off at 25 km.
 */

const G0 = 9.80665;          // m/s²
const R = 287.053;           // J/(kg K), dry air
const GAMMA = 1.4;
const T0 = 288.15, P0 = 101325, LAPSE = 0.0065;
const TROPOPAUSE = 11000, T11 = T0 - LAPSE * TROPOPAUSE;
const P11 = P0 * (T11 / T0) ** (G0 / (LAPSE * R));

export const SEA_LEVEL_DENSITY = P0 / (R * T0);   // 1.225 kg/m³

/** The air at `height` metres, into `out`: { temperature (K), pressure (Pa), density (kg/m³), sound (m/s), ratio (density / sea level's) }. */
export function air(height, out = {}) {
  const h = Math.max(-500, height);
  let T, p;
  if (h < TROPOPAUSE) {
    T = T0 - LAPSE * h;
    p = P0 * (T / T0) ** (G0 / (LAPSE * R));
  } else {
    T = T11;
    p = P11 * Math.exp((-G0 * (h - TROPOPAUSE)) / (R * T11));
  }
  out.temperature = T;
  out.pressure = p;
  out.density = p / (R * T);
  out.sound = Math.sqrt(GAMMA * R * T);
  out.ratio = out.density / SEA_LEVEL_DENSITY;
  return out;
}
