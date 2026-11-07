/* cockpit.js — the airplane mode's display (Stage 5.9b), over the view, on
 * the main thread.
 *
 * What it shows is his to choose (Settings → Vehicles → Airplane display;
 * his words: "where you can check what you want on or not ... default should
 * be just a point as pointer (no atitude thing), but with option to turn that
 * on"). The pointer, a dot in the middle (where the jet goes, or where its
 * nose points: Settings → Vehicles → Airplane → View), is the crosshair's element
 * restyled (css/ui.css, main.js): it costs nothing a frame. Everything else
 * is drawn here, and only while something is on: then the render thread
 * sends the jet's state (engine/controllers/plane.js, report) every frame and
 * this draws it on a 2D canvas at the next animation frame (making no
 * garbage: fonts made once, scratch vectors), in the interface's look rather
 * than a military green: thin white lines and figures with a soft shadow, the
 * flight path's blue for what you asked for.
 *   ladder      the horizon and a line every 10° of pitch, dashed under the
 *               horizon, true to the view (drawn where those angles are on
 *               the screen, rolled with it), round the way the view looks
 *               and on both sides of straight up and down, so they turn with
 *               the view through rolls and loops and never jump (Stage
 *               5.12b, his words: "plane ui messes up when airplane does
 *               barrel rolls or rolls and then pulls up/down": 5.11b drew
 *               them round the nose's heading, which flips at the vertical
 *               and is not where the view looks when it looks along the
 *               path); hidden while you look round
 *   marker      the flight path marker (a ring with wings: where the jet is
 *               really going, the velocity seen through the screen; the gap
 *               between it and the nose is the wing's angle and any drift)
 *   speed       left: the speed (km/h), the speed asked under it (or, when
 *               the scroll wheel sets the throttle, the throttle: Stage
 *               5.13b), the Mach number and the load (g)
 *   altitude    right: the altitude over the sea (m), over the ground under
 *               it (R), and the climb (m/s)
 *   heading     at the top
 *   throttle    bottom left: idle to full dry thrust, then the afterburner
 *   warnings    STALL while the wing is stalled (5.11b), BRAKE, ON GROUND
 * Projecting the conformal symbols uses the camera's own conventions
 * (engine/camera.js: yaw from north, pitch up, roll banking the picture's
 * up towards its right; FOV_Y vertical).
 */

import { FOV_Y } from '../engine/camera.js';

const DEG = Math.PI / 180;
const FONT = (weight, px) => `${weight} ${px}px "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`;
const FIGURE = FONT(600, 18), HEADING = FONT(600, 15), ASKED = FONT(600, 13), SMALL = FONT(500, 13),
  FLAG = FONT(600, 13), THROTTLE = FONT(600, 12), UNIT = FONT(500, 11);
const INK = 'rgba(255, 255, 255, 0.92)';
const DIM = 'rgba(255, 255, 255, 0.62)';
const ACCENT = '#3d8bff';
const WARN = '#ff6b5e';
const DASH = [6, 5], SOLID = [];
const TAN = Math.tan(FOV_Y / 2);

/* Scratch, so a frame of the display makes no garbage: the view's axes, a
 * direction, two points on the screen, and the ladder's lines. */
const F = new Float64Array(3), R = new Float64Array(3), U = new Float64Array(3);
const D = new Float64Array(3), P = new Float64Array(2), Q = new Float64Array(2);
const TA = new Float64Array(3), TE = new Float64Array(3);
const LINES = [];

export class Cockpit {
  constructor(canvas = document.getElementById('cockpit')) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = null;
    this.pending = false;
    this.on = false;
    this.show = { ladder: false, marker: false, speed: false, altitude: false, heading: false, throttle: false, warnings: false };
    this.ladder = { turn: null };   // the ladder's turn kept from frame to frame (ladderLines)
    this.any = false;
    addEventListener('resize', () => this.#size());
    this.#size();
  }

  /** What to draw: { ladder, marker, speed, altitude, heading, throttle, warnings }, each true or false. */
  configure(show) {
    let any = false;
    for (const k in this.show) { this.show[k] = Boolean(show[k]); any ||= this.show[k]; }
    this.any = any;
    if (!any) this.#hide();
    else if (this.state) { this.#reveal(); this.#schedule(); }
  }

  #size() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    if (this.state) this.#draw();
  }

  /**
   * From the render thread: the jet's state (every frame while something is
   * shown), { on, looking } (getting in, or looking round, when only the
   * pointer is), or { off: true } (leaving the airplane).
   */
  update(state) {
    if (state.off) { this.state = null; this.ladder.turn = null; }
    else if (state.speed != null) this.state = state;
    if (!this.state || !this.any) { this.#hide(); return; }
    this.#reveal();
    this.#schedule();
  }

  #reveal() { if (!this.on) { this.on = true; this.canvas.hidden = false; } }
  #hide() { if (this.on) { this.on = false; this.canvas.hidden = true; } }
  #schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; if (this.state && this.on) this.#draw(); });
  }

