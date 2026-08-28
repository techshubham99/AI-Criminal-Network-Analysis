import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '@/api';
import { EmptyState, ErrorState, SkeletonRows, Spinner } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { NodeOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { firIdFromEntityId, personIdFromEntityId, splitEntityId } from '@/utils/entity';
import { formatCount } from '@/utils/format';

import { SearchResultList } from './SearchResultList';

/**
 * GlobalSearch — the top-bar entry point into the whole investigation.
 *
 * Backed by `GET /api/v1/graph/search?q=&limit=`, which returns `NodeOut`
 * records for persons, phones, Aadhaar ids, locations, FIRs and cell towers.
 * Keystrokes are debounced to one request per pause and every in-flight request
 * is aborted when superseded, so a fast typist cannot land a stale response.
 *
 * ROUTING — the two id forms matter here. Responses speak the prefixed entity id
 * (`person:445`), but this app's route paths carry the backend's NUMERIC row id
 * (`/network/445`, `/fir/79`) because the underlying path parameters parse as
 * integers. Only the Evidence route takes the prefixed id, and it does so as a
 * QUERY parameter — which is the form that endpoint wants, and which must be
 * URL-encoded because phone ids contain a '+'.
 *
 * A phone or a tower cannot be a network root: the backend's network endpoint is
 * person-rooted (`/graph/persons/{id}/network`). That limitation is stated in the
 * UI (each non-person row says where it opens) rather than hidden.
 */

/** Backend caps search at 50; 12 is what fits a dropdown without scroll fatigue. */
const RESULT_LIMIT = 12;
/** Below this the backend has nothing useful to match on, so we do not ask. */
const MIN_QUERY_LENGTH = 2;

/**
 * Deterministic option/listbox ids, mirroring the scheme in `SearchResultList`.
 * The combobox must name its active option in `aria-activedescendant`, and the
 * list's props are a fixed contract with no slot for an id prefix — so the two
 * files share this convention deliberately.
 */
const LISTBOX_ID = 'tracex-dropdown-search-listbox';
const optionDomId = (entityId: string) =>
  `tracex-dropdown-search-option-${entityId.replace(/[^A-Za-z0-9]+/g, '-')}`;

/** The route a result opens, or null when its id cannot be converted safely. */
function routeForNode(node: NodeOut): string | null {
  const type = (node.entity_type ?? '').toUpperCase();

  if (type === 'PERSON') {
    const personId = personIdFromEntityId(node.entity_id);
    return personId === null ? null : `/network/${personId}`;
  }
  if (type === 'FIR') {
    const firId = firIdFromEntityId(node.entity_id);
    return firId === null ? null : `/fir/${firId}`;
  }
  if (type === 'LOCATION') {
    const parts = splitEntityId(node.entity_id);
    const locationId = parts && /^\d+$/.test(parts.key) ? parts.key : null;
    if (locationId !== null) return `/locations?location=${locationId}`;
  }
  // PHONE / AADHAAR / CELL_TOWER: prefixed id, as a query parameter.
  return `/evidence?entity=${encodeURIComponent(node.entity_id)}`;
}

export function GlobalSearch({ className }: { className?: string }) {
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const debounced = useDebouncedValue(trimmed, 250);
  const canSearch = debounced.length >= MIN_QUERY_LENGTH;

  const { data, error, isLoading, isInitialLoading, retry } = useAsync(
    (signal) => api.searchGraph(debounced, RESULT_LIMIT, { signal }),
    [debounced],
    { enabled: canSearch },
  );

  /**
   * Rows that can actually be opened. A PERSON or FIR whose id will not convert
   * to the integer its route needs is dropped rather than rendered as a dead
   * row — and dropping it here keeps the keyboard index and the rendered list in
   * exact agreement.
   */
  const rows = useMemo(() => {
    if (!canSearch || !data) return [] as Array<{ node: NodeOut; to: string }>;
    const out: Array<{ node: NodeOut; to: string }> = [];
    for (const node of data.results) {
      const to = routeForNode(node);
      if (to) out.push({ node, to });
    }
    return out;
  }, [canSearch, data]);

  const results = useMemo(() => rows.map((row) => row.node), [rows]);

  // A new query is a new list: put the caret back on the top hit.
  useEffect(() => {
    setActiveIndex(0);
  }, [debounced]);

  const clampedActive = rows.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), rows.length - 1);

  const select = useCallback(
    (node: NodeOut) => {
      const to = routeForNode(node);
      if (!to) return;
      setOpen(false);
      setQuery('');
      setActiveIndex(0);
      navigate(to);
    },
    [navigate],
  );

  /* ------------------------------------------------------- keyboard: global -- */
  // '/' focuses the search from anywhere, unless the user is already typing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Clicking away closes the popup without clearing what was typed.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  /* -------------------------------------------------------- keyboard: field -- */
  const onFieldKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        if (rows.length > 0) setActiveIndex((i) => (clampAt(i, rows.length) + 1) % rows.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setOpen(true);
        if (rows.length > 0) {
          setActiveIndex((i) => (clampAt(i, rows.length) - 1 + rows.length) % rows.length);
        }
        break;
      case 'Home':
        if (rows.length > 0) {
          event.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (rows.length > 0) {
          event.preventDefault();
          setActiveIndex(rows.length - 1);
        }
        break;
      case 'Enter': {
        const row = clampedActive >= 0 ? rows[clampedActive] : undefined;
        if (open && row) {
          event.preventDefault();
          select(row.node);
        }
        break;
      }
      case 'Escape':
        event.preventDefault();
        if (trimmed.length > 0) setQuery('');
        setOpen(false);
        break;
      default:
        break;
    }
  };

  /* ----------------------------------------------------------------- states -- */
  const panelOpen = open && trimmed.length > 0;
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LENGTH;
  // The debounce has not caught up with the field yet, so no request has been
  // issued for what is on screen. Without this the panel would show an empty
  // result list for the length of the debounce before the skeleton appears.
  const settling =
    trimmed.length >= MIN_QUERY_LENGTH && debounced !== trimmed;
  // 422 is the backend's "empty or invalid query" answer. It is not a fault to
  // report in red — the honest response is to say nothing was searched.
  const invalidQuery = error !== null && error.status === 422;
  const hardError = error !== null && !invalidQuery;
  const emptyAnswer = canSearch && !isLoading && !error && data !== null && rows.length === 0;
  const listVisible = panelOpen && !settling && rows.length > 0;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div className="relative">
        <span aria-hidden className="text-ink-4 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="10.5" cy="10.5" r="6.25" />
            <path d="m15.2 15.2 4.3 4.3" strokeLinecap="round" />
          </svg>
        </span>

        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search persons, phones, Aadhaar ids, locations, FIRs and cell towers"
          aria-expanded={panelOpen}
          aria-controls={listVisible ? LISTBOX_ID : undefined}
          aria-activedescendant={
            listVisible && clampedActive >= 0
              ? optionDomId(rows[clampedActive].node.entity_id)
              : undefined
          }
          aria-autocomplete="list"
          aria-describedby="tracex-search-help"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search entities…"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onFieldKeyDown}
          className={cn(
            'bg-inset border-line-strong text-ink placeholder:text-ink-4 h-8.5 w-full rounded-sm border pr-16 pl-8 font-sans text-xs transition-colors',
            'hover:border-line-accent focus:border-cyan-600/60',
            // The UA search-cancel button is a light square on a dark field.
            '[&::-webkit-search-cancel-button]:hidden',
          )}
        />

        <span className="pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5">
          {isLoading ? <Spinner className="size-3" label="Searching" /> : null}
          {trimmed.length === 0 ? (
            <kbd className="border-line-strong text-ink-4 rounded-xs border px-1.5 py-0.5 text-2xs">
              /
            </kbd>
          ) : null}
        </span>
      </div>

      <p id="tracex-search-help" className="sr-only">
        Type at least {MIN_QUERY_LENGTH} characters. Use the up and down arrow keys to move through
        results, Enter to open one, Escape to close.
      </p>
      <span role="status" aria-live="polite" className="sr-only">
        {listVisible ? `${rows.length} search results available.` : ''}
      </span>

      {panelOpen ? (
        <div
          className="border-line-strong bg-panel-2 absolute top-full right-0 left-0 z-40 mt-1 min-w-[20rem] overflow-hidden rounded-lg border"
          data-testid="global-search-panel"
        >
          <div className="max-h-[22rem] overflow-y-auto p-1.5">
            {tooShort ? (
              <p className="text-ink-3 px-2 py-3 text-xs">
                Type at least {MIN_QUERY_LENGTH} characters to search the graph.
              </p>
            ) : invalidQuery ? (
              <p className="text-ink-3 px-2 py-3 text-xs">
                The backend rejected this as an empty or invalid query, so nothing was searched.
              </p>
            ) : hardError ? (
              <ErrorState error={error} onRetry={retry} compact className="m-0.5" />
            ) : settling || isInitialLoading ? (
              <SkeletonRows rows={4} className="p-1" />
            ) : emptyAnswer ? (
              <EmptyState
                icon="search"
                title="No matching entity"
                description={
                  <>
                    Nothing in the graph matches{' '}
                    <span className="text-ink-2 font-mono">{debounced}</span>. Search covers person
                    names, phone numbers, Aadhaar ids, location names, FIR ids and cell tower ids.
                  </>
                }
              />
            ) : (
              <SearchResultList
                results={results}
                activeIndex={clampedActive}
                onSelect={select}
                onHoverIndex={setActiveIndex}
                variant="dropdown"
                className={isLoading ? 'opacity-60 transition-opacity' : undefined}
              />
            )}
          </div>

          {listVisible ? (
            <div className="border-line bg-panel text-ink-4 flex items-center justify-between gap-3 border-t px-2.5 py-1.5 text-2xs">
              <span className="font-mono">
                {data && data.count !== rows.length
                  ? `${formatCount(rows.length)} of ${formatCount(data.count)} returned`
                  : `${formatCount(rows.length)} result${rows.length === 1 ? '' : 's'}`}
              </span>
              <span className="hidden sm:inline">
                ↑↓ move · ⏎ open · esc close — non-person results open in Evidence &amp; Provenance,
                because the network view is person-rooted
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Keep a stored index usable after the result list has shrunk. */
function clampAt(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
