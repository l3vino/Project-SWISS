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
/* A railway's ground as the terrain is shaped along it (formationAt, 5.18n): its profile's height held level LEVEL_HALF
 * metres either side of its line (a standard-gauge line's half-width and bench: swisstopo-transport.js, pieces.js),
 * falling FILL_FALL a metre beyond (shape.c FILL_SLOPE, 1:1.5), out to REACH metres. */
const LEVEL_HALF = 3.8, FILL_FALL = 1 / 1.5, REACH = 20;
const M_LAT = 111132;

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
    this.tiles = new Map();     // road tile key → { key, lines, lon, lat, lists (while read), sent, made, box }
    this.current = null;        // the road tile being read
    this.eye = { lon: 0, lat: 0 };
    this.stats = { tiles: 0, sent: 0, lines: 0, readings: 0, ms: 0 };
  }

  /**
   * The railways' ground at a point as the terrain is shaped along them (5.18n): over each line's profile within
   * LEVEL_HALF of it, falling 1:1.5 beyond, the highest of the lines within REACH whose profiles are made; -Infinity
   * where none. The tunnels' fit takes it as the ground over a road or path passing under a railway: the bare ground
   * there has the line's bridge left out (the road's tunnel saw 0.34 m of ground over it by the Ceneri north portal,
   * where the embankment stands 5.8 m over the road).
   */
  formationAt(lon, lat) {
    let best = -Infinity;
    const m = 111320 * Math.cos((lat * Math.PI) / 180), dLon = REACH / m, dLat = REACH / M_LAT;
    for (const t of this.tiles.values()) {
      const b = t.box;
      if (!t.made || lon < b[0] - dLon || lon > b[2] + dLon || lat < b[1] - dLat || lat > b[3] + dLat) continue;
      for (const { prof, stretches } of t.made) {
        for (const p of stretches) {
          let d = Infinity, s = 0;
          for (let i = 0; i + 5 < p.length; i += 3) {
            const ax = (lon - p[i]) * m, ay = (lat - p[i + 1]) * M_LAT, ux = (p[i + 3] - p[i]) * m, uy = (p[i + 4] - p[i + 1]) * M_LAT;
            const L2 = ux * ux + uy * uy, f = L2 > 0 ? Math.max(0, Math.min(1, (ax * ux + ay * uy) / L2)) : 0;
            const e = Math.hypot(ax - ux * f, ay - uy * f);
            if (e < d) { d = e; s = p[i + 2] + (p[i + 5] - p[i + 2]) * f; }
          }
          if (!(d <= REACH)) continue;
          const z = heightAt(prof, s);
          if (Number.isFinite(z)) best = Math.max(best, z - Math.max(0, d - LEVEL_HALF) * FILL_FALL);
        }
      }
    }
    return best;
  }

  /** The road tiles whose profiles are made within REACH of a box [west, south, east, north] (degrees), as a key:
   *  it changes when one near it comes or goes (the tunnels' placing signature). */
  madeNear(box) {
    const lat = (box[1] + box[3]) / 2, dLon = REACH / (111320 * Math.cos((lat * Math.PI) / 180)), dLat = REACH / M_LAT;
    let key = '';
    for (const t of this.tiles.values()) {
      const b = t.box;
      if (t.made && !(box[2] < b[0] - dLon || box[0] > b[2] + dLon || box[3] < b[1] - dLat || box[1] > b[3] + dLat)) key += `${t.key},`;
    }
    return key;
  }

  /** Road tiles whose profiles are still to make (the console's swissgpu.settled waits for none, 5.18e). */
  get pending() {
    let n = 0;
    for (const t of this.tiles.values()) if (!t.sent) n++;
    return n;
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
    // (Kept with their lines for formationAt: the profiles themselves go to the render thread.)
    const byLine = new Map(t.lines.map((l) => [l.line, l.stretches]));
    t.made = lines.map(([line, p]) => ({ prof: p.slice(), stretches: byLine.get(line) ?? [] }));
    t.box = boxOf(t.lines);
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

/* A profile's ([s, z, …], a NaN height at a break) height `s` metres along its line; NaN off it or at a break. */
function heightAt(prof, s) {
  if (!(prof.length >= 4) || s < prof[0] || s > prof[prof.length - 2]) return NaN;
  for (let k = 0; k + 3 < prof.length; k += 2) {
    if (s > prof[k + 2]) continue;
    const span = prof[k + 2] - prof[k];
    return span > 1e-9 ? prof[k + 1] + ((prof[k + 3] - prof[k + 1]) * (s - prof[k])) / span : prof[k + 1];
  }
  return NaN;
}

/* The box [west, south, east, north] (degrees) round a road tile's railway lines' stretches (lon, lat, s, …). */
function boxOf(lines) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { stretches } of lines) {
    for (const p of stretches) {
      for (let i = 0; i + 1 < p.length; i += 3) {
        box[0] = Math.min(box[0], p[i]); box[1] = Math.min(box[1], p[i + 1]);
        box[2] = Math.max(box[2], p[i]); box[3] = Math.max(box[3], p[i + 1]);
      }
    }
  }
  return box;
}
