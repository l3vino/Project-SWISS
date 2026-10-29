/* swisstopo-transport.js — swisstopo's roads and railways as the vector tiles
 * name them, and what each is drawn as. For the swisstopo adapter's `vector`
 * block (swisstopo.js); read on the decode threads (js/formats/vector-tile.js
 * turns it into the tables the C decoder reads), so plain data only.
 *
 * ch.swisstopo.base.vt's `transportation` layer (checked live 2026-10-28):
 * one line per carriageway on motorways, every rail track its own line (also
 * in tunnels), classes motorway, trunk, primary, secondary, tertiary, minor,
 * service, track, path, footway, trail, via_ferrata, rail (subclasses rail,
 * narrow_gauge, rack_rail, funicular) and transit (tram); subclass steps on
 * paths and streets; brunnel bridge/tunnel/ford with a layer from −3 to 4;
 * surface paved/unpaved; service siding; sac_scale on mountain paths. Map
 * masks (mask_*), things under construction and cableways are not kinds
 * here: masks are only a map's styling, what is being built is not there
 * yet, and cableways come from swissTLM3D's 3D tiles as ropes and pylons.
 * The subclass avalanche_protector marks a gallery and covered_bridge a
 * covered bridge on any road: they set a flag, they are no kind of their own.
 *
 * `half` is the widest a kind is ever drawn, half of it, in metres: the
 * decoder lists a segment in every grid cell that much (plus a margin) can
 * reach, so it must not be less than anything later drawn for it (the
 * widest swissTLM3D class a base.vt class turns out to be, with its edges).
 * `priority` orders what is painted over what (higher on top). `colour` is
 * the debug view's (Graphics → Diagnostics → Terrain view → Roads and rails).
 *
 * Drawn on the ground (Stage 5.15b): `width`, metres, where the road's own
 * width is not known (swissTLM3D's class for it, `widthClasses` below, near
 * the camera): the middle of the class most roads of the kind belong to
 * (measured in Zürich, Langnau and Minusio: 'minor' is the 4 m class for
 * 60 to 72%, 'secondary' the 6 m class for 97%, 'primary' mostly 10 m in
 * town and 8 m outside); `material`, how its surface is made (vector.wgsl):
 * asphalt, footway (paving in town, gravel outside), gravel, track (gravel
 * with two ruts and grass between, asphalt where paved), dirt, steps.
 * Railways are not drawn yet (5.17b) but where one crosses a drawn road:
 * `gauge`, metres between its rails (standard 1.435, metre gauge 1.0, the
 * Swiss trams' 1.0), sets its rails into the road there.
 * Shaped into the terrain (wasm/src/shape.c): `bench`, metres of level
 * ground beyond the drawn width on either side (verges, ballast); `grade`,
 * the steepest the line may climb, which smooths out what a coarse terrain
 * tile gets wrong along it (Swiss design limits: motorways 6 to 8%, main
 * roads 10 to 12%, standard-gauge railways 4%, rack railways 25%).
 */

