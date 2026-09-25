/* settings.js — one schema drives the menu, the storage and the engine.
 *
 * Adding a setting means adding one entry below. The settings menu builds
 * itself from this (a tab per entry of TABS, a section per heading), values
 * persist automatically, and anything that cares subscribes by id.
 *
 * Distances are in kilometres, speeds in metres a second, heights in metres,
 * as the controls show them. Key bindings are one setting holding every
 * action's keys, edited on the Controls tab.
 */

const STORAGE_KEY = 'swissgpu.settings.v2';

/* What the keys do. Movement actions are held; the rest act on a press.
 * Each action takes up to two keys, as KeyboardEvent.code values, which name
 * physical keys and so work on any keyboard layout. */
export const ACTIONS = [
  { id: 'forward', label: 'Move forward', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', label: 'Move back', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', label: 'Move left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'Move right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'up', label: 'Jump · fly up', keys: ['Space'], hint: 'Tap twice to switch between walking and flying.' },
  { id: 'down', label: 'Fly down', keys: ['ShiftLeft'] },
  { id: 'sprint', label: 'Run · fly faster', keys: ['ControlLeft'] },
  { id: 'toggleMode', label: 'Switch walking and flying', keys: ['KeyF'] },
  { id: 'menu', label: 'Open settings', keys: ['KeyO'] },
  { id: 'readout', label: 'Show or hide the readout', keys: ['F3'] },
];

export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]]));

const km = (digits) => (v) => `${Number(v).toFixed(digits)} km`;

/*
 * The menu's tabs, each a list of sections, each a list of settings.
 *   toggle   on or off
 *   slider   a number, `format` shows it with its unit
 *   choice   a few named options side by side; `select` for longer lists
 *   readout  shows a value something else owns
 *   button   runs an action
 *   keybinds the key table
 */
