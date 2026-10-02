/* atmosphere.js — the air: the sky's colour, the sunlight and skylight that
 * light everything, and the haze between the eye and the distance.
 *
 * Compute passes fill the tables of shaders/atmosphere.wgsl (Hillaire's
 * method, see there) and a small buffer with the light of the moment. The
 * tables that depend only on the air are made once; the sky view and the
 * light are redone when the camera's height, the ground below it or the sun
 * change enough to matter; the aerial perspective, which is laid out in
 * screen space, every frame. All of it together is a fraction of a
 * millisecond on a real GPU.
 *
 * The textures and the buffer are bound for drawing through the frame's bind
 * group (frame-uniforms.js), which is why this runs first in the frame.
 */

import { loadShader } from '../shaders.js';

const LUT_FORMAT = 'rgba16float';
/* Redo the sky view and the light when the height they were made for is off
 * by this much, in metres, or by this fraction of it. */
const HEIGHT_STEP = 25;
const HEIGHT_FRACTION = 0.01;

export class Atmosphere {
  /** @param timer  the frame's GPU timer (gpu.js), for the per-frame passes */
  static async create(device, frame, timer = null) {
    const module = await loadShader(device, 'atmosphere',
      ['atmosphere.wgsl', 'frame.wgsl', 'atmosphere-luts.wgsl']);
    const pipeline = (entryPoint) => device.createComputePipelineAsync({
      label: `atmosphere-${entryPoint}`, layout: 'auto', compute: { module, entryPoint },
    });
    const [transmittance, multiple, skyView, aerial, ambient] = await Promise.all(
      ['transmittance', 'multipleScattering', 'skyView', 'aerial', 'ambient'].map(pipeline));
    return new Atmosphere(device, frame, { transmittance, multiple, skyView, aerial, ambient }, timer);
  }

  constructor(device, frame, pipelines, timer) {
    this.device = device;
    this.frame = frame;
    this.pipelines = pipelines;
    this.timer = timer;
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const lut = (label, width, height, depth = 1, dimension = '2d') =>
      device.createTexture({ label, size: [width, height, depth], dimension, format: LUT_FORMAT, usage });
    this.transmittance = lut('atmosphere-transmittance', 256, 64);
    this.multiScatter = lut('atmosphere-multiple-scattering', 32, 32);
    this.skyView = lut('atmosphere-sky-view', 192, 108);
    this.aerial = lut('atmosphere-aerial-perspective', 32, 32, 32, '3d');
    // sun, four spherical harmonic coefficients, level ground: vec4 each.
    this.light = device.createBuffer({
      label: 'atmosphere-light', size: 6 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.sampler = device.createSampler({
      label: 'atmosphere', magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    });
    this.views = {
      transmittance: this.transmittance.createView(),
      multiScatter: this.multiScatter.createView(),
      skyView: this.skyView.createView(),
      aerial: this.aerial.createView({ dimension: '3d' }),
    };

    // One bind group per pass, each with exactly what its entry point uses.
    const bind = (p, entries0, entries1) => [
      device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: entries0 }),
      device.createBindGroup({ layout: p.getBindGroupLayout(1), entries: entries1 }),
    ];
    const uniform = { binding: 0, resource: { buffer: frame.buffer } };
    const sampler = { binding: 1, resource: this.sampler };
    const trans = { binding: 2, resource: this.views.transmittance };
    const multi = { binding: 6, resource: this.views.multiScatter };
    const P = pipelines;
    this.groups = {
      transmittance: bind(P.transmittance, [], [{ binding: 0, resource: this.views.transmittance }]),
      multiple: bind(P.multiple, [sampler, trans], [{ binding: 1, resource: this.views.multiScatter }]),
      skyView: bind(P.skyView, [uniform, sampler, trans, multi], [{ binding: 2, resource: this.views.skyView }]),
      aerial: bind(P.aerial, [uniform, sampler, trans, multi], [{ binding: 3, resource: this.views.aerial }]),
      ambient: bind(P.ambient, [uniform, sampler, trans, multi], [{ binding: 4, resource: { buffer: this.light } }]),
    };

    // The air itself does not change: its two tables are made now.
    const encoder = device.createCommandEncoder({ label: 'atmosphere-once' });
    this.#dispatch(encoder, 'transmittance', [256 / 8, 64 / 8, 1]);
    this.#dispatch(encoder, 'multiple', [32, 32, 1]);
    device.queue.submit([encoder.finish()]);

    this.madeFor = { height: NaN, ground: NaN, sun: NaN };
  }

  #dispatch(encoder, name, [x, y, z], timed = null) {
    const pass = encoder.beginComputePass({ label: `atmosphere-${name}`,
      timestampWrites: timed ? this.timer?.writes(timed) : undefined });
    pass.setPipeline(this.pipelines[name]);
    const [g0, g1] = this.groups[name];
    pass.setBindGroup(0, g0);
    pass.setBindGroup(1, g1);
    pass.dispatchWorkgroups(x, y, z);
    pass.end();
  }

  /** First in the frame, after the frame uniforms have been written. */
  record(encoder) {
    const { height, ground, sunElevation } = this.frame.state;
    const m = this.madeFor;
    const off = (a, b) => !(Math.abs(a - b) <= Math.max(HEIGHT_STEP, Math.abs(b) * HEIGHT_FRACTION));
    if (off(height, m.height) || sunElevation !== m.sun) {
      this.#dispatch(encoder, 'skyView', [Math.ceil(192 / 8), Math.ceil(108 / 8), 1], 'air tables');
      m.height = height;
    }
    if (off(ground, m.ground) || sunElevation !== m.sun) {
      this.#dispatch(encoder, 'ambient', [1, 1, 1], 'air light');
      m.ground = ground;
    }
    m.sun = sunElevation;
    this.#dispatch(encoder, 'aerial', [32 / 8, 32 / 8, 1], 'air');
  }
}
