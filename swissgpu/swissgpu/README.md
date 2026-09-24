# Switzerland, streamed

A 3D reconstruction of Switzerland built from live swisstopo open data, rendered
with WebGPU. No frameworks, no build step, no API keys.

## Running it

Open `index.html` with VS Code's Live Server (or any static server) and go to the
URL it prints. Opening the file directly with `file://` will not work: ES modules
and `fetch` both need an HTTP origin.

Requires Chrome or Edge 113+ on desktop. There is no WebGL fallback by design.

## Controls

Click the view to take the mouse; **Esc** gives it back. **Double-tap Space**
switches between flying and walking.

*Flying:* **WASD** moves along your heading, **Space** and **Left Shift** change
altitude, the **scroll wheel** changes speed, **Ctrl** triples it. Where you are
looking never drags you up or down, and the ground is solid.

*Walking:* **WASD** walks at 1.4 m/s, **Ctrl** runs at 4.5 m/s, **Space** jumps
45 cm, and holding it keeps jumping. Switching to walking in mid-air drops you
with real gravity and air drag, so from 6,000 m the fall takes about two
minutes. Ground steeper than 45° cannot be climbed and slides you off. All of
these, and your height, are in Settings → Physics.

Buildings and bridges are solid. Walls stop you and you slide along them, kerbs
and stairs up to 40 cm are stepped up, and you can stand on roofs, terraces and
bridge decks. They are solid while flying too, the way the ground is; Settings
→ Physics → *Fly through buildings* turns that off.

You stand on the terrain being drawn, which under your feet is swisstopo's
finest level, a few metres between vertices.

**Ctrl K** focuses the search box, except while flying. Picking a result puts
you **standing on the ground there**, in walking mode and facing the way you
were. The view settles as the terrain there loads; the tiles under the spot
are all requested at once, so this takes about a second. If the spot is inside
a building, which for an address it usually is, you are put on the nearest
open ground instead, up to 60 m away. Outside Switzerland there is no terrain
yet, so you arrive flying 150 m above the place instead, with a note saying so.

In the browser console, `swissgpu.probe()` shows the camera and physics state
right now, and `swissgpu.send(type, payload)` sends the render thread a message.

The search bar has a **Global / National** switch, remembered between visits.
**Global** asks Open-Meteo, which indexes cities and towns worldwide from
GeoNames with no key, so looking up New York from Switzerland works. Its free
tier allows 600 calls a minute and 10,000 a day; search sends one request per
pause in typing, so one person never gets near that. **National** asks the country source for what is on screen, swisstopo
today, which also knows addresses, summits and field names. Near a border it
asks every country in view and merges them.

While the pointer is captured, browser shortcuts are suppressed so they do not
fire mid-flight. The reserved ones — Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab — ignore
`preventDefault` entirely and need the Keyboard Lock API, which only works in
fullscreen, so clicking the view also goes fullscreen. That is Settings →
Controls → *Capture browser shortcuts*, on by default. Turn it off if you would
rather keep the browser chrome and DevTools visible; Ctrl+W will then close the
tab, which matters because Ctrl+W is how you run.

## What is here

The engine spine, running end to end:

- **Threads.** The page thread starts a render thread and a pool of decode
  threads, all spawned from Blob URLs. The render thread owns the WebGPU device
  and the canvas through `OffscreenCanvas`, so the page thread never renders.
- **Native core.** The C under `wasm/src/` is compiled to a 23 KB wasm module,
  compiled once by the browser, then instantiated separately in every thread so
  each one gets a private heap and a bump arena.
- **Transfers.** Buffers move between threads by transfer, never by copy. Boot
  fails loudly if that stops being true.
- **Renderer.** Reverse-Z depth, per-pass GPU timing where the hardware exposes
  it, adaptive render scale.
- **Adapters, routed by area.** `registry.js` answers "who serves this
  rectangle?" per tile rather than per session, so a tile on a border is
  offered to each source in priority order and an unmapped region is simply
  never requested. National search asks every country source covering the
  current view at once and merges the results; Global asks the worldwide index.
