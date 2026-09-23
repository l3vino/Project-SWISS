/* open-meteo.js — populated places, worldwide, without a throttle to worry about.
 *
 * What the Global search mode asks. It indexes GeoNames, so it answers for
 * cities, towns and villages anywhere on earth: no key, CORS enabled, no
 * published rate limit, free for non-commercial use with the data under
 * CC BY 4.0.
 *
 * It does not index detail: no streets, no summits, no stations. That is the
 * National mode's job, answered by whichever country adapter covers the view.
 */

import { defineAdapter } from './adapter.js';

export const openMeteo = defineAdapter({
  id: 'open-meteo',
  label: 'Cities and towns worldwide',
  // The wording Open-Meteo's geocoding documentation asks for.
  attribution: 'Location data based on GeoNames',
  attributionUrl: 'https://www.geonames.org/',

  // Below every national source; it is a fallback, never the better answer for
  // ground a dedicated adapter already covers.
  priority: -100,
  bounds: [-180, -90, 180, 90],
  searchOnly: true,

  search: {
    global: true,
    url: 'https://geocoding-api.open-meteo.com/v1/search',
    queryParam: 'name',
    params: { count: '8', format: 'json' },

    // No location bias parameter exists here, which is fine: ranking by
    // proximity happens on our side anyway.

    items: (body) => body.results || [],

    map(place) {
      const region = place.admin1 && place.admin1 !== place.name ? place.admin1 : null;
      return {
        label: [place.name, region].filter(Boolean).join(', '),
        kind: place.country || '',
        lon: place.longitude,
        lat: place.latitude,
      };
    },
  },
});

export default openMeteo;
