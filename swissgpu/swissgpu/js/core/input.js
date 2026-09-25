/* input.js — keyboard and mouse on the page thread, camera on the render thread.
 *
 * The page thread does no camera maths. It watches the raw events, folds the
 * held keys into a bitmask, and forwards only what changed. A held key sends
 * one message when pressed and one when released, not sixty a second.
 *
 * It also stands between you and the browser's own shortcuts, which is a
 * two-tier problem. Most are ordinary and yield to preventDefault. A handful
 * are reserved by the browser and ignore it entirely, and the only way to
 * reach those is the Keyboard Lock API, which applies only in fullscreen.
 * Ctrl+W is in that second group, and Ctrl+W is the sprint binding.
 */

import { KEY } from '../engine/camera.js';
import { DEFAULT_BINDINGS } from './settings.js';

/* Held actions and the bit each sets in the mask the render thread reads. */
const HELD = {
  forward: KEY.FORWARD, back: KEY.BACK, left: KEY.LEFT, right: KEY.RIGHT,
  up: KEY.UP, down: KEY.DOWN, sprint: KEY.SPRINT,
};

/* Suppressed while flying. Every one of these yields to preventDefault.
 * Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+W and Ctrl+Tab are deliberately absent:
 * they are reserved, preventDefault does nothing to them, and listing them
 * would only suggest otherwise. Keyboard lock is what handles those. */
const WITH_MODIFIER = new Set([
  'KeyD', 'KeyS', 'KeyP', 'KeyF', 'KeyO', 'KeyU', 'KeyG', 'KeyJ',
  'KeyR', 'KeyE', 'KeyH', 'KeyL', 'KeyB', 'KeyK',
  'Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
]);

const PLAIN = new Set(['F1', 'F3', 'F5', 'F6', 'F7', 'F10', 'Tab', 'Backspace', 'Space']);

export class InputBridge {
  /**
   * @param bindings  action id -> key codes (see ACTIONS in core/settings.js)
   * @param onAction  called with the id of a press action (not movement)
   */
  constructor(canvas, endpoint, { onLockChange, onAction, bindings = DEFAULT_BINDINGS, captureKeys = true, doubleTapMs = 300 } = {}) {
    this.canvas = canvas;
    this.endpoint = endpoint;
    this.mask = 0;
    this.locked = false;
    this.capture = captureKeys;
    this.onLockChange = onLockChange;
    this.onAction = onAction;
    this.doubleTapMs = doubleTapMs;
    this.lastSpace = -Infinity;
    this.setBindings(bindings);

    canvas.addEventListener('click', () => {
      if (this.locked) return;
      // Keyboard lock has to be asked for before fullscreen takes hold, and
      // both need the user gesture this click provides.
      if (this.capture) this.#grabKeyboard();
      // Raw mouse movement, without the operating system's acceleration, so
      // the same hand movement always turns the view by the same angle.
      // Not every platform offers it; plain pointer lock is the fallback.
      Promise.resolve()
        .then(() => canvas.requestPointerLock({ unadjustedMovement: true }))
        .catch(() => canvas.requestPointerLock());
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.#setMask(0); this.#releaseKeyboard(); }
      this.onLockChange?.(this.locked);
    });

    // Leaving fullscreen by any other route should not leave the keyboard held.
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) navigator.keyboard?.unlock?.();
    });

    addEventListener('keydown', (e) => this.#keydown(e));
    addEventListener('keyup', (e) => this.#key(e, false));
    // Alt-tabbing away with a key down would otherwise leave it stuck on.
    addEventListener('blur', () => this.#setMask(0));

    /* Mouse movement at the mouse's own rate, not once per page frame.
     * `mousemove` is coalesced to the page's frames, and the render thread
     * draws on its own clock: a batch that lands just after a render frame
     * starts waits a whole frame, so a steady turn arrives as uneven steps.
     * `pointerrawupdate` fires for every report the mouse sends, spreading
     * the movement evenly across render frames. */
    const look = (e) => {
      if (!this.locked) return;
      if (e.movementX || e.movementY) endpoint.send('look', { dx: e.movementX, dy: e.movementY });
    };
    if ('onpointerrawupdate' in window) addEventListener('pointerrawupdate', look);
    else addEventListener('mousemove', look);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      endpoint.send('speed', { notches: -Math.sign(e.deltaY) });
    }, { passive: false });
  }

  setDoubleTap(ms) { this.doubleTapMs = Number(ms) || 300; }

  /** From the key table: which action each physical key performs. */
  setBindings(bindings) {
    this.byCode = new Map();
    for (const [action, codes] of Object.entries(bindings || {})) {
      for (const code of codes || []) if (code) this.byCode.set(code, action);
    }
    // Keys let go of while their binding changed would stay held otherwise.
    this.#setMask(0);
  }

  setCapture(on) {
    this.capture = Boolean(on);
    if (!this.capture) this.#releaseKeyboard();
    else if (this.locked) this.#grabKeyboard();
  }

  async #grabKeyboard() {
    try {
      // Captures the reserved combinations, but only takes effect while the
      // document is fullscreen, so both go together.
      await navigator.keyboard?.lock?.();
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch (err) {
      console.warn(`[input] full keyboard capture unavailable: ${err.message}`);
    }
  }

  #releaseKeyboard() {
    navigator.keyboard?.unlock?.();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  #keydown(e) {
    // With the keyboard locked, Escape is delivered here instead of to the
    // browser, so releasing everything becomes our job. A tap is enough;
    // Chrome's own press-and-hold still works as a backstop.
    if (e.code === 'Escape' && this.locked) {
      e.preventDefault();
      document.exitPointerLock();
      return;
    }
    if (this.locked && shouldSuppress(e)) e.preventDefault();
    this.#key(e, true);
    const action = this.byCode.get(e.code);
    if (!this.locked || e.repeat || !action) return;

    /* Two presses of Jump close together switch between walking and flying.
     * The first press has already acted (a jump, or the start of a climb), so
     * the toggle never makes Jump feel delayed. The key state goes out
     * before the toggle on purpose: the controller taking over then sees
     * Jump as already held, and does not treat it as a fresh jump. Held-key
     * repeats are not presses. */
    if (action === 'up') {
      if (e.timeStamp - this.lastSpace <= this.doubleTapMs) {
        this.lastSpace = -Infinity;   // a third press starts a new pair
        this.endpoint.send('mode', {});
      } else {
        this.lastSpace = e.timeStamp;
      }
    } else if (action === 'toggleMode') {
      e.preventDefault();
      this.endpoint.send('mode', {});
    } else if (!(action in HELD)) {
      e.preventDefault();
      this.onAction?.(action);
    }
  }

  #key(e, down) {
    const bit = HELD[this.byCode.get(e.code)];
    if (bit === undefined) return;
    // Only swallow the key when it is actually driving the camera, so typing
    // in the search box still works.
    if (!this.locked) return;
    e.preventDefault();
    this.#setMask(down ? this.mask | bit : this.mask & ~bit);
  }

  #setMask(next) {
    if (next === this.mask) return;
    this.mask = next;
    this.endpoint.send('keys', { mask: next });
  }
}

function shouldSuppress(e) {
  if (e.ctrlKey || e.metaKey) return WITH_MODIFIER.has(e.code);
  if (e.altKey) return e.code === 'ArrowLeft' || e.code === 'ArrowRight';
  return PLAIN.has(e.code);
}
