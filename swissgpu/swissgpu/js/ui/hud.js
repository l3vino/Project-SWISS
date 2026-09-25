/* hud.js — the boot sequence and the instrument readout. */

export class Boot {
  constructor(root = document.getElementById('boot')) {
    this.root = root;
    this.list = document.getElementById('boot-steps');
    this.errorBox = document.getElementById('boot-error');
    this.steps = new Map();
  }

  step(id, label) {
    const li = document.createElement('li');
    li.className = 'boot__step';
    li.dataset.state = 'pending';
    li.innerHTML = `<span class="boot__mark">·</span><span></span>`;
    li.lastElementChild.textContent = label;
    this.list.append(li);
    this.steps.set(id, li);
    return li;
  }

  mark(id, state, label) {
    const li = this.steps.get(id);
    if (!li) return;
    li.dataset.state = state;
    li.firstElementChild.textContent = { active: '·', done: '✓', failed: '×' }[state] || '·';
    if (label) li.lastElementChild.textContent = label;
  }

  /** A failure is a dead end, so say what broke and what to do about it.
   *  Works after boot too: the overlay comes back over the frozen view. */
  fail(message, remedy) {
    this.errorBox.hidden = false;
    this.errorBox.textContent = message + (remedy ? ` ${remedy}` : '');
    this.root.dataset.done = 'false';
  }

  done() { this.root.dataset.done = 'true'; }
}

/** One short message at a time, under the search bar, gone after a while. */
export class Toast {
  constructor(el = document.getElementById('toast')) {
    this.el = el;
    this.timer = 0;
  }

  show(text, ms = 5000) {
    this.el.textContent = text;
    this.el.dataset.show = 'true';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.el.dataset.show = 'false'; }, ms);
  }
}

const KB = 1024, MB = KB * 1024;

const formatCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : `${n}`);

export class Readout {
  constructor(root = document.getElementById('readout')) {
    this.root = root;
    this.rows = new Map();
    this.data = {};
    this.imperial = false;
  }

  visible(on) { this.root.hidden = !on; }

  /** 'metric' or 'imperial', for heights and speeds. */
  setUnits(units) { this.imperial = units === 'imperial'; }

  /* A height or distance in metres, as the chosen units show it. */
  #length(m, decimals = 0) {
    const v = this.imperial ? m / 0.3048 : m;
    const unit = this.imperial ? 'ft' : 'm';
    return decimals ? `${v.toFixed(decimals)} ${unit}` : `${Math.round(v).toLocaleString('en')} ${unit}`;
  }

  /* A speed in metres a second: walking pace keeps a decimal. */
  #speed(ms, walking) {
    const v = this.imperial ? ms * 2.23694 : ms * 3.6;
    const unit = this.imperial ? 'mph' : 'km/h';
    return walking ? `${v.toFixed(1)} ${unit}` : `${Math.round(v).toLocaleString('en')} ${unit}`;
  }

  rule() {
    const el = document.createElement('div');
    el.className = 'readout__rule';
    this.root.append(el);
  }

  row(id, key) {
    const el = document.createElement('div');
    el.className = 'readout__row';
    el.innerHTML = `<span class="readout__key"></span><span class="readout__val"></span>`;
    el.firstElementChild.textContent = key;
    this.root.append(el);
    this.rows.set(id, el.lastElementChild);
    return el;
  }

  set(id, value, warn = false) {
    const el = this.rows.get(id);
    if (!el) return;
    el.textContent = value;
    el.classList.toggle('readout__val--warn', warn);
  }

  update(stats) {
    const c = stats.camera;
    if (c) {
      this.set('position', `${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}`);
      this.set('altitude', this.#length(c.height));
    }
    const m = stats.motion;
    if (m) {
      this.set('mode', m.state, m.state === 'waiting for ground' || m.state === 'arriving');
      // Walking speeds need a decimal; flight speeds would only jitter with one.
      this.set('speed', m.mode === 'walk' ? this.#speed(m.speed, true)
        : `${this.#speed(m.speed, false)}${m.boosted ? ' ×3' : ''}`, m.boosted);
      this.set('ground', m.aboveGround == null ? '—'
        : m.aboveGround < 100 ? this.#length(m.aboveGround, 2) : this.#length(m.aboveGround));
    }
    const t = stats.terrain;
    if (t) {
      this.set('tiles', `${t.drawn} drawn · ${t.pending} loading`, t.pending > 0);
      this.set('levels', t.drawn ? `z${t.minLevel}–${t.maxLevel} · ${(t.bytes / MB).toFixed(0)} MB` : '—');
    }
    const b = stats.buildings;
    if (b) {
      this.set('buildings', !b.layers ? 'none here'
        : `${b.drawn} tiles · ${formatCount(b.triangles)} tris${b.pending ? ` · ${b.pending} loading` : ''}`,
        b.pending > 0);
    }
    const im = stats.imagery;
    if (im) {
      this.set('imagery', `${im.resident} ready · ${im.loading} loading`, im.loading > 0);
      this.set('sharpest', im.top ? `zoom ${im.top}` : '—');
    }
    this.set('fps', `${stats.fps.toFixed(0)} fps · ${stats.cpuMs.toFixed(1)} ms`, stats.fps < 45);
    // Work is what the render thread spends per frame; late frames are the
    // ones the display had to wait for, which is what stutter looks like.
    if (stats.work != null) {
      this.set('cpu', `${stats.work.toFixed(1)} ms · 99th ${stats.work99.toFixed(1)}`, stats.work99 > 12);
      this.set('worst', `${stats.late} of the last 240`, stats.late > 2);
    }
    this.set('gpu', stats.gpuMs >= 0 ? `${stats.gpuMs.toFixed(2)} ms` : 'not measured');
    this.set('res', `${stats.width} × ${stats.height}`);
    this.set('heap', `${(stats.wasmUsed / KB).toFixed(0)} / ${(stats.wasmHeap / MB).toFixed(1)} MB`);
  }
}
