/* source.js — one imagery service, as the clipmap sees it.
 *
 * An adapter's `imagery` entry describes an XYZ tile service: a URL template,
 * the zoom range it has, and its tile size. Only Web Mercator services are
 * accepted, since that is the grid the clipmap is built on.
 */

import { tileUrl } from '../../adapters/adapter.js';

export class ImagerySource {
  constructor(adapter, spec) {
    this.adapter = adapter;
    this.template = spec.url;
    this.minLevel = spec.minLevel ?? 0;
    this.maxLevel = spec.maxLevel ?? 19;
    this.tileSize = spec.tileSize ?? 256;
    this.priority = adapter.priority;
  }

  /** Null for services this renderer cannot use, which then simply do not appear. */
  static from(adapter) {
    const spec = adapter.imagery;
    if (!spec || !spec.url) return null;
    if (spec.crs && spec.crs !== 'EPSG:3857') {
      console.warn(`[imagery] ${adapter.id}: ${spec.crs} is not supported, only EPSG:3857`);
      return null;
    }
    return new ImagerySource(adapter, spec);
  }

  serves(z) { return z >= this.minLevel && z <= this.maxLevel; }

  urlFor(z, x, y) { return tileUrl(this.template, { z, x, y }); }
}
