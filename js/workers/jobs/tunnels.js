/* tunnels.js — the tunnels' jobs (5.19a: on the tunnels' own thread, workers/tunnels.js, which has the C core; up to
 * 5.18b on the decode threads). engine/tunnels/tunnels.js asks for them through its scheduler client.
 */

import { vectorBytes } from '../../core/net.js';
import { exactCopy } from '../../core/buffer-pool.js';
import { decodeVectorTile, schemaKinds } from '../../formats/vector-tile.js';
import { tunnelRuns } from '../../engine/tunnels/runs.js';
import { tubesFrom, TUBE_POINT } from '../../engine/tunnels/groups.js';
import { traceTunnel, placeOn, tileOf, TRACE_ZOOM } from '../../engine/tunnels/trace.js';
import { buildTunnelMesh } from '../../engine/tunnels/mesh.js';
import { cacheGet, cachePut } from '../index-cache.js';

/* Metres between the points of a traced tunnel kept between sessions. */
const KEEP_STEP = 10;

/**
 * The tunnels' jobs by name, each `(payload, signal) => result` (core/local-scheduler.js runs them).
 * @param ctx  { core }: the thread's C core (core/wasm.js), there once the thread is set up
 */
export function tunnelJobs(ctx) {
  return {
    /**
     * The tubes of the tunnel runs of the detail tiles round the camera (engine/tunnels/groups.js): runs joined
     * across tiles, double tracks one bore, the ends of each. `priority` names each kind's importance; `hints` the
     * points the bores' spines are to run through (5.18a).
     */
    'tunnel-tubes': ({ runs, priority, hints }) => ({ tubes: tubesFrom(runs, priority, hints ?? []) }),

    /**
     * The whole tunnel a point inside one belongs to, from portal to portal (engine/tunnels/trace.js), through the
     * vector service's zoom-13 tiles (`templates`, picked per tile as engine/vector/source.js does, so they are the
     * overview tiles the browser has cached). Kept between sessions: each tunnel once, thinned to a point every
     * KEEP_STEP metres, and per tile the names of the tunnels through it, so the next ask anywhere along a tunnel
     * finds it without a download.
     */
    'tunnel-trace': async ({ family, lon, lat, templates, schema, priority }, signal) => {
      const space = `${schema.id}.${schema.revision}|${family}`;
      const start = tileAtZoom(lon, lat, TRACE_ZOOM);
      const listed = await cacheGet(`tunnel-tile|1|${space}|${start}`);
      for (const key of listed?.keys ?? []) {
        const hit = await cacheGet(`tunnel-tube|1|${space}|${key}`);
        if (hit?.tube && placeOn(hit.tube, lon, lat).off <= 30) return { tube: hit.tube, tiles: 0, done: true, cached: true, bytes: 0 };
      }
      let bytes = 0;
      const tileRuns = async (z, x, y) => {
        const t = templates[(x + y) % templates.length];
        const got = await vectorBytes(t.replace('{z}', z).replace('{x}', x).replace('{y}', y), signal, priority);
        if (!got) return null;
        bytes += got.byteLength;
        const r = decodeVectorTile(ctx.core, got, { z, x, y, schema });
        return r.block ? tunnelRuns(r.block.subarray(0, r.size), z, x, y, schemaKinds(schema)) : [];
      };
      const found = await traceTunnel(tileRuns, family, lon, lat);
      if (!found) return { tube: null, tiles: 0, done: false, bytes };
      const tube = thinned(found.tube, KEEP_STEP);
      if (found.done) {
        await cachePut(`tunnel-tube|1|${space}|${tube.key}`, { bytes: tube.points.byteLength + 200, tube });
        for (const tile of tilesAlong(found.tube, TRACE_ZOOM)) {
          const key = `tunnel-tile|1|${space}|${tile}`;
          const keys = (await cacheGet(key))?.keys ?? [];
          if (!keys.includes(tube.key)) await cachePut(key, { bytes: 64 * (keys.length + 1), keys: [...keys, tube.key] });
        }
      }
      return { tube, tiles: found.tiles, done: found.done, cached: false, bytes };
    },

    /**
     * A tube's mesh (wasm/src/tunnel.c through engine/tunnels/mesh.js): its points (mesh.js meshPoints) and
     * cross-section (sections.js) in, vertices and indices out, in buffers of their own (sent on to the render
     * thread, transferred).
     */
    'tunnel-mesh': ({ spec, points, profile }) => buildTunnelMesh(ctx.core, spec, viewOf(Float64Array, points), viewOf(Float32Array, profile), exactCopy),
  };
}

/* A typed array of a type over `data` (one already, or its buffer). */
function viewOf(Type, data) {
  return data instanceof Type ? data : new Type(data);
}

/* A tube with a spine point every `step` metres or so (and its last). */
function thinned(tube, step) {
  const p = tube.points, n = p.length / TUBE_POINT, keep = [];
  let next = 0;
  for (let k = 0; k < n; k++) if (p[k * TUBE_POINT + 2] >= next || k === n - 1) { keep.push(k); next = p[k * TUBE_POINT + 2] + step; }
  const points = new Float64Array(keep.length * TUBE_POINT);
  keep.forEach((k, i) => points.set(p.subarray(k * TUBE_POINT, (k + 1) * TUBE_POINT), i * TUBE_POINT));
  return { ...tube, points };
}

/* The tiles of a zoom a tube's spine passes through, as 'x/y'. */
function tilesAlong(tube, z) {
  const p = tube.points, out = new Set();
  for (let k = 0; k < p.length; k += TUBE_POINT) out.add(tileAtZoom(p[k], p[k + 1], z));
  return out;
}

function tileAtZoom(lon, lat, z) {
  const t = tileOf(lon, lat, z);
  return `${t.x}/${t.y}`;
}
