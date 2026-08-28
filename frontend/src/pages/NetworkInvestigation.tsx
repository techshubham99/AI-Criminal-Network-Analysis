/**
 * The investigation workspace — one subject, one full page.
 *
 * Without a person id: subject search. With one: a header carrying the subject,
 * their priority band and their key counts, then a tab bar over eight views. The
 * active tab owns the main content; the graph is the page, not a thumbnail beside
 * a rail, and selected entity/edge detail arrives in a drawer over it.
 *
 * The Communication, Financial and Locations tabs render the very components
 * their own routes render, scoped to this subject — one implementation per
 * product area, not a second abbreviated copy of each.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

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
import { ActivityTimeline, BAND_TONE, PersonIntelligence } from '@/components/intelligence';
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
  RelationshipBadge,
  Skeleton,
  SkeletonRows,
  Spinner,
  StatInline,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInvestigation } from '@/hooks/useInvestigation';
import { PersonCommunication } from '@/pages/CommunicationPage';
import { PersonFinancial } from '@/pages/FinancialPage';
import { PersonLocations } from '@/pages/LocationsPage';
import type { EdgeOut, NodeOut, PersonDetailResponse, PriorityScoreOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { personIdFromEntityId } from '@/utils/entity';
import { formatCount, humanizeToken, sortedCounts } from '@/utils/format';
import { flattenScalars, readBoolean, readNumber } from '@/utils/records';

/** The graph owns the main content area, so it is sized against the viewport. */
const CANVAS_HEIGHT = 'h-[68vh] min-h-[520px]';
const OVERLAY_ATTRIBUTE_KEYS = ['ring_id', 'ground_truth_ring_id'];
const OVERLAY_EDGE_TYPE = 'SAME_RING';
const SEARCH_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;

