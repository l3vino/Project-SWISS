/* fit.js — how a tube meets the ground (Stage 5.17c; 5.17d; 5.17e).
 *
 * His words (on 5.17b): "the terrain sometimes still has holes where you see
 * through the world. you can also see that the terrain in this case is not
 * supposed to be a road, so just keep terrain without generating road."
 * On 5.17c: "the system seems to not understand sottopassaggi and the
 * terrain. any type of road should be priority, base of tunnel must be base
 * of road in front of it (nearest one). it breaks things around".
 * On 5.17d: "tunnels should be aligned with road starts, height musst also
 * be aligned, otherwise there are floating tunnels like in Locarno. if there
 * is a road or something above the tunnel, it should not be obstructed in
 * any way, that's also the point of a tunnel, be underground, so it
 * shouldn't go above ground and obstruct things."
 *
 * The tunnel lines say where a tunnel runs, not how the ground lies over it;
 * the terrain does. The ground is sampled (tunnels.js, from the finest
 * terrain tiles) along each portal's axis and along the whole tube, and held
 * against the tube's floor:
 *   - each portal's floor is the road right in front of it (tunnels.js
 *     #portalFloor), and the tube starts exactly there, at the mapped
 *     portal (5.17d started it where the hillside's face was, up to 10 m
 *     further in: the road and the tube did not meet);
 *   - a short tunnel (a whole one under SHORT metres: an underpass, a cut
 *     and cover) must fit under the ground over it, between where each
 *     portal's ground first has room for the least tunnel of its kind (short
 *     of that the tube's mouth stands in the open): under the lower share of
 *     that cover a box as high as there is room for (sections.js fitUnder),
 *     and where not even its clearance fits, nothing is built (the terrain
 *     stays whole; the line, a tunnel's, is not drawn on it);
 *   - the floor between the portals is kept under the ground (underGround):
 *     the line between the portals' floors, but nowhere higher than leaves
 *     the collar's concrete and some soil (1 m; over a short tube the
 *     concrete it was fitted with) between its vault and the ground, past
 *     each portal's mouth; it dips no steeper than its kind climbs, eased. 5.17d ran it level from its portal, or linear between
 *     its two, under any ground: by Locarno a railway tunnel under the town
 *     stood up to 18 m out of it over 1.4 km, the road tunnel's 10 m;
 *   - at each portal: where the hillside's face is (the ground rising over
 *     the floor), and how far back the collar's concrete covers the vault
 *     where the ground is lower than it (as thin as the ground over a short
 *     tube leaves room for, so it never stands out of the road over an
 *     underpass).
 * The terrain is cut exactly along the whole bore (cuts.js, terrain.wgsl):
 * nothing of it is left inside a tube, whatever its tiles' detail.
 * Positions are metres in from the mapped portal (d), out of it negative.
 */

import { TUBE_END, TUBE_POINT } from './groups.js';
import { outlineAt, fitUnder, ROOF } from './sections.js';

/* Whole tunnels at most this long must fit under the ground over them; longer ones run through mountains. */
export const SHORT = 300;
/* The ground along a portal's axis (through the bore's middle), a metre apart, this far out of it and in. */
const AXIS_OUT = 12, AXIS_IN = 12;
/* The ground along the tube: at each of its points along a short tube (every 2 m), else every ALONG_NEAR metres within
 * NEAR_PORTAL of a portal (from the finest tiles) and every ALONG_FAR beyond (from tiles of FAR_LEVEL at the finest: a
 * long tube's middle need not load hundreds of the finest). */
const ALONG_NEAR = 4, ALONG_FAR = 8, NEAR_PORTAL = 120;
export const FAR_LEVEL = 15;
/* The face: where the ground first rises FACE_LEVEL over the floor and stays so FACE_RUN metres on; looked for up to
 * FACE_FARTHEST in. */
