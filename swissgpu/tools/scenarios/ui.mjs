/* ui.mjs — the settings menu, the mouse, and going to a search result, for
 * tools/verify.mjs --scenario ui.
 *
 * Drives the menu through the real page the way a person would: the Settings
 * button, tabs, a switch, a segmented choice, a slider, a key rebinding and
 * Escape. Each is checked against the stored setting it should change and
 * the effect it should have. Then the mouse: E frees it without leaving
 * fullscreen and takes it back, and with it free Esc leaves fullscreen. Then
 * search picks through the real search box (the rig answers for the search
 * services, tools/mock-data.mjs): a pick takes the mouse back and flies
 * there: climbing at once and off straight ahead the way the camera faces,
 * its path (a glass tube with beads) and the place's name drawn, banking a
 * little into its turns within the setting, the view looking the way it
 * goes and following the path (level between its blends, turning gently),
 * never near the ground, in along the start heading and exactly onto the
 * spot, facing and tilted as the camera was at the pick, at the same height
 * above the ground; with the flight turned off it is there at once, as high
 * above the ground; Longest flight caps a long one; a short trip straight
 * ahead flies one arc straight there, quickly; a walker lands on the ground next to
 * the house an address points into and walks on, never into the house on the
 * way, and a low flight ends at its height outside the house.
 */

import { PLACES, height } from '../mock-data.mjs';
import { houseInfo, HOUSE_HALF } from '../mock-buildings.mjs';
import { offset } from '../../js/core/geo.js';

const KEY = { FORWARD: 1 };
const M_PER_DEG_LAT = 111_132;
const DEG = Math.PI / 180;
const EYE = 1.75 * 0.936;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const turn = (a, b) => Math.abs(wrap(a - b));

