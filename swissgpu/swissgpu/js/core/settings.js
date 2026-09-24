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
      { id: 'terrainDetail', label: 'Terrain detail', type: 'select', default: 2,
        options: [[1, 'Ultra'], [2, 'High'], [4, 'Medium'], [8, 'Low']],
        hint: 'A terrain tile splits into finer ones while its error on screen exceeds 1, 2, 4 or 8 pixels. Each step down roughly halves the triangles drawn.' },
      { id: 'terrainMemory', label: 'Terrain memory', type: 'select', default: 256,
        options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
        hint: 'Video memory kept for terrain tiles. The ones out of sight longest are dropped first.' },
      { id: 'imageryDetail', label: 'Imagery detail', type: 'select', default: 16,
        options: [[8, 'Low'], [12, 'Medium'], [16, 'High']],
        hint: 'How far around you imagery stays sharp. About 22, 50 or 88 MB of video memory with block compression.' },
      { id: 'debugMode', label: 'Terrain view', type: 'select', default: 0,
        options: [[0, 'Shaded'], [1, 'Normals'], [2, 'Height'], [3, 'Tile grid'], [4, 'Imagery levels'], [5, 'Terrain levels']] },
    ],
  },
  {
    id: 'physics', label: 'Physics', items: [
      { id: 'characterHeight', label: 'Character height', type: 'slider',
        default: 1.75, min: 1.0, max: 2.2, step: 0.01, format: (v) => `${v.toFixed(2)} m`,
        hint: 'Your eyes sit at 94% of it while walking.' },
      { id: 'walkSpeed', label: 'Walking speed', type: 'slider',
        default: 1.4, min: 0.5, max: 3, step: 0.1, format: (v) => `${v.toFixed(1)} m/s` },
      { id: 'runSpeed', label: 'Running speed', type: 'slider',
        default: 4.5, min: 2, max: 10, step: 0.1, format: (v) => `${v.toFixed(1)} m/s`,
        hint: 'Ctrl with a movement key.' },
      { id: 'jumpHeight', label: 'Jump height', type: 'slider',
        default: 0.45, min: 0.1, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)} cm` },
      { id: 'gravity', label: 'Gravity', type: 'slider',
        default: 9.81, min: 1.6, max: 25, step: 0.01, format: (v) => `${v.toFixed(2)} m/s²`,
        hint: 'Earth is 9.81, the Moon 1.62.' },
      { id: 'maxSlope', label: 'Steepest walkable slope', type: 'slider',
        default: 45, min: 20, max: 70, step: 1, format: (v) => `${v}°`,
        hint: 'Steeper ground stops you going up it and slides you down it.' },
    ],
  },
  {
    id: 'controls', label: 'Controls', items: [
      { id: 'lookSensitivity', label: 'Mouse sensitivity', type: 'slider',
        default: 2.2, min: 0.4, max: 8, step: 0.1, format: (v) => v.toFixed(1) },
      { id: 'invertY', label: 'Invert vertical look', type: 'toggle', default: false },
      { id: 'doubleTapMs', label: 'Double-tap Space window', type: 'slider',
        default: 300, min: 150, max: 500, step: 10, format: (v) => `${v} ms`,
        hint: 'Two presses of Space inside this switch between walking and flying.' },
      { id: 'captureKeys', label: 'Capture browser shortcuts', type: 'toggle', default: true,
        hint: 'Goes fullscreen while flying so Ctrl+W and Ctrl+T reach the app instead of the browser. Escape releases everything.' },
      { id: 'flySpeed', label: 'Flight speed', type: 'slider',
        default: 120, min: 10, max: 5000, step: 10, format: (v) => `${v} m/s`,
        hint: 'The scroll wheel changes this too, and the wheel wins.' },
    ],
  },
  {
    id: 'layers', label: 'Layers', items: [
      { id: 'buildings', label: 'Buildings', type: 'toggle', default: true,
        hint: 'Every building in the national 3D building model, roofs coloured from the aerial photos.' },
      { id: 'buildingDetail', label: 'Building detail', type: 'select', default: 10,
        options: [[6, 'Ultra'], [10, 'High'], [16, 'Medium'], [24, 'Low']],
        hint: 'How far out buildings keep their full detail. High matches swisstopo\'s own viewer.' },
      { id: 'buildingMemory', label: 'Building memory', type: 'select', default: 256,
        options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
        hint: 'Video memory kept for building tiles. The ones out of sight longest are dropped first.' },
    ],
  },
  {
    id: 'world', label: 'World', items: [
      { id: 'spawn', label: 'Start at', type: 'select', default: 'last',
        options: [['last', 'Last position'], ['home', 'Fixed home']] },
      { id: 'home', label: 'Home', type: 'readout', default: null,
        format: (v) => (v ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}` : 'not set') },
      { id: 'setHome', label: 'Set home to current view', type: 'button' },
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
