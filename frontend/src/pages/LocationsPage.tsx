/**
 * Location Intelligence — an independent product area, not a tab of the network
 * page.
 *
 * Corpus-wide by default: every location the dataset holds, plotted from the
 * canonical city-centroid coordinates the backend supplies, with the persons on
 * record at a selected location. Scoped to a subject on request: the places that
 * subject is linked to, the people they share a place with, and the observation
 * window behind each link.
 *
 * The map is a plain coordinate plot. There is no basemap, no tile service and no
 * geocoding — `canonical_lat` / `canonical_lng` are the only coordinates in the
 * corpus, they are city centroids rather than addresses, and the plot says so
 * instead of implying street-level precision it does not have.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { PatternDetails, PatternList } from '@/components/intelligence';
import { Cell, DataTable, PersonRef, SubjectScope } from '@/components/records';
import {
  Badge,
  EmptyState,
  ErrorState,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  SkeletonRows,
  SkeletonTile,
  StatTile,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useLive } from '@/hooks/useLive';
import { usePersonNames } from '@/hooks/usePersonNames';
import { usePersonScope } from '@/hooks/usePersonScope';
import type { EdgeOut, LocationRecord, NodeOut } from '@/types/api';
import { formatCount, formatDateTime, formatMetric } from '@/utils/format';

/** The server-side page cap. The corpus holds 200 locations, so one page reads all. */
const MAX_PAGE_SIZE = 200;

/** The two categories the pattern engine derives from co-location. */
const LOCATION_PATTERNS = ['LOCATION_COHORT', 'SHARED_LOCATION_PAIR'] as const;

/** Relationship types that place a person somewhere. */
const PLACE_EDGES = new Set(['LOCATED_AT', 'CO_LOCATED', 'USED_TOWER']);

/* ============================================================ route */

export function LocationsPage(): ReactElement {
  const { personId, setPersonId } = usePersonScope();
  const names = usePersonNames();

  return (
    <div className="space-y-4 pb-8 animate-fade-in" data-testid="locations-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Location Intelligence</h1>
      </div>

      <SubjectScope personId={personId} label={names.nameOf(personId)} onChange={setPersonId} />

      {personId === null ? <CorpusLocations /> : <PersonLocations personId={personId} />}
    </div>
  );
}

/* ============================================================ corpus-wide */

function CorpusLocations(): ReactElement {
  const [params, setParams] = useSearchParams();
  const rawSelected = params.get('location');
  const selectedId =
    rawSelected !== null && /^\d+$/.test(rawSelected) ? Number(rawSelected) : null;
  const [selectedPattern, setSelectedPattern] = useState<string | null>(null);

  const locations = useAsync(
    (signal) => api.listLocations({ page_size: MAX_PAGE_SIZE }, { signal }),
    [],
  );
  const cohorts = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'LOCATION_COHORT', limit: 1 }, { signal }),
    [],
  );
  const sharedPairs = useAsync(
    (signal) => api.listPatterns({ pattern_type: 'SHARED_LOCATION_PAIR', limit: 1 }, { signal }),
    [],
  );

  const items = locations.data?.items ?? [];
  const selected = items.find((item) => item.location_id === selectedId) ?? null;
  const states = useMemo(() => new Set(items.map((item) => item.state)).size, [items]);
  const cities = useMemo(() => new Set(items.map((item) => item.city)).size, [items]);

  const select = (locationId: number | null) => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev);
        if (locationId === null) updated.delete('location');
        else updated.set('location', String(locationId));
        return updated;
      },
      { replace: true },
    );
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {locations.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Locations"
            value={formatCount(locations.data?.meta.total)}
            accent="cyan"
          />
        )}
        {locations.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Cities" value={formatCount(cities)} accent="neutral" />
        )}
        {cohorts.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile label="Location cohorts" value={formatCount(cohorts.data?.total)} accent="azure" />
        )}
        {sharedPairs.isInitialLoading ? (
          <SkeletonTile />
        ) : (
          <StatTile
            label="Shared-location pairs"
            value={formatCount(sharedPairs.data?.total)}
            accent="azure"
          />
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <CoordinatePlot
            locations={items}
            loading={locations.isInitialLoading}
            error={locations.error}
            onRetry={locations.retry}
            selectedId={selectedId}
            onSelect={select}
            footnote={`${formatCount(items.length)} plotted · ${formatCount(states)} states`}
          />
          {selected ? <LocationPeople location={selected} onClear={() => select(null)} /> : null}
          <LocationTable
            locations={items}
            loading={locations.isInitialLoading}
            selectedId={selectedId}
            onSelect={select}
          />
        </div>
        <div className="space-y-4">
          <PatternList
            title="Co-location patterns"
            types={LOCATION_PATTERNS}
            limit={10}
            selectedId={selectedPattern}
            onSelect={setSelectedPattern}
          />
          {selectedPattern ? <PatternDetails patternId={selectedPattern} /> : null}
        </div>
      </div>
    </>
  );
}

