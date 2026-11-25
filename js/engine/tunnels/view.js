/* view.js — the tunnels on the render thread (5.19a): what is drawn and what the bodies touch, as the tunnels'
 * thread places them (workers/tunnels.js runs engine/tunnels/tunnels.js).
 *
 * That thread sends each mesh it makes with a compact copy of the tube as placed (placed.js), and after every change
 * the lists the passes read: the meshes in the order drawn, the portals where the terrain is opened, which bores run
 * into each other. Here: the meshes' GPU buffers (made in a frame's upload slice, then the thread is told), the cuts
 * the terrain and buildings passes cut along, the bore the camera and the bodies are in (placed.js TubeQuery), the
 * light at the eye inside one. And the other way, what that thread needs from this one: the camera, the road service,
 * the detail road tiles' tunnel runs and the bridges' decks as they come and go (each sent once, not every time
 * something changes), and what the portals' checks against the ground as drawn found (portal-checks.js).
 *
 * The same face to the rest of the render thread as tunnels.js had up to 5.18b: meshes, portals, cuts, cutVersion,
 * meets, meetsOf, boreAt, boreNear, roomAt, eyeLight, enabled, stats, bytes.
 */

import { enuBasis } from '../../core/math.js';
import { meetsInFrame } from './cuts.js';
import { PlacedTube, TubeQuery } from './placed.js';
import { PortalChecks } from './portal-checks.js';

/* The eye in a tunnel (5.18b): the lamps' light against daylight on level ground (passes/tunnels.js hands it to
 * tunnel.wgsl, which dims them by it: from daylight a tunnel is dark inside), and how fast the eye adapts, in
 * stops a second: to the dark slower than back to daylight (as Unreal's eye adaptation by default; the eye takes
 * seconds in a tunnel's mouth and less coming out into the glare). render.js does the adapting. */
export const EYE = { interior: 1 / 16, darker: 1.2, brighter: 3 };

