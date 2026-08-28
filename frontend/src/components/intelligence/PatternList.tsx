import { useState, type ReactElement } from 'react';

import { api } from '@/api';
import { PATTERN_TYPES } from '@/types/api';
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
}: {
  entityId?: string;
  limit?: number;
  selectedId?: string | null;
  onSelect?: (patternId: string) => void;
  className?: string;
  /** Bumped by the caller after a live event: refetches in place, no skeleton. */
  refreshKey?: number;
}): ReactElement {
  const [patternType, setPatternType] = useState('');

  const list = useAsync(
    (signal) =>
      api.listPatterns(
        { pattern_type: patternType || undefined, entity_id: entityId, limit },
        { signal },
      ),
    [patternType, entityId, limit, refreshKey],
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
        {PATTERN_TYPES.map((type) => (
          <option key={type} value={type}>
            {patternTypeLabel(type)}
          </option>
        ))}
      </select>
    </label>
  );

  const data = list.data;
  const subtitle = data ? `${formatCount(data.count)} of ${formatCount(data.total)}` : undefined;

  return (
    <Panel className={cn('flex min-w-0 flex-col', className)} data-testid="pattern-list">
      <PanelHeader title="Patterns" subtitle={subtitle} accent actions={filter} />
      <PanelBody className="min-h-0 flex-1 overflow-y-auto">
        {list.isInitialLoading ? <SkeletonRows rows={5} /> : null}

        {list.error ? <ErrorState error={list.error} onRetry={list.retry} /> : null}

        {data && data.patterns.length === 0 ? (
          <EmptyState
            title="No patterns detected"
            description={
              patternType
                ? `The engine found no ${patternTypeLabel(patternType).toLowerCase()} patterns for this filter.`
                : 'The engine found no patterns for this filter.'
            }
          />
        ) : null}

        {data && data.patterns.length > 0 ? (
          <ul className="space-y-1.5">
            {data.patterns.map((pattern) => {
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
