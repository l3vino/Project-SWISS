/* junctions.js — railway floors through junctions (Stage 5.18h).
 *
 * His words on 5.18g: "what is this ramp? it's a train... it should defenetly not be that steep". Each tube's floor ran
 * only between its own two ends (sections.js floorProfile), and a tube opening into another took that one's height
 * there (tunnels.js #joinedFloor): a junction partway along a tube never bent its floor. By Giubiasco the Ceneri base
 * tunnel's west tube leaves its portal onto a viaduct 5.9 m over the east tube's, kept that height to the junction,
 * and the 134 m crossover between the tubes climbed it alone: 4.3%, where AlpTransit's flat route climbs 1.25% at most.
 *
 * So the railway tubes joined to each other are taken together: each tube's ends and the points along it where
 * another's JOIN end opens into it, or where its own opens into another partway along its tunnel (its stations), are
 * the nodes, the stretches of tube between them the links (as long as they are), the portals' floors (their viaducts'
 * decks among them) fixed. Every other node takes the average
 * of its neighbours' heights, each weighted by one over how far away it is (Gauss–Seidel until it moves under a
 * millimetre): the heights that make the grades along every way between two portals straight and as even as they can
 * be (the least squares of the grades). An end with nothing fixed beyond it runs on level. The same junction now
 * shares its 5.9 m between the west tube and the crossover, each about 0.9%.
 */

/* Iterations at most, and the millimetres a node may still move when they stop. */
const ROUNDS = 400, STILL = 0.001;
/* Metres from a tube's end within which a point along it is that end. */
const END_NEAR = 1;

/* Sets of ids, each named by one of them (union–find). */
function unionFind() {
  const parent = new Map();
  const find = (a) => {
    if (!parent.has(a)) parent.set(a, a);
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); }
    return a;
  };
  const join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  return { find, join };
}

/**
 * The heights through a railway network's junctions.
 * @param tubes  [{ key, length, fixed: [h0, h1] }]: metres; a portal's floor where it is known, NaN otherwise
 * @param links  [{ from, at, to, s }]: the point `at` metres along tube `from` (an end of it, or partway along where its
 *               tunnel's tube opens into another: 5.18h, a tube is placed by its whole tunnel) lies in tube `to`, `s`
 *               metres along it
 * @returns Map key → { ends: [h0, h1], stations: [[s, h], …] sorted by s }, for each tube of a network with a fixed
 *          height (where none is known, no tube of it is in the map)
 */
