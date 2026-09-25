/* ui.mjs — the settings menu and the flight to a search result, for
 * tools/verify.mjs --scenario ui.
 *
 * Drives the menu through the real page the way a person would: the Settings
 * button, tabs, a switch, a segmented choice, a slider, a key rebinding and
 * Escape. Each is checked against the stored setting it should change and
 * the effect it should have. Then a flight to a place from a search pick:
 * it has to climb, arrive, and leave you standing on the ground there.
 */

const KEY = { FORWARD: 1 };

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

  /* 5. A flight to a place: up, over, down, standing on the ground there. */
  const from = await probe();
  const target = { lon: from.camera.lon + 0.03, lat: from.camera.lat + 0.01 };
  await send('flyto', { lon: target.lon, lat: target.lat, elevation: null, label: 'Testplatz' });
  let peak = 0, sawFlight = false;
  q = await until((r) => {
    if (r.motion.state.startsWith('flying to')) sawFlight = true;
    peak = Math.max(peak, r.camera.height);
    return sawFlight && r.motion.mode === 'walk' && r.motion.state === 'standing';
  }, 240000, 100);
  const off = Math.hypot((q.camera.lon - target.lon) * 77000, (q.camera.lat - target.lat) * 111000);
  check('a search pick flies there and lands you standing', sawFlight && q.motion.state === 'standing' && off < 1,
    `flew (${sawFlight ? 'seen' : 'not seen'}), climbed to ${Math.round(peak)} m, now ${q.motion.state} ${off.toFixed(2)} m from the spot`);
  await snap('landed');
  return results;
}
