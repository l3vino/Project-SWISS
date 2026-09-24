/* bc1-test.mjs — measures the GPU BC1 encoder through the real path.
 *
 *   xvfb-run -a node tools/bc1-test.mjs
 *
 * Encodes test images with js/engine/shaders/bc1.wgsl, copies the blocks into
 * a BC1 texture exactly as the clipmap does, lets the GPU's own decoder read
 * them back, and compares with the source pixels. A wrong channel order, bit
 * layout or copy would not show up as a slightly worse number but as garbage,
 * so this checks correctness and quality at once. A naive bounding-box
 * encoder runs alongside as the baseline to beat, and its blocks go through
 * the same hardware decoder, so both are measured the same way.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ||
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');

const server = http.createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { 'content-type': path.endsWith('.wgsl') ? 'text/plain' : 'text/html' });
    res.end(body);
  } catch { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>bc1</title>'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
         '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'],
});
const page = await browser.newPage();
await page.goto(`${origin}/blank.html`);

const report = await page.evaluate(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter.features.has('texture-compression-bc')) return { error: 'no texture-compression-bc' };
  const device = await adapter.requestDevice({ requiredFeatures: ['texture-compression-bc'] });
  const errors = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);

  /* ---- test images ---- */
  const S = 256;
  const canvas = new OffscreenCanvas(S, S);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const images = {};

  // Smooth colour gradients: the easy case, and where banding would show.
  const grad = g.createLinearGradient(0, 0, S, S);
  grad.addColorStop(0, '#1d3b1f'); grad.addColorStop(0.5, '#8c7a5b'); grad.addColorStop(1, '#e8eef2');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  images.gradient = g.getImageData(0, 0, S, S);

  // Aerial-like: fields, forest texture, a road, roofs. The hard case.
  g.fillStyle = '#4a5f2e'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsl(${70 + rand() * 40}, ${25 + rand() * 30}%, ${22 + rand() * 25}%)`;
    g.fillRect(rand() * S, rand() * S, 20 + rand() * 90, 20 + rand() * 90);
  }
  const noise = g.getImageData(0, 0, S, S);
  for (let i = 0; i < noise.data.length; i += 4) {
    const n = (rand() - 0.5) * 38;
    for (let c = 0; c < 3; c++) noise.data[i + c] = Math.max(0, Math.min(255, noise.data[i + c] + n));
  }
  g.putImageData(noise, 0, 0);
  g.strokeStyle = '#b9b3a6'; g.lineWidth = 5; g.beginPath(); g.moveTo(0, 190); g.bezierCurveTo(90, 120, 170, 230, 256, 150); g.stroke();
  for (let i = 0; i < 14; i++) { g.fillStyle = i % 2 ? '#a0422f' : '#6d6a66'; g.fillRect(150 + (i % 4) * 22, 20 + Math.floor(i / 4) * 24, 16, 14); }
  images.aerial = g.getImageData(0, 0, S, S);

  // Hard edges between saturated colours: the worst case for any BC1 encoder.
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    g.fillStyle = ((x >> 3) + (y >> 3)) % 3 === 0 ? '#d23a2a' : ((x >> 3) + (y >> 3)) % 3 === 1 ? '#2a6fd2' : '#f2d23a';
    g.fillRect(x, y, 1, 1);
  }
  images.edges = g.getImageData(0, 0, S, S);

  const names = Object.keys(images);
  const layers = names.length;

  /* ---- baseline: bounding-box endpoints, encoded to real BC1 blocks ---- */
  const pack565 = (r, g, b) => (Math.round((r / 255) * 31) << 11) | (Math.round((g / 255) * 63) << 5) | Math.round((b / 255) * 31);
  const unpack565 = (v) => {
    const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
    return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
  };
  const naiveBlocks = (img) => {
    const out = new Uint32Array(4096 * 2);
    for (let by = 0; by < 64; by++) for (let bx = 0; bx < 64; bx++) {
      const lo = [255, 255, 255], hi = [0, 0, 0];
      const at = (x, y) => ((by * 4 + y) * S + bx * 4 + x) * 4;
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 3; c++) {
        const v = img.data[at(x, y) + c]; lo[c] = Math.min(lo[c], v); hi[c] = Math.max(hi[c], v);
      }
      let c0 = pack565(...hi), c1 = pack565(...lo);
      if (c0 < c1) [c0, c1] = [c1, c0];
      let bits = 0;
      if (c0 !== c1) {
        const p0 = unpack565(c0), p1 = unpack565(c1);
        const pal = [p0, p1, p0.map((v, c) => (2 * v + p1[c]) / 3), p0.map((v, c) => (v + 2 * p1[c]) / 3)];
        for (let i = 0; i < 16; i++) {
          const q = at(i & 3, i >> 2);
          let best = 0, bd = Infinity;
          pal.forEach((pp, k) => { const d = (pp[0] - img.data[q]) ** 2 + (pp[1] - img.data[q + 1]) ** 2 + (pp[2] - img.data[q + 2]) ** 2; if (d < bd) { bd = d; best = k; } });
          bits |= best << (2 * i);
        }
      }
      out[(by * 64 + bx) * 2] = (c0 | (c1 << 16)) >>> 0;
      out[(by * 64 + bx) * 2 + 1] = bits >>> 0;
    }
    return out;
  };

  /* ---- encode on the GPU with the real shader ---- */
  const code = await (await fetch('/js/engine/shaders/bc1.wgsl')).text();
  const module = device.createShaderModule({ code });
  const info = await module.getCompilationInfo();
  const compileErrors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}: ${m.message}`);
  if (compileErrors.length) return { error: compileErrors.join('\n') };

  const staging = device.createTexture({
    size: [S, S, layers], format: 'rgba8unorm',
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  for (let k = 0; k < layers; k++) {
    const bitmap = await createImageBitmap(images[names[k]], { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: staging, origin: [0, 0, k] }, [S, S]);
    bitmap.close();
  }
  const blocks = device.createBuffer({ size: layers * 4096 * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'encode' } });
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: staging.createView({ dimension: '2d-array' }) },
      { binding: 1, resource: { buffer: blocks } },
    ],
  });

  // The destination the clipmap uses, minus sRGB so the comparison is exact.
  const bc = device.createTexture({ size: [S, S, layers], format: 'bc1-rgba-unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
  const bcNaive = device.createTexture({ size: [S, S, layers], format: 'bc1-rgba-unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(8, 8, layers); pass.end();
  for (let k = 0; k < layers; k++) {
    enc.copyBufferToTexture({ buffer: blocks, offset: k * 32768, bytesPerRow: 512, rowsPerImage: 64 },
      { texture: bc, origin: [0, 0, k] }, [S, S, 1]);
  }

  /* ---- let the GPU decode it, via textureLoad into a plain target ---- */
  const decodeModule = device.createShaderModule({ code: `
    @group(0) @binding(0) var t : texture_2d_array<f32>;
    @group(0) @binding(1) var<uniform> layer : u32;
    @vertex fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
      let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u)); return vec4f(uv * 2.0 - 1.0, 0.0, 1.0); }
    @fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f {
      return textureLoad(t, vec2u(p.xy), layer, 0); }` });
  const decodePipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: decodeModule, entryPoint: 'vs' },
    fragment: { module: decodeModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  for (let k = 0; k < layers; k++) {
    device.queue.writeTexture({ texture: bcNaive, origin: [0, 0, k] }, naiveBlocks(images[names[k]]),
      { bytesPerRow: 512, rowsPerImage: 64 }, [S, S, 1]);
  }

  const target = device.createTexture({ size: [S, S], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 2 * layers * S * S * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  [bc, bcNaive].forEach((texture, which) => {
    for (let k = 0; k < layers; k++) {
      const u = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(u, 0, new Uint32Array([k, 0, 0, 0]));
      const b = device.createBindGroup({ layout: decodePipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: texture.createView({ dimension: '2d-array' }) }, { binding: 1, resource: { buffer: u } }] });
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline(decodePipeline); rp.setBindGroup(0, b); rp.draw(3); rp.end();
      enc.copyTextureToBuffer({ texture: target }, { buffer: readback, offset: (which * layers + k) * S * S * 4, bytesPerRow: S * 4 }, [S, S]);
    }
  });
  device.queue.submit([enc.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const decoded = new Uint8Array(readback.getMappedRange().slice(0));

  const psnr = (a, b, offset = 0) => {
    let se = 0;
    for (let i = 0; i < S * S * 4; i += 4) for (let c = 0; c < 3; c++) se += (a[i + c] - b[offset + i + c]) ** 2;
    const mse = se / (S * S * 3);
    return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
  };

  const results = names.map((name, k) => ({
    name,
    gpu: psnr(images[name].data, decoded, k * S * S * 4),
    naive: psnr(images[name].data, decoded, (layers + k) * S * S * 4),
  }));
  return { results, errors };
});

await browser.close();
server.close();

if (report.error) { console.error('bc1 test could not run:', report.error); process.exit(2); }
let failed = report.errors.length > 0;
for (const e of report.errors) console.error('webgpu error:', e);
console.log('image       gpu encoder   bounding box   (PSNR, higher is better)');
for (const r of report.results) {
  const ok = r.gpu > 28 && r.gpu >= r.naive - 0.05;
  if (!ok) failed = true;
  console.log(`${r.name.padEnd(10)}  ${r.gpu.toFixed(2).padStart(8)} dB   ${r.naive.toFixed(2).padStart(9)} dB   ${ok ? 'ok' : 'FAIL'}`);
}
process.exit(failed ? 1 : 0);
