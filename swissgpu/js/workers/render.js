/* render.js — the render thread.
 *
 * Owns the WebGPU device, the canvas, the camera, the terrain cache, and its
 * own pool of decode threads. The page thread sends input and receives
 * telemetry; nothing else crosses. Tile traffic never touches it at all, which
 * is the point of nesting the pool here rather than leaving it on the page.
 */

import { Endpoint } from '../core/rpc.js';
import { instantiateCore } from '../core/wasm.js';
import { WorkerPool, suggestedCodecThreads } from '../core/workers.js';
import { Scheduler, PHYSICS } from '../core/scheduler.js';
import { BUILD } from '../build.js';
import { initGPU } from '../engine/gpu.js';
import { Frame } from '../engine/frame.js';
import { SkyPass } from '../engine/passes/sky.js';
import { TerrainPass } from '../engine/passes/terrain.js';
import { BuildingsPass } from '../engine/passes/buildings.js';
import { CablesPass } from '../engine/passes/cables.js';
import { PathPass } from '../engine/passes/path.js';
import { LabelPass } from '../engine/passes/label.js';
import { FrameUniforms } from '../engine/passes/frame-uniforms.js';
import { Atmosphere } from '../engine/passes/atmosphere.js';
import { Tileset } from '../engine/features/tileset.js';
import { FeaturePool } from '../engine/features/feature-pool.js';
import { createMaterialLibrary } from '../engine/material-library.js';
import { SolidWorld, nearestWhere } from '../engine/features/solid.js';
import { View } from '../engine/view.js';
import { UploadQueue } from '../engine/uploads.js';
import { Profiler } from '../engine/profiler.js';
import { Camera, FOV_Y } from '../engine/camera.js';
import { Clipmap } from '../engine/imagery/clipmap.js';
import { Terrain, ACCURATE_LEVEL, geometricError } from '../engine/terrain/terrain.js';
import { Ground, groundSample } from '../engine/terrain/ground.js';
import { FlyController, SPRINT_MULTIPLIER } from '../engine/controllers/fly.js';
import { WalkController, BODY_RADIUS } from '../engine/controllers/walk.js';
import { Flight, LANDING, GROUND_EXACT, GROUND_ELEVATION } from '../engine/flight/flight.js';
import { Obstacles } from '../engine/flight/obstacles.js';
import { DEFAULT_SETTINGS, warmUpPlanner } from '../engine/flight/plan.js';
import { PACE } from '../engine/flight/timing.js';
import { smoothstep } from '../core/signal.js';
import { DEG, radiiAt, geodeticToEcef } from '../core/math.js';
import { registry } from '../adapters/index.js';

const rpc = new Endpoint(self, 'render');

let frame = null, core = null, device = null, caps = null;
let camera = null, terrain = null, pool = null, scheduler = null, ground = null, imagery = null;
let frameUniforms = null;
const view = new View();
/* Arrived tiles wait here and go to the GPU a slice at a time, every frame. */
const uploads = new UploadQueue(2);
/* Sections of a frame. 'evict' (dropping tiles to stay within memory) and
 * 'maintain' (tidying the streamers' trees and lists) are measured inside the
 * terrain and building updates and carved out of them. */
const profiler = new Profiler(['physics', 'uploads', 'view', 'terrain', 'buildings', 'evict', 'maintain',
  'ground', 'imagery', 'requests', 'draw', 'submit']);
/* Reused every frame rather than allocated. */
const viewParams = { viewHeight: 1, fovY: FOV_Y, aspect: 1, near: 0.1 };
const imageryParams = { aboveGround: 0, viewHeight: 1, fovY: FOV_Y, reach: 20000 };
/* Streamed 3D Tiles layers drawn as buildings (buildings, bridges and other
 * structures), and the collision world built from them; two more of those
 * for a search flight's start and landing, and what the flight keeps
 * clear of (engine/flight/obstacles.js). */
let buildings = [];
let solids = null, startSolids = null, endSolids = null, obstacles = null;
/* The passes whose draw counts the performance panel shows. */
let terrainPass = null, buildingsPass = null, cablesPass = null, pathPass = null, labelPass = null;
let streamingPaused = false;

/* `keys` is what is held now. `pressed` latches every key that went down
 * since the last physics step, so a tap shorter than a frame still counts:
 * down and up can both arrive between two frames, and without the latch the
 * physics would never see the key at all. */
const input = { keys: 0, pressed: 0, sensitivity: 0.0022, invertY: false };
let simTime = 0;   // seconds of simulated time, for the probe

/* Physics never steps longer than this, whatever the frame rate. Each frame
 * is cut into equal substeps no longer than 1/120 s, which keeps jumps and
 * landings the same at 30 fps and at 240. */
const PHYSICS_HZ = 120;

/* Eyes sit at about 93.6% of standing height in adults. */
const EYE_RATIO = 0.936;

/* Near clip plane, metres. Reverse-Z depth keeps its precision however small
 * this is, and a walker's eye can come within a metre of a steep slope. */
const NEAR = 0.1;

/* An arrival that has found no ground at all after this long gives up and
 * flies instead. */
const ARRIVAL_GIVE_UP = 15;

/* Around the walker, and around a flyer near the ground or anything built,
 * every building tile is loaded in full detail, on screen or not, and solid
 * (the view's focus). FOCUS_RADIUS is also how far an arrival may be moved
 * to get clear of buildings; CLEAR_PATIENCE how long it waits for them
 * before standing anyway. Flying, the focus reaches as far as FOCUS_LEAD
 * seconds take you at the speed set (sprinting, at that times
 * SPRINT_MULTIPLIER): FOCUS_RADIUS, doubled until it does, FOCUS_MOST at
 * most; and it is there while the eye is less than that (FOCUS_HEIGHT at
 * least) above the ground, or above the highest anything built within it
 * can reach (Obstacles.built). Stage 5.7: Basel's Roche towers stand 178
 * and 205 m; flying more than 150 m over the ground beside them, nothing
 * was solid and he passed through them, his words: "never ignore
 * collisions otherwise, only in flyTo flight". */
const FOCUS_RADIUS = 60;
const FOCUS_HEIGHT = 150;
const FOCUS_LEAD = 2;
const FOCUS_MOST = 240;
const CLEAR_PATIENCE = 10;
/* Per frame, triangles are gathered this far beyond what one frame's
 * movement can reach, and never farther than the cap. */
const SOLID_MARGIN = 1.5;
const SOLID_REACH_CAP = 200;

const physics = {
  eyeHeight: 1.75 * EYE_RATIO, bodyHeight: 1.75,
  walkSpeed: 1.4, runSpeed: 4.5, jumpHeight: 0.45, gravity: 9.81, maxSlope: 45 * DEG,
  flyThrough: false,
};

const controllers = { fly: new FlyController(), walk: new WalkController() };
let mode = 'fly';
/* A flight to a search result (engine/flight/), while one is under way,
 * where it goes, and its settings (General tab: speed, longest, bank). */
const flight = new Flight();
const flightSettings = { ...DEFAULT_SETTINGS };
let showFlightPath = true;
let showFlightLabel = true;
let flyTarget = null;

/* Coarse terrain tiles are stand-ins: only tiles this fine (or the finest a
 * service has) say where the ground is (terrain.js, ACCURATE_LEVEL). For
 * clearance and first guesses, the top of a tile is trusted from this level
 * on; a coarser tile's top can be a mountain away from a valley floor. */
const TRUSTED_TOP_LEVEL = 12;

/* Flying low and fast, the ground ahead is asked for before you reach it:
 * every quarter second of flight below 800 m above the ground and faster
 * than 30 m/s, the whole column of terrain tiles under the point two seconds
 * ahead is requested at once (down to the level the view will draw there,
 * and at least to the first accurate one), and physics indexes the ground
 * there as soon as it lands. Velocity is measured from the camera's own
 * movement, eased over a fifth of a second. (Ground needed right where the
 * camera or a walker is, ground.js asks for itself.) */
