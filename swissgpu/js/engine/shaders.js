/* shaders.js — WGSL modules assembled from files.
 *
 * WGSL has no #include. Passes list the files they are made of and this joins
 * them in order, so shared code (the output transform, the imagery sampler)
 * is written once. Compiler messages are mapped back to the file and line
 * they came from, rather than a line number in the joined text.
 */

const cache = new Map();

async function source(name) {
  if (!cache.has(name)) {
    const url = new URL(`./shaders/${name}`, import.meta.url);
    cache.set(name, fetch(url).then((r) => {
      if (!r.ok) throw new Error(`shader ${name}: HTTP ${r.status}`);
      return r.text();
    }));
  }
  return cache.get(name);
}

export async function loadShader(device, label, files) {
  const parts = await Promise.all(files.map(source));
  const starts = [];
  let line = 1;
  for (const text of parts) {
    starts.push(line);
    line += text.split('\n').length;
  }
  const code = parts.join('\n');
  const module = device.createShaderModule({ code, label });

  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    const where = (n) => {
      let i = starts.length - 1;
      while (i > 0 && starts[i] > n) i--;
      return `${files[i]}:${n - starts[i] + 1}`;
    };
    throw new Error(errors.map((m) => `${where(m.lineNum)}: ${m.message}`).join('\n'));
  }
  return module;
}
