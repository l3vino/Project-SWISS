/* session.js — where you were when you closed the tab.
 *
 * Only the camera lives here. Preferences belong to settings; this is the one
 * piece of state that is a place rather than a choice, and it is written often
 * enough to need throttling.
 */

const KEY = 'swissgpu.session.v1';
const WRITE_EVERY_MS = 2000;

export class Session {
  constructor() {
    this.data = {};
    this.lastWrite = 0;
    this.dirty = null;
    try { this.data = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }

    // The tab can vanish without a beat; flush whatever is outstanding.
    addEventListener('pagehide', () => this.flush());
    addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); });
  }

  /** A saved camera is only usable if some adapter still covers it. */
  camera(registry) {
    const c = this.data.camera;
    if (!c || !Number.isFinite(c.lon) || !Number.isFinite(c.lat)) return null;
    return registry.forPoint(c.lon, c.lat) ? c : null;
  }

  record(camera) {
    this.dirty = camera;
    const now = performance.now();
    if (now - this.lastWrite < WRITE_EVERY_MS) return;
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    this.data.camera = this.dirty;
    this.dirty = null;
    this.lastWrite = performance.now();
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }
}
