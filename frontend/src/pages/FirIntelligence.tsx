/**
 * FirIntelligence — the FIR list, and one FIR read twice.
 *
 * With no `:firId` the page is the list: the structured `firs` table full width,
 * or a narrative search over extracted entities. Selecting an FIR replaces the
 * list with the record; neither view is squeezed into a rail beside the other.
 *
 * The detail view exists to answer a single question honestly: what does the FIR
 * *record* say, and what does a deterministic reader claim the FIR *narrative*
 * says? Those are two different kinds of fact and the layout never lets them blur:
 *
 *   SECTION 1   the structured columns of the `firs` row. Recorded values.
 *   SECTIONS 2-5 everything the Phase 3 NLP layer derived from the free text —
 *               entity spans, resolutions, relationships, graph impact. Each one
 *               carries a NARRATIVE-DERIVED tag, and the backend's own reasons,
 *               notes and zero-counts are reproduced rather than smoothed over.
 *
 * Four independent requests feed the main column (`getFir`, `getFirEntities`,
 * `getFirRelationships`, `getFirGraphImpact`), each in its own `useAsync` so one
 * failing call cannot blank the rest. Sections 2 and 3 share a single request
 * because they render two views of the same `/nlp/firs/{id}/entities` response:
 * the highlighted narrative and the entity table, cross-linked by one shared
 * active-entity index.
 *
 * ID FORMS. `:firId` and every id inside an FIR record (`complainant_id`,
 * `accused_id`, `location_id`) are already plain integers, and this app's routes
 * take plain integers, so nothing on this page is ever prefixed or encoded into a
 * path. Prefixed entity ids appear only where they belong: in a query string
 * (`/evidence?entity=location:178`) and in the ids the backend hands back.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '@/api';
import type { ApiError } from '@/api';
import { EntityTable } from '@/components/nlp/EntityTable';
import { GraphImpactPanel } from '@/components/nlp/GraphImpactPanel';
import { NarrativeViewer } from '@/components/nlp/NarrativeViewer';
import { RelationshipList } from '@/components/nlp/RelationshipList';
import { Cell, DataTable, Pager, PersonRef } from '@/components/records';
import {
  Badge,
  Button,
  Divider,
  EmptyState,
  EntityBadge,
  ErrorState,
  InfoHint,
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  ProvenanceTag,
  RelationshipBadge,
  SegmentedControl,
  Skeleton,
  SkeletonRows,
  SkeletonText,
  Spinner,
  StatInline,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInvestigation } from '@/hooks/useInvestigation';
import { usePersonNames } from '@/hooks/usePersonNames';
import type { EntityOut, FIR, NlpSearchResponse, PageMeta, SearchHitOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount, formatDateTime, humanizeToken, sortedCounts, truncate } from '@/utils/format';

/** A full-width table can show more rows than a rail could. */
const RECORDS_PAGE_SIZE = 20;
const SEARCH_PAGE_SIZE = 10;
/** The backend caps a page at 200, which is the whole `locations` table here. */
const LOCATION_INDEX_SIZE = 200;
/** `/nlp/search` returns HTTP 422 for an empty query, so the box waits for input. */
const MIN_QUERY_LENGTH = 2;

/* ======================================================================== page */

