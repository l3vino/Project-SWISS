/* lru.js — least-recently-used order that never sorts.
 *
 * The cache every streamer keeps its loaded tiles in, after the one Cesium
 * uses for 3D Tiles: a doubly linked list with a marker node in it. At the
 * start of a selection the marker moves to the tail; every tile the
 * selection uses moves behind it. Afterwards, whatever is still in front of
 * the marker went unused this time, the longest-unused first, so eviction
 * takes tiles from the head and stops at the marker.
 *
 * Every operation is a few pointer swaps, whatever the number of tiles
 * loaded. The list it replaces was rebuilt by walking every tile and sorting
 * them, on every frame the view changed while memory was full, which is
 * work that grows with everything loaded since the session began.
 *
 * The links live on the items themselves (`lruPrev`, `lruNext`, both null
 * when not in the list), so adding and touching allocate nothing. An item
 * belongs to at most one list.
 */

export class LruList {
  constructor() {
    // Circular, through a sentinel; the marker is an ordinary member.
    this.sentinel = { lruPrev: null, lruNext: null };
    this.marker = { lruPrev: null, lruNext: null };
    const s = this.sentinel, m = this.marker;
    s.lruNext = m; s.lruPrev = m;
    m.lruNext = s; m.lruPrev = s;
    this.size = 0;
  }

  #unlink(n) {
    n.lruPrev.lruNext = n.lruNext;
    n.lruNext.lruPrev = n.lruPrev;
    n.lruPrev = n.lruNext = null;
  }

  #append(n) {
    const s = this.sentinel, last = s.lruPrev;
    n.lruPrev = last;
    n.lruNext = s;
    last.lruNext = n;
    s.lruPrev = n;
  }

  /** Whether an item is in the list. */
  has(n) { return n.lruNext !== null; }

  /** A newly loaded item, as the most recently used. */
  add(n) {
    if (n.lruNext !== null) { this.touch(n); return; }
    this.#append(n);
    this.size++;
  }

  /** Used in this selection: behind the marker. No-op for non-members. */
  touch(n) {
    if (n.lruNext === null || this.sentinel.lruPrev === n) return;
    this.#unlink(n);
    this.#append(n);
  }

  remove(n) {
    if (n.lruNext === null) return;
    this.#unlink(n);
    this.size--;
  }

  /** Start of a selection: everything is unused until touched. */
  mark() {
    this.#unlink(this.marker);
    this.#append(this.marker);
  }

  /** The item unused longest, if it went unused since the last mark; else null. */
  get stalest() {
    const h = this.sentinel.lruNext;
    return h === this.marker ? null : h;
  }
}
