/**
 * Evidence & Provenance — where any entity in the graph can be traced back to
 * the dataset row it was read from.
 *
 * Three decisions worth stating, because they are the difference between a
 * provenance view and a plausible-looking one:
 *
 *  1. The route takes a PREFIXED entity id as a query parameter
 *     (`/evidence?entity=phone%3A%2B91-7804841598`). Person-rooted views use the
 *     numeric row id; this page is the only one that has to address a phone, an
 *     Aadhaar or a cell tower, none of which have a numeric route of their own.
 *
 *  2. Resolution is a single `GET /graph/search?q=<full entity id>`. That was
 *     verified against the live backend for all six materialised node types —
 *     the exact id resolves to exactly one node, and a nonexistent id returns
 *     `count: 0`. There is no `/graph/entities/{id}` endpoint to call instead,
 *     and nothing here is substituted when the lookup comes back empty.
 *
 *  3. `source_record_id` is a NODE field, and it does not always point at a
 *     fetchable row. A cell tower's provenance reads `calls.cell_tower_id:2404`
 *     — a column in the calls table, not a record with an endpoint. The row link
 *     below is therefore offered only for `persons:`, `locations:` and `firs:`,
 *     and it is labelled as the row the entity was read from rather than as an
 *     owner, because a phone number appearing on a person's row is not a claim
 *     of exclusive possession.
 *
 * Relationship-level evidence lives in Network Investigation, where clicking an
 * edge opens the full provenance of that link. This page deliberately does not
 * duplicate it.
 */
