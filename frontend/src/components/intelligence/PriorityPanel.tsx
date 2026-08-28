import { useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/api';
import {
  Badge,
  Button,
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
import { formatCount } from '@/utils/format';
import { EvidencePair } from './EvidenceList';
import { FactorBreakdown } from './FactorBreakdown';
import { PriorityExplain } from './PriorityExplain';
import { ScoreReadout } from './ScoreReadout';
import { patternTypeLabel } from './labels';

/**
 * The full priority read on one person: score, band, factor contributions,
 * evidence and the backend's own short explanation.
 *
 * The number is never presented alone. Factors are always visible, the two
 * evidence lists sit beside them, and the arithmetic is one click away — a
 * priority figure with no derivation on screen is exactly the thing this system
 * is not allowed to produce.
 */
export function PriorityPanel({
  personId,
  className,
  refreshKey = 0,
}: {
  personId: number | null;
  className?: string;
  /** Bumped by the caller after a live event: refetches in place, no skeleton. */
  refreshKey?: number;
}): ReactElement {
  const [showWhy, setShowWhy] = useState(false);
  const enabled = personId !== null;
  const intel = useAsync(
    (signal) => api.getPersonIntelligence(personId as number, { signal }),
    [personId, refreshKey],
    { enabled },
  );

  if (!enabled) {
    return (
      <Panel className={className}>
        <PanelHeader title="Priority detail" accent />
        <PanelBody>
          <EmptyState title="Select a person" description="Pick a row from the queue." />
        </PanelBody>
      </Panel>
    );
  }

  if (intel.isInitialLoading) {
    return (
      <Panel className={className}>
        <PanelHeader title="Priority detail" accent />
        <PanelBody>
          <SkeletonRows rows={6} />
        </PanelBody>
      </Panel>
    );
  }

  if (intel.error) {
    return (
      <Panel className={className}>
        <PanelHeader title="Priority detail" accent />
        <PanelBody>
          <ErrorState error={intel.error} onRetry={intel.retry} />
        </PanelBody>
      </Panel>
    );
  }

  const data = intel.data;
  if (!data) {
    return (
      <Panel className={className}>
        <PanelHeader title="Priority detail" accent />
        <PanelBody>
          <EmptyState title="No priority record" description="Nothing scored for this person." />
        </PanelBody>
      </Panel>
    );
  }

  const { person, priority, patterns } = data;
  const place = [person.city, person.state].filter(Boolean).join(', ');

  return (
    <Panel className={cn('min-w-0', className)} data-testid="priority-panel">
      <PanelHeader
        title={person.name}
        subtitle={place || undefined}
        accent
        actions={
          <Link to={`/network/${person.person_id}`}>
            <Button size="sm">Open network</Button>
          </Link>
        }
      />
      <PanelBody className="space-y-4">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <ScoreReadout score={priority.score} band={priority.band} className="min-w-48 flex-1" />
          <dl className="flex gap-5">
            <div>
              <dt className="field-label">Patterns</dt>
              <dd className="text-ink mt-0.5 font-mono text-sm tabular-nums">
                {formatCount(patterns.length)}
              </dd>
            </div>
            <div>
              <dt className="field-label">Entity</dt>
              <dd className="mt-0.5">
                <Mono>{priority.entity_id}</Mono>
              </dd>
            </div>
          </dl>
        </div>

        <p className="text-ink-2 text-xs leading-relaxed">{priority.explanation}</p>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="field-label">Factor contributions</h3>
            <Button
              size="sm"
              variant={showWhy ? 'primary' : 'secondary'}
              aria-expanded={showWhy}
              onClick={() => setShowWhy((open) => !open)}
              data-testid="why-toggle"
            >
              {showWhy ? 'Hide working' : 'Why?'}
            </Button>
          </div>
          <FactorBreakdown factors={priority.factors} />
          {showWhy ? <PriorityExplain personId={person.person_id} className="pt-1" /> : null}
        </section>

        {patterns.length > 0 ? (
          <section className="space-y-1.5">
            <h3 className="field-label">Detected patterns</h3>
            <div className="flex flex-wrap gap-1.5">
              {patterns.map((pattern) => (
                <Badge key={pattern.pattern_id} tone="cyan" title={pattern.explanation}>
                  {patternTypeLabel(pattern.pattern_type)}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        <section className="space-y-1.5">
          <h3 className="field-label">Evidence</h3>
          <EvidencePair
            structured={priority.structured_evidence}
            nlp={priority.nlp_evidence}
            initial={4}
          />
        </section>

        <p className="text-ink-4 text-2xs leading-snug">{priority.disclaimer}</p>
      </PanelBody>
    </Panel>
  );
}
