/* views.js — views as links, and the camera at a command (Stage 5.18e).
 *
 * His words on 5.18d: "make it so you can really easily command you position and camera for checking". The address
 * bar keeps the view as a link (core/view-link.js), written once the camera has stopped, so a reload, a bookmark or
 * a link sent comes back to it; a link opened, or pasted into the address bar, goes there; the key for it (L) copies
 * one. And for the checks in a browser driven from outside (main.js's swissgpu handle in the console): go to a view,
 * a link, coordinates or a height over the ground; look a way; read the view; wait until nothing is loading.
 */

import { formatView, parseView } from '../core/view-link.js';

const DEG = Math.PI / 180;
/* Stats (twice a second) in a row with the same view: the camera has stopped, and the address bar is given it. */
const STILL = 2;
/* Stats in a row with nothing loading and nothing arriving: the view is as it will stay (settled). */
const QUIET = 3;
/* A view placed before what is round it loaded (a tunnel's tube: until it is known, the ground over it holds the camera
 * up): placed again once it has, if the camera stands more than PUSHED metres off it but within ASIDE metres of it
 * across (pushed up or down, not walked away). */
const PUSHED = 0.3, ASIDE = 1;
const M_LAT = 111132;

export class Views {
  /**
   * @param render  the render thread (core/rpc.js)
   * @param toast   ui/hud.js Toast
   */
  constructor(render, { toast }) {
    this.render = render;
    this.toast = toast;
    this.last = '';            // the view in the last stats
    this.still = 0;            // stats in a row it was
    this.waiters = new Set();  // settled() calls waiting
    addEventListener('hashchange', () => {
      const view = parseView(location.hash);
      if (view) this.go(view).catch(() => {});
    });
  }

  /** The camera to start with from the page's address (a view link with its height), or null. */
  static startFrom(registry) {
    const view = parseView(location.hash);
    if (!view || view.height === undefined || !registry.forPoint(view.lon, view.lat)) return null;
    return { lon: view.lon, lat: view.lat, height: view.height, yaw: view.yaw ?? 0, pitch: view.pitch ?? -0.28, mode: view.mode };
  }

  /** Every stats message: the address bar once the camera has stopped, and the settled() calls waiting. */
  onStats(stats) {
    if (stats.camera) {
      const link = formatView(stats.camera);
      this.still = link === this.last ? this.still + 1 : 0;
      this.last = link;
      if (this.still === STILL - 1 && location.hash !== `#${link}`) {
        try { history.replaceState(history.state, '', `${location.pathname}${location.search}#${link}`); } catch { /* throttled */ }
      }
    }
    if (!this.waiters.size) return;
    const busy = loadingOf(stats), quiet = !Object.values(busy).some((n) => n > 0);
    for (const w of this.waiters) {
      w.quiet = quiet ? w.quiet + 1 : 0;
      w.busy = { ...busy, tunnelsWhy: stats.tunnels?.busyWhy ?? null };
      if (w.quiet >= QUIET) w.done(true);
    }
  }

  /** The link to where the camera is now, on the clipboard (the key for it: L). */
  async copy() {
    const { camera } = await this.render.request('view', null, undefined, { timeout: 2000 });
    const url = `${location.origin}${location.pathname}#${formatView(camera)}`;
    try {
      await navigator.clipboard.writeText(url);
      this.toast.show('Link to this view copied: opening it comes back here, looking the same way.', 4000);
    } catch {
      this.toast.show(`Copying was refused here; the link is ${url}`, 12000);
    }
    return url;
  }

  /**
   * The view now: { lat, lon, height, above (metres over the ground, null unknown), heading, tilt (degrees), mode, link }.
   */
  async view() {
    const { camera, aboveGround } = await this.render.request('view', null, undefined, { timeout: 2000 });
    const link = formatView(camera);
    const v = parseView(link);
    return { lat: camera.lat, lon: camera.lon, height: camera.height, above: aboveGround ?? null,
      heading: Math.round((((v.yaw / DEG) + 360) % 360) * 10) / 10, tilt: Math.round((90 + v.pitch / DEG) * 10) / 10, mode: camera.mode,
      link: `${location.origin}${location.pathname}#${link}` };
  }

