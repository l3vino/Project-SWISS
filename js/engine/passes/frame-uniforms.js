/* frame-uniforms.js — the per-frame values every pass that draws the world
 * reads.
 *
 * The camera's view-projection, its position and local axes, the rays that
 * turn a screen position into a direction, the sun, and how far the world is
 * drawn: written once per frame into one small uniform buffer and bound at
 * group 0 by every pass that draws, together with the atmosphere's tables
 * and the light of the moment (passes/atmosphere.js). Terrain, buildings,
 * the sky and whatever comes next therefore agree on all of them by
 * construction; the matching WGSL is js/engine/shaders/frame.wgsl.
 */

import { DEG } from '../../core/math.js';

const FLOATS = 52;

/* Where the sun stands, for now: south-east and 42° up, a spring afternoon. */
const SUN_AZIMUTH = 145;
const SUN_ELEVATION = 42;

/* The earth's radius in the atmosphere model (atmosphere.wgsl), km. */
const EARTH_KM = 6360;

export class FrameUniforms {
  constructor(device) {
    this.device = device;
    this.debugMode = 0;
    this.data = new Float32Array(FLOATS);
    // debugMode is a u32 inside the float buffer; take the view once.
    this.u32 = new Uint32Array(this.data.buffer);
    this.sun = new Float64Array(3);
    this.buffer = device.createBuffer({
      label: 'frame', size: FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const both = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'frame',
      entries: [
        { binding: 0, visibility: both, buffer: { type: 'uniform' } },
        { binding: 1, visibility: both, sampler: { type: 'filtering' } },
        { binding: 2, visibility: both, texture: { sampleType: 'float' } },
        { binding: 3, visibility: both, texture: { sampleType: 'float' } },
        { binding: 4, visibility: both, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 5, visibility: both, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.bindGroup = null;
    // What the atmosphere's tables were last made for (see atmosphere.js).
    this.state = { height: 0, ground: 0, sunElevation: SUN_ELEVATION };
  }

  /** Binds the atmosphere's tables and light alongside the uniforms. */
  attach(atmosphere) {
    this.bindGroup = this.device.createBindGroup({
      label: 'frame', layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.buffer } },
        { binding: 1, resource: atmosphere.sampler },
        { binding: 2, resource: atmosphere.views.transmittance },
        { binding: 3, resource: atmosphere.views.skyView },
        { binding: 4, resource: atmosphere.views.aerial },
        { binding: 5, resource: { buffer: atmosphere.light } },
      ],
    });
  }

  /**
   * Once per frame, after the view has been updated.
   * @param ground  height of the ground under the camera, metres
   * @param size    the render target: { width, height }; fovY and aspect of the view
   */
  update(camera, view, near, { ground = 0, width = 1, height = 1, fovY = 1, aspect = 1 } = {}) {
    const d = this.data;
    d.set(view.viewProj, 0);
    const p = camera.position;
    d[16] = p[0]; d[17] = p[1]; d[18] = p[2];
    d[19] = near;
    const sun = camera.sunDirection(SUN_AZIMUTH, SUN_ELEVATION, this.sun);
    d[20] = sun[0]; d[21] = sun[1]; d[22] = sun[2];
    this.u32[23] = this.debugMode;
    d.set(camera.east, 24);
    // Unlimited is sent as very far: the shader fades towards it.
    d[27] = Number.isFinite(view.maxDistance) ? view.maxDistance : 1e9;
    d.set(camera.north, 28);
    d[31] = EARTH_KM + camera.height / 1000;
    d.set(camera.up, 32);
    // The haze table reaches as far as anything is drawn, horizon included.
    d[35] = Math.max(10, Math.min(view.horizon, view.maxDistance) / 1000);
    // The view's right and up axes, from the rows of the view matrix, scaled
    // so that forward + x·right + y·up is the ray through screen position (x, y).
    const v = camera.view, t = Math.tan(fovY / 2);
    d[36] = v[0] * t * aspect; d[37] = v[4] * t * aspect; d[38] = v[8] * t * aspect;
    d[39] = EARTH_KM + ground / 1000;
    d[40] = v[1] * t; d[41] = v[5] * t; d[42] = v[9] * t;
    d[43] = width;
    d.set(camera.forward, 44);
    d[47] = height;
    const az = SUN_AZIMUTH * DEG, el = SUN_ELEVATION * DEG;
    d[48] = Math.sin(az) * Math.cos(el); d[49] = Math.cos(az) * Math.cos(el); d[50] = Math.sin(el);
    this.device.queue.writeBuffer(this.buffer, 0, d);
    this.state.height = camera.height;
    this.state.ground = ground;
    this.state.sunElevation = SUN_ELEVATION;
  }
}
