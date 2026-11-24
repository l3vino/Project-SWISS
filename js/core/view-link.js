/* view-link.js — a view as a link (Stage 5.18e).
 *
 * His words on 5.18d: "make it so you can really easily command you position and camera for checking". A view is where
 * the camera is and where it looks, written after the page's address as Google Earth writes its views, with KML's
 * camera angles (heading clockwise from north; tilt 0 looking straight down, 90 at the horizon):
 * `#@46.154500,8.986800,219.0a,174.3h,90.0t`, and `,walk` for a walker. The address bar keeps the view (main.js), a link
 * opened starts there, and the search box and the console (swissgpu.go) take one too, or plain coordinates.
 */

const DEG = 180 / Math.PI;
/* The camera's own limits (engine/camera.js): heights, and how far it looks up or down. */
const LOWEST = -450, HIGHEST = 400000, STEEPEST = 89;

/**
 * The link's part after '#' for a camera state.
 * @param state  { lon, lat, height (metres), yaw (radians, 0 north, clockwise), pitch (radians, 0 level), mode }
 */
export function formatView({ lon, lat, height, yaw = 0, pitch = 0, mode = 'fly' }) {
  const heading = ((((yaw * DEG) % 360) + 360) % 360);
  const tilt = 90 + pitch * DEG;
  return `@${lat.toFixed(6)},${lon.toFixed(6)},${height.toFixed(1)}a,${(heading >= 359.95 ? 0 : heading).toFixed(1)}h,` +
    `${tilt.toFixed(1)}t${mode === 'walk' ? ',walk' : ''}`;
}

/**
 * A view from a link (the whole address or its part after '#'), or from plain coordinates ("46.1545, 8.9868", as the
 * readout shows the position). Null if it is neither.
 * @returns { lat, lon, height, yaw, pitch, mode }: height, yaw, pitch and mode undefined where the text gives none
 *          (plain coordinates give only lat and lon)
 */
export function parseView(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(hash + 1).trim();
  if (s.startsWith('@')) return linked(s.slice(1));
  // Plain coordinates: latitude then longitude, apart by a comma or spaces.
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:,\s*|\s+)(-?\d+(?:\.\d+)?)$/.exec(s);
  return m ? place(Number(m[1]), Number(m[2])) : null;
}

/* The fields after '@': latitude, longitude, then each with its unit's letter (a altitude, h heading, t tilt) in any
 * order, and `walk`; any other field Google Earth writes (d distance, y field of view, r roll) is passed over. */
function linked(body) {
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length < 2) return null;
  const view = place(number(parts[0]), number(parts[1]));
  if (!view) return null;
  for (const p of parts.slice(2)) {
    if (p === 'walk') { view.mode = 'walk'; continue; }
    if (p === 'fly') { view.mode = 'fly'; continue; }
    const f = /^(-?\d+(?:\.\d+)?)([a-z])$/.exec(p);
    if (!f) return null;
    const v = Number(f[1]);
    if (f[2] === 'a') {
      if (v < LOWEST || v > HIGHEST) return null;
      view.height = v;
    } else if (f[2] === 'h') {
      view.yaw = (((((v % 360) + 360) % 360) + 180) % 360 - 180) / DEG;
    } else if (f[2] === 't') {
      if (v < 0 || v > 180) return null;
      view.pitch = Math.max(-STEEPEST, Math.min(STEEPEST, v - 90)) / DEG;
    }
  }
  view.mode ??= view.height === undefined ? undefined : 'fly';
  return view;
}

function place(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, height: undefined, yaw: undefined, pitch: undefined, mode: undefined };
}

function number(p) {
  return /^-?\d+(?:\.\d+)?$/.test(p) ? Number(p) : NaN;
}
