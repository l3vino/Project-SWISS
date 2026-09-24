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
import { initGPU } from '../engine/gpu.js';
import { Frame } from '../engine/frame.js';
import { SkyPass } from '../engine/passes/sky.js';
import { TerrainPass } from '../engine/passes/terrain.js';
import { BuildingsPass } from '../engine/passes/buildings.js';
import { FrameUniforms } from '../engine/passes/frame-uniforms.js';
import { Tileset } from '../engine/features/tileset.js';
import { SolidWorld } from '../engine/features/solid.js';
import { View } from '../engine/view.js';
import { Camera, FOV_Y } from '../engine/camera.js';
import { Clipmap } from '../engine/imagery/clipmap.js';
import { Terrain } from '../engine/terrain/terrain.js';
import { Ground } from '../engine/terrain/ground.js';
import { FlyController } from '../engine/controllers/fly.js';
import { WalkController, BODY_RADIUS } from '../engine/controllers/walk.js';
import { DEG } from '../core/math.js';
import { registry } from '../adapters/index.js';

const rpc = new Endpoint(self, 'render');

let frame = null, core = null, device = null, caps = null;
let camera = null, terrain = null, pool = null, ground = null, imagery = null;
let frameUniforms = null;
const view = new View();
/* Streamed 3D Tiles layers drawn as buildings (buildings, bridges and other
 * structures), and the collision world built from them. */
let buildings = [];
let solids = null;

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

/* Around the walker, and around a flyer this close to the ground, every
 * building tile is loaded in full detail, on screen or not, and solid. The
 * radius is also how far an arrival may be moved to get clear of buildings,
 * and how long it waits for them before standing anyway. */
const FOCUS_RADIUS = 60;
const FOCUS_HEIGHT = 150;
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

rpc.on('init', async ({ canvas, wasmModule, settings, size, camera: startCamera }) => {
  core = instantiateCore(wasmModule);
  const failure = core.selftest();
  if (failure !== 0) throw new Error(`wasm core self-test failed with code ${failure}`);

  // The decode threads are children of this one, so a finished tile lands
  // directly where its GPU buffers are created.
  const codecCount = suggestedCodecThreads();
  pool = await WorkerPool.create(new URL('./codec.js', import.meta.url), codecCount, 'codec');
  await pool.all('init', { wasmModule }, { timeout: 15000 });

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
    device, pool, registry,
    maxError: Number(settings.terrainDetail) || 2,
    budgetMB: Number(settings.terrainMemory) || 256,
  });
  ground = new Ground({ terrain, pool });
  imagery = new Clipmap({ device, pool, registry, caps, window: Number(settings.imageryDetail) || 16 });
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

  frameUniforms = new FrameUniforms(device);
  frame.add(await SkyPass.create(device, { format: caps.format, timer: frame.timer }));
  frame.add(await TerrainPass.create(device, {
    format: caps.format, timer: frame.timer, terrain, imagery, frame: frameUniforms,
  }));

  // Every adapter's building layer. Their tileset descriptions load in the
  // background: the terrain does not wait for buildings to appear.
  // Each layer answers to its own switch in Layers, and takes its share of
  // the building memory setting.
  buildings = registry.all.flatMap((adapter) => adapter.features
    .filter((f) => f.kind === 'buildings' && f.tileset)
    .map((spec) => new Tileset({
      device, pool, spec: { ...spec, id: `${adapter.id}/${spec.id}`, setting: spec.setting || 'buildings' },
      maxError: Number(settings.buildingDetail) || spec.maxError || 10,
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
  frame.add(await BuildingsPass.create(device, {
    format: caps.format, timer: frame.timer, tilesets: buildings, imagery, frame: frameUniforms,
  }));

  applySettings(settings);
  frame.resize(size.width, size.height, size.dpr);
  frame.start();
  startReporting();

  return {
    gpu: caps.description,
    vendor: caps.vendor,
    features: [...caps.features],
    maxTextureSize: caps.maxTextureSize,
    timestamps: caps.timestamps,
    bc: caps.bc,
    wasm: core.version,
    codecThreads: codecCount,
    spawnMode: pool.spawnMode,
    services,
    imagery: imageryInfo,
  };
});

/** One simulation step, run before the frame's passes are recorded. */
function step(dt) {
  const controller = controllers[mode];
  gatherSolids(dt);
  const n = Math.max(1, Math.ceil(dt * PHYSICS_HZ));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    // A press acts once, on the first substep.
    controller.step(h, input.keys, i === 0 ? input.pressed : 0, camera, ground, physics, solids);
  }
  input.pressed = 0;
  simTime += dt;
  clearArrival();
  // The view the frame is about to draw decides which tiles exist, and the
  // tiles decide what the ground index and imagery need.
  view.update(camera, {
    viewHeight: frame.height, fovY: FOV_Y, aspect: frame.width / Math.max(1, frame.height), near: NEAR,
  }, terrain.finestAt(camera.lon, camera.lat)?.minHeight ?? 0);
  // Physics needs everything around the body loaded, seen or not.
  const touching = mode === 'walk' || (!physics.flyThrough && (heightAboveGround() ?? Infinity) < FOCUS_HEIGHT);
  view.setFocus(touching ? camera.lon : null, camera.lat, FOCUS_RADIUS);
  frameUniforms.update(camera, view, NEAR);
  terrain.update(view);
  for (const layer of buildings) layer.update(view);
  ground.update(camera, mode === 'walk');
  imagery.update(camera, {
    aboveGround: heightAboveGround(),
    viewHeight: frame.height,
    fovY: FOV_Y,
    // Imagery beyond the farthest drawn terrain is never fetched.
    reach: Math.max(terrain.reach, 20000),
  });
  watchArrival();
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
    : camera.speed * 3;
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
  input.pressed |= mask & ~input.keys;
  input.keys = mask;
});
rpc.on('look', ({ dx, dy }) => camera?.look(dx, dy, input.sensitivity, input.invertY));
rpc.on('speed', ({ notches }) => camera?.adjustSpeed(notches));
rpc.on('mode', ({ mode: next } = {}) => camera && setMode(next || (mode === 'fly' ? 'walk' : 'fly')));
rpc.on('camera', ({ state }) => {
  if (!camera) return;
  camera.apply(state);
  if (state.mode) setMode(state.mode);
});