export const TABS = [
  {
    id: 'general', label: 'General', icon: 'general', sections: [
      { title: 'Interface', items: [
        { id: 'showTelemetry', label: 'Instrument readout', type: 'toggle', default: true,
          hint: 'Position, speed, streaming and frame timing, bottom left.' },
        { id: 'units', label: 'Units', type: 'choice', default: 'metric',
          options: [['metric', 'Metric'], ['imperial', 'Imperial']],
          hint: 'For the readout: metres and km/h, or feet and mph.' },
        { id: 'flyToResults', label: 'Fly to search results', type: 'toggle', default: true,
          hint: 'Picking a place flies you there and sets you down on the ground. Off: you are there at once.' },
      ] },
    ],
  },
  {
    id: 'graphics', label: 'Graphics', icon: 'graphics', sections: [
      { title: 'Display', items: [
        { id: 'renderScale', label: 'Render scale', type: 'slider',
          default: 1, min: 0.5, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
          hint: 'Renders below or above the screen\'s resolution. The single biggest lever on frame time.' },
        { id: 'fpsCap', label: 'Frame rate limit', type: 'choice', default: 0,
          options: [[0, 'Display'], [30, '30'], [60, '60'], [120, '120']] },
      ] },
      { title: 'Distance and detail', items: [
        { id: 'viewDistanceKm', label: 'View distance', type: 'slider',
          default: 400, min: 10, max: 400, step: 10, format: (v) => (v >= 400 ? 'Horizon' : `${v} km`),
          hint: 'Nothing farther is drawn or downloaded, and the haze thickens to meet it. All the way right draws to the horizon.' },
        { id: 'terrainDetailKm', label: 'Full terrain detail', type: 'slider',
          default: 0.15, min: 0.05, max: 1, step: 0.05, format: km(2),
          hint: 'How far out the finest ground (30 cm) is kept; each coarser level reaches twice as far. Doubling it roughly quadruples the terrain drawn.' },
      ] },
      { title: 'Aerial photos', items: [
        { id: 'imageryQuality', label: 'Photo quality', type: 'choice', default: 'high',
          options: [['high', 'High'], ['standard', 'Standard']],
          hint: 'High keeps sixteen shades in every 4×4 pixels and shows no grain; Standard keeps four and uses half the video memory.' },
        { id: 'imagerySharpness', label: 'Photo sharpness', type: 'choice', default: 0.35,
          options: [[0, 'Sharp'], [0.35, 'Balanced'], [0.7, 'Soft']],
          hint: 'Sharp shows every pixel the screen can; Balanced and Soft calm distant forests and fields.' },
        { id: 'imageryDetail', label: 'Sharp photo radius', type: 'choice', default: 16,
          options: [[8, '0.1 km'], [12, '0.16 km'], [16, '0.21 km'], [24, '0.32 km']],
          hint: 'How far around you the 10 cm photos are kept before coarser ones take over. Video memory grows with its square.' },
      ] },
      { title: 'Memory', items: [
        { id: 'terrainMemory', label: 'Terrain memory', type: 'choice', default: 256,
          options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
          hint: 'Video memory kept for terrain tiles. The ones out of sight longest are dropped first.' },
      ] },
      { title: 'Diagnostics', items: [
        { id: 'gpuTiming', label: 'Measure GPU time', type: 'toggle', default: true,
          hint: 'Timestamp queries around each pass, shown in the readout.' },
        { id: 'debugMode', label: 'Terrain view', type: 'select', default: 0,
          options: [[0, 'Shaded'], [1, 'Normals'], [2, 'Height'], [3, 'Tile grid'], [4, 'Imagery levels'], [5, 'Terrain levels']] },
      ] },
    ],
  },
  {
    id: 'layers', label: 'Layers', icon: 'layers', sections: [
      { title: 'On the map', items: [
        { id: 'buildings', label: 'Buildings', type: 'toggle', default: true,
          hint: 'Every building in the national 3D building model.' },
        { id: 'structures', label: 'Bridges and structures', type: 'toggle', default: true,
          hint: 'Bridges, cable cars and other structures from the national landscape model.' },
      ] },
      { title: 'Buildings', items: [
        { id: 'buildingDistanceKm', label: 'Building distance', type: 'slider',
          default: 15, min: 1, max: 50, step: 1, format: km(0),
          hint: 'How far out buildings and bridges are drawn at all.' },
        { id: 'buildingDetailKm', label: 'Full building detail', type: 'slider',
          default: 0.5, min: 0.1, max: 2, step: 0.05, format: km(2),
          hint: 'How far out buildings keep their full shape; farther ones use simpler versions. 0.5 km matches swisstopo\'s own viewer.' },
        { id: 'buildingMemory', label: 'Building memory', type: 'choice', default: 256,
          options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
          hint: 'Kept for building and bridge tiles, including what collision uses.' },
      ] },
    ],
  },
  {
    id: 'character', label: 'Character', icon: 'character', sections: [
      { title: 'Body', items: [
        { id: 'characterHeight', label: 'Height', type: 'slider',
          default: 1.75, min: 1.0, max: 2.2, step: 0.01, format: (v) => `${v.toFixed(2)} m`,
          hint: 'Your eyes sit at 94% of it.' },
      ] },
      { title: 'On foot', items: [
        { id: 'walkSpeed', label: 'Walking speed', type: 'slider',
          default: 1.4, min: 0.5, max: 3, step: 0.1, format: (v) => `${v.toFixed(1)} m/s`,
          hint: '1.4 m/s is an ordinary walk, 5 km/h.' },
        { id: 'runSpeed', label: 'Running speed', type: 'slider',
          default: 4.5, min: 2, max: 10, step: 0.1, format: (v) => `${v.toFixed(1)} m/s`,
          hint: 'Hold Run with a movement key.' },
        { id: 'jumpHeight', label: 'Jump height', type: 'slider',
          default: 0.45, min: 0.1, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)} cm` },
      ] },
      { title: 'In the air', items: [
        { id: 'flySpeed', label: 'Flight speed', type: 'slider',
          default: 120, min: 10, max: 5000, step: 10, format: (v) => `${v} m/s`,
          hint: 'The scroll wheel changes it too while flying.' },
      ] },
    ],
  },
  {
    id: 'physics', label: 'Physics', icon: 'physics', sections: [
      { title: 'World', items: [
        { id: 'gravity', label: 'Gravity', type: 'slider',
          default: 9.81, min: 1.6, max: 25, step: 0.01, format: (v) => `${v.toFixed(2)} m/s²`,
          hint: 'Earth is 9.81, the Moon 1.62.' },
        { id: 'maxSlope', label: 'Steepest walkable slope', type: 'slider',
          default: 45, min: 20, max: 70, step: 1, format: (v) => `${v}°`,
          hint: 'Steeper ground stops you going up it and slides you down it. Steeper roofs count as walls.' },
      ] },
      { title: 'Collisions', items: [
        { id: 'flyThrough', label: 'Fly through buildings', type: 'toggle', default: false,
          hint: 'Off: buildings and bridges are solid while flying, like the ground. Walking always collides.' },
      ] },
    ],
  },
  {
    id: 'controls', label: 'Controls', icon: 'controls', sections: [
      { title: 'Mouse', items: [
        { id: 'lookSensitivity', label: 'Sensitivity', type: 'slider',
          default: 2.2, min: 0.4, max: 8, step: 0.1, format: (v) => v.toFixed(1) },
        { id: 'invertY', label: 'Invert vertical look', type: 'toggle', default: false },
      ] },
      { title: 'Keyboard', items: [
        { id: 'doubleTapMs', label: 'Double-tap window', type: 'slider',
          default: 300, min: 150, max: 500, step: 10, format: (v) => `${v} ms`,
          hint: 'Two presses of Jump inside this switch between walking and flying.' },
        { id: 'captureKeys', label: 'Capture browser shortcuts', type: 'toggle', default: true,
          hint: 'Goes fullscreen while you play, so Ctrl+W and the like reach the app instead of closing the tab. Esc releases everything.' },
      ] },
      { title: 'Keys', items: [
        { id: 'keybinds', label: 'Keys', type: 'keybinds', default: DEFAULT_BINDINGS },
      ] },
    ],
  },
  {
    id: 'world', label: 'World', icon: 'world', sections: [
      { title: 'Starting point', items: [
        { id: 'spawn', label: 'Start at', type: 'choice', default: 'last',
          options: [['last', 'Last position'], ['home', 'Home']] },
        { id: 'home', label: 'Home', type: 'readout', default: null,
          format: (v) => (v ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}` : 'not set') },
        { id: 'setHome', label: 'Make where I am home', type: 'button' },
      ] },
    ],
  },
];

/** Every setting, whichever tab it is on. */
export const ITEMS = TABS.flatMap((tab) => tab.sections.flatMap((s) => s.items));

export class Settings {
  constructor() {
    this.values = {};
    this.defaults = {};
    this.listeners = new Map();
    this.actions = new Map();
    for (const item of ITEMS) {
      if (item.type === 'button') continue;
      this.values[item.id] = item.default;
      this.defaults[item.id] = item.default;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      for (const k of Object.keys(this.values)) if (k in saved) this.values[k] = saved[k];
    } catch { /* corrupt or unavailable storage falls back to defaults */ }
    // Actions added since the bindings were saved get their default keys.
    this.values.keybinds = { ...DEFAULT_BINDINGS, ...(this.values.keybinds || {}) };
    this.persistTimer = 0;
  }

  get(id) { return this.values[id]; }

  isDefault(id) { return JSON.stringify(this.values[id]) === JSON.stringify(this.defaults[id]); }

  reset(id) { if (id in this.defaults) this.set(id, structuredClone(this.defaults[id])); }

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

  /* Dragging a slider sets a value many times a second; storage only needs
   * the last one. */
  #persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* private mode */ }
    }, 250);
  }
}