  #draw() {
    const s = this.state, ctx = this.ctx, dpr = this.dpr;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr, cx = W / 2, cy = H / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    const show = this.show;
    basis(s.yaw, s.pitch, s.roll);
    if (!s.looking) {
      if (show.ladder) this.#ladder(ctx, s, W, H);
      const V = Math.sqrt(s.vEast * s.vEast + s.vNorth * s.vNorth + s.vUp * s.vUp);
      if (show.marker && V > 5) {
        D[0] = s.vEast / V; D[1] = s.vNorth / V; D[2] = s.vUp / V;
        if (project(D, W, H, P)) this.#marker(ctx, P[0], P[1]);
      }
    }
    // Near enough the middle to read at a glance, clear of the readout at the bottom left.
    const lx = cx - Math.min(200, W * 0.16), rx = cx + Math.min(200, W * 0.16);
    if (show.speed) {
      // Left: the speed, what is asked, Mach, g.
      box(ctx, lx, cy, `${Math.round(s.speed * 3.6)}`, 'km/h', 'right');
      text(ctx, s.manual ? `▸ ${leverText(s.lever)}` : s.target > 0 ? `▸ ${Math.round(s.target * 3.6)}` : '▸ engine off', lx, cy + 30, ACCENT, ASKED, 'right');
      text(ctx, `M ${s.mach.toFixed(2)}`, lx, cy + 50, DIM, SMALL, 'right');
      text(ctx, `${s.load.toFixed(1)} g`, lx, cy + 68, Math.abs(s.load) > 7.5 ? WARN : DIM, SMALL, 'right');
    }
    if (show.altitude) {
      // Right: altitude, over the ground, climb.
      box(ctx, rx, cy, `${Math.round(s.altitude).toLocaleString('en-US')}`, 'm', 'left');
      text(ctx, s.above != null ? `R ${Math.round(s.above).toLocaleString('en-US')}` : 'R —', rx, cy + 30, DIM, SMALL, 'left');
      text(ctx, `${s.climb >= 0 ? '+' : '−'}${Math.abs(s.climb).toFixed(0)} m/s`, rx, cy + 50, DIM, SMALL, 'left');
    }
    if (show.heading) {
      const hdg = ((Math.round(s.heading / DEG) % 360) + 360) % 360;
      text(ctx, `${String(hdg).padStart(3, '0')}°`, cx, 100, INK, HEADING, 'center');
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, 106);
      ctx.lineTo(cx, 114);
      ctx.stroke();
    }
    if (show.throttle) this.#throttle(ctx, lx - 60, cy + 92, s);
    if (show.warnings) {
      // One under the other.
      let y = cy + 110;
      if (s.stall) { text(ctx, 'STALL', cx, y, WARN, FLAG, 'center'); y += 20; }
      if (s.brake) { text(ctx, 'BRAKE', cx, y, INK, FLAG, 'center'); y += 20; }
      if (s.onGround) text(ctx, s.waiting ? 'WAITING FOR GROUND' : 'ON GROUND', cx, y, DIM, FLAG, 'center');
    }
  }

  /* The horizon and the pitch lines, every 10°, where they are on the screen. */
  #ladder(ctx, s, W, H) {
    const n = ladderLines(s, W, H, LINES, this.ladder);
    for (let i = 0; i < n; i++) {
      const { e, x: px, y: py, ux, uy, hx, hy } = LINES[i];
      const horizon = e === 0, half = horizon ? 150 : 70, gap = horizon ? 34 : 26;
      ctx.strokeStyle = horizon ? INK : DIM;
      ctx.lineWidth = horizon ? 1.5 : 1.25;
      ctx.setLineDash(e < 0 ? DASH : SOLID);
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.moveTo(px + side * gap * ux, py + side * gap * uy);
        ctx.lineTo(px + side * half * ux, py + side * half * uy);
        // The tips point at the horizon.
        if (!horizon) ctx.lineTo(px + side * half * ux + 6 * hx, py + side * half * uy + 6 * hy);
        ctx.stroke();
      }
      ctx.setLineDash(SOLID);
      if (!horizon) {
        const label = LABELS[Math.abs(e) / 10];
        text(ctx, label, px + (half + 16) * ux, py + (half + 16) * uy + 4, DIM, UNIT, 'center');
        text(ctx, label, px - (half + 16) * ux, py - (half + 16) * uy + 4, DIM, UNIT, 'center');
      }
    }
  }

  /* The flight path marker: a ring with wings and a fin. */
  #marker(ctx, x, y) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.moveTo(x - 6, y); ctx.lineTo(x - 18, y);
    ctx.moveTo(x + 6, y); ctx.lineTo(x + 18, y);
    ctx.moveTo(x, y - 6); ctx.lineTo(x, y - 12);
    ctx.stroke();
  }

  /* The throttle: a thin bar, idle to full dry thrust white, the afterburner blue. */
  #throttle(ctx, x, y, s) {
    const w = 60, h = 4, dry = 0.75;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = INK;
    ctx.fillRect(x, y, w * Math.min(s.throttle, dry), h);
    if (s.throttle > dry) {
      ctx.fillStyle = ACCENT;
      ctx.fillRect(x + w * dry, y, w * (s.throttle - dry), h);
    }
    ctx.fillStyle = INK;
    ctx.fillRect(x + w * dry - 0.5, y - 3, 1, h + 6);
    text(ctx, s.afterburner ? 'AB' : `${Math.round(100 * Math.min(1, s.throttle / dry))}%`, x + w, y + 18,
      s.afterburner ? ACCENT : DIM, THROTTLE, 'right');
  }
}