export async function run(page, { shot } = {}) {
  // A software GPU can take seconds a frame, and Playwright's checks that an
  // element is steady wait for frames: generous timeouts throughout.
  page.setDefaultTimeout(120000);
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`  ... ${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`);
  };
  // A frame of the software GPU can outlast the probe's 2 s answer time (a
  // flight draws more): then it is asked again, a few times.
  const probe = async () => {
    for (let tries = 1; ; tries++) {
      try { return await page.evaluate(() => globalThis.swissgpu.probe()); }
      catch (err) { if (tries >= 5 || !/did not answer/.test(err.message)) throw err; }
    }
  };
  const send = (type, payload) => page.evaluate(([t, p]) => globalThis.swissgpu.send(t, p), [type, payload]);
  const wait = (ms) => page.waitForTimeout(ms);
  const until = async (test, ms = 120000, every = 300) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await probe(); if (test(last)) return last; await wait(every); }
    return last;
  };
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('swissgpu.settings.v2') || '{}'));
  const snap = async (suffix) => {
    if (!shot) return;
    try { await page.screenshot({ path: shot.replace(/\.png$/, `-${suffix}.png`), timeout: 120000 }); }
    catch (err) { console.warn(`screenshot ${suffix} skipped: ${err.message.split('\n')[0]}`); }
  };

  await until((q) => q.terrain.pending === 0 && q.terrain.drawn > 0);

  /* 1. The Settings button opens the menu on the last tab used. */
  await page.click('#gear');
  await wait(400);
  const open = await page.evaluate(() => !document.getElementById('menu').hidden);
  const tabs = await page.$$eval('.menu__tab', (els) => els.map((e) => e.textContent.trim()));
  check('the Settings button opens a menu with tabs', open && tabs.length >= 7, `open: ${open}, tabs: ${tabs.join(', ')}`);

  /* 2. Graphics tab: a segmented choice and a distance slider (Stage 5.10b:
   * on the Quality page, under Advanced, opened first if it is folded). */
  await page.click('.menu__tab[data-tab="graphics"]');
  await wait(300);
  await page.click('.menu__pagetab[data-page="quality"]');
  await wait(200);
  if (await page.$eval('.advanced__toggle', (b) => b.getAttribute('aria-expanded') !== 'true')) await page.click('.advanced__toggle');
  await wait(200);
  await snap('graphics');
  await page.click('.setting--choice:has(#setting-imagerySharpness) button:has-text("Sharp")');
  await page.$eval('.setting--slider:has(#setting-viewDistanceKm) .range', (r) => {
    r.value = '120'; r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await wait(600);
  let s = await stored();
  const chip = await page.$eval('.setting--slider:has(#setting-viewDistanceKm) .value-chip', (e) => e.textContent);
  check('choices and sliders set their values, with units', s.imagerySharpness === 0 && s.viewDistanceKm === 120 && chip === '120 km',
    `sharpness ${s.imagerySharpness}, view distance ${s.viewDistanceKm} shown as "${chip}"`);
  let q = await until((r) => r.horizon <= 120000, 20000);
  check('the view distance reaches the renderer', q.horizon <= 120000, `drawing out to ${Math.round(q.horizon / 1000)} km`);

  /* 3. A changed setting can be reset; the switch says On and Off. */
  await page.click('.setting--slider:has(#setting-viewDistanceKm) .setting__reset');
  await page.click('.menu__tab[data-tab="general"]');
  await wait(300);
  await page.click('.menu__pagetab[data-page="interface"]');
  await wait(200);
  const sw = '.setting--toggle:has(#setting-showTelemetry) .toggle';
  await page.click(sw);
  await wait(300);
  const readoutHidden = await page.evaluate(() => document.getElementById('readout').hidden);
  await page.click(sw);
  await wait(500);            // storage is written a moment after the last change
  s = await stored();
  check('reset and switches work', s.viewDistanceKm === 400 && readoutHidden && s.showTelemetry === true,
    `view distance back to ${s.viewDistanceKm}, readout hidden while off: ${readoutHidden}`);

  /* 4. Keys: bind Move forward to I, and walk with it. */
  await page.click('.menu__tab[data-tab="controls"]');
  await wait(300);
  await page.click('.menu__pagetab[data-page="keys"]');
  await wait(200);
  await snap('controls');
  const slots = await page.$$('.keys__row .key');
  await slots[0].click();
  await page.keyboard.press('KeyI');
  await wait(500);
  s = await stored();
  check('a key can be rebound', s.keybinds?.forward?.[0] === 'KeyI', `forward is now ${JSON.stringify(s.keybinds?.forward)}`);
  await page.keyboard.press('Escape');
  await wait(300);
  const closed = await page.evaluate(() => document.getElementById('menu').hidden);
  check('Escape closes the menu', closed, closed ? 'closed' : 'still open');

  // Take the pointer again. Going fullscreen makes the software GPU's next
  // frames slow, and physics never steps more than a tenth of a second per
  // frame, so the key is held for a second of simulated time, not of clock.
  await page.mouse.click(640, 500);
  let locked = false;
  for (let i = 0; i < 30 && !locked; i++) {
    await wait(100);
    locked = await page.evaluate(() => document.pointerLockElement !== null);
  }
  const before = await probe();
  await page.keyboard.down('KeyI');
  await until((r) => r.simTime > before.simTime + 1, 60000, 100);
  await page.keyboard.up('KeyI');
  const after = await probe();
  const moved = Math.hypot(after.camera.lon - before.camera.lon, after.camera.lat - before.camera.lat) > 1e-6;
  check('the new key moves you', moved,
    `${moved ? 'moved forward with I' : 'did not move'} (pointer ${locked ? 'locked' : 'not locked'}, ${before.motion.mode})`);
  await page.evaluate(() => document.exitPointerLock());
  // Put the default back for whoever runs next.
  await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem('swissgpu.settings.v2') || '{}');
    delete v.keybinds;
    localStorage.setItem('swissgpu.settings.v2', JSON.stringify(v));
  });

  /* 5. The mouse: E frees it and keeps fullscreen, E takes it back, and with
   * it free, Esc leaves fullscreen. */
  const lockState = () => page.evaluate(() => ({
    locked: document.pointerLockElement !== null, fullscreen: document.fullscreenElement !== null,
  }));
  const waitLock = async (want, ms = 5000) => {
    const end = Date.now() + ms;
    let s = await lockState();
    while (s.locked !== want && Date.now() < end) { await wait(100); s = await lockState(); }
    return s;
  };
  await page.mouse.click(640, 500);
  const taken = await waitLock(true);
  await wait(500);   // fullscreen settles a moment after the lock
  const full = (await lockState()).fullscreen;
  await page.keyboard.press('KeyE');
  const freed = await waitLock(false);
  check('E frees the mouse and keeps fullscreen', taken.locked && !freed.locked && freed.fullscreen === full,
    `locked ${taken.locked} → ${freed.locked}, fullscreen ${full} → ${freed.fullscreen}`);
  await page.keyboard.press('KeyE');
  const back = await waitLock(true);
  check('E takes it back', back.locked, back.locked ? 'locked again, from a key press' : 'not locked');
  await page.keyboard.press('KeyE');
  await waitLock(false);
  await page.keyboard.press('Escape');
  await wait(600);
  const left = await lockState();
  check('with the mouse free, Esc leaves fullscreen', !left.locked && !left.fullscreen,
    full ? `fullscreen ${left.fullscreen}` : 'fullscreen is not available here; nothing to leave');
  // And everything comes back with the next click, after all that toggling.
  await page.mouse.click(640, 500);
  const again = await waitLock(true);
  await wait(500);
  const againFull = (await lockState()).fullscreen;
  check('a click afterwards takes the mouse and fullscreen again', again.locked && againFull === full,
    `locked ${again.locked}, fullscreen ${againFull}`);
  // The menu key, like E, frees the mouse and keeps fullscreen; Esc then
  // closes the menu and still keeps it.
  await page.keyboard.press('KeyO');
  const menuOpen = await waitLock(false);
  await wait(300);
  const opened = await page.evaluate(() => !document.getElementById('menu').hidden);
  await page.keyboard.press('Escape');
  await wait(400);
  const closed2 = await page.evaluate(() => document.getElementById('menu').hidden);
  const afterMenu = await lockState();
  check('O opens the menu, freeing the mouse and keeping fullscreen', opened && !menuOpen.locked &&
    menuOpen.fullscreen === full && closed2 && afterMenu.fullscreen === full,
    `menu ${opened ? 'opened' : 'did not open'}, mouse ${menuOpen.locked ? 'still locked' : 'free'}, ` +
    `fullscreen ${full} → ${menuOpen.fullscreen}, after Esc ${afterMenu.fullscreen} (menu ${closed2 ? 'closed' : 'open'})`);
  /* Frees the mouse if the camera has it, for the search box. */
  const freeMouse = async () => {
    if ((await lockState()).locked) { await page.keyboard.press('KeyE'); await waitLock(false); }
  };

  /* 6. A search pick, flying 300 m up: the mouse goes back to the camera;
   * the flight goes up at once and off straight ahead the way the camera
   * faces (north, looking down, the place 5 km away to the north-east and
   * 2 km lower: it curves right, flies on and curves back left), banks into
   * its turns within the Bank setting, keeps the view level and turns
   * smoothly, never comes near the ground, comes in along the start heading
   * and arrives exactly on the spot, facing the way the camera faced at the
   * pick, tilted as it was, level, at the same height above the ground.
   * (Facing away from the place, down off this ridge, it is an S all the
   * same, rising straight up first where its curves would come high up and
   * wide: plan.js, LIFT, tested in tools/flight-test.mjs.) */
  const street = PLACES.national[1];
  await send('camera', { state: { lon: street.lon, lat: street.lat, height: height(street.lon, street.lat) + 300,
    yaw: 0, pitch: -0.45, mode: 'fly' } });
  const q0 = await until((r) => r.physicsGround?.accurate && Math.abs(r.camera.lat - street.lat) < 1e-9, 180000, 300);
  const from = q0;
  const aboveFrom = from.camera.height - from.physicsGround.height;
  /* Types into the real search box and clicks the first suggestion; returns
   * the state just before the click. */
  const pickResult = async (text) => {
    await page.fill('#search-input', '');
    await page.click('#search-input');
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForSelector('.search__result', { timeout: 15000 });
    const at = await probe();
    await page.click('.search__result');
    return at;
  };
  /* Watches a flight from `start` until it is over: how it set off (more up
   * than along at first, along the heading, the view not turning), the
   * fastest the heading turns and the bank (never leaning against the
   * turn), how level the view stays in flight, the heading flown at the
   * very end, the lowest and highest it goes above the exact ground, how
   * close it comes to a house's roof when given one, and the phases. */
  const watchFlight = async (start, house = null, shotAt = null) => {
    const w = { sawFlight: false, offStart: 0, setOff: 0, startTurn: 0, leaving: 0, risen: null, early: 0, rate: 0, bank: 0, banked: 0,
      against: 0, tilt: 0, level: 0, inHeading: 0, inSamples: 0, lowest: Infinity, overRoof: Infinity, peak: -Infinity,
      phases: new Set(), plan: null, pathPoints: 0, beads: 0, label: '', labelSize: null, along: 0, alongSamples: 0, shot: false };
    let last = null, told = Date.now();
    // Polled like `until`, but able to stop for a screenshot on the way.
    const end = Date.now() + 1500000;
    let q = null;
    while (Date.now() < end) {
      q = await probe();
      if (watch(q)) break;
      if (shotAt != null && !w.shot && q.flight?.active && q.flight.progress >= shotAt) {
        w.shot = true;
        await snap('path');
      }
      await wait(60);
    }
    return { q, w };

    function watch(r) {
      const f = r.flight;
      // A line every half minute on a slow software GPU, so a long wait shows where it is.
      if (f && Date.now() - told > 30000) {
        told = Date.now();
        console.log(`      (flight ${f.phase}, ${f.t?.toFixed(2)} of ${f.duration?.toFixed(2)} s, ` +
          `${Math.round(r.camera.height - (r.physicsGround?.height ?? 0))} m up, plan ${f.planMs?.toFixed(1)} ms)`);
      }
      if (f?.active) {
        w.sawFlight = true;
        w.phases.add(f.phase);
        if (f.plan) { w.plan = f.plan; w.firstPlan ??= f.plan; }
        const e = (r.camera.lon - start.camera.lon) * M_PER_DEG_LAT * Math.cos(start.camera.lat * DEG);
        const n = (r.camera.lat - start.camera.lat) * M_PER_DEG_LAT, moved = Math.hypot(e, n);
        if (r.physicsGround?.accurate) {
          const above = r.camera.height - r.physicsGround.height;
          w.lowest = Math.min(w.lowest, above);
          w.peak = Math.max(w.peak, above);
        }
        if (house) {
          // Over the house's footprint, the height above its roof there: the
          // gabled one (ridge east-west through the middle, eaves at the
          // north and south walls), at or above the flat one of coarse tiles.
          const he = (r.camera.lon - house.lon) * M_PER_DEG_LAT * Math.cos(house.lat * DEG), hn = (r.camera.lat - house.lat) * M_PER_DEG_LAT;
          if (Math.abs(he) < HOUSE_HALF.east && Math.abs(hn) < HOUSE_HALF.north) {
            const roof = house.eaves + (house.ridge - house.eaves) * (1 - Math.abs(hn) / HOUSE_HALF.north);
            w.overRoof = Math.min(w.overRoof, r.camera.height - roof);
          }
        }
        if (r.path?.drawn) { w.pathPoints = Math.max(w.pathPoints, r.path.points); w.beads = Math.max(w.beads, r.path.beads); }
        if (r.label?.drawn) { w.label = r.label.text; w.labelSize = r.label.size; }
        // The view along the way it moves, once it moves along more than up.
        if (last && f.phase === 'flight' && f.plan && !f.plan.glide) {
          const de = (r.camera.lon - last.camera.lon) * M_PER_DEG_LAT * Math.cos(r.camera.lat * DEG);
          const dn = (r.camera.lat - last.camera.lat) * M_PER_DEG_LAT, rise = Math.abs(r.camera.height - last.camera.height);
          if (Math.hypot(de, dn) > 2 && Math.hypot(de, dn) > rise) {
            const mid = last.camera.yaw + wrap(r.camera.yaw - last.camera.yaw) / 2;
            w.along = Math.max(w.along, turn(mid, Math.atan2(de, dn)));
            w.alongSamples++;
          }
        }
        if (f.phase === 'flight' && moved < 15) {
          w.early++;
          // From the air in the open it leaves level and curves up (Stage
          // 5.8b, his words: "start with a more curved approach (like the
          // destination)"): how steeply it rises over its first 3 m.
          if (moved > 0.5 && moved < 3) w.leaving = Math.max(w.leaving, Math.atan2(r.camera.height - start.camera.height, moved));
          if (moved > 0.3) {
            w.offStart = Math.max(w.offStart, turn(Math.atan2(e, n), start.camera.yaw));
            w.startTurn = Math.max(w.startTurn, turn(r.camera.yaw, start.camera.yaw));
            w.setOff++;
          }
        }
        // ... and how high it has risen once 15 m along.
        if (f.phase === 'flight' && moved >= 15 && w.risen == null) w.risen = r.camera.height - start.camera.height;
        const roll = r.camera.roll ?? 0;
        w.bank = Math.max(w.bank, Math.abs(roll));
        if (last && r.simTime - last.simTime > 0.02) {
          const rate = wrap(r.camera.yaw - last.camera.yaw) / (r.simTime - last.simTime);
          w.rate = Math.max(w.rate, Math.abs(rate));
          if (Math.abs(rate) > 10 * DEG && Math.abs(roll) > 5 * DEG) {
            w.banked++;
            if (rate * roll < 0) w.against++;
          }
        }
        // The tilt on the path, between its turns from and back to your view.
        if (f.phase === 'flight' && f.plan && f.plan.kind === 'curve' && f.t > f.plan.viewIn + 0.05 &&
          f.t < f.plan.duration - f.plan.viewOut - 0.05) {
          w.tilt = Math.max(w.tilt, Math.abs(r.camera.pitch));
          w.level++;
        }
        if (f.progress > 0.98) {
          w.inHeading = Math.max(w.inHeading, turn(f.heading, start.camera.yaw));
          w.inSamples++;
        }
        last = r;
      }
      return w.sawFlight && r.flight && !r.flight.active;
    }
  };
  const planned = (w, q) => (w.plan ? `${w.plan.word} route of ${Math.round(w.plan.length)} m for ${Math.round(w.plan.distance)} m, ` +
    `turns ${w.plan.turns.map((a) => Math.round(a)).join('° and ')}°, cruise ${Math.round(w.plan.cruise - (q.physicsGround?.height ?? 0))} m up, ` +
    `${w.plan.duration.toFixed(1)} s (x${w.plan.compress.toFixed(2)})` : 'no plan seen');
  const pickedTestd = await pickResult('Testd');
  const relocked = await waitLock(true);
  check('picking a result takes the mouse back', relocked.locked, relocked.locked ? 'locked' : 'still free');
  let { q: arrived, w } = await watchFlight(pickedTestd, null, 0.25);
  q = arrived;
  const dorf = PLACES.global[0];
  const offBy = (c, p) => Math.hypot((c.lon - p.lon) * M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180), (c.lat - p.lat) * M_PER_DEG_LAT);
  let off = offBy(q.camera, { lon: dorf.longitude, lat: dorf.latitude });
  let above = q.physicsGround ? q.camera.height - q.physicsGround.height : NaN;
  check('it sets off straight ahead, the way the camera faces, leaving level and curving up',
    w.sawFlight && w.early >= 2 && w.leaving < 10 * DEG && w.risen > 0 && w.setOff >= 2 && w.offStart < 2 * DEG && w.startTurn < 0.5 * DEG,
    `rising at ${(w.leaving / DEG).toFixed(1)}° at most over its first 3 m, ${w.risen?.toFixed(1)} m up 15 m along (${w.early} samples), ` +
    `flown within ${(w.offStart / DEG).toFixed(2)}° of the heading, the view turning ${(w.startTurn / DEG).toFixed(2)}° meanwhile (${planned(w, q)})`);
  check('a blue line with beads shows the way ahead, and the place\'s name floats over it', w.pathPoints > 1 && w.beads > 0 &&
    w.label.startsWith('Testdorf') && w.shot,
    `${w.pathPoints} points and ${w.beads} beads drawn; the name "${w.label}" (${w.labelSize?.join(' x ') ?? '–'} px)` +
    `${w.shot ? ', screenshot ui-path.png' : ''}`);
  // Between probes the camera moves a long way at the bell's peak, on a
  // curve: the chord against the view halfway along it.
  check('the view looks the way the flight goes', w.alongSamples >= 5 && w.along < 3 * DEG,
    `within ${(w.along / DEG).toFixed(2)}° of the way it moved over ${w.alongSamples} samples`);
  check('it banks into its turns, within the setting', w.bank > 5 * DEG && w.bank <= 15.5 * DEG && w.banked >= 3 && w.against === 0,
    `up to ${(w.bank / DEG).toFixed(1)}° of bank (setting 15°), leaning into the turn in ${w.banked} samples, against it in ${w.against}`);
  const fastest = 30 * (w.plan?.compress ?? 1) + 3;
  check('the view follows the path: up and down along it (89° at most), turning gently', w.level >= 3 && w.tilt < 89.01 * DEG && w.rate < fastest * DEG,
    `pitch within ${(w.tilt / DEG).toFixed(2)}° of level over ${w.level} samples, fastest turn ${(w.rate / DEG).toFixed(0)}°/s (at most ${fastest.toFixed(0)})`);
  check('it never comes near the ground', w.lowest > 250,
    `at least ${w.lowest.toFixed(0)} m above the exact ground on the way (took off ${aboveFrom.toFixed(0)} m up), ` +
    `closest by the flight's own count ${q.flight?.closest?.toFixed?.(1) ?? '–'} m`);
  check('it comes in along the start heading', w.inSamples >= 1 && w.inHeading < 1 * DEG,
    `the way in flown within ${(w.inHeading / DEG).toFixed(2)}° of the start heading over ${w.inSamples} samples`);
  check('it arrives facing exactly that way, level, at the same height above the ground',
    turn(q.camera.yaw, from.camera.yaw) < 1e-3 && Math.abs(q.camera.pitch - from.camera.pitch) < 1e-3 &&
    Math.abs(q.camera.roll ?? 0) < 1e-6 && off < 1 && Math.abs(above - aboveFrom) < 1.5 && q.motion.mode === 'fly',
    `heading ${from.camera.yaw.toFixed(3)} → ${q.camera.yaw.toFixed(3)}, pitch ${from.camera.pitch.toFixed(3)} → ` +
    `${q.camera.pitch.toFixed(3)}, bank ${((q.camera.roll ?? 0) / DEG).toFixed(4)}°, ${off.toFixed(2)} m from the spot, ` +
    `${above.toFixed(1)} m above its ground (took off ${aboveFrom.toFixed(1)} m above), ${q.motion.mode === 'fly' ? 'flying' : q.motion.state}`);
  await snap('arrived');

  /* 7. The flight turned off: a pick is there at once, at the same height
   * above the ground, looking the same way. */
  const openGeneral = async () => {
    await freeMouse();
    await page.click('#gear');
    await wait(300);
    await page.click('.menu__tab[data-tab="general"]');
    await wait(300);
    // Search flights, its Advanced open (Longest flight is there since 5.10b).
    await page.click('.menu__pagetab[data-page="flights"]');
    await wait(200);
    if (await page.$eval('.advanced__toggle', (b) => b.getAttribute('aria-expanded') !== 'true')) await page.click('.advanced__toggle');
    await wait(200);
  };
  const flightSwitch = async () => {
    await openGeneral();
    await page.click('.setting--toggle:has(#setting-flyToResults) .toggle');
    await wait(300);
    await page.keyboard.press('Escape');
    await wait(300);
  };
  await flightSwitch();
  await page.click('.scope[data-scope="national"]', { force: true });
  const platz = PLACES.national[0];
  const pickedAt = await pickResult('Testplatz');
  const aboveAt = pickedAt.physicsGround ? pickedAt.camera.height - pickedAt.physicsGround.height : aboveFrom;
  const there = await until((r) => offBy(r.camera, platz) < 1, 60000, 50);
  q = await until((r) => r.flight && !r.flight.active, 120000, 100);
  off = offBy(q.camera, platz);
  above = q.physicsGround ? q.camera.height - q.physicsGround.height : NaN;
  check('with the flight off, a pick is there at once, as high above the ground',
    there.flight?.duration === 0 && there.simTime - pickedAt.simTime < 0.5 && q.motion.mode === 'fly' && off < 1 &&
    Math.abs(above - aboveAt) < 1.5 && turn(q.camera.yaw, pickedAt.camera.yaw) < 1e-3,
    `there ${(there.simTime - pickedAt.simTime).toFixed(2)} s of simulation after the click ` +
    `(${there.flight?.duration === 0 ? 'no travel' : `a ${there.flight?.duration?.toFixed(1)} s flight`}), ` +
    `${above.toFixed(1)} m above the ground (was ${aboveAt.toFixed(1)}), ${off.toFixed(2)} m off, ` +
    `${q.motion.mode === 'fly' ? 'flying' : q.motion.state}`);
  await flightSwitch();   // the flight back on

  /* 7b. Longest flight at its shortest, 5 s, caps a long flight to 5 s
   * (plus finishing a late move of its end);
   * then back to 30 s. */
  const setSlider = async (id, value) => {
    await openGeneral();
    await page.$eval(`.setting--slider:has(#setting-${id}) .range`, (r, v) => {
      r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await page.keyboard.press('Escape');
    await wait(1000);            // storage is written a moment after the last change
  };
  await setSlider('longestFlight', 5);
  const longest = (await stored()).longestFlight;
  await page.click('.scope[data-scope="global"]', { force: true });
  const pickedBack = await pickResult('Testd');
  let capped;
  ({ q: capped, w } = await watchFlight(pickedBack));
  const first = w.firstPlan, flown = capped.flight?.elapsed;
  check('Longest flight caps a long flight', longest === 5 && first && first.natural > 5 && first.duration <= 5 + 1e-6 &&
    flown <= 5 + 2.05,
    `setting ${longest} s: the plan ${first?.natural?.toFixed(1)} s at full limits played in ${first?.duration?.toFixed(2)} s, ` +
    `flown in ${flown?.toFixed(2)} s`);
  await setSlider('longestFlight', 30);

  /* 8. A trip of 150 m straight ahead from 300 m up flies one arc straight
   * there, quickly (5.10b: under 300 m, "go straight to the destination,
   * while height follows a parabola"): no turn, no bank, the view kept as it
   * was all the way (5.11b, his words: "when hop is close, don't turn the
   * camera"). */
  const hopFrom = await probe();
  const hopYaw = hopFrom.camera.yaw;
  // Exactly along the heading, on the ellipsoid (a flat-earth guess with the
  // latitude scale for longitude would put it 0.1° to one side).
  const hopTo = offset(hopFrom.camera.lon, hopFrom.camera.lat, 150 * Math.sin(hopYaw), 150 * Math.cos(hopYaw), { lon: 0, lat: 0 });
  await send('flyto', { lon: hopTo.lon, lat: hopTo.lat, elevation: null, label: 'Nebenan' });
  let drift = 0, hopBank = 0, hopTilt = 0, hopPlan = null;
  q = await until((r) => {
    if (r.flight?.active) {
      drift = Math.max(drift, turn(r.camera.yaw, hopYaw));
      hopTilt = Math.max(hopTilt, Math.abs(r.camera.pitch - hopFrom.camera.pitch));
      hopBank = Math.max(hopBank, Math.abs(r.camera.roll ?? 0));
      if (r.flight.plan) hopPlan = r.flight.plan;
    }
    return r.flight && !r.flight.active && offBy(r.camera, hopTo) < 1;
  }, 600000, 60);
  check('a short trip straight ahead flies one arc straight there, quickly, the view kept', drift < 0.05 * DEG && hopBank < 0.05 * DEG &&
    hopTilt < 1e-3 && offBy(q.camera, hopTo) < 1 && Math.abs(q.camera.pitch - hopFrom.camera.pitch) < 1e-3 && hopPlan && hopPlan.duration < 3.5 &&
    hopPlan.kind === 'hop',
    `${hopPlan?.kind ?? 'no plan'} ${hopPlan?.word ?? ''}: the view turned at most ${(drift / DEG).toFixed(4)}°, tilted ${(hopTilt / DEG).toFixed(4)}° and banked ${(hopBank / DEG).toFixed(4)}° on the way, ` +
    `${hopPlan?.duration?.toFixed(2)} s (${hopPlan?.natural?.toFixed(2)} s at the pace alone), back to ` +
    `${(q.camera.pitch - hopFrom.camera.pitch).toFixed(4)} rad of the start pitch, ${offBy(q.camera, hopTo).toFixed(2)} m from the spot`);

  /* 9. Walking, a pick of an address in the middle of a house: up, over the
   * roofs and down onto open ground beside the house, walking on, facing
   * the same way, never into the house on the way. */
  const home = PLACES.national.find((p) => p.house);
  const H = houseInfo(...home.house);
  await send('camera', { state: { ...(await probe()).camera, yaw: 0.6, pitch: -0.05 } });
  await send('spawn', { lon: street.lon, lat: street.lat, elevation: null, label: 'street' });
  const standing = (r) => r.motion.mode === 'walk' && r.motion.state === 'standing';
  const walker = await until((r) => standing(r) && r.solid.clearedBy != null && r.buildings.pending === 0, 300000, 300);
  await freeMouse();
  await page.click('.scope[data-scope="national"]', { force: true });
  const pickedHouse = await pickResult('Testhaus');
  ({ q, w } = await watchFlight(pickedHouse, H));
  const landedFlight = q.flight;
  q = await until((r) => standing(r) && r.solid.clearedBy != null, 300000, 200);
  const outOf = (r, h) => {
    const e = (r.camera.lon - h.lon) * M_PER_DEG_LAT * Math.cos(h.lat * DEG), n = (r.camera.lat - h.lat) * M_PER_DEG_LAT;
    return { e, n, outside: Math.abs(e) > HOUSE_HALF.east + 0.25 || Math.abs(n) > HOUSE_HALF.north + 0.25, away: Math.hypot(e, n) };
  };
  let o = outOf(q, H);
  const feet = q.camera.height - EYE - (q.physicsGround?.height ?? NaN);
  // Clear is the physics' own verdict: not inside the house and no wall
  // above a step's height around the body (the stand-in town is built into
  // a steep slope, so on its uphill side a house's eaves can be at your feet).
  // A trip under 300 m keeps the view (a hop: plan.js, ARC; Stage 5.11b);
  // an S sets off the way it faces.
  const glided = w.plan?.kind === 'hop';
  check('walking, a pick lands you on open ground beside the house, walking on, facing the same way',
    standing(q) && landedFlight?.landed && q.solid.clear === true && q.solid.clearedBy < 0.05 && o.away > 4 && o.away < 15 &&
    Math.abs(feet) < 0.1 && (glided ? w.startTurn < 0.5 * DEG : w.offStart < 2 * DEG) && turn(q.camera.yaw, walker.camera.yaw) < 1e-3,
    `${q.motion.state}, ${o.e.toFixed(1)} m east and ${o.n.toFixed(1)} m north of the house's middle, ` +
    `${q.solid.clear ? 'clear of it' : 'not clear of it'} (moved ${q.solid.clearedBy?.toFixed(2)} m after landing), ` +
    `feet ${feet.toFixed(2)} m off the ground, ${glided ? `glided there, the view turning ${(w.startTurn / DEG).toFixed(2)}° as it set off` :
      `set off within ${(w.offStart / DEG).toFixed(2)}° of the heading`} ` +
    `(${[...w.phases].join(', ')}; spot ${landedFlight?.guessed ? 'guessed' : 'found'}, ${landedFlight?.hovered?.toFixed(1)} s over the place), ` +
    `heading ${(turn(q.camera.yaw, walker.camera.yaw) / DEG).toFixed(4)}° off`);
  // Landing along the start heading beside the house can take the last
  // metres over its roof, down its slope to the eaves: the test is the
  // height above the roof itself, at least the metre a flight keeps.
  const overRoof = (w) => (Number.isFinite(w.overRoof) ? `${w.overRoof.toFixed(1)} m above its roof` : '(never over it)');
  check('on the way it never went into the house or near the ground', w.overRoof > 1 && w.lowest > 1,
    `over the house at least ${overRoof(w)}, ` +
    `at least ${w.lowest.toFixed(2)} m above the exact ground, up to ${w.peak.toFixed(0)} m (${planned(w, q)})`);

  /* 10. Flying 5 m up, the same pick ends 5 m up, clear of the house (at
   * the house's middle that height is inside its roof). */
  await send('camera', { state: { lon: street.lon, lat: street.lat, height: height(street.lon, street.lat) + 5, yaw: 0.6, pitch: -0.05, mode: 'fly' } });
  const low = await until((r) => r.physicsGround?.accurate && Math.abs(r.camera.lat - street.lat) < 1e-9, 60000, 300);
  const lowAbove = low.camera.height - low.physicsGround.height;
  await freeMouse();
  const pickedLow = await pickResult('Testhaus');
  ({ q, w } = await watchFlight(pickedLow, H));
  o = outOf(q, H);
  above = q.camera.height - (q.physicsGround?.height ?? NaN);
  q = await until((r) => r.solid.clear != null, 30000, 200);
  // The house's middle at that height is inside its roof, so the flight has
  // to move off it to the nearest clear spot; how far depends on the roof.
  const movedBy = q.flight ? offBy(q.flight.spot, q.flight.to) : 0;
  check('flying low, it ends at that height, clear of the house', q.motion.mode === 'fly' && q.solid.clear === true &&
    movedBy > 0.5 && o.away < 15 && Math.abs(above - lowAbove) < 1.5 && turn(q.camera.yaw, low.camera.yaw) < 1e-3 && w.overRoof > 1,
    `${above.toFixed(1)} m above the ground (took off ${lowAbove.toFixed(1)} m above), moved ${movedBy.toFixed(2)} m off the house's ` +
    `middle to ${o.e.toFixed(1)} m east and ${o.n.toFixed(1)} m north, ${q.solid.clear ? 'clear of it' : 'not clear of it'}, over the house at least ` +
    `${overRoof(w)}, heading ${(turn(q.camera.yaw, low.camera.yaw) / DEG).toFixed(4)}° off (${w.plan?.kind ?? 'no plan'})`);
  return results;
}
