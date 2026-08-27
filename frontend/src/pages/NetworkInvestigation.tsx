/**
 * NetworkInvestigation — the flagship screen (spec §5).
 *
 * One subject, one graph, one evidence trail. The page is a thin orchestrator:
 * it converts a route parameter into the two requests this backend actually
 * offers for a person-rooted network, filters what came back, and hands the
 * result to the graph components. It computes no analytics of its own and
 * invents no fields.
 *
 * Four decisions worth knowing before reading the code:
 *
 *  1. THE TWO ID FORMS. The route carries the backend's NUMERIC person id
 *     (`/network/445`) because `/graph/persons/{id}/network` parses that segment
 *     as an integer and answers HTTP 422 for `person:445`. Everything displayed
 *     — and `focusEntityId` — uses the PREFIXED id the response itself speaks,
 *     read from `meta`/`anchor` rather than rebuilt by string concatenation.
 *
 *  2. NO OVERLAY, EVER. `include_overlay` is pinned false in the request and
 *     there is no control for it. `SAME_RING` is the synthetic generator's own
 *     answer key, not evidence; the edge list is additionally filtered on
 *     `is_overlay` so it cannot reach the canvas even if the backend's default
 *     ever changed.
 *
 *  3. RESPONSES ARE MATCHED TO THE SUBJECT BEFORE THEY ARE DRAWN. `useAsync`
 *     keeps the previous payload while the next request is in flight, which is
 *     exactly what a depth switch needs (the old graph stays on screen instead
 *     of flashing empty) and exactly what a *subject* switch must not have
 *     (person A's graph under person B's name). Both payloads are therefore
 *     gated on the anchor's own id matching the requested one.
 *
 *  4. FILTERING HIDES ORPHANS. Turning off a relationship type removes its
 *     edges; any attribute node that was only held on screen by those edges is
 *     dropped with them, so the canvas never fills with floating dots. The
 *     anchor is the one node that always stays.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api } from '@/api';
import type { ApiError } from '@/api/client';
import {
  EdgeEvidencePanel,
  GraphLegend,
  GraphToolbar,
  NetworkGraph,
  NodeDetailsPanel,
} from '@/components/graph';
import type { NetworkGraphHandle } from '@/components/graph';
import { SearchResultList } from '@/components/search/SearchResultList';
import {
  Badge,
  Button,
  EmptyState,
  EntityBadge,
  ErrorState,
  InfoHint,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  RelationshipBadge,
  SectionHeading,
  Skeleton,
  SkeletonRows,
  Spinner,
  StatInline,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInvestigation } from '@/hooks/useInvestigation';
import type { EdgeOut, NodeOut, PersonDetailResponse } from '@/types/api';
import { cn } from '@/utils/cn';
import { personIdFromEntityId } from '@/utils/entity';
import { formatCount, humanizeToken, sortedCounts } from '@/utils/format';
import { flattenScalars, readBoolean, readNumber } from '@/utils/records';

/* The graph is the dominant element on this page: a tall canvas that still has
   a floor on a short laptop screen. The right-hand rail is matched to it on
   `lg` so it scrolls independently instead of stretching the page. */
const CANVAS_HEIGHT = 'h-[62vh] min-h-[480px]';

/** `ring_id` arrives inside `attributes`; it is held out of the observed rows. */
const OVERLAY_ATTRIBUTE_KEYS = ['ring_id', 'ground_truth_ring_id'];

/** The generator's ground-truth edge type. Never counted as observed evidence. */
const OVERLAY_EDGE_TYPE = 'SAME_RING';

/** Backend caps search at 50; 10 persons is a comfortable page list. */
const SEARCH_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;

/**
 * Deterministic listbox/option ids, mirroring the scheme documented in
 * `SearchResultList` (and duplicated in `GlobalSearch`): the component's props
 * are a fixed contract with no slot for an id prefix, so the convention is
 * shared rather than passed.
 */