export class TunnelView {
  /**
   * @param thread  the tunnels' thread (core/rpc.js Endpoint)
   * @param vector  the road tiles (engine/vector/tiles.js): their service, tiles, tunnel runs, decks, portal floors
   */
  constructor({ device, uploads, vector, thread }) {
    this.device = device;
    this.uploads = uploads;
    this.vector = vector;
    this.thread = thread;
    this.enabled = true;
    this.meshes = [];              // what the pass draws, in order
    this.portals = [];             // where the terrain is opened
    this.cuts = [];                // the bores cut out of what is built (cuts.js), and a number that changes with them
    this.cutVersion = 0;
    this.meets = [];               // per cut, the other bores reaching into it (cuts.js boreMeets)
    this.stats = { tubes: 0, meshes: 0 };
    this.busy = 0;                 // the work the thread still has to do (5.18e: the console's settled waits for none)
    this.busyWhy = null;           // and of what kinds
    this.bytes = 0;
    this.byId = new Map();         // mesh id → mesh with its buffers (listed, or about to be)
    this.query = new TubeQuery();
    this.checks = new PortalChecks();
    this.insideBore = {};
    // What the thread has been sent (each thing once).
    this.sent = { lon: NaN, lat: NaN, source: null, tunnelVersion: -1, runs: new Map(), deckEpoch: -1, deckOn: null, decks: new Map(), track: null,
      railVersion: -1, rails: new Map() };
    this.deckIds = 0;
    thread.on('mesh', (msg) => this.#mesh(msg));
    thread.on('mesh-unused', ({ id }) => this.#unused(id));
    thread.on('lists', (lists) => this.#lists(lists));
    // The railways' profiles made there (5.18d): the terrain is cut along them (vector/tiles.js setProfiles).
    thread.on('profiles', ({ key, lines }) => this.vector.setProfiles(key, lines));
    thread.on('busy', ({ n, why }) => { this.busy = n; this.busyWhy = why; });
  }

  setEnabled(on) {
    this.enabled = on;
    this.thread.send('enabled', { on });
  }

  /** Once a frame: the camera, and the road tiles' tunnels and the decks where they changed, to the thread; which
   *  mesh the camera is in. */
  update(camera) {
    // The detail tiles' railway lines whether the tunnels are on or not: their profiles cut the terrain either way.
    if (this.vector.railVersion !== this.sent.railVersion) this.#sendRails();
    if (!this.enabled) {
      if (camera.lon !== this.sent.lon || camera.lat !== this.sent.lat) this.#sendCamera(camera);
      return;
    }
    this.#sendRoads();
    if (this.vector.tunnelVersion !== this.sent.tunnelVersion) this.#sendRuns();
    if (this.vector.decks) this.#sendDecks(this.vector.decks);
    // Whether the open track is built in 3D: a railway tube's bed stands as high as its (5.18c).
    if (this.vector.tracks !== this.sent.track) {
      this.sent.track = this.vector.tracks;
      this.thread.send('track', { on: this.vector.tracks });
    }
    if (camera.lon !== this.sent.lon || camera.lat !== this.sent.lat) this.#sendCamera(camera);
    this.#inside(camera);
  }

  #sendCamera(camera) {
    this.sent.lon = camera.lon; this.sent.lat = camera.lat;
    this.thread.send('camera', { lon: camera.lon, lat: camera.lat });
  }

  /* The detail tiles' railway lines (vector/tiles.js t.rails), each tile's once, and the tiles gone (5.18d). */
  #sendRails() {
    this.sent.railVersion = this.vector.railVersion;
    this.vector.profilesExpected = !this.thread.missing;
    const live = new Set(), added = [], removed = [];
    for (const [key, t] of this.vector.tiles) {
      if (t.level !== 0 || !t.rails?.length) continue;
      live.add(key);
      if (this.sent.rails.get(key) !== t.rails) { this.sent.rails.set(key, t.rails); added.push([key, t.rails]); }
    }
    for (const key of this.sent.rails.keys()) if (!live.has(key)) removed.push(key);
    for (const key of removed) this.sent.rails.delete(key);
    if (added.length || removed.length) this.thread.send('rails', { added, removed });
  }

  /**
   * The portals checked against the ground as drawn (portal-checks.js); what is found goes to the thread.
   * @param ground  { groundAt, shapedGround, shapedAt, epoch } (portal-checks.js run)
   */
  checkPortals(ground) {
    if (!this.enabled || !this.query.tubes.length) return;
    const corrections = this.checks.run(this.query.tubes, ground);
    if (corrections.length) this.thread.send('checks', { corrections });
  }

  /* ---- the bodies ------------------------------------------------------------------------------------------------ */

  /** The tube a point is inside, or null (placed.js TubeQuery boreAt: the controllers ask every physics step). */
  boreAt(lon, lat, feet, out, past = 0) {
    return this.query.boreAt(lon, lat, feet, out, past);
  }

  /** The nearest place inside a bore within `within` metres (placed.js TubeQuery boreNear). */
  boreNear(lon, lat, within, out) {
    return this.query.boreNear(lon, lat, within, out);
  }

  /** Whether a body is in the room a tube takes out of what is built (placed.js TubeQuery roomAt). */
  roomAt(lon, lat, feet) {
    return this.enabled && this.query.roomAt(lon, lat, feet);
  }

  /**
   * The light at the eye against daylight on level ground: 1 outside a tunnel; inside, the daylight falling in at
   * its portals (as tunnel.wgsl tDaylight has it) and its lamps' (EYE.interior). render.js adapts the eye to it.
   */
  eyeLight() {
    const m = this.#eyeRoom();
    return m ? daylightIn(m) + EYE.interior : 1;
  }

  /** The daylight at the eye against level ground's: 1 outside a tunnel; inside, what falls in at its portals, near 0
   *  deep in it (passes/terrain.js: the ground met from beneath dark there, 5.18j). */
  daylightAtEye() {
    const m = this.#eyeRoom();
    return m ? daylightIn(m) : 1;
  }

  /* The mesh the camera is in (#inside), or null. */
  #eyeRoom() {
    if (!this.enabled) return null;
    for (const m of this.meshes) if (m.inside && !Number.isNaN(m.insideAt)) return m;
    return null;
  }

  /**
   * A mesh's pieces of the other bores reaching into it (5.17m), in its own frame (east, north and up at its origin,
   * the vertices' own): { data: Float32Array (cuts.js CUT_FLOATS each), frame }, or null where none does. Kept on
   * the mesh until the tubes change (passes/tunnels.js adds how far they reach and their order).
   */
  meetsOf(m) {
    if (!this.enabled || m.cutIndex < 0) return null;
    const meets = this.meets[m.cutIndex];
    if (!meets?.length) return null;
    if (m.meet?.version !== this.cutVersion) {
      const e = new Float64Array(3), n = new Float64Array(3), u = new Float64Array(3);
      enuBasis(m.originLonLat[0], m.originLonLat[1], e, n, u);
      const frame = { origin: m.origin, east: e, north: n, up: u };
      const out = meetsInFrame(this.cuts, meets, frame);
      m.meet = { version: this.cutVersion, data: out.length ? Float32Array.from(out) : null, frame };
    }
    return m.meet.data ? m.meet : null;
  }