const FACE_LEVEL = 0.3, FACE_RUN = 3, FACE_FARTHEST = 10;
/* The collar's concrete over the vault (its outer side, COLLAR_WIDTH thick, or over a short tube as thick as the
 * ground over it leaves OVER_SHELL above it, SHELL_THINNEST at the least) runs back until the ground is OVER_SHELL
 * over it and stays so OVER_RUN metres (its closed end buried), SHELL_LEAST at the least. */
export const COLLAR_WIDTH = 0.8;
const OVER_SHELL = 0.2, OVER_RUN = 4, SHELL_THINNEST = 0.25, SHELL_LEAST = 3;
/* The cover a short tube must fit under: its lower share's, between where each portal's ground first has room for
 * the least tunnel of its kind. */
const COVER_SHARE = 0.1;
/* Under the ground (underGround): past a portal's mouth (where the ground over the floor first leaves room for the
 * vault and its cover, at most MOUTH_MOST in), the vault and its cover under the ground; the steepest a floor dips
 * (its kind's grade, at most DIP_MOST for a road and DIP_PATH for a path); grade changes eased over EASE metres, the
 * floor first held EASE_MARGIN lower where the ground asks it down (the easing lifts a dip's bottom by about that). */
const MOUTH_MOST = 30, DIP_MOST = 0.12, DIP_PATH = 0.18, EASE = 10, EASE_MARGIN = 0.3;
/* Where a tube starts (5.17f, his words: "make sure nothing goes above the ground"): from each portal in, the first
 * place where the ground covers its vault, its collar's concrete and OVER_SHELL of soil, and keeps covering them
 * COVER_RUN on, looked for along the whole tube (its samples are dense near its portals); short of it the road runs on
 * into the hill in an open cutting at the floor (tunnels.js, vector/portals.js). Nowhere, or less than TUBE_LEAST left
 * between two such starts: no tube at all, the cutting the whole way. (The first build looked 120 m in at most and
 * started the tube there anyway: on the rig's stand-in, whose portals stand on low ground, its vault stood out.) */
const COVER_RUN = 4, TUBE_LEAST = 3;
const PATHS = new Set(['path', 'footway', 'steps', 'track', 'trail', 'via_ferrata', 'cycleway']);

/**
 * Where the ground is wanted for a tube's fit: along each portal's axis (from AXIS_OUT out to AXIS_IN in, a metre
 * apart, through the bore's middle) and along the whole tube (the bore's middle: each point of a short one, else
 * every ALONG_NEAR metres near a portal and ALONG_FAR beyond, with its ends).
 * @param tube   the near tube (groups.js)
 * @param short  whether its whole tunnel is short (it must fit under the ground)
 * @returns { lonlat: Float64Array [lon, lat, …], axes: [each end's first sample along its axis; -1 none], first (the
 *            tube points' first sample), ks: Int32Array (the tube point of each of those), under: per sample the
 *            level its ground tile is under (Infinity: the finest) }
 */
export function fitPoints(tube, short = false) {
  const p = tube.points, n = p.length / TUBE_POINT, L = tube.length;
  const out = [], axes = [-1, -1], under = [];
  for (let e = 0; e < 2; e++) {
    const end = tube.ends[e];
    if (end.type !== TUBE_END.PORTAL) continue;
    const { inX, inY, rX, rY, offset } = wayIn(tube, e);
    const m = metresLon(end.lat);
    axes[e] = out.length / 2;
    for (let d = -AXIS_OUT; d <= AXIS_IN; d++) {
      out.push(end.lon + (inX * d + rX * offset) / m, end.lat + (inY * d + rY * offset) / M_LAT);
      under.push(Infinity);
    }
  }
  const first = out.length / 2, ks = [];
  const portalA = tube.ends[0].type === TUBE_END.PORTAL, portalB = tube.ends[1].type === TUBE_END.PORTAL;
  let last = -Infinity;
  for (let k = 0; k < n; k++) {
    const s = p[k * TUBE_POINT + 2];
    const near = (portalA && s <= NEAR_PORTAL) || (portalB && L - s <= NEAR_PORTAL);
    if (!short && k !== 0 && k !== n - 1 && s - last < (near ? ALONG_NEAR : ALONG_FAR) - 1e-6) continue;
    last = s;
    const m = middleOf(p, n, k);
    out.push(m[0], m[1]);
    under.push(near || short ? Infinity : FAR_LEVEL + 1);
    ks.push(k);
  }
  return { lonlat: Float64Array.from(out), axes, first, ks: Int32Array.from(ks), under };
}