const LOOK_AHEAD = { seconds: 2, every: 0.25, below: 800, faster: 30, smoothing: 0.2 };
const motion = { east: 0, north: 0, lon: NaN, lat: NaN, radii: { meridian: 0, primeVertical: 0 } };
const ahead = { lon: 0, lat: 0, on: false, next: 0, count: 0 };

rpc.on('init', async ({ canvas, wasmModule, settings, size, camera: startCamera }) => {
  core = instantiateCore(wasmModule);
  const failure = core.selftest();
  if (failure !== 0) throw new Error(`wasm core self-test failed with code ${failure}`);

  // The decode threads are children of this one, so a finished tile lands
  // directly where its GPU buffers are created. Every job they do goes
  // through the scheduler (core/scheduler.js).
  const codecCount = decodeThreads(settings.decodeThreads);
  pool = await WorkerPool.create(new URL('./codec.js', import.meta.url), codecCount, 'codec',
    { type: 'init', payload: { wasmModule }, timeout: 15000 });
  scheduler = new Scheduler(pool);

  const gpu = await initGPU(canvas);
  device = gpu.device;
  caps = gpu.caps;

  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    rpc.send('device-lost', { reason: info.reason, message: info.message });
    frame?.stop();
  });
  device.onuncapturederror = (e) => rpc.send('gpu-error', { message: String(e.error.message) });

  camera = new Camera(startCamera);
  terrain = new Terrain({
    device, scheduler, registry, uploads,
    maxError: 2,
    budgetMB: Number(settings.terrainMemory) || 256,
  });
  ground = new Ground({ terrain, scheduler });
  // A tile physics may stand on brings its ground index along.
  terrain.wantsGround = (t) => ground.wants(t);
  terrain.onGround = (t, data) => ground.adopt(t, data);
  imagery = new Clipmap({ device, scheduler, registry, caps, uploads, window: Number(settings.imageryDetail) || 16,
    quality: settings.imageryQuality, sharpness: Number(settings.imagerySharpness ?? 0.35) });
  const [services, imageryInfo] = await Promise.all([terrain.prepare(), imagery.prepare()]);
  if (startCamera?.mode === 'walk') {
    // Back where the last session stood: settle onto the ground as it loads,
    // rather than stand on the first coarse tile and drop when detail lands.
    terrain.prefetchColumn(camera.lon, camera.lat);
    setMode('walk', { arrive: true });
  } else {
    setMode('fly');
  }

  frame = new Frame({ device, context: gpu.context, canvas, caps });
  frame.onError = (err) => rpc.send('render-error', {
    message: String(err?.message || err),
    stack: String(err?.stack || '').split('\n').slice(0, 6).join('\n'),
  });
  frame.shared = { camera, terrain, fovY: FOV_Y, near: NEAR };
  frame.beforeFrame = (dt) => step(dt);
  frame.profiler = profiler;

  // The air comes first: its tables and light are bound for everything drawn after.
  frameUniforms = new FrameUniforms(device);
  const atmosphere = await Atmosphere.create(device, frameUniforms, frame.timer);
  frameUniforms.attach(atmosphere);
  frame.add(atmosphere);
  frame.add(await SkyPass.create(device, { format: caps.format, timer: frame.timer, frame: frameUniforms }));
  terrainPass = frame.add(await TerrainPass.create(device, {
    format: caps.format, timer: frame.timer, terrain, imagery, frame: frameUniforms,
  }));

  // Every adapter's building layer. Their tileset descriptions load in the
  // background: the terrain does not wait for buildings to appear.
  // Each layer answers to its own switch in Layers, and takes its share of
  // the building memory setting. All of them keep their buildings' records
  // in one pool, which the pass binds once.
  const features = new FeaturePool(device);
  buildings = registry.all.flatMap((adapter) => adapter.features
    .filter((f) => f.kind === 'buildings' && f.tileset)
    .map((spec) => new Tileset({
      device, scheduler, uploads, features,
      spec: { ...spec, id: `${adapter.id}/${spec.id}`, setting: spec.setting || 'buildings' },
      maxError: spec.maxError || 10,
      budgetMB: (Number(settings.buildingMemory) || 256) * (spec.memoryShare ?? 1),
    })));
  for (const layer of buildings) {
    layer.configure({ enabled: settings[layer.spec.setting] !== false });
    layer.load().then((line) => console.info(`[buildings] ${line}`), (err) => {
      layer.status = 'failed';
      console.warn(`[buildings] ${layer.spec.id} unavailable: ${err.message}`);
    });
  }
  solids = new SolidWorld(buildings);
  startSolids = new SolidWorld(buildings);
  endSolids = new SolidWorld(buildings);
  obstacles = new Obstacles(terrain, buildings);
  warmUpPlanner();
  buildingsPass = frame.add(await BuildingsPass.create(device, {
    format: caps.format, timer: frame.timer, tilesets: buildings, imagery, frame: frameUniforms,
    features, materials: await createMaterialLibrary(device),
  }));
  // Cable cars come in the same tiles, as ropes and pylons.
  cablesPass = frame.add(await CablesPass.create(device, {
    format: caps.format, timer: frame.timer, tilesets: buildings, frame: frameUniforms,
  }));
  // A search flight's path, in the world, and its destination's name over everything.
  pathPass = frame.add(await PathPass.create(device, { format: caps.format, timer: frame.timer, frame: frameUniforms }));
  labelPass = frame.add(await LabelPass.create(device, { format: caps.format, timer: frame.timer, frame: frameUniforms }));

  applySettings(settings);
  frame.resize(size.width, size.height, size.dpr);
  frame.start();
  startReporting();

  return {
    gpu: caps.description,
    adapter: caps.adapter,
    vendor: caps.vendor,
    features: [...caps.features],
    maxTextureSize: caps.maxTextureSize,
    timestamps: caps.timestamps,
    bc: caps.bc,
    wasm: core.version,
    codecThreads: codecCount,
    spawnMode: pool.spawnMode,
    build: BUILD,
    codecBuilds: [...new Set(pool.workers.map((e) => e.setupReply?.build ?? 'unknown'))],
    services,
    imagery: imageryInfo,
  };
});

/* What the frame uniforms need besides the camera and the view. */
const frameState = { ground: 0, width: 1, height: 1, fovY: FOV_Y, aspect: 1 };
function frameParams(aspect) {
  frameState.ground = camera.height - (heightAboveGround() ?? camera.height);
  frameState.width = frame.width;
  frameState.height = frame.height;
  frameState.aspect = aspect;
  return frameState;
}

/*
 * The line along a flight's path (passes/path.js): the points of each new
 * plan put on the earth, and again whenever a late change reshapes the way
 * ahead (flight.js: each point moved as the flight will be there, from its
 * σ); every frame the flight's time; faded in as a flight starts and out
 * after it ends (or when the setting is off).
 */
const PATH_FADE = { in: 0.4, out: 0.8 };   // seconds
let pathPlan = null, pathLine = null, pathEcefs = null, pathChanges = 0, pathFade = 0;
const pathPoint = { lon: 0, lat: 0 }, pathEcef = new Float64Array(3), pathMove = { x: 0, y: 0, h: 0 };
function showPath(dt) {
  if (!pathPass) return;
  const want = flight.active && flight.plan && !flight.instant && showFlightPath;
  if (want && (flight.plan !== pathPlan || flight.corrections.length !== pathChanges)) {
    if (flight.plan !== pathPlan) {
      pathPlan = flight.plan;
      pathLine = pathPlan.line();
      pathEcefs = new Float64Array(3 * pathLine.n);
    }
    pathChanges = flight.corrections.length;
    const line = pathLine;
    for (let k = 0; k < line.n; k++) {
      const m = flight.offsetAt(line.sigma[k], pathMove);
      flight.plane.inverse(line.x[k] + m.x, line.y[k] + m.y, pathPoint);
      geodeticToEcef(pathPoint.lon, pathPoint.lat, line.h[k] + m.h, pathEcef);
      pathEcefs.set(pathEcef, 3 * k);
    }
    pathPass.show({ ...line, ecef: pathEcefs });
  }
  pathFade = Math.max(0, Math.min(1, pathFade + (want ? dt / PATH_FADE.in : -dt / PATH_FADE.out)));
  if (pathFade === 0 && pathPlan) { pathPlan = pathLine = pathEcefs = null; pathPass.clear(); }
  pathPass.alpha = smoothstep(pathFade);
  pathPass.now = flight.t;
  pathPass.scale = frame.width / Math.max(1, frame.cssWidth);
}

