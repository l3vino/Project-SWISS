/* tunnels.js — the tunnels' thread (5.19a).
 *
 * Spawned by the render thread (workers/render.js) from a Blob URL like every thread here (core/workers.js), with
 * its own instance of the C core. It runs the whole tunnel system (engine/tunnels/tunnels.js: finding the tubes in
 * the detail road tiles' tunnel runs, tracing whole tunnels, the ground round their portals, fitting them to it,
 * their meshes and cuts) and its jobs (jobs/tunnels.js, jobs/ground.js) here, where up to 5.18b they took the render
 * thread 3.8 ms a frame while loading and 5.7 ms flying (plus the copying of every run to a decode thread whenever the
 * tiles changed). The render thread keeps only what it draws and what the bodies touch (engine/tunnels/view.js).
 *
 * From the render thread: 'init' (the compiled core), 'enabled', 'camera' (where it is, when it moves), 'roads' (the
 * road service's templates and schema), 'runs' (the detail tiles' tunnel runs as they come and go), 'decks' (the
 * bridges' decks as they come and go: portal floors on their own decks), 'track' (whether the open track is built in
 * 3D: a railway tube's bed as high as its, 5.18c), 'rails' (the detail tiles' railway lines as they come and go: their
 * profiles, engine/tunnels/rail-profiles.js, 5.18d), 'checks' (what its checks of the portals against the ground as
 * drawn found: portal-checks.js), 'report' (for the probe), 'lines' (the railway tubes' lines near a point: the console's
 * swissgpu.lines, 5.18g).
 * To it: 'mesh' (a request: a mesh's vertices and indices, transferred, its fields and the copy of its tube as placed;
 * answered once its buffers are on the GPU), 'mesh-unused', 'lists' (after every change: the meshes drawn in order,
 * the portals, the bores' meetings, the portal floors for the road tiles), 'profiles' (a road tile's railway lines'
 * height profiles, transferred: vector/tiles.js setProfiles), 'busy' (how much is still to do, when it changes: the
 * console's swissgpu.settled waits for none of it, 5.18e).
 */

import { Endpoint } from '../core/rpc.js';
import { instantiateCore } from '../core/wasm.js';
import { LocalScheduler } from '../core/local-scheduler.js';
import { registry } from '../adapters/index.js';
import { TerrainSource } from '../engine/terrain/source.js';
import { schemaKinds } from '../formats/vector-tile.js';
import { Decks } from '../engine/features/decks.js';
import { TunnelSet, MESH_FIELDS } from '../engine/tunnels/tunnels.js';
import { RailProfiles } from '../engine/tunnels/rail-profiles.js';
import { tunnelJobs } from './jobs/tunnels.js';
import { groundJob } from './jobs/ground.js';
import { BUILD } from '../build.js';

/* Milliseconds between the tubes' turns (each tube's state moved on, jobs started), whatever the frame rate. */
const TICK_MS = 33;
/* Milliseconds at least between two counts of the work still to do sent ('busy'; none left is sent at once). */
const BUSY_MS = 250;

const rpc = new Endpoint(self, 'tunnels');
const ctx = { core: null };
let set = null, rails = null, scheduler = null, ticking = 0;
let listsDue = null;     // the latest lists, sent at the end of the turn (one message for many changes)
const busy = { sent: -1, at: 0, why: { tubes: 0, mesh: 0, trace: 0, ground: 0 } };   // the work still to do last sent, when
let trackOn = true;      // the open track in 3D (the setting; kept for a set made after it came)
const railsEarly = [];   // road tiles' railway lines sent before the thread was ready
const camera = { lon: 0, lat: 0 };

/* The road tiles as far as the tunnels go (TunnelSet's `vector`), as the render thread tells them. */
const roads = {
  source: null,          // { templates, schema }
  kinds: null,           // the schema's kinds (formats/vector-tile.js)
  tiles: new Map(),      // detail tile key → { level: 0, tunnels: its runs }
  tunnelVersion: 0,
  decks: null,           // features/decks.js over the bridges' decks sent
};

/* The bridges' decks sent (one stand-in tileset for features/decks.js), by id. */
const deckSet = { spec: { decks: true }, enabled: false, deckNodes: new Set(), deckEpoch: 0 };
const deckNodes = new Map();