/**
 * The tube fitted to the ground.
 *   tube       the near tube
 *   floorAt    (s along it) => its floor by its portals (the line between them; sections.js floorProfile)
 *   section    its cross-section by the rules (sections.js sectionFor)
 *   clearance  the least it needs inside (sections.js clearanceFor)
 *   kind       its kind (the schema's: its grade and id)
 *   short      whether its whole tunnel is short
 *   slopes     per end: its portal's approach's rise a metre out
 *   pts        fitPoints' answer for it; heights: the ground at each (NaN not known; null: none known)
 *   starts     per end: metres in its tube starts at most (tunnels.js trimStarts: the ground as cut covers it there),
 *              or undefined
 * @returns { section (null: no room for it, not built), cover (a short tube's, metres; NaN none), collarWidth (its
 *          collar's concrete's thickness, metres), floorAt (s => the floor kept under the ground), floor: { ss, zs,
 *          dipped (metres the floor went under the line between the portals at most), out (metres of the tube whose
 *          vault stands out of the ground past its mouths) }, ends: per end null (not a portal) or { face, collar (0:
 *          the tube starts at the mapped portal), start (metres in it starts: where the ground covers it), shell (from
 *          the collar), rise, offset, outline }, open (no tube at all: the cutting the whole way) }
 */
