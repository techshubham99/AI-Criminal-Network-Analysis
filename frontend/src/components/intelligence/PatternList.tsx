import { useMemo, useState, type ReactElement } from 'react';

import { api } from '@/api';
import { PATTERN_TYPES, type PatternListResponse } from '@/types/api';
import {
  Badge,
  EmptyState,
  ErrorState,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { cn } from '@/utils/cn';
import { formatCount, formatMetric, truncate } from '@/utils/format';
import { patternTypeLabel } from './labels';

/**
 * One response per category, merged into one.
 *
 * The categories are disjoint, so `total` is their sum — the number of patterns
 * the backend holds across the categories this screen covers. `limit` is applied
 * after the merge, so the panel shows the most severe across all of them rather
 * than the whole of the first category's page.
 */
function mergePages(
  pages: PatternListResponse[],
  limit: number,
  entityId: string | null,
): PatternListResponse {
  const patterns = [...pages.flatMap((page) => page.patterns)]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, limit);

  return {
    total: pages.reduce((sum, page) => sum + page.total, 0),
    count: patterns.length,
    offset: 0,
    limit,
    patterns,
    filters: { pattern_type: null, entity_id: entityId },
    note: pages[0]?.note ?? '',
  };
}

/**
 * Detected patterns, filtered by type and optionally scoped to one entity.
 *
 * The type filter is populated from the nine categories the backend detects, not
 * from whatever happens to be on the current page — an analyst needs to be able
 * to ask for a category and be told plainly that it is empty. A zero is reported
 * as a zero; nothing is substituted.
 */
export function PatternList({
  entityId,
  limit = 8,
  selectedId = null,
  onSelect,
  className,
  refreshKey = 0,
  types = PATTERN_TYPES,
  title = 'Patterns',
  provided,
}: {
  entityId?: string;
  limit?: number;
  selectedId?: string | null;
  onSelect?: (patternId: string) => void;
  className?: string;
  /** Bumped by the caller after a live event: refetches in place, no skeleton. */
  refreshKey?: number;
  /**
   * The categories this instance offers. Defaults to all nine. A domain screen
   * narrows it to its own categories — and then "All" means all of *those*, so
   * the list never silently mixes in a category the screen does not claim.
   */
  types?: readonly string[];
  title?: string;
  /**
   * An already-computed list to render instead of fetching one. Used by the CSV
   * import preview, whose patterns come from an overlay that only exists in that
   * response — there is no endpoint to ask for them again.
   */
  provided?: PatternListResponse | null;
}): ReactElement {
  const [patternType, setPatternType] = useState('');
  const scoped = types.length < PATTERN_TYPES.length;
  const typesKey = types.join(',');

  const list = useAsync(
    async (signal) => {
      if (patternType || !scoped) {
        return api.listPatterns(
          { pattern_type: patternType || undefined, entity_id: entityId, limit },
          { signal },
        );
      }
      /*
       * A narrowed screen asks for each of its own categories explicitly. The
       * unfiltered list is ordered by severity across all nine, so a screen that
       * shows two of them can find none of its own in that page and would report
       * "no patterns detected" while the backend holds hundreds.
       */
      const pages = await Promise.all(
        types.map((type) =>
          api.listPatterns({ pattern_type: type, entity_id: entityId, limit }, { signal }),
        ),
      );
      return mergePages(pages, limit, entityId ?? null);
    },
    [patternType, entityId, limit, refreshKey, typesKey],
    { enabled: !provided },
  );

  const filter = (
    <label className="flex items-center gap-1.5">
      <span className="field-label">Type</span>
      <select
        value={patternType}
        onChange={(event) => setPatternType(event.target.value)}
        aria-label="Filter patterns by type"
        data-testid="pattern-type-filter"
        className="border-line-strong bg-inset text-ink-2 focus-visible:border-cyan-500 h-7 rounded-sm border px-1.5 text-2xs font-semibold"
      >
        <option value="">All</option>
        {types.map((type) => (
          <option key={type} value={type}>
            {patternTypeLabel(type)}
          </option>
        ))}
      </select>
    </label>
  );

  /*
   * With a narrowed `types` list the backend's unfiltered response still spans
   * every category, so the out-of-scope rows are dropped here as a guard.
   */
  const data = provided ?? list.data;
  const allowed = useMemo(() => new Set(types), [types]);
  const patterns = useMemo(() => {
    if (!data) return [];
    if (!patternType) return data.patterns.filter((pattern) => allowed.has(pattern.pattern_type));
    // A provided list is never refetched, so its type filter is applied here.
    return provided
      ? data.patterns.filter((pattern) => pattern.pattern_type === patternType)
      : data.patterns;
  }, [data, patternType, allowed, provided]);
  const subtitle = data
    ? `${formatCount(patterns.length)} of ${formatCount(data.total)}`
    : undefined;

  return (
    <Panel className={cn('flex min-w-0 flex-col', className)} data-testid="pattern-list">
      <PanelHeader title={title} subtitle={subtitle} accent actions={filter} />
      <PanelBody className="min-h-0 flex-1 overflow-y-auto">
        {list.isInitialLoading ? <SkeletonRows rows={5} /> : null}

        {list.error ? <ErrorState error={list.error} onRetry={list.retry} /> : null}

        {data && patterns.length === 0 ? (
          <EmptyState
            title="No patterns detected"
            description={
              patternType
                ? `The engine found no ${patternTypeLabel(patternType).toLowerCase()} patterns for this filter.`
                : 'The engine found no patterns for this filter.'
            }
          />
        ) : null}

        {data && patterns.length > 0 ? (
          <ul className="space-y-1.5">
            {patterns.map((pattern) => {
              const active = pattern.pattern_id === selectedId;
              return (
                <li key={pattern.pattern_id}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(pattern.pattern_id)}
                    aria-current={active || undefined}
                    data-testid="pattern-row"
                    className={cn(
                      'w-full rounded-sm border px-2.5 py-2 text-left transition-colors',
                      active
                        ? 'border-cyan-600/60 bg-cyan-500/10'
                        : 'border-line bg-inset hover:border-line-accent hover:bg-panel-2',
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <Badge tone="cyan">{patternTypeLabel(pattern.pattern_type)}</Badge>
                      <span className="text-ink-4 shrink-0 font-mono text-2xs tabular-nums">
                        sev {formatMetric(pattern.severity, 2)}
                      </span>
                    </div>

                    <p className="text-ink-2 mt-1.5 text-2xs leading-snug">
                      {truncate(pattern.explanation, 170)}
                    </p>

                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {pattern.entity_ids.slice(0, 3).map((id) => (
                        <Mono key={id}>{id}</Mono>
                      ))}
                      {pattern.entity_ids.length > 3 ? (
                        <span className="text-ink-4 text-2xs">
                          +{formatCount(pattern.entity_ids.length - 3)}
                        </span>
                      ) : null}
                    </div>

                    <p className="text-ink-4 mt-1 flex flex-wrap gap-x-3 text-2xs">
                      <span>{pattern.source_datasets.join(', ') || '—'}</span>
                      <span>
                        {formatCount(pattern.structured_evidence.length)} structured ·{' '}
                        {formatCount(pattern.nlp_evidence.length)} NLP
                      </span>
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {data?.note ? <p className="text-ink-4 mt-3 text-2xs leading-snug">{data.note}</p> : null}
      </PanelBody>
    </Panel>
  );
}