/*
 * Put the walker on the ground at a place, for a search result. The tiles
 * under the point are all requested at once, the eye starts above the best
 * height known there, and the walk controller settles it onto the final
 * ground as detail arrives. Where no terrain service reaches, there is
 * nothing to stand on, so the camera arrives flying just above the place.
 */
rpc.on('spawn', ({ lon, lat, elevation, label }) => {
  if (!camera) return;
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
  const guess = tile && tile.z >= 12 ? tile.maxHeight : known ?? tile?.maxHeight ?? 1000;
  camera.apply({ lon, lat, height: guess + physics.eyeHeight, yaw, pitch: 0 });
  setMode('walk', { arrive: true });
});
rpc.on('resize', ({ width, height, dpr }) => frame?.resize(width, height, dpr));

/* An immediate snapshot, for the console handle and the verification rig.
 * The readout's twice-a-second stats are too coarse to watch a jump. */
rpc.on('probe', () => {
  const walk = controllers.walk;
  const leaf = terrain.leafAt(camera.lon, camera.lat);
  const entry = ground.entryAt(camera.lon, camera.lat);
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
    // Screen pixels per radian over the pixels of error allowed: a tile at
    // distance d splits while its geometric error times this exceeds d.
    errorFactor: terrain.errorFactor,
    terrain: terrain.stats,
    imagery: imagery.stats,
    buildings: buildingStats(),
    // Every building tile drawn right now, for checking decoding end to end.
    buildingTiles: buildings.flatMap((layer) => (layer.enabled ? layer.visible : []).map((node) => ({
      url: node.url, triangles: node.gpu.indexCount / 3, encoding: node.gpu.encoding, depth: node.depth,
      layer: layer.spec.id,
    }))),
    // What physics touches: gathered this frame, and where the walker stands.
    solid: {
      tiles: solids.stats.tiles, triangles: solids.count,
      settled: solids.settled(view),
      onStructure: mode === 'walk' ? walk.onStructure : null,
      terrainBelow: mode === 'walk' ? walk.here.height : controllers.fly.sample.height,
      clearedBy: walk.clearedBy ?? null,
      focus: buildings.map((layer) => ({ id: layer.spec.id, tiles: layer.stats.focusTiles, pending: layer.stats.focusPending })),
    },
  };
});
rpc.on('setting', ({ id, value }) => applySettings({ [id]: value }));

function applySettings(s) {
  if (!frame) return;
  if ('renderScale' in s) frame.setRenderScale(Number(s.renderScale));
  if ('fpsCap' in s) { frame.fpsCap = Number(s.fpsCap) || 0; frame.nextFrameAt = 0; }
  if ('gpuTiming' in s) frame.timer.enabled = Boolean(s.gpuTiming) && caps.timestamps;
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
    solids?.setMaxSlope(physics.maxSlope);
  }
  if ('imageryDetail' in s && imagery) imagery.setWindow(Number(s.imageryDetail) || 16);
  if (('terrainDetail' in s || 'terrainMemory' in s) && terrain) {
    terrain.configure({
      maxError: 'terrainDetail' in s ? Number(s.terrainDetail) : undefined,
      budgetMB: 'terrainMemory' in s ? Number(s.terrainMemory) : undefined,
    });
  }
  for (const layer of buildings) {
    const toggle = layer.spec.setting;
    if (!(toggle in s) && !('buildingDetail' in s) && !('buildingMemory' in s)) continue;
    layer.configure({
      enabled: toggle in s ? Boolean(s[toggle]) : undefined,
      maxError: 'buildingDetail' in s ? Number(s.buildingDetail) : undefined,
      budgetMB: 'buildingMemory' in s ? Number(s.buildingMemory) * (layer.spec.memoryShare ?? 1) : undefined,
    });
  }
}

/** All building layers' numbers, summed, for the readout and the probe. */
function buildingStats() {
  const total = { layers: buildings.length, drawn: 0, ready: 0, pending: 0, bytes: 0, triangles: 0, failed: 0,
    solidBytes: 0, encodings: { plain: 0, quantized: 0, meshopt: 0, draco: 0 } };
  for (const layer of buildings) {
    const s = layer.stats;
    total.drawn += s.drawn; total.ready += s.ready; total.pending += s.pending;
    total.bytes += s.bytes; total.triangles += s.triangles; total.failed += s.failed;
    total.solidBytes += s.solidBytes;
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
    rpc.send('stats', {
      fps: s.fps, cpuMs: s.cpuMs, cpu99: s.cpu99,
      gpuMs: frame.timer.enabled ? frame.timer.total() : -1,
      width: frame.width, height: frame.height,
      wasmHeap: core.capacity, wasmUsed: core.used,
      camera: camera.state(),
      motion: motionReport(),
      view: camera.viewRect(),
      terrain: terrain.stats,
      imagery: imagery.stats,
      buildings: buildingStats(),
      groundTiles: ground.entries.size,
    });
  }, 500);
}

/** What the readout says about how you are moving. */
function motionReport() {
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
