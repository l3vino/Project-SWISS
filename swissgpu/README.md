# Switzerland, streamed

A 3D reconstruction of Switzerland built from live swisstopo open data, rendered
with WebGPU. No frameworks, no build step, no API keys.

## Running it

Open `index.html` with VS Code's Live Server (or any static server) and go to the
URL it prints. Opening the file directly with `file://` will not work: ES modules
and `fetch` both need an HTTP origin.

Requires Chrome or Edge 113+ on desktop. There is no WebGL fallback by design.

## Controls

Click the view to take the mouse. **E** frees it for the search box and the
menus without leaving fullscreen, and takes it back again, like an inventory
key; **Esc** gives everything back (with the mouse already free, Esc leaves
fullscreen). **Double-tap Space** (or **F**) switches between flying and
walking. **O** or the Settings button opens the settings (freeing the mouse
and keeping fullscreen, like E), **F3** shows or
hides the readout, **F2** the performance panel. Every key can be changed in
Settings → Controls → Keys: click a key, press the new one.

*Flying:* **WASD** moves along your heading, **Space** and **Left Shift** change
altitude, the **scroll wheel** changes speed, **Ctrl** triples it. Where you are
looking never drags you up or down, and the ground is solid.

*Walking:* **WASD** walks at 1.4 m/s, **Ctrl** runs at 4.5 m/s, **Space** jumps
45 cm, and holding it keeps jumping. Switching to walking in mid-air drops you
with real gravity and air drag, so from 6,000 m the fall takes about two
minutes. Ground steeper than 45° cannot be climbed and slides you off. All of
these, and your height, are in Settings → Character and → Physics.

Buildings and bridges are solid. Walls stop you and you slide along them, kerbs
and stairs up to 40 cm are stepped up, and you can stand on roofs, terraces and
bridge decks. They are solid while flying too, the way the ground is; Settings
→ Physics → *Fly through buildings* turns that off.

You stand on the terrain being drawn, which under your feet is swisstopo's
finest level, a few metres between vertices. Physics only ever stands on
accurate ground: level 14 and finer (about 5 m of error), or the finest the
service has at that spot. While terrain streams in, the first tiles to arrive
are coarse stand-ins whose surface can be kilometres above a valley floor, and
those never lift you: flying, there is simply no floor until accurate ground is
there; walking, you wait where you are (the readout says *waiting for ground*),
unless you are falling from high above everything, which carries on. Flying
below 800 m faster than 30 m/s, the whole column of tiles under the point two
seconds ahead is requested at once, so the ground is usually there before you
are. Wherever physics needs ground and only a stand-in is loaded (under you,
40 m around you while walking, where a flight to a place will end), the column
of tiles there is requested the same way: the view only refines what it sees,
and the ground behind you is out of view.

**Ctrl K** focuses the search box, except while flying. Picking a result
**flies you there like an aircraft**. You set off the way you face, from
rest, gathering speed, nose up as you climb (steeply at first from low down,
where the houses are), then bank into a turn towards the place, cruise,
bank round onto your original heading and come in along it, so you always
leave going forward and arrive **moving and facing exactly the way you were**,
level. The route is the shortest one that does that without turning tighter
than a radius (a Dubins path: take-off run, turn, straight, turn, final
straight); the turns are flown low, the climb and descent are on the
straight between them. The view looks where you fly, as a pilot's does: it
eases into and out of every turn, the nose follows the climb and descent,
and the picture banks with the turn, up to 28°. Speed follows the height
above the ground (the ground streams past at much the same pace high or
low), slowing for turns so the view never turns faster than 50° a second;
a flight takes 5 to 20 seconds. It ends at **the same height above the
ground** as it began. **Walking, you land on the ground and walk on**: from
take-off on, everything within 100 m of the place is loaded with its
collision copy, the nearest spot outside any building is found and the end
of the route moved to it during the cruise, and the approach stays above any
building in its last 40 m before coming down. If the place is reached before
its ground and buildings are in, the flight hovers 50 m up until they are
(12 s at most), glides across and comes down. A flight ending below 50 m
lands the same way, at its height. Hops under 20 m glide straight there.
The tiles under the spot are requested when the flight starts, and the
height of the ground there is refined as they arrive and glided onto, never
jumped to. Moving the mouse on the way turns your head, easing back when you
stop; a movement key takes over where you are (a bank then levels out).
Outside Switzerland there is no terrain yet: you arrive at
least 150 m up, and a note says so. Picking a result also gives the mouse
back to the camera, so you can look around at once. In Settings → General:
*Fly to search results* off puts you there at once; *Take the mouse after
picking a result* off leaves the mouse free.

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
- **Native core.** The C under `wasm/src/` is compiled to a 36 KB wasm module,
  compiled once by the browser, then instantiated separately in every thread so
  each one gets a private heap and a bump arena.