  /**
   * Goes to a view and (unless settle is false) waits until it has loaded; answers the view then.
   * @param where  a link (the whole address or its part after '#'), "lat, lon", or { lat, lon, height (metres) or
   *               above (metres over the ground there), heading, tilt (degrees, as in links: 90 the horizon), walk }
   *               (heading and tilt the current ones where not given; without a height or above, flown to as a place
   *               found, arriving at once)
   */
  async go(where, { settle = true, timeout = 60000 } = {}) {
    const view = typeof where === 'string' ? parseView(where) : fromObject(where);
    if (!view) throw new Error(`not a view, a link or coordinates: ${JSON.stringify(where)}`);
    const turn = { yaw: view.yaw, pitch: view.pitch, mode: view.mode };
    if (view.height !== undefined) {
      this.#place(view.lon, view.lat, view.height, turn);
      if (settle) {
        await this.settled({ timeout });
        const { camera: c } = await this.render.request('view', null, undefined, { timeout: 2000 });
        const across = Math.hypot((c.lon - view.lon) * M_LAT * Math.cos((view.lat * Math.PI) / 180), (c.lat - view.lat) * M_LAT);
        if (across <= ASIDE && Math.abs(c.height - view.height) > PUSHED) this.#place(view.lon, view.lat, view.height, turn);
      }
    } else if (view.above !== undefined) {
      // Stood there first (render.js spawn: the tiles under it asked for at once, settled onto the ground once it is
      // known; a guess over ground not loaded can be a mountain top away), then as high over it as asked.
      this.render.send('spawn', { lon: view.lon, lat: view.lat, label: `${view.lat.toFixed(5)}, ${view.lon.toFixed(5)}` });
      if (settle) {
        await this.settled({ timeout });
        const [exact] = await this.render.request('ground', { points: [[view.lon, view.lat]] }, undefined, { timeout: 2000 });
        const { camera: c, aboveGround } = await this.render.request('view', null, undefined, { timeout: 2000 });
        const ground = Number.isFinite(exact) ? exact : c.height - (aboveGround ?? 0);
        this.#place(view.lon, view.lat, ground + view.above, turn);
      }
    } else {
      this.render.send('flyto', { lon: view.lon, lat: view.lat, elevation: null, label: `${view.lat.toFixed(5)}, ${view.lon.toFixed(5)}`, instant: true });
    }
    if (!settle) return null;
    const s = await this.settled({ timeout });
    return { ...(await this.view()), settled: s.settled, ms: s.ms };
  }

  /** Turns the camera where it is (degrees as in links; one not given stays). */
  look(heading, tilt) {
    const yaw = Number.isFinite(heading) ? ((((heading % 360) + 540) % 360) - 180) * DEG : undefined;
    const pitch = Number.isFinite(tilt) ? Math.max(-89, Math.min(89, tilt - 90)) * DEG : undefined;
    this.render.send('turn', { yaw, pitch });
  }

  /**
   * Waits until nothing is loading (terrain, photos, roads, buildings, the tunnels' and railways' work) and nothing is
   * arriving, for QUIET stats in a row; answers { settled, ms, busy } (settled false after `timeout`, with what was
   * still loading then).
   */
  settled({ timeout = 60000 } = {}) {
    const start = performance.now();
    return new Promise((resolve) => {
      const w = { quiet: 0, busy: null, done: null };
      const timer = setTimeout(() => w.done(false), timeout);
      w.done = (settled) => {
        clearTimeout(timer);
        this.waiters.delete(w);
        resolve({ settled, ms: Math.round(performance.now() - start), busy: w.busy });
      };
      this.waiters.add(w);
    });
  }

  /* The camera there at once (a walker settles onto the ground as it loads). */
  #place(lon, lat, height, { yaw, pitch, mode }) {
    this.render.send('camera', { state: { lon, lat, height, yaw, pitch, mode: mode ?? 'fly' }, arrive: true });
  }
}

/* What is still loading or moving, from the render thread's stats (each 0 when nothing). */
function loadingOf(stats) {
  const m = stats.motion;
  return {
    terrain: stats.terrain?.pending ?? 0,
    imagery: stats.imagery?.loading ?? 0,
    roads: stats.vector?.loading ?? 0,
    buildings: stats.buildings?.pending ?? 0,
    tunnels: stats.tunnels?.busy ?? 0,
    moving: m && (m.flight != null || m.state === 'waiting for ground' || m.state === 'arriving' || m.state === 'falling') ? 1 : 0,
  };
}

/* A view from go()'s object form, or null. */
function fromObject(o) {
  if (!o || typeof o !== 'object') return null;
  const view = parseView(`${o.lat}, ${o.lon}`);
  if (!view) return null;
  if (Number.isFinite(o.height)) view.height = o.height;
  else if (Number.isFinite(o.above)) view.above = o.above;
  if (Number.isFinite(o.heading)) view.yaw = ((((o.heading % 360) + 540) % 360) - 180) * DEG;
  if (Number.isFinite(o.tilt)) view.pitch = Math.max(-89, Math.min(89, o.tilt - 90)) * DEG;
  if (o.walk === true) view.mode = 'walk';
  return view;
}
