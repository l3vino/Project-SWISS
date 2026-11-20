/* autoscale-test.mjs — the render scale kept to a frame rate (js/engine/autoscale.js), with a GPU whose time goes
 * with the pixels drawn (the scale squared).
 *
 *   node tools/autoscale-test.mjs
 */
import { AutoScale, AUTO_LEAST } from '../js/engine/autoscale.js';

let failures = 0;
const report = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'pass' : 'FAIL'}  ${name}: ${detail}`); };
const run = (a, fullMs, frames) => {
  const scales = [];
  for (let i = 0; i < frames; i++) {
    a.feed(fullMs * a.effective ** 2 * (1 + 0.04 * Math.sin(i)));
    scales.push(a.effective);
  }
  return scales;
};
const changesIn = (scales) => scales.reduce((n, s, i) => n + (i && s !== scales[i - 1] ? 1 : 0), 0);

{
  // His laptop: 25 ms a frame at full size, 60 fps aimed for: down to what fits, within a second, then steady.
  const a = new AutoScale();
  const s = run(a, 25, 600);
  const at60 = s.findIndex((x) => 25 * x * x <= 1000 / 60);
  const end = s[s.length - 1], gpu = 25 * end * end;
  report('a GPU too slow for the frame rate: down to what fits, then steady', gpu <= 1000 / 60 && gpu >= 0.55 * 1000 / 60 && at60 >= 0 && at60 <= 60 && changesIn(s.slice(120)) === 0,
    `scale ${end.toFixed(2)} (GPU ${gpu.toFixed(1)} ms of ${(1000 / 60).toFixed(1)}), fitting after ${at60} frames, ${changesIn(s)} changes in all, none after the first 120 frames`);
  // The view gets lighter (the GPU's time a third): back up to his scale, a step at a time.
  const back = run(a, 8, 1500);
  report('lighter again: back up to his own scale', back[back.length - 1] === 1 && changesIn(back) <= 8,
    `scale ${back[back.length - 1].toFixed(2)} after ${back.length} frames, ${changesIn(back)} steps`);
}
{
  // A GPU that keeps up: his scale all along, never changed.
  const a = new AutoScale();
  const s = run(a, 9, 600);
  report('a GPU that keeps up: his scale, untouched', s.every((x) => x === 1), `scale ${s[s.length - 1]} after 600 frames, ${changesIn(s)} changes`);
}
{
  // Far too slow: never under its least; off: his scale whatever the GPU.
  const a = new AutoScale();
  const s = run(a, 200, 600);
  report('far too slow: no lower than its least', s[s.length - 1] === AUTO_LEAST, `scale ${s[s.length - 1]}`);
  const b = new AutoScale();
  b.enabled = false;
  b.most = 0.8;
  const t = run(b, 50, 300);
  report('off: his own scale whatever the GPU', t.every((x) => x === 0.8), `scale ${t[t.length - 1]}`);
}
{
  // His own scale is its most; 30 fps aimed for asks for less.
  const a = new AutoScale();
  a.most = 0.9; a.target = 30; a.reset();
  const s = run(a, 25, 600);
  report('30 fps aimed for: his 0.9 kept where 25 ms fits 33 ms', s.every((x) => x === 0.9), `scale ${s[s.length - 1]}`);
}

console.log(failures ? `${failures} FAILED` : 'all passed');
process.exitCode = failures ? 1 : 0;