- **Transfers.** Buffers move between threads by transfer, never by copy. Boot
  fails loudly if that stops being true.
- **Renderer.** Reverse-Z depth, per-pass GPU timing where the hardware exposes
  it, adaptive render scale.
- **Frame pacing.** Every GPU upload of arriving tiles goes through one queue
  that spends at most a quarter of a frame, and never more than 2 ms
  (`js/engine/uploads.js`), so a burst of tiles spreads over a few frames
  instead of making one late, at 60 frames a second and at 400 alike. The
  mouse is read through `pointerrawupdate`, close to every report the mouse
  sends rather than one batch per page frame, summed and sent to the render
  thread at most every 2 ms (a gaming mouse reports up to 8,000 times a
  second), and without the operating system's acceleration where the platform
  allows. A profiler (`js/engine/profiler.js`) splits each frame into physics,
  uploads, view, terrain and building selection, memory drops, housekeeping,
  the ground index, imagery, pass recording and submission; the readout shows
  the real work per frame, its 99th percentile, and how many frames came late
  in the last five seconds.
- **Work that does not grow with what is loaded.** Per-frame work scales with
  what is on screen, never with everything loaded since the session began.
  Loaded tiles are kept in least-recently-used order in a linked list with a
  marker (`js/engine/lru.js`, the way Cesium keeps its 3D Tiles cache): a
  selection marks what it uses, and dropping tiles to stay within memory takes
  the longest-unused from the head of the list, finer before coarser, without
  ever scanning or sorting the loaded tiles. When the view in front of you needs
  more than the memory budget holds, nothing unused is left to drop, and detail
  is lowered a step instead (the readout says so, in red), and raised again
  once there is room. A selection keeps only the few dozen most urgent tiles it
  would like loaded (`js/engine/topk.js`) instead of sorting hundreds.
  Housekeeping (forgetting empty branches of the terrain tree, letting go of
  collision copies far away, forgetting building files unused for a while)
  works from short lists a few hundred nodes at a time on a clock, not by
  walking the whole tree every so many frames. Hot code allocates nothing per
  frame. On the real swissBUILDINGS3D tree, flying at 150 m/s with memory
  full (`tools/bench-streaming.mjs`), this took the building streamer's cost
  per frame from 3.5 ms to 0.18 ms on average and its 99th percentile from
  7.8 to 0.34 ms, while memory now stays at its budget instead of four times
  over it; with memory to spare, the 99th percentile went from 7.1 to 1.2 ms.
- **Loading.** Everything the decode threads do goes through one scheduler
  (`js/core/scheduler.js`): at most four jobs per thread and 24 per host in
  flight, so a tile that becomes urgent waits behind a handful rather than
  fifty; what physics waits for (the ground under you, collision copies, the
  buildings where a flight will land) first; then the view, shared between
  terrain, photos and each building layer by deficit round robin, so heavy
  Draco buildings cannot crowd out light photos; preloading last. Ten times a
  second it calls off jobs for tiles the view has left, which aborts their
  downloads on the decode threads. What an answer means is decided once
  (`js/core/net.js`): nothing there (403, 404, 400, 410, 204) is never asked
  for again; a server error, a timeout or "too many requests" is tried again
  after 1, 2 and 4 s with jitter, or when the server asks (Retry-After), and a
  429 halves how many requests go to that host at once, which then recovers
  one at a time. While you move, buildings off the centre of the view wait
  until you slow down (a second at most) and tiles you would cross in under a
  second are not asked for at all, as Cesium does. Building tileset files,
  megabytes of JSON with tens of thousands of tiles each, are read on a
  decode thread into compact indexes (`js/formats/tileset-index.js`, 115
  bytes a tile) kept between visits in IndexedDB
  (`js/workers/index-cache.js`, 64 MB); tile objects are made from them only
  as far as the view walks, a third of a millisecond a frame at most, and let
  go again when unused. A terrain tile that physics may stand on brings its
  ground index from the same decode, and a building tile that reaches you
  without a collision copy gets one from its own GPU buffers, not by
  downloading and decoding it again. A flight to a search result loads what
  the view there will need, terrain, buildings and photos, while it flies.
  The buffers a decoded tile arrives in go back to the decode threads once
  its contents are on the GPU and are filled with the next tiles
  (`js/core/buffer-pool.js`), so streaming leaves no garbage outside the
  heap on the render thread, which is what set off its full garbage
  collections. The tree walk reads tile bounds straight from the compact
  indexes, siblings side by side in memory, instead of following a chain of
  small objects per tile.
  Settings → Graphics → *Decode threads* (Auto: half your processor's threads
  less one, 2 to 8) applies at once. On the real swissBUILDINGS3D tree
  (`tools/bench-streaming.mjs`, a 50 s flight at 150 m/s), the render
  thread's worst frame went from about 400 ms (the tileset files were read
  there) to 7 ms, its average from 0.27 to 0.18 ms and its 99th percentile
  from 0.8 to 0.6 ms, with 3,745 tile objects made instead of 74,010.
