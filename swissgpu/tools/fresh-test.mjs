/* fresh-test.mjs — after an update, the app runs the new files, whatever the
 * local server says about caching.
 *
 *   xvfb-run -a node tools/fresh-test.mjs
 *
 * Never loaded by the app. Serves a copy of the app the way some local
 * servers do — a Last-Modified long in the past and no Cache-Control, which
 * lets the browser reuse its copies for days without asking (heuristic
 * freshness) — and answers revalidations by content (ETag). Loads the app,
 * changes the build number in the copy (as an update does), reloads, and
 * reads what every thread reports (main.js refuses to start on a mixture).
 * Runs twice: with index.html as shipped (every file revalidated before
 * start), and with the plain module tag older builds had, which must show
 * the stale copies, or the test proves nothing.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ||
  '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.wgsl': 'text/plain', '.json': 'application/json' };
const LONG_AGO = new Date(Date.now() - 30 * 86400e3).toUTCString();

async function variant(name, plainTag) {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-'));
  for (const part of ['index.html', 'files.json', 'css', 'js', 'wasm', 'vendor']) cpSync(join(ROOT, part), join(dir, part), { recursive: true });
  const html = join(dir, 'index.html');
  if (plainTag) {
    writeFileSync(html, readFileSync(html, 'utf8').replace(/<script type="module">[\s\S]*?<\/script>/, '<script type="module" src="js/main.js"></script>'));
  }
  let served = 0;
  const server = http.createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    let body;
    try { body = readFileSync(join(dir, path || 'index.html')); } catch { res.writeHead(404); res.end(); return; }
    const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'last-modified': LONG_AGO }); res.end(); return; }
    served++;
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', etag, 'last-modified': LONG_AGO });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface'] });
  const page = await (await browser.newContext({ viewport: { width: 640, height: 400 } })).newPage();
  // Every thread's build, or the refusal to start on a mixture.
  const state = async () => {
    for (let i = 0; i < 180; i++) {
      const s = await page.evaluate(() => ({
        error: document.getElementById('boot-error')?.hidden === false ? document.getElementById('boot-error').textContent : null,
        sub: document.querySelector('.boot__sub')?.textContent,
        up: Boolean(globalThis.swissgpu),
      })).catch(() => null);
      if (s && (s.error || s.up)) return s;
      await page.waitForTimeout(500);
    }
    return { error: 'did not start within 90 s' };
  };
  await page.goto(url);
  const first = await state();
  // An update: a new build number in every place it lives.
  const bump = (file, from, to) => writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf8').split(from).join(to));
  const build = /BUILD = '([^']+)'/.exec(readFileSync(join(dir, 'js/build.js'), 'utf8'))[1];
  const next = `${build}-next`;
  bump('js/build.js', `'${build}'`, `'${next}'`);
  bump('index.html', `data-build="${build}"`, `data-build="${next}"`);
  bump('files.json', `"build": "${build}"`, `"build": "${next}"`);
  const before = served;
  await page.reload();
  const second = await state();
  await browser.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  return { name, first, second, refetched: served - before, next };
}

const shipped = await variant('as shipped', false);
const plain = await variant('plain module tag', true);
const okShipped = !shipped.first.error && !shipped.second.error && shipped.second.sub?.includes(shipped.next);
const staleShown = Boolean(plain.second.error?.includes('old copies'));
console.log(`as shipped: first start ${shipped.first.error ?? 'ok'}; after the update ${shipped.second.error ?? `ok, ${shipped.second.sub}`}; ` +
  `${shipped.refetched} files fetched again`);
console.log(`plain module tag (older builds): after the update ${plain.second.error ?? 'started'}; ${plain.refetched} files fetched again`);
console.log(okShipped && staleShown
  ? 'pass  after an update every thread runs the new files, where the plain tag ran stale copies'
  : `FAIL  ${okShipped ? '' : 'the shipped page did not start on the new files; '}${staleShown ? '' : 'the plain tag did not show stale copies, so this server does not reproduce the problem'}`);
process.exit(okShipped && staleShown ? 0 : 1);
