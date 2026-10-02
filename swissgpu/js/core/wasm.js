/* wasm.js — one compile, many instances.
 *
 * The browser cannot compile C. What it can do is compile the wasm bytecode
 * once and hand the resulting `WebAssembly.Module` to every thread: modules are
 * structured-cloneable, and cloning one shares the already-compiled machine
 * code instead of recompiling it per worker. Each worker then instantiates it
 * with a private `WebAssembly.Memory`, so threads never contend for a heap.
 */

/** Main thread: compile once, streaming, before any worker is spawned. */
export async function compileCore(url = '../../wasm/core.wasm') {
  const abs = new URL(url, import.meta.url);
  const response = await fetch(abs);
  if (!response.ok) throw new Error(`Could not load ${abs.pathname} (${response.status}).`);
  try {
    return await WebAssembly.compileStreaming(response.clone());
  } catch {
    // Streaming compilation refuses anything not served as application/wasm,
    // which some static dev servers get wrong. Buffer it instead.
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/** Worker side: give this thread its own instance of the shared module. */
export function instantiateCore(module) {
  const instance = new WebAssembly.Instance(module, {});
  return new Core(instance);
}

export class Core {
  constructor(instance) {
    this.exports = instance.exports;
    this.memory = instance.exports.memory;
    this.#refresh();
    this.exports.arena_init();
  }

  /** Views are invalidated whenever linear memory grows, so re-take them. */
  #refresh() {
    const b = this.memory.buffer;
    this.buffer = b;
    this.u8 = new Uint8Array(b);
    this.u16 = new Uint16Array(b);
    this.u32 = new Uint32Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
    this.f64 = new Float64Array(b);
  }

  /** Re-take the typed views if wasm grew its memory since we last looked. */
  sync() {
    if (this.buffer !== this.memory.buffer) this.#refresh();
    return this;
  }

  /** Returns a byte offset. Throws rather than returning a silent null offset. */
  alloc(bytes) {
    const off = this.exports.arena_alloc(bytes);
    if (!off) throw new Error(`wasm arena: out of memory requesting ${bytes} bytes`);
    if (this.buffer !== this.memory.buffer) this.#refresh();
    return off;
  }

  /** Copy bytes in and hand back the offset. */
  write(bytes) {
    const off = this.alloc(bytes.byteLength);
    this.u8.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), off);
    return off;
  }

  reset() { this.exports.arena_reset(); }

  get used() { return this.exports.arena_used(); }
  get capacity() { return this.exports.arena_capacity(); }

  /** 0 means the instance decoded, allocated and ran SIMD correctly. */
  selftest() { return this.exports.core_selftest(); }

  get version() {
    const v = this.exports.core_version();
    return `${v >> 16 & 255}.${v >> 8 & 255}.${v & 255}`;
  }
}