/*
 * The destination's name over the place (passes/label.js) while a flight
 * goes there: faded in as it starts, out over the way down (LABEL_FADE, in
 * shares of the flight's σ, where it would come to cover the view) and
 * when the flight ends or is cut short. It stands on the best ground known
 * at the place, followed smoothly as that is refined.
 */
const LABEL_FADE = { in: 0.5, out: 0.6, from: 0.8, to: 0.93, follow: 0.4 };
let labelFade = 0, labelHeight = NaN;
const labelAt = { lon: NaN, lat: NaN }, labelEcef = new Float64Array(3);
function showLabel(dt) {
  if (!labelPass) return;
  const want = flight.active && !flight.instant && showFlightLabel && Boolean(flight.label);
  // A new place: on its ground at once, not slid there from the last one.
  if (want && (labelAt.lon !== flight.to.lon || labelAt.lat !== flight.to.lat)) {
    labelAt.lon = flight.to.lon;
    labelAt.lat = flight.to.lat;
    labelHeight = flight.spot.ground;
  }
  labelFade = Math.max(0, Math.min(1, labelFade + (want ? dt / LABEL_FADE.in : -dt / LABEL_FADE.out)));
  if (labelFade === 0) {
    labelPass.alpha = 0;
    return;
  }
  labelPass.setText(flight.label, frame.width / Math.max(1, frame.cssWidth));
  // Gone over the way down (a flight cut short keeps it, fading out).
  const down = 1 - smoothstep((flight.progress - LABEL_FADE.from) / (LABEL_FADE.to - LABEL_FADE.from));
  labelPass.alpha = smoothstep(labelFade) * down;
  labelHeight += (flight.spot.ground - labelHeight) * (1 - Math.exp(-dt / LABEL_FADE.follow));
  geodeticToEcef(flight.to.lon, flight.to.lat, labelHeight, labelEcef);
  labelPass.anchor.set(labelEcef);
}

/* The slowest of a few steps of a frame while a flight is under way, ms
 * (probe: flight.slowest), to find what makes a flight stutter. */
const slowest = { flight: 0, stream: 0, path: 0, label: 0 };
function lapSlow(key, t0) {
  const t = performance.now();
  if (flight.active && t - t0 > slowest[key]) slowest[key] = t - t0;
  return t;
}

/** One simulation step, run before the frame's passes are recorded. */
function step(dt) {
  const controller = controllers[mode];
  if (flight.active) {
    // The flight drives the camera; physics waits for it to arrive and settle.
    const t0 = performance.now();
    const arrived = flight.step(dt, camera, flightEnv);
    lapSlow('flight', t0);
    const floor = floorUnder(camera.lon, camera.lat);
    controllers.fly.aboveGround = floor == null ? null : camera.height - floor;
    if (arrived) land();
    // A walker came down onto open ground and walks on from there.
    if (flight.landed && flight.walk) setMode('walk', { arrive: true });
  } else {
    // A bank left by a flight cut short levels out.
    camera.level(dt);
    gatherSolids(dt);
    const n = Math.max(1, Math.ceil(dt * PHYSICS_HZ));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      // A press acts once, on the first substep.
      controller.step(h, input.keys, i === 0 ? input.pressed : 0, camera, ground, physics, solids);
    }
  }
  input.pressed = 0;
  simTime += dt;
  let t0 = performance.now();
  streamForFlight();
  t0 = lapSlow('stream', t0);
  showPath(dt);
  t0 = lapSlow('path', t0);
  showLabel(dt);
  lapSlow('label', t0);
  clearArrival();
  trackMotion(dt);
  lookAhead();
  profiler.lap('physics');

  // Tiles that arrived since the last frame, a slice's worth: a share of
  // the frame, so it stays small at high frame rates.
  uploads.run(frame.interval);
  profiler.lap('uploads');

  // The view the frame is about to draw decides which tiles exist, and the
  // tiles decide what the ground index and imagery need.
  viewParams.viewHeight = frame.height;
  viewParams.aspect = frame.width / Math.max(1, frame.height);
  viewParams.near = NEAR;
  view.update(camera, viewParams, terrain.finestAt(camera.lon, camera.lat)?.minHeight ?? 0);
  // Physics needs everything around the body loaded, seen or not; a flight
  // to a place needs everything around the place, from take-off on, to find
  // open ground there or to know what stands there by the time it arrives.
  if (flight.active && flight.covered) {
    view.setFocus(flight.to.lon, flight.to.lat, LANDING.focus);
    view.touching = false;
  } else {
    const radius = touchRadius();
    view.setFocus(radius > 0 ? camera.lon : null, camera.lat, radius);
    view.touching = radius > 0;
  }
  frameUniforms.update(camera, view, NEAR, frameParams(viewParams.aspect));
  profiler.lap('view');
  terrain.update(view);
  carveTiming(terrain);
  profiler.lap('terrain');
  for (const layer of buildings) {
    layer.update(view);
    carveTiming(layer);
  }
  profiler.lap('buildings');
  // Ground is also indexed where a flight to a place will end, and where a
  // fast, low flight is heading.
  ground.update(camera, mode === 'walk', flight.active ? flight.to : ahead.on ? ahead : null);
  profiler.lap('ground');
  imageryParams.aboveGround = heightAboveGround();
  imageryParams.viewHeight = frame.height;
  // Imagery beyond the farthest drawn terrain is never fetched.
  imageryParams.reach = Math.max(terrain.reach, 20000);
  imagery.update(camera, imageryParams);
  watchArrival();
  preloadArrival(false);
  profiler.lap('imagery');
  // Every layer has chosen what it wants: hand out the decode threads.
  scheduler.dispatch();
  profiler.lap('requests');
}

/* A streamer's own timings (tile dropping, housekeeping) go to their own
 * profiler sections rather than to the streamer's. */
function carveTiming(streamer) {
  const t = streamer.timing;
  profiler.carve('evict', t.evict);
  profiler.carve('maintain', t.maintain);
  t.evict = 0;
  t.maintain = 0;
}

/*
 * How far round the camera physics needs everything loaded and solid (the
 * focus, see FOCUS_RADIUS), or 0 where it needs nothing: during a search
 * flight, which keeps clear by its plan, and flying through everything.
 */
function touchRadius() {
  if (flight.active) return 0;
  if (mode === 'walk') return FOCUS_RADIUS;
  if (physics.flyThrough) return 0;
  const reach = camera.speed * (controllers.fly.sprinting ? SPRINT_MULTIPLIER : 1) * FOCUS_LEAD;
  let radius = FOCUS_RADIUS;
  while (radius < reach && radius < FOCUS_MOST) radius *= 2;
  radius = Math.min(radius, FOCUS_MOST);
  const ground = camera.height - heightAboveGround();
  const top = Math.max(ground, obstacles.built(camera.lon, camera.lat, radius, ground));
  return camera.height - top < Math.max(FOCUS_HEIGHT, radius) ? radius : 0;
}

/*
 * The triangles physics may touch during this frame's steps: those of the
 * tiles in the focus within what one frame of movement can reach.
 */