const PAGE_LISTBOX_ID = 'tracex-page-search-listbox';
const pageOptionDomId = (entityId: string) =>
  `tracex-page-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;

type WorkspaceTab =
  | 'overview'
  | 'network'
  | 'communication'
  | 'financial'
  | 'locations'
  | 'fir'
  | 'timeline'
  | 'evidence';

const TAB_LABELS: Array<{ id: WorkspaceTab; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <OverviewIcon /> },
  { id: 'network', label: 'Network', icon: <NetworkIcon /> },
  { id: 'communication', label: 'Communication', icon: <CommsIcon /> },
  { id: 'financial', label: 'Financial', icon: <FinancialIcon /> },
  { id: 'locations', label: 'Locations', icon: <LocationIcon /> },
  { id: 'fir', label: 'FIR', icon: <FirIcon /> },
  { id: 'timeline', label: 'Timeline', icon: <TimelineIcon /> },
  { id: 'evidence', label: 'Evidence', icon: <EvidenceIcon /> },
];

function OverviewIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <rect x="2" y="2" width="5" height="5" rx="0.8" /><rect x="9" y="2" width="5" height="5" rx="0.8" />
      <rect x="2" y="9" width="5" height="5" rx="0.8" /><rect x="9" y="9" width="5" height="5" rx="0.8" />
    </svg>
  );
}
function NetworkIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden className="size-3.5">
      <circle cx="4" cy="5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" /><circle cx="8" cy="13" r="1.8" />
      <path d="M5.5 5.5 10.5 4.5M5.5 6.5 7.5 11.5M11 5 9 11" />
    </svg>
  );
}
function CommsIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <path d="M14 10.8a1.4 1.4 0 0 1-1.4 1.4H4.2L1.8 14.6V4.2a1.4 1.4 0 0 1 1.4-1.4h9.4a1.4 1.4 0 0 1 1.4 1.4z" />
    </svg>
  );
}
function FinancialIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <line x1="8" y1="1" x2="8" y2="15" /><path d="M11.5 3.5H6.3a3 3 0 0 0 0 6h3.4a3 3 0 0 1 0 6H4" />
    </svg>
  );
}
function LocationIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <path d="M8 1.5a5 5 0 0 1 5 5c0 4-5 8-5 8s-5-4-5-8a5 5 0 0 1 5-5z" />
      <circle cx="8" cy="6.5" r="2" />
    </svg>
  );
}
function FirIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <path d="M9.5 2H5A1.2 1.2 0 0 0 3.8 3.2v9.6A1.2 1.2 0 0 0 5 14h6a1.2 1.2 0 0 0 1.2-1.2V5z" />
      <path d="M9.5 2v3H12.2M5.5 8.5h5M5.5 11h3" />
    </svg>
  );
}
function TimelineIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden className="size-3.5">
      <line x1="8" y1="2" x2="8" y2="14" /><circle cx="8" cy="4.5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /><circle cx="8" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
      <line x1="4" y1="4.5" x2="6.5" y2="4.5" /><line x1="4" y1="8" x2="6.5" y2="8" /><line x1="4" y1="11.5" x2="6.5" y2="11.5" />
    </svg>
  );
}
function EvidenceIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="size-3.5">
      <path d="M8 2a6 6 0 0 1 6 6M2 8a6 6 0 0 1 6-6" /><path d="M4.5 8a3.5 3.5 0 0 1 7 0v1.6" />
      <path d="M6.5 8a1.5 1.5 0 0 1 3 0v3M8 13.5V8" />
    </svg>
  );
}

/* ========================================================================== */
/* Page                                                                       */
/* ========================================================================== */

export function NetworkInvestigation({ defaultTab }: { defaultTab?: WorkspaceTab }): ReactElement {
  const { personId: personIdParam } = useParams();
  const navigate = useNavigate();

  const personId =
    personIdParam !== undefined && /^\d+$/.test(personIdParam) ? Number(personIdParam) : null;
  const invalidParam = personIdParam !== undefined && personId === null;

  return (
    <div className="space-y-4">
      {invalidParam ? (
        <EmptyState
          icon="search"
          title="That is not a person id"
          description="This route carries a numeric person id. Search for a person by name."
          action={
            <Button variant="primary" onClick={() => navigate('/network')}>
              Search for a person
            </Button>
          }
        />
      ) : personId === null ? (
        <SubjectPicker />
      ) : (
        <NetworkView personId={personId} defaultTab={defaultTab} />
      )}
    </div>
  );
}

/* ========================================================================== */
/* No subject — subject picker                                                 */
/* ========================================================================== */

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

  const results = useMemo(
    () => (data && data.query === debounced ? data.results : []),
    [data, debounced],
  );

  const personRows = useMemo(
    () => results.filter((node) => personIdFromEntityId(node.entity_id) !== null),
    [results],
  );
  const otherCount = results.length - personRows.length;

  useEffect(() => { setActiveIndex(0); }, [debounced]);

  const clampedActive =
    personRows.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), personRows.length - 1);

  const select = useCallback(
    (node: NodeOut) => {
      const nextId = personIdFromEntityId(node.entity_id);
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
      case 'Enter': {
        const row = clampedActive >= 0 ? personRows[clampedActive] : undefined;
        if (row) { event.preventDefault(); select(row); }
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

  const settling = trimmed.length >= MIN_QUERY_LENGTH && debounced !== trimmed;
  const invalidQuery = error !== null && error.status === 422;
  const hardError = error !== null && !invalidQuery;
  const emptyAnswer = canSearch && !isLoading && !settling && !error && personRows.length === 0;
  const listVisible = personRows.length > 0 && !settling;

  return (
    <div className="mx-auto max-w-xl pt-10">
      <div className="animate-fade-in mb-6 text-center">
        <h1 className="text-ink text-lg font-bold tracking-tight">Network</h1>
      </div>

      <Panel>
        <PanelBody className="px-5 py-5">
          <label className="field-label" htmlFor="tracex-network-subject-search">
            Subject search
          </label>
          <div className="relative mt-2">
            <span aria-hidden className="text-ink-4 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2">
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="10.5" cy="10.5" r="6.25" />
                <path d="m15.2 15.2 4.3 4.3" strokeLinecap="round" />
              </svg>
            </span>
            <input
              id="tracex-network-subject-search"
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
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder="Search by person name…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'bg-inset border-line-strong text-ink placeholder:text-ink-4 h-10 w-full rounded-sm border pr-9 pl-9 font-sans text-sm transition-colors',
                'hover:border-line-accent focus:border-cyan-600/60',
                '[&::-webkit-search-cancel-button]:hidden',
              )}
            />
            <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2">
              {isLoading || settling ? <Spinner className="size-3" label="Searching" /> : null}
            </span>
          </div>

          <div className="mt-4">
            {trimmed.length === 0 ? (
              <p className="text-ink-4 py-4 text-center text-xs">
                Type a name to search the graph corpus.
              </p>
            ) : trimmed.length < MIN_QUERY_LENGTH ? (
              <p className="text-ink-3 py-2 text-xs">Type at least {MIN_QUERY_LENGTH} characters.</p>
            ) : invalidQuery ? (
              <p className="text-ink-3 py-2 text-xs">Invalid query.</p>
            ) : hardError ? (
              <ErrorState error={error} onRetry={retry} compact />
            ) : settling || isLoading ? (
              <SkeletonRows rows={5} />
            ) : emptyAnswer ? (
              <p className="text-ink-3 py-4 text-center text-xs">
                No person matches <Mono>{debounced}</Mono>.
                {otherCount > 0 ? ` ${otherCount} non-person result(s) found — search evidence instead.` : ''}
              </p>
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
                {otherCount > 0 ? (
                  <p className="text-ink-4 mt-2 text-2xs">
                    {otherCount} non-person result(s) not shown.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </PanelBody>
      </Panel>
    </div>
  );
}

/* ========================================================================== */
/* Investigation workspace                                                     */
/* ========================================================================== */

function NetworkView({ personId, defaultTab }: { personId: number; defaultTab?: WorkspaceTab }): ReactElement {
  const navigate = useNavigate();
  const { setSubject } = useInvestigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const graphRef = useRef<NetworkGraphHandle>(null);

  // Tab state from URL search param
  const tabParam = searchParams.get('tab') as WorkspaceTab | null;
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(
    tabParam ?? defaultTab ?? 'overview',
  );

  const handleTabChange = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Sync URL → state
  useEffect(() => {
    const urlTab = searchParams.get('tab') as WorkspaceTab | null;
    if (urlTab && urlTab !== activeTab) setActiveTab(urlTab);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // Graph state (used when Network tab is active)
  const [depth, setDepth] = useState<1 | 2>(1);
  const [personsOnly, setPersonsOnly] = useState(false);
  const [enabledTypes, setEnabledTypes] = useState<string[] | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeOut | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeOut | null>(null);

  const detail = useAsync((signal) => api.getPersonDetail(personId, { signal }), [personId]);
  /* The header's priority band. The Overview tab reads the full breakdown itself. */
  const priority = useAsync(
    (signal) => api.getPersonIntelligence(personId, { signal }),
    [personId],
  );
  const network = useAsync(
    (signal) =>
      api.getPersonNetwork(personId, { depth, persons_only: personsOnly, include_overlay: false }, { signal }),
    [personId, depth, personsOnly],
  );

  const detailData =
    detail.data && personIdFromEntityId(detail.data.person.entity_id) === personId
      ? detail.data
      : null;
  const priorityData =
    priority.data && priority.data.priority.person_id === personId
      ? priority.data.priority
      : null;
  const networkData =
    network.data && personIdFromEntityId(network.data.anchor.entity_id) === personId
      ? network.data
      : null;

  const anchor = networkData?.anchor ?? null;
  const anchorEntityId = anchor?.entity_id ?? null;
  const anchorLabel = anchor?.label ?? null;

  useEffect(() => {
    if (!anchorEntityId || !anchorLabel) return;
    setSubject({ entityId: anchorEntityId, label: anchorLabel, kind: 'person' });
  }, [anchorEntityId, anchorLabel, setSubject]);

  useEffect(() => () => setSubject(null), [setSubject]);

  useEffect(() => {
    setEnabledTypes(null);
    setSelectedNode(null);
    setSelectedEdge(null);
  }, [personId, depth, personsOnly]);

  const observedEdges = useMemo(
    () =>
      networkData
        ? networkData.edges.filter((e) => !e.is_overlay && e.relationship_type !== OVERLAY_EDGE_TYPE)
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
    () => observedEdges.filter((e) => enabledSet.has(e.relationship_type)),
    [observedEdges, enabledSet],
  );

  const visibleNodes = useMemo(() => {
    if (!networkData) return [] as NodeOut[];
    const keep = new Set<string>();
    for (const edge of filteredEdges) {
      keep.add(edge.source_entity_id);
      keep.add(edge.target_entity_id);
    }
    keep.add(networkData.anchor.entity_id);
    const kept = networkData.nodes.filter((node) => keep.has(node.entity_id));
    if (!kept.some((node) => node.entity_id === networkData.anchor.entity_id)) kept.unshift(networkData.anchor);
    return kept;
  }, [networkData, filteredEdges]);

  const nodeTypeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const node of visibleNodes) counts[node.entity_type] = (counts[node.entity_type] ?? 0) + 1;
    return counts;
  }, [visibleNodes]);

  const hiddenEdgeCount = observedEdges.length - filteredEdges.length;
  const hiddenNodeCount = Math.max(0, (networkData?.nodes.length ?? 0) - visibleNodes.length);

  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((n) => n.entity_id)), [visibleNodes]);
  const visibleEdgeIds = useMemo(() => new Set(filteredEdges.map((e) => e.relationship_id)), [filteredEdges]);

  const activeNode = selectedNode && visibleNodeIds.has(selectedNode.entity_id) ? selectedNode : null;
  const activeEdge = selectedEdge && visibleEdgeIds.has(selectedEdge.relationship_id) ? selectedEdge : null;

  const handleSelectNode = useCallback((node: NodeOut | null) => {
    setSelectedEdge(null); setSelectedNode(node);
  }, []);
  const handleSelectEdge = useCallback((edge: EdgeOut | null) => {
    setSelectedNode(null); setSelectedEdge(edge);
  }, []);

  const toggleEdgeType = useCallback((edgeType: string) => {
    setEnabledTypes((prev) => {
      const base = prev ?? availableTypes;
      return base.includes(edgeType) ? base.filter((t) => t !== edgeType) : [...base, edgeType];
    });
  }, [availableTypes]);

  const setAllEdgeTypes = useCallback((enabled: boolean) => setEnabledTypes(enabled ? null : []), []);

  const handleInvestigate = useCallback((personEntityId: string) => {
    const nextId = personIdFromEntityId(personEntityId);
    if (nextId === null) return;
    navigate(`/network/${nextId}`);
  }, [navigate]);

  const handleOpenFir = useCallback((firId: number) => navigate(`/fir/${firId}`), [navigate]);
  const handleFit = useCallback(() => graphRef.current?.fit(), []);
  const handleZoomIn = useCallback(() => graphRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => graphRef.current?.zoomOut(), []);
  const handleRelayout = useCallback(() => graphRef.current?.relayout(), []);

  const graphError = network.status === 'error' ? network.error : null;
  const showGraphSkeleton = !networkData && !graphError;
  const emptyAnswer = networkData !== null && observedEdges.length === 0;
  const responseNodeCount = readNumber(networkData?.meta, 'node_count') ?? visibleNodes.length;
  const responseEdgeCount = readNumber(networkData?.meta, 'edge_count') ?? observedEdges.length;
  const truncated = readBoolean(networkData?.meta, 'truncated') ?? false;
  const duplicateFailure = graphError !== null && detail.error !== null && graphError.status === detail.error.status;

  if (graphError && graphError.status === 404) {
    return (
      <div className="space-y-4">
        <GraphRequestError error={graphError} onRetry={network.retry} />
      </div>
    );
  }

  return (
    <div className="space-y-3 animate-fade-in" data-testid="investigation-workspace">
      {/* Investigation header */}
      <InvestigationHeader
        detail={detailData}
        priority={priorityData}
        isLoading={detail.isInitialLoading}
        error={detail.error && !duplicateFailure ? detail.error : null}
        onRetry={detail.retry}
        onBack={() => navigate('/network')}
      />

      {/* Tab bar */}
      <div className="tab-bar bg-panel border-line rounded-t-lg border px-2">
        {TAB_LABELS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => handleTabChange(tab.id)}
            className="tab-item"
            id={`tab-${tab.id}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Main content — the active tab */}
      <div className="animate-fade-in min-w-0" key={activeTab}>
        {activeTab === 'overview' && (
          <OverviewTab
            personId={personId}
            edges={filteredEdges}
            nodes={visibleNodes}
            anchorEntityId={anchorEntityId}
          />
        )}

        {activeTab === 'network' && (
          <NetworkTab
            graphRef={graphRef}
            depth={depth}
            setDepth={setDepth}
            personsOnly={personsOnly}
            setPersonsOnly={setPersonsOnly}
            visibleNodes={visibleNodes}
            filteredEdges={filteredEdges}
            anchorEntityId={anchorEntityId}
            activeNode={activeNode}
            activeEdge={activeEdge}
            handleSelectNode={handleSelectNode}
            handleSelectEdge={handleSelectEdge}
            network={network}
            graphError={graphError}
            showGraphSkeleton={showGraphSkeleton}
            emptyAnswer={emptyAnswer}
            responseNodeCount={responseNodeCount}
            responseEdgeCount={responseEdgeCount}
            truncated={truncated}
            nodeTypeCounts={nodeTypeCounts}
            edgeTypeCounts={edgeTypeCounts}
            enabledList={enabledList}
            toggleEdgeType={toggleEdgeType}
            setAllEdgeTypes={setAllEdgeTypes}
            hiddenEdgeCount={hiddenEdgeCount}
            hiddenNodeCount={hiddenNodeCount}
            observedEdges={observedEdges}
            handleInvestigate={handleInvestigate}
            handleOpenFir={handleOpenFir}
            handleFit={handleFit}
            handleZoomIn={handleZoomIn}
            handleZoomOut={handleZoomOut}
            handleRelayout={handleRelayout}
          />
        )}

        {/* The domain components return a bare list of panels, so the tab supplies
            the spacing the standalone route's own page wrapper supplies there. */}
        {activeTab === 'communication' && (
          <div className="space-y-4" data-testid="communication-view">
            <PersonCommunication personId={personId} />
          </div>
        )}

        {activeTab === 'financial' && (
          <div className="space-y-4" data-testid="financial-view">
            <PersonFinancial personId={personId} />
          </div>
        )}

        {activeTab === 'locations' && (
          <div className="space-y-4" data-testid="locations-view">
            <PersonLocations personId={personId} />
          </div>
        )}

        {activeTab === 'fir' && <FirTab personId={personId} onOpenFir={handleOpenFir} />}

        {activeTab === 'timeline' && anchorEntityId ? (
          <ActivityTimeline
            edges={filteredEdges}
            nodes={visibleNodes}
            anchorEntityId={anchorEntityId}
          />
        ) : activeTab === 'timeline' ? (
          <Panel>
            <PanelBody>
              <EmptyState title="No dated relationships" description="No data available." />
            </PanelBody>
          </Panel>
        ) : null}

        {activeTab === 'evidence' && <EvidenceTab filteredEdges={filteredEdges} />}
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Investigation header                                                        */
/* ========================================================================== */

