/* settings.js — one schema drives the panel, the storage and the engine.
 *
 * Adding a setting means adding one entry below. The panel builds itself from
 * this, values persist automatically, and anything that cares subscribes by id.
 * `live: false` marks a control that is declared but has no effect yet, so the
 * UI can say so instead of pretending.
 */

const STORAGE_KEY = 'swissgpu.settings.v2';

export const SCHEMA = [
  {
    id: 'general', label: 'General', items: [
      { id: 'showTelemetry', label: 'Instrument readout', type: 'toggle', default: true },
      { id: 'units', label: 'Units', type: 'select', default: 'metric',
        options: [['metric', 'Metres'], ['imperial', 'Feet']] },
    ],
  },
  {
    id: 'graphics', label: 'Graphics', items: [
      { id: 'renderScale', label: 'Render scale', type: 'slider',
        default: 1, min: 0.5, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
        hint: 'Renders below or above display resolution. The heaviest single lever on frame time.' },
      { id: 'fpsCap', label: 'Frame rate limit', type: 'select', default: 0,
        options: [[0, 'Display refresh'], [30, '30'], [60, '60'], [120, '120']] },
      { id: 'gpuTiming', label: 'Measure GPU time', type: 'toggle', default: true,
        hint: 'Timestamp queries around each pass. Needs the timestamp-query feature.' },
      { id: 'debugMode', label: 'Terrain view', type: 'select', default: 0,
        options: [[0, 'Shaded'], [1, 'Normals'], [2, 'Height'], [3, 'Tile grid']] },
    ],
  },
  { id: 'physics', label: 'Physics', items: [], comingIn: 'step 4, with walking and collision' },
  {
    id: 'controls', label: 'Controls', items: [
      { id: 'lookSensitivity', label: 'Mouse sensitivity', type: 'slider',
        default: 2.2, min: 0.4, max: 8, step: 0.1, format: (v) => v.toFixed(1) },
      { id: 'invertY', label: 'Invert vertical look', type: 'toggle', default: false },
      { id: 'captureKeys', label: 'Capture browser shortcuts', type: 'toggle', default: true,
        hint: 'Goes fullscreen while flying so Ctrl+W and Ctrl+T reach the app instead of the browser. Escape releases everything.' },
      { id: 'flySpeed', label: 'Flight speed', type: 'slider',
        default: 120, min: 10, max: 5000, step: 10, format: (v) => `${v} m/s`,
        hint: 'The scroll wheel changes this too, and the wheel wins.' },
    ],
  },
  { id: 'layers', label: 'Layers', items: [], comingIn: 'step 6, with buildings and terrain features' },
  {
    id: 'world', label: 'World', items: [
      { id: 'spawn', label: 'Start at', type: 'select', default: 'last',
        options: [['last', 'Last position'], ['home', 'Fixed home']] },
      { id: 'home', label: 'Home', type: 'readout', default: null,
        format: (v) => (v ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}` : 'not set') },
      { id: 'setHome', label: 'Set home to current view', type: 'button' },
      { id: 'terrainLevel', label: 'Terrain detail level', type: 'slider',
        default: 11, min: 8, max: 13, step: 1, format: (v) => `z${v}`,
        hint: 'Each level halves the tile size and quadruples the tile count. Fixed for now; step 1b chooses it per tile.' },
      { id: 'loadRadius', label: 'Load radius', type: 'slider',
        default: 6, min: 2, max: 12, step: 1, format: (v) => `${v} tiles` },
    ],
  },
];

export class Settings {
  constructor() {
    this.values = {};
    this.listeners = new Map();
    this.actions = new Map();
    for (const group of SCHEMA) {
      for (const item of group.items) {
        if (item.type !== 'button') this.values[item.id] = item.default;
      }
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const k of Object.keys(this.values)) if (k in saved) this.values[k] = saved[k];
    } catch { /* corrupt or unavailable storage falls back to defaults */ }
  }

  get(id) { return this.values[id]; }

  /** Buttons carry no value; they notify whoever is listening. */
  onAction(id, fn) {
    if (!this.actions.has(id)) this.actions.set(id, new Set());
    this.actions.get(id).add(fn);
    return () => this.actions.get(id).delete(fn);
  }

  trigger(id) { for (const fn of this.actions.get(id) || []) fn(); }

  set(id, value) {
    if (this.values[id] === value) return;
    this.values[id] = value;
    this.#persist();
    for (const fn of this.listeners.get(id) || []) fn(value, id);
    for (const fn of this.listeners.get('*') || []) fn(value, id);
  }

  on(id, fn) {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id).add(fn);
    return () => this.listeners.get(id).delete(fn);
  }

  snapshot() { return { ...this.values }; }

  #persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
  }
}
