import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { api } from '@/api';
import {
  Badge,
  EmptyState,
  ErrorState,
  KeyValueList,
  KeyValueRow,
  Mono,
  Panel,
  PanelBody,
  PanelHeader,
  RelationshipBadge,
  SkeletonRows,
} from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { cn } from '@/utils/cn';
import { personIdFromEntityId } from '@/utils/entity';
import { formatMetric, humanizeToken } from '@/utils/format';
import { flattenScalars } from '@/utils/records';
import { EvidencePair } from './EvidenceList';
import { patternTypeLabel } from './labels';

/**
 * One pattern in full: type, entities, explanation, evidence ids, source datasets
 * and severity.
 *
 * Person entities link through to their network view, because a pattern is only
 * useful if the analyst can get from it to the subject. The `detail` object is
 * rendered generically — it carries different keys per pattern type, and inventing
 * a bespoke layout per category would mean guessing at keys the backend may add.
 */
export function PatternDetails({
  patternId,
  className,
}: {
  patternId: string | null;
  className?: string;
}): ReactElement {
  const enabled = patternId !== null && patternId !== '';
  const detail = useAsync((signal) => api.getPattern(patternId as string, { signal }), [patternId], {
    enabled,
  });

  const shell = (children: ReactElement) => (
    <Panel className={cn('min-w-0', className)} data-testid="pattern-details">
      <PanelHeader title="Pattern detail" accent />
      <PanelBody>{children}</PanelBody>
    </Panel>
  );

  if (!enabled) {
    return shell(
      <EmptyState title="No pattern selected" description="Pick a pattern from the list." />,
    );
  }
  if (detail.isInitialLoading) return shell(<SkeletonRows rows={5} />);
  if (detail.error) return shell(<ErrorState error={detail.error} onRetry={detail.retry} />);

  const data = detail.data;
  if (!data) return shell(<EmptyState title="No pattern detail" />);

  const detailRows = flattenScalars(data.detail);

  return (
    <Panel className={cn('min-w-0', className)} data-testid="pattern-details">
      <PanelHeader
        title={patternTypeLabel(data.pattern_type)}
        subtitle={<Mono>{data.pattern_id}</Mono>}
        accent
        actions={<Badge tone="neutral">sev {formatMetric(data.severity, 2)}</Badge>}
      />
      <PanelBody className="space-y-4">
        <p className="text-ink-2 text-xs leading-relaxed">{data.explanation}</p>

        <section className="space-y-1.5">
          <h3 className="field-label">Entities</h3>
          <ul className="flex flex-wrap gap-1.5">
            {data.entity_ids.map((entityId) => {
              const personId = personIdFromEntityId(entityId);
              return (
                <li key={entityId}>
                  {personId === null ? (
                    <Mono>{entityId}</Mono>
                  ) : (
                    <Link
                      to={`/network/${personId}`}
                      className="text-cyan-300 hover:text-cyan-200 font-mono text-2xs underline decoration-dotted underline-offset-2"
                    >
                      {entityId}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <KeyValueList dense>
          <KeyValueRow
            label="Relationship types"
            value={
              data.relationship_types.length === 0 ? (
                '—'
              ) : (
                <span className="flex flex-wrap gap-1">
                  {data.relationship_types.map((type) => (
                    <RelationshipBadge key={type} relationshipType={type} />
                  ))}
                </span>
              )
            }
          />
          <KeyValueRow
            label="Source datasets"
            value={data.source_datasets.map(humanizeToken).join(', ') || '—'}
          />
        </KeyValueList>

        {detailRows.length > 0 ? (
          <section className="space-y-1.5">
            <h3 className="field-label">Detail</h3>
            <KeyValueList dense>
              {detailRows.map(([key, value]) => (
                <KeyValueRow key={key} label={humanizeToken(key)} value={value} mono wrap />
              ))}
            </KeyValueList>
          </section>
        ) : null}

        <section className="space-y-1.5">
          <h3 className="field-label">Evidence</h3>
          <EvidencePair
            structured={data.structured_evidence}
            nlp={data.nlp_evidence}
            initial={4}
          />
        </section>
      </PanelBody>
    </Panel>
  );
}
