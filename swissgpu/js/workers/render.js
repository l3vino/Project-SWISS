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
import { Camera } from '../engine/camera.js';
import { Terrain } from '../engine/terrain/terrain.js';
import { registry } from '../adapters/index.js';

const rpc = new Endpoint(self, 'render');

let frame = null, core = null, device = null, caps = null;
let camera = null, terrain = null, terrainPass = null, pool = null;

const input = { keys: 0, sensitivity: 0.0022, invertY: false };

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
    level: Number(settings.terrainLevel),
    radius: Number(settings.loadRadius),
  });
  const services = await terrain.prepare();

  frame = new Frame({ device, context: gpu.context, canvas, caps });
  frame.shared = { camera, terrain };
  frame.beforeFrame = (dt) => step(dt);

  frame.add(await SkyPass.create(device, { format: caps.format, timer: frame.timer }));
  terrainPass = frame.add(await TerrainPass.create(device, {
    format: caps.format, timer: frame.timer, terrain,
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
  };
});

/** One simulation step, run before the frame's passes are recorded. */
function step(dt) {
  camera.update(dt, input.keys);
  terrain.update(camera);
}

/* ---- input ---- */

rpc.on('keys', ({ mask }) => { input.keys = mask; });
rpc.on('look', ({ dx, dy }) => camera?.look(dx, dy, input.sensitivity, input.invertY));
rpc.on('speed', ({ notches }) => camera?.adjustSpeed(notches));
rpc.on('camera', ({ state }) => camera?.apply(state));
rpc.on('resize', ({ width, height, dpr }) => frame?.resize(width, height, dpr));
rpc.on('setting', ({ id, value }) => applySettings({ [id]: value }));

function applySettings(s) {
  if (!frame) return;
  if ('renderScale' in s) frame.setRenderScale(Number(s.renderScale));
  if ('fpsCap' in s) { frame.fpsCap = Number(s.fpsCap) || 0; frame.nextFrameAt = 0; }
  if ('gpuTiming' in s) frame.timer.enabled = Boolean(s.gpuTiming) && caps.timestamps;
  if ('lookSensitivity' in s) input.sensitivity = Number(s.lookSensitivity) / 1000;
  if ('invertY' in s) input.invertY = Boolean(s.invertY);
  if ('flySpeed' in s && camera) camera.speed = Number(s.flySpeed);
  if ('debugMode' in s && terrainPass) terrainPass.debugMode = Number(s.debugMode) || 0;
  if (('terrainLevel' in s || 'loadRadius' in s) && terrain) {
    terrain.configure({
      level: 'terrainLevel' in s ? Number(s.terrainLevel) : undefined,
      radius: 'loadRadius' in s ? Number(s.loadRadius) : undefined,
    });
  }
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
      sprinting: camera.sprinting,
      view: camera.viewRect(),
      terrain: terrain.stats,
    });
  }, 500);
}

// Handlers are registered, so the page thread can hand over the canvas.
rpc.announce();
