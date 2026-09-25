/* swisstopo-buildings.js — how Swiss buildings look, for the swisstopo adapter.
 *
 * Plain data, read by js/engine/features/appearance.js on the decode threads
 * (so it must survive structured cloning: no functions). A look is what a
 * kind of building is made of and how its walls open; the rules pick one per
 * building from what swissBUILDINGS3D says about it (its OBJEKTART, whether
 * it has an EGID, which the federal register gives mainly to buildings people
 * live or work in) and from its shape as measured on arrival: height, eaves,
 * footprint, how much of the roof is pitched, and the altitude it stands at.
 * The first matching rule wins.
 *
 * The regions are rough outlines, drawn loosely over the border where no
 * Swiss building stands anyway: the Italian-speaking south, where render is
 * warm-coloured and old houses are bare stone, and the French-speaking west,
 * with its stone surrounds and pale limestone tones.
 *
 * Colours are sRGB, as a paint chart would give them.
 */

const REGIONS = {
  south: [
    [8.33, 46.30], [8.36, 46.45], [8.45, 46.53], [8.57, 46.58], [8.70, 46.60], [8.83, 46.60],
    [8.97, 46.61], [9.10, 46.56], [9.22, 46.51], [9.33, 46.50], [9.45, 46.45], [9.60, 46.43],
    [9.73, 46.41], [9.85, 46.36], [10.00, 46.43], [10.13, 46.44], [10.25, 46.37], [10.20, 46.20],
    [9.90, 46.10], [9.40, 45.95], [9.05, 45.80], [8.85, 45.80], [8.55, 45.95], [8.40, 46.15],
  ],
  west: [
    [5.90, 46.10], [5.90, 47.50], [7.00, 47.52], [7.55, 47.45], [7.45, 47.25], [7.25, 47.14],
    [7.15, 46.98], [7.20, 46.80], [7.25, 46.60], [7.25, 46.45], [7.45, 46.35], [7.60, 46.28],
    [7.60, 46.00], [6.80, 45.80],
  ],
};

const PALETTES = {
  // The plateau and the north: white and cream, sand and pale grey, now and
  // then a pastel.
  render: ['#ebe8e0', '#f1eee6', '#e7e1d1', '#ddd6c6', '#d9d5cd', '#e9ddc1', '#dacaa9', '#d0c9be',
    '#e5d8c8', '#cac5bb', '#ddd3b1', '#e3d0ba', '#c0c5bc', '#c5cacd', '#e8e2cf', '#d6cfc0'],
  // South of the Alps: ochre, straw, salmon, terracotta, rose, sage.
  renderSouth: ['#e9ca90', '#daa96d', '#e7b99b', '#dda18c', '#e9d0c1', '#d7927b', '#f0e4c9', '#f2efe6',
    '#cacfb9', '#e4d49d', '#d0906b', '#e7ddca', '#bab4a5', '#dac4a2', '#e3b58a', '#d9b8a6'],
  // The west: limestone, cream, the yellow stone of Neuchâtel, grey.
  renderWest: ['#e5ddcc', '#d9ceb6', '#e9e1cd', '#d0c7b5', '#e3d4aa', '#d6d3cc', '#c9c1b1', '#ece8de'],
  // Flats and offices of the last decades: white, greys, a little beige.
  modern: ['#e7e6e1', '#d9d9d5', '#c0c2c2', '#a0a3a5', '#8d8b87', '#cac4b9', '#f0efea', '#b7b3aa'],
  gneiss: ['#908b81', '#9b958b', '#807b73', '#a49d90', '#8b8479', '#77746e'],
  sandstone: ['#c0b29b', '#cac0a9', '#a99d87', '#d5cab1', '#9d9589'],
  brick: ['#8f4b37', '#9c5b41', '#7e4030', '#a9674b', '#6f3b2d'],
  larch: ['#5b3e29', '#4b3323', '#6c4b31', '#3f2b1e', '#7b6b5b', '#6f5b45'],
  concrete: ['#a9a69f', '#b6b3ab', '#9d9b95', '#c1beb6', '#8f8e8a'],
  cladding: ['#b9bdc0', '#8f969a', '#d9dad7', '#70808d', '#7e8b79', '#a34b3b', '#c8c2b0'],
  glass: ['#6f8a94', '#5e7280', '#7d8c84', '#8a8272', '#55606a'],
};

