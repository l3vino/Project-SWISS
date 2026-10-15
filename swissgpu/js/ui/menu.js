/* menu.js — the settings menu: a window with a tab per subject.
 *
 * Built entirely from the schema in js/core/settings.js, so a new setting is
 * one entry there and appears here with the right control. Every control
 * shows its state plainly: switches say On or Off, sliders show their value
 * with its unit, a short list of options sits side by side as a segmented
 * choice. A setting changed from its default gets a reset button, and each
 * tab can be reset as a whole.
 *
 * The Controls tab holds the key table: click a key, press the new one.
 * Escape cancels, Backspace clears the slot, and a key already used by
 * another action moves rather than doing two things at once.
 */

import { TABS, ACTIONS } from '../core/settings.js';

const TAB_KEY = 'swissgpu.menu.tab';

/* Line icons, 20x20, stroked in the text colour. */
const ICONS = {
  general: '<circle cx="10" cy="10" r="7.2"/><path d="M10 9v5M10 6.2v.2"/>',
  graphics: '<path d="M2.5 15.5 7 9l3 4 2.5-3 5 5.5z"/><circle cx="14" cy="5.5" r="1.6"/>',
  layers: '<path d="m10 3 7.5 4L10 11 2.5 7z"/><path d="m2.5 10.5 7.5 4 7.5-4"/><path d="m2.5 13.8 7.5 4 7.5-4"/>',
  character: '<circle cx="10" cy="5" r="2.4"/><path d="M5.5 17.5 7 11l3-2 3 2 1.5 6.5M7 11l-2.5 2M13 11l2.5 2"/>',
  physics: '<circle cx="10" cy="10" r="1.6"/><ellipse cx="10" cy="10" rx="7.5" ry="3"/><ellipse cx="10" cy="10" rx="7.5" ry="3" transform="rotate(60 10 10)"/><ellipse cx="10" cy="10" rx="7.5" ry="3" transform="rotate(-60 10 10)"/>',
  controls: '<rect x="2" y="5.5" width="16" height="9" rx="2"/><path d="M5 8.5h1M8 8.5h1M11 8.5h1M14 8.5h1M6 11.5h8"/>',
  world: '<circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.2 2.1 3.3 4.6 3.3 7.5S12.2 15.4 10 17.5C7.8 15.4 6.7 12.9 6.7 10S7.8 4.6 10 2.5z"/>',
  reset: '<path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.8v2.6h2.6"/>',
  close: '<path d="m5 5 10 10M15 5 5 15"/>',
};

export function icon(name, size = 18) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** A key's name as printed on it, from a KeyboardEvent.code. */
export function keyLabel(code) {
  if (!code) return '—';
  const named = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', CapsLock: 'Caps Lock',
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left ⌘', MetaRight: 'Right ⌘',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', IntlBackslash: '<',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}

