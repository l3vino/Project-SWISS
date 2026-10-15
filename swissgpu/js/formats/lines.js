/* lines.js — lines a data source models as tubes, back to lines.
 *
 * swissTLM3D's 3D tiles draw every cable car and material ropeway as a
 * closed tube around its line: a many-sided cylinder of the feature's
 * BufferRadius (0.5 or 1 m) for each straight segment, with flat caps, and a
 * small sphere at each bend. Drawn like that a rope looks a metre thick, and
 * as a solid it stood as an invisible wall. The line is all that is needed:
 * its corners are the mast tops ("the highest points of the masts joined by
 * straight lines", swissTLM3D catalogue 2.4), so the ropes can be drawn as
 * thin lines sagging between them, and the masts as pylons.
 *
 * tubeAxes      the polylines a tube mesh is wrapped around. Every vertex of
 *               a tube lies within its radius of a corner of the line (the
 *               end rings of each cylinder and the sphere at each bend all
 *               sit on one), so the vertices gather into one cluster per
 *               corner; the cylinders' long side triangles join
 *               neighbouring corners; following those joins from an end
 *               gives the corners in order, each at the middle of its
 *               cluster's box (rings and spheres are symmetric about their
 *               centre; a plain mean would lean towards a cap's fan).
 * ropeGeometry  ropes and pylons along those lines, in a style per kind of
 *               line (how many ropes and how far apart, how thick, what the
 *               masts look like). Every span between two corners hangs as a
 *               parabola a few per cent of its length deep at the middle
 *               (for a rope this slack, a catenary to within millimetres),
 *               cut into short straight pieces; every inner corner gets a
 *               pylon, its crossarm square to the line. A pylon is made of
 *               steel members, drawn exactly like rope pieces (thin, lit as
 *               cylinders, a pixel wide at least and fading with distance as
 *               anti-aliased wires do): a lattice tower of four legs with
 *               cross-bracing on every face, wider towards the ground, for
 *               aerial tramways and material ropeways; a single tubular
 *               pole for gondolas, chair and drag lifts. The members reach
 *               PYLON_DEPTH below the mast top, deep enough for any real
 *               mast; the terrain hides what is underground.
 *
 * Positions are local metres: x east, y north, z up.
 */

/* Rope pieces are about this long, and each span has this many at least
 * and at most. */
const PIECE = 8;
const PIECES = { min: 4, max: 64 };

/* Records, in floats: a rope piece (or a pylon's member) is two points and
 * its radius and shade; a pylon is its top, crossarm half-length, direction
 * along the line, half-width at the top and how much wider it gets per
 * metre down. */
export const ROPE_FLOATS = 8;
export const PYLON_FLOATS = 8;

/* Pylons: how far below the mast top they reach, where the crossarm hangs,
 * how tall a lattice panel is for its width, how long a pole piece is, and
 * the shade of steel. */
export const PYLON_DEPTH = 90;
const ARM_DROP = 0.35;
const PANEL = 1.1;
const POLE_PIECE = 15;
const STEEL = 0.3;

/**
 * The polylines a tube of `radius` traces.
 * @param positions  x, y, z of every vertex of the mesh
 * @param vertices   the tube's vertex numbers
 * @param triangles  the tube's triangles, three vertex numbers each
 * @returns [Float64Array x, y, z, ...] one per line, two corners at least
 */
