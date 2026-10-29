/* topk.js — the few most urgent of many candidates, without sorting them all.
 *
 * A selection can find hundreds of tiles it would like loaded, and only a
 * dozen or so requests go out before the next selection replaces the list.
 * Sorting every candidate each time was the cost of a frame; keeping only
 * the best `capacity` in a bounded heap is a fraction of it, and the few
 * kept are sorted once at the end.
 *
 * Candidates carry their own `priority` (lower is more urgent) and
 * `heapIndex` (-1 when not held), so nothing is allocated per offer.
 */

const byPriority = (a, b) => a.priority - b.priority;

export class TopK {
  constructor(capacity = 64) {
    this.capacity = capacity;
    this.heap = [];           // max-heap on priority: the least urgent held is at the root
  }

  get size() { return this.heap.length; }

  /**
   * Considers an item at its current priority. An item already held whose
   * priority improved is moved to its new place.
   */
  offer(item) {
    const h = this.heap;
    if (item.heapIndex >= 0 && h[item.heapIndex] === item) {
      this.#down(item.heapIndex);
      return;
    }
    if (h.length < this.capacity) {
      item.heapIndex = h.length;
      h.push(item);
      this.#up(item.heapIndex);
    } else if (item.priority < h[0].priority) {
      h[0].heapIndex = -1;
      h[0] = item;
      item.heapIndex = 0;
      this.#down(0);
    }
  }

  /** Moves the held items into `out`, most urgent first, and empties the heap. */
  drainSorted(out) {
    const h = this.heap;
    out.length = h.length;
    for (let i = 0; i < h.length; i++) { out[i] = h[i]; h[i].heapIndex = -1; }
    h.length = 0;
    out.sort(byPriority);
    return out;
  }

  clear() {
    for (const item of this.heap) item.heapIndex = -1;
    this.heap.length = 0;
  }

  #up(i) {
    const h = this.heap, item = h[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].priority >= item.priority) break;
      h[i] = h[p]; h[i].heapIndex = i;
      i = p;
    }
    h[i] = item; item.heapIndex = i;
  }

  #down(i) {
    const h = this.heap, n = h.length, item = h[i];
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && h[r].priority > h[l].priority ? r : l;
      if (h[c].priority <= item.priority) break;
      h[i] = h[c]; h[i].heapIndex = i;
      i = c;
    }
    h[i] = item; item.heapIndex = i;
  }
}
