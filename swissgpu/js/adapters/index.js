/* index.js — every country the viewer knows about.
 *
 * Imported by both the page thread and the render thread. Adapters are static
 * data, so importing the module twice is cheaper and safer than serialising
 * them across a postMessage.
 */

import { registry } from './registry.js';
import { swisstopo } from './swisstopo.js';
import { openMeteo } from './open-meteo.js';

registry.register(swisstopo);
registry.register(openMeteo);

export { registry };