function gatherSolids(dt) {
  if (!solids) return;
  if (mode === 'fly' && physics.flyThrough) { solids.clear(); return; }
  const speed = mode === 'walk'
    ? Math.max(physics.runSpeed, controllers.walk.speed, Math.abs(controllers.walk.vUp))
    : camera.speed * SPRINT_MULTIPLIER;
  const reach = Math.min(SOLID_REACH_CAP, BODY_RADIUS + speed * Math.min(dt, 0.1) + SOLID_MARGIN);
  solids.prepare(camera.lon, camera.lat, camera.height, reach);
}

/*
 * An arrival has settled on the ground. Once the buildings around it have
 * loaded (or after a patient wait), make sure it is not standing inside one:
 * if it is, move it to the nearest open ground, and let it settle there.
 */
function clearArrival() {
  const w = controllers.walk;
  if (mode !== 'walk' || !w.clearing) return;
  if (!solids.settled(view) && w.clearTime < CLEAR_PATIENCE) return;
  solids.prepare(camera.lon, camera.lat, camera.height, FOCUS_RADIUS + 2);
  const sample = { height: 0, gradE: 0, gradN: 0 }, at = { lon: 0, lat: 0 };
  const feetAt = (x, y) => {
    camera.offsetLonLat(x, y, at);
    return ground.sample(at.lon, at.lat, sample) ? sample.height - solids.origin.height : null;
  };
  const spot = solids.nearestClear(0, 0, BODY_RADIUS + 0.25, physics.bodyHeight, FOCUS_RADIUS, feetAt);
  if (!spot) {
    rpc.send('notice', { text: 'No open ground nearby: you may be standing inside a building.' });
  } else if (spot.x !== 0 || spot.y !== 0) {
    camera.translate(spot.x, spot.y, 0);
    w.clearedBy = Math.hypot(spot.x, spot.y);
  } else {
    w.clearedBy = 0;
  }
  w.clearing = false;
  w.cleared = true;
}

/** Best available estimate of the eye's height over the ground below it. */
function heightAboveGround() {
  const known = controllers[mode].aboveGround;
  if (known != null) return known;
  const tile = terrain.leafAt(camera.lon, camera.lat) || terrain.finestAt(camera.lon, camera.lat);
  // The tile's highest point makes the estimate err towards the ground being
  // closer, which asks for sharper imagery rather than blurrier.
  return tile ? camera.height - tile.maxHeight : camera.height;
}

/* The highest ground known under a point, for keeping a flight clear of it:
 * the exact surface where accurate ground is indexed, else the top of the
 * finest tile, if that tile is fine enough for its top to mean something. */
const floorSample = groundSample();
function floorUnder(lon, lat) {
  if (ground.sample(lon, lat, floorSample) && floorSample.accurate) return floorSample.height;
  const t = terrain.finestAt(lon, lat);
  return t && t.z >= TRUSTED_TOP_LEVEL ? t.maxHeight : null;
}

/* The best estimate of the ground at a point, and how good it is (see
 * engine/flight/flight.js): accurate ground where it is indexed, else the
 * finest tile's cell over the point (terrain.js, estimateAt), ranked by its
 * level. */
const pointEstimate = { height: 0, level: 0 };
function groundEstimate(lon, lat, out) {
  if (ground.sample(lon, lat, floorSample) && floorSample.accurate) {
    out.height = floorSample.height;
    out.rank = GROUND_EXACT;
    return true;
  }
  if (!terrain.estimateAt(lon, lat, pointEstimate)) return false;
  out.height = pointEstimate.height;
  out.rank = pointEstimate.level;
  return true;
}

/* Accurate ground at a point, or null: a flight's backstop. */
function exactGround(lon, lat) {
  return ground.sample(lon, lat, floorSample) && floorSample.accurate ? floorSample.height : null;
}

/* The view's focus is round this place, at least as wide as a landing's:
 * then `settled` speaks for it. */
function focusedAt(to) {
  const f = view.focus;
  return Boolean(f) && f.lon === to.lon && f.lat === to.lat && f.radius >= LANDING.focus;
}

/*
 * Where a flight ending low comes down (engine/flight/flight.js): the
 * nearest spot around the place where a body `above` metres over the
 * ground, or standing on it when `walk`, is outside every building, clear of
 * its walls and with nothing over it (the flight comes straight down onto
 * it). Only once the focus is round the place, the ground there is accurate
 * and its buildings have loaded with their collision copies; flying through
 * buildings, any spot will do for a flight. The triangles gathered for it,
 * out to the edge of the focus, then answer the flight's questions there
 * exactly (an obstacle zone).
 */
const landSample = groundSample();
/* How long gathering the exact zones took, the slowest of each (ms): at the
 * start, round a place arrived at, and finding a landing spot (probe).
 * Each gathers only as far as it is asked about: a landing spot is looked
 * for within FOCUS_RADIUS; a place arrived at without landing is asked only
 * what stands within a metre or two of it (flight.js, #arrival and #hover),
 * so ARRIVAL_ZONE. (Both gathered 102 m before: 65 ms in one frame of the
 * rig on the way to Lugano.) */
const ARRIVAL_ZONE = 10;
const zoneMs = { start: 0, end: 0, spot: 0 };
const timed = (key, t0) => { zoneMs[key] = Math.max(zoneMs[key], performance.now() - t0); };

function landingSpot(to, above, walk, out) {
  if (!focusedAt(to)) return false;
  if (!ground.sample(to.lon, to.lat, landSample) || !landSample.accurate) return false;
  out.lon = to.lon;
  out.lat = to.lat;
  out.ground = landSample.height;
  if (!solids || (!walk && physics.flyThrough)) return true;
  if (!endSolids.settled(view)) return false;
  const t0 = performance.now();
  const feet = walk ? 0 : Math.max(0, above - physics.eyeHeight);
  endSolids.prepare(to.lon, to.lat, landSample.height + feet, FOCUS_RADIUS + 2, { lines: true });
  obstacles.addZone(endSolids, FOCUS_RADIUS);
  const o = endSolids.origin, radius = BODY_RADIUS + 0.25;
  const spot = nearestWhere(0, 0, FOCUS_RADIUS, (x, y) => {
    const lon = to.lon + x / endSolids.mPerDegLon, lat = to.lat + y / endSolids.mPerDegLat;
    if (!ground.sample(lon, lat, landSample) || !landSample.accurate) return false;
    const f = landSample.height + feet - o.height;
    return endSolids.clearAt(x, y, f, radius, physics.bodyHeight) && !endSolids.overhead(x, y, radius, f + 0.1);
  });
  timed('spot', t0);
  if (!spot) {
    rpc.send('notice', { text: 'No open ground near this place: you may land inside a building.' });
  } else if (spot.x !== 0 || spot.y !== 0) {
    out.lon = to.lon + spot.x / endSolids.mPerDegLon;
    out.lat = to.lat + spot.y / endSolids.mPerDegLat;
    if (ground.sample(out.lon, out.lat, landSample)) out.ground = landSample.height;
  }
  return true;
}

/* What stands round a place a flight arrives at without landing, exactly,
 * once it has loaded there (an obstacle zone, as for a landing). */
function endZone(to) {
  if (!solids || physics.flyThrough || !focusedAt(to) || !endSolids.settled(view)) return false;
  const t0 = performance.now();
  const base = groundEstimate(to.lon, to.lat, destination) ? destination.height : camera.height;
  endSolids.prepare(to.lon, to.lat, base, ARRIVAL_ZONE + 2, { lines: true });
  obstacles.addZone(endSolids, ARRIVAL_ZONE);
  timed('end', t0);
  return true;
}