export function tubeAxes(positions, vertices, triangles, radius) {
  const link = 2.1 * radius, link2 = link * link, inv = 1 / link;
  // Clusters: the vertex that started each, and the box around its
  // vertices. Each is filed under its seed's cell of a hash grid as wide as
  // the link, so a vertex need only look in the 27 cells around its own.
  const seeds = [], boxes = [], counts = [];
  const cells = new Map();
  let top = 0;
  for (const v of vertices) if (v > top) top = v;
  const cluster = new Int32Array(top + 1).fill(-1);
  const hash = (i, j, k) => ((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) | 0;
  let last = -1;
  for (const v of vertices) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    const ci = Math.floor(x * inv), cj = Math.floor(y * inv), ck = Math.floor(z * inv);
    // Neighbouring vertices mostly belong to the same corner: try its first.
    let found = -1;
    if (last >= 0) {
      const dx = seeds[last * 3] - x, dy = seeds[last * 3 + 1] - y, dz = seeds[last * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz <= link2) found = last;
    }
    for (let d = 0; d < 27 && found < 0; d++) {
      const list = cells.get(hash(ci + (d % 3) - 1, cj + (((d / 3) | 0) % 3) - 1, ck + ((d / 9) | 0) - 1));
      if (!list) continue;
      for (let m = 0; m < list.length; m++) {
        const c = list[m];
        const dx = seeds[c * 3] - x, dy = seeds[c * 3 + 1] - y, dz = seeds[c * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= link2) { found = c; break; }
      }
    }
    if (found < 0) {
      found = counts.length;
      seeds.push(x, y, z);
      boxes.push(x, y, z, x, y, z);
      counts.push(0);
      const k = hash(ci, cj, ck);
      const list = cells.get(k);
      if (list) list.push(found); else cells.set(k, [found]);
    }
    cluster[v] = found;
    const b = found * 6;
    if (x < boxes[b]) boxes[b] = x; if (y < boxes[b + 1]) boxes[b + 1] = y; if (z < boxes[b + 2]) boxes[b + 2] = z;
    if (x > boxes[b + 3]) boxes[b + 3] = x; if (y > boxes[b + 4]) boxes[b + 4] = y; if (z > boxes[b + 5]) boxes[b + 5] = z;
    counts[found]++;
    last = found;
  }

  // Joins between corners, from the triangles that span two of them.
  const n = counts.length;
  const next = Array.from({ length: n }, () => new Set());
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const a = cluster[triangles[t]] ?? -1, b = cluster[triangles[t + 1]] ?? -1, c = cluster[triangles[t + 2]] ?? -1;
    if (a < 0 || b < 0 || c < 0) continue;
    if (a !== b) { next[a].add(b); next[b].add(a); }
    if (b !== c) { next[b].add(c); next[c].add(b); }
    if (a !== c) { next[a].add(c); next[c].add(a); }
  }

  // Lines: from every end (a corner with one join), then whatever loops are left.
  const walked = new Set();
  const edge = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const walk = (start) => {
    const corners = [start];
    for (let cur = start; ;) {
      let to = -1;
      for (const m of next[cur]) if (!walked.has(edge(cur, m))) { to = m; break; }
      if (to < 0) break;
      walked.add(edge(cur, to));
      corners.push(to);
      cur = to;
    }
    return corners;
  };
  const lines = [];
  const take = (start) => {
    const corners = walk(start);
    if (corners.length < 2) return;
    const out = new Float64Array(corners.length * 3);
    corners.forEach((c, i) => {
      out[i * 3] = (boxes[c * 6] + boxes[c * 6 + 3]) / 2;
      out[i * 3 + 1] = (boxes[c * 6 + 1] + boxes[c * 6 + 4]) / 2;
      out[i * 3 + 2] = (boxes[c * 6 + 2] + boxes[c * 6 + 5]) / 2;
    });
    lines.push(out);
  };
  for (let c = 0; c < n; c++) if (next[c].size === 1) take(c);
  for (let c = 0; c < n; c++) {
    for (const m of next[c]) if (!walked.has(edge(c, m))) { take(c); break; }
  }
  return lines;
}

/**
 * Rope pieces and pylons along lines, appended to `out.ropes` and
 * `out.pylons` (plain arrays of numbers, ROPE_FLOATS and PYLON_FLOATS each).
 * @param style  { ropes, spacing, ropeRadius, shade, sag, mast: { width, taper, arm } | null }
 */
