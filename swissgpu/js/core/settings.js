/* settings.js — one schema drives the menu, the storage and the engine.
 *
 * Adding a setting means adding one entry below. The settings menu builds
 * itself from this (a tab per entry of TABS, a page per entry of its pages,
 * a section per heading), values persist automatically, and anything that
 * cares subscribes by id.
 *
 * Distances are in kilometres, speeds in metres a second, heights in metres,
 * as the controls show them. Key bindings are one setting holding every
 * action's keys, edited on the Controls tab.
 */

const STORAGE_KEY = 'swissgpu.settings.v2';
const REVISIONS = '_revisions';   // under the key: each changed setting's revision when saved

/* What the keys do. Movement actions are held; the rest act on a press.
 * Each action takes up to two keys, as KeyboardEvent.code values, which name
 * physical keys and so work on any keyboard layout. */
export const ACTIONS = [
  { id: 'forward', label: 'Move forward', keys: ['KeyW', 'ArrowUp'] },
  { id: 'back', label: 'Move back', keys: ['KeyS', 'ArrowDown'] },
  { id: 'left', label: 'Move left', keys: ['KeyA', 'ArrowLeft'] },
  { id: 'right', label: 'Move right', keys: ['KeyD', 'ArrowRight'] },
  { id: 'up', label: 'Jump · fly up', keys: ['Space'], hint: 'Tap twice to switch between walking and flying.' },
  { id: 'down', label: 'Sneak · fly down · speed brake', keys: ['ShiftLeft'],
    hint: 'Walking, held: slower and lower, and you never step off an edge higher than a step (as in Minecraft).' },
  { id: 'sprint', label: 'Run · fly faster', keys: ['ControlLeft'], hint: 'Walking: with Move forward.' },
  { id: 'toggleMode', label: 'Switch walking and flying', keys: ['KeyF'] },
  { id: 'airplane', label: 'Airplane on · off', keys: ['KeyP'],
    hint: 'In the airplane: W and S pitch, A and D roll, the scroll wheel sets the speed or the throttle (Vehicles → Airplane), Left Shift brakes, and switching to walking bails out.' },
  { id: 'pointer', label: 'Free the mouse · take it back', keys: ['KeyE'],
    hint: 'Frees the mouse for the search and the menus without leaving fullscreen. Press again, or click the view, to look around again.' },
  { id: 'menu', label: 'Open settings', keys: ['KeyO'] },
  { id: 'readout', label: 'Show or hide the readout', keys: ['F3'] },
  { id: 'perf', label: 'Show or hide performance', keys: ['F2'] },
];

export const DEFAULT_BINDINGS = Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]]));

const km = (digits) => (v) => `${Number(v).toFixed(digits)} km`;

/*
 * The menu's tabs, each a list of pages (the second column, Stage 5.10b:
 * his words: "in settings, inbgraphics, veichles and others, there should be
 * a sub-sidebar (example: veichles: airplane, train, car, ecc...). each one
 * with maybe presets, and an extendable advanced settings / custom
 * section"), each page a list of sections of settings, then, folded until
 * opened, its `advanced` ones. A page may have `presets`: named sets of
 * values for some of its settings (`values`); the menu shows which one the
 * settings match, or Custom.
 *   toggle   on or off
 *   slider   a number, `format` shows it with its unit
 *   choice   a few named options side by side; `select` for longer lists
 *   readout  shows a value something else owns
 *   button   runs an action
 *   keybinds the key table
 */