/*
 * Where a flight starts, exactly: when physics touches the world at the
 * camera (walking, or flying low) and everything round it has loaded, the
 * triangles and ropes there answer the flight's questions (an obstacle
 * zone). Under an overhang (a roof, a bridge, a rope above the eye), the
 * flight first slides out to the nearest spot with open sky, on rings 2 m
 * apart in 16 directions, that a body can reach at the eye's height without
 * passing through a wall. Returns { lon, lat, distance } for that slide, or
 * null to lift where it is.
 */
function prepareStart() {
  if (!solids || (mode === 'fly' && physics.flyThrough) || !view.touching || !view.focus || !startSolids.settled(view)) return null;
  const t0 = performance.now();
  startSolids.prepare(camera.lon, camera.lat, camera.height, FOCUS_RADIUS, { lines: true });
  obstacles.addZone(startSolids, FOCUS_RADIUS - 2);
  timed('start', t0);
  if (!startSolids.overhead(0, 0, 0.5, 0.2)) return null;
  const from = { x: 0, y: 0 }, to = { x: 0, y: 0 };
  for (let ring = 2; ring <= FOCUS_RADIUS - 2; ring += 2) {
    for (let k = 0; k < 16; k++) {
      const a = (2 * Math.PI * k) / 16, x = ring * Math.sin(a), y = ring * Math.cos(a);
      if (startSolids.overhead(x, y, 0.5, 0.2)) continue;
      to.x = x; to.y = y;
      startSolids.sweep(from, to, BODY_RADIUS, -physics.eyeHeight + 0.5, 0.2);
      if (Math.hypot(to.x - x, to.y - y) > 0.05) continue;
      return { lon: camera.lon + x / startSolids.mPerDegLon, lat: camera.lat + y / startSolids.mPerDegLat, distance: ring };
    }
  }
  return null;
}

/* The finest terrain level whose margin (terrain.js, upperBound: 1.5 of its
 * error) fits in `metres`, between 8 and 17: how deep a flight asks for the
 * ground along its way. */
function levelForError(metres) {
  let z = 8;
  while (z < 17 && 1.5 * geometricError(z) > metres) z++;
  return z;
}

/* Everything a flight asks about the world (engine/flight/flight.js). */
const flightEnv = {
  bound: (lon, lat, r) => obstacles.bound(lon, lat, r),
  estimate: (lon, lat, r) => obstacles.estimate(lon, lat, r),
  groundAt: groundEstimate,
  exactGround,
  landingSpot,
  endZone,
  ready: () => arrival.ready,
  prefetch: (lon, lat, level) => terrain.prefetchAhead(lon, lat, level),
  levelFor: levelForError,
};

/* A flight has arrived. Where there is no terrain yet, it says so. */
function land() {
  const t = flyTarget;
  flyTarget = null;
  if (t && !t.covered) {
    rpc.send('notice', { text: `No terrain for ${t.label || 'this place'} yet: only Switzerland is modelled so far.` });
  }
}

/* The camera's own horizontal velocity, measured from how it moved. A jump
 * (a search pick, the rig placing it) is not a velocity: placing the camera
 * resets this. */
function trackMotion(dt) {
  const m = motion;
  if (dt > 0 && Number.isFinite(m.lon) && !flight.active) {
    const { meridian, primeVertical } = radiiAt(camera.lat, m.radii);
    const east = ((camera.lon - m.lon) * DEG * primeVertical * Math.cos(camera.lat * DEG)) / dt;
    const north = ((camera.lat - m.lat) * DEG * meridian) / dt;
    const k = 1 - Math.exp(-dt / LOOK_AHEAD.smoothing);
    m.east += (east - m.east) * k;
    m.north += (north - m.north) * k;
    // Faster than anything here can fly: it was placed, not moved.
    if (Math.hypot(east, north) > 100000) m.east = m.north = 0;
  } else {
    m.east = m.north = 0;
  }
  m.lon = camera.lon;
  m.lat = camera.lat;
}

function resetMotion() {
  motion.lon = motion.lat = NaN;
  ahead.on = false;
}

/* See LOOK_AHEAD. `ahead.on` says the point ahead is where physics should
 * also index ground (ground.js's watched point). */
function lookAhead() {
  const speed = Math.hypot(motion.east, motion.north);
  const above = heightAboveGround();
  if (mode !== 'fly' || flight.active || streamingPaused || speed < LOOK_AHEAD.faster ||
      above == null || above > LOOK_AHEAD.below) {
    ahead.on = false;
    return;
  }
  if (ahead.on && simTime < ahead.next) return;
  ahead.on = true;
  ahead.next = simTime + LOOK_AHEAD.every;
  camera.offsetLonLat(motion.east * LOOK_AHEAD.seconds, motion.north * LOOK_AHEAD.seconds, ahead);
  terrain.prefetchColumn(ahead.lon, ahead.lat,
    Math.max(ACCURATE_LEVEL, terrain.levelFor(Math.max(50, above))));
  ahead.count++;
}

/*
 * A flight to a place loads what the view there will need while it is on
 * its way: the terrain, buildings and photos round it, from a camera put
 * where the flight will arrive (render thread's View, one per flight,
 * reused) looking all around (Stage 5.6, his words: "the loaded endpoints
 * should be a circle of point B, not just the final in view elements (you
 * cull after having landed)"): terrain and buildings in a full circle with
 * the detail their distance asks for, out to the horizon; photos in a square
 * round the place. After landing, the normal view's culling takes over.
 * Asked again every second of the flight, since the ground there is refined
 * and each walk gets further down the trees. `ready` says how much of it is
 * here, 0 to 1, the layers weighed by ARRIVAL_WEIGHT (those with nothing
 * there left out): the flight slows its descent while it is short
 * (engine/flight/flight.js, WAIT).
 */
const ARRIVAL_WEIGHT = { terrain: 0.4, buildings: 0.4, imagery: 0.2 };
const arrival = { camera: null, view: new View(), next: 0, ready: 1, counts: null,
  params: { viewHeight: 1, fovY: FOV_Y, aspect: 1, near: NEAR } };
arrival.view.setAllAround(true);
function preloadArrival(now) {
  if (!flight.active || flight.instant || flight.arrived || streamingPaused) return;
  if (!now && simTime < arrival.next) return;
  arrival.next = simTime + 1;
  const cam = arrival.camera ??= new Camera();
  const at = flight.confirmed ? flight.spot : flight.to;
  cam.apply({ lon: at.lon, lat: at.lat, height: flight.ground1 + Math.max(flight.h1, physics.eyeHeight),
    yaw: flight.yaw0, pitch: flight.pitch0, roll: 0 });
  const p = arrival.params;
  p.viewHeight = frame.height;
  p.aspect = frame.width / Math.max(1, frame.height);
  arrival.view.setMaxDistance(view.maxDistance);
  arrival.view.update(cam, p, flight.ground1);
  const c = arrival.counts ??= { terrain: { have: 0, need: 0 }, buildings: { have: 0, need: 0 }, imagery: { have: 0, need: 0 } };
  for (const k in c) c[k].have = c[k].need = 0;
  terrain.preload(arrival.view, c.terrain);
  for (const layer of buildings) layer.preload(arrival.view, c.buildings);
  imagery.preload(at.lon, at.lat, Math.max(flight.h1, physics.eyeHeight), frame.height, FOV_Y, c.imagery);
  let sum = 0, weight = 0;
  for (const k in c) {
    const total = c[k].have + c[k].need;
    if (!total) continue;
    sum += (ARRIVAL_WEIGHT[k] * c[k].have) / total;
    weight += ARRIVAL_WEIGHT[k];
  }
  arrival.ready = weight > 0 ? sum / weight : 1;
}

/*
 * While a search flight is on its way, what its arrival will show may take
 * half the decode slots before the view along the way, and goes first in
 * the flight's second half (core/scheduler.js): the way past is passing,
 * the arrival is what stays. And the faster the ground streams past (its
 * pace, heights a second), the less detail is asked for along the way:
 * terrain as if the detail setting were MOTION.steps lower, photos a level
 * coarser from half of it (what is loaded still shows; see terrain.js,
 * imagery/clipmap.js). A few steps, not a new detail every frame.
 */
