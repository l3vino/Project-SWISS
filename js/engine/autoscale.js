/* autoscale.js — the render scale kept to a frame rate (5.17l).
 *
 * His words on 5.17j, on a laptop (an Intel Xe-LPG drawing 2559 × 1389): "fps is terrible" (37 fps, the GPU 23 ms a
 * frame). Pixels are the bulk of the work here (the photo, the roads painted under each pixel, the buildings' faces,
 * the air), so the render scale is the biggest lever (settings.js), and a fixed one is right on one GPU only. As
 * Unity HDRP's dynamic resolution does: the GPU's time is averaged over a group of GROUP frames; after DOWN_GROUPS
 * groups over the frame's budget (the target frame rate's, OVER of it) the scale goes down at once to what should fit
 * with some room (pixels go with the scale squared: scale · sqrt(ROOM · budget / time)), after UP_GROUPS groups well
 * under it (UNDER) up a STEP; never under LEAST nor over his own render scale (`most`). Each change resizes the
 * canvas and its depth (a hitch), so changes come in STEPs and SETTLE frames after one are not counted (they were
 * drawn at the size before). Where the GPU's time is not measured, the frame's interval stands in for it.
 */

const GROUP = 20, DOWN_GROUPS = 2, UP_GROUPS = 6, SETTLE = 6;
const OVER = 0.92, UNDER = 0.62, ROOM = 0.82;
export const AUTO_LEAST = 0.5;
const STEP = 0.05;

export class AutoScale {
  constructor() {
    this.enabled = true;
    this.target = 60;            // frames a second aimed for
    this.most = 1;               // his render scale: the most it goes to
    this.scale = 1;              // the scale drawn at now
    this.sum = 0;
    this.count = 0;
    this.over = 0;
    this.under = 0;
    this.settle = 0;
    this.last = 0;               // the last group's mean, ms
    this.changes = 0;
  }

  /** The scale to draw at (his own when this is off). */
  get effective() {
    return this.enabled ? Math.min(this.most, this.scale) : this.most;
  }

  /** His settings changed: back to his scale (and it adapts from there). */
  reset() {
    this.scale = this.most;
    this.sum = this.count = this.over = this.under = 0;
    this.settle = SETTLE;
  }

  /**
   * One frame's GPU time (ms). @returns the new scale when it changes, else null.
   */
  feed(ms) {
    if (!this.enabled || !(ms > 0)) return null;
    if (this.settle > 0) { this.settle--; return null; }
    this.sum += ms;
    if (++this.count < GROUP) return null;
    const mean = this.sum / this.count, budget = 1000 / this.target;
    this.last = mean;
    this.sum = this.count = 0;
    let next = this.scale;
    if (mean > budget * OVER) {
      this.under = 0;
      if (++this.over >= DOWN_GROUPS) {
        this.over = 0;
        next = Math.round((this.scale * Math.sqrt((ROOM * budget) / mean)) / STEP) * STEP;
        next = Math.min(this.scale - STEP, next);
      }
    } else if (mean < budget * UNDER) {
      this.over = 0;
      if (++this.under >= UP_GROUPS) {
        this.under = 0;
        next = this.scale + STEP;
      }
    } else {
      this.over = this.under = 0;
    }
    next = Math.round(Math.max(AUTO_LEAST, Math.min(this.most, next)) * 100) / 100;
    if (next === this.scale) return null;
    this.scale = next;
    this.settle = SETTLE;
    this.changes++;
    return next;
  }
}