const LABELS = ['0', '10', '20', '30', '40', '50', '60', '70', '80'];
/* The throttle lever (0 idle, 0.75 full dry thrust, 1 full afterburner) as
 * the speed box shows it: the share of dry thrust, then the afterburner's. */
function leverText(lever) {
  return lever <= 0.75 + 1e-6 ? `${Math.round((100 * lever) / 0.75)}%` : `AB ${Math.round((100 * (lever - 0.75)) / 0.25)}%`;
}
/* Near straight up or down, as how much of the view's forward lies across
 * (the sine of its angle from the vertical): the screen's top starts taking
 * over the ladder's azimuth from 12° off it, and has it from 3°. */
const LADDER_TOP = { from: Math.sin(12 * DEG), to: Math.sin(3 * DEG) };
const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
/* An angle between lines, within a quarter turn either way. */
const halfWrap = (a) => a - Math.PI * Math.round(a / Math.PI);

/**
 * The pitch ladder's lines for a view ({ yaw, pitch, roll }, the camera's)
 * on a W × H screen, into `out` (records reused frame to frame): each line's
 * pitch `e` (degrees), the azimuth `az` it is drawn at, its middle (x, y),
 * its direction along the screen (ux, uy) and the side towards the horizon
 * (hx, hy). Returns how many there are.
 *
 * Round the view's own azimuth, where the vertical circle through the middle
 * of the screen meets each pitch's circle, and on the circle's far side too:
 * through straight up or down the two swap, so the lines carry on across the
 * screen as the view turns rather than jumping (a loop) or hanging where the
 * nose points while the view looks along the path. Near straight up or down
 * (within LADDER_TOP), where the forward's own azimuth swings round as the
 * view passes close by, the way the screen's top (looking up) or bottom
 * (looking down) points takes over, which stays put. Between the two the
 * ladder turns from one to the other, the way round it turned last frame
 * (`memory`, { turn }, kept by the caller from frame to frame, turn null at
 * first): where the two are a quarter turn apart (passing the vertical a few
 * degrees off, or rolled across it) either way round would do, and only the
 * one it was turning keeps it from jumping. With a number for `fixed`, only
 * round that azimuth (5.11b's way, with the nose's heading), to compare with.
 */
export function ladderLines(view, W, H, out = [], memory = null, fixed = null) {
  basis(view.yaw, view.pitch, view.roll);
  let az = fixed, sides = 1;
  if (az == null) {
    sides = 2;
    const down = F[2] >= 0 ? -1 : 1, top = Math.atan2(down * U[0], down * U[1]);
    const across = Math.sqrt(F[0] * F[0] + F[1] * F[1]);
    const ahead = across > 1e-9 ? Math.atan2(F[0], F[1]) : top;
    const k = across > 1e-9 ? smoothstep((LADDER_TOP.from - across) / (LADDER_TOP.from - LADDER_TOP.to)) : 1;
    // From the forward's azimuth to the top's, as lines (both sides drawn, so
    // a half turn is none), carried on from last frame's.
    const last = memory?.turn;
    let turn = last == null ? halfWrap(top - ahead) : last + halfWrap(top - ahead - last);
    // Wholly one or the other, the way round no longer matters: back to the nearest.
    if (k <= 0 || k >= 1) turn = halfWrap(turn);
    if (memory) memory.turn = turn;
    az = ahead + k * turn;
  }
  let n = 0;
  for (let side = 0; side < sides; side++) {
    const a = az + side * Math.PI, sa = Math.sin(a), ca = Math.cos(a);
    for (let e = -80; e <= 80; e += 10) {
      const el = e * DEG, ce = Math.cos(el), se = Math.sin(el);
      D[0] = sa * ce; D[1] = ca * ce; D[2] = se;
      if (!project(D, W, H, P)) continue;
      const px = P[0], py = P[1];
      if (px < -200 || px > W + 200 || py < -200 || py > H + 200) continue;
      // Along the line: the way the point moves on the screen as its azimuth grows.
      TA[0] = ca; TA[1] = -sa; TA[2] = 0;
      along(D, TA, H, Q);
      let ux = Q[0], uy = Q[1];
      const len = Math.sqrt(ux * ux + uy * uy);
      if (!(len > 1e-9)) continue;
      ux /= len; uy /= len;
      // Towards the horizon: the side of the line where the pitch nears 0.
      TE[0] = -sa * se; TE[1] = -ca * se; TE[2] = ce;
      along(D, TE, H, Q);
      let hx = -uy, hy = ux;
      if ((Q[0] * hx + Q[1] * hy) * e > 0) { hx = -hx; hy = -hy; }
      const line = out[n] ?? (out[n] = { e: 0, az: 0, x: 0, y: 0, ux: 0, uy: 0, hx: 0, hy: 0 });
      line.e = e; line.az = a; line.x = px; line.y = py; line.ux = ux; line.uy = uy; line.hx = hx; line.hy = hy;
      n++;
    }
  }
  return n;
}

