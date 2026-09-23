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
   * swissALTI3D in May 2025. A triangulated mesh rather than a raster
   * heightmap, so vertices already sit where the terrain needs them: cliffs
   * cost triangles, flat lake surfaces cost almost none.
   */
  terrain: {
    codec: 'quantized-mesh',
    crs: 'EPSG:4326',
    // No tile URL here on purpose. The service files its tiles under a dated
    // directory that changes whenever swissALTI3D is reprocessed, and
    // layer.json is what publishes the current one along with the level range
    // and the cache-busting version. Read it, do not guess it.
    layerJson: 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/layer.json',
    // layer.json declares global bounds, so real coverage comes from the
    // adapter's own bounds. It also has no `available` array, only
    // `metadataAvailability`, which step 1b will read from the tiles themselves.
    availabilityFromBounds: true,
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

  /** 3D Tiles sets, streamed from step 6 onward. */
  features: [
    { id: 'buildings', label: 'Buildings', codec: 'b3dm',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json' },
    { id: 'tlm', label: 'Roads, railways and water', codec: 'b3dm',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swisstlm3d.3d/v1/tileset.json' },
    { id: 'vegetation', label: 'Trees', codec: 'b3dm',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.vegetation.3d/v1/tileset.json' },
    { id: 'names', label: 'Place names', codec: 'b3dm',
      tileset: 'https://3d.geo.admin.ch/ch.swisstopo.swissnames3d.3d/v1/tileset.json' },
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

  /** Ground height at a point, for placing the camera before tiles arrive. */
  elevation: {
    url: 'https://api3.geo.admin.ch/rest/services/height',
    params: { sr: '4326' },
  },
});

export default swisstopo;