- **Performance panel** (**F2**, or Settings → General). Frame times as
  percentiles, the render thread's time per section (mean, 95th percentile,
  worst), the GPU's time per pass and for the whole frame, draw calls and
  triangles, memory per layer against its budget, what is streaming, and
  which GPU the browser actually picked, with everything it says about it.
  *Copy report* puts all of it on the clipboard as plain text; *Pause
  streaming* stops new requests, which separates the cost of loading from
  the cost of drawing.
- **Adapters, routed by area.** `registry.js` answers "who serves this
  rectangle?" per tile rather than per session, so a tile on a border is
  offered to each source in priority order and an unmapped region is simply
  never requested. National search asks every country source covering the
  current view at once and merges the results; Global asks the worldwide index.
- **Terrain.** Quantized Mesh tiles from swisstopo (swissALTI3D, levels 0 to
  18), decoded in C on the decode threads, uploaded as 24-byte vertices.
  A quadtree picks the detail per tile by distance: the finest level is kept
  out to the *Full terrain detail* distance (150 m by default) and each coarser
  level reaches twice as far, which gives level 17–18 under your feet and
  coarse tiles at the horizon. Only tiles in view are visited; a parent stays drawn until
  every child in view has arrived, so refinement never opens holes; requests
  go out nearest first; a memory budget drops what has been out of sight
  longest, and lowers distant detail when the view alone needs more (see
  above). The tiles' own availability metadata says which finer tiles exist,
  so nothing is requested that the service does not have, and where finer
  data stops, the coarser tile keeps covering that quarter. The tiles' own
  per-vertex normals are used, so lighting is seamless across tile edges.
  Skirts are sized per level and face outward, which lets back faces be
  culled. Settings → Graphics → *View distance* stops drawing and fetching
  anything farther and fades the last stretch into the sky behind it; *Full
  terrain detail* and *Terrain memory* are next to it, and *Terrain view →
  Terrain levels* colours each tile by its level.
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
  within a few centimetres across a tile.
- **What buildings look like.** On arrival the C core measures every
  building (`mesh_features`): its height, where its eaves are (the lowest
  corner of its roof), the ground it covers and how much of its roof is
  pitched. Rules the adapter declares as plain data
  (`js/adapters/swisstopo-buildings.js`) then give each one a look from
  that, its type in swissBUILDINGS3D, whether the building register lists
  it, the altitude and the region: warm ochre, salmon and rose render and
  bare stone *rustici* south of the Alps, pale limestone tones in the west,
  white and cream on the plateau, log and board chalets on a rendered
  ground floor above about 1,150 m, board barns on a stone or rendered
  base, clad halls, concrete and glass towers, rendered churches with tall
  windows, rubble castles and walls, brick chimneys, metal tanks. The first
  rule that matches wins, so they read as a list of exceptions ending in
  the ordinary house; another country's adapter brings its own. The result
  is eight bytes per building in one shared GPU buffer
  (`js/engine/features/feature-pool.js`): wall colour, material, base,
  kind of openings, shutters, window surrounds, eave height and overhang.