- **Terrain.** Quantized Mesh tiles from swisstopo (swissALTI3D, levels 0 to
  18), decoded in C on the decode threads, uploaded as 24-byte vertices.
  A quadtree picks the detail per tile: a tile splits while its error on
  screen exceeds 2 pixels (Cesium's error model, so the service looks the way
  it was tuned), which gives level 17–18 under your feet and coarse tiles at
  the horizon. Only tiles in view are visited; a parent stays drawn until
  every child in view has arrived, so refinement never opens holes; requests
  go out nearest first; a memory budget drops what has been out of sight
  longest. The tiles' own availability metadata says which finer tiles exist,
  so nothing is requested that the service does not have, and where finer
  data stops, the coarser tile keeps covering that quarter. The tiles' own
  per-vertex normals are used, so lighting is seamless across tile edges.
  Skirts are sized per level and face outward, which lets back faces be
  culled. Settings → Graphics → *Terrain detail* and *Terrain memory*;
  *Terrain view → Terrain levels* colours each tile by its level. The
  placeholder sky is one full-screen pass.
- **Buildings.** All of swissBUILDINGS3D, streamed as 3D Tiles: nested
  tilesets of b3dm tiles with real roof shapes. A reusable 3D Tiles streamer
  (`js/engine/features/tileset.js`) walks the tileset by screen-space error
  with the same view, culling and memory rules as the terrain, both
  refinement modes included; trees, roads and names will reuse it. Tiles
  decode on the decode threads: the b3dm and its glTF are unpacked in
  JavaScript, then C places every vertex in a local frame per tile and packs
  it into 12 bytes (plain glTF spends 32 or more). Whether swisstopo's tiles
  are plain, meshopt- or Draco-compressed is not documented, so all three are
  read; the Draco and meshopt decoders in `vendor/` load only if a tile needs
  them. Underground and invisible buildings, as swisstopo marks them, are
  dropped. Roofs are coloured by the aerial photo projected straight down, to
  within a few centimetres across a tile. Walls are drawn in the shader, so
  they cost no memory or download and stay sharp however close you get:
  plaster with grain, blotches and rain streaks under the sills, windows with
  frames, stone sills and glass set back in its reveal that reflects the sky
  more the more obliquely you see it, open louvred shutters on some houses, a
  stone plinth, storey mouldings, the odd shopfront. Each building draws its
  proportions and colours from its own identifier, and every detail is
  filtered against the pixel, fading to its average with distance instead of
  shimmering. Normals come from the screen-space derivatives of position,
  exact for flat faces and free in memory. Settings → Layers turns them off
  and sets their detail and memory.
- **Bridges and structures.** swissTLM3D's 3D objects, which include the
  country's bridges and cable cars, through the same streamer. The terrain is
  the bare ground with bridges removed, so without them a road over a valley
  is only a picture on the valley floor. They are drawn as concrete, with
  their tops coloured by the aerial photo like roofs, and are solid like
  buildings. Layers → *Bridges & structures*. Which object types the service
  really holds is printed to the console as tiles arrive.
- **Camera.** Longitude, latitude, height and two angles, with a floating
  origin so float32 vertex positions stay exact. Where you were, and whether
  you were walking, is restored on reload, or you can pin a home.
- **Imagery.** SWISSIMAGE aerial photos as a clipmap: a stack of zoom levels,
  each a 16×16-tile window centred under you in one layer of a texture array,
  from about 435 km across at zoom 10 down to about 400 m at zoom 20. Windows
  are toroidal, so moving only loads the tiles that enter. A level is only
  fetched where it will be sampled: fine ones near you, coarse ones out to the
  edge of the terrain. JPEGs decode on the codec threads and are compressed to
  BC1 by a compute shader on arrival, 4 bits a pixel instead of 32. Where a
  finer tile has not arrived yet, the shader falls back to a coarser level, so
  streaming shows as blur, never as holes. Beyond Switzerland the ground keeps
  its altitude colours. Settings → Graphics → *Imagery detail* sets the window
  to 8, 12 or 16 tiles, about 22, 50 or 88 MB of video memory, and *Terrain
  view → Imagery levels* colours the ground by the zoom level being drawn.
- **Colour.** Shading happens in linear light and is encoded to sRGB once, at
  output, so photographs come out looking like the photographs.
