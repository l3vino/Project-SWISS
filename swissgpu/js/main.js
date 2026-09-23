/* main.js — the page thread.
 *
 * Starts the render thread, wires the interface, and then does as close to
 * nothing per frame as possible. It holds no camera, no tiles and no decode
 * pool: those all live on the render thread, which is why typing in the search
 * box cannot cost a frame.
 */

import { spawnWorker } from './core/workers.js';
import { compileCore } from './core/wasm.js';
import { Settings } from './core/settings.js';
import { Session } from './core/session.js';
import { InputBridge } from './core/input.js';
import { registry } from './adapters/index.js';
import { Boot, Readout } from './ui/hud.js';
import { Search } from './ui/search.js';
import { SettingsPanel } from './ui/settings-panel.js';

const boot = new Boot();
boot.step('gpu', 'Checking WebGPU');
boot.step('wasm', 'Compiling native core');
boot.step('threads', 'Starting threads');
boot.step('render', 'Opening the view');

const settings = new Settings();
const session = new Session();
const readout = new Readout();

/** Latest state pushed up from the render thread. */
const live = { camera: null, view: null };

start().catch((err) => {
  console.error(err);
  boot.fail(err.message, 'Reload once the cause is fixed.');
});

async function start() {
  boot.mark('gpu', 'active');
  if (!navigator.gpu) {
    boot.mark('gpu', 'failed', 'WebGPU is unavailable');
    throw new Error('This browser has no WebGPU. Use Chrome or Edge 113+ on desktop.');
  }
  boot.mark('gpu', 'done', 'WebGPU available');

  boot.mark('wasm', 'active');
  const wasmModule = await compileCore();
  boot.mark('wasm', 'done', 'Native core compiled');

  boot.mark('threads', 'active');
  let render;
  try {
    render = await spawnWorker(new URL('./workers/render.js', import.meta.url), 'render');
  } catch (err) {
    boot.mark('threads', 'failed', 'The render thread could not start');
    throw new Error(`${err.message} Serve the folder over http, not from a file:// path.`);
  }

  render.on('stats', onStats);
  render.on('device-lost', ({ message }) => {
    boot.fail(`The GPU device was lost: ${message}`, 'Reload to recover.');
  });
  render.on('gpu-error', ({ message }) => console.error('[gpu]', message));
  render.onfail = (err) => boot.fail(`The render thread stopped: ${err.message}`, 'Reload to restart it.');

  boot.mark('render', 'active');
  const canvasEl = document.getElementById('view');
  const offscreen = canvasEl.transferControlToOffscreen();

  const info = await render.request('init', {
    canvas: offscreen,
    wasmModule,
    settings: settings.snapshot(),
    size: viewportSize(),
    camera: startingCamera(),
  }, [offscreen], { timeout: 25000 });

  boot.mark('threads', 'done', `${info.codecThreads} decode + 1 render (${info.spawnMode})`);
  boot.mark('render', 'done', info.gpu);

  buildReadout(info);
  wireInterface(render, canvasEl);

  const sendSize = () => render.send('resize', viewportSize());
  new ResizeObserver(sendSize).observe(document.documentElement);
  addEventListener('resize', sendSize);

  console.info('[swissgpu]', {
    gpu: info.gpu, features: info.features, blockCompression: info.bc,
    gpuTimestamps: info.timestamps, wasm: info.wasm,
    threads: `${info.codecThreads} decode (${info.spawnMode})`,
    adapters: registry.all.map((a) => a.id),
    terrainServices: info.services,
  });

  boot.done();
}

/**
 * Where to begin: the last place you were, a home you pinned, or whatever the
 * adapter suggests. Each falls back to the next, so a cleared browser or a
 * saved position in a country that is no longer registered still starts well.
 */
function startingCamera() {
  if (settings.get('spawn') === 'last') {
    const saved = session.camera(registry);
    if (saved) return saved;
  }
  const home = settings.get('home');
  if (home && registry.forPoint(home.lon, home.lat)) {
    return { lon: home.lon, lat: home.lat, height: home.height, yaw: home.yaw ?? 0, pitch: -0.28 };
  }
  const fallback = registry.all.find((a) => a.home)?.home;
  if (!fallback) throw new Error('No adapter declares a home, and nothing was saved.');
  return { lon: fallback.lon, lat: fallback.lat, height: fallback.height, pitch: -0.28 };
}

function wireInterface(render, canvasEl) {
  new SettingsPanel(settings);
  const hint = document.getElementById('lock-hint');
  const crosshair = document.getElementById('crosshair');

  const input = new InputBridge(canvasEl, render, {
    captureKeys: settings.get('captureKeys'),
    onLockChange(locked) {
      hint.hidden = locked;
      crosshair.hidden = !locked;
    },
  });
  settings.on('captureKeys', (v) => input.setCapture(v));

  settings.on('showTelemetry', (v) => readout.visible(v));
  settings.on('*', (value, id) => render.send('setting', { id, value }));
  readout.visible(settings.get('showTelemetry'));

  settings.onAction('setHome', () => {
    if (!live.camera) return;
    const { lon, lat, height, yaw } = live.camera;
    settings.set('home', { lon, lat, height, yaw });
  });

  new Search(registry, {
    view: () => live.view,
    onPick(place) {
      // Smooth flight arrives in step 5; for now the camera is placed with a
      // sensible altitude and left pointing north.
      render.send('camera', {
        state: { lon: place.lon, lat: place.lat, height: 4000, yaw: 0, pitch: -0.35 },
      });
    },
  });
}

function onStats(stats) {
  live.camera = stats.camera;
  live.view = stats.view;
  updateCredits(stats.view);
  session.record(stats.camera);
  readout.update(stats);
}

/** Whoever's data is on screen gets named, and only while it is. */
let creditsShown = '';
function updateCredits(view) {
  if (!view) return;
  const credits = registry.credits(view);
  const key = credits.map((c) => c.label).join('|');
  if (key === creditsShown) return;
  creditsShown = key;

  const el = document.getElementById('attribution');
  el.replaceChildren();
  credits.forEach((c, i) => {
    if (i) el.append(' · ');
    if (!c.url) { el.append(c.label); return; }
    const a = document.createElement('a');
    a.href = c.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = c.label;
    el.append(a);
  });
}

function viewportSize() {
  return {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    dpr: Math.min(devicePixelRatio || 1, 2),
  };
}

function buildReadout(info) {
  readout.row('position', 'position');
  readout.row('altitude', 'altitude');
  readout.row('speed', 'speed');
  readout.row('tiles', 'tiles');
  readout.rule();
  readout.row('fps', 'frames');
  readout.row('cpu', 'cpu');
  readout.row('worst', 'cpu 99th');
  readout.row('gpu', 'gpu');
  readout.rule();
  readout.row('res', 'buffer');
  readout.row('heap', 'wasm heap');
  readout.row('device', 'device');

  readout.set('device', info.gpu.length > 26 ? `${info.gpu.slice(0, 25)}…` : info.gpu);
}