- **Walls.** The materials, render, rough render, rubble stone, cut stone,
  brick, boards, logs, concrete and ribbed metal, are drawn on the GPU at
  start-up into a texture array (`shaders/materials.wgsl`, about 11 MB, a
  few milliseconds, nothing downloaded): each texel holds how much lighter
  or darker than the building's colour it is, whether it is a joint, and
  the slope of the surface, so stones and logs are lit by the sun as relief.
  Every mip level is there and walls are sampled anisotropically, so they
  stay sharp edge-on and settle to their average far away. On top, drawn
  per pixel: windows laid out by the building's own bays and storeys, with
  frames, sills, painted surrounds on some, recessed glass reflecting the
  real sky more the more obliquely you see it, and open louvred shutters on
  others; ribbon windows on offices, a high band on halls, tall narrow ones
  on churches, few and small on old stone; a plinth or a whole ground
  storey of another material; rain streaks under sills; and the shadow of
  the eaves, as deep down the wall as the overhang's shadow really reaches
  for where the sun is, with the sky partly hidden just under it. Every
  detail is filtered against the pixel, fading to its average with distance
  instead of shimmering. Normals come from the screen-space derivatives of
  position, exact for flat faces and free in memory. Settings → Layers turns
  buildings off and sets how far out they are drawn, how far out they keep
  full detail, both in kilometres, and their memory.
- **Bridges and structures.** swissTLM3D's 3D objects, which include the
  country's bridges and cable cars, through the same streamer. The terrain is
  the bare ground with bridges removed, so without them a road over a valley
  is only a picture on the valley floor. They are drawn as concrete, with
  their tops coloured by the aerial photo like roofs, and are solid like
  buildings. Layers → *Bridges & structures*. Which object types the service
  really holds is printed to the console as tiles arrive.
- **Cable cars.** swissTLM3D models every cable car and material ropeway as a
  tube a metre or two thick around its line. On the decode threads the line
  is recovered from the tube (`js/formats/lines.js`: the tube's vertices
  cluster at the line's corners, which are the mast tops, and its long side
  triangles join them) and drawn as what it is (`js/engine/passes/cables.js`):
  ropes sagging between the masts, two strands for tramways, gondolas, chairs
  and drag lifts, real rope thickness, drawn as anti-aliased lines that stay
  a pixel wide and fade with distance rather than vanish in steps; and a pylon
  at every mast, a lattice tower or a slim tube by kind of lift, with its
  crossarm. The tubes are neither drawn nor solid: you fly through ropes.
- **Camera.** Longitude, latitude, height and two angles, with a floating
  origin so float32 vertex positions stay exact. Where you were, and whether
  you were walking, is restored on reload, or you can pin a home.
- **Imagery.** SWISSIMAGE aerial photos as a clipmap: a stack of zoom levels,
  each a 16×16-tile window centred under you in one layer of a texture array,
  from about 435 km across at zoom 10 down to about 400 m at zoom 20. Windows
  are toroidal, so moving only loads the tiles that enter. A level is only
  fetched where it will be sampled: fine ones near you, coarse ones out to the
  edge of the terrain. JPEGs decode on the decode threads and are compressed
  there by the C core (`wasm/src/bc.c`) into the GPU's own block format, so a
  tile arrives ready and costs the render thread one copy. *Photo quality*
  High uses BC7, 8 bits a pixel with sixteen shades in every 4×4 block, which
  keeps the photos free of the grain the cheaper format adds; Standard uses
  BC1, 4 bits a pixel. Either is a quarter or an eighth of plain RGBA. Where a
  finer tile has not arrived yet, the shader falls back to a coarser level, so
  streaming shows as blur, never as holes. Beyond Switzerland the ground keeps
  its altitude colours. Settings → Graphics → *Sharp photo radius* sets how
  far the finest photos reach, *Photo sharpness* trades crispness against the
  shimmer of distant forests, and *Terrain view → Imagery levels* colours the
  ground by the zoom level being drawn.
- **Sky, light and haze.** One model of the air
  (`shaders/atmosphere.wgsl`, Sébastien Hillaire's method from EGSR 2020, as
  Unreal Engine uses): Rayleigh scattering for the blue, Mie scattering for
  haze and the glow round the sun, ozone, over a round earth. Small tables
  made by compute passes (`js/engine/passes/atmosphere.js`) stand in for the
  integrals: how much light survives a path through the air and the light
  scattered more than once, made once; the sky around the camera, redone
  when its height changes; and the haze between the eye and everything in
  view, a 32 × 32 × 32 grid over the screen, every frame. The same model
  gives the sunlight and skylight everything is lit by, at the ground under
  you, so a wall facing away from the sun is lit by the blue sky and the
  ground, and distant mountains fade into the right blue. Together a
  fraction of a millisecond.
