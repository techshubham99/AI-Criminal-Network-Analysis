/**
 * FirIntelligence — one FIR, read twice.
 *
 * The page exists to answer a single question honestly: what does the FIR *record*
 * say, and what does a deterministic reader claim the FIR *narrative* says? Those
 * are two different kinds of fact and the layout never lets them blur:
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
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '@/api';
import type { ApiError } from '@/api';
import { EntityTable } from '@/components/nlp/EntityTable';
import { GraphImpactPanel } from '@/components/nlp/GraphImpactPanel';
import { NarrativeViewer } from '@/components/nlp/NarrativeViewer';
import { RelationshipList } from '@/components/nlp/RelationshipList';
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
  SectionHeading,
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
import type { EntityOut, FIR, NlpSearchResponse, PageMeta, SearchHitOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount, formatDateTime, humanizeToken, sortedCounts, truncate } from '@/utils/format';

/** Rail page sizes. Kept small so the rail never out-scrolls the main column. */
const RECORDS_PAGE_SIZE = 10;
const SEARCH_PAGE_SIZE = 10;
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

  return (
    <div className="space-y-4">
      <SectionHeading
        title="FIR Intelligence"
        subtitle="Reports as filed, beside what deterministic narrative extraction reads out of them."
        actions={
          firId !== null ? (
            <Badge tone="cyan" title="The FIR currently open">
              FIR {firId}
            </Badge>
          ) : null
        }
      />

      <ProvenanceLegend />

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[21rem_minmax(0,1fr)]">
        <FirSelectorRail selectedFirId={firId} />

        <div className="min-w-0 space-y-4">
          {!hasParam ? (
            <Panel>
              <PanelBody>
                <EmptyState
                  title="No FIR selected"
                  description="Pick an FIR from the list on the left, or search the narrative text for a name, phone, Aadhaar or place. The selected FIR opens at its own address — /fir/79 — so it can be linked to directly in a briefing."
                  icon="empty"
                />
              </PanelBody>
            </Panel>
          ) : !isNumericParam || firId === null ? (
            <NotFoundPanel
              heading="Invalid FIR reference"
              message={`"${rawFirId}" is not an FIR id. This route takes the numeric row id, for example /fir/79 — the prefixed form "fir:79" belongs in query parameters and relationship ids, never in a path.`}
              onBack={() => navigate('/fir')}
            />
          ) : recordNotFound ? (
            <NotFoundPanel
              heading={`FIR ${firId} was not found`}
              message={
                record.error?.message ??
                'The backend has no FIR record with that id. It reported 404 rather than an empty record, which means the id does not exist in this dataset.'
              }
              onBack={() => navigate('/fir')}
              onRetry={record.retry}
            />
          ) : (
            <>
              <FirRecordPanel
                record={record.data}
                isLoading={record.isLoading}
                error={record.error}
                onRetry={record.retry}
              />
              <ExtractionSections firId={firId} />
              <RelationshipsSection firId={firId} />
              <GraphImpactSection firId={firId} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ==================================================================== legend */

/**
 * The page's contract with the viewer, stated before any data is shown. Both
 * ProvenanceTag variants appear here so the tags that follow are already known
 * by the time they are used as shorthand in a panel header.
 */
function ProvenanceLegend(): ReactElement {
  return (
    <Panel>
      <PanelBody className="grid grid-cols-1 gap-x-6 gap-y-3 px-4 py-3 lg:grid-cols-2">
        <div className="flex gap-3">
          <ProvenanceTag provenance="structured" />
          <p className="text-ink-3 min-w-0 flex-1 text-xs leading-relaxed">
            <strong className="text-ink-2 font-semibold">Section 1 only.</strong> The columns of the
            FIR row itself — id, date, complainant, accused and location. Recorded dataset values,
            read straight out of the record with no inference.
          </p>
        </div>
        <div className="flex gap-3">
          <ProvenanceTag provenance="narrative" />
          <p className="text-ink-3 min-w-0 flex-1 text-xs leading-relaxed">
            <strong className="text-ink-2 font-semibold">Sections 2–5.</strong> Everything the NLP
            layer takes out of the narrative's free text, by regex and named rules with quoted
            trigger phrases. It is held in a{' '}
            <strong className="text-ink-2 font-semibold">separate narrative graph</strong> and is
            never merged into the observed graph, so no section below can change what the structured
            evidence says.
          </p>
        </div>
      </PanelBody>
    </Panel>
  );
}

/* ================================================================ left rail */

type RailMode = 'records' | 'narrative';

const RAIL_MODES = [
  { value: 'records' as RailMode, label: 'FIR records', title: 'Browse the structured FIR table' },
  {
    value: 'narrative' as RailMode,
    label: 'Narrative search',
    title: 'Search entities extracted from FIR narrative text',
  },
];

/**
 * FirSelectorRail — two ways to reach an FIR, kept visibly distinct because they
 * are not the same query. "FIR records" pages the structured `firs` table.
 * "Narrative search" searches the *extracted entities* over narrative text, so
 * its hits are narrative-derived and tagged as such.
 */
function FirSelectorRail({ selectedFirId }: { selectedFirId: number | null }): ReactElement {
  const [mode, setMode] = useState<RailMode>('records');
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

  return (
    <Panel as="aside" className="xl:sticky xl:top-1">
      <PanelHeader
        title="FIR selector"
        subtitle={
          mode === 'records'
            ? 'The structured FIR table, paged as the backend returns it.'
            : 'Entities the extractor found in FIR narrative text.'
        }
        actions={<ProvenanceTag provenance={mode === 'records' ? 'structured' : 'narrative'} short />}
      />

      <div className="border-line border-b px-3 py-2.5">
        <SegmentedControl
          options={RAIL_MODES}
          value={mode}
          onChange={setMode}
          label="FIR selector mode"
        />
      </div>

      {mode === 'records' ? (
        <RecordsList
          selectedFirId={selectedFirId}
          items={firs.data?.items ?? null}
          meta={firs.data?.meta ?? null}
          isInitialLoading={firs.isInitialLoading}
          isLoading={firs.isLoading}
          error={firs.error}
          onRetry={firs.retry}
          onPage={setRecordsPage}
        />
      ) : (
        <NarrativeSearchList
          selectedFirId={selectedFirId}
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

function RecordsList({
  selectedFirId,
  items,
  meta,
  isInitialLoading,
  isLoading,
  error,
  onRetry,
  onPage,
}: {
  selectedFirId: number | null;
  items: FIR[] | null;
  meta: PageMeta | null;
  isInitialLoading: boolean;
  isLoading: boolean;
  error: ApiError | null;
  onRetry: () => void;
  onPage: (page: number) => void;
}): ReactElement {
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
        <EmptyState
          title="This page of the FIR table is empty"
          description="The request succeeded and returned no rows. Step back a page, or check the dataset's FIR count on the command centre."
        />
      </PanelBody>
    );
  }

  return (
    <>
      {/* `isLoading` after the first load dims the stale page instead of
          collapsing the rail to a skeleton — the operator keeps their place.
          The list scrolls inside a bounded box so the pager below it stays
          reachable on a 1280×800 projector. */}
      <ul
        className={cn(
          'divide-line/70 max-h-[24rem] divide-y overflow-y-auto transition-opacity',
          isLoading && 'opacity-55',
        )}
      >
        {items.map((fir) => (
          <li key={fir.fir_id}>
            <FirRow fir={fir} selected={fir.fir_id === selectedFirId} />
          </li>
        ))}
      </ul>
      <Pager meta={meta} onPage={onPage} isLoading={isLoading} unit="FIRs" />
    </>
  );
}

/** One row of the structured FIR table: id, date, and the narrative's opening. */
function FirRow({ fir, selected }: { fir: FIR; selected: boolean }): ReactElement {
  return (
    <Link
      to={`/fir/${fir.fir_id}`}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group block border-l-2 px-3 py-2.5 transition-colors',
        selected
          ? 'border-l-cyan-500 bg-panel-3'
          : 'hover:bg-panel-2 focus-visible:bg-panel-2 border-l-transparent',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'font-mono text-xs font-semibold',
            selected ? 'text-cyan-200' : 'text-ink group-hover:text-cyan-200',
          )}
        >
          FIR {fir.fir_id}
        </span>
        <span className="text-ink-4 shrink-0 font-mono text-2xs">{formatDateTime(fir.date)}</span>
      </div>
      <p className="text-ink-3 mt-1 text-2xs leading-snug">{truncate(fir.narrative ?? '', 96)}</p>
    </Link>
  );
}

function NarrativeSearchList({
  selectedFirId,
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
  selectedFirId: number | null;
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
          <InfoHint content="Searches the entities the extractor pulled out of every FIR narrative — names, phone numbers, Aadhaar numbers, dates and places — not the raw sentence text. A hit means the extractor claimed that mention in that FIR." />
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
          <EmptyState
            icon="search"
            title={`Type at least ${MIN_QUERY_LENGTH} characters`}
            description="The backend rejects an empty narrative query with HTTP 422 rather than returning the whole corpus, so this box waits for input before it asks."
          />
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
            description="Zero hits is an answer: the extractor claimed no mention matching this text in any FIR narrative. It does not mean the string is absent from the raw sentences — only that no entity was extracted from it."
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
            {response.searched_fields && response.searched_fields.length > 0 ? (
              <p className="text-ink-4 text-2xs leading-snug">
                Fields searched:{' '}
                <span className="font-mono">{response.searched_fields.join(', ')}</span>
              </p>
            ) : null}
          </div>

          <ul
            className={cn(
              'divide-line/70 max-h-[20rem] divide-y overflow-y-auto transition-opacity',
              isLoading && 'opacity-55',
            )}
          >
            {response.items.map((hit, index) => (
              <li key={`${hit.fir_id}-${hit.entity.character_start}-${hit.entity.character_end}-${index}`}>
                <SearchHitRow hit={hit} selected={hit.fir_id === selectedFirId} />
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
function SearchHitRow({ hit, selected }: { hit: SearchHitOut; selected: boolean }): ReactElement {
  const { entity, resolution } = hit;
  return (
    <Link
      to={`/fir/${hit.fir_id}`}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'group block border-l-2 px-3 py-2.5 transition-colors',
        selected
          ? 'border-l-cyan-500 bg-panel-3'
          : 'hover:bg-panel-2 focus-visible:bg-panel-2 border-l-transparent',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'font-mono text-xs font-semibold',
            selected ? 'text-cyan-200' : 'text-ink group-hover:text-cyan-200',
          )}
        >
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

/** Previous/Next driven strictly by the backend's own `has_prev` / `has_next`. */
function Pager({
  meta,
  onPage,
  isLoading,
  unit,
}: {
  meta: PageMeta | null;
  onPage: (page: number) => void;
  isLoading: boolean;
  unit: string;
}): ReactElement | null {
  if (!meta) return null;
  return (
    <div className="border-line flex items-center justify-between gap-2 border-t px-3 py-2">
      <Button
        size="sm"
        onClick={() => onPage(Math.max(1, meta.page - 1))}
        disabled={!meta.has_prev || isLoading}
        aria-label="Previous page"
      >
        Prev
      </Button>
      <span className="text-ink-4 text-center font-mono text-2xs tabular-nums">
        {meta.page} / {meta.total_pages} · {formatCount(meta.total)} {unit}
      </span>
      <Button
        size="sm"
        onClick={() => onPage(meta.page + 1)}
        disabled={!meta.has_next || isLoading}
        aria-label="Next page"
      >
        Next
      </Button>
    </div>
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
        subtitle="The columns of this row as filed. Recorded values — not extracted, not inferred."
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

            <p className="text-ink-4 text-2xs leading-relaxed">
              The id columns hold plain integers — the bold values above — and this backend's paths
              take that form, which is why the accused link points at{' '}
              <span className="font-mono">/network/{record.accused_id}</span>. The grey{' '}
              <span className="font-mono">person:{record.accused_id}</span> beside it is the same row
              under the name the graph uses in its own responses; that prefixed form belongs in a
              query parameter, never in a path. Opening a person shows their observed network, where
              centrality and connection counts are structural measures over synthetic data — not
              measures of guilt.
            </p>
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
          subtitle="The narrative column reproduced verbatim. The text is part of the record; every highlight over it is an extraction claim about that text."
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
            <NarrativeViewer
              narrative={data.narrative}
              entities={flattened}
              activeEntityIndex={activeEntityIndex}
              onActiveEntityChange={setActiveEntityIndex}
            />
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title={<SectionTitle ordinal="03">Extracted entities</SectionTitle>}
          subtitle="Every mention the extractor claimed, and what happened when it tried to tie that mention to a node in the structured graph."
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
                  <p className="text-ink-4 text-2xs leading-relaxed">
                    The backend lists these itself rather than omitting them, so an absence stays
                    visible as an absence. Where such a type has no node in the Phase 2 graph at all,
                    nothing on this page renders it as present.
                  </p>
                </div>
              ) : null}

              <Divider label="Entity table" />

              <EntityTable
                entities={data.entities}
                activeEntityIndex={activeEntityIndex}
                onActiveEntityChange={setActiveEntityIndex}
              />

              <p className="text-ink-4 text-2xs leading-relaxed">
                Selecting a row highlights the exact characters it came from in section 2, and
                selecting a highlight selects its row. Confidence values are fixed tiers set by the
                rule that fired — not a trained model's probability.
              </p>
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
        subtitle="Claims the narrative makes, admitted only when an explicit trigger phrase fired a named rule with role-bound endpoints."
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
          subtitle="What this narrative proposed to the graph, and what the validator admitted or refused."
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
