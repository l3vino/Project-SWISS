/* materials.js — the names buildings are described with, shared by the
 * decode threads that describe them (appearance.js) and the render thread
 * that draws them.
 *
 * The order is the contract: a material's index is its layer in the texture
 * array materials.wgsl draws and the M_ constants in buildings.wgsl; an
 * opening style's index is an O_ constant there.
 */

export const MATERIALS = ['plaster', 'roughcast', 'rubble', 'ashlar', 'brick', 'boards', 'logs', 'concrete', 'metal'];

/* A base material of this value means none: the wall runs down to the ground. */
export const NO_BASE = 15;

export const OPENINGS = ['none', 'residential', 'office', 'industrial', 'sacred', 'barn', 'historic', 'chalet'];