  /**
   * The tunnels for the probe: the thread's report of its tubes (tunnels.js report), with what only this thread
   * knows: each tube's portal checks (trimSeen), whether the camera is in its mesh, its cuttings' walls against the
   * ground as drawn; the portals; the bore the camera is in.
   * @param groundAt  (lon, lat) => the ground as drawn (accurate), or null
   * @param camera    { lon, lat, height }
   */
  async report(groundAt, camera) {
    let base = null;
    try { base = await this.thread.request('report', null, undefined, { timeout: 10000 }); } catch (err) { base = { error: err.message, tubes: [] }; }
    if (!base) return null;
    const r2 = (v) => Math.round(v * 100) / 100;
    const drawn = new Map(this.meshes.map((m) => [m.tube.key, m]));
    for (const t of base.tubes) {
      const m = drawn.get(t.key);
      t.trimSeen = m?.tube.trimSeen ?? null;
      if (t.mesh) t.mesh.inside = Boolean(m?.inside);
      t.cuttings = m?.cuttings ? m.cuttings.map((c) => c && cuttingReport(c, groundAt)) : null;
    }
    const b = this.boreAt(camera.lon, camera.lat, camera.height - 1.7, {});
    return {
      ...base, enabled: this.enabled, bytes: this.bytes,
      portals: this.portals.map((q) => ({ lon: q.lon, lat: q.lat, h: q.h, half: q.mouth ?? q.half, wall: q.wall, rise: q.rise,
        // The terrain's opening there (5.17d's way, in 5.17i): its outline's half-width, how deep and how it bends.
        start: q.start, open: { half: q.half, spring: q.spring, before: q.before, depth: q.depth, bend: q.bend } })),
      // The bore the camera is in, if any (as the controllers ask: feet an eye under it).
      boreHere: b ? { key: b.record.key, s: Math.round(b.s), floor: r2(b.floor), top: r2(b.top), across: r2(b.across) } : null,
    };
  }

  /* ---- from the thread ------------------------------------------------------------------------------------------- */

  /* A mesh made: its buffers, in a frame's upload slice; the thread is answered once they are there. */
  async #mesh({ mesh, vertices, indices, vertexCount, indexCount, stride, copy }) {
    const m = { ...mesh, vbuf: null, ibuf: null, inside: false, insideAt: NaN, listed: false, cutIndex: -1, meet: null, tube: new PlacedTube(copy) };
    m.tube.mesh = m;
    await this.uploads.schedule(() => {
      const vbytes = vertexCount * stride, ibytes = indexCount * 4;
      m.vbuf = this.device.createBuffer({ label: 'tunnel-vertices', size: vbytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      m.ibuf = this.device.createBuffer({ label: 'tunnel-indices', size: ibytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(m.vbuf, 0, vertices.buffer, vertices.byteOffset, vbytes);
      this.device.queue.writeBuffer(m.ibuf, 0, indices.buffer, indices.byteOffset, ibytes);
    });
    this.byId.set(m.id, m);
    return true;
  }

  /* A mesh made but not wanted after all (its tube changed meanwhile). */
  #unused(id) {
    const m = this.byId.get(id);
    if (!m || m.listed) return;
    this.#free(m);
    this.byId.delete(id);
  }

  /* The lists after a change: a mesh listed before and not now goes; the cuts in the same order as the thread's, so
   * its meetings (by cut) are this side's too. */
  #lists({ meshes, portals, meets, floors, stats, bytes }) {
    const ids = new Set(meshes);
    for (const [id, m] of this.byId) {
      if (ids.has(id)) m.listed = true;
      else if (m.listed) { this.#free(m); this.byId.delete(id); }
    }
    this.meshes = [];
    for (const id of meshes) { const m = this.byId.get(id); if (m) this.meshes.push(m); }
    this.query.tubes = this.meshes.map((m) => m.tube);
    this.portals = portals;
    this.cuts = this.meshes.map((m) => m.cut).filter(Boolean);
    this.cutVersion++;
    this.meets = meets;
    for (const m of this.meshes) { m.cutIndex = m.cut ? this.cuts.indexOf(m.cut) : -1; m.meet = null; }
    this.stats = stats;
    this.bytes = bytes;
    // Each portal's floor, for the road running into it (vector/portals.js), when they changed.
    if (floors) this.vector.setPortalFloors?.(floors);
  }

  #free(m) {
    m.vbuf?.destroy();
    m.ibuf?.destroy();
    m.vbuf = m.ibuf = null;
  }

  /* ---- to the thread --------------------------------------------------------------------------------------------- */

  /* The road service, once it is read (its tile templates and schema: the traces' tiles and the runs' kinds). */
  #sendRoads() {
    const source = this.vector.source;
    if (!source || source === this.sent.source) return;
    this.sent.source = source;
    this.thread.send('roads', { templates: source.templates, schema: source.schema });
  }