- **Colour.** Shading happens in linear light and is encoded to sRGB once, at
  output. Exposure is set so that level ground in full sun comes to 1, and
  the tone curve passes everything below 0.8 through untouched and rolls
  brighter light off to white, so aerial photographs come out exactly as
  photographed while the sun and its glare on glass do not clip harshly.
- **Physics.** Flying and walking are separate controllers stepping at 120 Hz on
  the render thread. Walking stands on the terrain's own triangles through a
  grid index the C core builds for the finest tiles around you, including the
  ones behind you that are not drawn; a lookup costs about 0.05 µs. Only
  accurate tiles are indexed (level 14 and finer, or the finest there is),
  so a coarse stand-in never becomes a floor. Buildings
  and bridges collide through the same kind of grid, built by the C core on
  the decode threads over exactly the triangles that are drawn
  (`wasm/src/solid.c`). Around you the streamers load every tile in full
  detail whether or not it is on screen, tiles near the camera keep a CPU copy
  of their triangles, and each frame the few within reach are gathered into
  one short list that every physics step asks: the highest surface to stand
  on, the lowest one overhead, and how far an upright body 30 cm in radius is
  pushed out of the walls it overlaps (`js/engine/features/solid.js`). A wall
  counts only for the part of it beside the body (each triangle is clipped to
  the body's footprint first), so the side of a rising bridge, one long
  triangle spanning a hundred metres of height, is solid only where it is
  drawn; and the grid files each triangle only in the
  cells it actually crosses, not every cell of its bounding box. Moves
  are swept in steps shorter than the body, so speed cannot tunnel through a
  wall. Whether a spot is inside a building is decided the way it is for any
  closed shape, by counting the surfaces straight above it: odd is inside,
  even is outside or under a bridge.
- **Interface.** Search with live suggestions, a settings menu with a tab per
  subject (General, Graphics, Layers, Character, Physics, Controls, World)
  generated from one schema, and an instrument readout in metric or imperial.
  Switches say On and Off, sliders show their value with its unit, a setting
  changed from its default gets a reset button, and each tab can be reset.

## Layout

    index.html
    css/ui.css
    js/main.js                   page thread: boot, UI wiring, nothing per frame
    js/core/rpc.js               the message protocol every thread speaks, with cancellation
    js/core/workers.js           blob spawning, load-balanced dispatch, pools that resize
    js/core/scheduler.js         whose turn it is on the decode threads
    js/core/net.js               what a service's answer means: nothing there, try again, the file
    js/core/buffer-pool.js       result buffers that go back to the decode threads to be filled again
    js/core/wasm.js              compile once, instantiate per thread
    js/core/math.js              f64 geodesy, ellipsoid radii, Mercator, reverse-Z
    js/core/settings.js          the schema that drives the settings menu, and the key actions
    js/core/session.js           where you were, for resuming there
    js/core/input.js             keys, mouse, double-tap, browser shortcut capture
    js/adapters/adapter.js       the contract a data source plugs into
    js/adapters/registry.js      which source serves which area, per tile
    js/adapters/index.js         every registered source
    js/adapters/swisstopo.js     Switzerland
    js/adapters/swisstopo-buildings.js  what Swiss buildings look like: regions, palettes, looks, rules
    js/adapters/open-meteo.js    worldwide place names for Global search
    js/engine/gpu.js             device negotiation, capabilities, GPU timing
    js/engine/frame.js           render targets, resize, the loop
    js/engine/uploads.js         the per-frame upload budget
    js/engine/profiler.js        where each frame's time goes
    js/engine/lru.js             least-recently-used order without sorting, for every tile cache
    js/engine/topk.js            the few most urgent of many candidates, for every request queue
    js/engine/camera.js          position and view; controllers move it
    js/engine/view.js            what the camera sees this frame: frustum, distances, horizon
    js/engine/bounds.js          bounding spheres for regions, boxes and spheres
    js/engine/controllers/       fly.js, walk.js, flyto.js for flights to search results, and
                                 flight-path.js, the geometry those flights are planned with
    js/engine/terrain/           the quadtree, layer.json and availability, ground lookup
    js/engine/features/          the 3D Tiles streamer, the collision world, building looks
                                 (appearance.js), their shared GPU records (feature-pool.js)
    js/engine/material-library.js  the wall materials, drawn on the GPU at start-up
    js/engine/imagery/           the clipmap, its source, Web Mercator in doubles
    js/engine/passes/            one file per pass: the atmosphere's compute passes, sky,
                                 terrain, buildings, cables; and the shared frame uniforms
    js/engine/shaders.js         joins WGSL files, maps errors back to them
    js/engine/shaders/           common (output), atmosphere and atmosphere-luts (the air),
                                 frame (light, haze), imagery, terrain, buildings,
                                 materials, sky, cables
    js/formats/                  b3dm, glTF, Draco and meshopt loading, tile content,
                                 lines.js (lines a source models as tubes back to lines) and
                                 tileset-index.js (tileset files as compact indexes)
    js/workers/render.js         the render thread: device, camera, physics
    js/workers/codec.js          a decode thread
    js/workers/index-cache.js    tileset indexes kept in IndexedDB
    js/ui/                       boot, readout, search, the settings menu, the performance panel
    vendor/                      the Draco and meshopt decoders, with their licences
    wasm/core.wasm               prebuilt, committed
    wasm/src/core.h, core.c      shared declarations, the arena
    wasm/src/mathf.c             sin, cos and geodetic-to-ECEF without libm
    wasm/src/qm.h, qm.c          Quantized Mesh parser and render decoder
    wasm/src/ground.c            the triangle grid physics stands on
    wasm/src/mesh.c              building meshes: placement, 12-byte packing, measurements
    wasm/src/solid.c             the triangle grid buildings collide through
    wasm/src/bc.c                BC7 and BC1 encoders for the aerial photos
    wasm/build.sh                only needed if you edit the C
    wasm/test.mjs                node wasm/test.mjs
    tools/                       the verification rig, never loaded by the app; fixtures/
                                 holds a real tile the tests decode

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
    xvfb-run -a node tools/verify.mjs --scenario perf --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario stress --settings '{"renderScale":0.25}'
    xvfb-run -a node tools/verify.mjs --scenario stream --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario ui --settings '{"renderScale":0.5}' --shot ui.png
    xvfb-run -a node tools/verify.mjs --scenario flight --settings '{"renderScale":0.35}'
    xvfb-run -a node tools/verify.mjs --scenario look --settings '{"renderScale":0.5}' --shot look.png
    xvfb-run -a node tools/bc-test.mjs
    node --expose-gc tools/bench-streaming.mjs --frames 6000 --worst 10
    xvfb-run -a node tools/live-tour.mjs --seconds 90        # needs the network
    xvfb-run -a node tools/live-tour.mjs --seconds 30 --threads 8 --flights "8.9511,46.0037" [--walk]
    xvfb-run -a node tools/live-startup.mjs --seconds 30     # needs the network

The buildings scenario serves a small stand-in town the way swissBUILDINGS3D
is organised (`tools/mock-buildings.mjs`): nested tilesets, coarse boxes
replaced by gabled houses, the detailed tiles spread over plain, meshopt and
Draco glTF, one house per tile marked underground. It checks that every tile
drawn holds exactly its houses' triangles less the underground one, that
detailed tiles replace coarse ones up close, that the layer switch works, and
that the tileset files are indexed on the decode threads and, after a reload,
read from IndexedDB rather than downloaded again;
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
Then a cable car, modelled as swissTLM3D models one (a 1 m tube whose sides
run the whole span, 40° then 15° up, with a ball at the mast): it is drawn as
a rope with its exact number of pieces and one pylon, and no tube; flying
under it, level with it and over it all pass. It also screenshots a facade
close up and the bridge from the side.

The imagery scenario serves synthetic aerial photos drawn from the same height
field as the terrain, with a line every 0.01°, so misplaced imagery is obvious
in its screenshots. It checks the sharpest level against the arithmetic, that
blank placeholder tiles are refused, and that a zoom the service does not have
is switched off after a few refusals instead of being requested forever.

The perf scenario flies low over the stand-in town while everything streams
and prints where each frame's time went, section by section, with the 95th
percentile and the worst frame of each; it checks that uploads stayed inside
their slice.

The stress scenario gives terrain and buildings a fraction of the memory the
view needs and flies over the town turning, the situation that used to scan
and sort every loaded tile each frame. It checks that memory stays within the
budgets (detail is lowered instead), that dropping tiles and housekeeping stay
cheap frame after frame, that detail comes back once there is room, that
pausing streaming stops new requests and resuming picks up again, and that the
decode jobs out never exceed the scheduler's capacity.

The stream scenario makes the stand-in services misbehave (`faults` in
`verify.mjs`) and checks the loading rules: a server error is tried again a
moment later and loads; a 429 with Retry-After: 2 is tried again no sooner,
and halves the host's share of requests, which then recovers; an answer that
never comes is given up at the job's timeout and asked for again; requests
for what the view has left are called off; everything loads once the
services behave; nothing the services said is not there is ever asked for
twice; the jobs out never exceed the capacity; and with eight decode
threads and photos answering slowly, a search flight's photos fetched ahead
go out with the spare slots without upsetting the checks for stale requests.

The ui scenario works the settings menu like a person: opens it, switches
tabs, sets a choice and a distance slider and checks the renderer obeyed,
resets, flips a switch, binds Move forward to another key and walks with it,
closes it with Esc. Then the mouse: E frees it and keeps fullscreen, E takes it
back, and with it free Esc leaves fullscreen; O opens the menu, freeing the
mouse and keeping fullscreen. Then it searches through the real search box
(the rig answers for both search services) and picks results: the pick takes
the mouse back; the flight sets off within 2° of the camera's heading with the
view not turning, banks into its turns (and never against them), never turns
faster than 60° a second, flies its final straight within 3° of the start
heading and arrives facing exactly that way, level, at the same height above
the ground; with *Fly to search results* off, it is there at once; a 150 m
hop straight ahead flies straight there; walking, a pick of an address in
the middle of a house lands you on open ground beside it, walking; flying 5 m
up, the same pick ends 5 m up, outside the house. `wasm/test.mjs` also
decodes the stand-in cable car through the tile decoder and checks the rope,
its sag and the pylon against the model, and a real swissTLM3D tile
(`tools/fixtures/tlm-gorduno.b3dm`, Draco-compressed, saved from the live
service) whose ropeway must come out as 114 rope pieces through its masts at
the heights measured from the tube, with its bridges kept.

The flight scenario starts in basins of the stand-in terrain far from anything
loaded, where the coarse tiles that arrive first are far above the floor, as
over the Alps. Placed low with no key held, the camera must not move while the
terrain streams in; physics must only use accurate levels; flying at 250 m/s
40 m over ground that has not loaded, the camera may only rise onto accurate
ground, and the columns ahead must have been requested; a walker placed over
unloaded ground waits and then drops onto the accurate ground, and running
backwards from there, away from everything the view has loaded, never meets
an edge; a walker high above everything falls at once.

The look scenario measures nothing: it saves screenshots of the stand-in
town from the street, from arm's length, from above a row and from a
hillside, and of the cable car from beside it, for judging the walls, the
light, the sky and the ropes by eye.

`bc-test.mjs` runs the C encoders on test images, lets the GPU's own decoder
read the blocks back, and compares with the source and with a naive BC1
encoder put through the same decoder; BC7 has to beat BC1 clearly. A layout
mistake would show as garbage, not a small error.

`bench-streaming.mjs` runs in Node, without a browser: the app's own terrain
and 3D Tiles streamers against the stand-in terrain and the real
swissBUILDINGS3D tileset tree, with a fake GPU and decode pool, timing only
what the render thread does per frame to decide what to draw, load and drop,
and what it does with arriving results. Time runs on a simulated clock of 120
frames a second. A first, untimed flight makes the stand-in tiles, whose
garbage would otherwise land in the timed frames; tileset files are indexed
on a thread of their own, as the decode threads do in the app; result buffers
go round as they do in the app. `--root` points it at another copy of the
app, to compare two versions; `--worst N` lists the slowest frames section
by section.

`live-tour.mjs` and `live-startup.mjs` use the real services. The tour runs
the app against swisstopo at Bellinzona with small memory budgets, flies a
turning tour at 150 m/s and prints the render thread's cost per section every
ten seconds. `--threads` sets the decode threads, `--flights` first flies to
each place as a search pick does (real latency, preloading and all) and
`--walk` makes those flights land walking; every delivery is run this way
too, since the stand-in answers instantly and cannot show what real latency
does. The startup check starts flying at 330 m in the valley at
Bellinzona, holds no key, and prints the camera's height as the terrain
streams in; it fails if the camera rose (before the accurate-ground rule it was
lifted to 3,286 m). Both take `--root` for comparing two versions.

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