const LOOKS = {
  hidden: { kind: 'hidden' },
  default: { material: 'plaster', palette: 'render', openings: 'residential', shutters: 0.35,
    surrounds: 0.15, overhang: 0.6, base: 'ashlar' },
  house: { material: 'plaster', palette: 'render', openings: 'residential', shutters: 0.35,
    surrounds: 0.15, overhang: 0.6, base: 'ashlar' },
  houseSouth: { material: ['plaster', 'roughcast'], palette: 'renderSouth', openings: 'residential',
    shutters: 0.6, surrounds: 0.55, overhang: 0.5, base: 'rubble' },
  houseWest: { material: 'plaster', palette: 'renderWest', openings: 'residential', shutters: 0.6,
    surrounds: 0.5, overhang: 0.5, base: 'ashlar' },
  flats: { material: 'plaster', palette: 'modern', openings: 'residential', shutters: 0.1,
    surrounds: 0, overhang: 0.25, base: 'concrete' },
  rustico: { material: 'rubble', palette: 'gneiss', openings: 'historic', shutters: 0.3,
    surrounds: 0, overhang: 0.4 },
  chalet: { material: ['logs', 'boards'], palette: 'larch', openings: 'chalet', shutters: 0.65,
    surrounds: 0, overhang: 1.25, base: { material: 'plaster', storey: true } },
  barn: { material: 'boards', palette: 'larch', openings: 'barn', overhang: 1.0,
    base: { material: ['rubble', 'plaster'], storey: true } },
  outbuilding: { material: ['plaster', 'boards', 'concrete'], palette: { boards: 'larch', concrete: 'concrete', default: 'render' },
    openings: 'none', overhang: 0.3 },
  office: { material: ['concrete', 'plaster', 'metal'], palette: { metal: 'cladding', default: 'modern' }, openings: 'office', overhang: 0.1 },
  tower: { kind: 'glass', palette: 'glass', overhang: 0 },
  industrial: { material: ['metal', 'concrete'], palette: { concrete: 'concrete', default: 'cladding' }, openings: 'industrial', overhang: 0.3 },
  church: { material: 'plaster', palette: 'render', openings: 'sacred', overhang: 0.4, base: 'ashlar' },
  churchSouth: { material: ['plaster', 'rubble'], palette: { rubble: 'gneiss', default: 'renderSouth' }, openings: 'sacred',
    overhang: 0.3, base: 'rubble' },
  belltower: { material: ['ashlar', 'plaster'], palette: { plaster: 'render', default: 'sandstone' }, openings: 'none', overhang: 0.2 },
  castle: { material: 'rubble', palette: 'gneiss', openings: 'historic', overhang: 0 },
  wall: { kind: 'plain', material: 'ashlar', palette: 'sandstone', openings: 'none', overhang: 0 },
  wallSouth: { kind: 'plain', material: 'rubble', palette: 'gneiss', openings: 'none', overhang: 0 },
  chimney: { kind: 'plain', material: 'brick', palette: 'brick', openings: 'none', overhang: 0 },
  tank: { kind: 'plain', material: 'metal', palette: 'cladding', openings: 'none', overhang: 0 },
  concrete: { kind: 'plain', material: 'concrete', palette: 'concrete', openings: 'none', overhang: 0 },
  canopy: { kind: 'plain', material: 'metal', palette: 'cladding', openings: 'none', overhang: 0 },
  shed: { kind: 'plain', material: 'boards', palette: 'larch', openings: 'none', overhang: 0.5 },
  greenhouse: { kind: 'glass', palette: 'glass', overhang: 0 },
  coveredBridge: { kind: 'plain', material: 'boards', palette: 'larch', openings: 'none', overhang: 0.3 },
  skybridge: { kind: 'glass', palette: 'glass', overhang: 0 },
};

