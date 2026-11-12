/**
 * Where synthetic portfolio companies have their head office (docs/14 section 11): real cities
 * with their real coordinates, given to fictional companies. A company's city is drawn from its
 * own geography, from a stream of its own, so adding it changed no other seeded value. About one
 * company in ten has no headquarters recorded, the case the co-investment map must show plainly.
 */
import { Rng } from './prng.js';

export interface Place {
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Degrees to five places, as the numeric(8, 5) columns hold them. */
  latitude: string;
  longitude: string;
}

const place = (city: string, country: string, latitude: number, longitude: number): Place => ({
  city,
  country,
  latitude: latitude.toFixed(5),
  longitude: longitude.toFixed(5),
});

export const PLACES: Readonly<Record<string, readonly Place[]>> = {
  'geography.north_america': [
    place('New York', 'US', 40.7128, -74.006),
    place('Boston', 'US', 42.3601, -71.0589),
    place('Chicago', 'US', 41.8781, -87.6298),
    place('Austin', 'US', 30.2672, -97.7431),
    place('Dallas', 'US', 32.7767, -96.797),
    place('Houston', 'US', 29.7604, -95.3698),
    place('Atlanta', 'US', 33.749, -84.388),
    place('Miami', 'US', 25.7617, -80.1918),
    place('Denver', 'US', 39.7392, -104.9903),
    place('Seattle', 'US', 47.6062, -122.3321),
    place('San Francisco', 'US', 37.7749, -122.4194),
    place('Los Angeles', 'US', 34.0522, -118.2437),
    place('San Diego', 'US', 32.7157, -117.1611),
    place('Minneapolis', 'US', 44.9778, -93.265),
    place('Nashville', 'US', 36.1627, -86.7816),
    place('Charlotte', 'US', 35.2271, -80.8431),
    place('Philadelphia', 'US', 39.9526, -75.1652),
    place('Salt Lake City', 'US', 40.7608, -111.891),
    place('Phoenix', 'US', 33.4484, -112.074),
    place('Columbus', 'US', 39.9612, -82.9988),
    place('Toronto', 'CA', 43.6532, -79.3832),
    place('Vancouver', 'CA', 49.2827, -123.1207),
    place('Montreal', 'CA', 45.5019, -73.5674),
  ],
  'geography.europe': [
    place('London', 'GB', 51.5074, -0.1278),
    place('Manchester', 'GB', 53.4808, -2.2426),
    place('Dublin', 'IE', 53.3498, -6.2603),
    place('Paris', 'FR', 48.8566, 2.3522),
    place('Amsterdam', 'NL', 52.3676, 4.9041),
    place('Frankfurt', 'DE', 50.1109, 8.6821),
    place('Munich', 'DE', 48.1351, 11.582),
    place('Berlin', 'DE', 52.52, 13.405),
    place('Zurich', 'CH', 47.3769, 8.5417),
    place('Milan', 'IT', 45.4642, 9.19),
    place('Madrid', 'ES', 40.4168, -3.7038),
    place('Stockholm', 'SE', 59.3293, 18.0686),
    place('Copenhagen', 'DK', 55.6761, 12.5683),
    place('Oslo', 'NO', 59.9139, 10.7522),
    place('Helsinki', 'FI', 60.1699, 24.9384),
    place('Vienna', 'AT', 48.2082, 16.3738),
    place('Brussels', 'BE', 50.8503, 4.3517),
    place('Warsaw', 'PL', 52.2297, 21.0122),
  ],
  'geography.asia_pacific': [
    place('Sydney', 'AU', -33.8688, 151.2093),
    place('Melbourne', 'AU', -37.8136, 144.9631),
    place('Singapore', 'SG', 1.3521, 103.8198),
    place('Tokyo', 'JP', 35.6762, 139.6503),
    place('Seoul', 'KR', 37.5665, 126.978),
    place('Hong Kong', 'HK', 22.3193, 114.1694),
    place('Auckland', 'NZ', -36.8485, 174.7633),
    place('Mumbai', 'IN', 19.076, 72.8777),
    place('Bengaluru', 'IN', 12.9716, 77.5946),
  ],
};

export interface Headquarters {
  hqCity: string | null;
  hqCountry: string | null;
  hqLatitude: string | null;
  hqLongitude: string | null;
}

export const NO_HEADQUARTERS: Headquarters = {
  hqCity: null,
  hqCountry: null,
  hqLatitude: null,
  hqLongitude: null,
};

/** The stream the headquarters are drawn from: the seed, turned by a constant of its own. */
const HQ_STREAM = 0x48515f31;

/**
 * Gives each company its head office, in the order the companies come: one in ten gets none, the
 * rest a city of their geography. A geography with no list here gets none either.
 */
export function assignHeadquarters<T extends { geography: string | null } & Headquarters>(
  companies: readonly T[],
  seed: number,
): void {
  const rng = new Rng(seed ^ HQ_STREAM);
  for (const company of companies) {
    const unrecorded = rng.int(0, 9) === 0;
    const places = company.geography === null ? undefined : PLACES[company.geography];
    if (unrecorded || places === undefined) continue;
    const at = rng.pick(places);
    company.hqCity = at.city;
    company.hqCountry = at.country;
    company.hqLatitude = at.latitude;
    company.hqLongitude = at.longitude;
  }
}