const MOTION = { from: 0.3, steps: [1, 0.7, 0.5, 0.35] };
function streamForFlight() {
  const on = flight.active && flight.phase === 'flight';
  scheduler.preloadShare = on ? 0.5 : 0;
  scheduler.preloadFirst = on && flight.t >= 0.5 * flight.duration;
  let scale = 1;
  if (on) {
    const above = Math.max(0, controllers.fly.aboveGround ?? heightAboveGround() ?? 0);
    const pace = (flight.pose.speed * flight.rate) / (above + PACE.offset);
    const wanted = 1 / (1 + Math.max(0, pace - MOTION.from));
    for (const step of MOTION.steps) if (step >= wanted) scale = step;
  }
  terrain.setMotion(scale);
  imagery.setMotion(Math.floor(Math.log2(1 / scale) + 0.01));
}

/* Placed somewhere with terrain that never loaded: fly rather than hang. */
function watchArrival() {
  const walk = controllers.walk;
  if (mode === 'walk' && walk.arriving && walk.waiting && walk.arriveTime > ARRIVAL_GIVE_UP) {
    setMode('fly');
    rpc.send('notice', { text: 'The ground here did not load, so you are flying instead.' });
  }
}

function setMode(next, options) {
  if (next !== 'walk' && next !== 'fly') return;
  mode = next;
  camera.mode = next;
  // The Space press that asked for the switch must not also act as a jump
  // in the new mode. It is latched already, because the page sends key state
  // before the toggle, so drop it here.
  input.pressed = 0;
  controllers[next].enter(options);
}

/* ---- input ---- */

rpc.on('keys', ({ mask }) => {
  // Taking the controls during a flight to a place stops it where it is.
  if (flight.active && (mask & ~input.keys)) cancelFlight('keys');
  input.pressed |= mask & ~input.keys;
  input.keys = mask;
});
rpc.on('look', ({ dx, dy }) => {
  // During a flight to a place the mouse turns the head; the flight goes on.
  // Settling after an instant trip, it looks around as usual.
  if (flight.active && flight.phase !== 'settle') {
    flight.look(dx * input.sensitivity, (input.invertY ? dy : -dy) * input.sensitivity);
    return;
  }
  camera?.look(dx, dy, input.sensitivity, input.invertY);
});
rpc.on('speed', ({ notches }) => camera?.adjustSpeed(notches));
rpc.on('mode', ({ mode: next } = {}) => {
  if (!camera) return;
  if (flight.active) cancelFlight('mode');
  setMode(next || (mode === 'fly' ? 'walk' : 'fly'));
});

function cancelFlight(reason) {
  flight.cancel(reason);
  flyTarget = null;
  setMode('fly');
}

/*
 * Go to a place, for a search result (see engine/flight/): up at once, off
 * the way you face, hooking towards the place and back, banking through the
 * turns, high enough to clear everything on the way, and in facing the way
 * you faced, at the same height above the ground as now; a walker lands on
 * the ground, at the nearest spot outside any building, and walks on. With
 * `instant`, there at once. The tiles under the destination are asked for at
 * the start, all levels at once, and the ground there is refined as they
 * land; the buildings around it are loaded from take-off on (the view's
 * focus moves there). Where no terrain reaches, there is nothing to stand
 * on: at least 150 m up.
 */
const destination = { height: 0, rank: -1 };
const UNCOVERED_HEIGHT = 150;
rpc.on('flyto', ({ lon, lat, elevation, label, instant = false }) => {
  if (!camera) return;
  const covered = terrain.covers(lon, lat);
  if (covered) terrain.prefetchColumn(lon, lat);
  // Best ground known there now: accurate ground or a fine tile's top, else
  // the place's own elevation, else a coarse tile's top (too high, never too
  // low), else sea level.
  let there = 0, rank = -1;
  if (covered && groundEstimate(lon, lat, destination)) { there = destination.height; rank = destination.rank; }
  if (rank < GROUND_ELEVATION && Number.isFinite(elevation)) { there = elevation; rank = GROUND_ELEVATION; }
  if (rank < 0 && covered) there = terrain.finestAt(lon, lat)?.maxHeight ?? 0;
  const above = heightAboveGround() ?? 0;
  const walk = mode === 'walk' && covered;
  let arrive = walk ? physics.eyeHeight : Math.max(physics.eyeHeight, above);
  if (!covered) arrive = Math.max(arrive, UNCOVERED_HEIGHT);
  // Exactly what is round the start, while physics still has it (and where
  // to slide to first, from under an overhang).
  obstacles.clearZones();
  const slideTo = instant ? null : prepareStart();
  setMode('fly');
  flyTarget = { covered, label };
  flight.start(camera, { lon, lat, label, covered, ground: there, rank, arrive, walk }, flightEnv, flightSettings,
    { instant: Boolean(instant), slideTo });
  resetMotion();
  arrival.ready = 1;
  arrival.counts = null;
  if (covered) preloadArrival(true);
});
rpc.on('camera', ({ state }) => {
  if (!camera) return;
  flight.cancel('placed');
  flyTarget = null;
  camera.apply(state);
  resetMotion();
  if (state.mode) setMode(state.mode);
});

/*
 * Put the walker on the ground at a place: the verification rig uses it, and
 * a "stand here" action will. The tiles under the point are all requested at
 * once, the eye starts above the best height known there (a coarse tile's
 * top only when nothing better is known), and the walk controller settles it
 * onto accurate ground once that is indexed. Where no terrain service
 * reaches, there is nothing to stand on, so the camera arrives flying just
 * above the place.
 */
rpc.on('spawn', ({ lon, lat, elevation, label }) => {
  if (!camera) return;
  flight.cancel('placed');
  flyTarget = null;
  resetMotion();
  const yaw = camera.yaw;
  const known = Number.isFinite(elevation) ? elevation : null;

  if (!terrain.covers(lon, lat)) {
    camera.apply({ lon, lat, height: (known ?? 0) + 150, yaw, pitch: -0.15 });
    setMode('fly');
    rpc.send('notice', { text: `No terrain for ${label || 'this place'} yet: only Switzerland is modelled so far.` });
    return;
  }

  terrain.prefetchColumn(lon, lat);
  // A fine tile's top is a close upper bound; a coarse one's can be a
  // mountain away, where the place's own elevation, if given, is better.
  const tile = terrain.finestAt(lon, lat);
  const guess = tile && tile.z >= TRUSTED_TOP_LEVEL ? tile.maxHeight : known ?? tile?.maxHeight ?? 1000;
  camera.apply({ lon, lat, height: guess + physics.eyeHeight, yaw, pitch: 0 });
  setMode('walk', { arrive: true });
});
rpc.on('resize', ({ width, height, dpr }) => frame?.resize(width, height, dpr));

/* For diagnosing: nothing new is requested while paused, so what remains is
 * the cost of drawing and of the selection itself. */
rpc.on('pause-streaming', ({ on }) => {
  streamingPaused = Boolean(on);
  if (scheduler) scheduler.paused = streamingPaused;
  terrain?.pause(streamingPaused);
  imagery?.pause(streamingPaused);
  for (const layer of buildings) layer.pause(streamingPaused);
});

/* An immediate snapshot, for the console handle and the verification rig.
 * The readout's twice-a-second stats are too coarse to watch a jump. */