export function FirIntelligence(): ReactElement {
  const { firId: rawFirId } = useParams<{ firId?: string }>();
  const navigate = useNavigate();
  const { setSubject } = useInvestigation();

  // Digits only. `Number('')` is 0 and `Number('79x')` is NaN, so the shape of
  // the param is checked before it is converted — same contract as the network
  // page's `:personId`.
  const hasParam = rawFirId !== undefined && rawFirId !== '';
  const isNumericParam = hasParam && /^\d+$/.test(rawFirId);
  const firId = isNumericParam ? Number(rawFirId) : null;

  const record = useAsync(
    (signal) => {
      // A real guard rather than a cast: the request is disabled while `firId` is
      // null, and if it were ever reached the rejection is visible, not silent.
      if (firId === null) return Promise.reject(new Error('No FIR is selected.'));
      return api.getFir(firId, { signal });
    },
    [firId],
    { enabled: firId !== null },
  );

  // Name the active subject for the top bar once the record is actually on hand;
  // the label comes from the response, never from the URL.
  useEffect(() => {
    const fir = record.data;
    if (!fir) return;
    setSubject({ entityId: `fir:${fir.fir_id}`, label: `FIR ${fir.fir_id}`, kind: 'fir' });
  }, [record.data, setSubject]);

  const recordNotFound = record.error?.status === 404;

  /* Default state: the FIR list *is* the page. Selecting one replaces it with the
     full record, so neither view is squeezed into a rail beside the other. */
  if (!hasParam) {
    return (
      <div className="space-y-3 animate-fade-in">
        <h1 className="text-ink text-base font-bold tracking-tight">FIR Intelligence</h1>
        <FirBrowser />
      </div>
    );
  }

  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-center gap-2">
        <Link
          to="/fir"
          className="text-ink-3 hover:text-cyan-300 border-line hover:border-line-accent rounded-sm border px-2 py-1 text-2xs font-semibold transition-colors"
        >
          ← FIRs
        </Link>
        <h1 className="text-ink text-base font-bold tracking-tight">
          FIR {isNumericParam ? firId : rawFirId}
        </h1>
      </div>

      {!isNumericParam || firId === null ? (
        <NotFoundPanel
          heading="Invalid FIR reference"
          message={`"${rawFirId}" is not a valid FIR id.`}
          onBack={() => navigate('/fir')}
        />
      ) : recordNotFound ? (
        <NotFoundPanel
          heading={`FIR ${firId} not found`}
          message={record.error?.message ?? 'No FIR record with that id.'}
          onBack={() => navigate('/fir')}
          onRetry={record.retry}
        />
      ) : (
        <div className="min-w-0 space-y-4">
          <FirRecordPanel
            record={record.data}
            isLoading={record.isLoading}
            error={record.error}
            onRetry={record.retry}
          />
          <ExtractionSections firId={firId} />
          <RelationshipsSection firId={firId} />
          <GraphImpactSection firId={firId} />
        </div>
      )}
    </div>
  );
}

/* ============================================================== FIR browser */

type BrowseMode = 'records' | 'narrative';

const BROWSE_MODES = [
  { value: 'records' as BrowseMode, label: 'FIR records', title: 'Browse the structured FIR table' },
  {
    value: 'narrative' as BrowseMode,
    label: 'Narrative search',
    title: 'Search entities extracted from FIR narrative text',
  },
];

/**
 * FirBrowser — two ways to reach an FIR, kept visibly distinct because they are
 * not the same query. "FIR records" pages the structured `firs` table. "Narrative
 * search" searches the *extracted entities* over narrative text, so its hits are
 * narrative-derived and tagged as such.
 */