export class Menu {
  constructor(settings, { onOpen, onClose } = {}) {
    this.settings = settings;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.root = document.getElementById('menu');
    this.gear = document.getElementById('gear');
    this.listening = null;       // { action, slot, button } while waiting for a key
    this.refreshers = [];        // per visible control: bring it up to date with the settings
    let saved = null;
    try { saved = localStorage.getItem(TAB_KEY); } catch { /* storage unavailable */ }
    this.tab = TABS.some((t) => t.id === saved) ? saved : TABS[0].id;

    this.#build();
    this.gear.addEventListener('click', () => this.toggle());
    // Capture phase, so a key being bound never reaches anything else.
    addEventListener('keydown', (e) => this.#keydown(e), true);
    settings.on('*', () => this.#refresh());
  }

  get isOpen() { return !this.root.hidden; }

  toggle(force) {
    const open = force ?? !this.isOpen;
    if (open === this.isOpen) return;
    this.root.hidden = !open;
    this.gear.setAttribute('aria-expanded', String(open));
    if (open) {
      this.onOpen?.();
      this.#showTab(this.tab);
      this.nav.querySelector('[aria-selected="true"]')?.focus();
    } else {
      this.#stopListening();
      this.onClose?.();
      this.gear.focus();
    }
  }

  /* ---- structure ---------------------------------------------------------- */

  #build() {
    this.root.className = 'menu';
    this.root.innerHTML = `
      <div class="menu__backdrop"></div>
      <div class="menu__window" role="dialog" aria-modal="true" aria-labelledby="menu-title">
        <nav class="menu__nav" role="tablist" aria-label="Settings">
          <div class="menu__brand">Settings</div>
        </nav>
        <section class="menu__page">
          <header class="menu__head">
            <h2 class="menu__title" id="menu-title"></h2>
            <button class="menu__button" data-act="reset-tab">${icon('reset', 15)}<span>Reset tab</span></button>
            <button class="menu__button menu__button--close" data-act="close" aria-label="Close settings">${icon('close', 16)}</button>
          </header>
          <div class="menu__body" role="tabpanel" aria-labelledby="menu-title"></div>
        </section>
      </div>`;
    this.nav = this.root.querySelector('.menu__nav');
    this.title = this.root.querySelector('.menu__title');
    this.body = this.root.querySelector('.menu__body');

    for (const tab of TABS) {
      const b = document.createElement('button');
      b.className = 'menu__tab';
      b.setAttribute('role', 'tab');
      b.dataset.tab = tab.id;
      b.innerHTML = `${icon(tab.icon)}<span>${tab.label}</span>`;
      b.addEventListener('click', () => this.#showTab(tab.id));
      this.nav.append(b);
    }
    // Up and down move between tabs while the tab list has focus.
    this.nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length];
      this.#showTab(next.id);
      this.nav.querySelector(`[data-tab="${next.id}"]`).focus();
    });
    this.root.querySelector('.menu__backdrop').addEventListener('click', () => this.toggle(false));
    this.root.querySelector('[data-act="close"]').addEventListener('click', () => this.toggle(false));
    this.root.querySelector('[data-act="reset-tab"]').addEventListener('click', () => {
      const tab = TABS.find((t) => t.id === this.tab);
      for (const s of tab.sections) for (const item of s.items) if (item.type !== 'button') this.settings.reset(item.id);
    });
  }

  #showTab(id) {
    this.tab = id;
    try { localStorage.setItem(TAB_KEY, id); } catch { /* storage unavailable */ }
    const tab = TABS.find((t) => t.id === id);
    for (const b of this.nav.querySelectorAll('.menu__tab')) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    this.title.textContent = tab.label;
    this.#stopListening();
    this.refreshers = [];
    this.body.replaceChildren();
    for (const section of tab.sections) {
      const el = document.createElement('div');
      el.className = 'menu__section';
      const h = document.createElement('h3');
      h.className = 'menu__section-title';
      h.textContent = section.title;
      el.append(h);
      for (const item of section.items) el.append(this.#control(item));
      this.body.append(el);
    }
    this.body.scrollTop = 0;
  }

  #refresh() { for (const fn of this.refreshers) fn(); }

  /* ---- one setting -------------------------------------------------------- */

  #control(item) {
    if (item.type === 'keybinds') return this.#keyTable(item);

    const row = document.createElement('div');
    row.className = `setting setting--${item.type}`;
    const label = document.createElement('div');
    label.className = 'setting__label';
    label.textContent = item.label;
    label.id = `setting-${item.id}`;
    row.append(label);

    const s = this.settings;
    let refresh = () => {};

    if (item.type === 'toggle') {
      const sw = document.createElement('button');
      sw.className = 'toggle';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-labelledby', label.id);
      sw.addEventListener('click', () => s.set(item.id, !s.get(item.id)));
      refresh = () => sw.setAttribute('aria-checked', String(Boolean(s.get(item.id))));
      row.append(sw);
    } else if (item.type === 'choice') {
      const group = document.createElement('div');
      group.className = 'choice';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', label.id);
      const buttons = item.options.map(([value, text]) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.addEventListener('click', () => s.set(item.id, value));
        group.append(b);
        return [value, b];
      });
      refresh = () => { for (const [value, b] of buttons) b.setAttribute('aria-pressed', String(String(value) === String(s.get(item.id)))); };
      row.append(group);
    } else if (item.type === 'select') {
      const select = document.createElement('select');
      select.className = 'menu-select';
      select.setAttribute('aria-labelledby', label.id);
      for (const [value, text] of item.options) {
        const o = document.createElement('option');
        o.value = String(value);
        o.textContent = text;
        select.append(o);
      }
      select.addEventListener('change', () => {
        const original = item.options.find(([v]) => String(v) === select.value)?.[0];
        s.set(item.id, original);
      });
      refresh = () => { select.value = String(s.get(item.id)); };
      row.append(select);
    } else if (item.type === 'slider') {
      const chip = document.createElement('output');
      chip.className = 'value-chip';
      row.append(chip);
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'range';
      range.min = item.min; range.max = item.max; range.step = item.step;
      range.setAttribute('aria-labelledby', label.id);
      const paint = (v) => {
        chip.textContent = item.format ? item.format(v) : String(v);
        range.style.setProperty('--fill', `${((v - item.min) / (item.max - item.min)) * 100}%`);
      };
      range.addEventListener('input', () => { const v = Number(range.value); paint(v); s.set(item.id, v); });
      refresh = () => { const v = Number(s.get(item.id)); range.value = String(v); paint(v); };
      row.append(range);
    } else if (item.type === 'readout') {
      const out = document.createElement('output');
      out.className = 'value-chip';
      refresh = () => { out.textContent = item.format ? item.format(s.get(item.id)) : String(s.get(item.id)); };
      row.append(out);
    } else if (item.type === 'button') {
      label.remove();
      const b = document.createElement('button');
      b.className = 'menu__action';
      b.textContent = item.label;
      b.addEventListener('click', () => s.trigger(item.id));
      row.append(b);
    }

    if (item.type !== 'button' && item.type !== 'readout') {
      const reset = document.createElement('button');
      reset.className = 'setting__reset';
      reset.title = 'Back to the default';
      reset.setAttribute('aria-label', `Reset ${item.label}`);
      reset.innerHTML = icon('reset', 14);
      reset.addEventListener('click', () => s.reset(item.id));
      const inner = refresh;
      refresh = () => { inner(); reset.hidden = s.isDefault(item.id); };
      row.insertBefore(reset, label.nextSibling);
    }
    if (item.hint) {
      const hint = document.createElement('p');
      hint.className = 'setting__hint';
      hint.textContent = item.hint;
      row.append(hint);
    }
    refresh();
    this.refreshers.push(refresh);
    return row;
  }

  /* ---- keys --------------------------------------------------------------- */

  #keyTable(item) {
    const wrap = document.createElement('div');
    wrap.className = 'keys';
    const note = document.createElement('p');
    note.className = 'keys__note';
    note.textContent = 'Click a key, then press the one you want. Esc cancels, Backspace clears.';
    wrap.append(note);
    const buttons = [];
    for (const action of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'keys__row';
      const label = document.createElement('div');
      label.className = 'keys__label';
      label.textContent = action.label;
      if (action.hint) {
        const h = document.createElement('span');
        h.className = 'keys__hint';
        h.textContent = action.hint;
        label.append(h);
      }
      row.append(label);
      for (let slot = 0; slot < 2; slot++) {
        const b = document.createElement('button');
        b.className = 'key';
        b.addEventListener('click', () => this.#listen(action.id, slot, b));
        row.append(b);
        buttons.push([action.id, slot, b]);
      }
      wrap.append(row);
    }
    this.keyNote = note;
    const refresh = () => {
      const binds = this.settings.get(item.id);
      for (const [id, slot, b] of buttons) {
        if (this.listening?.button === b) continue;
        const code = binds[id]?.[slot];
        b.textContent = keyLabel(code);
        b.classList.toggle('key--empty', !code);
      }
    };
    refresh();
    this.refreshers.push(refresh);
    return wrap;
  }

  #listen(action, slot, button) {
    this.#stopListening();
    this.listening = { action, slot, button };
    button.dataset.listening = 'true';
    button.textContent = 'Press a key';
  }

  #stopListening() {
    if (!this.listening) return;
    delete this.listening.button.dataset.listening;
    this.listening = null;
    this.#refresh();
  }

  #keydown(e) {
    if (this.listening) {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { this.#stopListening(); return; }
      const { action, slot } = this.listening;
      const binds = structuredClone(this.settings.get('keybinds'));
      let moved = '';
      if (e.code !== 'Backspace') {
        // One key, one action: take it from wherever else it was.
        for (const [id, keys] of Object.entries(binds)) {
          keys.forEach((k, i) => {
            if (k === e.code && !(id === action && i === slot)) {
              keys[i] = null;
              moved = ACTIONS.find((a) => a.id === id)?.label ?? id;
            }
          });
        }
      }
      binds[action] = [...(binds[action] || [])];
      binds[action][slot] = e.code === 'Backspace' ? null : e.code;
      this.listening = null;
      this.settings.set('keybinds', binds);
      this.keyNote.textContent = moved
        ? `${keyLabel(e.code)} moved here from “${moved}”.`
        : 'Click a key, then press the one you want. Esc cancels, Backspace clears.';
      this.#refresh();
      return;
    }
    if (e.key === 'Escape' && this.isOpen) {
      e.preventDefault();
      this.toggle(false);
    }
  }
}