const probeSample = groundSample();
rpc.on('probe', () => {
  const walk = controllers.walk;
  const leaf = terrain.leafAt(camera.lon, camera.lat);
  const entry = ground.entryAt(camera.lon, camera.lat);
  const under = ground.sample(camera.lon, camera.lat, probeSample);
  return {
    simTime,
    lastJump: controllers.walk.lastJump,
    jumps: controllers.walk.jumps,
    camera: camera.state(),
    motion: motionReport(),
    slope: mode === 'walk' ? Math.atan(Math.hypot(walk.here.gradE, walk.here.gradN)) / DEG : null,
    uphill: mode === 'walk' ? Math.atan2(walk.here.gradE, walk.here.gradN) : null,
    groundTiles: ground.entries.size,
    // The tile drawn under the eye, and the one physics stands on.
    leaf: leaf && {
      z: leaf.z, x: leaf.x, y: leaf.y, final: leaf.final, normals: leaf.serverNormals,
      minHeight: leaf.minHeight, maxHeight: leaf.maxHeight,
    },
    groundLevel: entry ? entry.z : null,
    // The ground physics knows under the eye (null: none yet), how often
    // fast low flight asked for the ground ahead, and a flight under way.
    physicsGround: under ? { height: probeSample.height, level: probeSample.level, accurate: probeSample.accurate } : null,
    highest: ground.highest(camera.lon, camera.lat),
    lookAheads: ahead.count,
    groundColumns: ground.columns,
    flight: flight.active || flight.arrived || flight.cancelled ? flightReport() : null,
    // Screen pixels per radian over the pixels of error allowed: a tile at
    // distance d splits while its geometric error times this exceeds d.
    errorFactor: terrain.errorFactor,
    horizon: view.horizon,
    profile: profiler.report(),
    gpu: frame.timer.enabled ? frame.timer.report() : null,
    uploads: uploads.stats,
    terrain: terrain.stats,
    imagery: imagery.stats,
    buildings: buildingStats(),
    requests: requestStats(),
    // Every building tile drawn right now, for checking decoding end to end.
    buildingTiles: buildings.flatMap((layer) => (layer.enabled ? layer.visible : []).map((node) => ({
      url: node.url, triangles: node.gpu.indexCount / 3, encoding: node.gpu.encoding, depth: node.depth,
      layer: layer.spec.id, ropes: node.gpu.cables?.ropes ?? 0, pylons: node.gpu.cables?.pylons ?? 0,
    }))),
    cables: { tiles: cablesPass?.draws.length ?? 0, ropes: cablesPass?.ropes ?? 0, pylons: cablesPass?.pylons ?? 0 },
    path: { points: pathPass?.count ?? 0, beads: pathPass?.beads ?? 0, drawn: Boolean(pathPass?.drawn), alpha: pathPass?.alpha ?? 0 },
    label: { text: labelPass?.text ?? '', drawn: Boolean(labelPass?.drawn), alpha: labelPass?.alpha ?? 0, timings: labelPass ? { ...labelPass.timings, warmUp: labelPass.warmUp } : null,
      size: labelPass ? [...labelPass.size] : null },
    // What physics touches: gathered this frame, and where the walker stands.
    solid: {
      tiles: solids.stats.tiles, triangles: solids.count,
      settled: solids.settled(view),
      // The focus round the camera: its radius while physics touches the world there, else 0.
      touch: view.touching && view.focus ? view.focus.radius : 0,
      onStructure: mode === 'walk' ? walk.onStructure : null,
      terrainBelow: mode === 'walk' ? walk.here.height : controllers.fly.sample.height,
      clearedBy: walk.clearedBy ?? null,
      // Whether the body is outside every building and clear of its walls,
      // asked of the triangles gathered around it this frame (none: clear;
      // null during a flight to a place, which gathers none).
      clear: flight.active ? null : !solids.active ||
        solids.clearAt(0, 0, camera.height - physics.eyeHeight - solids.origin.height, BODY_RADIUS, physics.bodyHeight),
      focus: buildings.map((layer) => ({ id: layer.spec.id, tiles: layer.stats.focusTiles, pending: layer.stats.focusPending })),
    },
  };
});
rpc.on('setting', ({ id, value }) => applySettings({ [id]: value }));

/* What a flight would keep clear of near a point, for the console
 * (swissgpu.bounds): each source's answer and the total. */
rpc.on('bounds', ({ lon, lat, radius = 0 }) => {
  const sample = groundSample();
  return {
    terrain: terrain.upperBound(lon, lat, radius), estimate: terrain.estimate(lon, lat, radius),
    layers: buildings.map((layer) => ({ id: layer.spec.id, bound: layer.upperBound(lon, lat, radius, Infinity),
      known: layer.knownTop(lon, lat, radius) })),
    total: obstacles.bound(lon, lat, radius), known: obstacles.known(lon, lat, radius),
    paceGround: obstacles.estimate(lon, lat, radius), zones: obstacles.zones.length,
    exactGround: ground.sample(lon, lat, sample) && sample.accurate ? sample.height : null,
  };
});

function applySettings(s) {
  if (!frame) return;
  if ('renderScale' in s) frame.setRenderScale(Number(s.renderScale));
  if ('fpsCap' in s) { frame.fpsCap = Number(s.fpsCap) || 0; frame.nextFrameAt = 0; }
  if ('gpuTiming' in s) {
    const on = Boolean(s.gpuTiming) && caps.timestamps;
    if (on && !frame.timer.enabled) frame.timer.reset();
    frame.timer.enabled = on;
  }
  if ('decodeThreads' in s && pool) pool.resize(decodeThreads(s.decodeThreads));
  if ('lookSensitivity' in s) input.sensitivity = Number(s.lookSensitivity) / 1000;
  if ('invertY' in s) input.invertY = Boolean(s.invertY);
  if ('flySpeed' in s && camera) camera.speed = Number(s.flySpeed);
  if ('debugMode' in s && frameUniforms) frameUniforms.debugMode = Number(s.debugMode) || 0;
  if ('characterHeight' in s) {
    physics.bodyHeight = Number(s.characterHeight);
    physics.eyeHeight = physics.bodyHeight * EYE_RATIO;
  }
  if ('flyThrough' in s) physics.flyThrough = Boolean(s.flyThrough);
  if ('walkSpeed' in s) physics.walkSpeed = Number(s.walkSpeed);
  if ('runSpeed' in s) physics.runSpeed = Number(s.runSpeed);
  if ('jumpHeight' in s) physics.jumpHeight = Number(s.jumpHeight);
  if ('gravity' in s) physics.gravity = Number(s.gravity);
  if ('maxSlope' in s) {
    physics.maxSlope = Number(s.maxSlope) * DEG;
    for (const world of [solids, startSolids, endSolids]) world?.setMaxSlope(physics.maxSlope);
  }
  // The search flight: playback speed, longest flight (seconds), most bank (degrees).
  if ('flightSpeed' in s) flightSettings.speed = Math.max(0.05, Number(s.flightSpeed) || 1);
  if ('longestFlight' in s) flightSettings.longest = Math.max(0.5, Number(s.longestFlight) || 10);
  if ('flightBank' in s) flightSettings.maxBank = Math.max(0, Math.min(90, Number(s.flightBank) || 0)) * DEG;
  if ('flightPath' in s) showFlightPath = s.flightPath !== false;
  if ('flightLabel' in s) showFlightLabel = s.flightLabel !== false;
  if ('imageryDetail' in s && imagery) imagery.setWindow(Number(s.imageryDetail) || 16);
  if ('imageryQuality' in s && imagery) {
    imagery.setQuality(s.imageryQuality).catch((err) => rpc.send('render-error', { message: err.message, stack: '' }));
  }
  if ('imagerySharpness' in s && imagery) imagery.setSharpness(s.imagerySharpness);
  // Distances come in kilometres; the far end of the view distance slider
  // means the horizon.
  if ('viewDistanceKm' in s) {
    const km = Number(s.viewDistanceKm);
    view.setMaxDistance(km >= 400 ? Infinity : km * 1000);
  }
  if (('terrainDetailKm' in s || 'terrainMemory' in s) && terrain) {
    terrain.configure({
      detailDistance: 'terrainDetailKm' in s ? Number(s.terrainDetailKm) * 1000 : undefined,
      budgetMB: 'terrainMemory' in s ? Number(s.terrainMemory) : undefined,
    });
  }
  for (const layer of buildings) {
    const toggle = layer.spec.setting;
    if (!(toggle in s) && !('buildingDetailKm' in s) && !('buildingDistanceKm' in s) && !('buildingMemory' in s)) continue;
    layer.configure({
      enabled: toggle in s ? Boolean(s[toggle]) : undefined,
      detailDistance: 'buildingDetailKm' in s ? Number(s.buildingDetailKm) * 1000 : undefined,
      maxDistance: 'buildingDistanceKm' in s ? Number(s.buildingDistanceKm) * 1000 : undefined,
      budgetMB: 'buildingMemory' in s ? Number(s.buildingMemory) * (layer.spec.memoryShare ?? 1) : undefined,
    });
  }
}

