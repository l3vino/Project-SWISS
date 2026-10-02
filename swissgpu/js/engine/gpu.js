/* gpu.js — adapter and device negotiation, plus pass timing.
 *
 * Runs inside the render worker. Features are requested opportunistically:
 * every one of them is optional, and `caps` records what we actually got so
 * later passes can branch once at build time instead of per frame.
 */

/** Requested in preference order; missing ones are simply not enabled. */
const WANTED_FEATURES = [
  // Block-compressed textures. Aerial imagery as BC1 costs 32 KB per 256px
  // tile instead of 256 KB, which decides how much of the country fits in VRAM.
  'texture-compression-bc',
  // Per-pass GPU timings, so optimisation targets measurements not guesses.
  'timestamp-query',
  // Linear filtering of float32 textures, used by the atmosphere LUTs later.
  'float32-filterable',
  // Lets the depth prepass share a buffer with stencil-based masking.
  'depth32float-stencil8',
  // Half-float arithmetic in shaders: less register pressure, more occupancy.
  'shader-f16',
];

export async function initGPU(canvas, { powerPreference = 'high-performance' } = {}) {
  if (!navigator.gpu) throw new Error('This browser has no WebGPU. Chrome 113+ or Edge on desktop.');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference });
  if (!adapter) throw new Error('No GPU adapter. If you are on a laptop, check the discrete GPU is enabled for the browser.');

  const features = WANTED_FEATURES.filter((f) => adapter.features.has(f));

  // Ask for the adapter's real ceilings on the limits that gate large scenes.
  // Requesting the default and discovering the cap mid-flight is how streaming
  // engines end up silently capped at a fraction of the hardware.
  const l = adapter.limits;
  const requiredLimits = {
    maxBufferSize: l.maxBufferSize,
    maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
    maxTextureDimension2D: l.maxTextureDimension2D,
    maxTextureArrayLayers: l.maxTextureArrayLayers,
    maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
  };

  const device = await adapter.requestDevice({
    label: 'swissgpu',
    requiredFeatures: features,
    requiredLimits,
  });

  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const info = adapter.info || {};
  const caps = {
    format,
    features: new Set(features),
    bc: features.includes('texture-compression-bc'),
    timestamps: features.includes('timestamp-query'),
    f16: features.includes('shader-f16'),
    maxTextureSize: l.maxTextureDimension2D,
    maxBufferSize: l.maxBufferSize,
    vendor: info.vendor || 'unknown',
    architecture: info.architecture || '',
    description: [info.vendor, info.architecture, info.device].filter(Boolean).join(' ') || 'GPU',
    adapter: describeAdapter(adapter, powerPreference),
  };

  return { adapter, device, context, caps };
}

/**
 * Everything the browser says about the adapter it picked, for the
 * performance panel and its report. Browsers deliberately say little (empty
 * strings for what they withhold), and Chrome says more with its WebGPU
 * developer features flag on; the strings are shown exactly as given, since
 * they are what tells which GPU really runs the app on a laptop with two.
 */
function describeAdapter(adapter, powerPreference) {
  const info = adapter.info || {};
  const pick = (k) => (typeof info[k] === 'string' ? info[k] : '');
  const l = adapter.limits;
  return {
    vendor: pick('vendor'),
    architecture: pick('architecture'),
    device: pick('device'),
    description: pick('description'),
    type: pick('type'),
    backend: pick('backend'),
    driver: pick('driver'),
    fallback: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter),
    powerPreference,
    features: [...adapter.features].sort(),
    limits: {
      maxTextureDimension2D: l.maxTextureDimension2D,
      maxTextureArrayLayers: l.maxTextureArrayLayers,
      maxBufferSize: l.maxBufferSize,
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: l.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: l.maxComputeInvocationsPerWorkgroup,
    },
  };
}

/** Reverse-Z: near is 1, the horizon is 0, and depth clears to 0. */
export const DEPTH_FORMAT = 'depth32float';
export const DEPTH_CLEAR = 0.0;
export const DEPTH_COMPARE = 'greater';

