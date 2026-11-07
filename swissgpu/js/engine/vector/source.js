/* source.js — what a vector tile service says about itself.
 *
 * A Mapbox Vector Tile service publishes a TileJSON document: the tile URL
 * templates (often several hosts, to spread requests: swisstopo has five),
 * the zoom range and the bounds. Read once at startup, like the terrain's
 * layer.json, so choosing tiles later stays synchronous. The adapter's own
 * bounds limit what is asked for (swisstopo's TileJSON declares a box far
 * wider than the country it has detail for).
 */

import { tileUrl } from '../../adapters/adapter.js';

const TILEJSON_TIMEOUT_MS = 10000;

export class VectorSource {
  constructor(adapter, spec, { templates, minLevel, maxLevel }) {
    this.adapter = adapter;
    this.spec = spec;
    this.templates = templates;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
    // The zoom whose tiles are used near the camera, and the one farther
    // out (both complete for the layer used; see the adapter).
    this.detailLevel = Math.min(maxLevel, spec.detailLevel ?? maxLevel);
    this.overviewLevel = Math.max(minLevel, Math.min(this.detailLevel, spec.overviewLevel ?? this.detailLevel - 1));
    this.schema = spec.layers?.transportation ?? null;
  }

  /** Resolves a service, or null where it cannot be read (that country then has no roads drawn). */
  static async load(adapter, spec) {
    try {
      let templates = spec.tiles ?? null, minLevel = spec.minLevel ?? 0, maxLevel = spec.maxLevel ?? 14;
      if (spec.tilejson) {
        // A service that does not answer leaves this country without roads,
        // not the app waiting.
        const response = await fetch(spec.tilejson, { signal: AbortSignal.timeout(TILEJSON_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`TileJSON returned ${response.status}`);
        const meta = await response.json();
        const base = spec.tilejson.replace(/[^/]*$/, '');
        const raw = Array.isArray(meta.tiles) && meta.tiles.length ? meta.tiles : null;
        if (!raw && !templates) throw new Error('TileJSON lists no tiles');
        if (raw) templates = raw.map((t) => (/^https?:/i.test(t) ? t : base + t));
        minLevel = Math.max(meta.minzoom ?? 0, spec.minLevel ?? 0);
        maxLevel = Math.min(meta.maxzoom ?? 14, spec.maxLevel ?? Infinity);
        if (meta.scheme && meta.scheme !== 'xyz') throw new Error(`unsupported scheme "${meta.scheme}"`);
      }
      if (!templates?.length) return null;
      return new VectorSource(adapter, spec, { templates, minLevel, maxLevel });
    } catch (err) {
      console.warn(`[vector] ${adapter.id} has no usable vector tiles: ${err.message}`);
      return null;
    }
  }

  /** A tile's URL; neighbouring tiles go to different hosts. */
  urlFor(z, x, y) {
    const t = this.templates[(x + y) % this.templates.length];
    return tileUrl(t, { z, x, y });
  }

  describe() {
    return `${this.adapter.id} z${this.overviewLevel}+${this.detailLevel} (${this.templates.length} hosts)`;
  }
}
