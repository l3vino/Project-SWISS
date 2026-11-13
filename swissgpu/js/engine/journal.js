/* journal.js — what was made and destroyed on the GPU lately (5.17h).
 *
 * His GPU is reset while the app runs (DXGI_ERROR_DEVICE_HUNG) with light frames just done (5.17g's report: the last
 * frame 9 ms, done 11 ms before): not a task that ran too long, but something the GPU or its driver would not take.
 * What that was is not known, so a loss's report now also says what the app did on the GPU in the seconds before:
 * buffers and textures made and destroyed (by their labels, runs of the same kind counted together), pipelines and
 * shaders made, and what the passes note themselves (`device.journal.note`: the bores' list rewritten).
 *
 * The device's own methods are wrapped (an own property over the prototype's): a few nanoseconds a call.
 */

const KEEP = 96;
/* Milliseconds within which the same thing done again counts into the entry before. */
const TOGETHER = 400;

export function journalOf(device) {
  const ring = [];
  const note = (kind, label, bytes = 0) => {
    const now = performance.now(), last = ring[ring.length - 1];
    // (A label's numbers out: a tile's key, a level.)
    const name = String(label || 'unnamed').replace(/[0-9]+([./:-][0-9]+)*/g, '#').slice(0, 28);
    if (last && last.kind === kind && last.name === name && now - last.to < TOGETHER) { last.n++; last.bytes += bytes; last.to = now; return; }
    ring.push({ kind, name, n: 1, bytes, to: now });
    if (ring.length > KEEP) ring.shift();
  };
  const wrap = (target, method, after) => {
    const original = target[method];
    if (typeof original !== 'function') return;
    target[method] = function wrapped(...args) {
      const result = original.apply(this, args);
      try { after(result, args[0] ?? {}); } catch { /* the journal never stops the app */ }
      return result;
    };
  };
  wrap(device, 'createBuffer', (buffer, d) => {
    note('buffer made', d.label, d.size);
    wrap(buffer, 'destroy', () => note('buffer destroyed', d.label, d.size));
  });
  wrap(device, 'createTexture', (texture, d) => {
    const size = Array.isArray(d.size) ? d.size : [d.size?.width ?? 1, d.size?.height ?? 1, d.size?.depthOrArrayLayers ?? 1];
    const bytes = (size[0] ?? 1) * (size[1] ?? 1) * (size[2] ?? 1) * 4;
    note('texture made', d.label, bytes);
    wrap(texture, 'destroy', () => note('texture destroyed', d.label, bytes));
  });
  for (const m of ['createRenderPipeline', 'createRenderPipelineAsync', 'createComputePipeline', 'createComputePipelineAsync']) {
    wrap(device, m, (_, d) => note('pipeline made', d.label));
  }
  wrap(device, 'createShaderModule', (_, d) => note('shader made', d.label));
  return {
    note,
    /** The entries of the last `ms`, the latest last: [{ ago (ms), kind, name, n, kb }]. */
    recent(ms = 3000, most = 12) {
      const now = performance.now();
      return ring.filter((e) => now - e.to <= ms).slice(-most)
        .map((e) => ({ ago: Math.round(now - e.to), kind: e.kind, name: e.name, n: e.n, kb: Math.round(e.bytes / 1024) }));
    },
  };
}
