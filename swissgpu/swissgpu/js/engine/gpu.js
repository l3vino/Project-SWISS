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
  };

  return { adapter, device, context, caps };
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
 * the stall we are trying to measure.
 */
export class GpuTimer {
  constructor(device, { capacity = 8, pool = 3 } = {}) {
    this.device = device;
    this.enabled = false;
    this.results = new Map();
    this.names = [];

    if (!device.features.has('timestamp-query')) return;

    this.enabled = true;
    this.capacity = capacity * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.capacity, label: 'pass-timings' });
    this.resolve = device.createBuffer({
      size: this.capacity * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      label: 'timestamp-resolve',
    });
    this.staging = Array.from({ length: pool }, () => device.createBuffer({
      size: this.capacity * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    this.free = [...this.staging];
  }

  /** Call before recording passes; returns the pass names slot index. */
  begin() { this.names.length = 0; }

  /** Timestamp writes to hand to a render or compute pass descriptor. */
  writes(name) {
    if (!this.enabled || this.names.length * 2 >= this.capacity) return undefined;
    const i = this.names.length;
    this.names.push(name);
    return { querySet: this.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  /** Record the resolve into the frame's command encoder. */
  resolveInto(encoder) {
    if (!this.enabled || this.names.length === 0) return null;
    const buf = this.free.pop();
    if (!buf) return null; // every staging buffer is still mapped: skip this frame
    encoder.resolveQuerySet(this.querySet, 0, this.names.length * 2, this.resolve, 0);
    encoder.copyBufferToBuffer(this.resolve, 0, buf, 0, this.names.length * 8 * 2);
    return { buf, names: [...this.names] };
  }

  /** Read back without blocking; results land a frame or two later. */
  async collect(ticket) {
    if (!ticket) return;
    const { buf, names } = ticket;
    try {
      await buf.mapAsync(GPUMapMode.READ);
      const t = new BigInt64Array(buf.getMappedRange().slice(0));
      for (let i = 0; i < names.length; i++) {
        const ns = Number(t[i * 2 + 1] - t[i * 2]);
        if (ns >= 0) this.results.set(names[i], ns / 1e6); // milliseconds
      }
      buf.unmap();
    } catch { /* device lost or buffer destroyed */ }
    this.free.push(buf);
  }

  total() {
    let ms = 0;
    for (const v of this.results.values()) ms += v;
    return ms;
  }
}
