/* frame.js — render targets, the loop, and the frame clock.
 *
 * Owns everything that has to be rebuilt when the window or the render scale
 * changes, and nothing that has to be rebuilt per frame. Passes are recorded in
 * order into a single command encoder, so the whole frame is one submit.
 */

import { DEPTH_FORMAT, GpuTimer } from './gpu.js';

export class Frame {
  constructor({ device, context, canvas, caps }) {
    this.device = device;
    this.context = context;
    this.canvas = canvas;
    this.caps = caps;

    this.timer = new GpuTimer(device);
    this.passes = [];

    this.cssWidth = 1;
    this.cssHeight = 1;
    this.renderScale = 1;
    this.dpr = 1;
    this.width = 1;
    this.height = 1;
    this.depth = null;

    this.running = false;
    this.frameId = 0;
    this.startTime = performance.now();
    this.lastTime = this.startTime;

    // Frame times as a ring buffer: a fixed allocation, no array churn, and a
    // percentile is more honest about stutter than an average.
    this.history = new Float32Array(120);
    this.historyAt = 0;

    this.fpsCap = 0;
    this.nextFrameAt = 0;
    this.onStats = null;
    this.onError = null;

    // State the render thread owns and every pass may read. Copied into one
    // reused payload each frame, so passes never reach back into the worker
    // and a frame allocates nothing for them.
    this.shared = {};
    this.payload = {};
    this.beforeFrame = null;
    this.profiler = null;
    this.interval = 0;
  }

  add(pass) { this.passes.push(pass); return pass; }

  /** CSS pixels from the page, multiplied by the render scale for the backbuffer. */
  resize(cssWidth, cssHeight, dpr = 1) {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.dpr = dpr;
    this.#applySize();
  }

  setRenderScale(scale) {
    this.renderScale = scale;
    this.#applySize();
  }

  #applySize() {
    const max = this.caps.maxTextureSize;
    const w = Math.min(max, Math.max(1, Math.round(this.cssWidth * this.dpr * this.renderScale)));
    const h = Math.min(max, Math.max(1, Math.round(this.cssHeight * this.dpr * this.renderScale)));
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    this.depth?.destroy();
    this.depth = this.device.createTexture({
      label: 'depth',
      size: [w, h],
      format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.depthView = this.depth.createView();

    for (const p of this.passes) p.resize?.(w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.#schedule();
  }

  stop() {
    this.running = false;
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId);
  }

  #schedule() {
    // Dedicated workers implement requestAnimationFrame for OffscreenCanvas,
    // which keeps the loop synced to the compositor. Fall back only if absent.
    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame((t) => this.#tick(t));
    } else {
      setTimeout(() => this.#tick(performance.now()), 16);
    }
  }

  #tick(now) {
    if (!this.running) return;

    // Frame limiting by skipping presents rather than by sleeping, so the
    // loop stays aligned to vsync and input latency does not creep up.
    if (this.fpsCap > 0 && now < this.nextFrameAt) { this.#schedule(); return; }
    if (this.fpsCap > 0) {
      const period = 1000 / this.fpsCap;
      this.nextFrameAt = Math.max(now, this.nextFrameAt + period);
      if (this.nextFrameAt - now > period) this.nextFrameAt = now + period;
    }

    this.interval = now - this.lastTime;
    const dt = Math.min(0.1, this.interval / 1000);
    this.lastTime = now;
    this.frameId++;

    try {
      this.render(now, dt);
    } catch (err) {
      // An exception here would otherwise end the loop silently: the next
      // frame is never scheduled and the last image just stays on screen.
      this.running = false;
      this.onError?.(err);
      return;
    }

    // Wall time between the last two frame starts is the number that matches
    // what the display actually showed; time spent inside render() alone is not.
    this.history[this.historyAt] = Math.max(dt * 1000, performance.now() - now);
    this.historyAt = (this.historyAt + 1) % this.history.length;

    this.#schedule();
  }

  render(now, dt) {
    const time = (now - this.startTime) / 1000;
    const prof = this.profiler;
    prof?.begin(this.interval);
    this.beforeFrame?.(dt, time);
    const colorView = this.context.getCurrentTexture().createView();

    this.timer.begin();
    const encoder = this.device.createCommandEncoder({ label: `frame-${this.frameId}` });

    const payload = Object.assign(this.payload, this.shared);
    payload.width = this.width; payload.height = this.height; payload.time = time; payload.dt = dt;
    for (const pass of this.passes) {
      pass.update?.(payload);
      pass.record(encoder, colorView, this.depthView);
    }
    prof?.lap('draw');

    const ticket = this.timer.resolveInto(encoder);
    this.device.queue.submit([encoder.finish()]);
    if (ticket) this.timer.collect(ticket);
    prof?.lap('submit');
    prof?.end();
  }

  /** Mean and 99th-percentile CPU frame time over the ring buffer. */
  stats() {
    const h = this.history;
    let sum = 0, n = 0;
    const sorted = [];
    for (let i = 0; i < h.length; i++) {
      if (h[i] > 0) { sum += h[i]; n++; sorted.push(h[i]); }
    }
    if (!n) return { fps: 0, cpuMs: 0, cpu99: 0 };
    sorted.sort((a, b) => a - b);
    const mean = sum / n;
    return {
      fps: mean > 0 ? 1000 / mean : 0,
      cpuMs: mean,
      cpu99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
    };
  }
}
