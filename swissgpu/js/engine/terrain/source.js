/* source.js — what a terrain service says about itself.
 *
 * A Cesium terrain service publishes a layer.json describing where its tiles
 * actually live, which levels exist, and which grid convention it uses. Reading
 * it is not optional politeness: swisstopo files its tiles under a dated
 * directory that changes whenever the elevation model is reprocessed, so a URL
 * hardcoded today is a URL that breaks silently later.
 *
 * Everything here is resolved once, at startup, so the tile loader stays
 * synchronous when it is deciding what to request.
 */

import { tilesY } from './tiling.js';
import { tileUrl } from '../../adapters/adapter.js';

export class TerrainSource {
  constructor(adapter, { template, minLevel, maxLevel, scheme, extensions, version }) {
    this.adapter = adapter;
    this.template = template;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
    this.scheme = scheme;
    this.extensions = extensions;
    this.version = version;
  }

  /**
   * Resolve a service into something that can hand out tile URLs.
   * Returns null if the service cannot be reached or is not a format we read,
   * which leaves that country simply absent rather than erroring per tile.
   */
  static async load(adapter, spec) {
    try {
      if (!spec.layerJson) {
        // A service with a fixed template and no metadata document.
        if (!spec.url) return null;
        return new TerrainSource(adapter, {
          template: spec.url,
          minLevel: spec.minLevel ?? 0,
          maxLevel: spec.maxLevel ?? 16,
          scheme: spec.scheme === 'xyz' ? 'xyz' : 'tms',
          extensions: [],
          version: null,
        });
      }

      const response = await fetch(spec.layerJson);
      if (!response.ok) throw new Error(`layer.json returned ${response.status}`);
      const meta = await response.json();

      if (meta.format && meta.format !== 'quantized-mesh-1.0') {
        throw new Error(`unsupported terrain format "${meta.format}"`);
      }

      // The template is relative to the metadata document, and it carries
      // braces the URL parser would percent-encode, so join the strings by
      // hand rather than going through `new URL`.
      const raw = (meta.tiles && meta.tiles[0]) || '{z}/{x}/{y}.terrain';
      const base = spec.layerJson.replace(/[^/]*$/, '');
      const joined = /^https?:/i.test(raw) ? raw : base + raw;
      const template = joined.replaceAll('{version}', meta.version ?? '');

      // The service's own range, narrowed by anything the adapter insists on.
      const minLevel = Math.max(meta.minzoom ?? 0, spec.minLevel ?? 0);
      const maxLevel = Math.min(meta.maxzoom ?? 16, spec.maxLevel ?? Infinity);

      return new TerrainSource(adapter, {
        template,
        minLevel,
        maxLevel,
        scheme: meta.scheme === 'xyz' ? 'xyz' : 'tms',
        extensions: meta.extensions || [],
        version: meta.version ?? null,
      });
    } catch (err) {
      console.warn(`[terrain] ${adapter.id} has no usable terrain service: ${err.message}`);
      return null;
    }
  }

  serves(level) { return level >= this.minLevel && level <= this.maxLevel; }

  /** TMS counts rows from the south; xyz counts them from the north. */
  urlFor(z, x, y) {
    const row = this.scheme === 'xyz' ? tilesY(z) - 1 - y : y;
    return tileUrl(this.template, { z, x, y: row });
  }

  describe() {
    return `${this.adapter.id} z${this.minLevel}-${this.maxLevel}` +
      (this.version ? ` v${this.version}` : '');
  }
}
