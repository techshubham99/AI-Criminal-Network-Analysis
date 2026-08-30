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
 * The map is drawn from vendored Census-2011 boundaries projected to Web Mercator,
 * with the corpus's coordinates put through the same projection: no tile service,
 * no map API, no map library, no geocoding, nothing fetched at render time.
 * `canonical_lat` / `canonical_lng` are the only coordinates in the corpus and they
 * are city centroids rather than addresses, so the panel says so, and a city can be
 * zoomed rather than having its points spread out to look separate.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { INDIA_BOUNDS, INDIA_VIEWBOX, IndiaMap, project } from '@/components/geo';
import { PatternDetails, PatternList } from '@/components/intelligence';
import { Cell, DataTable, PersonRef, SubjectScope } from '@/components/records';
import {
  Badge,
  Button,
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
import { cn } from '@/utils/cn';
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
  const selectedId = rawSelected !== null && /^\d+$/.test(rawSelected) ? Number(rawSelected) : null;
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
          <StatTile
            label="Location cohorts"
            value={formatCount(cohorts.data?.total)}
            accent="azure"
          />
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
                        <span className="font-mono text-2xs">
                          {formatDateTime(place.firstSeen)}
                        </span>
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

/** Map units across the whole country — the scale every size below is relative to. */
const COUNTRY_WIDTH = INDIA_BOUNDS.maxX - INDIA_BOUNDS.minX;
const COUNTRY_HEIGHT = INDIA_BOUNDS.maxY - INDIA_BOUNDS.minY;

/**
 * A city never zooms tighter than this many degrees across. The corpus places
 * every location in a city within ±0.05° of its centroid, which is about six
 * kilometres, so a cluster's own extent is far too small to be a sensible window.
 */
const MIN_FOCUS_SPAN = 1.6;
const FOCUS_PAD = 0.4;

/** The country's own longitude midpoint; labels are written away from it. */
const COUNTRY_MID_X = (INDIA_BOUNDS.minX + INDIA_BOUNDS.maxX) / 2;

interface Plotted {
  readonly item: LocationRecord;
  readonly x: number;
  readonly y: number;
}

interface Cluster {
  readonly key: string;
  readonly city: string;
  readonly state: string;
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly span: number;
}

/**
 * The locations of one city, gathered. Every position stays exactly where the
 * coordinates put it; grouping only decides where a label and a ring are drawn.
 */
function clustersOf(points: Plotted[]): Cluster[] {
  const groups = new Map<string, Plotted[]>();
  for (const point of points) {
    const key = `${point.item.city}, ${point.item.state}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(point);
    else groups.set(key, [point]);
  }
  return [...groups.values()]
    .map((members) => {
      const xs = members.map((member) => member.x);
      const ys = members.map((member) => member.y);
      const first = members[0].item;
      return {
        key: `${first.city}, ${first.state}`,
        city: first.city,
        state: first.state,
        count: members.length,
        x: xs.reduce((total, value) => total + value, 0) / members.length,
        y: ys.reduce((total, value) => total + value, 0) / members.length,
        span: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** A window on one city, at the country's aspect ratio so the map cannot shift. */
function windowOf(cluster: Cluster): { viewBox: string; width: number } {
  const width = Math.max(cluster.span + FOCUS_PAD * 2, MIN_FOCUS_SPAN);
  const height = (width * COUNTRY_HEIGHT) / COUNTRY_WIDTH;
  return {
    viewBox: `${cluster.x - width / 2} ${cluster.y - height / 2} ${width} ${height}`,
    width,
  };
}

/**
 * Where the dataset's places actually are, drawn on a map of India.
 *
 * The basemap is vendored geometry projected to Web Mercator — no tile service, no
 * map API, no map library, nothing fetched at render time — and the points go
 * through the same projection, so a dot sits on the land it names.
 *
 * What it cannot claim: `canonical_lat` / `canonical_lng` are city centroids with a
 * deterministic jitter, not addresses. At country scale a city's twenty locations
 * therefore land on top of each other, which is why a city can be opened: the zoom
 * is geographic, and no point is ever moved to make the picture read better.
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
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const points = useMemo(
    () =>
      locations.map((item) => ({
        item,
        ...project(item.canonical_lat, item.canonical_lng),
      })),
    [locations],
  );
  const clusters = useMemo(() => clustersOf(points), [points]);
  const activeStates = useMemo(
    () => new Set(locations.map((item) => item.state.toLowerCase())),
    [locations],
  );

  const focus = clusters.find((cluster) => cluster.key === focusKey) ?? null;
  const view = focus ? windowOf(focus) : { viewBox: INDIA_VIEWBOX, width: COUNTRY_WIDTH };
  /* Sizes are given in map units, so they have to shrink as the window does. */
  const zoom = view.width / COUNTRY_WIDTH;
  const selected = points.find((point) => point.item.location_id === selectedId) ?? null;

  return (
    <Panel data-testid="location-map">
      <PanelHeader
        title="Geographic plot"
        subtitle="City centroids on a projected map — not address-level positions"
        accent
        actions={
          <div className="flex items-center gap-2">
            {footnote ? <span className="text-ink-4 font-mono text-2xs">{footnote}</span> : null}
            {focus ? (
              <Button size="sm" onClick={() => setFocusKey(null)} data-testid="map-zoom-out">
                Whole country
              </Button>
            ) : null}
          </div>
        }
      />
      <PanelBody>
        {loading ? <div className="skeleton h-80 w-full rounded-md" /> : null}
        {error ? <ErrorState error={error} onRetry={onRetry} compact /> : null}
        {!loading && !error && locations.length === 0 ? (
          <EmptyState title="No coordinates" description="No data available." />
        ) : null}
        {locations.length > 0 ? (
          <div className="space-y-2">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
              <div className="inset relative overflow-hidden rounded-md">
                <IndiaMap
                  label={`Map of India with ${locations.length} plotted locations`}
                  activeStates={activeStates}
                  viewBox={view.viewBox}
                  className="h-80 w-full sm:h-[26rem]"
                >
                  {/* A ring per city, sized by how many locations it holds. Click to open. */}
                  {clusters.map((cluster) => {
                    const radius = (0.32 + Math.sqrt(cluster.count) * 0.08) * zoom;
                    const toLeft = cluster.x < COUNTRY_MID_X;
                    return (
                      <g key={cluster.key} data-testid="map-cluster" data-city={cluster.city}>
                        <circle
                          cx={cluster.x}
                          cy={cluster.y}
                          r={radius}
                          fill="var(--color-cyan-500)"
                          fillOpacity={focus?.key === cluster.key ? 0.18 : 0.1}
                          stroke="var(--color-cyan-400)"
                          strokeOpacity="0.75"
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                          className="cursor-pointer"
                          onClick={() =>
                            setFocusKey(focus?.key === cluster.key ? null : cluster.key)
                          }
                        >
                          <title>{`${cluster.key} — ${formatCount(cluster.count)} locations`}</title>
                        </circle>
                        <text
                          x={cluster.x + (toLeft ? -(radius + 0.22 * zoom) : radius + 0.22 * zoom)}
                          y={cluster.y + 0.3 * zoom}
                          textAnchor={toLeft ? 'end' : 'start'}
                          fontSize={0.82 * zoom}
                          fill="var(--color-ink-2)"
                          className="pointer-events-none font-semibold"
                        >
                          {cluster.city}
                          <tspan fill="var(--color-ink-4)"> {cluster.count}</tspan>
                        </text>
                      </g>
                    );
                  })}

                  {/* Cross hairs on the selection, so it stays findable inside a cluster. */}
                  {selected ? (
                    <g
                      stroke="var(--color-cyan-300)"
                      strokeOpacity="0.5"
                      strokeWidth="1"
                      strokeDasharray="4 3"
                      vectorEffect="non-scaling-stroke"
                      className="pointer-events-none"
                    >
                      <line
                        x1={INDIA_BOUNDS.minX}
                        y1={selected.y}
                        x2={INDIA_BOUNDS.maxX}
                        y2={selected.y}
                        vectorEffect="non-scaling-stroke"
                      />
                      <line
                        x1={selected.x}
                        y1={INDIA_BOUNDS.minY}
                        x2={selected.x}
                        y2={INDIA_BOUNDS.maxY}
                        vectorEffect="non-scaling-stroke"
                      />
                    </g>
                  ) : null}

                  {points.map(({ item, x, y }) => {
                    const active = item.location_id === selectedId;
                    return (
                      <circle
                        key={item.location_id}
                        cx={x}
                        cy={y}
                        r={(active ? 0.26 : 0.13) * zoom}
                        fill={active ? 'var(--color-cyan-200)' : 'var(--color-ent-location)'}
                        fillOpacity={active ? 1 : 0.8}
                        stroke={active ? 'var(--color-cyan-300)' : 'none'}
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                        className="cursor-pointer"
                        onClick={() => onSelect(active ? null : item.location_id)}
                        data-testid="map-point"
                        data-location-id={item.location_id}
                      >
                        <title>{`${item.city}, ${item.state}`}</title>
                      </circle>
                    );
                  })}
                </IndiaMap>
              </div>
              {/* The same clusters as a list, because a wide panel leaves the map's
                own aspect ratio room to spare and a ranking is worth more there
                than empty space. Counts are the recording's, bars are relative
                to the largest city. */}
              <ul className="space-y-1" data-testid="map-city-rail">
                {clusters.map((cluster) => {
                  const open = focus?.key === cluster.key;
                  const share = cluster.count / clusters[0].count;
                  return (
                    <li key={cluster.key}>
                      <button
                        type="button"
                        onClick={() => setFocusKey(open ? null : cluster.key)}
                        className={cn(
                          'w-full rounded-sm border px-2 py-1 text-left transition-colors',
                          open
                            ? 'border-cyan-600/55 bg-cyan-500/12'
                            : 'border-line hover:border-line-accent hover:bg-panel-2',
                        )}
                        data-testid="map-city"
                        data-city={cluster.city}
                        title={`${cluster.key} — ${formatCount(cluster.count)} locations`}
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-2xs font-semibold',
                              open ? 'text-cyan-200' : 'text-ink-2',
                            )}
                          >
                            {cluster.city}
                          </span>
                          <Mono className="text-ink-4 text-2xs">{formatCount(cluster.count)}</Mono>
                        </span>
                        <span className="bg-panel-3 mt-1 block h-0.5 w-full overflow-hidden rounded-full">
                          <span
                            className="block h-full bg-cyan-500/70"
                            style={{ width: `${(share * 100).toFixed(1)}%` }}
                          />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="text-ink-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 font-mono text-2xs">
              <span>
                {focus
                  ? `${focus.key} · ${formatCount(focus.count)} locations · zoomed`
                  : 'Click a city ring to zoom · click a point to select it'}
              </span>
              <span>Boundaries: Census 2011 (DataMeet, CC-BY-SA) · Web Mercator</span>
            </div>
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
        {
          city: location.city,
          state: location.state,
          page_size: MAX_PAGE_SIZE,
        },
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
