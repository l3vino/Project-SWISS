/* meshopt.js — the meshoptimizer decoder, loaded on first use.
 *
 * EXT_meshopt_compression compresses whole glTF buffer views; the decoder is
 * a small wasm module embedded in vendor/meshopt/meshopt_decoder.mjs. It is
 * imported only when a tile actually uses the extension, once per thread.
 */

let decoder = null;

export function loadMeshopt() {
  decoder ??= import('../../vendor/meshopt/meshopt_decoder.mjs').then(async ({ MeshoptDecoder }) => {
    await MeshoptDecoder.ready;
    return MeshoptDecoder;
  });
  return decoder;
}
