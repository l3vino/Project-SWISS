/* search.js — place search with live suggestions.
 *
 * Two modes, picked with the switch in the search bar. Global asks the
 * worldwide index, for well-known places anywhere. National asks whichever
 * country sources cover what is on screen, which know the local detail:
 * addresses, summits, field names. Near a border that can be more than one
 * country, and they are queried together and merged.
 *
 * This file has no idea Switzerland exists; the registry decides who answers.
 * Requests are debounced and the previous one aborted, which keeps a fast
 * typist from queueing eight round trips and rendering them out of order.
 */

const DEBOUNCE_MS = 140;

/* The mode is remembered between visits, but it is not a setting: the switch
 * in the search bar is its only control. */
const SCOPE_KEY = 'swissgpu.searchScope';

function readScope() {
  try { return localStorage.getItem(SCOPE_KEY) === 'national' ? 'national' : 'global'; }
  catch { return 'global'; }
}

export class Search {
  constructor(registry, { onPick, view }) {
    this.registry = registry;
    this.onPick = onPick;
    this.view = view || (() => null);
    this.scope = readScope();
    this.input = document.getElementById('search-input');
    this.list = document.getElementById('search-results');
    this.scopeBox = document.getElementById('search-scope');
    this.results = [];
    this.active = -1;
    this.timer = 0;
    this.controller = null;

    this.#buildScopeSwitch();

    this.input.addEventListener('input', () => this.#schedule());
    this.input.addEventListener('keydown', (e) => this.#key(e));
    this.input.addEventListener('focus', () => { if (this.results.length) this.#show(true); });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.search')) this.#show(false);
    });
    window.addEventListener('keydown', (e) => {
      // While the pointer is locked the keyboard belongs to the camera.
      if (document.pointerLockElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.input.focus();
        this.input.select();
      }
    });
  }

  #schedule() {
    clearTimeout(this.timer);
    const text = this.input.value.trim();
    if (text.length < 2) { this.results = []; this.#show(false); return; }
    this.timer = setTimeout(() => this.#query(text), DEBOUNCE_MS);
  }

  async #query(text) {
    const view = this.view();
    const national = this.scope === 'national';
    // Each mode has its own sources and never borrows the other's.
    const sources = this.registry.searchProviders(view).filter((s) => s.local === national);

    if (!sources.length) {
      this.results = [];
      this.#renderMessage(national
        ? 'No national index covers where you are. Switch to Global.'
        : 'No worldwide index is registered.');
      return;
    }

    this.controller?.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const attempts = sources.map(async ({ adapter, spec, local }) => {
      const url = new URL(spec.url);
      for (const [k, v] of Object.entries(spec.params || {})) url.searchParams.set(k, v);
      url.searchParams.set(spec.queryParam || 'q', text);
      // Each source decides how it wants to be told where you are, if at all.
      if (view && spec.bias) spec.bias(url.searchParams, view);

      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`${adapter.id} returned ${res.status}`);
      const body = await res.json();
      const items = spec.items ? spec.items(body) : (body.results || []);
      // Keep each source's own ordering; it encodes relevance we cannot
      // reconstruct from coordinates alone.
      return items.map((r, rank) => ({ ...spec.map(r), source: adapter, local, rank }));
    });

    const settled = await Promise.allSettled(attempts);
    if (signal.aborted) return;

    const seen = new Set();
    const merged = [];
    let failures = 0;
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        failures++;
        console.warn('[search]', outcome.reason?.message);
        continue;
      }
      for (const r of outcome.value) {
        if (!r.label || !Number.isFinite(r.lon) || !Number.isFinite(r.lat)) continue;
        // The same village can appear in a gazetteer, a commune list and OSM.
        const id = `${r.label.toLowerCase()}|${r.lon.toFixed(3)}|${r.lat.toFixed(3)}`;
        if (seen.has(id)) continue;
        seen.add(id);
        merged.push(r);
      }
    }

    if (!merged.length && failures === settled.length) {
      this.results = [];
      this.#renderMessage('Search is unreachable. Check the network and try again.');
      return;
    }

    /* Interleave by each source's own rank rather than by raw distance.
     * Sorting purely on proximity puts the nearest hamlet called Paris above
     * the city, which is not what anyone means. With one source this keeps its
     * order as given; near a border, best hit from each country comes first,
     * then second hits, with priority and then distance settling ties. */
    const centre = view ? [(view.west + view.east) / 2, (view.south + view.north) / 2] : null;
    merged.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.source.priority !== b.source.priority) return b.source.priority - a.source.priority;
      if (!centre) return 0;
      return dist2(a, centre) - dist2(b, centre);
    });

    this.results = merged.slice(0, 8);
    this.active = this.results.length ? 0 : -1;
    this.#render(text);
  }

  #buildScopeSwitch() {
    const modes = [['global', 'Global'], ['national', 'National']];
    for (const [value, label] of modes) {
      const b = document.createElement('button');
      b.className = 'scope';
      b.type = 'button';
      b.textContent = label;
      b.dataset.scope = value;
      b.setAttribute('aria-pressed', String(value === this.scope));
      b.addEventListener('click', () => this.#setScope(value));
      this.scopeBox.append(b);
    }
  }

  #setScope(scope) {
    if (scope === this.scope) return;
    this.scope = scope;
    for (const b of this.scopeBox.children) {
      b.setAttribute('aria-pressed', String(b.dataset.scope === scope));
    }
    try { localStorage.setItem(SCOPE_KEY, scope); } catch { /* private mode */ }
    const text = this.input.value.trim();
    if (text.length >= 2) this.#query(text);
  }

  #render(text) {
    this.list.replaceChildren();
    if (!this.results.length) {
      this.#renderMessage(`Nothing on the map matches “${text}”.`);
      return;
    }
    const credits = [...new Set(this.results.map((r) => r.source.attribution).filter(Boolean))];
    this.results.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = 'search__result';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.active));
      li.innerHTML = `<span class="search__result-name"></span><span class="search__result-kind"></span>`;
      li.firstElementChild.textContent = r.label;
      li.lastElementChild.textContent = kindLabel(r.kind);
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); this.#pick(i); });
      this.list.append(li);
    });
    if (credits.length) {
      const foot = document.createElement('li');
      foot.className = 'search__credit';
      foot.textContent = credits.join(' · ');
      this.list.append(foot);
    }
    this.#show(true);
  }

  #renderMessage(text) {
    const li = document.createElement('li');
    li.className = 'search__empty';
    li.textContent = text;
    this.list.replaceChildren(li);
    this.#show(true);
  }

  #show(open) {
    this.list.hidden = !open;
    this.input.setAttribute('aria-expanded', String(open));
  }

  #move(delta) {
    if (!this.results.length) return;
    this.active = (this.active + delta + this.results.length) % this.results.length;
    [...this.list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === this.active)));
    this.list.children[this.active]?.scrollIntoView({ block: 'nearest' });
  }

  #key(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.#move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.#move(-1); }
    else if (e.key === 'Enter' && this.active >= 0) { e.preventDefault(); this.#pick(this.active); }
    else if (e.key === 'Escape') { this.#show(false); this.input.blur(); }
  }

  #pick(i) {
    const r = this.results[i];
    if (!r) return;
    this.input.value = r.label;
    this.#show(false);
    this.input.blur();
    this.onPick?.(r);
  }
}

const dist2 = (r, c) => (r.lon - c[0]) ** 2 + (r.lat - c[1]) ** 2;

/* National sources report an index name; the global one reports a country.
 * Translate what we recognise and pass anything else through as given. */
function kindLabel(kind) {
  return {
    gg25: 'commune', kantone: 'canton', district: 'district',
    zipcode: 'postcode', address: 'address', gazetteer: 'place', parcel: 'parcel',
  }[kind] || kind || '';
}