function FirBrowser(): ReactElement {
  const [mode, setMode] = useState<BrowseMode>('records');
  const [recordsPage, setRecordsPage] = useState(1);
  const [query, setQuery] = useState('');
  const [searchPage, setSearchPage] = useState(1);

  const debouncedQuery = useDebouncedValue(query, 250);
  const trimmedQuery = debouncedQuery.trim();
  const searchReady = trimmedQuery.length >= MIN_QUERY_LENGTH;

  // A new query is a new result set; page 1 or the request would ask for a page
  // that may not exist.
  useEffect(() => {
    setSearchPage(1);
  }, [trimmedQuery]);

  const firs = useAsync(
    (signal) => api.listFirs(recordsPage, RECORDS_PAGE_SIZE, { signal }),
    [recordsPage],
    { enabled: mode === 'records' },
  );

  const hits = useAsync(
    (signal) => api.searchNlp(trimmedQuery, searchPage, SEARCH_PAGE_SIZE, { signal }),
    [trimmedQuery, searchPage],
    { enabled: mode === 'narrative' && searchReady },
  );

  // An FIR row carries `location_id`, not a place. One request resolves the whole
  // table's worth of ids to the city the backend recorded for each.
  const locations = useAsync(
    (signal) => api.listLocations({ page_size: LOCATION_INDEX_SIZE }, { signal }),
    [],
    { enabled: mode === 'records' },
  );

  const locationIndex = useMemo(() => {
    const index = new Map<number, string>();
    for (const location of locations.data?.items ?? []) {
      index.set(location.location_id, `${location.city}, ${location.state}`);
    }
    return index;
  }, [locations.data]);

  return (
    <Panel>
      <PanelHeader
        title="FIRs"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              options={BROWSE_MODES}
              value={mode}
              onChange={setMode}
              label="FIR search mode"
            />
            <ProvenanceTag
              provenance={mode === 'records' ? 'structured' : 'narrative'}
              short
            />
          </div>
        }
      />

      {mode === 'records' ? (
        <RecordsList
          items={firs.data?.items ?? null}
          meta={firs.data?.meta ?? null}
          locationIndex={locationIndex}
          isInitialLoading={firs.isInitialLoading}
          isLoading={firs.isLoading}
          error={firs.error}
          onRetry={firs.retry}
          onPage={setRecordsPage}
        />
      ) : (
        <NarrativeSearchList
          query={query}
          onQueryChange={setQuery}
          searchReady={searchReady}
          isSettling={query.trim() !== trimmedQuery}
          response={hits.data}
          isInitialLoading={hits.isInitialLoading}
          isLoading={hits.isLoading}
          error={hits.error}
          onRetry={hits.retry}
          onPage={setSearchPage}
        />
      )}
    </Panel>
  );
}

/** The structured `firs` table: one row per FIR, the columns it actually holds. */
function RecordsList({
  items,
  meta,
  locationIndex,
  isInitialLoading,
  isLoading,
  error,
  onRetry,
  onPage,
}: {
  items: FIR[] | null;
  meta: PageMeta | null;
  locationIndex: ReadonlyMap<number, string>;
  isInitialLoading: boolean;
  isLoading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  onPage: (page: number) => void;
}): ReactElement {
  const names = usePersonNames();

  if (isInitialLoading) {
    return (
      <PanelBody>
        <SkeletonRows rows={6} />
      </PanelBody>
    );
  }

  if (error) {
    return (
      <PanelBody>
        <ErrorState error={error} onRetry={onRetry} compact title="FIR list unavailable" />
      </PanelBody>
    );
  }

  if (!items || items.length === 0) {
    return (
      <PanelBody>
        <EmptyState title="No FIRs on this page" description="No data available." />
      </PanelBody>
    );
  }

  return (
    <>
      {/* `isLoading` after the first load dims the stale page instead of
          collapsing to a skeleton — the operator keeps their place. */}
      <div className={cn('transition-opacity', isLoading && 'opacity-55')}>
        <DataTable head={['FIR', 'Date', 'Complainant', 'Accused', 'Location', 'Narrative']}>
          {items.map((fir) => (
            <tr key={fir.fir_id} className="hover:bg-panel-2 transition-colors">
              <Cell>
                <Link
                  to={`/fir/${fir.fir_id}`}
                  className="text-ink hover:text-cyan-300 font-mono text-xs font-semibold underline decoration-dotted underline-offset-2"
                >
                  {fir.fir_id}
                </Link>
              </Cell>
              <Cell>
                <span className="text-ink-3 font-mono text-2xs whitespace-nowrap">
                  {formatDateTime(fir.date)}
                </span>
              </Cell>
              <Cell>
                <PersonRef personId={fir.complainant_id} names={names} />
              </Cell>
              <Cell>
                <PersonRef personId={fir.accused_id} names={names} />
              </Cell>
              <Cell>
                {locationIndex.get(fir.location_id) ?? <Mono>location:{fir.location_id}</Mono>}
              </Cell>
              <Cell className="text-ink-3 max-w-[26rem] min-w-[16rem]">
                {truncate(fir.narrative ?? '', 130) || '—'}
              </Cell>
            </tr>
          ))}
        </DataTable>
      </div>
      <Pager meta={meta} onPage={onPage} isLoading={isLoading} unit="FIRs" />
    </>
  );
}

