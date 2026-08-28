import { useState, type ReactElement } from 'react';

import { api } from '@/api';
import {
  Badge,
  Button,
  ErrorState,
  Panel,
  PanelBody,
  PanelHeader,
  Skeleton,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';
import { PriorityExplain } from './PriorityExplain';
import { ScoreReadout } from './ScoreReadout';
import { featureLabel, patternTypeLabel } from './labels';

/** Largest contributors first, zero-contribution factors omitted from the strip. */
const TOP_FACTOR_COUNT = 3;

/**
 * The compact intelligence strip for the network view.
 *
 * Deliberately small: the graph and the entity detail panels are what that screen
 * is for, and this sits above them as a summary — score, band, the factors doing
 * the most work, the detected pattern types, and a "Why?" that opens the full
 * arithmetic in place. Nothing here replaces or duplicates the panels below it.
 */
export function PersonIntelligence({
  personId,
  className,
}: {
  personId: number;
  className?: string;
}): ReactElement {
  const [showWhy, setShowWhy] = useState(false);
  const intel = useAsync((signal) => api.getPersonIntelligence(personId, { signal }), [personId]);

  if (intel.isInitialLoading) {
    return (
      <Panel className={className}>
        <PanelBody className="flex items-center gap-4">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 flex-1" />
        </PanelBody>
      </Panel>
    );
  }

  if (intel.error) {
    return (
      <Panel className={className}>
        <PanelBody>
          <ErrorState
            error={intel.error}
            onRetry={intel.retry}
            title="Priority unavailable"
            compact
          />
        </PanelBody>
      </Panel>
    );
  }

  const data = intel.data;
  if (!data) return <div className={className} />;

  const { priority, patterns } = data;
  const topFactors = [...priority.factors]
    .filter((factor) => factor.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, TOP_FACTOR_COUNT);

  // Pattern types, deduplicated with their counts — a person can carry several
  // patterns of one type and eleven identical chips say less than "x3".
  const typeCounts = new Map<string, number>();
  for (const pattern of patterns) {
    typeCounts.set(pattern.pattern_type, (typeCounts.get(pattern.pattern_type) ?? 0) + 1);
  }

  return (
    <Panel className={cn('min-w-0', className)} data-testid="person-intelligence">
      <PanelHeader
        title="Intelligence"
        accent
        actions={
          <Button
            size="sm"
            variant={showWhy ? 'primary' : 'secondary'}
            aria-expanded={showWhy}
            onClick={() => setShowWhy((open) => !open)}
            data-testid="why-toggle"
          >
            {showWhy ? 'Hide working' : 'Why?'}
          </Button>
        }
      />
      <PanelBody className="space-y-3">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <ScoreReadout
            score={priority.score}
            band={priority.band}
            size="sm"
            className="w-44 shrink-0"
          />

          <div className="min-w-48 flex-1 space-y-2">
            <div>
              <p className="field-label">Top factors</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {topFactors.length === 0 ? (
                  <li className="text-ink-4 text-2xs">No factor contributed</li>
                ) : (
                  topFactors.map((factor) => (
                    <li key={factor.feature}>
                      <Badge tone="neutral" title={factor.explanation}>
                        {featureLabel(factor.feature)} · {factor.contribution}
                      </Badge>
                    </li>
                  ))
                )}
              </ul>
            </div>

            <div>
              <p className="field-label">Patterns · {formatCount(patterns.length)}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {typeCounts.size === 0 ? (
                  <li className="text-ink-4 text-2xs">None detected</li>
                ) : (
                  [...typeCounts.entries()].map(([type, count]) => (
                    <li key={type}>
                      <Badge tone="cyan">
                        {patternTypeLabel(type)}
                        {count > 1 ? ` ×${count}` : ''}
                      </Badge>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </div>
        </div>

        <p className="text-ink-3 text-2xs leading-snug">{priority.explanation}</p>

        {showWhy ? <PriorityExplain personId={personId} className="border-line border-t pt-3" /> : null}
      </PanelBody>
    </Panel>
  );
}