export function fitTube({ tube, floorAt, section, clearance, kind = null, short, slopes = [0, 0], pts, heights, starts = [] }) {
  const p = tube.points, L = tube.length;
  // The ground along the tube, in order: metres along, the ground, how wide the bore is there.
  const ss = [], gs = [], wides = [];
  if (heights && pts) {
    for (let i = 0; i < pts.ks.length; i++) {
      const o = pts.ks[i] * TUBE_POINT;
      ss.push(p[o + 2]);
      gs.push(heights[pts.first + i]);
      wides.push((section.half + p[o + 4]) / section.half);
    }
  }
  let cover = NaN, sec = section;
  if (short && ss.length) {
    const cs = ss.map((s, i) => gs[i] - floorAt(s)), known = [];
    for (let i = 0; i < cs.length; i++) if (Number.isFinite(cs[i])) known.push(i);
    if (known.length) {
      const kss = known.map((i) => ss[i]), kcs = known.map((i) => cs[i]), n = kcs.length;
      // From each portal in, where the ground first has room over the least tunnel of its kind (its clearance and
      // ROOF) and keeps it: short of that the portal's mouth stands in the open; between, the ground must hold it.
      const least = clearance + ROOF;
      const reach = (k0, step) => {
        for (let k = k0; k >= 0 && k < n; k += step) {
          if (!(kcs[k] >= least)) continue;
          let ok = true;
          for (let j = k + step; j >= 0 && j < n && Math.abs(kss[j] - kss[k]) <= OVER_RUN; j += step) if (!(kcs[j] >= least)) { ok = false; break; }
          if (ok) return k;
        }
        return -1;
      };
      const a = tube.ends[0].type === TUBE_END.PORTAL ? reach(0, 1) : 0, b = tube.ends[1].type === TUBE_END.PORTAL ? reach(n - 1, -1) : n - 1;
      if (a < 0 || b < 0 || a > b) return { section: null, cover: Math.max(...kcs), collarWidth: COLLAR_WIDTH, ends: [null, null] };
      const middle = kcs.slice(a, b + 1).sort((x, y) => x - y);
      cover = middle[Math.floor(COVER_SHARE * (middle.length - 1))];
      sec = fitUnder(sec, cover, clearance);
      if (!sec) return { section: null, cover, collarWidth: COLLAR_WIDTH, ends: [null, null] };
    }
  }
  // The collar's concrete over a short tube: under the ground over it (a road over an underpass stays whole).
  const crown = outlineAt(sec).crown;
  const collarWidth = Number.isFinite(cover) ? Math.min(COLLAR_WIDTH, Math.max(SHELL_THINNEST, cover - crown - OVER_SHELL)) : COLLAR_WIDTH;
  // The floor under the ground.
  const fixed = [tube.ends[0].type === TUBE_END.PORTAL, tube.ends[1].type === TUBE_END.PORTAL];
  const dipMost = PATHS.has(kind?.id) ? DIP_PATH : tube.family === 2 ? 1 : DIP_MOST;
  const grade = Math.max(0.01, Math.min(kind?.grade ?? 0.06, dipMost));
  const floor = ss.length >= 2
    ? underGround({ ss, gs, base: ss.map(floorAt), crowns: wides.map((w) => outlineAt(sec, w).crown), fixed, grade,
      cover: collarWidth + (Number.isFinite(cover) ? 0 : OVER_SHELL), length: L })
    : null;
  const fitted = floor ? profileOf(floor.ss, floor.zs) : floorAt;
  const ends = [0, 1].map((e) => (tube.ends[e].type === TUBE_END.PORTAL
    ? portalFit(tube, e, fitted, sec, slopes[e] ?? 0, collarWidth, pts, heights) : null));
  // Where each portal's tube starts: the ground over all of it (see the top), its concrete from there.
  const crownTop = (s) => outlineAt(sec, wideAt(ss, wides, s)).crown + collarWidth + OVER_SHELL;
  for (const e of [0, 1]) {
    const f = ends[e];
    if (!f) continue;
    f.start = Math.min(coverStart(tube, e, fitted, crownTop, ss, gs, pts, heights), starts[e] ?? Infinity);
    f.shell = Math.max(SHELL_LEAST, f.shell - f.start);
  }
  // None left between them: the cutting runs the whole way (no tube is built).
  let open = false;
  if (ends[0] && ends[1] && ends[0].start + ends[1].start > L - TUBE_LEAST) {
    open = true;
    ends[0].start = L;
    ends[1].start = 0;
  }
  // A short tube's concrete runs the whole way (where the ground over it dips under its roof, the roof shows, not
  // the tunnel through it from above); two collars' outer sides along a short tube end where they would meet.
  if (Number.isFinite(cover)) for (const f of ends) if (f) f.shell = L + f.collar;
  if (ends[0] && ends[1] && !open) {
    // (Along the tube as built: from where it starts at each portal.)
    const a = ends[0].shell - ends[0].collar, b = ends[1].shell - ends[1].collar, built = L - ends[0].start - ends[1].start;
    if (a + b > built) {
      const meet = (built * a) / (a + b);
      ends[0].shell = meet + ends[0].collar;
      ends[1].shell = built - meet + ends[1].collar;
    }
  }
  return { section: sec, cover, collarWidth, floorAt: fitted, floor, ends, open };
}

/* How wide the bore is at s (the samples' ratios, the nearest; 1 where none). */
function wideAt(ss, wides, s) {
  if (!ss.length) return 1;
  let best = 0;
  for (let i = 1; i < ss.length; i++) if (Math.abs(ss[i] - s) < Math.abs(ss[best] - s)) best = i;
  return wides[best];
}

/* Metres from portal e in where the ground first covers the tube (crownTop(s): the height over the floor it must
 * reach there) and keeps covering it COVER_RUN on (ground not known counts as covering it); its length where it
 * covers it nowhere. The portal's axis samples (every metre AXIS_IN in), then those along the tube. */
