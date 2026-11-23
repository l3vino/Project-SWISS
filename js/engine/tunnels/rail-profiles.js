/* rail-profiles.js — one height profile per railway line, the same for every terrain tile it crosses (Stage 5.18d).
 *
 * Each terrain tile took a line's height from its own mesh (wasm/src/shape.c), and tiles of different levels of detail
 * disagree by up to ~1.7 m where they meet: the track stepped at their edges. So the render thread sends each detail
 * road tile's railway lines once, as their stretches on the ground (engine/vector/rails.js), and this reads the ground
 * every STEP metres along each from the terrain's finest level (RAIL_LEVEL: swissALTI3D's rebuild of May 2025; a coarser
 * one only where that is not published) through the thread's GroundPoints, makes each stretch's profile in C
 * (wasm/src/profile.c rail_profile: spikes out, smoothed over 6 m, kept where it bends by more than 12 mm), and sends a
 * road tile's profiles back all at once (to vector/tiles.js setProfiles), which every tile cut along its lines then
 * takes their heights from (pieces.js, shape.c). The road tile nearest the camera goes first, one at a time, so the
 * readings' terrain tiles (20 or so a kilometre of line) are kept only while it waits for them. Its tiles run through
 * a scheduler client of its own: the profiles come whether the tunnels are on or not.
 */

import { VIEW } from '../../core/scheduler.js';

/* The terrain's level the ground is read from (its finest), and the metres between readings along a line. */
const RAIL_LEVEL = 18;
const STEP = 2;

export class RailProfiles {
  /**
   * @param scheduler  the thread's (core/local-scheduler.js)
   * @param ground     the thread's GroundPoints (engine/terrain/ground-points.js)
   * @param core       the thread's C core (core/wasm.js)
   * @param send       (key, lines, transfer) → the render thread: a road tile's profiles, [[line, Float32Array [s, z, …]]]
   *                   (a NaN height between two stretches: a break)
   */
  constructor({ scheduler, ground, core, send }) {
    this.ground = ground;
    this.core = core;
    this.send = send;
    this.client = scheduler.client('rails', { weight: 1, pick: (cls) => this.#pick(cls) });
    this.tiles = new Map();     // road tile key → { key, lines, lon, lat, lists (while read), sent }
    this.current = null;        // the road tile being read
    this.eye = { lon: 0, lat: 0 };
    this.stats = { tiles: 0, sent: 0, lines: 0, readings: 0, ms: 0 };
  }

  /** Road tiles' railway lines as they come ([key, railLines]) and go (keys). */
  apply(added, removed) {
    for (const key of removed) this.tiles.delete(key);
    for (const [key, lines] of added) {
      const first = lines[0].stretches[0];
      this.tiles.set(key, { key, lines, lon: first[0], lat: first[1], lists: null, sent: false });
    }
    if (this.current && this.tiles.get(this.current.key) !== this.current) this.current = null;
    this.stats.tiles = this.tiles.size;
  }

  /** Each turn: the nearest road tile not yet sent has its readings asked for; once they are in, its profiles go. */
  tick(camera) {
    this.eye.lon = camera.lon;
    this.eye.lat = camera.lat;
    if (!this.current || this.current.sent) this.current = this.#nearest();
    const t = this.current;
    if (!t) return;
    t.lists ??= this.#readings(t);
    let waiting = false;
    for (const r of t.lists) {
      r.g = this.ground.list(r.key, () => ({ lonlat: r.lonlat, most: RAIL_LEVEL }));
      if (r.g.state === 'tiles') waiting = true;
    }
    if (waiting) return;
    const start = performance.now();
    const lines = this.#profiles(t);
    for (const r of t.lists) this.ground.lists.delete(r.key);
    t.lists = null;
    t.sent = true;
    this.stats.sent++;
    this.stats.ms += performance.now() - start;
    this.send(t.key, lines, lines.map(([, p]) => p.buffer));
  }

  /* The road tile not yet sent nearest the camera. */
  #nearest() {
    let best = null, bestD = Infinity;
    const m = Math.cos((this.eye.lat * Math.PI) / 180);
    for (const t of this.tiles.values()) {
      if (t.sent) continue;
      const d = ((t.lon - this.eye.lon) * m) ** 2 + (t.lat - this.eye.lat) ** 2;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }

  /* A road tile's readings: per stretch of each line, a point every STEP metres along it (and at its end), with the
   * metres along the line at each. */
  #readings(t) {
    const lists = [];
    for (const { line, stretches } of t.lines) {
      stretches.forEach((p, k) => {
        const lonlat = [], s = [];
        const last = p.length - 3, sEnd = p[last + 2];
        let i = 0;   // the segment from point i (p[i], p[i + 1], p[i + 2]: lon, lat, s) to point i + 3
        for (let at = p[2]; ; at = Math.min(at + STEP, sEnd)) {
          while (i + 3 < last && p[i + 5] < at) i += 3;
          const s0 = p[i + 2], s1 = p[i + 5];
          const f = s1 > s0 ? Math.min(1, Math.max(0, (at - s0) / (s1 - s0))) : 0;
          lonlat.push(p[i] + (p[i + 3] - p[i]) * f, p[i + 1] + (p[i + 4] - p[i + 1]) * f);
          s.push(at);
          if (at >= sEnd) break;
        }
        this.stats.readings += s.length;
        lists.push({ key: `rail|${t.key}|${line}|${k}`, line, lonlat, s: Float64Array.from(s), g: null });
      });
    }
    this.stats.lines += t.lines.length;
    return lists;
  }

  /* Each line's profile: its stretches' (rail_profile), in order along it, a NaN height between two. */
  #profiles(t) {
    const byLine = new Map();
    for (const r of t.lists) {
      const prof = r.g.state === 'done' ? this.#profile(r.s, r.g.heights) : null;
      if (!prof?.length) continue;
      const parts = byLine.get(r.line) ?? [];
      parts.push(prof);
      byLine.set(r.line, parts);
    }
    const lines = [];
    for (const [line, parts] of byLine) {
      parts.sort((a, b) => a[0] - b[0]);
      const total = parts.reduce((n, p) => n + p.length, 0) + 2 * (parts.length - 1);
      const out = new Float32Array(total);
      let at = 0;
      parts.forEach((p, k) => {
        if (k > 0) { out[at] = (out[at - 2] + p[0]) / 2; out[at + 1] = NaN; at += 2; }   // the break between two
        out.set(p, at);
        at += p.length;
      });
      lines.push([line, out]);
    }
    return lines;
  }

  /* One stretch's profile from its readings (wasm/src/profile.c): [s, z, …], or null. */
  #profile(s, z) {
    const core = this.core, n = s.length;
    if (n < 2) return null;
    core.reset();
    const sOff = core.write(new Uint8Array(s.buffer, s.byteOffset, s.byteLength));
    const zOff = core.write(new Uint8Array(z.buffer, z.byteOffset, z.byteLength));
    const outOff = core.alloc(n * 8);
    const count = core.exports.rail_profile(sOff, zOff, n, outOff);
    core.sync();
    return count >= 2 ? new Float32Array(core.buffer.slice(outOff, outOff + count * 8)) : null;
  }

  /* The scheduler's turn: the current road tile's readings' terrain tiles, while it waits for them. */
  #pick(cls) {
    if (cls !== VIEW) return false;
    const lists = this.current?.lists;
    if (!lists) return false;
    const now = performance.now();
    for (const r of lists) {
      if (r.g?.state !== 'tiles') continue;
      for (const t of r.g.tiles) if (this.ground.ready(t, this.client, now)) { this.ground.run(t, this.client); return true; }
    }
    return false;
  }
}
