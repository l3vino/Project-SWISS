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
 * there like an aircraft, setting off straight ahead the way the camera
 * faces, banking into its turns, turning smoothly, and arriving moving and
 * facing the way the camera faced at the pick, level, at the same height
 * above the ground; with the flight turned off it is there at once; a short
 * hop straight ahead flies straight there; a walker lands on the ground next
 * to the house an address points into and walks on, and a low flight ends
 * at its height outside the house.
 */

import { PLACES, height } from '../mock-data.mjs';
import { houseInfo, HOUSE_HALF } from '../mock-buildings.mjs';

const KEY = { FORWARD: 1 };
const M_PER_DEG_LAT = 111_132;
const DEG = Math.PI / 180;
const EYE = 1.75 * 0.936;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const turn = (a, b) => Math.abs(wrap(a - b));

export async function run(page, { shot } = {}) {
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

  /* 2. Graphics tab: a segmented choice and a distance slider. */
  await page.click('.menu__tab[data-tab="graphics"]');
  await wait(300);
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
   * the flight sets off straight ahead the way the camera faces, banks into
   * its turns (it starts facing away from the place and down, so there is a
   * lot of turning), turns smoothly, and arrives moving and facing exactly
   * the way the camera faced at the pick, level, at the same height above
   * the ground. */
  const street = PLACES.national[1];
  await send('camera', { state: { lon: street.lon, lat: street.lat, height: height(street.lon, street.lat) + 300,
    yaw: -2.2, pitch: -0.45, mode: 'fly' } });
  let q0 = await until((r) => r.physicsGround?.accurate && Math.abs(r.camera.lat - street.lat) < 1e-9, 180000, 300);
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
  /* Watches a flight from `start` until it is over: which way it set off
   * and whether the view turned meanwhile, the fastest the heading turns,
   * the bank (and whether it ever leans against the turn), the direction
   * travelled along the final straight, the highest it goes above the ground
   * below, and the phases it went through. */
  const watchFlight = async (start) => {
    const w = { sawFlight: false, offStart: 0, setOff: 0, startTurn: 0, rate: 0, bank: 0, banked: 0, against: 0,
      stretch: 0, headingErr: 0, peak: -Infinity, phases: new Set() };
    let last = null, lastStretch = false;
    const q = await until((r) => {
      const f = r.flight;
      if (f?.active) {
        w.sawFlight = true;
        w.phases.add(f.phase);
        const ground = r.physicsGround?.accurate ? r.physicsGround.height : f.ground;
        w.peak = Math.max(w.peak, r.camera.height - ground);
        const e = (r.camera.lon - start.camera.lon) * M_PER_DEG_LAT * Math.cos(start.camera.lat * DEG);
        const n = (r.camera.lat - start.camera.lat) * M_PER_DEG_LAT;
        const moved = Math.hypot(e, n);
        if (f.phase === 'flight' && moved > 0.3 && moved < 15) {
          w.offStart = Math.max(w.offStart, turn(Math.atan2(e, n), start.camera.yaw));
          w.startTurn = Math.max(w.startTurn, turn(r.camera.yaw, start.camera.yaw));
          w.setOff++;
        }
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
        if (f.lastStretch && lastStretch) {
          w.headingErr = Math.max(w.headingErr, turn(f.heading, start.camera.yaw));
          w.stretch++;
        }
        lastStretch = f.lastStretch;
        last = r;
      }
      return w.sawFlight && r.flight && !r.flight.active;
    }, 1500000, 60);
    return { q, w };
  };
  const pickedTestd = await pickResult('Testd');
  const relocked = await waitLock(true);
  check('picking a result takes the mouse back', relocked.locked, relocked.locked ? 'locked' : 'still free');
  let { q: arrived, w } = await watchFlight(pickedTestd);
  q = arrived;
  const dorf = PLACES.global[0];
  const offBy = (c, p) => Math.hypot((c.lon - p.lon) * M_PER_DEG_LAT * Math.cos((p.lat * Math.PI) / 180), (c.lat - p.lat) * M_PER_DEG_LAT);
  let off = offBy(q.camera, { lon: dorf.longitude, lat: dorf.latitude });
  let above = q.physicsGround ? q.camera.height - q.physicsGround.height : NaN;
  const shape = q.flight?.shape;
  check('it sets off straight ahead, the way the camera faces', w.sawFlight && w.setOff >= 3 && w.offStart < 2 * DEG && w.startTurn < 0.5 * DEG,
    `first 15 m flown within ${(w.offStart / DEG).toFixed(2)}° of the heading over ${w.setOff} samples, ` +
    `the view turning ${(w.startTurn / DEG).toFixed(2)}° meanwhile (route ${Math.round(q.flight?.route ?? 0)} m: ` +
    `${Math.round(shape?.takeoff ?? 0)} m take-off run, turns of ${Math.round(shape?.radius ?? 0)} and ` +
    `${Math.round(shape?.radius2 ?? 0)} m radius, ${Math.round(shape?.sweep ?? 0)}° in all, ${Math.round(shape?.final ?? 0)} m final, ` +
    `cruise ${Math.round(q.flight?.cruise ?? 0)} m, ${q.flight?.duration?.toFixed(1)} s)`);
  check('it banks into its turns', w.bank > 10 * DEG && w.bank <= 28.5 * DEG && w.banked >= 5 && w.against === 0,
    `up to ${(w.bank / DEG).toFixed(1)}° of bank, leaning into the turn in ${w.banked} samples, against it in ${w.against}`);
  check('the view turns smoothly', w.rate < 60 * DEG, `fastest turn ${(w.rate / DEG).toFixed(0)}°/s`);
  check('it comes in along the start heading', w.stretch >= 3 && w.headingErr < 3 * DEG,
    `final straight flown within ${(w.headingErr / DEG).toFixed(2)}° of the start heading over ${w.stretch} samples`);
  check('it arrives facing exactly that way, level, at the same height above the ground',
    turn(q.camera.yaw, from.camera.yaw) < 1e-3 && Math.abs(q.camera.pitch - from.camera.pitch) < 1e-3 &&
    Math.abs(q.camera.roll ?? 0) < 1e-6 && off < 1 && Math.abs(above - aboveFrom) < 1.5 && q.motion.mode === 'fly',
    `heading ${from.camera.yaw.toFixed(3)} → ${q.camera.yaw.toFixed(3)}, pitch ${from.camera.pitch.toFixed(3)} → ` +
    `${q.camera.pitch.toFixed(3)}, bank ${((q.camera.roll ?? 0) / DEG).toFixed(4)}°, ${off.toFixed(2)} m from the spot, ` +
    `${above.toFixed(1)} m above its ground (took off ${aboveFrom.toFixed(1)} m above), ${q.motion.mode === 'fly' ? 'flying' : q.motion.state}`);
  await snap('arrived');

  /* 7. The flight turned off: a pick is there at once, at the same height
   * above the ground, looking the same way. */
  const flightSwitch = async () => {
    await freeMouse();
    await page.click('#gear');
    await wait(300);
    await page.click('.menu__tab[data-tab="general"]');
    await wait(300);
    await page.click('.setting--toggle:has(#setting-flyToResults) .toggle');
    await wait(300);
    await page.keyboard.press('Escape');
    await wait(300);
  };
  await flightSwitch();
  await page.click('.scope[data-scope="national"]');
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

  /* 8. A hop of 150 m straight ahead flies straight there: no turn, no bank
   * (the nose still follows the climb or descent over the slope, and comes
   * back to where it was). */
  const hopFrom = await probe();
  const hopYaw = hopFrom.camera.yaw;
  const hopTo = {
    lon: hopFrom.camera.lon + (150 * Math.sin(hopYaw)) / (M_PER_DEG_LAT * Math.cos(hopFrom.camera.lat * DEG)),
    lat: hopFrom.camera.lat + (150 * Math.cos(hopYaw)) / M_PER_DEG_LAT,
  };
  const rise = height(hopTo.lon, hopTo.lat) - height(hopFrom.camera.lon, hopFrom.camera.lat);
  await send('flyto', { lon: hopTo.lon, lat: hopTo.lat, elevation: null, label: 'Nebenan' });
  let drift = 0, hopBank = 0, nose = 0;
  q = await until((r) => {
    if (r.flight?.active) {
      drift = Math.max(drift, turn(r.camera.yaw, hopYaw));
      hopBank = Math.max(hopBank, Math.abs(r.camera.roll ?? 0));
      const tilt = r.camera.pitch - hopFrom.camera.pitch;
      if (Math.abs(tilt) > Math.abs(nose)) nose = tilt;
    }
    return r.flight && !r.flight.active && offBy(r.camera, hopTo) < 1;
  }, 600000, 60);
  check('a short hop straight ahead flies straight there', drift < 0.05 * DEG && hopBank < 0.05 * DEG &&
    offBy(q.camera, hopTo) < 1 && Math.sign(nose) === Math.sign(rise) && Math.abs(q.camera.pitch - hopFrom.camera.pitch) < 1e-3,
    `the view turned at most ${(drift / DEG).toFixed(4)}° and banked ${(hopBank / DEG).toFixed(4)}° on the way, ` +
    `nose ${nose > 0 ? 'up' : 'down'} as much as ${Math.abs(nose / DEG).toFixed(1)}° over ground ${rise > 0 ? 'rising' : 'falling'} ${Math.abs(rise).toFixed(0)} m, ` +
    `back to ${(q.camera.pitch - hopFrom.camera.pitch).toFixed(4)} rad of the start, ${offBy(q.camera, hopTo).toFixed(2)} m from the spot`);

  /* 9. Walking, a pick of an address in the middle of a house: off along
   * the street, up over the roofs, round and down onto open ground beside
   * the house, walking on, facing the same way. */
  const home = PLACES.national.find((p) => p.house);
  const H = houseInfo(...home.house);
  await send('camera', { state: { ...(await probe()).camera, yaw: 0.6, pitch: -0.05 } });
  await send('spawn', { lon: street.lon, lat: street.lat, elevation: null, label: 'street' });
  const standing = (r) => r.motion.mode === 'walk' && r.motion.state === 'standing';
  const walker = await until((r) => standing(r) && r.solid.clearedBy != null && r.buildings.pending === 0, 300000, 300);
  await freeMouse();
  const pickedHouse = await pickResult('Testhaus');
  ({ q, w } = await watchFlight(pickedHouse));
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
  check('walking, a pick lands you on the ground beside the house, walking on, facing the same way',
    standing(q) && landedFlight?.landed && q.solid.clear === true && q.solid.clearedBy < 0.05 && o.away > 4 && o.away < 15 &&
    Math.abs(feet) < 0.1 && w.peak > 45 && w.offStart < 2 * DEG && turn(q.camera.yaw, walker.camera.yaw) < 1e-3,
    `${q.motion.state}, ${o.e.toFixed(1)} m east and ${o.n.toFixed(1)} m north of the house's middle, ` +
    `${q.solid.clear ? 'clear of it' : 'not clear of it'} (moved ${q.solid.clearedBy?.toFixed(2)} m after landing), ` +
    `feet ${feet.toFixed(2)} m off the ground, set off within ${(w.offStart / DEG).toFixed(2)}° of the heading, ` +
    `up to ${w.peak.toFixed(0)} m on the way (${[...w.phases].join(', ')}; spot known ${landedFlight?.confirmed ? 'in flight' : 'late'}, ` +
    `${landedFlight?.guessed ? 'guessed' : 'found'}), heading ${(turn(q.camera.yaw, walker.camera.yaw) / DEG).toFixed(4)}° off`);

  /* 10. Flying 5 m up, the same pick ends 5 m up, clear of the house (at
   * the house's middle that height is inside its roof). */
  await send('camera', { state: { lon: street.lon, lat: street.lat, height: height(street.lon, street.lat) + 5, yaw: 0.6, pitch: -0.05, mode: 'fly' } });
  const low = await until((r) => r.physicsGround?.accurate && Math.abs(r.camera.lat - street.lat) < 1e-9, 60000, 300);
  const lowAbove = low.camera.height - low.physicsGround.height;
  await freeMouse();
  const pickedLow = await pickResult('Testhaus');
  ({ q, w } = await watchFlight(pickedLow));
  o = outOf(q, H);
  above = q.camera.height - (q.physicsGround?.height ?? NaN);
  q = await until((r) => r.solid.clear != null, 30000, 200);
  // At that height the house's middle is inside its roof, so the flight
  // has to move off it to the nearest clear spot; how far depends on the roof.
  const movedBy = q.flight ? offBy(q.flight.spot, q.flight.to) : 0;
  check('flying low, it ends at that height, clear of the house', q.motion.mode === 'fly' && q.solid.clear === true &&
    movedBy > 0.5 && o.away < 15 && Math.abs(above - lowAbove) < 1.5 && turn(q.camera.yaw, low.camera.yaw) < 1e-3,
    `${above.toFixed(1)} m above the ground (took off ${lowAbove.toFixed(1)} m above), moved ${movedBy.toFixed(2)} m ` +
    `off the house's middle to ${o.e.toFixed(1)} m east and ${o.n.toFixed(1)} m north, ${q.solid.clear ? 'clear of it' : 'not clear of it'}`);
  return results;
}