export function ropeGeometry(lines, style, out) {
  const ropes = Math.max(1, style.ropes ?? 1), spacing = style.spacing ?? 0;
  const radius = style.ropeRadius ?? 0.025, shade = style.shade ?? 0.05, sag = style.sag ?? 0.035;
  for (const line of lines) {
    const n = line.length / 3;
    // Square to the line at each corner, level: along the mean of the spans either side.
    const across = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = line[b * 3] - line[a * 3], dy = line[b * 3 + 1] - line[a * 3 + 1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      across[i * 2] = -dy;
      across[i * 2 + 1] = dx;
    }
    for (let r = 0; r < ropes; r++) {
      const off = ropes === 1 ? 0 : (r / (ropes - 1) - 0.5) * spacing;
      for (let i = 0; i + 1 < n; i++) {
        const ax = line[i * 3] + off * across[i * 2], ay = line[i * 3 + 1] + off * across[i * 2 + 1], az = line[i * 3 + 2];
        const bx = line[i * 3 + 3] + off * across[i * 2 + 2], by = line[i * 3 + 4] + off * across[i * 2 + 3], bz = line[i * 3 + 5];
        const chord = Math.hypot(bx - ax, by - ay, bz - az);
        const pieces = Math.min(PIECES.max, Math.max(PIECES.min, Math.ceil(chord / PIECE)));
        const depth = sag * chord;
        let px = ax, py = ay, pz = az;
        for (let k = 1; k <= pieces; k++) {
          const u = k / pieces;
          const qx = ax + (bx - ax) * u, qy = ay + (by - ay) * u, qz = az + (bz - az) * u - 4 * depth * u * (1 - u);
          out.ropes.push(px, py, pz, radius, qx, qy, qz, shade);
          px = qx; py = qy; pz = qz;
        }
      }
    }
    const mast = style.mast;
    if (!mast) continue;
    for (let i = 1; i + 1 < n; i++) {
      const arm = mast.arm ?? spacing / 2 + 0.6;
      out.pylons.push(line[i * 3], line[i * 3 + 1], line[i * 3 + 2], arm,
        across[i * 2 + 1], -across[i * 2], mast.width ?? 0.4, mast.taper ?? 0.02);
      pylonMembers(line[i * 3], line[i * 3 + 1], line[i * 3 + 2], across[i * 2], across[i * 2 + 1], arm, mast, out.members ??= []);
    }
  }
  return out;
}

/*
 * The steel of one pylon, as members (rope records) appended to `members`:
 * its crossarm, then a lattice tower (legs and X-bracing on each face, in
 * panels about as tall as the tower is wide there) or a tubular pole made
 * of pieces each a little wider than the one above.
 * @param x, y, z     the mast top
 * @param ax, ay      square to the line, level (the crossarm's direction)
 * @param arm         the crossarm's half-length
 * @param mast        { kind: 'lattice' | 'pole', width (half-width at the top),
 *                    taper (more half-width per metre down), leg, brace (radii) }
 */
function pylonMembers(x, y, z, ax, ay, arm, mast, members) {
  const lx = ay, ly = -ax;                     // along the line, level
  const w0 = mast.width ?? 0.4, taper = mast.taper ?? 0.02;
  const top = z - ARM_DROP;
  const add = (x0, y0, z0, x1, y1, z1, r) => members.push(x0, y0, z0, r, x1, y1, z1, STEEL);
  // The crossarm carries the ropes, square to the line.
  add(x - ax * arm, y - ay * arm, top, x + ax * arm, y + ay * arm, top, mast.arm_radius ?? Math.max(0.08, w0 * 0.25));
  if (mast.kind !== 'lattice') {
    for (let d = 0; d < PYLON_DEPTH; d += POLE_PIECE) {
      const e = Math.min(PYLON_DEPTH, d + POLE_PIECE);
      add(x, y, top - d, x, y, top - e, w0 + taper * (d + e) / 2);
    }
    return;
  }
  // Corner k of the square section `d` metres below the crossarm.
  const SX = [1, 1, -1, -1], SY = [1, -1, -1, 1];
  const corner = (k, d) => {
    const h = w0 + taper * d;
    return [x + (lx * SX[k] + ax * SY[k]) * h, y + (ly * SX[k] + ay * SY[k]) * h, top - d];
  };
  const leg = mast.leg ?? 0.06, brace = mast.brace ?? leg * 0.5;
  for (let k = 0; k < 4; k++) add(...corner(k, 0), ...corner(k, PYLON_DEPTH), leg);
  for (let d = 0; d < PYLON_DEPTH;) {
    const e = Math.min(PYLON_DEPTH, d + PANEL * 2 * (w0 + taper * d));
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      add(...corner(k, d), ...corner(j, e), brace);
      add(...corner(j, d), ...corner(k, e), brace);
      add(...corner(k, d), ...corner(j, d), brace);
    }
    d = e;
  }
}
