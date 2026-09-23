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

  /** A failure is a dead end, so say what broke and what to do about it. */
  fail(message, remedy) {
    this.errorBox.hidden = false;
    this.errorBox.textContent = message + (remedy ? ` ${remedy}` : '');
  }

  done() {
    this.root.dataset.done = 'true';
    setTimeout(() => this.root.remove(), 600);
  }
}

const KB = 1024, MB = KB * 1024;

export class Readout {
  constructor(root = document.getElementById('readout')) {
    this.root = root;
    this.rows = new Map();
    this.data = {};
  }

  visible(on) { this.root.hidden = !on; }

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
      this.set('altitude', `${Math.round(c.height).toLocaleString('en')} m`);
      this.set('speed', `${Math.round(c.speed)} m/s${stats.sprinting ? ' ×3' : ''}`, stats.sprinting);
    }
    const t = stats.terrain;
    if (t) {
      this.set('tiles', `${t.ready} ready · ${t.pending} loading`, t.pending > 0);
    }
    this.set('fps', `${stats.fps.toFixed(0)}`, stats.fps < 45);
    this.set('cpu', `${stats.cpuMs.toFixed(2)} ms`);
    this.set('worst', `${stats.cpu99.toFixed(2)} ms`, stats.cpu99 > 24);
    this.set('gpu', stats.gpuMs >= 0 ? `${stats.gpuMs.toFixed(2)} ms` : 'not measured');
    this.set('res', `${stats.width} × ${stats.height}`);
    this.set('heap', `${(stats.wasmUsed / KB).toFixed(0)} / ${(stats.wasmHeap / MB).toFixed(1)} MB`);
  }
}
