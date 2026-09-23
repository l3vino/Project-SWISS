/* registry.js — which sources serve which piece of the world.
 *
 * Nothing else in the engine names a country. The tile loader asks who serves
 * a rectangle, the search box asks who is worth querying for the current view,
 * and the credit line asks who is on screen. Adding a country is one file and
 * one `register` call; an area no adapter claims is simply never requested,
 * which is what makes an unfinished map an empty region rather than a wall of
 * failed downloads.
 */

import { rectIntersects } from './adapter.js';

class Registry {
  constructor() { this.adapters = []; }

  register(adapter) {
    if (this.adapters.some((a) => a.id === adapter.id)) {
      throw new Error(`adapter "${adapter.id}" is registered twice`);
    }
    this.adapters.push(adapter);
    // Highest priority first, so every lookup below is a linear scan that can
    // stop at its first hit.
    this.adapters.sort((a, b) => b.priority - a.priority);
    return adapter;
  }

  get all() { return this.adapters; }

  /** The adapter that owns a point, or null out in the unmapped world. */
  forPoint(lon, lat) {
    return this.adapters.find((a) => a.covers(lon, lat)) || null;
  }

  /** Everything overlapping an area, best first. */
  forRect(rect) {
    return this.adapters.filter((a) => rectIntersects(a.rect, rect));
  }

  /**
   * Ordered candidates able to serve one kind of data over one rectangle.
   *
   * A list rather than a single answer: a tile straddling a border belongs to
   * whichever source ranks higher, but if that source has no tile there the
   * loader can try the next one instead of leaving a hole.
   */
  providers(kind, rect) {
    const out = [];
    for (const adapter of this.adapters) {
      if (!rectIntersects(adapter.rect, rect)) continue;
      const spec = adapter[kind];
      if (!spec) continue;
      out.push({ adapter, spec });
    }
    return out;
  }

  /** Best single provider, or null. */
  provider(kind, rect) { return this.providers(kind, rect)[0] || null; }

  /** Who is on screen and has something to offer. */
  activeFor(rect) { return this.forRect(rect); }

  /**
   * Every source that can answer a place-name query, each marked local or
   * global. Local ones are the country indexes covering the current view,
   * which near a border means more than one; global ones answer for anywhere.
   * The search box's National and Global modes each take one group.
   */
  searchProviders(rect) {
    const local = [], global = [];
    for (const adapter of this.adapters) {
      const spec = adapter.search;
      if (!spec) continue;
      if (spec.global) global.push({ adapter, spec, local: false });
      else if (!rect || rectIntersects(adapter.rect, rect)) local.push({ adapter, spec, local: true });
    }
    return [...local, ...global];
  }

  /**
   * Credits for what is actually drawn. Search indexes are excluded: they are
   * global, so they would sit in the corner permanently whether or not you had
   * searched anything. They are credited in the results list instead.
   */
  credits(rect) {
    const seen = new Set();
    const out = [];
    for (const a of this.activeFor(rect)) {
      if (a.searchOnly || !a.attribution || seen.has(a.attribution)) continue;
      seen.add(a.attribution);
      out.push({ label: a.attribution, url: a.attributionUrl || null });
    }
    return out;
  }

  attribution(rect) {
    return this.credits(rect).map((c) => c.label).join(' · ');
  }
}

export const registry = new Registry();
