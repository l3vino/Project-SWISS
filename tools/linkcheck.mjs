/* linkcheck.mjs — every module under js/ imported in Node (5.19a): one that imports a name another no longer
 * exports fails to link (a SyntaxError), and the thread it runs on never starts (in the browser: "could not start:
 * its script failed to load"). What a module does when it runs needs the browser, and its errors are not counted.
 * Usage: node tools/linkcheck.mjs   (wasm/test.mjs runs it)
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.js')) files.push(path);
  }
};
walk(join(root, 'js'));
// Thread modules talk to `self` as they load.
globalThis.self ??= globalThis;
globalThis.postMessage ??= () => {};
const broken = [];
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    if (err instanceof SyntaxError || /does not provide an export|ERR_MODULE_NOT_FOUND|Cannot find module/.test(String(err?.message))) {
      broken.push(`${relative(root, file)}: ${err.message}`);
    }
  }
}
console.log(broken.length ? `${broken.length} of ${files.length} modules do not link:\n${broken.join('\n')}` : `all ${files.length} modules link`);
process.exit(broken.length ? 1 : 0);
