/* build.js — which delivery these files are.
 *
 * Every thread reports it at start (main.js shows it on the loading screen
 * and in any error), and index.html carries the same value in `data-build`:
 * if they differ, the browser or the local server handed out old copies of
 * some files, which is said plainly instead of running a mixture.
 * tools/manifest.mjs checks the two agree and lists every file of the app in
 * files.json, which index.html revalidates before anything runs.
 */
export const BUILD = '5.7b';