- **Physics.** Flying and walking are separate controllers stepping at 120 Hz on
  the render thread. Walking stands on the terrain's own triangles through a
  grid index the C core builds for the finest tiles around you, including the
  ones behind you that are not drawn; a lookup costs about 0.05 µs. Buildings
  and bridges collide through the same kind of grid, built by the C core on
  the decode threads over exactly the triangles that are drawn
  (`wasm/src/solid.c`). Around you the streamers load every tile in full
  detail whether or not it is on screen, tiles near the camera keep a CPU copy
  of their triangles, and each frame the few within reach are gathered into
  one short list that every physics step asks: the highest surface to stand
  on, the lowest one overhead, and how far an upright body 30 cm in radius is
  pushed out of the walls it overlaps (`js/engine/features/solid.js`). Moves
  are swept in steps shorter than the body, so speed cannot tunnel through a
  wall. Whether a spot is inside a building is decided the way it is for any
  closed shape, by counting the surfaces straight above it: odd is inside,
  even is outside or under a bridge.
- **Interface.** Search with live suggestions, a settings panel generated from a
  schema, and an instrument readout.

## Layout

    index.html
    css/ui.css
    js/main.js                   page thread: boot, UI wiring, nothing per frame
    js/core/rpc.js               the message protocol every thread speaks
    js/core/workers.js           blob spawning and load-balanced dispatch
    js/core/wasm.js              compile once, instantiate per thread
    js/core/math.js              f64 geodesy, ellipsoid radii, Mercator, reverse-Z
    js/core/settings.js          the schema that drives the settings panel
    js/core/session.js           where you were, for resuming there
    js/core/input.js             keys, mouse, double-tap, browser shortcut capture
    js/adapters/adapter.js       the contract a data source plugs into
    js/adapters/registry.js      which source serves which area, per tile
    js/adapters/index.js         every registered source
    js/adapters/swisstopo.js     Switzerland
    js/adapters/open-meteo.js    worldwide place names for Global search
    js/engine/gpu.js             device negotiation, capabilities, GPU timing
    js/engine/frame.js           render targets, resize, the loop
    js/engine/camera.js          position and view; controllers move it
    js/engine/view.js            what the camera sees this frame: frustum, distances, horizon
    js/engine/bounds.js          bounding spheres for regions, boxes and spheres
    js/engine/controllers/       fly.js and walk.js
    js/engine/terrain/           the quadtree, layer.json and availability, ground lookup
    js/engine/features/          the 3D Tiles streamer and the collision world
    js/engine/imagery/           the clipmap, its source, Web Mercator in doubles
    js/engine/passes/            one file per render pass, and the shared frame uniforms
    js/engine/shaders.js         joins WGSL files, maps errors back to them
    js/engine/shaders/           common (output), frame (lighting, haze), imagery,
                                 terrain, buildings, sky, bc1
    js/formats/                  b3dm, glTF, Draco and meshopt loading, tile content
    js/workers/render.js         the render thread: device, camera, physics
    js/workers/codec.js          a decode thread
    js/ui/                       boot, readout, search, settings
    vendor/                      the Draco and meshopt decoders, with their licences
    wasm/core.wasm               prebuilt, committed
    wasm/src/core.h, core.c      shared declarations, the arena
    wasm/src/mathf.c             sin, cos and geodetic-to-ECEF without libm
    wasm/src/qm.h, qm.c          Quantized Mesh parser and render decoder
    wasm/src/ground.c            the triangle grid physics stands on
    wasm/src/mesh.c              building meshes: placement and 12-byte packing
    wasm/src/solid.c             the triangle grid buildings collide through
    wasm/build.sh                only needed if you edit the C
    wasm/test.mjs                node wasm/test.mjs
    tools/                       the verification rig, never loaded by the app

## Rebuilding the wasm

You do not need to. If you edit anything under `wasm/src/`:

    sudo apt install clang lld && npm i -g binaryen
    ./wasm/build.sh

## Verification