  /* The detail tiles' tunnel runs that came or went since last sent. */
  #sendRuns() {
    this.sent.tunnelVersion = this.vector.tunnelVersion;
    const live = new Set(), added = [], removed = [];
    for (const [key, t] of this.vector.tiles) {
      if (t.level !== 0 || !t.tunnels) continue;
      live.add(key);
      if (this.sent.runs.get(key) !== t.tunnels) { this.sent.runs.set(key, t.tunnels); added.push([key, t.tunnels]); }
    }
    for (const key of this.sent.runs.keys()) if (!live.has(key)) removed.push(key);
    for (const key of removed) this.sent.runs.delete(key);
    if (added.length || removed.length) this.thread.send('runs', { added, removed });
  }

  /* The bridges' decks that came or went since last sent (features/decks.js: each tile's deck tops), and whether any
   * layer of them is on. */
  #sendDecks(decks) {
    const epoch = decks.epoch, on = decks.active;
    if (epoch === this.sent.deckEpoch && on === this.sent.deckOn) return;
    this.sent.deckEpoch = epoch; this.sent.deckOn = on;
    const live = new Set(), added = [], removed = [];
    for (const t of decks.tilesets) {
      if (!t.spec.decks || !t.enabled) continue;
      for (const node of t.deckNodes) {
        const d = node.decks;
        if (!d) continue;
        live.add(d);
        if (!this.sent.decks.has(d)) {
          const id = ++this.deckIds;
          this.sent.decks.set(d, id);
          added.push([id, { keys: d.keys, heights: d.heights, step: d.step, origin: d.origin, east: d.east, north: d.north, up: d.up, box: d.box, error: d.error }]);
        }
      }
    }
    for (const [d, id] of this.sent.decks) if (!live.has(d)) { removed.push(id); this.sent.decks.delete(d); }
    this.thread.send('decks', { added, removed, on });
  }

  /* Which mesh the camera is in (no outdoor haze on it), and where along it; and those running into it (5.17m: one
   * room with it, seen from inside). */
  #inside(camera) {
    const bore = this.query.boreAt(camera.lon, camera.lat, camera.height - 1.5, this.insideBore);
    let room = null;
    for (const m of this.meshes) {
      m.inside = bore !== null && bore.record === m.tube && bore.s >= 0 && bore.s <= m.tube.length;
      if (m.inside) { m.insideAt = bore.s; room = m; }
    }
    if (!room || room.cutIndex < 0) return;
    for (const { other } of this.meets[room.cutIndex] ?? []) {
      const m = this.meshes.find((q) => q.cutIndex === other);
      if (m && !m.inside) { m.inside = true; m.insideAt = NaN; }
    }
  }
}

/* A portal's cutting for the probe (5.17u: tunnels.js cuttingFrom): metres long, the walls' half-width apart, their
 * tops' most either side, the headwall's top lowest and highest (metres over the floor); at its collar, a quarter, half
 * and three quarters out and its end: metres out, each wall's top and the ground as drawn 1 m outside it (null: not
 * indexed), over the floor there. */
function cuttingReport(c, groundAt) {
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    len: c.len, half: r2(c.half),
    walls: [0, 1].map((k) => { let most = -Infinity; for (let i = 0; i < c.n; i++) most = Math.max(most, c.tops[2 * i + k]); return r2(most); }),
    head: [r2(Math.min(...c.head)), r2(Math.max(...c.head))],
    along: [0, 0.25, 0.5, 0.75, 1].map((f) => {
      const d = f * c.len, i = Math.min(c.n - 1, Math.round((d / c.len) * (c.n - 1))), floor = c.h + c.rise * d;
      const at = (a) => {
        const x = c.te * c.dir * d + c.tn * a, y = c.tn * c.dir * d - c.te * a, m = (6378137 * Math.PI) / 180;
        const g = groundAt(c.lon + x / (m * Math.cos((c.lat * Math.PI) / 180)), c.lat + y / m);
        return g === null ? null : r2(g - floor);
      };
      const w = c.half + Math.min(d, c.wing ?? 1e9) * (c.splay ?? 0) + 1.5;   // (1 m past a wall's outer face)
      return [Math.round(d), r2(c.tops[2 * i]), at(c.off - w), r2(c.tops[2 * i + 1]), at(c.off + w)];
    }),
  };
}

/* The daylight falling in at a mesh's portals where the camera is in it (its insideAt), against level ground's, as
 * tunnel.wgsl tDaylight falls off from each portal (at most 1). */
function daylightIn(m) {
  const d0 = Math.max(m.insideAt - m.portals[0], 0), d1 = Math.max(m.portals[1] - m.insideAt, 0);
  return Math.min(1, 0.55 * (Math.exp(-d0 / 18) + Math.exp(-d1 / 18)) + 0.08 * (Math.exp(-d0 / 90) + Math.exp(-d1 / 90)));
}
