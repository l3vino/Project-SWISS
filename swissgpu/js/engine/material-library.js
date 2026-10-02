/* material-library.js — the building materials as a texture array, drawn on
 * the GPU once at start-up (shaders/materials.wgsl).
 *
 * Nine layers of 512 × 512, one per material in features/materials.js, each
 * tiling seamlessly over a metre or three of wall, with every mip level so
 * that a wall far away shows its average rather than sparkle, and sampled
 * anisotropically so a wall seen edge-on stays sharp along its length.
 * About 11 MB of video memory, and nothing downloaded: the pictures are
 * made from noise and a few rules about stone, brick and wood, in a few
 * milliseconds.
 */

import { loadShader } from './shaders.js';
import { MATERIALS } from './features/materials.js';

const SIZE = 512;
const WORKGROUP = 8;

export async function createMaterialLibrary(device) {
  const layers = MATERIALS.length;
  const levels = Math.log2(SIZE) + 1;
  const texture = device.createTexture({
    label: 'building-materials',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: layers },
    mipLevelCount: levels,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
  });
  // Brightness, joints and height at full precision, for working out the
  // slopes; dropped once they have been.
  const scratch = device.createTexture({
    label: 'building-materials-heights',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: layers },
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
  });

  const module = await loadShader(device, 'materials', ['materials.wgsl']);
  const pipeline = (entryPoint) => device.createComputePipelineAsync({
    label: `materials-${entryPoint}`, layout: 'auto', compute: { module, entryPoint },
  });
  const [generate, finish, downsample] = await Promise.all(['generate', 'finish', 'downsample'].map(pipeline));
  const level = (mip) => texture.createView({ dimension: '2d-array', baseMipLevel: mip, mipLevelCount: 1 });

  const encoder = device.createCommandEncoder({ label: 'materials' });
  let pass = encoder.beginComputePass({ label: 'materials-generate' });
  pass.setPipeline(generate);
  pass.setBindGroup(0, device.createBindGroup({
    layout: generate.getBindGroupLayout(0),
    entries: [{ binding: 2, resource: scratch.createView({ dimension: '2d-array' }) }],
  }));
  pass.dispatchWorkgroups(SIZE / WORKGROUP, SIZE / WORKGROUP, layers);
  pass.end();
  pass = encoder.beginComputePass({ label: 'materials-finish' });
  pass.setPipeline(finish);
  pass.setBindGroup(0, device.createBindGroup({
    layout: finish.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: level(0) }, { binding: 3, resource: scratch.createView({ dimension: '2d-array' }) }],
  }));
  pass.dispatchWorkgroups(SIZE / WORKGROUP, SIZE / WORKGROUP, layers);
  pass.end();
  // Each level from the one before: four texels averaged into one.
  for (let mip = 1; mip < levels; mip++) {
    const size = SIZE >> mip;
    pass = encoder.beginComputePass({ label: `materials-mip-${mip}` });
    pass.setPipeline(downsample);
    pass.setBindGroup(0, device.createBindGroup({
      layout: downsample.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: level(mip) }, { binding: 1, resource: level(mip - 1) }],
    }));
    pass.dispatchWorkgroups(Math.ceil(size / WORKGROUP), Math.ceil(size / WORKGROUP), layers);
    pass.end();
  }
  device.queue.submit([encoder.finish()]);
  scratch.destroy();

  const sampler = device.createSampler({
    label: 'building-materials',
    addressModeU: 'repeat', addressModeV: 'repeat',
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    maxAnisotropy: 16,
  });
  return { texture, view: texture.createView({ dimension: '2d-array' }), sampler, bytes: Math.round(SIZE * SIZE * 4 * layers * 4 / 3) };
}