/* Graphics → Quality. High is what every value was before presets. */
const QUALITY = [
  { id: 'low', label: 'Low', values: { renderScale: 0.6, viewDistanceKm: 40, terrainDetailKm: 0.1, imageryQuality: 'standard', imageryDetail: 12,
    imagerySharpness: 0.35, terrainMemory: 128, buildingDistanceKm: 5, buildingDetailKm: 0.3, buildingMemory: 128,
    roadDistanceKm: 1.5, roadDetailKm: 0.5, roadMemory: 32 } },
  { id: 'medium', label: 'Medium', values: { renderScale: 0.8, viewDistanceKm: 100, terrainDetailKm: 0.15, imageryQuality: 'high', imageryDetail: 16,
    imagerySharpness: 0.35, terrainMemory: 256, buildingDistanceKm: 10, buildingDetailKm: 0.5, buildingMemory: 256,
    roadDistanceKm: 2, roadDetailKm: 0.8, roadMemory: 64 } },
  { id: 'high', label: 'High', values: { renderScale: 1, viewDistanceKm: 400, terrainDetailKm: 0.15, imageryQuality: 'high', imageryDetail: 16,
    imagerySharpness: 0.35, terrainMemory: 256, buildingDistanceKm: 15, buildingDetailKm: 0.5, buildingMemory: 256,
    roadDistanceKm: 3, roadDetailKm: 1, roadMemory: 64 } },
  { id: 'ultra', label: 'Ultra', values: { renderScale: 1, viewDistanceKm: 400, terrainDetailKm: 0.3, imageryQuality: 'high', imageryDetail: 24,
    imagerySharpness: 0.35, terrainMemory: 512, buildingDistanceKm: 25, buildingDetailKm: 1, buildingMemory: 512,
    roadDistanceKm: 5, roadDetailKm: 1.5, roadMemory: 128 } },
];

/* Vehicles → Airplane. Easy is how it flies unless he changes it (his
 * answers: the wings level themselves, just a pointer; 5.11b: the view along
 * the flight path and a stronger wing, his words: "make pitch faster";
 * 5.13b: the F-16's own engine, so the air's drag shows, his words: "the
 * airplane does not seem to consider air resistance", and the wheel setting
 * the speed asked); Realistic is the F-16 as built, seen from its cockpit,
 * the wheel on the throttle, with the whole head-up display. */
const PLANE_SHOWN = { planeLadder: true, planeMarker: true, planeSpeed: true, planeAltitude: true, planeHeading: true, planeThrottle: true, planeWarnings: true };
const PLANE_HIDDEN = Object.fromEntries(Object.keys(PLANE_SHOWN).map((k) => [k, false]));
const AIRPLANE = [
  { id: 'easy', label: 'Easy', values: { planeLevel: true, planeView: 'path', planeWing: 'strong', planeRollRate: 90, planeRollBuild: 0.8,
    planeScroll: 'speed', planeEngine: 'built', planePointer: true, ...PLANE_HIDDEN } },
  { id: 'realistic', label: 'Realistic', values: { planeLevel: false, planeView: 'nose', planeWing: 'built', planeRollRate: 180, planeRollBuild: 0.2,
    planeScroll: 'throttle', planeEngine: 'built', planePointer: true, ...PLANE_SHOWN } },
];