`tools/` is never loaded by the app. `tools/verify.mjs` runs the real page in
Chromium on a software GPU (SwiftShader), answers every swisstopo request from
`tools/mock-data.mjs` with synthetic but valid Quantized Mesh tiles, and fails
on any WebGPU validation error, uncaught exception or failed module load:

    xvfb-run -a node tools/verify.mjs --shot frame.png
    xvfb-run -a node tools/verify.mjs --scenario buildings --settings '{"renderScale":0.5}' --shot b.png
    xvfb-run -a node tools/verify.mjs --scenario lod --settings '{"renderScale":0.5}' --shot lod.png
    xvfb-run -a node tools/verify.mjs --scenario walk --settings '{"renderScale":0.25}'
    xvfb-run -a node tools/verify.mjs --scenario collide --settings '{"renderScale":0.35}' --shot c.png
    xvfb-run -a node tools/verify.mjs --scenario imagery --settings '{"renderScale":0.5}' --shot im.png
    xvfb-run -a node tools/bc1-test.mjs

The buildings scenario serves a small stand-in town the way swissBUILDINGS3D
is organised (`tools/mock-buildings.mjs`): nested tilesets, coarse boxes
replaced by gabled houses, the detailed tiles spread over plain, meshopt and
Draco glTF, one house per tile marked underground. It checks that every tile
drawn holds exactly its houses' triangles less the underground one, that
detailed tiles replace coarse ones up close, and that the layer switch works;
the stand-in photos show the houses' roofs, so the screenshots show at a
glance whether the roof texturing lines up. The rig needs the encoders once:
`npm i -g draco3dgltf meshoptimizer`.

The lod scenario checks the terrain quadtree against its own rules: the tile
under the eye is exactly as fine as the pixel budget asks, detail falls off
with distance, looking away draws less, nothing is requested that the tiles'
availability metadata says does not exist, a search pick lands you standing on
level 18 where the stand-in service has it and on 17 where it does not, New
York is reached in flight with a notice and with nothing drawn or fetched past
the horizon, imagery still works on the way back, and a small memory budget
is kept. `--session '{json}'` seeds the saved camera, for testing a resume.

The walk scenario takes the pointer, double-taps Space, walks, runs, jumps,
bounces with Space held, slides off a slope it cannot climb, flies up and
falls back down, and checks each against the physics, measured on the
simulation's own clock.

The collide scenario uses the stand-in town and a stand-in bridge leaving a
ridge over the falling slope. It walks into a house wall and checks it stopped
a body's radius short, walks at it at 45° and checks it slid along, arrives
inside a house and checks it was put outside, drops onto a tower's roof and
stands there, walks out along the bridge deck with the ground falling away,
flies into a wall and stops, then with *Fly through buildings* on, does not.
It also screenshots a facade close up and the bridge from the side.

The imagery scenario serves synthetic aerial photos drawn from the same height
field as the terrain, with a line every 0.01°, so misplaced imagery is obvious
in its screenshots. It checks the sharpest level against the arithmetic, that
blank placeholder tiles are refused, and that a zoom the service does not have
is switched off after a few refusals instead of being requested forever.

`bc1-test.mjs` runs the BC1 encoder on test images, lets the GPU decode the
result, and compares it with the source and with a naive encoder put through
the same decoder. A layout mistake would show as garbage, not a small error.

The frame rate it reports is a CPU rasterizer's, not your GPU's, and the
terrain is synthetic. What it proves is that every pipeline, buffer and shader
is valid before a change ships.

## Data

Map data comes from the Swiss Federal Spatial Data Infrastructure and is
subject to its [terms of use](https://www.geo.admin.ch/en/general-terms-of-use-fsdi).
Worldwide place names come from GeoNames through Open-Meteo, under CC BY 4.0.
The two third-party decoders under `vendor/` (Draco, Apache 2.0; meshoptimizer,
MIT) are listed with their sources in `vendor/README.md`.

| What | Service |
| --- | --- |
| Terrain | Quantized Mesh from swissALTI3D, levels 0–18 with normals and availability, `3d.geo.admin.ch`, located through its `layer.json` |
| Imagery | SWISSIMAGE via WMTS, `wmts.geo.admin.ch` |
| Buildings | swissBUILDINGS3D as 3D Tiles (b3dm), `3d.geo.admin.ch` |
| Bridges and structures | swissTLM3D 3D objects as 3D Tiles (b3dm), `3d.geo.admin.ch` |
| Trees, names | 3D Tiles, `3d.geo.admin.ch`, declared for the steps that draw them |
| Place search, National | SearchServer, `api3.geo.admin.ch` |
| Place search, Global | Open-Meteo geocoding over GeoNames, no key, free tier limited to 10,000 calls a day |
