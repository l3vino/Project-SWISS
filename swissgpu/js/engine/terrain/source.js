/* source.js — what a terrain service says about itself.
 *
 * A Cesium terrain service publishes a layer.json describing where its tiles
 * actually live, which levels exist, and which grid convention it uses. Reading
 * it is not optional politeness: swisstopo files its tiles under a dated
 * directory that changes whenever the elevation model is reprocessed, so a URL
 * hardcoded today is a URL that breaks silently later.
 *
 * It also answers "does this tile exist?" before anything is requested. The
 * answer comes from two places. layer.json may list available tile ranges per
 * level. Beyond that, services like swisstopo's put the answer inside the
 * tiles themselves: every tile at a level that is a multiple of
 * `metadataAvailability` carries, in its metadata extension, the ranges that
 * exist for the next levels of its own subtree. The quadtree always loads a
 * parent before looking at its children, so that answer is already in hand
 * by the time it is needed.
 *
 * Everything else is resolved once, at startup, so the tile loader stays
 * synchronous when it is deciding what to request.
 */

import { tilesY, tileKey } from './tiling.js';
import { tileUrl } from '../../adapters/adapter.js';

/* Extensions this app reads. Asking for others would only cost bytes. */
const READABLE_EXTENSIONS = ['octvertexnormals', 'metadata'];

export class TerrainSource {
  constructor(adapter, { template, minLevel, maxLevel, scheme, extensions, version, metadataAvailability = 0, available = null }) {
    this.adapter = adapter;
    this.template = template;
    this.minLevel = minLevel;
    this.maxLevel = maxLevel;
    this.scheme = scheme;
    this.extensions = extensions;
    this.version = version;

    /* The header Cesium sends. Accept is a CORS-safelisted header as long as
     * it stays under 128 bytes of plain characters, which this does, so it
     * costs no preflight. Static hosts ignore it and send what they have. */
    const wanted = READABLE_EXTENSIONS.filter((e) => extensions.includes(e));
    this.accept = (wanted.length
      ? `application/vnd.quantized-mesh;extensions=${wanted.join('-')}`
      : 'application/vnd.quantized-mesh') + ',application/octet-stream;q=0.9,*/*;q=0.01';

    this.metadataAvailability = extensions.includes('metadata') ? metadataAvailability : 0;
    this.layerAvailable = available;     // ranges per level from layer.json, or null
    this.subtrees = new Map();           // metadata tile key -> ranges for the levels below it
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
        metadataAvailability: meta.metadataAvailability ?? 0,
        available: Array.isArray(meta.available) ? meta.available : null,
      });
    } catch (err) {
      console.warn(`[terrain] ${adapter.id} has no usable terrain service: ${err.message}`);
      return null;
    }
  }

  serves(level) { return level >= this.minLevel && level <= this.maxLevel; }

  /**
   * Whether a tile exists, as far as anything published says. Unknown counts
   * as yes: a request that comes back empty is then remembered as missing.
   * Ranges count rows from the south, the same way the tiles do.
   */
  isAvailable(z, x, y) {
    if (!this.serves(z)) return false;
    if (this.layerAvailable && z < this.layerAvailable.length) {
      return inRanges(this.layerAvailable[z], x, y);
    }
    const every = this.metadataAvailability;
    if (!every || z === 0) return true;
    const top = Math.floor((z - 1) / every) * every;     // level of the tile that knows
    const shift = z - top;
    const ranges = this.subtrees.get(tileKey(top, x >> shift, y >> shift));
    if (!ranges) return true;
    return inRanges(ranges[z - top - 1], x, y);
  }

  /** Called with a tile's metadata `available` array once it has loaded. */
  recordAvailability(z, x, y, available) {
    if (!this.metadataAvailability || !Array.isArray(available)) return;
    if (z % this.metadataAvailability !== 0) return;
    this.subtrees.set(tileKey(z, x, y), available);
  }

  /** TMS counts rows from the south; xyz counts them from the north. */
  urlFor(z, x, y) {
    const row = this.scheme === 'xyz' ? tilesY(z) - 1 - y : y;
    return tileUrl(this.template, { z, x, y: row });
  }

  describe() {
    return `${this.adapter.id} z${this.minLevel}-${this.maxLevel}` +
      (this.version ? ` v${this.version}` : '') +
      (this.metadataAvailability ? `, availability every ${this.metadataAvailability} levels` : '');
  }
}

function inRanges(list, x, y) {
  if (!list) return false;
  for (const r of list) {
    if (x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY) return true;
  }
  return false;
}
