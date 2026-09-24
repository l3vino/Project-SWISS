/* swisstopo.js — Switzerland, from the Federal Spatial Data Infrastructure.
 *
 * Every endpoint below is public, key-less and CORS-enabled.
 * Terms: https://www.geo.admin.ch/en/general-terms-of-use-fsdi
 */

import { defineAdapter } from './adapter.js';

export const swisstopo = defineAdapter({
  id: 'swisstopo',
  label: 'Switzerland',
  attribution: '© swisstopo',
  attributionUrl: 'https://www.geo.admin.ch/en/general-terms-of-use-fsdi',

  // Outranks any future continental or global source over the same ground.
  priority: 100,

  // Slightly wider than the border so edge tiles are not clipped away.
  bounds: [5.75, 45.7, 10.6, 47.9],

  // Well above the ridgeline, so the first frame is the region rather than
  // the side of whichever mountain happens to be nearest.
  home: { lon: 8.7943, lat: 46.1712, height: 6000, label: 'Locarno' },

  /**
   * Cesium Quantized Mesh 1.0 over a TMS global-geodetic grid, rebuilt from
   * swissALTI3D (0.5 to 2 m) in May 2025, levels 0 to 18. A triangulated mesh
   * rather than a raster heightmap, so vertices already sit where the terrain
   * needs them: cliffs cost triangles, flat lake surfaces cost almost none.
   */
  terrain: {
    codec: 'quantized-mesh',
    crs: 'EPSG:4326',
    // No tile URL here on purpose. The service files its tiles under a dated
    // directory that changes whenever swissALTI3D is reprocessed, and
    // layer.json is what publishes the current one along with the level range
    // and the cache-busting version. Read it, do not guess it.
    //
    // layer.json declares global bounds, so coverage comes from this
    // adapter's own bounds. Which finer tiles exist inside them is published
    // by the tiles themselves (every tenth level carries it), and the loader
    // reads it from there; see js/engine/terrain/source.js.
    layerJson: 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json',
  },

  /**
   * SWISSIMAGE via WMTS REST in Web Mercator. Mercator is the best-supported
   * matrix set here and reaches 0.25 m at zoom 27; the mismatch with geodetic
   * terrain is resolved analytically per vertex, not by reprojecting pixels.
   */
  imagery: {
    crs: 'EPSG:3857',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    tileSize: 256,
    minLevel: 8,
    maxLevel: 20,
    format: 'image/jpeg',
  },

  /**
   * 3D Tiles sets. `kind` picks how the engine draws a set ('buildings' sets
   * are drawn and solid); `setting` is the Layers switch it answers to. The
   * sets of other kinds are declared for the steps that add them.
   */
  features: [
    {
      id: 'buildings', label: 'Buildings', kind: 'buildings', codec: 'b3dm',
      // swissBUILDINGS3D: nested tilesets of b3dm tiles, LOD2 roof shapes.
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json',
      // The screen-space error swisstopo's own viewer uses for this layer.
      maxError: 10,
      // What the batch table says about each building. Only the kind matters
      // to drawing: it decides windows, plain walls, glass, or not at all.
      attributes: {
        id: 'EGID',
        type: 'OBJEKTART',
        kinds: {
          'Gebaeude Einzelhaus': 'building', 'Hochhaus': 'building', 'Historische Baute': 'building',
          'Sakrales Gebaeude': 'building', 'Kapelle': 'building',
          'Sakraler Turm': 'plain', 'Turm': 'plain', 'Hochkamin': 'plain', 'Kuehlturm': 'plain',
          'Lagertank': 'plain', 'Lueftungsschacht': 'plain', 'Mauer gross': 'plain',
          'Mauer gross gedeckt': 'plain', 'Flugdach': 'plain', 'Offenes Gebaeude': 'plain',
          'Im Bau': 'plain', 'Bruecke gedeckt': 'plain', 'Verbindungsbruecke': 'plain', 'Verbindungsbrücke': 'plain',
          'Treibhaus': 'glass',
          'Unterirdisches Gebaeude': 'hidden', 'Gebaeude unsichtbar': 'hidden',
        },
      },
    },
    {
      id: 'structures', label: 'Bridges & structures', kind: 'buildings', setting: 'structures', codec: 'b3dm',
      // swissTLM3D's objects modelled in 3D: bridges, cable cars and other
      // structures, which swisstopo's own 3D viewer shows next to the
      // buildings. The terrain model has bridges removed (it is the bare
      // ground), so without this layer a road over a valley is only a
      // picture on the valley floor.
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swisstlm3d.3d/v1/tileset.json',
      maxError: 10,
      // Few objects, so a quarter of the building memory setting is plenty.
      memoryShare: 0.25,
      attributes: {
        type: 'OBJEKTART',
        // Concrete and steel, unless a type says otherwise. Anything that is
        // an ordinary building is the building layer's to draw.
        defaultKind: 'plain',
        kinds: {
          'Gebaeude': 'hidden', 'Gebaeude Einzelhaus': 'hidden', 'Hochhaus': 'hidden',
          'Historische Baute': 'hidden', 'Sakrales Gebaeude': 'hidden', 'Kapelle': 'hidden',
          'Treibhaus': 'hidden', 'Offenes Gebaeude': 'hidden', 'Gebaeude unsichtbar': 'hidden',
          'Unterirdisches Gebaeude': 'hidden',
        },
      },
    },
    { id: 'vegetation', label: 'Trees', kind: 'vegetation', codec: 'b3dm',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.vegetation.3d/v1/tileset.json' },
    { id: 'names', label: 'Place names', kind: 'names', codec: 'glb',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swissnames3d.3d/v2/tileset.json' },
  ],

  /**
   * Communes, every name printed on the national map, postcodes and addresses.
   * `sr=4326` returns lon/lat directly, which is what the camera wants.
   *
   * No bbox filter. This service expresses one in Swiss grid metres, and
   * sending degrees silently matched nothing. Proximity ranking belongs on our
   * side anyway, where it works the same for every country.
   */
  search: {
    url: 'https://api3.geo.admin.ch/rest/services/ech/SearchServer',
    queryParam: 'searchText',
    params: { type: 'locations', sr: '4326', limit: '8', origins: 'gg25,gazetteer,zipcode,address' },
    items: (body) => body.results || [],
    /** Strips the API's HTML label and normalises one result. */
    map(result) {
      const a = result.attrs || {};
      return {
        label: String(a.label || '').replace(/<[^>]*>/g, '').trim(),
        kind: a.origin,
        lon: a.lon,
        lat: a.lat,
        // geom_st_box2d gives an extent we can frame the camera to later.
        extent: a.geom_st_box2d || null,
      };
    },
  },
});

export default swisstopo;