function coverStart(tube, e, floorAt, crownTop, ss, gs, pts, heights) {
  const L = tube.length, list = [];
  const at = (d) => (e ? L - d : d);
  if (pts && heights && pts.axes[e] >= 0) {
    for (let d = 0; d <= AXIS_IN; d++) list.push([d, heights[pts.axes[e] + AXIS_OUT + d]]);
  }
  for (let i = 0; i < ss.length; i++) {
    const d = e ? L - ss[i] : ss[i];
    if (d > AXIS_IN) list.push([d, gs[i]]);
  }
  list.sort((a, b) => a[0] - b[0]);
  // How far the ground stands over what it must cover (NaN: not known, taken as covered).
  const margin = (k) => list[k][1] - floorAt(at(list[k][0])) - crownTop(at(list[k][0]));
  const covered = (k) => !(margin(k) < 0);
  for (let k = 0; k < list.length; k++) {
    if (!covered(k)) continue;
    let keeps = true;
    for (let j = k + 1; j < list.length && list[j][0] - list[k][0] <= COVER_RUN; j++) if (!covered(j)) { keeps = false; break; }
    if (!keeps) continue;
    if (k === 0) return list[0][0];
    // Where the ground rises through it between the last sample short of it and this one, and half a metre on (the
    // ground between two samples may lie lower than the line between them).
    const a = margin(k - 1), b = margin(k), d0 = list[k - 1][0], d1 = list[k][0];
    const cross = Number.isFinite(a) && Number.isFinite(b) && b > a ? d0 + ((d1 - d0) * -a) / (b - a) : d1;
    return Math.min(d1, cross + 0.5);
  }
  return list.length ? L : 0;
}

/**
 * A floor kept under the ground (see the top). Exported for the tests.
 *   ss, gs     metres along the tube of its samples (in order, the first at 0 and the last at its length) and the ground
 *              there (NaN: not known)
 *   base       the floor by its portals there
 *   crowns     the vault's height over the floor there
 *   fixed      per end: whether it is a portal (its floor stays; another end's floor may go lower)
 *   grade      the steepest the floor may dip, rise a metre
 *   cover      metres of ground the vault keeps over it
 * @returns { ss, zs: Float64Array (the floor at each sample), gs, crowns (as given), dipped (metres it went under the
 *          line between the portals at most), out (metres of it whose vault stays out of the ground past the mouths) }
 */
