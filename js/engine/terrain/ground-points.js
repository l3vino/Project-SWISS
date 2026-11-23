/* ground-points.js — the ground under lists of points, from the finest terrain tiles a service has there.
 *
 * Asked for by key: a list of points (lon, lat, …) whose heights are wanted. The terrain tile each lies in (the
 * finest level the service has there, `most` at most; a list may ask for another) is fetched and indexed once
 * ('terrain-ground', workers/jobs/ground.js) and kept for every list that needs it: at most `tilesMost`, those no list
 * waits for and least lately used going first. A tile the service turns out not to have gives way to the next coarser
 * one there; one that fails is asked for again, `tries` times in all, `againMs` later and three times longer each time
 * (up to 5.17i a failure counted as a tile the service does not have, and a coarser one stood in for it for good:
 * portal floors metres off under load). Once every tile of a list is in, its points are sampled (`heights`, NaN where
 * not known).
 *
 * The tunnels' thread keeps one (workers/tunnels.js): round the tunnels' portals and along their tubes
 * (engine/tunnels/tunnels.js, since 5.17e) and along the railways (engine/tunnels/rail-profiles.js, 5.18d). Each user
 * runs the tiles its own lists wait for through its own scheduler client, in its own order (`run`), and any tile still
 * wanted when it has nothing else to do (`runAny`).
 */

import { VIEW, hostOf } from '../../core/scheduler.js';
import { tileAt, tileRect, tileKey } from './tiling.js';
import { groundEntry, sampleEntry, groundSample } from './ground.js';

export class GroundPoints {
  /**
   * @param sources  the terrain sources (engine/terrain/source.js) on this thread
   * @param options  most: the finest level asked for (17); least: the coarsest tried (12); tilesMost: tiles kept
   *                 indexed (64); listsMost: lists kept (256); tries (5) and againMs (2000): a failed tile's retries;
   *                 stats: where the counts go (grounds: lists, groundTiles: tiles, failed); label: for its warnings
   */
  constructor(sources, { most = 17, least = 12, tilesMost = 64, listsMost = 256, tries = 5, againMs = 2000, stats = null, label = 'ground' } = {}) {
    this.sources = sources;
    this.most = most;
    this.least = least;
    this.tilesMost = tilesMost;
    this.listsMost = listsMost;
    this.tries = tries;
    this.againMs = againMs;
    this.label = label;
    this.stats = stats ?? { grounds: 0, groundTiles: 0, failed: 0 };
    this.lists = new Map();    // list key → { key, pts, lonlat, pointTiles, tiles, heights (once in), state: tiles | done | failed }
    this.tiles = new Map();    // tile key → { key, z, x, y, url, rect, accept, host, state, entry, usedAt, tries, againAt }
    this.scratch = groundSample();
  }

  /**
   * The list `key`: `make` gives { lonlat: [lon, lat, …], under?: [a level per point, finer than which none is
   * asked for], most?: the finest level for all of them } the first time, the rest kept as `pts`. Its tiles are asked
   * for; once they are in, its `heights`.
   */
  list(key, make) {
    let g = this.lists.get(key);
    if (!g) {
      const pts = make();
      g = { key, pts, lonlat: pts.lonlat, pointTiles: [], tiles: [], heights: null, state: 'tiles' };
      const most = pts.most ?? this.most;
      for (let i = 0; i < g.lonlat.length; i += 2) {
        const tile = this.#tile(g.lonlat[i], g.lonlat[i + 1], pts.under?.[i / 2] ?? Infinity, most);
        g.pointTiles.push(tile);
        if (tile && !g.tiles.includes(tile)) g.tiles.push(tile);
      }
      if (!g.tiles.length) g.state = 'failed';
      if (this.lists.size >= this.listsMost) {
        // The oldest lists done with go (a user still wanting one asks again).
        for (const [k, q] of this.lists) {
          if (this.lists.size < this.listsMost * 0.75) break;
          if (q.state !== 'tiles') this.lists.delete(k);
        }
      }
      this.lists.set(key, g);
      this.stats.grounds = this.lists.size;
    }
    if (g.state === 'tiles') this.#resolve(g);
    return g;
  }

  /** Whether tile `t` can be fetched now through `client`: wanted (or its retry's time come), its host free. */
  ready(t, client, now = performance.now()) {
    if (t.state === 'again' && now >= t.againAt) t.state = 'wanted';
    return t.state === 'wanted' && client.canRun(t.host);
  }