/**
 * Rolling GPU timer.
 *
 * Timestamps are written into a query set, resolved into a buffer, then read
 * back through a small pool of staging buffers. The pool matters: mapping the
 * same buffer every frame would make the CPU wait on the GPU, which is exactly
 * the stall we are trying to measure. A frame whose staging buffers are all
 * still in use simply goes unmeasured.
 *
 * Besides each pass, the whole frame is measured: from the first pass's start
 * to the last one's end, gaps included, which is what decides the frame rate
 * when the GPU is the bottleneck. Frame times are kept for percentiles, pass
 * times as running averages. Browsers round timestamps (Chrome to 100 µs
 * unless its WebGPU developer features are on), plenty for milliseconds.
 */
const FRAME_HISTORY = 512;

export class GpuTimer {
  constructor(device, { capacity = 10, pool = 3 } = {}) {
    this.device = device;
    this.enabled = false;
    this.available = device.features.has('timestamp-query');
    this.means = new Map();                  // pass name -> smoothed milliseconds
    this.names = [];
    this.frames = new Float32Array(FRAME_HISTORY);
    this.framesAt = 0;
    this.framesCount = 0;
    this.sorted = new Float32Array(FRAME_HISTORY);

    if (!this.available) return;

    this.enabled = true;
    this.capacity = capacity * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.capacity, label: 'pass-timings' });
    this.resolve = device.createBuffer({
      size: this.capacity * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'timestamp-resolve',
    });
    // Each staging buffer travels with the pass names it was recorded for.
    this.free = Array.from({ length: pool }, () => ({
      buf: device.createBuffer({ size: this.capacity * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      names: [],
    }));
  }

  /** Call before recording passes. */
  begin() { this.names.length = 0; }

  /** Timestamp writes to hand to a render or compute pass descriptor. */
  writes(name) {
    if (!this.enabled || this.names.length * 2 >= this.capacity) return undefined;
    const i = this.names.length;
    this.names.push(name);
    // The same descriptor for a slot every frame: nothing allocated per pass.
    this.slots ??= [];
    return this.slots[i] ??= { querySet: this.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  /** Record the resolve into the frame's command encoder. */
  resolveInto(encoder) {
    if (!this.enabled || this.names.length === 0) return null;
    const ticket = this.free.pop();
    if (!ticket) return null; // every staging buffer is still mapped: skip this frame
    encoder.resolveQuerySet(this.querySet, 0, this.names.length * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, ticket.buf, 0, this.names.length * 8 * 2);
    ticket.names.length = 0;
    for (const n of this.names) ticket.names.push(n);
    return ticket;
  }

  /** Read back without blocking; results land a frame or two later. */
  async collect(ticket) {
    if (!ticket) return;
    const { buf, names } = ticket;
    try {
      await buf.mapAsync(GPUMapMode.READ);
      // Nanoseconds as two 32-bit halves: exact as a Number for months,
      // and no BigInt per value.
      const w = new Uint32Array(buf.getMappedRange(0, names.length * 16));
      const at = (i) => w[i * 2 + 1] * 4294967296 + w[i * 2];
      for (let i = 0; i < names.length; i++) {
        const ms = (at(i * 2 + 1) - at(i * 2)) / 1e6;
        if (!(ms >= 0 && ms < 1000)) continue;
        const m = this.means.get(names[i]);
        this.means.set(names[i], m === undefined ? ms : m + (ms - m) * 0.1);
      }
      const span = (at(names.length * 2 - 1) - at(0)) / 1e6;
      if (span >= 0 && span < 1000) {
        this.frames[this.framesAt] = span;
        this.framesAt = (this.framesAt + 1) % FRAME_HISTORY;
        this.framesCount = Math.min(FRAME_HISTORY, this.framesCount + 1);
      }
      buf.unmap();
    } catch { /* device lost or buffer destroyed */ }
    this.free.push(ticket);
  }

  /** Whole-frame GPU time, milliseconds: mean and percentiles of recent frames. */
  report() {
    const n = this.framesCount;
    const out = { frame: -1, frame95: -1, frame99: -1, passes: Object.fromEntries(this.means) };
    if (!this.enabled || !n) return out;
    const s = this.sorted.subarray(0, n);
    s.set(this.frames.subarray(0, n));
    s.sort();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += s[i];
    out.frame = sum / n;
    out.frame95 = s[Math.min(n - 1, Math.floor(n * 0.95))];
    out.frame99 = s[Math.min(n - 1, Math.floor(n * 0.99))];
    return out;
  }

  /** Forget what was measured, e.g. after timing was switched back on. */
  reset() {
    this.means.clear();
    this.framesCount = 0;
    this.framesAt = 0;
  }
}
