/* draco.js — Google's Draco mesh decoder, loaded on first use.
 *
 * KHR_draco_mesh_compression replaces a primitive's attributes and indices
 * with one Draco-encoded blob. The decoder is C++ compiled to wasm, shipped in
 * vendor/draco/ together with its Emscripten wrapper. The wrapper is a plain
 * script rather than a module, so it is evaluated as a function that returns
 * its factory; handed the wasm bytes directly, it never tries to locate or
 * fetch anything itself. One instance per thread, created on first use.
 */

let module = null;

export function loadDraco() {
  module ??= (async () => {
    const base = new URL('../../vendor/draco/', import.meta.url);
    const [code, wasmBinary] = await Promise.all([
      fetch(new URL('draco_decoder_gltf.js', base)).then(ok).then((r) => r.text()),
      fetch(new URL('draco_decoder_gltf.wasm', base)).then(ok).then((r) => r.arrayBuffer()),
    ]);
    const factory = new Function(`${code}\n;return DracoDecoderModule;`)();
    return factory({ wasmBinary });
  })();
  return module;
}

function ok(response) {
  if (!response.ok) throw new Error(`Draco decoder unavailable (${response.status})`);
  return response;
}

/**
 * Decodes one compressed primitive.
 * @param bytes       the extension's buffer view
 * @param attributes  glTF attribute name -> Draco unique id, as the extension lists them
 * @returns {{ indices: Uint32Array, [name]: Float32Array }}
 */
export function decodeDraco(draco, bytes, attributes) {
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  try {
    const input = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const status = decoder.DecodeArrayToMesh(input, input.byteLength, mesh);
    if (!status.ok() || mesh.ptr === 0) throw new Error(`Draco decode failed: ${status.error_msg()}`);

    const out = {};
    const indexCount = mesh.num_faces() * 3;
    out.indices = copyOut(draco, indexCount * 4, (ptr, size) => decoder.GetTrianglesUInt32Array(mesh, size, ptr),
      (buffer, ptr) => new Uint32Array(buffer, ptr, indexCount));

    const points = mesh.num_points();
    for (const [name, id] of Object.entries(attributes)) {
      const attribute = decoder.GetAttributeByUniqueId(mesh, id);
      if (!attribute || attribute.ptr === 0) continue;
      const count = points * attribute.num_components();
      out[name] = copyOut(draco, count * 4,
        (ptr, size) => decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, size, ptr),
        (buffer, ptr) => new Float32Array(buffer, ptr, count));
    }
    return out;
  } finally {
    draco.destroy(mesh);
    draco.destroy(decoder);
  }
}

/* Decoded data lands in the decoder's own heap; copy it out and free it. */
function copyOut(draco, size, fill, view) {
  const ptr = draco._malloc(size);
  try {
    fill(ptr, size);
    return view(draco.HEAPU8.buffer, ptr).slice();
  } finally {
    draco._free(ptr);
  }
}
