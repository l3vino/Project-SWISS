/* settings-panel.js — builds the whole panel from the schema.
 *
 * No control is hand-written here. Adding a setting is one schema entry, which
 * is the only way a settings menu this wide stays maintainable.
 */

import { SCHEMA } from '../core/settings.js';

export class SettingsPanel {
  constructor(settings) {
    this.settings = settings;
    this.panel = document.getElementById('settings');
    this.body = document.getElementById('panel-body');
    this.gear = document.getElementById('gear');

    this.gear.addEventListener('click', () => this.toggle());
    document.getElementById('panel-close').addEventListener('click', () => this.toggle(false));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.toggle(false);
    });

    this.#build();
  }

  get isOpen() { return this.panel.dataset.open === 'true'; }

  toggle(force) {
    const open = force ?? !this.isOpen;
    this.panel.dataset.open = String(open);
    this.panel.setAttribute('aria-hidden', String(!open));
    this.gear.setAttribute('aria-expanded', String(open));
    if (open) this.panel.querySelector('button, input, select')?.focus();
  }

  #build() {
    for (const group of SCHEMA) {
      const section = document.createElement('section');
      section.className = 'group';

      const title = document.createElement('h3');
      title.className = 'group__title';
      title.textContent = group.label;
      section.append(title);

      if (!group.items.length) {
        const note = document.createElement('p');
        note.className = 'group__pending';
        note.textContent = group.comingIn ? `Arrives in ${group.comingIn}.` : 'Nothing to configure yet.';
        section.append(note);
      }

      for (const item of group.items) section.append(this.#field(item));
      this.body.append(section);
    }
  }

  #field(item) {
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const row = document.createElement('div');
    row.className = 'field__row';

    const label = document.createElement('label');
    label.className = 'field__label';
    label.textContent = item.label;
    label.htmlFor = `set-${item.id}`;
    row.append(label);

    const current = this.settings.get(item.id);
    const value = current;   // used by the interactive control types below
    let control;

    if (item.type === 'toggle') {
      control = document.createElement('button');
      control.className = 'switch';
      control.id = `set-${item.id}`;
      control.setAttribute('role', 'switch');
      control.setAttribute('aria-checked', String(value));
      control.addEventListener('click', () => {
        const next = control.getAttribute('aria-checked') !== 'true';
        control.setAttribute('aria-checked', String(next));
        this.settings.set(item.id, next);
      });
      row.append(control);
      wrap.append(row);

    } else if (item.type === 'select') {
      control = document.createElement('select');
      control.className = 'select';
      control.id = `set-${item.id}`;
      for (const [v, text] of item.options) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = text;
        opt.selected = String(v) === String(value);
        control.append(opt);
      }
      control.addEventListener('change', () => {
        const raw = control.value;
        const original = item.options.find(([v]) => String(v) === raw)?.[0];
        this.settings.set(item.id, original);
      });
      row.append(control);
      wrap.append(row);

    } else if (item.type === 'readout') {
      const display = document.createElement('span');
      display.className = 'field__value';
      const show = (v) => { display.textContent = item.format ? item.format(v) : String(v); };
      show(current);
      row.append(display);
      wrap.append(row);
      // Readouts mirror a value someone else owns, so keep them in step.
      this.settings.on(item.id, show);

    } else if (item.type === 'button') {
      label.remove();
      control = document.createElement('button');
      control.className = 'action';
      control.id = `set-${item.id}`;
      control.textContent = item.label;
      control.addEventListener('click', () => this.settings.trigger(item.id));
      row.append(control);
      wrap.append(row);

    } else if (item.type === 'slider') {
      const readout = document.createElement('span');
      readout.className = 'field__value';
      readout.textContent = item.format ? item.format(value) : value;
      row.append(readout);
      wrap.append(row);

      control = document.createElement('input');
      control.type = 'range';
      control.className = 'slider';
      control.id = `set-${item.id}`;
      control.min = item.min;
      control.max = item.max;
      control.step = item.step;
      control.value = value;
      control.addEventListener('input', () => {
        const v = Number(control.value);
        readout.textContent = item.format ? item.format(v) : v;
        this.settings.set(item.id, v);
      });
      wrap.append(control);
    }

    if (item.hint) {
      const hint = document.createElement('p');
      hint.className = 'field__hint';
      hint.textContent = item.hint;
      wrap.append(hint);
    }

    return wrap;
  }
}