export function railFloors(tubes, links) {
  const byKey = new Map(tubes.map((t) => [t.key, t]));
  // Nodes: each tube's two ends and the points along it the links name (its stations); the two points a link joins
  // are one node (`same`).
  const same = unionFind();
  const along = new Map(tubes.map((t) => [t.key, [[0, `${t.key}|0`], [t.length, `${t.key}|1`]]]));
  const pointOf = (t, s) => {
    const c = Math.min(t.length, Math.max(0, s));
    if (c <= END_NEAR) return `${t.key}|0`;
    if (c >= t.length - END_NEAR) return `${t.key}|1`;
    const id = `${t.key}@${c.toFixed(1)}`, list = along.get(t.key);
    if (!list.some(([, other]) => other === id)) list.push([c, id]);
    return id;
  };
  for (const l of links) {
    const a = byKey.get(l.from), b = byKey.get(l.to);
    if (a && b && a !== b) same.join(pointOf(a, l.at), pointOf(b, l.s));
  }
  // Links between the nodes along each tube, nearest first.
  const edges = new Map();
  const link = (a, b, w) => {
    if (a === b) return;
    if (!edges.has(a)) edges.set(a, []);
    if (!edges.has(b)) edges.set(b, []);
    edges.get(a).push([b, w]); edges.get(b).push([a, w]);
  };
  for (const [, list] of along) {
    list.sort((p, q) => p[0] - q[0]);
    for (let i = 1; i < list.length; i++) link(same.find(list[i - 1][1]), same.find(list[i][1]), 1 / Math.max(1, list[i][0] - list[i - 1][0]));
  }
  // The fixed heights (a node fixed twice, two portals as one: their mean).
  const fixed = new Map();
  for (const t of tubes) {
    for (let e = 0; e < 2; e++) {
      const v = t.fixed?.[e];
      if (!Number.isFinite(v)) continue;
      const id = same.find(`${t.key}|${e}`), f = fixed.get(id);
      fixed.set(id, f ? { sum: f.sum + v, n: f.n + 1 } : { sum: v, n: 1 });
    }
  }
  // Each network (its nodes linked), and whether anything in it is fixed.
  const nets = unionFind();
  for (const [a, list] of edges) for (const [b] of list) nets.join(a, b);
  const anchored = new Set();
  for (const id of fixed.keys()) anchored.add(nets.find(id));
  const h = new Map();
  for (const id of edges.keys()) {
    if (!anchored.has(nets.find(id))) continue;
    const f = fixed.get(id);
    h.set(id, f ? f.sum / f.n : NaN);
  }
  // A start: each loose node the mean of the fixed ones of its network.
  const mean = new Map();
  for (const [id, f] of fixed) { const r = nets.find(id), m = mean.get(r) ?? { sum: 0, n: 0 }; m.sum += f.sum / f.n; m.n++; mean.set(r, m); }
  for (const [id, v] of h) if (!Number.isFinite(v)) { const m = mean.get(nets.find(id)); h.set(id, m.sum / m.n); }
  // Gauss–Seidel: each loose node the weighted mean of its neighbours.
  for (let round = 0; round < ROUNDS; round++) {
    let moved = 0;
    for (const [id, list] of edges) {
      if (fixed.has(id) || !h.has(id)) continue;
      let sw = 0, sh = 0;
      for (const [b, w] of list) { sw += w; sh += w * h.get(b); }
      if (!(sw > 0)) continue;
      const v = sh / sw;
      moved = Math.max(moved, Math.abs(v - h.get(id)));
      h.set(id, v);
    }
    if (moved < STILL) break;
  }
  // Per tube: its ends and its stations.
  const out = new Map();
  for (const t of tubes) {
    const e0 = `${t.key}|0`, e1 = `${t.key}|1`;
    if (!h.has(same.find(e0))) continue;
    const stations = along.get(t.key).filter(([, id]) => id !== e0 && id !== e1)
      .map(([s, id]) => [s, h.get(same.find(id))]).filter(([, v]) => Number.isFinite(v));
    out.set(t.key, { ends: [h.get(same.find(e0)), h.get(same.find(e1))], stations });
  }
  return out;
}

/** A floor through a tube's ends and its stations, straight between them (metres along → height). */
export function stationFloor(length, ends, stations) {
  const pts = [];
  if (Number.isFinite(ends[0])) pts.push([0, ends[0]]);
  for (const p of stations) pts.push(p);
  if (Number.isFinite(ends[1])) pts.push([length, ends[1]]);
  pts.sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  return (s) => {
    if (s <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (s <= pts[i][0]) {
        const [s0, h0] = pts[i - 1], [s1, h1] = pts[i];
        return s1 > s0 ? h0 + ((h1 - h0) * (s - s0)) / (s1 - s0) : h1;
      }
    }
    return pts[pts.length - 1][1];
  };
}

/* The steepest a railway's floor may climb (5.18h, for the probe's check): AlpTransit's flat route 12.5 per mille (the
 * base tunnels: sections.js section 'tube'), a standard-gauge line 28 (the Gotthard line's ramps were built at up to
 * 28, the Lötschberg's at 27: 25 flagged the old Ceneri line's tunnels, 2.1–2.5% as measured), narrow gauge 70 (the
 * Bernina's adhesion); rack railways and funiculars none. */
export function gradeLimit(kind, entry) {
  const id = kind?.id ?? '';
  if (id === 'rack' || id === 'rack_rail' || id === 'funicular') return Infinity;
  if (id === 'narrow_gauge' || entry?.section === 'metre') return 0.07;
  if (entry?.section === 'tube') return 0.0125;
  return 0.028;
}

/** The steepest grade of a floor over a tube's length (sampled every `step` metres). */
export function steepest(floorAt, length, step = 10) {
  let most = 0;
  for (let s = 0; s + step <= length; s += step) most = Math.max(most, Math.abs(floorAt(s + step) - floorAt(s)) / step);
  return most;
}