  /** Fetches and indexes tile `t` through `client` (its 'terrain-ground' job). */
  async run(t, client) {
    t.state = 'busy';
    try {
      const data = await client.run('terrain-ground', { url: t.url, rect: t.rect, accept: t.accept },
        { cls: VIEW, cost: 2, host: t.host, timeout: 20000 });
      t.entry = data.missing ? null : groundEntry(data, t.rect, { z: t.z, x: t.x, y: t.y });
      t.state = 'done';
    } catch (err) {
      if (err.name === 'AbortError') { t.state = 'wanted'; return; }
      this.stats.failed++;
      t.tries = (t.tries ?? 0) + 1;
      if (t.tries < this.tries) {
        t.state = 'again';
        t.againAt = performance.now() + this.againMs * 3 ** (t.tries - 1);
        return;
      }
      t.state = 'done';
      console.warn(`[${this.label}] ground ${t.z}/${t.x}/${t.y}: ${err.message} (${t.tries} tries)`);
    }
  }

  /** Starts the first tile still wanted that can run now through `client`; false if there is none. */
  runAny(client, now = performance.now()) {
    for (const t of this.tiles.values()) if (this.ready(t, client, now)) { this.run(t, client); return true; }
    return false;
  }

  /* The finest terrain tile a service has at a point, `most` at most and below level `under`, as a tile record (asked
   * for when first wanted). */
  #tile(lon, lat, under, most) {
    const source = this.sources.find((s) => s.adapter.covers(lon, lat));
    if (!source) return null;
    for (let z = Math.min(source.maxLevel, most, under - 1); z >= this.least; z--) {
      const { x, y } = tileAt(z, lon, lat);
      if (!source.isAvailable(z, x, y)) continue;
      const key = tileKey(z, x, y);
      let t = this.tiles.get(key);
      if (!t) {
        const url = source.urlFor(z, x, y);
        t = { key, z, x, y, url, rect: tileRect(z, x, y), accept: source.accept, host: hostOf(url), state: 'wanted', entry: null };
        this.tiles.set(key, t);
      }
      return t;
    }
    return null;
  }

  /* Once a list's tiles are in: its points sampled. A tile the service did not have after all gives way to the next
   * coarser one there. */
  #resolve(g) {
    let again = false;
    const most = g.pts.most ?? this.most;
    for (let i = 0; i < g.pointTiles.length; i++) {
      const t = g.pointTiles[i];
      if (t?.state !== 'done' || t.entry) continue;
      const coarser = this.#tile(g.lonlat[2 * i], g.lonlat[2 * i + 1], t.z, most);
      g.pointTiles[i] = coarser;
      if (coarser && !g.tiles.includes(coarser)) g.tiles.push(coarser);
      again = true;
    }
    if (again) g.tiles = g.tiles.filter((t) => g.pointTiles.includes(t));
    if (g.tiles.some((t) => t.state !== 'done')) return;
    const now = performance.now();
    g.heights = new Float64Array(g.pointTiles.length);
    let known = 0;
    for (let i = 0; i < g.pointTiles.length; i++) {
      const t = g.pointTiles[i];
      const ok = Boolean(t?.entry) && sampleEntry(t.entry, g.lonlat[2 * i], g.lonlat[2 * i + 1], this.scratch);
      g.heights[i] = ok ? this.scratch.height : NaN;
      if (ok) known++;
    }
    for (const t of g.tiles) t.usedAt = now;
    g.state = known ? 'done' : 'failed';
    this.#trim();
  }

  /* The tiles kept indexed: at most tilesMost, those no list waits for going first, the least lately used first (one
   * wanted again is asked for again). */
  #trim() {
    if (this.tiles.size > this.tilesMost) {
      const waited = new Set();
      for (const g of this.lists.values()) if (g.state === 'tiles') for (const t of g.tiles) waited.add(t);
      const spare = [...this.tiles.values()].filter((t) => t.state === 'done' && !waited.has(t)).sort((a, b) => (a.usedAt ?? 0) - (b.usedAt ?? 0));
      for (const t of spare) {
        if (this.tiles.size <= this.tilesMost) break;
        this.tiles.delete(t.key);
      }
    }
    this.stats.groundTiles = this.tiles.size;
  }
}
