/* frame-uniforms.js — the per-frame values every scene pass reads.
 *
 * The camera's view-projection, its absolute position, the sun, the haze and
 * the debug view, written once per frame into one small uniform buffer and
 * bound at group 0 by every pass that draws the world. Terrain, buildings and
 * whatever comes next therefore agree on all of them by construction; the
 * matching WGSL is js/engine/shaders/frame.wgsl.
 */

const FLOATS = 32;   // mat4 + three vec4-aligned blocks

/* The sky's horizon colour in linear light, so haze and sky meet cleanly. */
const HORIZON = [0.2330, 0.3424, 0.4770];
const FOG_DENSITY = 4.5e-6;

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
    this.layout = device.createBindGroupLayout({
      label: 'frame',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                  buffer: { type: 'uniform' } }],
    });
    this.bindGroup = device.createBindGroup({
      label: 'frame', layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.buffer } }],
    });
  }

  /** Once per frame, after the view has been updated. */
  update(camera, view, near) {
    const d = this.data;
    d.set(view.viewProj, 0);
    const p = camera.position;
    d[16] = p[0]; d[17] = p[1]; d[18] = p[2];
    d[19] = near;
    const sun = camera.sunDirection(145, 42, this.sun);
    d[20] = sun[0]; d[21] = sun[1]; d[22] = sun[2];
    this.u32[23] = this.debugMode;
    d[24] = HORIZON[0]; d[25] = HORIZON[1]; d[26] = HORIZON[2];
    d[27] = FOG_DENSITY;
    this.device.queue.writeBuffer(this.buffer, 0, d);
  }
}