export const BUILDING_APPEARANCE = {
  regions: REGIONS,
  palettes: PALETTES,
  looks: LOOKS,
  rules: [
    { type: ['Unterirdisches Gebaeude', 'Gebaeude unsichtbar'], look: 'hidden' },
    { type: 'Treibhaus', look: 'greenhouse' },
    { type: ['Verbindungsbruecke', 'Verbindungsbrücke'], look: 'skybridge' },
    { type: 'Bruecke gedeckt', look: 'coveredBridge' },
    { type: 'Hochkamin', look: 'chimney' },
    { type: 'Lagertank', look: 'tank' },
    { type: ['Kuehlturm', 'Lueftungsschacht', 'Im Bau'], look: 'concrete' },
    { type: 'Flugdach', look: 'canopy' },
    { type: 'Offenes Gebaeude', look: 'shed' },
    { type: ['Mauer gross', 'Mauer gross gedeckt'], region: 'south', look: 'wallSouth' },
    { type: ['Mauer gross', 'Mauer gross gedeckt'], look: 'wall' },
    { type: ['Sakraler Turm', 'Turm'], look: 'belltower' },
    { type: 'Historische Baute', look: 'castle' },
    { type: ['Sakrales Gebaeude', 'Kapelle'], region: 'south', look: 'churchSouth' },
    { type: ['Sakrales Gebaeude', 'Kapelle'], look: 'church' },
    { type: 'Hochhaus', height: [45], look: 'tower', chance: 0.5 },
    { type: 'Hochhaus', look: 'office' },
    // Big, low and flat: halls, warehouses, factories.
    { footprint: [1500], eaves: [null, 16], pitched: [null, 0.3], look: 'industrial' },
    // Garages and sheds the building register does not list.
    { hasId: false, footprint: [null, 45], height: [null, 4.5], look: 'outbuilding' },
    // Farm buildings: no register entry, a big pitched roof on low walls.
    { hasId: false, footprint: [120], eaves: [null, 7], pitched: [0.5], look: 'barn' },
    // Mountain houses: wood on a rendered ground floor.
    { altitude: [1150], footprint: [null, 600], pitched: [0.5], look: 'chalet', chance: 0.8 },
    // Old stone houses of the southern valleys, above the lakeside towns.
    { region: 'south', altitude: [300], footprint: [null, 110], height: [null, 10], pitched: [0.5], look: 'rustico', chance: 0.5 },
    // Flat-roofed blocks: flats and offices of the last decades.
    { pitched: [null, 0.3], height: [9], look: 'flats' },
    { region: 'south', look: 'houseSouth' },
    { region: 'west', look: 'houseWest' },
    { look: 'house' },
  ],
};

/* swissTLM3D's objects: bridges, dams, galleries, walls and the like. The
 * ordinary buildings it also holds are the building layer's to draw. Its
 * exact type names are not published with the tiles, so walls and dams are
 * recognised by the words in them; the console lists the types it meets. */
export const STRUCTURE_APPEARANCE = {
  regions: REGIONS,
  palettes: { concrete: PALETTES.concrete, gneiss: PALETTES.gneiss, sandstone: PALETTES.sandstone },
  looks: { hidden: { kind: 'hidden' }, default: LOOKS.concrete, wall: LOOKS.wall, wallSouth: LOOKS.wallSouth },
  rules: [
    { type: ['Gebaeude', 'Gebaeude Einzelhaus', 'Hochhaus', 'Historische Baute', 'Sakrales Gebaeude',
      'Kapelle', 'Treibhaus', 'Offenes Gebaeude', 'Gebaeude unsichtbar', 'Unterirdisches Gebaeude'], look: 'hidden' },
    { typeHas: ['Staumauer', 'Staudamm', 'Wehr', 'Laermschutz', 'Lärmschutz'], look: 'default' },
    { typeHas: 'Mauer', region: 'south', look: 'wallSouth' },
    { typeHas: 'Mauer', look: 'wall' },
  ],
};
