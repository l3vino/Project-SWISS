/* manifest.mjs — the list of the app's files, and the build number in sync.
 *
 *   node tools/manifest.mjs           # writes files.json, updates index.html
 *   node tools/manifest.mjs --check   # exits 1 if either is out of date
 *
 * Never loaded by the app. Run before every delivery.
 *
 * index.html revalidates every file in files.json before the app starts, so
 * a browser never runs old copies of some modules next to new ones (a local
 * server that sends no caching headers lets it keep old copies for a while
 * after an update). The build number lives in js/build.js; index.html
 * carries it in `data-build` (compared at start with every thread's) and on
 * its stylesheet URL.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');

/* What the app loads: its stylesheet, modules and shaders, the compiled
 * core, and the vendored decoders. Not the tools, sources or docs. */
const INCLUDE = [
  { dir: 'css', ext: ['.css'] },
  { dir: 'js', ext: ['.js', '.wgsl', '.json'] },
  { dir: 'wasm', ext: ['.wasm'], flat: true },
  { dir: 'vendor', ext: ['.js', '.mjs', '.wasm'] },
];

function walk(dir, ext, flat, out) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) { if (!flat) walk(path, ext, flat, out); continue; }
    if (ext.some((e) => name.endsWith(e))) out.push(path.split(sep).join('/'));
  }
  return out;
}

const files = INCLUDE.flatMap(({ dir, ext, flat }) => walk(dir, ext, flat, []));
const build = /BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(ROOT, 'js/build.js'), 'utf8'))?.[1];
if (!build) throw new Error('js/build.js has no BUILD');
const manifest = `${JSON.stringify({ build, files }, null, 1)}\n`;

const htmlPath = join(ROOT, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const synced = html
  .replace(/<html lang="en"( data-build="[^"]*")?>/, `<html lang="en" data-build="${build}">`)
  .replace(/href="css\/ui\.css(\?v=[^"]*)?"/, `href="css/ui.css?v=${build}"`);

let current = '';
try { current = readFileSync(join(ROOT, 'files.json'), 'utf8'); } catch { /* none yet */ }

if (check) {
  const problems = [];
  if (current !== manifest) problems.push('files.json is out of date');
  if (synced !== html) problems.push('index.html does not carry the build number');
  if (problems.length) { console.error(`${problems.join('; ')}: run node tools/manifest.mjs`); process.exit(1); }
  console.log(`build ${build}: ${files.length} files listed, index.html in step`);
} else {
  writeFileSync(join(ROOT, 'files.json'), manifest);
  if (synced !== html) writeFileSync(htmlPath, synced);
  console.log(`build ${build}: ${files.length} files listed in files.json; index.html ${synced !== html ? 'updated' : 'already in step'}`);
}