function NarrativeSearchList({
  query,
  onQueryChange,
  searchReady,
  isSettling,
  response,
  isInitialLoading,
  isLoading,
  error,
  onRetry,
  onPage,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  searchReady: boolean;
  isSettling: boolean;
  response: NlpSearchResponse | null;
  isInitialLoading: boolean;
  isLoading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  onPage: (page: number) => void;
}): ReactElement {
  const counts = sortedCounts(response?.counts_by_type);

  return (
    <>
      <div className="border-line border-b px-3 py-2.5">
        <label htmlFor="fir-narrative-search" className="field-label flex items-center gap-1.5">
          <span>Search narrative text</span>
          <InfoHint content="Searches the entities extracted from FIR narratives — names, phone numbers, Aadhaar numbers, dates and places — not the raw sentence text." />
        </label>
        <div className="relative mt-1.5">
          <input
            id="fir-narrative-search"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Mumbai, a name, a phone…"
            autoComplete="off"
            spellCheck={false}
            className="bg-inset border-line focus:border-line-accent text-ink placeholder:text-ink-4 h-8.5 w-full rounded-sm border px-2.5 pr-8 font-mono text-xs transition-colors"
          />
          {isLoading || isSettling ? (
            <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
              <Spinner label="Searching narratives" />
            </span>
          ) : null}
        </div>
      </div>

      {!searchReady ? (
        <PanelBody>
          <EmptyState icon="search" title={`Type at least ${MIN_QUERY_LENGTH} characters`} />
        </PanelBody>
      ) : error ? (
        <PanelBody>
          <ErrorState error={error} onRetry={onRetry} compact title="Narrative search failed" />
        </PanelBody>
      ) : isInitialLoading || !response ? (
        <PanelBody>
          <SkeletonRows rows={5} />
        </PanelBody>
      ) : response.items.length === 0 ? (
        <PanelBody>
          <EmptyState
            icon="search"
            title={`No extracted entity matches “${response.query}”`}
            description="No data available."
          />
        </PanelBody>
      ) : (
        <>
          <div className="border-line bg-panel-2/60 space-y-2 border-b px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <StatInline label="FIRs matched" value={formatCount(response.matched_fir_count)} />
              <StatInline label="Hits" value={formatCount(response.meta.total)} />
            </div>
            {counts.length > 0 ? (
              <ul className="flex flex-wrap items-center gap-1.5">
                {counts.map(([type, count]) => (
                  <li key={type} className="flex items-center gap-1">
                    <EntityBadge entityType={type} />
                    <span className="text-ink-3 font-mono text-2xs tabular-nums">{count}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <ul
            className={cn(
              'divide-line/70 max-h-[32rem] divide-y overflow-y-auto transition-opacity',
              isLoading && 'opacity-55',
            )}
          >
            {response.items.map((hit, index) => (
              <li key={`${hit.fir_id}-${hit.entity.character_start}-${hit.entity.character_end}-${index}`}>
                <SearchHitRow hit={hit} />
              </li>
            ))}
          </ul>

          <Pager meta={response.meta} onPage={onPage} isLoading={isLoading} unit="hits" />
        </>
      )}
    </>
  );
}

/** One `/nlp/search` hit: which FIR, which field matched, and the mention itself. */
function SearchHitRow({ hit }: { hit: SearchHitOut }): ReactElement {
  const { entity, resolution } = hit;
  return (
    <Link
      to={`/fir/${hit.fir_id}`}
      className="group hover:bg-panel-2 focus-visible:bg-panel-2 block border-l-2 border-l-transparent px-3 py-2.5 transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink group-hover:text-cyan-200 font-mono text-xs font-semibold">
          FIR {hit.fir_id}
        </span>
        <EntityBadge entityType={entity.entity_type} className="shrink-0" />
      </div>

      <p className="text-ink-2 mt-1 font-mono text-2xs break-words">{entity.raw_text}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone="muted" title="Which field of the extracted entity the query matched">
          {humanizeToken(hit.matched_field)}
        </Badge>
        {resolution.matched_entity_id ? (
          <Mono title="The structured graph entity this mention resolved to">
            {resolution.matched_entity_id}
          </Mono>
        ) : (
          <Badge tone="muted" title={resolution.reason ?? undefined}>
            {humanizeToken(resolution.status)}
          </Badge>
        )}
      </div>
    </Link>
  );
}

/* ============================================================= 1. FIR record */

/**
 * Section 1 — the structured record.
 *
 * Every value here is a column of the `firs` row. The person ids are already
 * integers and the network route takes an integer, so each links directly to
 * `/network/{id}` with no prefixing and no encoding. A null id renders as an em
 * dash with no link rather than a dead control.
 */
function FirRecordPanel({
  record,
  isLoading,
  error,
  onRetry,
}: {
  record: FIR | null;
  isLoading: boolean;
  error: ApiError | null;
  onRetry: () => void;
}): ReactElement {
  return (
    <Panel>
      <PanelHeader
        title={<SectionTitle ordinal="01">FIR record</SectionTitle>}
        subtitle="As filed. Recorded values, not extracted."
        actions={<ProvenanceTag provenance="structured" short />}
      />
      <PanelBody>
        {error ? (
          <ErrorState error={error} onRetry={onRetry} compact title="FIR record unavailable" />
        ) : isLoading && !record ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        ) : !record ? (
          <EmptyState
            title="No record returned"
            description="The request succeeded but carried no FIR body."
          />
        ) : (
          <div className="space-y-3">
            <KeyValueList>
              <KeyValueRow label="FIR id" value={<Mono>{record.fir_id}</Mono>} mono />
              <KeyValueRow
                label="Date filed"
                value={formatDateTime(record.date)}
                hint="The `date` column of the FIR row. Narratives in this corpus also quote a date inside the text; where they differ, the two are different fields and the extracted one is shown in section 3."
              />
              <KeyValueRow
                label="Complainant"
                value={<PersonLink personId={record.complainant_id} role="complainant" />}
              />
              <KeyValueRow
                label="Accused"
                value={<PersonLink personId={record.accused_id} role="accused" />}
                hint="The `accused_id` column names the person the report was filed against. It is a field of the record, not a finding of this system, and it is not a judgement of guilt."
              />
              <KeyValueRow label="Location" value={<LocationLink locationId={record.location_id} />} />
              <KeyValueRow
                label="Source record"
                value={<Mono>firs:{record.fir_id}</Mono>}
                hint="The dataset citation for this row — table name and primary key. Every fact in this section can be traced back to it."
              />
            </KeyValueList>
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}

/**
 * A person id column, rendered as the integer the column actually holds, with the
 * graph's own prefixed name for the same row shown alongside it in grey. The link
 * target is the integer route — `/network/445` — because that is the only form
 * this backend's paths accept.
 */
function PersonLink({
  personId,
  role,
}: {
  personId: number | null | undefined;
  role: string;
}): ReactElement {
  if (personId === null || personId === undefined || !Number.isFinite(personId)) {
    return <span className="text-ink-4">— not recorded</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link
        to={`/network/${personId}`}
        className="text-azure-300 hover:text-cyan-300 font-mono font-semibold transition-colors"
        title={`Open the observed network of the ${role}, person ${personId}`}
      >
        {personId}
      </Link>
      <span className="text-ink-4 text-2xs tracking-wide uppercase">{role}</span>
      <Mono title="How the graph names this same row in its responses">person:{personId}</Mono>
    </span>
  );
}

function LocationLink({ locationId }: { locationId: number | null | undefined }): ReactElement {
  if (locationId === null || locationId === undefined || !Number.isFinite(locationId)) {
    return <span className="text-ink-4">— not recorded</span>;
  }
  // Query parameters take the PREFIXED entity id; only paths take the integer.
  const search = new URLSearchParams({ entity: `location:${locationId}` }).toString();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Link
        to={{ pathname: '/evidence', search: `?${search}` }}
        className="text-azure-300 hover:text-cyan-300 font-mono font-semibold transition-colors"
        title={`Inspect location ${locationId} in Evidence & Provenance`}
      >
        {locationId}
      </Link>
      <Mono title="How the graph names this same row in its responses">location:{locationId}</Mono>
    </span>
  );
}

/* ================================== 2 & 3. narrative + extracted entities */

/**
 * Sections 2 and 3 render two views of one `/nlp/firs/{id}/entities` response, so
 * they share a single request. The shared `activeEntityIndex` is what makes the
 * extraction legible: clicking a highlight in the text selects its table row, and
 * clicking a row lights the span it came from. Indices are positions in the same
 * array — the flattened `EntityOut[]` given to NarrativeViewer is
 * `entities.map(e => e.entity)`, so position i means the same entity in both.
 */
function ExtractionSections({ firId }: { firId: number }): ReactElement {
  const entities = useAsync(
    (signal) => api.getFirEntities(firId, { signal }),
    [firId],
  );

  const [activeEntityIndex, setActiveEntityIndex] = useState<number | null>(null);

  // A different FIR is a different entity list; a stale index would highlight an
  // unrelated row.
  useEffect(() => {
    setActiveEntityIndex(null);
  }, [firId]);

  const data = entities.data;
  const flattened: EntityOut[] = useMemo(
    () => (data?.entities ?? []).map((item) => item.entity),
    [data],
  );

  const typeCounts = sortedCounts(data?.counts_by_type);
  const resolutionCounts = sortedCounts(data?.resolution_counts);
  const absentTypes = data?.absent_entity_types ?? [];

  return (
    <>
      <Panel>
        <PanelHeader
          title={<SectionTitle ordinal="02">Original narrative</SectionTitle>}
          subtitle="Verbatim text. Every highlight is an extraction claim."
          actions={<ProvenanceTag provenance="narrative" short />}
        />
        <PanelBody>
          {entities.error ? (
            <ErrorState
              error={entities.error}
              onRetry={entities.retry}
              compact
              title="Narrative extraction unavailable"
            />
          ) : entities.isLoading && !data ? (
            <SkeletonText lines={4} />
          ) : !data ? (
            <EmptyState title="No extraction response for this FIR" />
          ) : (
            <ExpandableNarrative>
              <NarrativeViewer
                narrative={data.narrative}
                entities={flattened}
                activeEntityIndex={activeEntityIndex}
                onActiveEntityChange={setActiveEntityIndex}
              />
            </ExpandableNarrative>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title={<SectionTitle ordinal="03">Extracted entities</SectionTitle>}
          subtitle="Every claimed mention, and how it resolved."
          actions={<ProvenanceTag provenance="narrative" short />}
        />
        <PanelBody className="space-y-3.5">
          {entities.error ? (
            <ErrorState
              error={entities.error}
              onRetry={entities.retry}
              compact
              title="Entity extraction unavailable"
            />
          ) : entities.isLoading && !data ? (
            <SkeletonRows rows={5} />
          ) : !data ? (
            <EmptyState title="No extraction response for this FIR" />
          ) : (
            <>
              <div className="inset flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
                <StatInline label="Entities" value={formatCount(data.entity_count)} />
                {resolutionCounts.map(([status, count]) => (
                  <StatInline
                    key={status}
                    label={humanizeToken(status)}
                    value={formatCount(count)}
                    hint={
                      status === 'not_applicable'
                        ? 'The mention has no node type in the graph that could hold it — a date, for example. The resolver says so rather than forcing a match.'
                        : undefined
                    }
                  />
                ))}
                <StatInline
                  label="Source record"
                  value={<span className="font-mono">{data.source_record_id}</span>}
                  hint="The dataset citation the extraction was run over: table name and primary key."
                />
              </div>

              {typeCounts.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="field-label">Extracted by type</p>
                  <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {typeCounts.map(([type, count]) => (
                      <li key={type} className="flex items-center gap-1.5">
                        <EntityBadge entityType={type} />
                        <span className="text-ink-2 font-mono text-2xs tabular-nums">{count}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {absentTypes.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="field-label flex items-center gap-1.5">
                    <span>Declared but not present in this corpus</span>
                    <InfoHint content="Entity types the extractor is built to recognise and did not find here — the backend reports them explicitly rather than letting their absence look like an oversight. This is an honest zero, not a gap in the UI." />
                  </p>
                  <ul className="flex flex-wrap items-center gap-1.5">
                    {absentTypes.map((type) => (
                      <li key={type}>
                        <Badge tone="muted" title="Zero occurrences extracted from this narrative">
                          {type} · 0
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <Divider label="Entity table" />

              <EntityTable
                entities={data.entities}
                activeEntityIndex={activeEntityIndex}
                onActiveEntityChange={setActiveEntityIndex}
              />

            </>
          )}
        </PanelBody>
      </Panel>
    </>
  );
}

/* ============================================== 4. extracted relationships */

function RelationshipsSection({ firId }: { firId: number }): ReactElement {
  const relationships = useAsync(
    (signal) => api.getFirRelationships(firId, { signal }),
    [firId],
  );

  const data = relationships.data;
  const typeCounts = sortedCounts(data?.counts_by_type);

  return (
    <Panel>
      <PanelHeader
        title={<SectionTitle ordinal="04">Extracted relationships</SectionTitle>}
        subtitle="Admitted only when a named rule fired."
        actions={<ProvenanceTag provenance="narrative" short />}
      />
      <PanelBody className="space-y-3.5">
        {relationships.error ? (
          <ErrorState
            error={relationships.error}
            onRetry={relationships.retry}
            compact
            title="Relationship extraction unavailable"
          />
        ) : relationships.isLoading && !data ? (
          <SkeletonRows rows={3} />
        ) : !data ? (
          <EmptyState title="No relationship response for this FIR" />
        ) : (
          <>
            <div className="inset flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5">
              <StatInline
                label="Relationships"
                value={formatCount(data.relationship_count)}
                hint="Relationships asserted by this narrative alone. A count of zero means no trigger phrase fired — co-occurrence in the same FIR is deliberately not treated as a relationship."
              />
              <StatInline
                label="Source record"
                value={<span className="font-mono">{data.source_record_id}</span>}
              />
            </div>

            {typeCounts.length > 0 ? (
              <div className="space-y-1.5">
                <p className="field-label">Asserted by type</p>
                <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {typeCounts.map(([type, count]) => (
                    <li key={type} className="flex items-center gap-1.5">
                      <RelationshipBadge relationshipType={type} />
                      <span className="text-ink-2 font-mono text-2xs tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* The backend's own caveat, quoted rather than paraphrased. */}
            {data.note ? (
              <p className="border-l-narrative/60 bg-inset text-ink-3 border-l-2 px-3 py-2 text-2xs leading-relaxed">
                <span className="field-label mr-1.5">Backend note</span>
                {data.note}
              </p>
            ) : null}

            <RelationshipList relationships={data.relationships} />
          </>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ========================================================= 5. graph impact */

/**
 * Section 5 wraps `GraphImpactPanel`, which brings its own Panel chrome and its
 * own honest statements about duplicates and non-mutation. Only the loading and
 * error states need a surface here.
 *
 * Graph impact on this backend is PER-FIR: it describes what this one narrative
 * proposed and what the validator did with it. It is not a corpus-wide figure.
 */
function GraphImpactSection({ firId }: { firId: number }): ReactElement {
  const impact = useAsync((signal) => api.getFirGraphImpact(firId, { signal }), [firId]);

  if (impact.error) {
    return (
      <Panel>
        <PanelHeader
          title={<SectionTitle ordinal="05">Graph impact</SectionTitle>}
          actions={<ProvenanceTag provenance="narrative" short />}
        />
        <PanelBody>
          <ErrorState
            error={impact.error}
            onRetry={impact.retry}
            compact
            title="Graph impact unavailable"
          />
        </PanelBody>
      </Panel>
    );
  }

  if (!impact.data) {
    return (
      <Panel>
        <PanelHeader
          title={<SectionTitle ordinal="05">Graph impact</SectionTitle>}
          subtitle="Proposed, then admitted or refused."
          actions={<ProvenanceTag provenance="narrative" short />}
        />
        <PanelBody className="space-y-3">
          <SkeletonText lines={2} />
          <SkeletonRows rows={3} />
        </PanelBody>
      </Panel>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 className="text-ink flex items-center gap-2 text-sm font-semibold tracking-tight">
          <span className="text-ink-4 font-mono text-2xs tabular-nums">05</span>
          <span>Graph impact</span>
        </h2>
        <span className="text-ink-4 text-2xs">
          Per-FIR: this narrative only, not a corpus-wide total.
        </span>
      </div>
      <GraphImpactPanel impact={impact.data} />
    </div>
  );
}

/* =================================================================== shared */

/**
 * A collapsed reading box. Long narrative text is clamped so the sections under
 * it stay reachable, and the toggle appears only when there is more text than the
 * box already shows — measured, not guessed from a character count.
 */
function ExpandableNarrative({ children }: { children: ReactNode }): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    setOverflows(element.scrollHeight > element.clientHeight + 4);
  }, []);

  return (
    <div>
      <div
        ref={box}
        className={cn('relative', !expanded && 'max-h-72 overflow-hidden')}
        data-testid="fir-narrative-box"
      >
        {children}
        {!expanded && overflows ? (
          <div
            aria-hidden
            className="from-panel absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent"
          />
        ) : null}
      </div>
      {overflows ? (
        <Button size="sm" className="mt-2" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </div>
  );
}

/** Numbered section label, so a spoken walkthrough can point at a section. */
function SectionTitle({
  ordinal,
  children,
}: {
  ordinal: string;
  children: ReactNode;
}): ReactElement {
  return (
    <span className="flex items-center gap-2">
      <span className="text-ink-4 font-mono text-2xs tabular-nums">{ordinal}</span>
      <span>{children}</span>
    </span>
  );
}

/**
 * The not-found surface, used for both a malformed `:firId` and a genuine 404.
 * `ErrorState` owns the failure message; the return-to-list action sits beneath
 * it because that is the only useful next step.
 */
function NotFoundPanel({
  heading,
  message,
  onBack,
  onRetry,
}: {
  heading: string;
  message: string;
  onBack: () => void;
  onRetry?: () => void;
}): ReactElement {
  return (
    <Panel>
      <PanelHeader title="FIR unavailable" />
      <PanelBody className="space-y-3">
        <ErrorState title={heading} error={new Error(message)} onRetry={onRetry} />
        <Button variant="primary" onClick={onBack}>
          Back to the FIR list
        </Button>
      </PanelBody>
    </Panel>
  );
}