/* ============================================================ person-scoped */

/**
 * One subject's location picture. Exported so the investigation workspace's
 * Locations tab renders exactly this screen rather than a second copy of it.
 */
export function PersonLocations({ personId }: { personId: number }): ReactElement {
  const [refreshKey, setRefreshKey] = useState(0);
  const names = usePersonNames();

  useLive((event) => {
    if (event.event_type === 'new_intelligence') setRefreshKey((key) => key + 1);
  });

  /* persons_only=false so location and tower nodes come back with the persons. */
  const network = useAsync(
    (signal) => api.getPersonNetwork(personId, { depth: 1, persons_only: false }, { signal }),
    [personId, refreshKey],
  );
  const person = useAsync((signal) => api.getPersonRecord(personId, { signal }), [personId]);

  const home = useAsync(
    (signal) =>
      person.data
        ? api.getLocationRecord(person.data.location_id, { signal })
        : Promise.reject(new Error('no location')),
    [person.data?.location_id],
    { enabled: person.data !== null },
  );

  const anchorId = `person:${personId}`;
  const nodes = network.data?.nodes ?? [];
  const edges = network.data?.edges ?? [];

  const places = useMemo(() => placeLinks(edges, nodes, anchorId), [edges, nodes, anchorId]);
  const shared = useMemo(() => sharedWith(edges, anchorId), [edges, anchorId]);

  const plotted = home.data ? [home.data] : [];

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Linked places"
          value={network.data ? formatCount(places.length) : '—'}
          accent="cyan"
        />
        <StatTile
          label="Shared-location links"
          value={network.data ? formatCount(shared.length) : '—'}
          accent="azure"
        />
        <StatTile
          label="Registered city"
          value={person.data ? `${person.data.city}` : '—'}
          footnote={person.data?.state}
          accent="neutral"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <CoordinatePlot
            locations={plotted}
            loading={home.isInitialLoading || person.isInitialLoading}
            error={person.error}
            onRetry={person.retry}
            selectedId={home.data?.location_id ?? null}
            onSelect={() => {}}
            footnote="Registered address centroid"
          />

          <Panel data-testid="place-links">
            <PanelHeader title="Location links" accent />
            <PanelBody padded={false}>
              {network.isInitialLoading ? <SkeletonRows rows={4} className="p-3" /> : null}
              {network.error ? (
                <ErrorState error={network.error} onRetry={network.retry} compact />
              ) : null}
              {network.data && places.length === 0 ? (
                <EmptyState
                  title="No location links"
                  description="No data available for this subject."
                />
              ) : null}
              {places.length > 0 ? (
                <DataTable head={['Place', 'Link', 'Observations', 'First', 'Last']}>
                  {places.map((place) => (
                    <tr
                      key={place.relationshipId}
                      className="hover:bg-panel-2 transition-colors"
                      data-testid="place-row"
                    >
                      <Cell>
                        <Link
                          to={`/evidence?entity=${encodeURIComponent(place.entityId)}`}
                          className="text-ink hover:text-cyan-300 text-xs font-medium underline decoration-dotted underline-offset-2"
                        >
                          {place.label}
                        </Link>
                      </Cell>
                      <Cell>
                        <Badge tone="neutral">{place.relationshipType}</Badge>
                      </Cell>
                      <Cell numeric>{formatCount(place.observations)}</Cell>
                      <Cell>
                        <span className="font-mono text-2xs">{formatDateTime(place.firstSeen)}</span>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-2xs">{formatDateTime(place.lastSeen)}</span>
                      </Cell>
                    </tr>
                  ))}
                </DataTable>
              ) : null}
            </PanelBody>
          </Panel>

          <Panel data-testid="shared-locations">
            <PanelHeader title="People sharing a location" accent />
            <PanelBody padded={false}>
              {network.isInitialLoading ? <SkeletonRows rows={4} className="p-3" /> : null}
              {network.data && shared.length === 0 ? (
                <EmptyState
                  title="No shared-location links"
                  description="No data available for this subject."
                />
              ) : null}
              {shared.length > 0 ? (
                <DataTable head={['Person', 'Observations', 'First', 'Last']}>
                  {shared.map((link) => (
                    <tr
                      key={link.relationshipId}
                      className="hover:bg-panel-2 transition-colors"
                      data-testid="shared-row"
                    >
                      <Cell>
                        <PersonRef personId={link.personId} names={names} />
                      </Cell>
                      <Cell numeric>{formatCount(link.observations)}</Cell>
                      <Cell>
                        <span className="font-mono text-2xs">{formatDateTime(link.firstSeen)}</span>
                      </Cell>
                      <Cell>
                        <span className="font-mono text-2xs">{formatDateTime(link.lastSeen)}</span>
                      </Cell>
                    </tr>
                  ))}
                </DataTable>
              ) : null}
            </PanelBody>
          </Panel>
        </div>

        <PatternList
          title="Co-location patterns"
          types={LOCATION_PATTERNS}
          entityId={anchorId}
          limit={10}
          refreshKey={refreshKey}
        />
      </div>
    </>
  );
}

