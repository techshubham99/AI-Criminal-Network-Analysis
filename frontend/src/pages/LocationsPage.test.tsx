/**
 * Location Intelligence — §3: an independent product area built on the backend's
 * own location data.
 *
 * The map is the part most easily overclaimed. The basemap is boundary geometry
 * this repo ships, and `canonical_lat` / `canonical_lng` are city centroids rather
 * than addresses — there is no tile service and no geocoder behind either — so the
 * panel says exactly that, and this asserts it. No geography is invented anywhere:
 * every point, city and state below comes out of the recording, and each dot is
 * checked against the projection rather than against a hand-written position.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { INDIA_BOUNDS, INDIA_VIEWBOX, project } from '@/components/geo';
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
const network = fixtures.network445Depth1 as unknown as {
  nodes: NodeOut[];
  edges: EdgeOut[];
};

const cities = new Set(allLocations.items.map((item) => item.city)).size;
/** Enough plotted points to hold the projection to account, without walking 200. */
const sample = allLocations.items.filter((_, index) => index % 25 === 0);

const home = allLocations.items.find((item) => item.location_id === person445.location_id);
if (!home) throw new Error('the locations recording no longer holds the person’s own location');

/** One plotted point, by the location it stands for. */
const dotOf = (map: HTMLElement, locationId: number): SVGCircleElement => {
  const dot = map.querySelector<SVGCircleElement>(
    `[data-testid="map-point"][data-location-id="${locationId}"]`,
  );
  if (!dot) throw new Error(`location ${locationId} is not plotted`);
  return dot;
};

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
      within(map).getByText('City centroids on a projected map — not address-level positions'),
    ).toBeInTheDocument();
    // Where the land under the points came from, stated on the panel itself.
    expect(within(map).getByText(/Census 2011.*Web Mercator/)).toBeInTheDocument();
  });

  it('plots each point where the projection puts it, on a basemap of India', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    const map = await screen.findByTestId('location-map');
    await waitFor(() => expect(screen.getAllByTestId('map-point').length).toBeGreaterThan(0));

    // The basemap is geometry this repo ships, not a tile fetched from anywhere.
    const canvas = within(map).getByTestId('india-map');
    expect(canvas).toHaveAttribute('viewBox', INDIA_VIEWBOX);
    expect(within(map).getAllByTestId('india-map-state').length).toBeGreaterThan(30);

    // Every point sits at its own coordinates put through the map's own projection,
    // so it cannot drift from the land it names.
    for (const item of sample) {
      const dot = dotOf(map, item.location_id);
      const at = project(item.canonical_lat, item.canonical_lng);
      expect(Number(dot.getAttribute('cx'))).toBeCloseTo(at.x, 10);
      expect(Number(dot.getAttribute('cy'))).toBeCloseTo(at.y, 10);
    }

    // Only the states the recording actually places data in are lit.
    const lit = within(map)
      .getAllByTestId('india-map-state')
      .filter((state) => state.dataset.active === 'true')
      .map((state) => state.dataset.state);
    expect(new Set(lit)).toEqual(new Set(allLocations.items.map((item) => item.state)));
  });

  it('zooms a city geographically instead of spreading its points apart', async () => {
    installFetch();
    renderWithRouter(<LocationsPage />, { route: '/locations' });

    const map = await screen.findByTestId('location-map');
    await waitFor(() => expect(within(map).getAllByTestId('map-cluster').length).toBe(cities));

    const before = sample.map((item) => dotOf(map, item.location_id).getAttribute('cx'));
    const ring = within(map).getAllByTestId('map-cluster')[0];
    fireEvent.click(ring.querySelector('circle') as SVGCircleElement);

    // A narrower window on the same projected space — the coordinates do not move.
    const canvas = within(map).getByTestId('india-map');
    expect(canvas.getAttribute('viewBox')).not.toBe(INDIA_VIEWBOX);
    expect(Number(canvas.getAttribute('viewBox')?.split(' ')[2])).toBeLessThan(
      INDIA_BOUNDS.maxX - INDIA_BOUNDS.minX,
    );
    expect(sample.map((item) => dotOf(map, item.location_id).getAttribute('cx'))).toEqual(before);

    fireEvent.click(within(map).getByTestId('map-zoom-out'));
    expect(within(map).getByTestId('india-map')).toHaveAttribute('viewBox', INDIA_VIEWBOX);
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
    renderWithRouter(<LocationsPage />, {
      route: `/locations?location=${home.location_id}`,
    });

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

    await waitFor(() => expect(statTile('Registered city')).toHaveTextContent(person445.city));
    expect(statTile('Registered city')).toHaveTextContent(person445.state);

    // The person record names a location id; that record is then read for its
    // coordinates. Nothing here is geocoded from the address text.
    expect(calls.some((url) => url.includes('/api/v1/persons/445'))).toBe(true);
    await waitFor(() =>
      expect(calls.some((url) => url.includes(`/api/v1/locations/${person445.location_id}`))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId('map-point')).toHaveLength(1));
  });
});
