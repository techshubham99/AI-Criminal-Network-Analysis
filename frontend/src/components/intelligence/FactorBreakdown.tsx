import type { ReactElement } from 'react';

import type { ScoreFactorOut } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatCount } from '@/utils/format';
import { featureLabel } from './labels';

/**
 * Where the score came from, factor by factor.
 *
 * Each row prints the arithmetic — `value x weight = contribution` — because a
 * weighted total that cannot be checked by hand is not an explanation. Factors
 * that contributed nothing are still listed, dimmed: dropping them would leave a
 * reader unable to see that the six weights sum to 100.
 *
 * Rows are ordered by contribution so the largest driver is first. That is
 * presentation only; no value is recomputed here.
 */
export function FactorBreakdown({
  factors,
  className,
}: {
  factors: ScoreFactorOut[];
  className?: string;
}): ReactElement {
  const ordered = [...factors].sort(
    (a, b) =>
      b.contribution - a.contribution ||
      b.max_contribution - a.max_contribution ||
      a.feature.localeCompare(b.feature),
  );

  if (ordered.length === 0) {
    return (
      <p className={cn('text-ink-3 text-xs', className)} data-testid="factor-breakdown">
        No factors contributed to this score.
      </p>
    );
  }

  return (
    <ul className={cn('space-y-2.5', className)} data-testid="factor-breakdown">
      {ordered.map((factor) => {
        const share =
          factor.max_contribution > 0
            ? Math.max(0, Math.min(100, (factor.contribution / factor.max_contribution) * 100))
            : 0;
        const spent = factor.contribution > 0;

        return (
          <li key={factor.feature} data-testid="factor-row" data-feature={factor.feature}>
            <div className="flex items-baseline justify-between gap-3">
              <span
                className={cn('truncate text-xs font-semibold', spent ? 'text-ink' : 'text-ink-4')}
              >
                {featureLabel(factor.feature)}
              </span>
              <span className="shrink-0 font-mono text-2xs tabular-nums">
                <span className={spent ? 'text-cyan-300' : 'text-ink-4'}>
                  {factor.contribution}
                </span>
                <span className="text-ink-4"> / {factor.max_contribution}</span>
              </span>
            </div>

            <div className="bg-inset border-line mt-1 h-1 w-full overflow-hidden rounded-full border">
              <div
                className={cn('h-full rounded-full', spent ? 'bg-cyan-500' : 'bg-transparent')}
                style={{ width: `${share}%` }}
              />
            </div>

            <p className="text-ink-4 mt-1 font-mono text-2xs tabular-nums">
              {factor.value} × {factor.max_contribution} = {factor.contribution}
            </p>

            {factor.explanation ? (
              <p className="text-ink-3 mt-0.5 text-2xs leading-snug">{factor.explanation}</p>
            ) : null}

            {factor.pattern_ids.length > 0 || factor.evidence_ids.length > 0 ? (
              <p className="text-ink-4 mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
                {factor.pattern_ids.length > 0 ? (
                  <span>{formatCount(factor.pattern_ids.length)} patterns</span>
                ) : null}
                {factor.evidence_ids.length > 0 ? (
                  <span>{formatCount(factor.evidence_ids.length)} evidence records</span>
                ) : null}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
