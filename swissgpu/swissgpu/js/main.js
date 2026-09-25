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
import { Boot, Readout, Toast } from './ui/hud.js';
import { Search } from './ui/search.js';
import { Menu, keyLabel } from './ui/menu.js';

const boot = new Boot();
boot.step('gpu', 'Checking WebGPU');
boot.step('wasm', 'Compiling native core');
boot.step('threads', 'Starting threads');
boot.step('render', 'Opening the view');

const settings = new Settings();
const session = new Session();
const readout = new Readout();
const toast = new Toast();

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
  render.on('notice', ({ text }) => toast.show(text));
  render.on('device-lost', ({ message }) => {
    boot.fail(`The GPU device was lost: ${message}`, 'Reload to recover.');
  });
  render.on('gpu-error', ({ message }) => console.error('[gpu]', message));
  render.on('render-error', ({ message, stack }) => {
    console.error(`[render] ${message}\n${stack}`);
    boot.fail(`Rendering stopped: ${message}`, 'Reload to restart it.');
  });
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

  // A handle for the browser console and the verification rig:
  // swissgpu.probe() shows the physics state now, swissgpu.send() drives it.
  globalThis.swissgpu = Object.freeze({
    send: (type, payload) => render.send(type, payload),
    probe: () => render.request('probe', null, undefined, { timeout: 2000 }),
    get stats() { return live.stats; },
  });

  const sendSize = () => render.send('resize', viewportSize());
  new ResizeObserver(sendSize).observe(document.documentElement);
  addEventListener('resize', sendSize);

  console.info('[swissgpu]', {
    gpu: info.gpu, features: info.features, blockCompression: info.bc,
    gpuTimestamps: info.timestamps, wasm: info.wasm,
    threads: `${info.codecThreads} decode (${info.spawnMode})`,
    adapters: registry.all.map((a) => a.id),
    terrainServices: info.services,
    imagery: info.imagery,
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
  const hint = document.getElementById('lock-hint');
  const crosshair = document.getElementById('crosshair');

  // Opening the menu hands the mouse back; closing it leaves the next click
  // on the view to take it again.
  const menu = new Menu(settings, {
    onOpen: () => { if (document.pointerLockElement) document.exitPointerLock(); },
  });
  const pressAction = (action) => {
    if (action === 'menu') menu.toggle();
    else if (action === 'readout') settings.set('showTelemetry', !settings.get('showTelemetry'));
  };

  const input = new InputBridge(canvasEl, render, {
    bindings: settings.get('keybinds'),
    captureKeys: settings.get('captureKeys'),
    doubleTapMs: settings.get('doubleTapMs'),
    onAction: pressAction,
    onLockChange(locked) {
      hint.hidden = locked;
      crosshair.hidden = !locked;
    },
  });
  settings.on('captureKeys', (v) => input.setCapture(v));
  settings.on('doubleTapMs', (v) => input.setDoubleTap(v));
  settings.on('keybinds', (v) => { input.setBindings(v); showKeyHint(hint, v); });
  showKeyHint(hint, settings.get('keybinds'));

  // The press actions also work with the mouse free, except while typing.
  addEventListener('keydown', (e) => {
    if (document.pointerLockElement || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const binds = settings.get('keybinds');
    for (const action of ['menu', 'readout']) {
      if ((binds[action] || []).includes(e.code)) { e.preventDefault(); pressAction(action); }
    }
  });

  settings.on('showTelemetry', (v) => readout.visible(v));
  settings.on('units', (v) => readout.setUnits(v));
  settings.on('*', (value, id) => render.send('setting', { id, value }));
  readout.visible(settings.get('showTelemetry'));
  readout.setUnits(settings.get('units'));

  settings.onAction('setHome', () => {
    if (!live.camera) return;
    const { lon, lat, height, yaw } = live.camera;
    settings.set('home', { lon, lat, height, yaw });
  });

  new Search(registry, {
    view: () => live.view,
    onPick(place) {
      // A smooth flight there, ending standing on the ground in walking
      // mode; where there is no terrain it arrives flying and says why. With
      // the flight turned off in Settings, straight there instead.
      render.send(settings.get('flyToResults') ? 'flyto' : 'spawn', {
        lon: place.lon, lat: place.lat,
        elevation: Number.isFinite(place.elevation) ? place.elevation : null,
        label: place.label,
      });
    },
  });
}

/* The strip along the bottom, from the current key table. */
function showKeyHint(el, binds) {
  const k = (action) => (binds[action] || []).filter(Boolean).map(keyLabel)[0] || '—';
  const move = ['forward', 'left', 'back', 'right'].map(k).join('');
  const parts = [
    ['', 'Click to start'],
    [move.length === 4 ? move : `${k('forward')} ${k('left')} ${k('back')} ${k('right')}`, 'move'],
    [k('up'), 'jump / up'],
    [k('down'), 'down'],
    [`${k('up')} ×2`, 'walk / fly'],
    [k('sprint'), 'run'],
    ['Scroll', 'speed'],
    [k('menu'), 'settings'],
    ['Esc', 'release'],
  ];
  el.replaceChildren();
  parts.forEach(([key, what], i) => {
    if (i) el.append(' · ');
    const span = document.createElement('span');
    if (key) { const b = document.createElement('b'); b.textContent = key; span.append(b, ` ${what}`); }
    else span.textContent = what;
    el.append(span);
  });
}

function onStats(stats) {
  live.stats = stats;
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
  readout.row('mode', 'motion');
  readout.row('position', 'position');
  readout.row('altitude', 'altitude');
  readout.row('ground', 'above ground');
  readout.row('speed', 'speed');
  readout.row('tiles', 'terrain');
  readout.row('levels', 'detail');
  readout.row('buildings', 'buildings');
  readout.row('imagery', 'imagery');
  readout.row('sharpest', 'sharpest');
  readout.rule();
  readout.row('fps', 'frames');
  readout.row('cpu', 'work');
  readout.row('worst', 'late frames');
  readout.row('gpu', 'gpu');
  readout.rule();
  readout.row('res', 'buffer');
  readout.row('heap', 'wasm heap');
  readout.row('device', 'device');

  readout.set('device', info.gpu.length > 26 ? `${info.gpu.slice(0, 25)}…` : info.gpu);
}
