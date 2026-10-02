/* stream.mjs — loading when the services misbehave, for
 * tools/verify.mjs --scenario stream.
 *
 * The rig answers for every service (tools/mock-data.mjs,
 * tools/mock-buildings.mjs); here it is told to answer some requests badly
 * (verify.mjs `faults`), and the app must cope the way core/net.js and
 * core/scheduler.js say:
 *   - nothing there (403, 404, 400) is asked for once and never again;
 *   - a server error (500) is tried again about a second later and loads;
 *   - "too many requests" (429 with Retry-After: 2) is tried again no
 *     sooner than the server asked, and halves how many requests go to that
 *     host at once, which then recovers by one per success;
 *   - an answer that never comes is given up at the job's timeout and asked
 *     for again;
 *   - requests for tiles the view has left are called off (stale), and the
 *     rest still loads;
 *   - the number of jobs in flight never exceeds the scheduler's capacity;
 *   - with decode threads to spare (8, as on a desktop), a flight's photos
 *     fetched ahead go out, and the staleness check leaves jobs for no tile
 *     in particular alone (the rig's two threads never had a slot to spare
 *     for them, and a user's machine with eight crashed on one).
 */

import { AREA } from '../mock-buildings.mjs';
import { height } from '../mock-data.mjs';

const HOST = '3d.geo.admin.ch';
const isTerrain = (url) => url.host === HOST && url.pathname.endsWith('.terrain');
const isPhoto = (url) => url.host === 'wmts.geo.admin.ch' && url.pathname.endsWith('.jpeg');
const isBuilding = (url) => url.host === HOST && url.pathname.endsWith('.b3dm');