/** What the decode threads are doing, for the panel and the probe. */
function requestStats() {
  const s = scheduler.stats;
  let physics = 0;
  for (const job of scheduler.jobs) if (job.cls === PHYSICS) physics++;
  return {
    // Counted now, not at the last frame's turn: jobs settle between frames.
    threads: pool.size, active: scheduler.active, waiting: scheduler.waiting.length, capacity: scheduler.capacity, physics,
    started: s.started, cancelled: s.cancelled, stale: s.stale, retries: s.retries, failed: s.failed,
    throttled: s.throttled, hosts: { ...s.hosts },
    // Bytes of result buffers sent back to the decode threads to be filled again.
    recycled: scheduler.returns.sent,
    clients: Object.fromEntries(scheduler.clients.map((c) => [c.name, { active: c.active, ...c.stats }])),
  };
}

/* Decode threads for a setting value: 0 (Auto) asks the machine. */
function decodeThreads(value) {
  const n = Number(value);
  return n > 0 ? Math.min(8, Math.round(n)) : suggestedCodecThreads();
}

/** All building layers' numbers, summed, for the readout and the probe. */
function buildingStats() {
  const total = { layers: buildings.length, drawn: 0, ready: 0, pending: 0, bytes: 0, triangles: 0, failed: 0,
    solidBytes: 0, budget: 0, solidBudget: 0, detail: 1, dropped: 0, files: 0,
    filesCached: 0, filesFetched: 0, nodes: 0, deferred: 0, skipped: 0, readbacks: 0,
    encodings: { plain: 0, quantized: 0, meshopt: 0, draco: 0 } };
  for (const layer of buildings) {
    const s = layer.stats;
    total.drawn += s.drawn; total.ready += s.ready; total.pending += s.pending;
    total.bytes += s.bytes; total.triangles += s.triangles; total.failed += s.failed;
    total.solidBytes += s.solidBytes;
    total.budget += s.budget; total.solidBudget += s.solidBudget;
    total.detail = Math.min(total.detail, s.detail);
    total.dropped += s.dropped; total.files += s.files;
    total.filesCached += s.filesCached; total.filesFetched += s.filesFetched; total.nodes += s.nodes;
    total.deferred += s.deferred; total.skipped += s.skipped; total.readbacks += s.readbacks;
    for (const k in s.encodings) total.encodings[k] += s.encodings[k];
  }
  return total;
}

/* Telemetry is pushed on an interval rather than per frame: at 144 Hz a
 * per-frame postMessage would cost more page-thread time than the numbers are
 * worth. The camera rides along so the page can persist it and bias search. */
function startReporting() {
  setInterval(() => {
    if (!frame || !camera) return;
    const s = frame.stats();
    const p = profiler.report();
    const g = frame.timer.enabled ? frame.timer.report() : null;
    rpc.send('stats', {
      fps: s.fps, cpuMs: s.cpuMs, cpu99: s.cpu99,
      work: p.work, work99: p.work99, late: p.late,
      gpuMs: g ? g.frame : -1,
      width: frame.width, height: frame.height,
      wasmHeap: core.capacity, wasmUsed: core.used,
      camera: camera.state(),
      motion: motionReport(),
      view: camera.viewRect(),
      terrain: terrain.stats,
      imagery: imagery.stats,
      buildings: buildingStats(),
      requests: requestStats(),
      groundTiles: ground.entries.size,
      // For the performance panel.
      profile: p,
      gpu: g,
      draws: { terrain: terrainPass?.draws.length ?? 0, buildings: buildingsPass?.draws.length ?? 0,
        cables: cablesPass?.draws.length ?? 0 },
      triangles: { terrain: Math.round(terrainPass?.triangles ?? 0), buildings: Math.round(buildingsPass?.triangles ?? 0) },
      uploads: uploads.stats,
      ground: { tiles: ground.entries.size, bytes: ground.bytes },
      solid: { tiles: solids?.stats.tiles ?? 0, triangles: solids?.count ?? 0 },
      paused: streamingPaused,
      renderScale: frame.renderScale, dpr: frame.dpr,
    });
  }, 500);
}

/** A flight's state, for the probe: what it is doing and how it was planned. */
function flightReport() {
  const f = flight, plan = f.plan;
  return {
    active: f.active, arrived: f.arrived, landed: f.landed, phase: f.phase, cancelled: f.cancelled,
    progress: f.progress, t: f.t, duration: f.duration, rate: f.rate, waited: f.waited, elapsed: f.elapsed, heading: f.heading,
    landing: f.landing, confirmed: f.confirmed, guessed: f.guessed, ready: f.ready,
    ground: f.ground1, rank: f.rank, arrive: f.h1, walk: f.walk, to: { ...f.to }, spot: { ...f.spot },
    end: { wanted: { ...f.wanted }, moved: { ...f.moved }, corrections: f.corrections.length },
    closest: f.closest, planMs: f.planMs, cruise: f.cruise,
    obstacleCalls: obstacles?.calls ?? 0, zones: obstacles?.zones.length ?? 0, zoneMs: { ...zoneMs }, slowest: { ...slowest },
    destination: arrival.counts ? { ...arrival.counts } : null,
    plan: plan ? {
      word: plan.route.word, distance: plan.distance, length: plan.length, turns: plan.route.turns.map((a) => a / DEG),
      cruise: plan.profile.cruise, lift: plan.profile.lift, land: plan.profile.land, end: plan.endHeight,
      compress: plan.compress, natural: plan.natural, duration: plan.duration, peakTurnRate: plan.peakTurnRate / DEG,
      peakTurnAccel: plan.peakTurnAccel / DEG, peakPace: plan.peakPace, pace: plan.pace, holdTime: plan.holdTime,
      kind: plan.kind, viewIn: plan.viewIn, viewOut: plan.viewOut, spinIn: plan.spinIn, spinOut: plan.spinOut, glide: plan.glide,
    } : null,
  };
}

/** What the readout says about how you are moving. */
function motionReport() {
  if (flight.active) {
    return { mode: 'fly', state: flight.label ? `flying to ${flight.label}` : 'flying there',
      speed: flight.phase === 'flight' ? flight.pose.speed * flight.rate : 0, boosted: false,
      aboveGround: controllers.fly.aboveGround, flight: flight.progress };
  }
  if (mode === 'fly') {
    const c = controllers.fly;
    return { mode, state: 'flying', speed: camera.speed, boosted: c.sprinting, aboveGround: c.aboveGround };
  }
  const c = controllers.walk;
  const state = c.waiting ? 'waiting for ground'
    : c.arriving ? 'arriving'
    : c.falling ? 'falling'
    : !c.grounded ? 'in the air'
    : c.running && c.speed > 0.2 ? 'running'
    : c.speed > 0.2 ? 'walking' : 'standing';
  return { mode, state, speed: c.speed, boosted: false, aboveGround: c.aboveGround };
}

// Handlers are registered, so the page thread can hand over the canvas.
rpc.announce();
