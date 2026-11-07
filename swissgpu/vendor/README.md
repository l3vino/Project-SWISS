# Third-party decoders

Loaded only when a streamed tile needs them, on the decode threads. Nothing
here runs unless a 3D Tiles tile arrives compressed with the matching glTF
extension.

| Folder | What | Source | Licence |
| --- | --- | --- | --- |
| `draco/` | Draco mesh decoder, glTF build (`KHR_draco_mesh_compression`) | [google/draco](https://github.com/google/draco) 1.5.7, npm `draco3dgltf` | Apache License 2.0 |
| `meshopt/` | meshoptimizer decoder (`EXT_meshopt_compression`) | [zeux/meshoptimizer](https://github.com/zeux/meshoptimizer) 1.2.0, npm `meshoptimizer` | MIT, see `meshopt/LICENSE.md` |

`draco/draco_decoder_gltf.js` is the package's `draco_decoder_gltf_nodejs.js`
renamed: it is an Emscripten wrapper that runs in any environment when handed
the wasm bytes directly, which is how `js/formats/draco.js` uses it.

Draco is Copyright Google LLC and licensed under the Apache License, Version
2.0: <https://www.apache.org/licenses/LICENSE-2.0>. Neither file is modified.