import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { NodeDetailsPanel } from '@/components/graph';
import { SearchResultList } from '@/components/search/SearchResultList';
import {
  Badge,
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
  SectionHeading,
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { NodeOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { splitEntityId } from '@/utils/entity';
import { flattenScalars } from '@/utils/records';

const SEARCH_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;
const PAGE_LISTBOX_ID = 'cna-page-search-listbox';

/** The generator's answer key. Shown, but never mixed into the record. */
const OVERLAY_KEYS = new Set(['ring_id', 'ground_truth_ring_id']);

/** Datasets whose `source_record_id` names a row this backend can actually serve. */
const FETCHABLE_ROW_DATASETS = new Set(['persons', 'locations', 'firs']);

const PAGE_SUBTITLE =
  'Resolve any entity the graph materialises — person, phone, Aadhaar, location, FIR or cell tower — and read the dataset row it came from. Nothing on this page is inferred: every field below is returned by the backend for the id in the URL.';

const optionDomId = (entityId: string) =>
  `cna-page-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;

const LINK_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-sm border border-line-strong bg-panel-2 px-2.5 text-xs font-semibold whitespace-nowrap text-ink-2 transition-colors hover:border-line-accent hover:bg-panel-3 hover:text-ink';

/** `persons:445` -> `{ dataset: 'persons', rowId: 445 }`; null when not a row. */
function parseSourceRecord(
  sourceRecordId: string | null | undefined,
): { dataset: string; rowId: number } | null {
  if (!sourceRecordId) return null;
  const idx = sourceRecordId.lastIndexOf(':');
  if (idx <= 0) return null;
  const dataset = sourceRecordId.slice(0, idx);
  const key = sourceRecordId.slice(idx + 1);
  if (!/^\d+$/.test(key)) return null;
  if (!FETCHABLE_ROW_DATASETS.has(dataset)) return null;
  return { dataset, rowId: Number(key) };
}

/** The numeric key of a prefixed id, when the prefix matches and the key is a row. */
function numericKey(entityId: string, prefix: string): number | null {
  const parts = splitEntityId(entityId);
  if (parts.prefix !== prefix) return null;
  if (!/^\d+$/.test(parts.key)) return null;
  return Number(parts.key);
}

export function EvidencePage(): ReactElement {
  const [params] = useSearchParams();
  const entityId = (params.get('entity') ?? '').trim();

  return (
    <div className="space-y-4 pb-10" data-testid="evidence-page">
      <SectionHeading title="Evidence & Provenance" subtitle={PAGE_SUBTITLE} />
      <EntityPicker currentEntityId={entityId} />
      {entityId ? (
        <EntityEvidence key={entityId} entityId={entityId} />
      ) : (
        <EmptyState
          icon="search"
          title="No entity selected"
          description="Search above for a person, phone, Aadhaar, location, FIR or cell tower. You can also arrive here by clicking a non-person node in Network Investigation."
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ picker -- */

/**
 * The entity picker. Always mounted, so the page is usable without first
 * navigating from somewhere else — and so a failed resolution below is still
 * recoverable without editing the URL.
 */
function EntityPicker({ currentEntityId }: { currentEntityId: string }): ReactElement {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const debounced = useDebouncedValue(query.trim(), 250);
  const isSearchable = debounced.length >= MIN_QUERY_LENGTH;

  const search = useAsync(
    (signal) => api.searchGraph(debounced, SEARCH_LIMIT, { signal }),
    [debounced],
    { enabled: isSearchable },
  );

  const results = useMemo<NodeOut[]>(
    () => (isSearchable ? (search.data?.results ?? []) : []),
    [isSearchable, search.data],
  );

  useEffect(() => {
    setActiveIndex(-1);
  }, [debounced]);

  const select = useCallback(
    (node: NodeOut) => {
      setQuery('');
      setActiveIndex(-1);
      navigate(`/evidence?entity=${encodeURIComponent(node.entity_id)}`);
    },
    [navigate],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) {
      if (event.key === 'Escape') setQuery('');
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % results.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
        break;
      case 'Home':
        event.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        event.preventDefault();
        setActiveIndex(results.length - 1);
        break;
      case 'Enter': {
        const node = results[activeIndex >= 0 ? activeIndex : 0];
        if (node) {
          event.preventDefault();
          select(node);
        }
        break;
      }
      case 'Escape':
        setQuery('');
        setActiveIndex(-1);
        break;
      default:
        break;
    }
  };

  const active = activeIndex >= 0 ? results[activeIndex] : undefined;

  return (
    <Panel>
      <PanelHeader
        title="Resolve an entity"
        subtitle="GET /graph/search — the same index Network Investigation searches."
      />
      <PanelBody className="space-y-3 px-4 py-3">
        <label className="block">
          <span className="text-ink-3 text-2xs font-semibold tracking-wide uppercase">
            Name, phone, Aadhaar, place or entity id
          </span>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls={PAGE_LISTBOX_ID}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionDomId(active.entity_id) : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. Ojas, +91-7804841598, location:178"
            className="border-line-strong bg-inset text-ink placeholder:text-ink-4 focus:border-line-accent mt-1.5 h-9 w-full rounded-sm border px-2.5 text-sm outline-none focus:ring-1 focus:ring-cyan-500/40"
          />
        </label>

        {isSearchable && search.error ? (
          <ErrorState compact error={search.error} onRetry={search.retry} />
        ) : null}

        {isSearchable && search.isInitialLoading ? <SkeletonRows rows={3} /> : null}

        {isSearchable && !search.isLoading && !search.error && results.length === 0 ? (
          <p className="text-ink-4 text-xs">
            No entity in the graph matches <Mono>{debounced}</Mono>.
          </p>
        ) : null}

        {results.length > 0 ? (
          <SearchResultList
            results={results}
            activeIndex={activeIndex}
            onSelect={select}
            onHoverIndex={setActiveIndex}
            variant="page"
          />
        ) : null}

        {!isSearchable && currentEntityId ? (
          <p className="text-ink-4 text-xs">
            Showing <Mono>{currentEntityId}</Mono>. Type at least {MIN_QUERY_LENGTH} characters to
            resolve a different entity.
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

/* ---------------------------------------------------------------- evidence -- */

/**
 * Everything known about one entity id. Mounted with `key={entityId}` by the
 * page so that every hook below stays unconditional across a change of subject.
 */
function EntityEvidence({ entityId }: { entityId: string }): ReactElement {
  const navigate = useNavigate();

  const resolution = useAsync(
    (signal) => api.searchGraph(entityId, 5, { signal }),
    [entityId],
  );

  const node = useMemo<NodeOut | null>(() => {
    const hits = resolution.data?.results ?? [];
    return hits.find((hit) => hit.entity_id === entityId) ?? null;
  }, [resolution.data, entityId]);

  // Where the row lookup comes from: the resolved node's own `source_record_id`,
  // not the id form in the URL. A phone's provenance reads `persons:445`, so the
  // row to show is that person's — asking for `/persons/+91-…` would be nonsense.
  // A tower's reads `calls.cell_tower_id:2404`, which parses to null and issues
  // no request at all.
  const record = useMemo(() => parseSourceRecord(node?.source_record_id), [node]);
  const personRowId = record?.dataset === 'persons' ? record.rowId : null;
  const locationRowId = record?.dataset === 'locations' ? record.rowId : null;
  const firRowId = record?.dataset === 'firs' ? record.rowId : null;

  // Route targets, by contrast, do depend on the id in the URL: only a person
  // can root a network view, and only a FIR has a narrative page.
  const personId = numericKey(entityId, 'person');
  const firId = numericKey(entityId, 'fir');

  const personRecord = useAsync(
    (signal) => api.getPersonRecord(personRowId as number, { signal }),
    [personRowId],
    { enabled: personRowId !== null },
  );
  const locationRecord = useAsync(
    (signal) => api.getLocationRecord(locationRowId as number, { signal }),
    [locationRowId],
    { enabled: locationRowId !== null },
  );
  const firRecord = useAsync(
    (signal) => api.getFir(firRowId as number, { signal }),
    [firRowId],
    { enabled: firRowId !== null },
  );

  if (resolution.isInitialLoading) {
    return (
      <Panel>
        <PanelBody>
          <SkeletonRows rows={6} />
        </PanelBody>
      </Panel>
    );
  }

  if (resolution.error) {
    return (
      <ErrorState
        title="Could not resolve this entity"
        error={resolution.error}
        onRetry={resolution.retry}
      />
    );
  }

  if (!node) {
    return (
      <EmptyState
        icon="search"
        title="The graph does not contain this entity"
        description={
          <>
            <Mono>{entityId}</Mono> resolved to no node. The request succeeded — this is an answer,
            not a failure. Either the id is not in the current dataset, or it is a type the Phase 2
            graph does not materialise.
          </>
        }
      />
    );
  }

  const raw =
    (personRecord.data as unknown as Record<string, unknown> | null) ??
    (locationRecord.data as unknown as Record<string, unknown> | null) ??
    (firRecord.data as unknown as Record<string, unknown> | null);
  const rawState =
    personRowId !== null ? personRecord : locationRowId !== null ? locationRecord : firRecord;
  const rawScalars = raw ? flattenScalars(raw).filter(([key]) => !OVERLAY_KEYS.has(key)) : [];
  const rawOverlay = raw ? flattenScalars(raw).filter(([key]) => OVERLAY_KEYS.has(key)) : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title="Provenance chain"
            subtitle="Which dataset this entity was read from, and which row."
            actions={<ProvenanceTag provenance="structured" short />}
          />
          <PanelBody>
            <KeyValueList>
              <KeyValueRow label="Entity id" value={<Mono>{node.entity_id}</Mono>} />
              <KeyValueRow
                label="Entity type"
                value={<EntityBadge entityType={node.entity_type} />}
              />
              <KeyValueRow label="Display value" value={node.label} />
              <KeyValueRow
                label="Source dataset"
                value={<Mono>{node.source_dataset ?? '—'}</Mono>}
                hint="The synthetic table this entity was materialised from. The dataset files themselves are read-only and unmodified."
              />
              <KeyValueRow
                label="Source record"
                value={<Mono>{node.source_record_id ?? '—'}</Mono>}
                hint="dataset:row_id. For a cell tower this names a column of the calls table rather than a record with its own endpoint, so no row link is offered."
              />
            </KeyValueList>

            {record ? (
              <p className="text-ink-3 mt-3 text-xs leading-relaxed">
                The row this entity was read from is <Mono>{node.source_record_id}</Mono>. It is
                shown below — appearing on a row is not a claim of ownership or possession.
              </p>
            ) : (
              <p className="text-ink-4 mt-3 text-xs leading-relaxed">
                This entity&rsquo;s provenance does not name a fetchable row, so there is no record
                to display. That is a property of how the graph is built, not a missing lookup.
              </p>
            )}
          </PanelBody>
        </Panel>

        {record ? (
          <Panel>
            <PanelHeader
              title={`Structured record · ${record.dataset}:${record.rowId}`}
              subtitle="Verbatim fields of the backing dataset row."
              actions={<ProvenanceTag provenance="structured" short />}
            />
            <PanelBody>
              {rawState.isInitialLoading ? (
                <SkeletonRows rows={5} />
              ) : rawState.error ? (
                <ErrorState compact error={rawState.error} onRetry={rawState.retry} />
              ) : rawScalars.length === 0 ? (
                <p className="text-ink-4 text-xs">The record returned no scalar fields.</p>
              ) : (
                <KeyValueList dense>
                  {rawScalars.map(([key, value]) => (
                    <KeyValueRow key={key} label={key} value={value} mono wrap />
                  ))}
                </KeyValueList>
              )}

              {rawOverlay.length > 0 ? (
                <div
                  className="border-overlay/35 bg-overlay/10 mt-3 rounded-md border border-dashed px-3 py-2.5"
                  data-testid="overlay-block"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-ink-2 text-xs font-semibold">
                      Data-generator label &mdash; not evidence
                    </p>
                    <ProvenanceTag provenance="overlay" short />
                  </div>
                  <KeyValueList dense className="mt-2">
                    {rawOverlay.map(([key, value]) => (
                      <KeyValueRow key={key} label={key} value={value} mono tone="muted" />
                    ))}
                  </KeyValueList>
                  <p className="text-ink-4 mt-2 text-xs leading-relaxed">
                    This field is the synthetic generator&rsquo;s own ground-truth grouping. It is
                    displayed for transparency and is never used to rank, colour, cluster or filter
                    anything in this system.
                  </p>
                </div>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}

        <Panel>
          <PanelHeader title="Where to go next" />
          <PanelBody className="space-y-3 px-4 py-3">
            <p className="text-ink-3 text-xs leading-relaxed">
              Relationship-level evidence — the type of a link, its weight, and the{' '}
              <Mono>dataset:record_id</Mono> citations behind it — is shown in Network Investigation:
              click any edge on the canvas to open its provenance. This page resolves entities only.
            </p>
            <div className="flex flex-wrap gap-2">
              {personId !== null ? (
                <Link className={LINK_CLASS} to={`/network/${personId}`}>
                  Open network
                </Link>
              ) : null}
              {firId !== null ? (
                <Link className={LINK_CLASS} to={`/fir/${firId}`}>
                  Open FIR narrative
                </Link>
              ) : null}
              <Link className={LINK_CLASS} to="/network">
                Network Investigation
              </Link>
            </div>
            {personId === null && firId === null ? (
              <p className="text-ink-4 text-xs leading-relaxed">
                The network endpoint is person-rooted (<Mono>/graph/persons/{'{id}'}/network</Mono>),
                so a {node.entity_type.replace(/_/g, ' ').toLowerCase()} cannot be a network root on
                this backend. Reach it through a person it appears with.
              </p>
            ) : null}
          </PanelBody>
        </Panel>
      </div>

      <div className="space-y-4">
        <NodeDetailsPanel
          node={node}
          onClose={() => navigate('/evidence')}
          onInvestigate={(personEntityId) => {
            const id = numericKey(personEntityId, 'person');
            if (id !== null) navigate(`/network/${id}`);
          }}
          onOpenFir={(id) => navigate(`/fir/${id}`)}
        />
        <Panel>
          <PanelBody className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-3 text-2xs font-semibold tracking-wide uppercase">
                Resolution
              </span>
              <Badge tone="muted" title="Number of nodes the exact-id lookup returned.">
                {resolution.data?.count ?? 0} HIT{(resolution.data?.count ?? 0) === 1 ? '' : 'S'}
              </Badge>
            </div>
            <p className={cn('text-ink-4 mt-2 text-xs leading-relaxed')}>
              Resolved by an exact-id lookup against <Mono>GET /graph/search</Mono>. There is no
              entity-by-id endpoint on this backend
              <InfoHint content="Verified against the live backend: querying the full prefixed entity id returns exactly one node for each materialised type, and count: 0 for an id the dataset does not contain." />
            </p>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