function InvestigationHeader({
  detail,
  priority,
  isLoading,
  error,
  onRetry,
  onBack,
}: {
  detail: PersonDetailResponse | null;
  priority: PriorityScoreOut | null;
  isLoading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  onBack: () => void;
}): ReactElement {
  if (isLoading) {
    return (
      <div className="panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <Skeleton className="h-6 w-52" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (!detail) {
    if (error) return <ErrorState error={error} onRetry={onRetry} compact />;
    return <></>;
  }

  const person = detail.person;
  const attributes = person.attributes;
  const attrRows = flattenScalars(attributes)
    .filter(([key]) => !OVERLAY_ATTRIBUTE_KEYS.includes(key))
    .slice(0, 4);
  const counts = detail.relationship_counts ?? {};
  const observedCountRows = sortedCounts(counts).filter(([type]) => type !== OVERLAY_EDGE_TYPE);
  const observedTotal = observedCountRows.reduce((t, [, c]) => t + c, 0);

  return (
    <div className="panel elevation-2 px-4 py-3 animate-slide-up" data-testid="investigation-header">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to search"
            className="border-line text-ink-4 hover:text-ink hover:border-line-strong flex size-7 shrink-0 items-center justify-center rounded-sm border transition-colors"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="size-3.5">
              <path d="M10 4 6 8l4 4" />
            </svg>
          </button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-ink truncate text-xl font-bold tracking-tight" data-testid="subject-name">
                {person.label}
              </h1>
              {priority ? (
                <span className="flex items-center gap-1.5" data-testid="subject-priority">
                  <Badge tone={BAND_TONE[priority.band]}>{priority.band}</Badge>
                  <span className="text-ink font-mono text-sm font-semibold tabular-nums">
                    {Math.round(priority.score)}
                  </span>
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              <EntityBadge entityType={person.entity_type} />
              <Mono className="text-2xs">{person.entity_id}</Mono>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <StatInline label="Neighbours" value={formatCount(detail.neighbor_count)} />
          <StatInline label="Links" value={formatCount(observedTotal)} />
          {attrRows.map(([key, value]) => (
            <StatInline key={key} label={humanizeToken(key)} value={String(value)} />
          ))}
        </div>
      </div>

      {observedCountRows.length > 0 && (
        <div className="border-line mt-2.5 flex flex-wrap items-center gap-1.5 border-t pt-2.5">
          {observedCountRows.map(([type, count]) => (
            <span key={type} className="flex items-center gap-1">
              <RelationshipBadge relationshipType={type} />
              <span className="text-ink-4 font-mono text-2xs tabular-nums">{count}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ========================================================================== */
/* Overview Tab                                                                */
/* ========================================================================== */

function OverviewTab({
  personId,
  edges,
  nodes,
  anchorEntityId,
}: {
  personId: number;
  edges: EdgeOut[];
  nodes: NodeOut[];
  anchorEntityId: string | null;
}): ReactElement {
  return (
    <div className="space-y-4">
      <PersonIntelligence personId={personId} />
      <div className="grid gap-4 lg:grid-cols-2">
        <KeyRelationships edges={edges} nodes={nodes} anchorEntityId={anchorEntityId} />
        <OverviewMetrics personId={personId} />
      </div>
      {anchorEntityId ? (
        <ActivityTimeline edges={edges} nodes={nodes} anchorEntityId={anchorEntityId} />
      ) : null}
    </div>
  );
}

/**
 * The strongest links out of the subject, ranked by how many source records back
 * them. The ranking is a record count, not a judgement about either party.
 */
function KeyRelationships({
  edges,
  nodes,
  anchorEntityId,
}: {
  edges: EdgeOut[];
  nodes: NodeOut[];
  anchorEntityId: string | null;
}): ReactElement {
  const rows = useMemo(() => {
    if (!anchorEntityId) return [];
    const labels = new Map(nodes.map((node) => [node.entity_id, node.label]));
    return edges
      .filter((edge) => !edge.is_overlay && edge.relationship_type !== OVERLAY_EDGE_TYPE)
      .map((edge) => {
        const otherId =
          edge.source_entity_id === anchorEntityId ? edge.target_entity_id : edge.source_entity_id;
        return {
          id: edge.relationship_id,
          otherId,
          label: labels.get(otherId) ?? otherId,
          type: edge.relationship_type,
          records: edge.evidence_count ?? edge.evidence?.length ?? 0,
        };
      })
      .sort((a, b) => b.records - a.records)
      .slice(0, 8);
  }, [edges, nodes, anchorEntityId]);

  return (
    <Panel data-testid="key-relationships">
      <PanelHeader title="Key relationships" accent />
      <PanelBody padded={false}>
        {rows.length === 0 ? (
          <EmptyState title="No relationships" description="No data available." />
        ) : (
          <ul className="divide-line divide-y">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 px-3.5 py-2"
                data-testid="key-relationship-row"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <RelationshipBadge relationshipType={row.type} />
                  <span className="text-ink truncate text-xs font-medium" title={row.otherId}>
                    {row.label}
                  </span>
                </div>
                <span className="text-ink-3 shrink-0 font-mono text-2xs tabular-nums">
                  {formatCount(row.records)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}

function OverviewMetrics({ personId }: { personId: number }): ReactElement {
  const analytics = useAsync((signal) => api.getPersonAnalytics(personId, { signal }), [personId]);

  if (analytics.isInitialLoading) return <Panel><PanelBody><SkeletonRows rows={5} /></PanelBody></Panel>;
  if (analytics.error) return <ErrorState error={analytics.error} onRetry={analytics.retry} compact />;
  if (!analytics.data) return <></>;

  const data = analytics.data;
  const metrics = [
    { label: 'Degree', value: formatCount(data.degree), hint: 'Total connections' },
    { label: 'PageRank', value: typeof data.pagerank === 'number' ? data.pagerank.toFixed(6) : '—', hint: 'Structural importance' },
    { label: 'Betweenness', value: typeof data.betweenness === 'number' ? data.betweenness.toFixed(4) : '—', hint: 'Bridge metric' },
    { label: 'Degree Centrality', value: typeof data.degree_centrality === 'number' ? data.degree_centrality.toFixed(4) : '—', hint: 'Normalized degree' },
    { label: 'Community', value: data.community_id ?? '—', hint: 'Detected community' },
  ];

  return (
    <Panel>
      <PanelHeader title="Network Metrics" accent />
      <PanelBody className="divide-line divide-y">
        {metrics.map((m) => (
          <div key={m.label} className="metric-row">
            <span className="field-label flex items-center gap-1">
              {m.label}
              <InfoHint content={m.hint} />
            </span>
            <span className="text-ink font-mono text-xs tabular-nums">{m.value}</span>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}

/* ========================================================================== */
/* Network Tab (hero graph)                                                    */
/* ========================================================================== */

interface NetworkTabProps {
  graphRef: React.RefObject<NetworkGraphHandle | null>;
  depth: 1 | 2;
  setDepth: (d: 1 | 2) => void;
  personsOnly: boolean;
  setPersonsOnly: (v: boolean) => void;
  visibleNodes: NodeOut[];
  filteredEdges: EdgeOut[];
  anchorEntityId: string | null;
  activeNode: NodeOut | null;
  activeEdge: EdgeOut | null;
  handleSelectNode: (n: NodeOut | null) => void;
  handleSelectEdge: (e: EdgeOut | null) => void;
  network: { isLoading: boolean; status: string; retry: () => void };
  graphError: ApiError | null;
  showGraphSkeleton: boolean;
  emptyAnswer: boolean;
  responseNodeCount: number;
  responseEdgeCount: number;
  truncated: boolean;
  nodeTypeCounts: Record<string, number>;
  edgeTypeCounts: Record<string, number>;
  enabledList: string[];
  toggleEdgeType: (t: string) => void;
  setAllEdgeTypes: (enabled: boolean) => void;
  hiddenEdgeCount: number;
  hiddenNodeCount: number;
  observedEdges: EdgeOut[];
  handleInvestigate: (id: string) => void;
  handleOpenFir: (id: number) => void;
  handleFit: () => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  handleRelayout: () => void;
}

function NetworkTab(props: NetworkTabProps): ReactElement {
  const {
    graphRef, depth, setDepth, personsOnly, setPersonsOnly,
    visibleNodes, filteredEdges, anchorEntityId, activeNode, activeEdge,
    handleSelectNode, handleSelectEdge, network, graphError,
    showGraphSkeleton, emptyAnswer, responseNodeCount, responseEdgeCount,
    truncated, nodeTypeCounts, edgeTypeCounts, enabledList, toggleEdgeType,
    setAllEdgeTypes, hiddenEdgeCount, hiddenNodeCount, observedEdges,
    handleInvestigate, handleOpenFir, handleFit, handleZoomIn, handleZoomOut,
    handleRelayout,
  } = props;

  return (
    <div className="min-w-0 space-y-2">
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

      {/* The canvas owns the width; selection detail arrives over it, not beside it. */}
      <div className="relative min-w-0">
        {graphError ? (
          <GraphRequestError error={graphError} onRetry={network.retry} />
        ) : showGraphSkeleton ? (
          <CanvasSkeleton />
        ) : emptyAnswer ? (
          <div className={cn('flex items-center justify-center', CANVAS_HEIGHT)}>
            <EmptyState
              icon="graph"
              title="No relationships at this depth"
              description="No observed relationships found. Try 2 hops or disable persons-only."
              action={
                <div className="flex gap-2">
                  {depth === 1 && <Button variant="primary" size="sm" onClick={() => setDepth(2)}>Try 2 hops</Button>}
                  {personsOnly && <Button variant="secondary" size="sm" onClick={() => setPersonsOnly(false)}>All entities</Button>}
                </div>
              }
            />
          </div>
        ) : (
          <NetworkGraph
            ref={graphRef}
            nodes={visibleNodes}
            edges={filteredEdges}
            focusEntityId={anchorEntityId}
            selectedNodeId={activeNode?.entity_id ?? null}
            selectedEdgeId={activeEdge?.relationship_id ?? null}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            className={cn(CANVAS_HEIGHT, network.isLoading && 'opacity-60 transition-opacity')}
          />
        )}

        {activeNode || activeEdge ? (
          <div
            className="elevation-3 absolute inset-y-2 right-2 z-20 w-[26rem] max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg animate-slide-in"
            data-testid="graph-drawer"
          >
            {activeNode ? (
              <NodeDetailsPanel
                node={activeNode}
                onClose={() => handleSelectNode(null)}
                onInvestigate={handleInvestigate}
                onOpenFir={handleOpenFir}
                className="min-h-full"
              />
            ) : activeEdge ? (
              <EdgeEvidencePanel
                edge={activeEdge}
                onClose={() => handleSelectEdge(null)}
                className="min-h-full"
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {hiddenEdgeCount > 0 ? (
        <div className="flex items-center gap-2">
          <Badge tone="neutral">{formatCount(hiddenEdgeCount)} of {formatCount(observedEdges.length)} edges hidden</Badge>
          {hiddenNodeCount > 0 && <span className="text-ink-4 font-mono text-2xs">{formatCount(hiddenNodeCount)} orphaned nodes dropped</span>}
          <Button variant="ghost" size="sm" onClick={() => setAllEdgeTypes(true)}>Show all</Button>
        </div>
      ) : null}

      {/* Compact filter strip, under the canvas rather than squeezing it. */}
      <Panel>
        <PanelHeader title="Filters" />
        <PanelBody className="px-3 py-2.5">
          <GraphLegend
            nodeCounts={nodeTypeCounts}
            edgeCounts={edgeTypeCounts}
            enabledEdgeTypes={enabledList}
            onToggleEdgeType={toggleEdgeType}
            onSetAllEdgeTypes={setAllEdgeTypes}
          />
        </PanelBody>
      </Panel>

      <span role="status" aria-live="polite" className="sr-only">
        {filteredEdges.length > 0 ? `${formatCount(visibleNodes.length)} entities and ${formatCount(filteredEdges.length)} relationships shown.` : ''}
      </span>
    </div>
  );
}

/* ========================================================================== */
/* FIR Tab                                                                     */
/* ========================================================================== */

function FirTab({
  personId,
  onOpenFir,
}: {
  personId: number;
  onOpenFir: (firId: number) => void;
}): ReactElement {
  // Show FIR nodes from a 2-hop network that includes FIR entities
  const network = useAsync(
    (signal) => api.getPersonNetwork(personId, { depth: 2, include_overlay: false }, { signal }),
    [personId],
  );

  if (network.isInitialLoading) return <Panel><PanelBody><SkeletonRows rows={5} /></PanelBody></Panel>;
  if (network.error) return <ErrorState error={network.error} onRetry={network.retry} compact />;
  if (!network.data) return <></>;

  const firNodes = network.data.nodes.filter((n) => n.entity_type?.toUpperCase() === 'FIR');
  const firEdges = network.data.edges.filter((e) => !e.is_overlay && (e.relationship_type === 'NAMED_IN_FIR' || e.relationship_type === 'REPORTED_AGAINST'));

  if (firNodes.length === 0) {
    return (
      <Panel>
        <PanelBody>
          <EmptyState icon="graph" title="No FIR records linked" description="No FIR entities found in this person's network." />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader title={`FIR Records · ${firNodes.length}`} accent />
      <PanelBody className="divide-line divide-y">
        {firNodes.map((node) => {
          const firEdge = firEdges.find((e) =>
            e.source_entity_id === node.entity_id || e.target_entity_id === node.entity_id,
          );
          return (
            <div key={node.entity_id} className="flex items-center justify-between py-3">
              <div>
                <div className="flex items-center gap-2">
                  <EntityBadge entityType="FIR" />
                  <span className="text-ink text-xs font-semibold">{node.label}</span>
                </div>
                {firEdge && (
                  <RelationshipBadge relationshipType={firEdge.relationship_type} className="mt-1" />
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const parts = node.entity_id.split(':');
                  const id = parts[1] ? Number(parts[1]) : null;
                  if (id !== null && !isNaN(id)) onOpenFir(id);
                }}
              >
                Open →
              </Button>
            </div>
          );
        })}
      </PanelBody>
    </Panel>
  );
}

/* ========================================================================== */
/* Evidence Tab                                                                */
/* ========================================================================== */

function EvidenceTab({
  filteredEdges,
}: {
  filteredEdges: EdgeOut[];
}): ReactElement {
  if (filteredEdges.length === 0) {
    return (
      <Panel>
        <PanelBody>
          <EmptyState icon="graph" title="No relationship evidence" description="No data available." />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHeader title={`Relationship Evidence · ${filteredEdges.length}`} accent />
      <PanelBody className="divide-line max-h-[60vh] divide-y overflow-y-auto">
        {filteredEdges.slice(0, 50).map((edge) => (
          <div key={edge.relationship_id} className="py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <RelationshipBadge relationshipType={edge.relationship_type} />
              <span className="text-ink-4 font-mono text-2xs">{edge.source_entity_id}</span>
              <span className="text-ink-4 text-2xs">→</span>
              <span className="text-ink-4 font-mono text-2xs">{edge.target_entity_id}</span>
            </div>
            {edge.evidence && edge.evidence.length > 0 && (
              <p className="text-ink-4 mt-0.5 font-mono text-2xs">
                Evidence: {edge.evidence.slice(0, 3).join(', ')}
                {edge.evidence.length > 3 ? ` +${edge.evidence.length - 3}` : ''}
              </p>
            )}
          </div>
        ))}
        {filteredEdges.length > 50 && (
          <p className="text-ink-4 py-2 text-center text-2xs">Showing 50 of {filteredEdges.length} relationships.</p>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ========================================================================== */
/* Canvas states                                                               */
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
        Building network graph…
      </p>
    </div>
  );
}

function GraphRequestError({ error, onRetry }: { error: ApiError; onRetry: () => void }): ReactElement {
  const navigate = useNavigate();

  return (
    <div className={cn('flex flex-col justify-center gap-3', CANVAS_HEIGHT)}>
      <ErrorState error={error} onRetry={onRetry} title={error.status === 404 ? 'No person with that id' : undefined} />
      {error.status === 404 && (
        <Button variant="primary" size="sm" onClick={() => navigate('/network')}>Search for a person</Button>
      )}
    </div>
  );
}