export function underGround({ ss, gs, base, crowns, fixed, grade, cover, length }) {
  const n = ss.length, zs = Float64Array.from(base);
  // The highest the floor may be: past each portal's mouth, its vault `cover` under the ground.
  const upper = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) if (Number.isFinite(gs[i])) upper[i] = gs[i] - crowns[i] - cover;
  for (let e = 0; e < 2; e++) {
    if (!fixed[e]) continue;
    // The mouth: from the portal in while the ground over the floor has not room for the vault and its cover yet.
    for (let j = 0; j < n; j++) {
      const i = e ? n - 1 - j : j, d = e ? length - ss[i] : ss[i];
      if (d > MOUTH_MOST) break;
      if (!Number.isFinite(upper[i])) continue;
      if (!(upper[i] < base[i])) break;
      upper[i] = Infinity;
    }
  }
  // How far under the line between the portals each floor must be (held EASE_MARGIN lower for the easing; a portal's
  // own floor stays), and the least that is, a taut string under those (their lower convex hull: straight stretches
  // of steady grade, as a tunnel is built, not a floor following every rise and fall of the ground over it; the
  // line's own shape, a table's culmination, kept).
  const need = new Float64Array(n);
  for (let i = 0; i < n; i++) need[i] = upper[i] < base[i] ? upper[i] - base[i] - EASE_MARGIN : 0;
  if (fixed[0]) need[0] = 0;
  if (fixed[1]) need[n - 1] = 0;
  const dip = lowerHull(ss, need);
  // Never further under the line between the portals than it can dip away from it at the grade from the nearer portal
  // (the floor goes where it can; a vault left out of the ground there is covered by the collar's concrete).
  const lowest = new Float64Array(n).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    const d = Math.min(fixed[0] ? ss[i] - ss[0] : Infinity, fixed[1] ? ss[n - 1] - ss[i] : Infinity);
    if (Number.isFinite(d)) lowest[i] = base[i] - grade * d;
  }
  let dipped = 0;
  for (let i = 0; i < n; i++) dipped = Math.max(dipped, -dip[i]);
  if (dipped > 1e-3) {
    // Eased where its grade changes: a moving average over EASE (twice: a tent), its window shorter towards the
    // ends, which stay.
    for (let pass = 0; pass < 2; pass++) {
      const src = Float64Array.from(dip);
      let a = 0, b = 0, sum = 0;
      for (let i = 1; i < n - 1; i++) {
        const half = Math.min(EASE / 2, ss[i] - ss[0], ss[n - 1] - ss[i]);
        while (b < n && ss[b] <= ss[i] + half + 1e-9) sum += src[b++];
        while (a < b && ss[a] < ss[i] - half - 1e-9) sum -= src[a++];
        if (b > a) dip[i] = sum / (b - a);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    // Over the lowest a portal lets it dip to, and nowhere over its bound where it can be under it.
    zs[i] = Math.max(base[i] + dip[i], lowest[i]);
    zs[i] = Math.min(zs[i], base[i], Math.max(upper[i], lowest[i]));
  }
  let out = 0;
  for (let i = 1; i < n; i++) {
    const over = Number.isFinite(upper[i]) && zs[i] > upper[i] + 1e-6;
    if (over) out += ss[i] - ss[i - 1];
  }
  return { ss: Float64Array.from(ss), zs, gs: Float64Array.from(gs), crowns: Float64Array.from(crowns), dipped, out };
}

/* The lower convex hull of points (xs ascending, ys) taken at each x: the highest convex function under them all. */
function lowerHull(xs, ys) {
  const n = xs.length, hull = [];
  for (let i = 0; i < n; i++) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2], b = hull[hull.length - 1];
      // Not turning up (left) at b: b is over the line from a to i.
      if ((xs[b] - xs[a]) * (ys[i] - ys[a]) - (ys[b] - ys[a]) * (xs[i] - xs[a]) <= 0) hull.pop();
      else break;
    }
    hull.push(i);
  }
  const out = new Float64Array(n);
  let h = 0;
  for (let i = 0; i < n; i++) {
    while (h + 1 < hull.length - 1 && xs[hull[h + 1]] <= xs[i]) h++;
    const a = hull[h], b = hull[Math.min(h + 1, hull.length - 1)];
    out[i] = b === a || xs[b] - xs[a] < 1e-9 ? ys[a] : ys[a] + ((ys[b] - ys[a]) * (xs[i] - xs[a])) / (xs[b] - xs[a]);
  }
  return out;
}

/** A floor along a tube from its samples (metres along, heights): linear between them, level beyond. */
export function profileOf(ss, zs) {
  const n = ss.length;
  let k = 0;
  return (s) => {
    if (!(n > 1)) return zs[0];
    if (s <= ss[0]) return zs[0];
    if (s >= ss[n - 1]) return zs[n - 1];
    // Most calls ask near the last one (the mesh's points in order, a body walking along).
    if (!(ss[k] <= s && s <= ss[k + 1])) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ss[mid] <= s) lo = mid; else hi = mid; }
      k = lo;
    }
    const span = ss[k + 1] - ss[k];
    return span > 1e-9 ? zs[k] + ((zs[k + 1] - zs[k]) * (s - ss[k])) / span : zs[k];
  };
}