const PAGE_LISTBOX_ID = 'cna-page-search-listbox';
const pageOptionDomId = (entityId: string) =>
  `cna-page-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;

const NEUTRAL_FRAMING =
  'This view shows entities that are structurally connected to the subject in the observed synthetic data, as investigation leads. Connectivity is not culpability: nothing here asserts that any person or group is criminal.';

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export function NetworkInvestigation(): ReactElement {
  const { personId: personIdParam } = useParams();
  const navigate = useNavigate();

  /* The path parameter is a plain integer. A non-numeric value is a not-found
     state rather than a request: `/graph/persons/person:445/network` is an
     HTTP 422, so firing it would only turn a bad URL into a backend error. */
  const personId =
    personIdParam !== undefined && /^\d+$/.test(personIdParam) ? Number(personIdParam) : null;
  const invalidParam = personIdParam !== undefined && personId === null;

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Network Investigation"
        subtitle={NEUTRAL_FRAMING}
        actions={
          personId !== null ? (
            <Button variant="secondary" size="sm" onClick={() => navigate('/network')}>
              Change subject
            </Button>
          ) : null
        }
      />

      {invalidParam ? (
        <EmptyState
          icon="search"
          title="That is not a person id"
          description={
            <>
              This app's network routes carry the backend's own numeric person id — for example{' '}
              <Mono>/network/445</Mono>. The path segment of{' '}
              <Mono>/graph/persons/{'{person_id}'}/network</Mono> is parsed as an integer, so a
              prefixed id such as <Mono>person:445</Mono> is rejected with HTTP 422. No request was
              sent for <Mono className="break-all">{personIdParam}</Mono>.
            </>
          }
          action={
            <Button variant="primary" onClick={() => navigate('/network')}>
              Search for a person
            </Button>
          }
        />
      ) : personId === null ? (
        <SubjectPicker />
      ) : (
        <NetworkView personId={personId} />
      )}
    </div>
  );
}

/* ========================================================================== */
/* No subject yet — a person search                                           */
/* ========================================================================== */

/**
 * The network endpoint is person-rooted, so an investigation has to start from a
 * person. That limitation is stated rather than hidden, and non-person matches
 * are held out of the list instead of being rendered as rows that cannot open.
 */
function SubjectPicker(): ReactElement {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 250);
  const canSearch = debounced.length >= MIN_QUERY_LENGTH;

  const { data, error, isLoading, retry } = useAsync(
    (signal) => api.searchGraph(debounced, SEARCH_LIMIT, { signal }),
    [debounced],
    { enabled: canSearch },
  );

  /* The response echoes the query it answered, which is the cheapest possible
     guard against rendering the previous term's hits under the current one. */
  const results = useMemo(
    () => (data && data.query === debounced ? data.results : []),
    [data, debounced],
  );

  const personRows = useMemo(
    () => results.filter((node) => personIdFromEntityId(node.entity_id) !== null),
    [results],
  );
  const otherCount = results.length - personRows.length;

  useEffect(() => {
    setActiveIndex(0);
  }, [debounced]);

  const clampedActive =
    personRows.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), personRows.length - 1);

  const select = useCallback(
    (node: NodeOut) => {
      const nextId = personIdFromEntityId(node.entity_id);
      // A non-person result cannot root a person-rooted network; skip it.
      if (nextId === null) return;
      navigate(`/network/${nextId}`);
    },
    [navigate],
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (personRows.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (Math.max(i, 0) + 1) % personRows.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (Math.max(i, 0) - 1 + personRows.length) % personRows.length);
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(personRows.length - 1);
        break;
      case 'Enter': {
        const row = clampedActive >= 0 ? personRows[clampedActive] : undefined;
        if (row) {
          event.preventDefault();
          select(row);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        setQuery('');
        break;
      default:
        break;
    }
  };

  // The debounce has not caught up with the field, so no request has been made
  // for what is on screen yet — distinct from "loading".
  const settling = trimmed.length >= MIN_QUERY_LENGTH && debounced !== trimmed;
  const invalidQuery = error !== null && error.status === 422;
  const hardError = error !== null && !invalidQuery;
  const emptyAnswer = canSearch && !isLoading && !settling && !error && personRows.length === 0;
  const listVisible = personRows.length > 0 && !settling;

  return (
    <Panel>
      <PanelHeader
        title="Select an investigation subject"
        subtitle="Search persons by name. Backed by GET /graph/search — nothing is matched locally."
      />
      <PanelBody className="px-4 py-4">
        <label className="field-label" htmlFor="cna-network-subject-search">
          Person name
        </label>
        <div className="relative mt-1.5">
          <span
            aria-hidden
            className="text-ink-4 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <circle cx="10.5" cy="10.5" r="6.25" />
              <path d="m15.2 15.2 4.3 4.3" strokeLinecap="round" />
            </svg>
          </span>
          <input
            id="cna-network-subject-search"
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={listVisible}
            aria-controls={listVisible ? PAGE_LISTBOX_ID : undefined}
            aria-activedescendant={
              listVisible && clampedActive >= 0
                ? pageOptionDomId(personRows[clampedActive].entity_id)
                : undefined
            }
            aria-autocomplete="list"
            aria-describedby="cna-network-subject-help"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="e.g. Ojas"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              'bg-inset border-line-strong text-ink placeholder:text-ink-4 h-9 w-full rounded-sm border pr-9 pl-8 font-sans text-xs transition-colors',
              'hover:border-line-accent focus:border-cyan-600/60',
              '[&::-webkit-search-cancel-button]:hidden',
            )}
          />
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2">
            {isLoading || settling ? <Spinner className="size-3" label="Searching" /> : null}
          </span>
        </div>
        <p id="cna-network-subject-help" className="text-ink-4 mt-1.5 text-2xs">
          Type at least {MIN_QUERY_LENGTH} characters. Arrow keys move through results, Enter opens
          one.
        </p>

        <div className="mt-4">
          {trimmed.length === 0 ? (
            <EmptyState
              icon="graph"
              title="An investigation starts from a person"
              description={
                <>
                  This backend's network endpoint is person-rooted —{' '}
                  <Mono>/graph/persons/{'{person_id}'}/network</Mono> — so a phone, Aadhaar id,
                  location or cell tower cannot be the root of a graph. Those entities appear{' '}
                  <em className="not-italic font-semibold">inside</em> a person's network, and can be
                  examined on the Evidence &amp; Provenance screen. Search for a person above to
                  begin.
                </>
              }
            />
          ) : trimmed.length < MIN_QUERY_LENGTH ? (
            <p className="text-ink-3 text-xs">
              Type at least {MIN_QUERY_LENGTH} characters to search the graph.
            </p>
          ) : invalidQuery ? (
            <p className="text-ink-3 text-xs">
              The backend rejected this as an empty or invalid query, so nothing was searched.
            </p>
          ) : hardError ? (
            <ErrorState error={error} onRetry={retry} />
          ) : settling || isLoading ? (
            <SkeletonRows rows={5} />
          ) : emptyAnswer ? (
            <EmptyState
              icon="search"
              title="No person matches that name"
              description={
                <>
                  Nothing in the graph's person records matches{' '}
                  <span className="text-ink-2 font-mono">{debounced}</span>.
                  {otherCount > 0 ? (
                    <>
                      {' '}
                      The search did return {formatCount(otherCount)} non-person{' '}
                      {otherCount === 1 ? 'match' : 'matches'} — those open on the Evidence &amp;
                      Provenance screen, because a network can only be rooted at a person.
                    </>
                  ) : null}
                </>
              }
            />
          ) : (
            <>
              <SearchResultList
                results={personRows}
                activeIndex={clampedActive}
                onSelect={select}
                onHoverIndex={setActiveIndex}
                variant="page"
                className={isLoading ? 'opacity-60 transition-opacity' : undefined}
              />
              <p className="text-ink-4 mt-3 text-2xs leading-relaxed">
                {formatCount(personRows.length)} person{personRows.length === 1 ? '' : 's'} shown
                {otherCount > 0
                  ? ` · ${formatCount(otherCount)} non-person ${
                      otherCount === 1 ? 'match' : 'matches'
                    } held back, because the network endpoint is person-rooted`
                  : ''}
                .
              </p>
            </>
          )}
        </div>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================================== */
/* The investigation itself                                                   */
/* ========================================================================== */

function NetworkView({ personId }: { personId: number }): ReactElement {
  const navigate = useNavigate();
  const { setSubject } = useInvestigation();
  const graphRef = useRef<NetworkGraphHandle>(null);

  const [depth, setDepth] = useState<1 | 2>(1);
  const [personsOnly, setPersonsOnly] = useState(false);
  /** `null` means "every relationship type the response contains" — so a type
      that only appears at depth 2 arrives enabled rather than silently hidden. */
  const [enabledTypes, setEnabledTypes] = useState<string[] | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeOut | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeOut | null>(null);

  /* Both requests take the NUMBER. `include_overlay` is stated explicitly so the
     absence of ground-truth edges is a visible decision, not a default. */
  const detail = useAsync((signal) => api.getPersonDetail(personId, { signal }), [personId]);
  const network = useAsync(
    (signal) =>
      api.getPersonNetwork(
        personId,
        { depth, persons_only: personsOnly, include_overlay: false },
        { signal },
      ),
    [personId, depth, personsOnly],
  );

  /* Gate both payloads on the anchor's own id. A depth change keeps the previous
     graph on screen (same person); a subject change does not. */
  const detailData =
    detail.data && personIdFromEntityId(detail.data.person.entity_id) === personId
      ? detail.data
      : null;
  const networkData =
    network.data && personIdFromEntityId(network.data.anchor.entity_id) === personId
      ? network.data
      : null;

  const anchor = networkData?.anchor ?? null;
  const anchorEntityId = anchor?.entity_id ?? null;
  const anchorLabel = anchor?.label ?? null;

  /* ------------------------------------------------ shell investigation subject */
  useEffect(() => {
    if (!anchorEntityId || !anchorLabel) return;
    // The PREFIXED id the response itself reported — never rebuilt from the route.
    setSubject({ entityId: anchorEntityId, label: anchorLabel, kind: 'person' });
  }, [anchorEntityId, anchorLabel, setSubject]);

  // `setSubject` is referentially stable, so this cleanup runs on unmount only.
  useEffect(() => () => setSubject(null), [setSubject]);

  /* ------------------------------------------------------------------- filters */
  // A new request is a new answer: the previous type filter and selection no
  // longer describe anything on screen.
  useEffect(() => {
    setEnabledTypes(null);
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [personId, depth, personsOnly]);

  /* Overlay edges are never requested. This filter is the second line of
     defence: SAME_RING is the generator's answer key and must not be drawable. */
  const observedEdges = useMemo(
    () =>
      networkData
        ? networkData.edges.filter(
            (edge) => !edge.is_overlay && edge.relationship_type !== OVERLAY_EDGE_TYPE,
          )
        : [],
    [networkData],
  );

  const edgeTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const edge of observedEdges) {
      counts[edge.relationship_type] = (counts[edge.relationship_type] ?? 0) + 1;
    }
    return counts;
  }, [observedEdges]);

  const availableTypes = useMemo(() => Object.keys(edgeTypeCounts).sort(), [edgeTypeCounts]);
  const enabledList = enabledTypes ?? availableTypes;
  const enabledSet = useMemo(() => new Set(enabledList), [enabledList]);

  const filteredEdges = useMemo(
    () => observedEdges.filter((edge) => enabledSet.has(edge.relationship_type)),
    [observedEdges, enabledSet],
  );

  /**
   * Visible nodes = the endpoints of the surviving edges, plus the anchor.
   * Without this, hiding OWNS_PHONE / LOCATED_AT would leave the phone and
   * location nodes floating unattached in the middle of the canvas.
   */
  const visibleNodes = useMemo(() => {
    if (!networkData) return [] as NodeOut[];
    const keep = new Set<string>();
    for (const edge of filteredEdges) {
      keep.add(edge.source_entity_id);
      keep.add(edge.target_entity_id);
    }
    keep.add(networkData.anchor.entity_id);
    const kept = networkData.nodes.filter((node) => keep.has(node.entity_id));
    // The anchor is in `nodes` on this backend; the guard keeps the focus node
    // present even so, because a graph with no anchor is unreadable.
    if (!kept.some((node) => node.entity_id === networkData.anchor.entity_id)) {
      kept.unshift(networkData.anchor);
    }
    return kept;
  }, [networkData, filteredEdges]);

  const nodeTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of visibleNodes) {
      counts[node.entity_type] = (counts[node.entity_type] ?? 0) + 1;
    }
    return counts;
  }, [visibleNodes]);

  const hiddenEdgeCount = observedEdges.length - filteredEdges.length;
  const hiddenNodeCount = Math.max(0, (networkData?.nodes.length ?? 0) - visibleNodes.length);

  /* --------------------------------------------------------------- selection */
  const visibleNodeIds = useMemo(
    () => new Set(visibleNodes.map((node) => node.entity_id)),
    [visibleNodes],
  );
  const visibleEdgeIds = useMemo(
    () => new Set(filteredEdges.map((edge) => edge.relationship_id)),
    [filteredEdges],
  );

  /* Derived, not stored: an element the filter or a new response removed from the
     canvas must not keep a details panel open beside it. */
  const activeNode =
    selectedNode && visibleNodeIds.has(selectedNode.entity_id) ? selectedNode : null;
  const activeEdge =
    selectedEdge && visibleEdgeIds.has(selectedEdge.relationship_id) ? selectedEdge : null;

  // One panel at a time: a node selection clears the edge and vice versa.
  const handleSelectNode = useCallback((node: NodeOut | null) => {
    setSelectedEdge(null);
    setSelectedNode(node);
  }, []);
  const handleSelectEdge = useCallback((edge: EdgeOut | null) => {
    setSelectedNode(null);
    setSelectedEdge(edge);
  }, []);

  const toggleEdgeType = useCallback(
    (edgeType: string) => {
      setEnabledTypes((previous) => {
        const base = previous ?? availableTypes;
        return base.includes(edgeType)
          ? base.filter((type) => type !== edgeType)
          : [...base, edgeType];
      });
    },
    [availableTypes],
  );

  const setAllEdgeTypes = useCallback((enabled: boolean) => {
    // `null` rather than a copy of the list, so "All" also covers types that
    // appear only after the next response.
    setEnabledTypes(enabled ? null : []);
  }, []);

  /* ------------------------------------------------------------- navigation */
  const handleInvestigate = useCallback(
    (personEntityId: string) => {
      // The callback hands over a PREFIXED id; the route needs the integer.
      const nextId = personIdFromEntityId(personEntityId);
      if (nextId === null) return;
      navigate(`/network/${nextId}`);
    },
    [navigate],
  );

  const handleOpenFir = useCallback((firId: number) => navigate(`/fir/${firId}`), [navigate]);

  /* ---------------------------------------------------------- graph controls */
  const handleFit = useCallback(() => graphRef.current?.fit(), []);
  const handleZoomIn = useCallback(() => graphRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => graphRef.current?.zoomOut(), []);
  const handleRelayout = useCallback(() => graphRef.current?.relayout(), []);

  /* ------------------------------------------------------------------ states */
  const graphError = network.status === 'error' ? network.error : null;
  // No matching payload and no error: either the first load or a subject switch.
  const showGraphSkeleton = !networkData && !graphError;
  const emptyAnswer = networkData !== null && observedEdges.length === 0;

  const responseNodeCount = readNumber(networkData?.meta, 'node_count') ?? visibleNodes.length;
  const responseEdgeCount = readNumber(networkData?.meta, 'edge_count') ?? observedEdges.length;
  const truncated = readBoolean(networkData?.meta, 'truncated') ?? false;

  /* Both requests failing with the same status is one fact (usually a 404 for an
     unknown id), so it is reported once, by the larger panel. */
  const duplicateFailure =
    graphError !== null && detail.error !== null && graphError.status === detail.error.status;

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------ subject header */}
      {detailData ? (
        <SubjectHeader detail={detailData} />
      ) : detail.status === 'error' ? (
        duplicateFailure ? null : (
          <ErrorState
            error={detail.error}
            onRetry={detail.retry}
            title="Subject record unavailable"
            compact
          />
        )
      ) : (
        <SubjectHeaderSkeleton />
      )}

      {/* --------------------------------------------------------- main layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_17.5rem] xl:grid-cols-[minmax(0,1fr)_21rem]">
        {/* Graph first in source order, so the stacked layout below `lg` leads
            with the canvas rather than with the legend. */}
        <div className="min-w-0 space-y-2.5">
          <GraphToolbar
            depth={depth}
            onDepthChange={setDepth}
            personsOnly={personsOnly}
            onPersonsOnlyChange={setPersonsOnly}
            nodeCount={responseNodeCount}
            edgeCount={responseEdgeCount}
            truncated={truncated}
            isLoading={network.isLoading}
            onFit={handleFit}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onRelayout={handleRelayout}
          />

          {graphError ? (
            <GraphRequestError error={graphError} onRetry={network.retry} />
          ) : showGraphSkeleton ? (
            <CanvasSkeleton />
          ) : emptyAnswer ? (
            <div className={cn('flex items-center justify-center', CANVAS_HEIGHT)}>
              <EmptyState
                icon="graph"
                title="No relationships at this depth"
                description={
                  <>
                    The person record exists and was returned, but the backend reports no observed
                    relationships for{' '}
                    {depth === 1 ? 'direct links' : 'either hop'} with the current settings. This is
                    an answer, not a failure — some records in this synthetic corpus are isolated.
                    {personsOnly
                      ? ' The persons-only projection is on, which hides phone, Aadhaar, location and cell-tower links; turning it off may reveal some.'
                      : ''}
                  </>
                }
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {depth === 1 ? (
                      <Button variant="primary" size="sm" onClick={() => setDepth(2)}>
                        Try 2 hops
                      </Button>
                    ) : null}
                    {personsOnly ? (
                      <Button variant="secondary" size="sm" onClick={() => setPersonsOnly(false)}>
                        Turn off persons-only
                      </Button>
                    ) : null}
                  </div>
                }
              />
            </div>
          ) : (
            <NetworkGraph
              ref={graphRef}
              nodes={visibleNodes}
              edges={filteredEdges}
              /* The PREFIXED anchor id from the response — the form the node
                 elements actually carry. */
              focusEntityId={anchorEntityId}
              selectedNodeId={activeNode?.entity_id ?? null}
              selectedEdgeId={activeEdge?.relationship_id ?? null}
              onSelectNode={handleSelectNode}
              onSelectEdge={handleSelectEdge}
              className={cn(
                CANVAS_HEIGHT,
                // A refresh dims the previous graph instead of blanking it.
                network.isLoading && 'opacity-60 transition-opacity',
              )}
            />
          )}

          {/* Live readout of what the canvas is actually showing, plus the
              filter's cost, which must never be silent. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-ink-4 text-2xs leading-relaxed">
              Lines are relationships recorded in the synthetic source data. Position in the layout
              carries no meaning beyond connectivity, and node size is degree within this view — a
              structural count, not a ranking of a person.
            </p>
            {hiddenEdgeCount > 0 ? (
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="neutral">
                  {formatCount(hiddenEdgeCount)} of {formatCount(observedEdges.length)} edges hidden
                  by filter
                </Badge>
                {hiddenNodeCount > 0 ? (
                  <span className="text-ink-4 font-mono text-2xs">
                    {formatCount(hiddenNodeCount)} orphaned {hiddenNodeCount === 1 ? 'node' : 'nodes'}{' '}
                    dropped
                  </span>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setAllEdgeTypes(true)}>
                  Show all
                </Button>
              </span>
            ) : null}
          </div>

          <span role="status" aria-live="polite" className="sr-only">
            {networkData
              ? `${formatCount(visibleNodes.length)} entities and ${formatCount(
                  filteredEdges.length,
                )} relationships shown.`
              : ''}
          </span>
        </div>

        {/* --------------------------------------------------------- side rail */}
        <aside className={cn('flex min-h-0 flex-col gap-4 lg:h-[62vh] lg:min-h-[480px]')}>
          <Panel className="shrink-0">
            <PanelHeader
              title="Legend & filter"
              subtitle="Untick a relationship type to take it off the canvas."
            />
            <PanelBody className="max-h-[22rem] overflow-y-auto px-3 py-3 lg:max-h-[15rem]">
              <GraphLegend
                nodeCounts={nodeTypeCounts}
                edgeCounts={edgeTypeCounts}
                enabledEdgeTypes={enabledList}
                onToggleEdgeType={toggleEdgeType}
                onSetAllEdgeTypes={setAllEdgeTypes}
              />
            </PanelBody>
          </Panel>

          {/* Only one of the two panels is ever mounted — a node selection and an
              edge selection are mutually exclusive by construction above. */}
          <div className="min-h-0 lg:flex-1">
            {activeNode ? (
              <NodeDetailsPanel
                node={activeNode}
                onClose={() => setSelectedNode(null)}
                onInvestigate={handleInvestigate}
                onOpenFir={handleOpenFir}
                className="max-lg:h-[30rem]"
              />
            ) : activeEdge ? (
              <EdgeEvidencePanel
                edge={activeEdge}
                onClose={() => setSelectedEdge(null)}
                className="max-lg:h-[30rem]"
              />
            ) : (
              <Panel className="h-full">
                <PanelHeader
                  title="Entity & evidence"
                  subtitle="Nothing selected on the canvas yet."
                />
                <PanelBody className="px-3 py-3">
                  <EmptyState
                    icon="graph"
                    title="Select something on the graph"
                    description={
                      <>
                        Click an entity for its record, source dataset and structural position. Click
                        a relationship for the dataset rows it was derived from. Keyboard: tab into
                        the canvas, then <Mono>+</Mono> / <Mono>-</Mono> to zoom, <Mono>0</Mono> to
                        fit, arrows to pan.
                      </>
                    }
                  />
                </PanelBody>
              </Panel>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Subject header                                                             */
/* ========================================================================== */

/** One labelled scalar, for the header's attribute strip. */
function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="field-label flex items-center gap-1 whitespace-nowrap">
        {label}
        {hint ? <InfoHint content={hint} /> : null}
      </span>
      <span className="text-ink-2 truncate font-mono text-xs">{value}</span>
    </div>
  );
}

/**
 * The subject strip above the graph. Every value comes from
 * `GET /graph/persons/{id}` — the person node, its relationship counts and the
 * backend's neighbour count. `ring_id` and `SAME_RING` are pulled out of both
 * lists and reported separately, tagged, with the reason stated in words.
 */
function SubjectHeader({ detail }: { detail: PersonDetailResponse }): ReactElement {
  const person = detail.person;
  const attributes = person.attributes;

  const attributeRows = useMemo(
    () =>
      flattenScalars(attributes)
        .filter(([key]) => !OVERLAY_ATTRIBUTE_KEYS.includes(key))
        .map(([key, value]) => ({ key, label: humanizeToken(key), value })),
    [attributes],
  );

  // Presence, not truthiness: `ring_id: null` is the generator saying it placed
  // this person in no ring, and `flattenScalars` drops nulls.
  const overlayRing = useMemo(() => {
    if (!attributes) return null;
    const key = OVERLAY_ATTRIBUTE_KEYS.find((candidate) => candidate in attributes);
    if (!key) return null;
    const raw = attributes[key];
    return { key, value: raw === null || raw === undefined ? 'null' : String(raw) };
  }, [attributes]);

  const counts = detail.relationship_counts ?? {};
  const observedCountRows = sortedCounts(counts).filter(([type]) => type !== OVERLAY_EDGE_TYPE);
  const observedTotal = observedCountRows.reduce((total, [, count]) => total + count, 0);
  const overlayEdgeCount = counts[OVERLAY_EDGE_TYPE];

  return (
    <Panel>
      <PanelBody className="px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <EntityBadge entityType={person.entity_type} />
            <h2 className="text-ink min-w-0 truncate text-base font-semibold tracking-tight">
              {person.label}
            </h2>
            <Mono className="break-all">{person.entity_id}</Mono>
            <ProvenanceTag provenance="structured" short />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <StatInline
              label="Neighbours"
              value={formatCount(detail.neighbor_count)}
              hint="The backend's own count of distinct entities directly linked to this person in the full graph. It is a whole-graph figure, so it can legitimately exceed the number of nodes drawn here — this view is depth-limited and capped."
            />
            <StatInline
              label="Observed links"
              value={formatCount(observedTotal)}
              hint="Sum of this person's relationship counts by type, as reported by the backend, with the synthetic SAME_RING overlay excluded."
            />
          </div>
        </div>

        {/* ------------------------------------------- observed attribute strip */}
        <div className="border-line mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 border-t pt-3">
          {attributeRows.map((row) => (
            <Field key={row.key} label={row.label} value={row.value} />
          ))}
          <Field
            label="Source"
            value={
              <>
                {person.source_dataset ?? '—'}
                {person.source_record_id ? ` · ${person.source_record_id}` : ''}
              </>
            }
            hint="The exact row in the original synthetic dataset this entity was materialised from, read as table:row_id. It is how anything shown here can be traced back to a source record."
          />
        </div>

        {/* --------------------------------------------- observed link type mix */}
        {observedCountRows.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {observedCountRows.map(([type, count]) => (
              <span key={type} className="flex items-center gap-1">
                <RelationshipBadge relationshipType={type} />
                <span className="text-ink-3 font-mono text-2xs tabular-nums">{count}</span>
              </span>
            ))}
          </div>
        ) : null}

        {/* ------------------------------------- ground-truth overlay, held apart */}
        {overlayRing || typeof overlayEdgeCount === 'number' ? (
          <div className="border-overlay/35 bg-overlay/10 mt-3 rounded-md border border-dashed px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <ProvenanceTag provenance="overlay" />
              <span className="field-label">Ground-truth overlay · synthetic data only</span>
              {overlayRing ? (
                <Field label={humanizeToken(overlayRing.key)} value={overlayRing.value} />
              ) : null}
              {typeof overlayEdgeCount === 'number' ? (
                <Field label="SAME_RING links" value={formatCount(overlayEdgeCount)} />
              ) : null}
            </div>
            <p className="text-ink-3 mt-2 text-2xs leading-relaxed">
              These are the data generator's own ground-truth labels: the fabricated ring it placed
              this person into, and the links it drew from that label. They exist only because this
              dataset is synthetic. They are not evidence, no analytic in this system reads them, and
              they are excluded from the graph below and from every count above — nothing anywhere in
              this interface is ranked, clustered, filtered or coloured by them. A real case file has
              no such column.
              {overlayRing?.value === 'null'
                ? ' A null value means the generator did not place this person in any ring.'
                : ''}
            </p>
          </div>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function SubjectHeaderSkeleton(): ReactElement {
  return (
    <Panel>
      <PanelBody className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="border-line mt-3 flex flex-wrap gap-4 border-t pt-3">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-44" />
        </div>
      </PanelBody>
    </Panel>
  );
}

/* ========================================================================== */
/* Canvas states                                                              */
/* ========================================================================== */

function CanvasSkeleton(): ReactElement {
  return (
    <div
      className={cn(
        'tactical-grid border-line relative flex flex-col items-center justify-center gap-3 rounded-lg border',
        CANVAS_HEIGHT,
      )}
      data-testid="canvas-skeleton"
    >
      {/* A few node-and-edge shapes rather than a bare grey slab, so the loading
          state reads as "a graph is coming" on a projector. */}
      <div aria-hidden className="flex items-center gap-3">
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-0.5 w-14" />
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="h-0.5 w-14" />
        <Skeleton className="size-9 rounded-full" />
      </div>
      <div aria-hidden className="flex items-center gap-3">
        <Skeleton className="size-7 rounded-full" />
        <Skeleton className="h-0.5 w-10" />
        <Skeleton className="size-7 rounded-full" />
      </div>
      <p className="text-ink-3 mt-2 flex items-center gap-2 text-xs">
        <Spinner className="size-3" label="Loading network" />
        Building the network from the graph engine…
      </p>
    </div>
  );
}

/**
 * A failed network request, with the honest reading of each status this endpoint
 * can return. Two of the three should be unreachable from the interface, and the
 * copy says so rather than implying the operator did something wrong.
 */
function GraphRequestError({
  error,
  onRetry,
}: {
  error: ApiError;
  onRetry: () => void;
}): ReactElement {
  const navigate = useNavigate();

  let title: string | undefined;
  let note: ReactNode = null;

  switch (error.status) {
    case 404:
      title = 'No person with that id';
      note = (
        <>
          The backend has no person row with this id, so there is no network to draw. Ids are the
          dataset's own <Mono>person_id</Mono> values and are not contiguous — reach a subject by
          searching for a name instead of typing an id.
        </>
      );
      break;
    case 422:
      title = 'Request rejected as invalid';
      note = (
        <>
          The backend could not parse the person id as an integer. This interface only ever puts
          integers in that path segment, so this should be unreachable from the UI; the backend's own
          message is shown above.
        </>
      );
      break;
    case 400:
      title = 'Request rejected';
      note = (
        <>
          The backend rejected the request — for this endpoint that is normally a traversal depth
          above its cap of 2 hops. This view only ever offers 1 or 2, so it should be unreachable
          from the UI; the backend's own message is shown above.
        </>
      );
      break;
    default:
      break;
  }

  return (
    <div className={cn('flex flex-col justify-center gap-3', CANVAS_HEIGHT)}>
      <ErrorState error={error} onRetry={onRetry} title={title} />
      {note ? (
        <div className="border-line bg-panel rounded-lg border px-4 py-3">
          <p className="text-ink-3 text-xs leading-relaxed">{note}</p>
          {error.status === 404 ? (
            <Button
              variant="primary"
              size="sm"
              className="mt-3"
              onClick={() => navigate('/network')}
            >
              Search for a person
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