/* ============================================================ derivations */

interface PlaceLink {
  relationshipId: string;
  entityId: string;
  label: string;
  relationshipType: string;
  observations: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Edges from the subject to a place node, labelled with the node's own label. */
function placeLinks(edges: EdgeOut[], nodes: NodeOut[], anchorId: string): PlaceLink[] {
  const byId = new Map(nodes.map((node) => [node.entity_id, node]));
  return edges
    .filter(
      (edge) =>
        !edge.is_overlay &&
        PLACE_EDGES.has(edge.relationship_type) &&
        (edge.source_entity_id === anchorId || edge.target_entity_id === anchorId),
    )
    .map((edge) => {
      const other =
        edge.source_entity_id === anchorId ? edge.target_entity_id : edge.source_entity_id;
      return {
        relationshipId: edge.relationship_id,
        entityId: other,
        label: byId.get(other)?.label ?? other,
        relationshipType: edge.relationship_type,
        observations: edge.evidence_count ?? 0,
        firstSeen: edge.date_first ?? null,
        lastSeen: edge.date_last ?? null,
      };
    })
    .filter((link) => !link.entityId.startsWith('person:'))
    .sort((a, b) => b.observations - a.observations);
}

interface SharedLink {
  relationshipId: string;
  personId: number;
  observations: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

/** CO_LOCATED person-to-person edges touching the subject. */
function sharedWith(edges: EdgeOut[], anchorId: string): SharedLink[] {
  return edges
    .filter(
      (edge) =>
        !edge.is_overlay &&
        edge.relationship_type === 'CO_LOCATED' &&
        (edge.source_entity_id === anchorId || edge.target_entity_id === anchorId),
    )
    .flatMap((edge) => {
      const other =
        edge.source_entity_id === anchorId ? edge.target_entity_id : edge.source_entity_id;
      if (!other.startsWith('person:')) return [];
      const numeric = Number(other.slice('person:'.length));
      if (!Number.isInteger(numeric)) return [];
      return [
        {
          relationshipId: edge.relationship_id,
          personId: numeric,
          observations: edge.evidence_count ?? 0,
          firstSeen: edge.date_first ?? null,
          lastSeen: edge.date_last ?? null,
        },
      ];
    })
    .sort((a, b) => b.observations - a.observations);
}

/* ============================================================ map */

const PLOT_PAD = 6;

/**
 * A coordinate plot of `canonical_lat` / `canonical_lng`, scaled to the extent of
 * the points supplied. Not a map of anywhere in particular: no basemap, no
 * projection beyond a linear scale, and no claim of address-level accuracy.
 */
function CoordinatePlot({
  locations,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  footnote,
}: {
  locations: LocationRecord[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  selectedId: number | null;
  onSelect: (locationId: number | null) => void;
  footnote?: string;
}): ReactElement {
  const bounds = useMemo(() => {
    if (locations.length === 0) return null;
    const lats = locations.map((item) => item.canonical_lat);
    const lngs = locations.map((item) => item.canonical_lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    return {
      minLat,
      maxLat,
      minLng,
      maxLng,
      /* A single point, or a row of identical ones, must not divide by zero. */
      spanLat: maxLat - minLat || 1,
      spanLng: maxLng - minLng || 1,
    };
  }, [locations]);

  return (
    <Panel data-testid="location-map">
      <PanelHeader
        title="Coordinate plot"
        subtitle="City centroids — not address-level positions"
        accent
        actions={footnote ? <span className="text-ink-4 font-mono text-2xs">{footnote}</span> : null}
      />
      <PanelBody>
        {loading ? <div className="skeleton h-64 w-full rounded-md" /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} compact /> : null}
        {!loading && !error && locations.length === 0 ? (
          <EmptyState title="No coordinates" description="No data available." />
        ) : null}
        {bounds && locations.length > 0 ? (
          <div className="inset relative overflow-hidden rounded-md">
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Coordinate plot of ${locations.length} locations`}
              className="h-64 w-full"
            >
              {/* Reference grid. Decorative, and drawn from the tokens. */}
              {[25, 50, 75].map((at) => (
                <g key={at} stroke="var(--color-line)" strokeWidth="0.15">
                  <line x1={at} y1="0" x2={at} y2="100" />
                  <line x1="0" y1={at} x2="100" y2={at} />
                </g>
              ))}
              {locations.map((item) => {
                const x =
                  PLOT_PAD +
                  ((item.canonical_lng - bounds.minLng) / bounds.spanLng) * (100 - PLOT_PAD * 2);
                /* Latitude grows northwards; SVG y grows downwards. */
                const y =
                  100 -
                  PLOT_PAD -
                  ((item.canonical_lat - bounds.minLat) / bounds.spanLat) * (100 - PLOT_PAD * 2);
                const active = item.location_id === selectedId;
                return (
                  <circle
                    key={item.location_id}
                    cx={x}
                    cy={y}
                    r={active ? 1.6 : 0.9}
                    fill={active ? 'var(--color-cyan-300)' : 'var(--color-ent-location)'}
                    fillOpacity={active ? 1 : 0.7}
                    stroke={active ? 'var(--color-cyan-200)' : 'none'}
                    strokeWidth="0.3"
                    className="cursor-pointer"
                    onClick={() => onSelect(active ? null : item.location_id)}
                    data-testid="map-point"
                    data-location-id={item.location_id}
                  >
                    <title>{`${item.city}, ${item.state}`}</title>
                  </circle>
                );
              })}
            </svg>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ============================================================ tables */

function LocationTable({
  locations,
  loading,
  selectedId,
  onSelect,
}: {
  locations: LocationRecord[];
  loading: boolean;
  selectedId: number | null;
  onSelect: (locationId: number | null) => void;
}): ReactElement {
  return (
    <Panel data-testid="location-table">
      <PanelHeader title="Locations" subtitle={`${formatCount(locations.length)} records`} accent />
      <PanelBody padded={false} className="max-h-[26rem] overflow-y-auto">
        {loading ? <SkeletonRows rows={8} className="p-3" /> : null}
        {!loading && locations.length === 0 ? (
          <EmptyState title="No locations" description="No data available." />
        ) : null}
        {locations.length > 0 ? (
          <DataTable head={['ID', 'City', 'State', 'Latitude', 'Longitude']}>
            {locations.map((item) => (
              <tr
                key={item.location_id}
                onClick={() => onSelect(item.location_id === selectedId ? null : item.location_id)}
                className={`cursor-pointer transition-colors ${
                  item.location_id === selectedId ? 'bg-cyan-500/10' : 'hover:bg-panel-2'
                }`}
                data-testid="location-row"
              >
                <Cell numeric>{item.location_id}</Cell>
                <Cell>{item.city}</Cell>
                <Cell>{item.state}</Cell>
                <Cell numeric>{formatMetric(item.canonical_lat, 4)}</Cell>
                <Cell numeric>{formatMetric(item.canonical_lng, 4)}</Cell>
              </tr>
            ))}
          </DataTable>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/**
 * The persons on record at one location.
 *
 * `?city=&state=` is the narrowest filter the backend offers, so the response is
 * further reduced here to the rows whose `location_id` actually matches — a city
 * can hold more than one location record.
 */
function LocationPeople({
  location,
  onClear,
}: {
  location: LocationRecord;
  onClear: () => void;
}): ReactElement {
  const names = usePersonNames();
  const people = useAsync(
    (signal) =>
      api.listPersons(
        { city: location.city, state: location.state, page_size: MAX_PAGE_SIZE },
        { signal },
      ),
    [location.city, location.state],
  );

  const atLocation = (people.data?.items ?? []).filter(
    (person) => person.location_id === location.location_id,
  );

  return (
    <Panel data-testid="location-people">
      <PanelHeader
        title={`${location.city}, ${location.state}`}
        subtitle={people.data ? `${formatCount(atLocation.length)} persons on record` : undefined}
        accent
        actions={
          <div className="flex items-center gap-2">
            <Mono className="text-2xs">location:{location.location_id}</Mono>
            <button
              type="button"
              onClick={onClear}
              className="text-ink-3 hover:text-ink text-2xs font-semibold underline decoration-dotted"
            >
              Clear
            </button>
          </div>
        }
      />
      <PanelBody padded={false}>
        {people.isInitialLoading ? <SkeletonRows rows={5} className="p-3" /> : null}
        {people.error ? <ErrorState error={people.error} onRetry={people.retry} compact /> : null}
        {people.data && atLocation.length === 0 ? (
          <EmptyState title="No persons on record here" description="No data available." />
        ) : null}
        {atLocation.length > 0 ? (
          <DataTable head={['Person', 'Address']}>
            {atLocation.map((person) => (
              <tr
                key={person.person_id}
                className="hover:bg-panel-2 transition-colors"
                data-testid="location-person-row"
              >
                <Cell>
                  <PersonRef personId={person.person_id} names={names} label={person.name} />
                </Cell>
                <Cell>{person.address}</Cell>
              </tr>
            ))}
          </DataTable>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