export const TRANSPORT = {
  id: 'swisstopo-transport',
  revision: 4,
  layer: 'transportation',
  // Buildings per hectare round a street (the 150 m or so round its
  // middle) from which it counts as in town, where the Swiss rules paint
  // centre lines 3/3 m and no edge lines. 4 a hectare: 88 to 98% of the
  // streets of Zürich, Bern, Bellinzona, Locarno and Langnau, 78% of
  // Göschenen's, and the open country round Airolo not. Zoom 13's building
  // layer keeps only the larger buildings (23% of them in Zürich), so it
  // needs fewer: 0.8 gives Zürich the same 92%. (Measured 2026-10-28.)
  density: { layer: 'building', town: 4, townByZoom: { 13: 0.8 } },
  fields: {
    class: 'class', subclass: 'subclass', brunnel: 'brunnel', layer: 'layer', surface: 'surface',
    service: 'service', oneway: 'oneway', ramp: 'ramp', sac: 'sac_scale',
  },
  values: {
    brunnel: { bridge: 1, tunnel: 2, ford: 3 },
    surface: { paved: 1, unpaved: 2 },
    service: { siding: 1, yard: 2, spur: 3, crossover: 4 },
    sac: { hiking: 1, mountain_hiking: 2, demanding_mountain_hiking: 3, alpine_hiking: 4,
      demanding_alpine_hiking: 5, difficult_alpine_hiking: 6 },
  },
  // Subclasses that only mark something about a road of any class.
  flags: { avalanche_protector: 1, covered_bridge: 2 },
  // First match wins: a rule with a subclass before the class's own rule.
  kinds: [
    { id: 'steps', subclass: 'steps', family: 'road', half: 2, priority: 29, colour: '#f4f4f4',
      width: 2, material: 'steps', bench: 0.2, grade: 1.0 },
    { id: 'motorway', class: 'motorway', family: 'road', half: 8, priority: 50, colour: '#e040e0',
      width: 11, material: 'asphalt', bench: 1.0, grade: 0.08 },
    { id: 'trunk', class: 'trunk', family: 'road', half: 6, priority: 48, colour: '#c050f0',
      width: 9, material: 'asphalt', bench: 0.8, grade: 0.10 },
    { id: 'primary', class: 'primary', family: 'road', half: 8, priority: 46, colour: '#ff5030',
      width: 9.2, material: 'asphalt', bench: 0.6, grade: 0.12 },
    { id: 'secondary', class: 'secondary', family: 'road', half: 5, priority: 44, colour: '#ff9020',
      width: 7.2, material: 'asphalt', bench: 0.5, grade: 0.14 },
    { id: 'tertiary', class: 'tertiary', family: 'road', half: 4, priority: 42, colour: '#ffd020',
      width: 5.2, material: 'asphalt', bench: 0.5, grade: 0.16 },
    { id: 'minor', class: 'minor', family: 'road', half: 5, priority: 40, colour: '#40e0ff',
      width: 5.2, material: 'asphalt', bench: 0.4, grade: 0.18 },
    { id: 'service', class: 'service', family: 'road', half: 3, priority: 38, colour: '#4090ff',
      width: 3.5, material: 'asphalt', bench: 0.3, grade: 0.20 },
    { id: 'track', class: 'track', family: 'road', half: 2.5, priority: 30, colour: '#40c040',
      width: 3, material: 'track', bench: 0.3, grade: 0.25 },
    { id: 'footway', class: 'footway', family: 'road', half: 2, priority: 28, colour: '#a0ffa0',
      width: 2, material: 'footway', bench: 0.2, grade: 0.35 },
    { id: 'path', class: 'path', family: 'road', half: 1.5, priority: 26, colour: '#80d060',
      width: 1.5, material: 'dirt', bench: 0.2, grade: 0.6 },
    { id: 'trail', class: 'trail', family: 'road', half: 0.8, priority: 24, colour: '#c0e080',
      width: 0.8, material: 'dirt', bench: 0.15, grade: 1.0 },
    { id: 'via_ferrata', class: 'via_ferrata', family: 'road', half: 0.6, priority: 22, colour: '#ff80c0' },
    { id: 'rail', class: 'rail', subclass: 'rail', family: 'rail', half: 2.5, priority: 60, colour: '#ffff30',
      width: 3.4, bench: 1.3, grade: 0.04, shape: true, gauge: 1.435 },
    { id: 'narrow_gauge', class: 'rail', subclass: 'narrow_gauge', family: 'rail', half: 2, priority: 59, colour: '#ffc000',
      width: 2.8, bench: 1.0, grade: 0.07, shape: true, gauge: 1.0 },
    { id: 'rack', class: 'rail', subclass: 'rack_rail', family: 'rail', half: 2, priority: 58, colour: '#ff8000',
      width: 2.8, bench: 1.0, grade: 0.25, shape: true, gauge: 1.0 },
    { id: 'funicular', class: 'rail', subclass: 'funicular', family: 'rail', half: 2, priority: 57, colour: '#ff60a0',
      width: 2.4, bench: 0.6, grade: 1.0, shape: true, gauge: 1.0 },
    { id: 'rail_other', class: 'rail', family: 'rail', half: 2.5, priority: 56, colour: '#e0e060',
      width: 3.4, bench: 1.3, grade: 0.06, shape: true, gauge: 1.435 },
    { id: 'tram', class: 'transit', subclass: 'tram', family: 'rail', half: 1.5, priority: 62, colour: '#b080ff', gauge: 1.0 },
    { id: 'transit_other', class: 'transit', family: 'rail', half: 1.5, priority: 61, colour: '#9070ff', gauge: 1.0 },
  ],
  // swissTLM3D's road classes (OBJEKTART, catalogue 2.4) as the widths
  // drawn, the middle of each class's range: a segment matched to a TLM
  // road near the camera carries its class's number (1-15, 0 none: the
  // kind's width). Classes without a width (connections, accesses,
  // squares) leave the kind's width.
  widthClasses: {
    widths: [0, 11.0, 9.2, 7.2, 5.2, 3.5, 2.3, 1.2, 6.0, 9.0, 0.8],
    objektart: { 8: 1, 20: 2, 9: 3, 10: 4, 11: 5, 15: 6, 16: 7, 17: 7, 18: 7, 0: 8, 1: 8, 2: 1, 21: 9, 19: 10 },
  },
};