/* What is placed goes to the render thread (engine/tunnels/view.js). */
const sink = {
  mesh(mesh, data, copy) {
    const fields = {};
    for (const k of MESH_FIELDS) fields[k] = mesh[k];
    const { vertices, indices } = data;
    return rpc.request('mesh', { mesh: fields, vertices, indices, vertexCount: data.vertexCount, indexCount: data.indexCount, stride: data.stride, copy },
      [vertices.buffer, indices.buffer, copy.points.buffer, copy.floor.buffer]);
  },
  unused(mesh) { rpc.send('mesh-unused', { id: mesh.id }); },
  lists(lists) { listsDue = lists; },
};

rpc.on('init', async ({ wasmModule }) => {
  ctx.core = instantiateCore(wasmModule);
  const failure = ctx.core.selftest();
  if (failure !== 0) throw new Error(`wasm core self-test failed with code ${failure}`);
  // The terrain services, for the ground round the portals (their layer.json again: the HTTP cache has it).
  const sources = (await Promise.all(registry.all.filter((a) => a.terrain).map((a) => TerrainSource.load(a, a.terrain)))).filter(Boolean);
  const core = ctx.core;
  scheduler = new LocalScheduler({ ...tunnelJobs(ctx), 'terrain-ground': (payload, signal) => groundJob(core, payload, signal) });
  set = new TunnelSet({ scheduler, terrain: { sourceList: sources }, vector: roads, sink });
  set.setTrack(trackOn);
  // The railways' profiles (5.18d), on the same ground as the tunnels' portals.
  rails = new RailProfiles({ scheduler, ground: set.ground, core, send: (key, lines, transfer) => rpc.send('profiles', { key, lines }, transfer) });
  for (const { added, removed } of railsEarly.splice(0)) rails.apply(added, removed);
  ticking = setInterval(tick, TICK_MS);
  return { build: BUILD, name: self.name, sources: sources.map((s) => s.describe()) };
});

function tick() {
  if (!scheduler) return;
  if (set?.enabled) set.update(camera);
  // (The railways' profiles whether the tunnels are on or not: the terrain is cut along them either way.)
  rails?.tick(camera);
  scheduler.dispatch();
  // (A mesh in them has its buffers on the render thread already: it was answered before it was set.)
  if (listsDue) { rpc.send('lists', listsDue); listsDue = null; }
  // How much is still to do (5.18e: the console's swissgpu.settled waits for none), when it changes.
  const now = performance.now(), why = busy.why;
  const tubes = set?.enabled ? set.pending(now, why) : 0, profiles = rails?.pending ?? 0;
  const n = scheduler.active + tubes + profiles;
  if (n !== busy.sent && (n === 0 || now - busy.at >= BUSY_MS)) {
    busy.sent = n; busy.at = now;
    rpc.send('busy', { n, why: { ...why, jobs: scheduler.active, profiles } });
  }
}

rpc.on('enabled', ({ on }) => set?.setEnabled(on));

rpc.on('track', ({ on }) => { trackOn = on; set?.setTrack(on); });

rpc.on('rails', ({ added, removed }) => { if (rails) rails.apply(added, removed); else railsEarly.push({ added, removed }); });

rpc.on('camera', ({ lon, lat }) => { camera.lon = lon; camera.lat = lat; });

rpc.on('roads', ({ templates, schema }) => {
  roads.source = { templates, schema };
  roads.kinds = schemaKinds(schema);
});

rpc.on('runs', ({ added, removed }) => {
  for (const key of removed) roads.tiles.delete(key);
  for (const [key, tunnels] of added) roads.tiles.set(key, { level: 0, tunnels });
  roads.tunnelVersion++;
});

rpc.on('decks', ({ added, removed, on }) => {
  for (const id of removed) { deckSet.deckNodes.delete(deckNodes.get(id)); deckNodes.delete(id); }
  for (const [id, decks] of added) { const node = { decks }; deckNodes.set(id, node); deckSet.deckNodes.add(node); }
  deckSet.enabled = on;
  deckSet.deckEpoch++;
  roads.decks ??= new Decks([deckSet]);
});

rpc.on('checks', ({ corrections }) => set?.applyChecks(corrections));

rpc.on('lines', ({ lon, lat, within }) => (set ? set.linesNear(lon, lat, within) : []));

rpc.on('report', () => (set ? { ...set.report(), rails: rails ? { ...rails.stats } : null, jobs: { ...scheduler.stats, active: scheduler.active } } : null));

rpc.announce();