/* One portal's fit (see the top). */
function portalFit(tube, e, floorAt, sec, slope, collarWidth, pts, heights) {
  const p = tube.points, n = p.length / TUBE_POINT, L = tube.length, o = e ? (n - 1) * TUBE_POINT : 0;
  const way = wayIn(tube, e);
  const outline = outlineAt(sec, (sec.half + p[o + 4]) / sec.half);
  const crown = outline.crown;
  const fallback = { face: 0, collar: 0, shell: Math.min(L, SHELL_LEAST), rise: slope, offset: way.offset, outline };
  if (!heights || pts.axes[e] < 0) return fallback;

  // The cover (ground over the floor) along the axis and on along the tube; out of the portal, the ground over the
  // approach's line.
  const sAt = (d) => (e ? L - d : d), floorOut = floorAt(sAt(0));
  const ds = [], cs = [];
  for (let i = 0; i <= AXIS_OUT + AXIS_IN; i++) {
    const d = i - AXIS_OUT;
    if (d > L) break;
    ds.push(d);
    cs.push(heights[pts.axes[e] + i] - (d < 0 ? floorOut - slope * d : floorAt(sAt(d))));
  }
  const along = [];
  for (let i = 0; i < pts.ks.length; i++) {
    const s = p[pts.ks[i] * TUBE_POINT + 2], d = e ? L - s : s;
    if (d > AXIS_IN) along.push([d, heights[pts.first + i] - floorAt(s)]);
  }
  along.sort((a, b) => a[0] - b[0]);
  for (const [d, c] of along) { ds.push(d); cs.push(c); }
  if (!cs.some(Number.isFinite)) return fallback;

  // The face: from the portal in, where the ground rises FACE_LEVEL over the floor and stays so.
  let face = FACE_FARTHEST;
  for (let i = AXIS_OUT; i + FACE_RUN - 1 < ds.length && ds[i] <= FACE_FARTHEST; i++) {
    let over = true;
    for (let j = i; j < i + FACE_RUN; j++) if (!(cs[j] > FACE_LEVEL)) { over = false; break; }
    if (over) { face = ds[i]; break; }
  }
  // Where the ground first stays over a height for OVER_RUN metres, from the portal in (Infinity: nowhere). (Over a
  // fitted box the ground at its cover is exactly the collar's buried top: a micrometre's leeway.)
  const stays = (height) => {
    const level = height - 1e-6;
    for (let i = 0; i < ds.length; i++) {
      if (ds[i] < 0 || !(cs[i] >= level)) continue;
      let ok = true;
      for (let j = i + 1; j < ds.length && ds[j] <= ds[i] + OVER_RUN; j++) if (!(cs[j] >= level)) { ok = false; break; }
      if (ok) return ds[i];
    }
    return Infinity;
  };
  // The collar's outer side: until the ground is over it (no farther than the ground is known).
  const shell = Math.max(Math.min(SHELL_LEAST, L), Math.min(stays(crown + collarWidth + OVER_SHELL), L, ds[ds.length - 1]));
  return { face, collar: 0, shell, rise: slope, offset: way.offset, outline };
}

/* The way in at an end (east, north), right of it, and the bore's middle there right of the line (as the way in runs). */
function wayIn(tube, e) {
  const end = tube.ends[e], p = tube.points, o = e ? p.length - TUBE_POINT : 0;
  const inX = -end.dirX, inY = -end.dirY;
  return { inX, inY, rX: inY, rY: -inX, offset: e ? -p[o + 3] : p[o + 3] };
}

/* The bore's middle at point k of a spine (TUBE_POINT doubles a point): its offset right of the line as it runs. */
function middleOf(p, n, k) {
  const a = Math.max(0, k - 1) * TUBE_POINT, b = Math.min(n - 1, k + 1) * TUBE_POINT, o = k * TUBE_POINT;
  const m = metresLon(p[o + 1]);
  const dx = (p[b] - p[a]) * m, dy = (p[b + 1] - p[a + 1]) * M_LAT, l = Math.hypot(dx, dy) || 1, off = p[o + 3];
  return [p[o] + (off * dy) / l / m, p[o + 1] - (off * dx) / l / M_LAT];
}

const M_LAT = 111132;
function metresLon(lat) {
  return 111320 * Math.cos((lat * Math.PI) / 180);
}
