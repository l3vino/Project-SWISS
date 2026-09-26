/* perf.js — the performance panel (F2), and the report it copies.
 *
 * Everything needed to tell where a frame's time goes on a given machine,
 * in one place: frame times as percentiles (averages hide stutter), the
 * render thread's time split by what it was doing, the GPU's time per pass
 * and for the whole frame, what is drawn, what memory each layer holds
 * against its budget, what is still streaming, and which GPU the browser
 * really picked. "Copy report" puts all of it on the clipboard as plain text,
 * to paste wherever it is needed; "Pause streaming" stops new requests, which
 * separates the cost of loading from the cost of drawing.
 *
 * Numbers arrive twice a second with the render thread's telemetry; the
 * panel only touches the page while it is open.
 */

const MB = 1048576;

/* The render thread's sections, in frame order, with what each one is. */
const SECTIONS = [
  ['physics', 'physics'],
  ['uploads', 'uploads to GPU'],
  ['view', 'view'],
  ['terrain', 'terrain select'],
  ['buildings', 'buildings select'],
  ['evict', 'memory drops'],
  ['maintain', 'housekeeping'],
  ['ground', 'ground index'],
  ['imagery', 'imagery'],
  ['draw', 'record passes'],
  ['submit', 'submit'],
];

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const mb = (b) => `${Math.round((b || 0) / MB)}`;
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} k` : `${n ?? 0}`);
const pct = (v) => `${Math.round((v ?? 1) * 100)}%`;

export class PerfPanel {
  /**
   * @param onPause  called with true or false when "Pause streaming" is switched
   * @param onClose  called when the panel's own close button is pressed
   * @param context  () => { settings, info }: what the report includes besides the numbers
   */
  constructor({ onPause, onClose, context } = {}) {
    this.onPause = onPause;
    this.onClose = onClose;
    this.context = context;
    this.stats = null;
    this.paused = false;
    this.root = document.createElement('section');
    this.root.id = 'perf';
    this.root.className = 'perf glass';
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Performance');
    this.root.innerHTML = `
      <header class="perf__head">
        <h2 class="perf__title">Performance</h2>
        <button class="perf__button" data-act="pause" aria-pressed="false">Pause streaming</button>
        <button class="perf__button perf__button--main" data-act="copy">Copy report</button>
        <button class="perf__button perf__button--icon" data-act="close" aria-label="Close performance panel">×</button>
      </header>
      <div class="perf__body"></div>
      <p class="perf__note" hidden></p>`;
    this.body = this.root.querySelector('.perf__body');
    this.note = this.root.querySelector('.perf__note');
    this.pauseButton = this.root.querySelector('[data-act="pause"]');
    this.root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'pause') this.#togglePause();
      else if (act === 'copy') this.#copy();
      else if (act === 'close') this.onClose?.();
    });
    document.getElementById('ui').append(this.root);
  }

  get isOpen() { return !this.root.hidden; }

  visible(on) {
    this.root.hidden = !on;
    if (on && this.stats) this.#render();
    // Streaming never stays paused behind a closed panel.
    if (!on && this.paused) this.#togglePause();
  }

  update(stats) {
    this.stats = stats;
    if (this.isOpen) this.#render();
  }

  #togglePause() {
    this.paused = !this.paused;
    this.pauseButton.setAttribute('aria-pressed', String(this.paused));
    this.pauseButton.textContent = this.paused ? 'Resume streaming' : 'Pause streaming';
    this.onPause?.(this.paused);
  }

  #render() {
    const s = this.stats, p = s.profile || {}, g = s.gpu, info = this.context?.().info || {};
    const t = s.terrain || {}, b = s.buildings || {}, im = s.imagery || {};
    const rows = [];
    const section = (title) => rows.push(`<h3 class="perf__section">${title}</h3>`);
    const line = (key, value, warn = false) =>
      rows.push(`<div class="perf__row"><span class="perf__key">${key}</span><span class="perf__val${warn ? ' perf__val--warn' : ''}">${value}</span></div>`);

    section(`Frames · last ${f1(p.seconds)} s`);
    line('rate', `${Math.round(s.fps)} fps · ${f2(p.interval)} ms typical`, s.fps < 45);
    line('frame time', `95th ${f1(p.frame95)} · 99th ${f1(p.frame99)} ms`, p.frame99 > 25);
    line('late frames', `${p.late ?? 0} of ${p.frames ?? 0}`, (p.late ?? 0) > (p.frames ?? 0) * 0.02);

    section('Render thread · ms per frame');
    rows.push('<div class="perf__grid"><span></span><span>mean</span><span>95th</span><span>worst</span>');
    const worst = Math.max(0.001, ...SECTIONS.map(([k]) => p.sections?.[k] ?? 0));
    for (const [k, label] of SECTIONS) {
      const mean = p.sections?.[k] ?? 0;
      rows.push(`<span class="perf__key"><i class="perf__bar" style="--w:${Math.min(100, (mean / worst) * 100).toFixed(0)}%"></i>${label}</span>` +
        `<span>${f2(mean)}</span><span>${f2(p.p95?.[k])}</span><span${(p.peaks?.[k] ?? 0) > 8 ? ' class="perf__val--warn"' : ''}>${f1(p.peaks?.[k])}</span>`);
    }
    rows.push(`<span class="perf__key perf__key--total">all work</span><span>${f2(p.work)}</span><span>${f2(p.work95)}</span>` +
      `<span${p.workMax > 16 ? ' class="perf__val--warn"' : ''}>${f1(p.workMax)}</span></div>`);

    section('GPU · ms');
    if (g && g.frame >= 0) {
      line('whole frame', `${f2(g.frame)} · 95th ${f2(g.frame95)} · 99th ${f2(g.frame99)}`, g.frame95 > 12.5);
      line('passes', Object.entries(g.passes).map(([k, v]) => `${k} ${f2(v)}`).join(' · ') || '—');
    } else {
      line('whole frame', 'not measured (Graphics › Measure GPU time)');
    }

    section('Drawn');
    line('draw calls', `terrain ${s.draws?.terrain ?? 0} · buildings ${s.draws?.buildings ?? 0}`);
    line('triangles', `terrain ${count(s.triangles?.terrain)} · buildings ${count(s.triangles?.buildings)}`);
    line('resolution', `${s.width} × ${s.height} (scale ${f2(s.renderScale)}, dpr ${f2(s.dpr)})`);

    section('Memory · used / budget');
    line('terrain', `${mb(t.bytes)} / ${mb(t.budget)} MB · ${t.ready ?? 0} tiles` +
      ((t.detail ?? 1) < 1 ? ` · detail ${pct(t.detail)}` : ''), (t.detail ?? 1) < 1);
    line('buildings', `${mb(b.bytes)} / ${mb(b.budget)} MB · ${b.ready ?? 0} tiles` +
      ((b.detail ?? 1) < 1 ? ` · detail ${pct(b.detail)}` : ''), (b.detail ?? 1) < 1);
    line('collision', `${mb(b.solidBytes)} / ${mb(b.solidBudget)} MB · ground ${mb(s.ground?.bytes)} MB`);
    line('imagery', `${mb(im.bytes)} MB · ${im.resident ?? 0} tiles`);
    line('tree', `${count(t.nodes)} terrain nodes · ${b.files ?? 0} building files`);

    section(`Streaming${s.paused ? ' · paused' : ''}`);
    line('loading', `terrain ${t.pending ?? 0} · buildings ${b.pending ?? 0} · imagery ${im.loading ?? 0}`);
    line('uploads', `${s.uploads?.waiting ?? 0} waiting · slice ${f2(s.uploads?.slice)} ms`);
    line('dropped', `terrain ${t.dropped ?? 0} · buildings ${b.dropped ?? 0} tiles`);

    const a = info.adapter || {};
    section('GPU in use');
    line('adapter', escapeHtml([a.vendor, a.architecture, a.device].filter(Boolean).join(' · ') || info.gpu || '—'));
    if (a.description) line('description', escapeHtml(a.description));
    line('details', `${a.fallback ? 'software fallback · ' : ''}BC ${info.bc ? 'yes' : 'no'} · ` +
      `timestamps ${info.timestamps ? 'yes' : 'no'} · ${info.codecThreads ?? '?'} decode threads`, Boolean(a.fallback));

    this.body.innerHTML = rows.join('');
  }

  async #copy() {
    if (!this.stats) return;
    const text = buildReport(this.stats, this.context?.() || {});
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* no clipboard permission */ }
    if (!copied) {
      // The older route, still honoured from a click.
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      area.remove();
    }
    this.note.hidden = false;
    this.note.textContent = copied ? 'Report copied: paste it into the chat.' : 'Copying was blocked; the report is in the browser console.';
    if (!copied) console.info(text);
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => { this.note.hidden = true; }, 4000);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** The whole picture as plain text, for pasting somewhere. */
export function buildReport(s, { settings = {}, info = {} } = {}) {
  const p = s.profile || {}, g = s.gpu, a = info.adapter || {};
  const t = s.terrain || {}, b = s.buildings || {}, im = s.imagery || {};
  const out = [];
  out.push(`swissgpu performance report · ${new Date().toISOString()}`);
  out.push(`browser: ${navigator.userAgent}`);
  out.push(`cores: ${navigator.hardwareConcurrency ?? '?'} · memory: ${navigator.deviceMemory ?? '?'} GB · decode threads: ${info.codecThreads ?? '?'} (${info.spawnMode ?? '?'})`);
  out.push(`gpu: vendor=${a.vendor || '?'} architecture=${a.architecture || '?'} device=${a.device || '-'} description=${a.description || '-'}` +
    ` type=${a.type || '-'} backend=${a.backend || '-'} driver=${a.driver || '-'} fallback=${a.fallback ? 'yes' : 'no'} asked=${a.powerPreference || '?'}`);
  out.push(`gpu features: ${(a.features || info.features || []).join(', ')}`);
  if (a.limits) out.push(`gpu limits: ${Object.entries(a.limits).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  out.push(`screen: ${innerWidth}×${innerHeight} css px · dpr ${devicePixelRatio} · buffer ${s.width}×${s.height} · render scale ${s.renderScale}`);
  const keys = ['renderScale', 'fpsCap', 'viewDistanceKm', 'terrainDetailKm', 'imageryQuality', 'imagerySharpness', 'imageryDetail',
    'terrainMemory', 'buildings', 'structures', 'buildingDistanceKm', 'buildingDetailKm', 'buildingMemory', 'gpuTiming', 'flyThrough'];
  out.push(`settings: ${keys.filter((k) => k in settings).map((k) => `${k}=${settings[k]}`).join(' ')}`);
  const c = s.camera || {};
  out.push(`camera: ${c.lat?.toFixed(4)}, ${c.lon?.toFixed(4)} at ${Math.round(c.height ?? 0)} m · ${s.motion?.state ?? '?'} ` +
    `${Math.round((s.motion?.speed ?? 0) * 3.6)} km/h · above ground ${Math.round(s.motion?.aboveGround ?? 0)} m`);
  out.push('');
  out.push(`frames (last ${f1(p.seconds)} s, ${p.frames} frames): ${Math.round(s.fps)} fps · interval typical ${f2(p.interval)} ` +
    `95th ${f2(p.frame95)} 99th ${f2(p.frame99)} ms · late ${p.late}`);
  out.push(`render thread work ms: mean ${f2(p.work)} 50th ${f2(p.work50)} 95th ${f2(p.work95)} 99th ${f2(p.work99)} worst ${f1(p.workMax)}`);
  for (const [k] of SECTIONS) {
    out.push(`  ${k.padEnd(9)} mean ${f2(p.sections?.[k]).padStart(6)}  95th ${f2(p.p95?.[k]).padStart(6)}  worst ${f1(p.peaks?.[k]).padStart(6)}`);
  }
  if (g && g.frame >= 0) {
    out.push(`gpu ms: frame mean ${f2(g.frame)} 95th ${f2(g.frame95)} 99th ${f2(g.frame99)} · ` +
      Object.entries(g.passes).map(([k, v]) => `${k} ${f2(v)}`).join(' · '));
  } else {
    out.push('gpu ms: not measured');
  }
  out.push(`drawn: draws terrain ${s.draws?.terrain} buildings ${s.draws?.buildings} · triangles terrain ${s.triangles?.terrain} buildings ${s.triangles?.buildings}`);
  out.push(`terrain: ${t.drawn} drawn z${t.minLevel}-${t.maxLevel} · ${t.ready} loaded · ${mb(t.bytes)}/${mb(t.budget)} MB · detail ${pct(t.detail)} · ` +
    `${t.nodes} nodes · ${t.pending} pending · ${t.dropped} dropped`);
  out.push(`buildings: ${b.drawn} drawn · ${b.ready} loaded · ${mb(b.bytes)}/${mb(b.budget)} MB · collision ${mb(b.solidBytes)}/${mb(b.solidBudget)} MB · ` +
    `detail ${pct(b.detail)} · ${b.files} files · ${b.pending} pending · ${b.dropped} dropped · ${count(b.triangles)} triangles`);
  out.push(`imagery: ${im.resident} resident · ${im.loading} loading · zoom ${im.top} · ${mb(im.bytes)} MB`);
  out.push(`uploads: ${s.uploads?.waiting} waiting · slice ${f2(s.uploads?.slice)} ms · streaming ${s.paused ? 'paused' : 'on'}`);
  out.push(`wasm heap: ${Math.round((s.wasmUsed ?? 0) / 1024)} KB of ${mb(s.wasmHeap)} MB · ground index ${s.ground?.tiles} tiles`);
  return out.join('\n');
}
