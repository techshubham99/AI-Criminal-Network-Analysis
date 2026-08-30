/**
 * Web Mercator, the one projection this app draws maps in.
 *
 * `india-basemap.ts` is generated with the identical formula (see the generator
 * `backend/scripts/build_india_basemap.py`), and `INDIA_VIEWBOX` is expressed in
 * the units this returns, so a coordinate projected here lands exactly on the
 * land it belongs to. Anything plotted over the basemap must come through here.
 *
 * Nothing is fetched, geocoded or tiled: this is arithmetic on coordinates the
 * corpus already holds.
 */

export interface ProjectedPoint {
  readonly x: number;
  readonly y: number;
}

/** Latitude beyond which Mercator's y runs away to infinity. */
const LIMIT = 85;

/**
 * Latitude/longitude in degrees to projected map units, y already flipped so it
 * grows downwards the way SVG's does.
 */
export function project(lat: number, lng: number): ProjectedPoint {
  const clamped = Math.max(-LIMIT, Math.min(LIMIT, lat));
  const radians = (clamped * Math.PI) / 180;
  const y = (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + radians / 2));
  return { x: lng, y: -y };
}
