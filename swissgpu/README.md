# Switzerland, streamed

A 3D reconstruction of Switzerland built from live swisstopo open data, rendered
with WebGPU. No frameworks, no build step, no API keys.

## Running it

Open `index.html` with VS Code's Live Server (or any static server) and go to the
URL it prints. Opening the file directly with `file://` will not work: ES modules
and `fetch` both need an HTTP origin.

Requires Chrome or Edge 113+ on desktop. There is no WebGL fallback by design.

## Controls

Click the view to take the mouse. **WASD** flies along your heading, **Space**
and **Left Shift** change altitude, the **scroll wheel** changes speed, and
**Esc** gives the pointer back. Where you are looking never drags you up or
down. Walking, jumping and the double-tap toggle arrive in step 4.

**Ctrl** with a movement key sprints. **Ctrl K** focuses the search box, except
while flying.

The search bar has a **Global / National** switch, remembered between visits.
**Global** asks Open-Meteo, which indexes cities and towns worldwide from
GeoNames with no key and no rate limit, so looking up New York from Switzerland
works. **National** asks the country source for what is on screen, swisstopo
today, which also knows addresses, summits and field names. Near a border it
asks every country in view and merges them.

While the pointer is captured, browser shortcuts are suppressed so they do not
fire mid-flight. The reserved ones — Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab — ignore
`preventDefault` entirely and need the Keyboard Lock API, which only works in
fullscreen, so clicking the view also goes fullscreen. That is Settings →
Controls → *Capture browser shortcuts*, on by default. Turn it off if you would
rather keep the browser chrome and DevTools visible; Ctrl+W will then close the
tab, which matters because Ctrl+W is the sprint binding.

## What is here after step 1a

The engine spine, running end to end:

- **Threads.** The page thread starts a render thread and a pool of decode
  threads, all spawned from Blob URLs. The render thread owns the WebGPU device
  and the canvas through `OffscreenCanvas`, so the page thread never renders.
- **Native core.** `wasm/src/core.c` is compiled to a 1.2 KB wasm module,
  compiled once by the browser, then instantiated separately in every thread so
  each one gets a private heap and a bump arena.
- **Transfers.** Buffers move between threads by transfer, never by copy. Boot
  fails loudly if that stops being true.
- **Renderer.** Reverse-Z depth, per-pass GPU timing where the hardware exposes
  it, adaptive render scale, and one full-screen pass drawing the placeholder sky.
- **Adapters, routed by area.** `registry.js` answers "who serves this
  rectangle?" per tile rather than per session, so a tile on a border is
  offered to each source in priority order and an unmapped region is simply
  never requested. National search asks every country source covering the
  current view at once and merges the results; Global asks the worldwide index.
- **Terrain.** Quantized Mesh tiles from swisstopo, decoded in C on the decode
  threads, uploaded as 24-byte vertices with skirts along every tile edge.
  One fixed detail level in a ring around the camera; the quadtree with
  screen-space-error refinement is step 1b.
- **Camera.** Longitude, latitude, height and two angles, with a floating
  origin so float32 vertex positions stay exact. Where you were is restored on
  reload, or you can pin a home in the settings.
- **Interface.** Search with live suggestions, a settings panel generated from a
  schema, and an instrument readout.

## Layout

    index.html
    css/ui.css
    js/main.js               page thread: boot, UI wiring, nothing per frame
    js/core/rpc.js           the message protocol every thread speaks
    js/core/workers.js       blob spawning and load-balanced dispatch
    js/core/wasm.js          compile once, instantiate per thread
    js/core/math.js          f64 geodesy, Mercator, reverse-Z matrices
    js/core/settings.js      the schema that drives the settings panel
    js/adapters/adapter.js   the contract a country plugs into
    js/adapters/swisstopo.js Switzerland
    js/engine/gpu.js         device negotiation, capabilities, GPU timing
    js/engine/frame.js       render targets, resize, the loop
    js/engine/passes/        one file per pass
    js/engine/shaders/       WGSL
    js/workers/render.js     the render thread
    js/workers/codec.js      a decode thread
    js/ui/                   boot, readout, search, settings
    wasm/core.wasm           prebuilt, committed
    wasm/src/core.h          shared declarations
    wasm/src/core.c          arena and memory substrate
    wasm/src/mathf.c         sin, cos and geodetic-to-ECEF, no libm
    wasm/src/qm.c            Quantized Mesh decoder
    wasm/build.sh            only needed if you edit the C
    wasm/test.mjs            node wasm/test.mjs

## Rebuilding the wasm

You do not need to. If you edit `wasm/src/core.c`:

    sudo apt install clang lld && npm i -g binaryen
    ./wasm/build.sh

## Data

Map data comes from the Swiss Federal Spatial Data Infrastructure and is
subject to its [terms of use](https://www.geo.admin.ch/en/general-terms-of-use-fsdi).
Worldwide place names come from GeoNames through Open-Meteo, under CC BY 4.0.

| What | Service |
| --- | --- |
| Terrain | Quantized Mesh from swissALTI3D, `3d.geo.admin.ch`, located through its `layer.json` |
| Imagery | SWISSIMAGE via WMTS, `wmts.geo.admin.ch` |
| Buildings, roads, railways, water, trees, names | 3D Tiles, `3d.geo.admin.ch` |
| Place search, National | SearchServer, `api3.geo.admin.ch` |
| Place search, Global | Open-Meteo geocoding over GeoNames, no key, no rate limit |