export const TABS = [
  {
    id: 'general', label: 'General', icon: 'general', pages: [
      { id: 'interface', title: 'Interface', sections: [{ items: [
        { id: 'showTelemetry', label: 'Instrument readout', type: 'toggle', default: true,
          hint: 'Position, speed, streaming and frame timing, bottom left.' },
        { id: 'units', label: 'Units', type: 'choice', default: 'metric',
          options: [['metric', 'Metric'], ['imperial', 'Imperial']],
          hint: 'For the readout: metres and km/h, or feet and mph.' },
        { id: 'pickTakesMouse', label: 'Take the mouse after picking a result', type: 'toggle', default: true,
          hint: 'Picking a place hands the mouse back to the camera, so you can look around at once. Off: the mouse stays free until you click the view or press E.' },
        { id: 'showPerf', label: 'Performance panel', type: 'toggle', default: false,
          hint: 'Frame times, CPU and GPU time per step, memory per layer and the GPU in use, with a report to copy. F2 shows and hides it.' },
      ] }] },
      { id: 'flights', title: 'Search flights', sections: [{ items: [
        { id: 'flyToResults', label: 'Fly to search results', type: 'toggle', default: true,
          hint: 'Picking a place flies you there: up first, then on, the view looking along the way, curving towards the place and back in an S, high enough to clear everything, and down at the end facing the way you were, at the same height above the ground; a place under 300 m away in one arc, your view kept as it is. Walking, you land on the ground outside any building and walk on. Off: you are there at once.' },
        { id: 'flightSpeed', label: 'Flight speed', type: 'slider', revision: 1,
          default: 1, min: 0.25, max: 4, step: 0.25, format: (v) => `${v}×`,
          hint: 'How fast a flight plays, turns and all: 2× takes half the time and turns twice as fast.' },
        { id: 'flightPath', label: 'Show the flight path', type: 'toggle', default: true,
          hint: 'A blue glass line along the way still ahead, with a bead every so often; faint and dashed where mountains or buildings hide it.' },
        { id: 'flightLabel', label: 'Show the destination name', type: 'toggle', default: true,
          hint: 'The place\'s name floats over it while you fly there, over everything, until the way down.' },
      ] }], advanced: [
        { id: 'longestFlight', label: 'Longest flight', type: 'slider', revision: 1,
          default: 30, min: 5, max: 60, step: 1, format: (v) => `${v} s`,
          hint: 'No flight takes longer than this, however far it goes: a longer one is played faster.' },
        { id: 'flightBank', label: 'Bank in turns', type: 'slider', revision: 1,
          default: 15, min: 0, max: 90, step: 5, format: (v) => `${v}°`,
          hint: 'How far the view leans into the flight\'s turns at the sharpest. 0 keeps it level.' },
      ] },
    ],
  },
  {
    id: 'graphics', label: 'Graphics', icon: 'graphics', pages: [
      { id: 'quality', title: 'Quality', presets: QUALITY, sections: [], advanced: [
        { id: 'renderScale', label: 'Render scale', type: 'slider',
          default: 1, min: 0.5, max: 2, step: 0.05, format: (v) => `${Math.round(v * 100)}%`,
          hint: 'Renders below or above the screen\'s resolution. The single biggest lever on frame time.' },
        { id: 'viewDistanceKm', label: 'View distance', type: 'slider',
          default: 400, min: 10, max: 400, step: 10, format: (v) => (v >= 400 ? 'Horizon' : `${v} km`),
          hint: 'Nothing farther is drawn or downloaded, and the haze thickens to meet it. All the way right draws to the horizon.' },
        { id: 'terrainDetailKm', label: 'Full terrain detail', type: 'slider',
          default: 0.15, min: 0.05, max: 1, step: 0.05, format: km(2),
          hint: 'How far out the finest ground (30 cm) is kept; each coarser level reaches twice as far. Doubling it roughly quadruples the terrain drawn.' },
        { id: 'imageryQuality', label: 'Photo quality', type: 'choice', default: 'high',
          options: [['high', 'High'], ['standard', 'Standard']],
          hint: 'High keeps sixteen shades in every 4×4 pixels and shows no grain; Standard keeps four and uses half the video memory.' },
        { id: 'imageryDetail', label: 'Sharp photo radius', type: 'choice', default: 16,
          options: [[8, '0.1 km'], [12, '0.16 km'], [16, '0.21 km'], [24, '0.32 km']],
          hint: 'How far around you the 10 cm photos are kept before coarser ones take over. Video memory grows with its square.' },
        { id: 'imagerySharpness', label: 'Photo sharpness', type: 'choice', default: 0.35,
          options: [[0, 'Sharp'], [0.35, 'Balanced'], [0.7, 'Soft']],
          hint: 'Sharp shows every pixel the screen can; Balanced and Soft calm distant forests and fields.' },
        { id: 'buildingDistanceKm', label: 'Building distance', type: 'slider',
          default: 15, min: 1, max: 50, step: 1, format: km(0),
          hint: 'How far out buildings and bridges are drawn at all.' },
        { id: 'buildingDetailKm', label: 'Full building detail', type: 'slider',
          default: 0.5, min: 0.1, max: 2, step: 0.05, format: km(2),
          hint: 'How far out buildings keep their full shape; farther ones use simpler versions. 0.5 km matches swisstopo\'s own viewer.' },
        { id: 'roadDistanceKm', label: 'Road and rail distance', type: 'slider',
          default: 3, min: 0.5, max: 8, step: 0.5, format: km(1),
          hint: 'How far out roads and railways are drawn from the national map\'s own lines; beyond, the photo shows them. Up where even a wide road is thinner than a pixel and a half, none are loaded at all.' },
        { id: 'roadDetailKm', label: 'Full road detail', type: 'slider',
          default: 1, min: 0.3, max: 2, step: 0.1, format: km(1),
          hint: 'How far out the most precise lines (40 cm) are used, which rails, lane lines and markings need; farther out, lines half as precise cost a quarter of the download.' },
        { id: 'roadWidths', label: 'Exact road widths', type: 'toggle', default: true,
          hint: 'Each road near you (600 m) as wide as the national landscape model has it, asked from swisstopo the first time you come (about 0.5 MB a square kilometre of city, less in the country; kept for next time). Off: every road of a kind as wide as most of them are.' },
        { id: 'roadShaping', label: 'Terrain under roads', type: 'toggle', default: true,
          hint: 'Cuts roads, tracks, paths and railway beds into the ground near you, so one along a hillside lies level across instead of tilted with the slope. As far out as the terrain is finest (about 1.2 km on High); tiles there get about half as many triangles again.' },
        { id: 'terrainMemory', label: 'Terrain memory', type: 'choice', default: 256,
          options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
          hint: 'Video memory kept for terrain tiles. The ones out of sight longest are dropped first; if the view needs more, distant detail is lowered until it fits.' },
        { id: 'buildingMemory', label: 'Building memory', type: 'choice', default: 256,
          options: [[128, '128 MB'], [256, '256 MB'], [512, '512 MB'], [1024, '1 GB']],
          hint: 'Video memory kept for building and bridge tiles; if the view needs more, distant detail is lowered until it fits. Collision copies near you get half as much again.' },
        { id: 'roadMemory', label: 'Road and rail memory', type: 'choice', default: 64,
          options: [[32, '32 MB'], [64, '64 MB'], [128, '128 MB']],
          hint: 'Video memory kept for road and railway tiles; the ones unused longest are dropped first. The middle of Zürich needs about 10 MB at a time.' },
      ] },
      { id: 'display', title: 'Display', sections: [{ items: [
        { id: 'fpsCap', label: 'Frame rate limit', type: 'choice', default: 0,
          options: [[0, 'Display'], [30, '30'], [60, '60'], [120, '120']] },
      ] }] },
      { id: 'loading', title: 'Loading', sections: [{ items: [
        { id: 'decodeThreads', label: 'Decode threads', type: 'select', default: 0,
          options: [[0, 'Auto'], [2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']],
          hint: 'Threads that download and unpack terrain, photos and buildings. Auto takes half your processor\'s threads less one (2 to 8). More fills the view faster after a jump; fewer leaves more for everything else.' },
      ] }] },
      { id: 'diagnostics', title: 'Diagnostics', sections: [{ items: [
        { id: 'gpuTiming', label: 'Measure GPU time', type: 'toggle', default: true,
          hint: 'Timestamp queries around each pass, shown in the readout.' },
        { id: 'debugMode', label: 'Terrain view', type: 'select', default: 0,
          options: [[0, 'Shaded'], [1, 'Normals'], [2, 'Height'], [3, 'Tile grid'], [4, 'Imagery levels'], [5, 'Terrain levels'],
            [6, 'Roads and rails (data)']],
          hint: 'Roads and rails (data): every road, path and track as the national map\'s vector tiles have it, in a colour per kind; bridges bright, tunnels dashed, the tiles outlined.' },
      ] }] },
    ],
  },
  {
    id: 'layers', label: 'Layers', icon: 'layers', pages: [
      { id: 'map', title: 'On the map', sections: [{ items: [
        { id: 'buildings', label: 'Buildings', type: 'toggle', default: true,
          hint: 'Every building in the national 3D building model. How far and how detailed: Graphics → Quality.' },
        { id: 'structures', label: 'Bridges and structures', type: 'toggle', default: true,
          hint: 'Bridges, cable cars and other structures from the national landscape model.' },
        { id: 'layerRoads', label: 'Roads', type: 'toggle', default: true,
          hint: 'Streets, roads and farm tracks drawn on the ground near you, each as wide as the national landscape model says. Farther away, and from high up, the photo shows them.' },
        { id: 'layerPaths', label: 'Paths and trails', type: 'toggle', default: true,
          hint: 'Footpaths, hiking trails and steps drawn on the ground near you.' },
      ] }] },
    ],
  },
  {
    id: 'character', label: 'Character', icon: 'character', pages: [
      { id: 'body', title: 'Body', sections: [{ items: [
        { id: 'characterHeight', label: 'Height', type: 'slider',
          default: 1.75, min: 1.0, max: 2.2, step: 0.01, format: (v) => `${v.toFixed(2)} m`,
          hint: 'Your eyes sit at 94% of it.' },
        { id: 'characterWidth', label: 'Width', type: 'slider',
          default: 0.45, min: 0.25, max: 0.8, step: 0.01, format: (v) => `${v.toFixed(2)} m`,
          hint: 'Across the shoulders. With the height and the depth, how much of you meets the air (falling, or thrown from a flight).' },
        { id: 'characterDepth', label: 'Depth', type: 'slider',
          default: 0.28, min: 0.15, max: 0.6, step: 0.01, format: (v) => `${v.toFixed(2)} m`,
          hint: 'Front to back.' },
        { id: 'characterWeight', label: 'Weight', type: 'slider',
          default: 75, min: 30, max: 150, step: 1, format: (v) => `${v} kg`,
          hint: 'What the air has to slow down: heavier falls faster and keeps a thrown speed longer.' },
      ] }] },
      { id: 'foot', title: 'On foot', sections: [{ items: [
        { id: 'walkSpeed', label: 'Walking speed', type: 'slider',
          default: 1.4, min: 0.5, max: 3, step: 0.1, format: (v) => `${v.toFixed(1)} m/s`,
          hint: '1.4 m/s is an ordinary walk, 5 km/h.' },
        { id: 'runSpeed', label: 'Running speed', type: 'slider',
          default: 4.5, min: 2, max: 10, step: 0.1, format: (v) => `${v.toFixed(1)} m/s`,
          hint: 'Hold Run with a movement key.' },
        { id: 'jumpHeight', label: 'Jump height', type: 'slider',
          default: 0.45, min: 0.1, max: 1.5, step: 0.05, format: (v) => `${Math.round(v * 100)} cm` },
      ] }] },
      { id: 'air', title: 'In the air', sections: [{ items: [
        { id: 'flySpeed', label: 'Flight speed', type: 'slider',
          default: 120, min: 10, max: 5000, step: 10, format: (v) => `${v} m/s`,
          hint: 'The scroll wheel changes it too while flying.' },
      ] }] },
    ],
  },
  {
    id: 'physics', label: 'Physics', icon: 'physics', pages: [
      { id: 'world', title: 'World', sections: [{ items: [
        { id: 'gravity', label: 'Gravity', type: 'slider',
          default: 9.81, min: 1.6, max: 25, step: 0.01, format: (v) => `${v.toFixed(2)} m/s²`,
          hint: 'Earth is 9.81, the Moon 1.62.' },
        { id: 'maxSlope', label: 'Steepest walkable slope', type: 'slider',
          default: 45, min: 20, max: 70, step: 1, format: (v) => `${v}°`,
          hint: 'Steeper ground stops you going up it and slides you down it. Steeper roofs count as walls.' },
      ] }] },
      { id: 'collisions', title: 'Collisions', sections: [{ items: [
        { id: 'flyThrough', label: 'Fly through buildings', type: 'toggle', default: false,
          hint: 'Off: buildings and bridges are solid while flying, like the ground. Walking always collides.' },
      ] }] },
    ],
  },
  {
    // Stage 5.9b (his words: "airplane should have a setting section in the
    // veichles section, where you can check what you want on or not (like
    // realistic wings settings, and ui), default should be just a point as
    // pointer (no atitude thing), but with option to turn that on"); its own
    // page with presets since 5.10b. Trains and cars get their pages when
    // they exist.
    id: 'vehicles', label: 'Vehicles', icon: 'vehicles', pages: [
      { id: 'airplane', title: 'Airplane', presets: AIRPLANE, sections: [
        { title: 'Handling', items: [
          { id: 'planeLevel', label: 'Wings level themselves', type: 'toggle', default: true,
            hint: 'Letting go of A and D rolls the wings back level (unless you are pulling or pushing). Off: the bank holds, as in a real fly-by-wire jet, until you roll back yourself.' },
          { id: 'planeView', label: 'View', type: 'choice', default: 'path',
            options: [['path', 'Flight path'], ['nose', 'Nose']],
            hint: 'Flight path: you look where the jet is going, so the view turns exactly as it does. Nose: as from a real cockpit; the nose rides above the way you go by the wing\'s angle, and pulling, it comes up first and the jet follows a moment later. On the ground it is always the nose.' },
          { id: 'planeWing', label: 'Wing', type: 'choice', default: 'strong',
            options: [['built', 'As built'], ['strong', 'Stronger']],
            hint: 'As built: the F-16\'s wing and 9 g; it stalls at about 245 km/h, level at sea level. Stronger: half as much lift again and 12 g, so it pulls round and up quicker and stalls at about 200 km/h.' },
          { id: 'planeScroll', label: 'Scroll sets', type: 'choice', default: 'speed',
            options: [['speed', 'Speed'], ['throttle', 'Throttle']],
            hint: 'Speed: the speed you want, and an autothrottle flies it as well as the engine can (scrolled down to nothing, the engine is off). Throttle: the engine\'s power itself, idle to full dry thrust (100%) and on into the afterburner (AB); the speed is then whatever thrust, drag and gravity make it. Either way a single notch is a fine step (5 km/h, or 1%), and scrolling on quickly makes each notch bigger, up to 100 km/h (10%).' },
          { id: 'planeEngine', label: 'Engine and brakes', type: 'choice', default: 'built', revision: 1,
            options: [['built', 'As built'], ['quick', 'Quick'], ['quicker', 'Quicker']],
            hint: 'As built: an F-16\'s engine and speed brake (Left Shift), so a steep climb slows you, a dive speeds you up and a hard turn bleeds speed. Quick: 1.5 times the thrust (straight up it even speeds up), and the autothrottle opens a strong speed brake itself, with the engine off down to the least speed it flies at: 450 → 850 km/h in about 10 s and back in about 14 s. Quicker: twice the thrust.' },
        ] },
        { title: 'Display', items: [
          { id: 'planePointer', label: 'Pointer', type: 'toggle', default: true,
            hint: 'A dot in the middle of the view: where you are going (View: Flight path), or where the nose points (View: Nose). Hidden while you look round the cockpit.' },
          { id: 'planeLadder', label: 'Horizon and pitch lines', type: 'toggle', default: false,
            hint: 'The attitude: the horizon and a line every 10° of pitch, drawn where they are in the view.' },
          { id: 'planeMarker', label: 'Flight path marker', type: 'toggle', default: false,
            hint: 'Where the jet is really going: below the nose by the wing\'s angle, beside it in a skid.' },
          { id: 'planeSpeed', label: 'Speed, Mach and g', type: 'toggle', default: false,
            hint: 'The speed in km/h, the speed asked with the wheel (or the throttle, when the wheel sets it), the Mach number and the load.' },
          { id: 'planeAltitude', label: 'Altitude and climb', type: 'toggle', default: false,
            hint: 'Metres above the sea, above the ground under you (R), and the climb in metres a second.' },
          { id: 'planeHeading', label: 'Heading', type: 'toggle', default: false },
          { id: 'planeThrottle', label: 'Throttle', type: 'toggle', default: false,
            hint: 'Idle to full dry thrust, then the afterburner.' },
          { id: 'planeWarnings', label: 'Warnings', type: 'toggle', default: false,
            hint: 'STALL while the wing is stalled, BRAKE, ON GROUND.' },
        ] },
      ], advanced: [
        { id: 'planeRollRate', label: 'Roll rate', type: 'slider',
          default: 90, min: 30, max: 240, step: 5, format: (v) => `${v}°/s`,
          hint: 'How fast it rolls with A or D held, at 600 km/h: in proportion to the speed, as an airplane\'s ailerons do (half as fast at 300 km/h, twice at 1,200), 240°/s at the most. The real F-16 rolls 180°/s and more.' },
        { id: 'planeRollBuild', label: 'Roll build-up', type: 'slider',
          default: 0.8, min: 0, max: 1.5, step: 0.05, format: (v) => `${Number(v).toFixed(2)} s`,
          hint: 'How long A or D takes to reach that rate. A key is all or nothing, so while held it moves the stick over this time and a tap is a small correction; 0 rolls at the full rate at once.' },
      ] },
    ],
  },
  {
    id: 'controls', label: 'Controls', icon: 'controls', pages: [
      { id: 'mouse', title: 'Mouse', sections: [{ items: [
        { id: 'lookSensitivity', label: 'Sensitivity', type: 'slider',
          default: 2.2, min: 0.4, max: 8, step: 0.1, format: (v) => v.toFixed(1) },
        { id: 'invertY', label: 'Invert vertical look', type: 'toggle', default: false },
      ] }] },
      { id: 'keyboard', title: 'Keyboard', sections: [{ items: [
        { id: 'doubleTapMs', label: 'Double-tap window', type: 'slider',
          default: 300, min: 150, max: 500, step: 10, format: (v) => `${v} ms`,
          hint: 'Two presses of Jump inside this switch between walking and flying.' },
        { id: 'captureKeys', label: 'Capture browser shortcuts', type: 'toggle', default: true,
          hint: 'Goes fullscreen while you play, so Ctrl+W and the like reach the app instead of closing the tab. Esc releases everything.' },
      ] }] },
      { id: 'keys', title: 'Keys', sections: [{ items: [
        { id: 'keybinds', label: 'Keys', type: 'keybinds', default: DEFAULT_BINDINGS },
      ] }] },
    ],
  },
  {
    id: 'world', label: 'World', icon: 'world', pages: [
      { id: 'start', title: 'Starting point', sections: [{ items: [
        { id: 'spawn', label: 'Start at', type: 'choice', default: 'last',
          options: [['last', 'Last position'], ['home', 'Home']] },
        { id: 'home', label: 'Home', type: 'readout', default: null,
          format: (v) => (v ? `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}` : 'not set') },
        { id: 'setHome', label: 'Make where I am home', type: 'button' },
      ] }] },
    ],
  },
];

/** Every setting of a page: its sections', then its advanced ones. */
export const pageItems = (page) => [...page.sections.flatMap((s) => s.items), ...(page.advanced ?? [])];

/* One preset's value and a setting's, alike? (Sliders give floats: 0.15 can come back as 0.15000000000000002.) */
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : String(a) === String(b));

/** Which of a page's presets the settings match, or null (Custom). */
export function presetOf(settings, page) {
  return page.presets?.find((p) => Object.entries(p.values).every(([id, v]) => same(settings.get(id), v)))?.id ?? null;
}

/** Sets every value of one of a page's presets. */
export function applyPreset(settings, page, id) {
  const preset = page.presets?.find((p) => p.id === id);
  if (preset) for (const [k, v] of Object.entries(preset.values)) settings.set(k, v);
}

/** Every setting, whichever tab and page it is on. */
export const ITEMS = TABS.flatMap((tab) => tab.pages.flatMap(pageItems));

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
    // A setting whose meaning or default changed carries a higher
    // `revision`: what was saved under an older one is left behind.
    this.revisions = {};
    for (const item of ITEMS) if (item.revision) this.revisions[item.id] = item.revision;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'), savedRevisions = saved[REVISIONS] || {};
      for (const k of Object.keys(this.values)) {
        if (k in saved && (savedRevisions[k] ?? 0) === (this.revisions[k] ?? 0)) this.values[k] = saved[k];
      }
    } catch { /* corrupt or unavailable storage falls back to defaults */ }
    // Actions added since the bindings were saved get their default keys,
    // unless one of those keys was since given to something else.
    const saved = this.values.keybinds || {};
    const taken = new Set(Object.values(saved).flat().filter(Boolean));
    const added = {};
    for (const [action, keys] of Object.entries(DEFAULT_BINDINGS)) {
      if (!(action in saved)) added[action] = keys.map((k) => (taken.has(k) ? '' : k));
    }
    this.values.keybinds = { ...added, ...saved };
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
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.values, [REVISIONS]: this.revisions })); } catch { /* private mode */ }
    }, 250);
  }
}