export async function run(page, { faults, seen, absent }) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`  ... ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
  };
  const probe = () => page.evaluate(() => globalThis.swissgpu.probe());
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 300) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  // A rule answering the first `times` matching requests its own way, which
  // remembers what it caught and when.
  const fault = (match, rule) => {
    const f = { ...rule, caught: [], match: (url) => {
      if (!match(url)) return false;
      f.caught.push({ path: url.pathname, at: Date.now() });
      return true;
    } };
    faults.push(f);
    return f;
  };
  // Seconds from a caught request to the next request for the same file.
  const retryGap = ({ path, at }) => {
    const later = (seen.get(path) ?? []).find((t) => t > at);
    return later ? (later - at) / 1000 : NaN;
  };
  const settled = (q) => q.terrain.pending === 0 && q.buildings.pending === 0;
  let most = 0;
  const watch = (q) => { most = Math.max(most, q.requests.active); return q; };

  await until((q) => watch(q).terrain.pending === 0 && q.terrain.drawn > 0);
  const over = { lon: AREA.west + 0.01, lat: (AREA.south + AREA.north) / 2, height: 400, yaw: 0.4, pitch: -0.35, mode: 'fly' };

  /* 1. A server error, then success: tried again about a second later. The
   * first building tile the town asks for gets a 500. */
  const err500 = fault(isBuilding, { status: 500, times: 1 });
  await send('camera', { state: over });
  let q = await until((r) => watch(r) && settled(r) && r.buildings.drawn > 0 && err500.times === 0, 300000);
  const hit500 = err500.caught[0];
  const gap500 = hit500 ? retryGap(hit500) : NaN;
  const drawn500 = hit500 && q.buildingTiles.some((t) => t.url.endsWith(hit500.path));
  check('a server error is tried again a moment later, and loads', gap500 >= 0.4 && gap500 < 6 && q.buildings.failed === 0,
    `${hit500?.path.split('/').slice(-2).join('/')} asked for again ${gap500.toFixed(2)} s after the 500 ` +
    `(${drawn500 ? 'drawn now' : 'loaded, replaced by finer tiles since'}), ${q.buildings.failed} failed; ` +
    `${q.requests.retries} retries in all`);

  /* 2. Too many requests: Retry-After honoured, the host's cap halved and back. */
  const busy = fault(isTerrain, { status: 429, retryAfter: 2, times: 3 });
  let lowestCap = 24;
  const capOf = (r) => r.requests.hosts?.[HOST] ?? 24;
  await send('camera', { state: { ...over, lat: over.lat + 0.02, height: 900, yaw: 2.5 } });
  q = await until((r) => {
    watch(r);
    lowestCap = Math.min(lowestCap, capOf(r));
    return busy.times === 0 && r.terrain.pending === 0;
  }, 300000, 100);
  const gaps = busy.caught.map(retryGap);
  // More requests to the host bring its cap back up, one per success.
  await send('camera', { state: { ...over, lat: over.lat - 0.015, height: 700, yaw: -2.2 } });
  const recovered = await until((r) => watch(r) && capOf(r) === 24, 180000);
  check('"too many requests" waits as asked and slows down, then recovers',
    gaps.length === 3 && gaps.every((g) => g >= 1.95) && lowestCap <= 12 && capOf(recovered) === 24,
    `${busy.caught.length} answers of 429 asked for again after ${gaps.map((g) => g.toFixed(2)).join(', ')} s ` +
    `(Retry-After: 2); host cap down to ${lowestCap}, back to ${capOf(recovered)}`);

  /* 3. An answer that never comes: given up at the timeout, asked again. */
  const hang = fault(isPhoto, { hang: 45000, times: 1 });
  await send('camera', { state: { ...over, lon: over.lon - 0.004, lat: over.lat - 0.004, height: 250, yaw: -0.5 } });
  const hung = await until((r) => watch(r) && hang.caught.length > 0 && retryGap(hang.caught[0]) > 0, 120000, 500);
  const hitHang = hang.caught[0];
  const gapHang = hitHang ? retryGap(hitHang) : NaN;
  check('an answer that never comes is given up at the timeout and asked again',
    gapHang >= 19.5 && gapHang < 30,
    `${hitHang?.path.split('/').slice(-3).join('/')} asked again ${gapHang.toFixed(1)} s after the first try ` +
    `(timeout 20 s); ${hung.requests.retries} retries in all`);

  /* 4. Requests for what the view has left are called off: terrain and
   * photos somewhere new answer slowly, and the view moves on before they do. */
  const before = await probe();
  // Longer than it takes to get there and leave, shorter than the jobs' 20 s timeout.
  const slow = fault((url) => isTerrain(url) || isPhoto(url), { hang: 15000, times: Infinity });
  const there = { ...over, lon: over.lon + 0.15, lat: over.lat - 0.1, yaw: 0.9 };
  there.height = height(there.lon, there.lat) + 500;
  await send('camera', { state: there });
  await until((r) => watch(r) && r.requests.active > 2, 60000, 100);
  await wait(1000);
  // Somewhere else entirely: everything asked for back there goes stale.
  slow.times = 0;
  const away = { ...over, lon: over.lon - 0.3, lat: over.lat + 0.25 };
  away.height = height(away.lon, away.lat) + 1500;
  await send('camera', { state: away });
  const off = await until((r) => watch(r) && r.requests.stale > before.requests.stale, 30000, 200);
  check('requests for what the view has left are called off',
    off.requests.stale > before.requests.stale && off.requests.cancelled > before.requests.cancelled,
    `${off.requests.stale - before.requests.stale} called off as stale, ` +
    `${off.requests.cancelled - before.requests.cancelled} cancelled in all`);

  /* 5. And everything still loads once the services behave again. */
  await send('camera', { state: over });
  const end = await until((r) => watch(r) && settled(r) && r.buildings.drawn > 0, 300000);
  check('everything loads once the services behave',
    settled(end) && end.buildings.drawn > 0 && end.terrain.drawn > 0,
    `${end.terrain.drawn} terrain and ${end.buildings.drawn} building tiles drawn, nothing pending; ` +
    `${end.requests.started} jobs started, ${end.requests.cancelled} cancelled, ${end.requests.retries} retries, ` +
    `${end.requests.failed} given up`);

  /* 6. Nothing there is asked for once only, and the limits held. */
  const repeats = [...absent].filter((p) => (seen.get(p)?.length ?? 0) > 1);
  check('nothing there is asked for once and never again', repeats.length === 0,
    `${absent.size} paths answered "nothing here", ${repeats.length} asked for again` +
    (repeats.length ? ` (${repeats.slice(0, 3).join(', ')})` : ''));
  check('jobs in flight never exceed the capacity', most <= end.requests.capacity && most > 0,
    `at most ${most} of ${end.requests.capacity} (${end.requests.threads} threads × 4)`);

  /* 7. Eight decode threads, a flight: photos fetched ahead with the spare
   * slots, and checked for staleness like everything else while they are
   * out. Photos answer slowly here, as over a real network, so the fetches
   * are still out when the checks come (with the stand-in's instant
   * answers they never were, which is how the rig missed the crash). */
  await send('setting', { id: 'decodeThreads', value: 8 });
  const wide = await until((r) => r.requests.threads === 8, 60000, 300);
  const before7 = wide.imagery.prefetched ?? 0;
  const slowPhotos = fault(isPhoto, { hang: 2000, times: 16 });
  await send('flyto', { lon: over.lon + 0.06, lat: over.lat + 0.04, label: 'preload check' });
  const ahead = await until((r) => (r.imagery.prefetched ?? 0) > before7, 120000, 300);
  // Staleness checks with the photos out (one every 100 ms of frames).
  await wait(3000);
  const after7 = await probe();
  slowPhotos.times = 0;
  await send('camera', { state: over });
  check('with threads to spare, a flight fetches photos ahead and the staleness check leaves them alone',
    after7.requests.threads === 8 && (ahead.imagery.prefetched ?? 0) > before7 && after7.simTime > ahead.simTime,
    `${after7.requests.threads} threads, capacity ${after7.requests.capacity}; ${(ahead.imagery.prefetched ?? 0) - before7} photos ` +
    `fetched ahead of the flight, frames still running (${(after7.simTime - ahead.simTime).toFixed(1)} s of simulation since)`);
  return results;
}
