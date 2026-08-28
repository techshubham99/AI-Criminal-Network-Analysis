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
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api } from '@/api';
import { LedgerIntegrity } from '@/components/audit';
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
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { NodeOut } from '@/types/api';
import { splitEntityId } from '@/utils/entity';
import { flattenScalars } from '@/utils/records';

const SEARCH_LIMIT = 20;
const MIN_QUERY_LENGTH = 2;
const PAGE_LISTBOX_ID = 'tracex-page-search-listbox';

/** The generator's answer key. Shown, but never mixed into the record. */
const OVERLAY_KEYS = new Set(['ring_id', 'ground_truth_ring_id']);

/** Datasets whose `source_record_id` names a row this backend can actually serve. */
const FETCHABLE_ROW_DATASETS = new Set(['persons', 'locations', 'firs']);

const optionDomId = (entityId: string) =>
  `tracex-page-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;

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
    <div className="space-y-4 pb-10 animate-fade-in" data-testid="evidence-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-ink text-base font-bold tracking-tight">Evidence & Provenance</h1>
      </div>
      <LedgerIntegrity />
      <EntityPicker currentEntityId={entityId} />
      {entityId ? (
        <EntityEvidence key={entityId} entityId={entityId} />
      ) : (
        <EmptyState
          icon="search"
          title="No entity selected"
          description="Search for a person, phone, Aadhaar, location, FIR or cell tower."
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
      <PanelHeader title="Resolve an entity" />
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
            Showing <Mono>{currentEntityId}</Mono>
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
        description={<Mono>{entityId}</Mono>}
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
                hint="The dataset table this entity was read from. The dataset files are read-only."
              />
              <KeyValueRow
                label="Source record"
                value={<Mono>{node.source_record_id ?? '—'}</Mono>}
                hint="dataset:row_id. A cell tower names a column of the calls table, so it has no fetchable row."
              />
            </KeyValueList>
          </PanelBody>
        </Panel>

        {record ? (
          <Panel>
            <PanelHeader
              title={`Structured record · ${record.dataset}:${record.rowId}`}
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
                </div>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}

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
              <div className="flex items-center gap-1.5">
                <Badge tone="muted" title="Number of nodes the exact-id lookup returned.">
                  {resolution.data?.count ?? 0} HIT{(resolution.data?.count ?? 0) === 1 ? '' : 'S'}
                </Badge>
                <InfoHint content="Exact-id lookup against the graph search endpoint. One node per materialised type; zero for an id the dataset does not contain." />
              </div>
            </div>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}
