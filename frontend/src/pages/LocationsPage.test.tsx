/**
 * Location Intelligence — §3: an independent product area built on the backend's
 * own location data.
 *
 * The map is the part most easily overclaimed. `canonical_lat` / `canonical_lng`
 * are city centroids, not addresses, and there is no basemap, tile service or
 * geocoder behind them — so the plot says exactly that, and this asserts it. No
 * geography is invented anywhere: every point, city and state below comes out of
 * the recording.
 */
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetPersonNames } from '@/hooks/usePersonNames';
import { fixtures, installFetch, renderWithRouter, statTile } from '@/test/helpers';
import type { EdgeOut, LocationRecord, NodeOut, Page, PatternListResponse } from '@/types/api';
import { formatCount } from '@/utils/format';

import { LocationsPage } from './LocationsPage';

const ANCHOR = 'person:445';

const allLocations = fixtures.locationsPage1 as unknown as Page<LocationRecord>;
const cohorts = fixtures.patternsLocationCohort as unknown as PatternListResponse;
const sharedPairs = fixtures.patternsSharedLocation as unknown as PatternListResponse;
const mumbai = fixtures.personsCityMumbai as unknown as Page<{
  person_id: number;
  location_id: number;
}>;
const person445 = fixtures.personRecord445 as unknown as {
  city: string;
  state: string;
  location_id: number;
};
const network = fixtures.network445Depth1 as unknown as { nodes: NodeOut[]; edges: EdgeOut[] };

const cities = new Set(allLocations.items.map((item) => item.city)).size;

const home = allLocations.items.find((item) => item.location_id === person445.location_id);
if (!home) throw new Error('the locations recording no longer holds the person’s own location');

const touchesAnchor = (edge: EdgeOut) =>
  !edge.is_overlay && (edge.source_entity_id === ANCHOR || edge.target_entity_id === ANCHOR);

/** The subject's link to a place, and their links to people who share one. */
const locatedAt = network.edges.filter(
  (edge) => touchesAnchor(edge) && edge.relationship_type === 'LOCATED_AT',
);
const coLocated = network.edges.filter(
  (edge) => touchesAnchor(edge) && edge.relationship_type === 'CO_LOCATED',
);
const homeNodeLabel = network.nodes.find(
  (node) => node.entity_id === `location:${person445.location_id}`,
)?.label;

describe('Location Intelligence — the corpus-wide browse', () => {
  beforeEach(resetPersonNames);

  it('plots the corpus without being given a person', async () => {
    const { calls } = installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    await waitFor(() =>
      expect(screen.getAllByTestId('map-point')).toHaveLength(allLocations.items.length),
    );

    expect(screen.getByTestId('locations-page')).toBeInTheDocument();
    expect(screen.getByTestId('scope-search')).toBeInTheDocument();
    expect(screen.getAllByTestId('location-row')).toHaveLength(allLocations.items.length);
    expect(calls.some((url) => url.includes('/api/v1/locations?page_size=200'))).toBe(true);
    expect(calls.some((url) => url.includes('/graph/persons/'))).toBe(false);
  });

  it('says what the coordinates are, rather than implying street-level accuracy', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    const map = await screen.findByTestId('location-map');
    expect(
      within(map).getByText('City centroids — not address-level positions'),
    ).toBeInTheDocument();
  });

  it('counts locations and cities from the response, and patterns from the engine', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    await waitFor(() =>
      expect(statTile('Locations')).toHaveTextContent(formatCount(allLocations.meta.total)),
    );
    expect(statTile('Cities')).toHaveTextContent(formatCount(cities));
    expect(statTile('Location cohorts')).toHaveTextContent(formatCount(cohorts.total));
    expect(statTile('Shared-location pairs')).toHaveTextContent(formatCount(sharedPairs.total));
  });

  it('asks the engine for its two co-location categories by name', async () => {
    const { calls } = installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    const panel = await screen.findByTestId('pattern-list');
    for (const type of ['LOCATION_COHORT', 'SHARED_LOCATION_PAIR']) {
      await waitFor(() =>
        expect(
          calls.filter((url) => url.includes(`pattern_type=${type}`) && url.includes('limit=10')),
        ).toHaveLength(1),
      );
    }

    await waitFor(() => expect(within(panel).getAllByTestId('pattern-row')).toHaveLength(10));
    expect(within(panel).queryByText('No patterns detected')).not.toBeInTheDocument();
    expect(panel).toHaveTextContent(formatCount(cohorts.total + sharedPairs.total));
  });

  it('opens a location from the URL and lists the people on record there', async () => {
    const { calls } = installFetch();
    renderWithRouter(<LocationsPage />, { route: `/locations?location=${home.location_id}` });

    const panel = await screen.findByTestId('location-people');
    expect(within(panel).getByText(`${home.city}, ${home.state}`)).toBeInTheDocument();

    // City-and-state is the narrowest filter the backend offers, so the response
    // is narrowed again here: a city can hold more than one location record.
    await waitFor(() =>
      expect(
        calls.some((url) =>
          url.includes(`/api/v1/persons?city=${home.city}&state=${home.state}&page_size=200`),
        ),
      ).toBe(true),
    );

    const here = mumbai.items.filter((person) => person.location_id === home.location_id);
    expect(here.length).toBeGreaterThan(0);
    expect(here.length).toBeLessThan(mumbai.items.length);
    await waitFor(() =>
      expect(within(panel).getAllByTestId('location-person-row')).toHaveLength(here.length),
    );
  });
});

describe('Location Intelligence — scoped to one subject', () => {
  beforeEach(resetPersonNames);

  it('shows the places the subject is linked to, and no person as a place', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations?person=445' });

    const panel = await screen.findByTestId('place-links');
    await waitFor(() =>
      expect(within(panel).getAllByTestId('place-row')).toHaveLength(locatedAt.length),
    );

    // CO_LOCATED edges also place the subject somewhere, but their other end is a
    // person, not a place — they belong in the shared-location table below.
    expect(coLocated.length).toBeGreaterThan(0);
    expect(within(panel).getByText(String(homeNodeLabel))).toBeInTheDocument();
    expect(within(panel).getByText('LOCATED_AT')).toBeInTheDocument();
    expect(statTile('Linked places')).toHaveTextContent(formatCount(locatedAt.length));
  });

  it('lists the people the subject shares a location with', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations?person=445' });

    const panel = await screen.findByTestId('shared-locations');
    await waitFor(() =>
      expect(within(panel).getAllByTestId('shared-row')).toHaveLength(coLocated.length),
    );
    expect(statTile('Shared-location links')).toHaveTextContent(formatCount(coLocated.length));
  });

  it('plots the subject’s own registered city from its location record', async () => {
    const { calls } = installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations?person=445' });

    await waitFor(() =>
      expect(statTile('Registered city')).toHaveTextContent(person445.city),
    );
    expect(statTile('Registered city')).toHaveTextContent(person445.state);

    // The person record names a location id; that record is then read for its
    // coordinates. Nothing here is geocoded from the address text.
    expect(calls.some((url) => url.includes('/api/v1/persons/445'))).toBe(true);
    await waitFor(() =>
      expect(
        calls.some((url) => url.includes(`/api/v1/locations/${person445.location_id}`)),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getAllByTestId('map-point')).toHaveLength(1));
  });
});