/* The camera's axes for yaw, pitch and roll into F, R, U (engine/camera.js:
 * right = forward × up, banked up = up cos roll + right sin roll). */
function basis(yaw, pitch, roll) {
  const cp = Math.cos(pitch);
  F[0] = Math.sin(yaw) * cp; F[1] = Math.cos(yaw) * cp; F[2] = Math.sin(pitch);
  const n = Math.sqrt(F[0] * F[0] + F[1] * F[1]) || 1;
  const r0 = F[1] / n, r1 = -F[0] / n;            // level right
  const u0 = r1 * F[2], u1 = -r0 * F[2], u2 = r0 * F[1] - r1 * F[0];   // level up = right × forward
  const c = Math.cos(roll), s = Math.sin(roll);
  U[0] = u0 * c + r0 * s; U[1] = u1 * c + r1 * s; U[2] = u2 * c;
  R[0] = r0 * c - u0 * s; R[1] = r1 * c - u1 * s; R[2] = -u2 * s;
}

/* Where the direction d (east, north, up) is on a W × H screen, into out: false behind the eye. */
function project(d, W, H, out) {
  const z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2];
  if (z <= 1e-3) return false;
  const cx = W / 2, cy = H / 2;
  out[0] = cx + ((d[0] * R[0] + d[1] * R[1] + d[2] * R[2]) / z / (TAN * (W / H))) * cx;
  out[1] = cy - ((d[0] * U[0] + d[1] * U[1] + d[2] * U[2]) / z / TAN) * cy;
  return true;
}

/* The way (into out, in pixels per radian) the point on the screen of the
 * direction d moves as d turns towards t (unit, at right angles to d), on a
 * screen H high: the projection's derivative. */
function along(d, t, H, out) {
  const z = d[0] * F[0] + d[1] * F[1] + d[2] * F[2], x = d[0] * R[0] + d[1] * R[1] + d[2] * R[2], y = d[0] * U[0] + d[1] * U[1] + d[2] * U[2];
  const tz = t[0] * F[0] + t[1] * F[1] + t[2] * F[2], tx = t[0] * R[0] + t[1] * R[1] + t[2] * R[2], ty = t[0] * U[0] + t[1] * U[1] + t[2] * U[2];
  const f = H / (2 * TAN) / (z * z);
  out[0] = f * (tx * z - x * tz);
  out[1] = -f * (ty * z - y * tz);
  return out;
}

/* The direction of azimuth az and elevation el, into out. */
function dir(az, el, out) {
  const ce = Math.cos(el);
  out[0] = Math.sin(az) * ce; out[1] = Math.cos(az) * ce; out[2] = Math.sin(el);
  return out;
}

function text(ctx, t, x, y, colour, font, align) {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = colour;
  ctx.fillText(t, x, y);
}

/* A figure in a thin box, with its unit under it. */
function box(ctx, x, y, value, unit, side) {
  ctx.font = FIGURE;
  const w = Math.max(64, ctx.measureText(value).width + 18), h = 28;
  const left = side === 'right' ? x - w : x;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.roundRect(left, y - h / 2, w, h, 6);
  ctx.stroke();
  text(ctx, value, left + w / 2, y + 6.5, INK, FIGURE, 'center');
  // The unit on the box's inner side, towards the middle.
  text(ctx, unit, side === 'right' ? left + w + 6 : left - 6, y + 5, DIM, UNIT, side === 'right' ? 'left' : 'right');
}
