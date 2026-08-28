import type { ReactElement } from 'react';

import { api } from '@/api';
import { ErrorState, SkeletonRows } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { cn } from '@/utils/cn';
import { featureLabel } from './labels';

/**
 * The "Why?" answer: the arithmetic behind one score, straight from
 * `/intelligence/persons/{id}/explain`.
 *
 * Every string here is a backend field. The walkthrough rows already carry their
 * own label and a spelled-out `arithmetic` expression, so this component formats
 * nothing and computes nothing — it lays the backend's own derivation out in
 * reading order and shows the rounding step that turns a sum like 58.17 into the
 * published 58.
 */
export function PriorityExplain({
  personId,
  className,
}: {
  personId: number;
  className?: string;
}): ReactElement {
  const explain = useAsync((signal) => api.explainPersonPriority(personId, { signal }), [personId]);

  if (explain.isInitialLoading) {
    return <SkeletonRows rows={4} className={className} />;
  }
  if (explain.error) {
    return (
      <ErrorState error={explain.error} onRetry={explain.retry} compact className={className} />
    );
  }

  const data = explain.data;
  if (!data) return <div className={className} />;

  return (
    <div className={cn('space-y-3', className)} data-testid="priority-explain">
      <ol className="space-y-1.5">
        {data.factor_walkthrough.map((row) => (
          <li
            key={row.feature}
            className="border-line bg-inset rounded-sm border px-2 py-1.5"
            data-testid="walkthrough-row"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-ink truncate text-xs font-semibold">
                {row.label || featureLabel(row.feature)}
              </span>
              <span className="text-cyan-300 shrink-0 font-mono text-2xs tabular-nums">
                {row.arithmetic}
              </span>
            </div>
            {row.explanation ? (
              <p className="text-ink-3 mt-0.5 text-2xs leading-snug">{row.explanation}</p>
            ) : null}
          </li>
        ))}
      </ol>

      <dl className="border-line grid grid-cols-1 gap-1.5 border-t pt-2.5 sm:grid-cols-2">
        <div>
          <dt className="field-label">Sum of contributions</dt>
          <dd className="text-ink mt-0.5 font-mono text-xs tabular-nums">
            {data.sum_of_contributions}
          </dd>
        </div>
        <div>
          <dt className="field-label">Published score</dt>
          <dd className="text-ink mt-0.5 font-mono text-xs tabular-nums">
            {data.score} · {data.band}
          </dd>
        </div>
      </dl>

      <p className="text-ink-3 text-2xs leading-snug">{data.rounding}</p>
      <p className="text-ink-3 text-2xs leading-snug">{data.band_meaning}</p>
      <p className="text-ink-4 text-2xs leading-snug">{data.disclaimer}</p>
    </div>
  );
}
