import type { ReactElement } from 'react';

import type { ScoreBand } from '@/types/api';
import { Badge } from '@/components/ui';
import { cn } from '@/utils/cn';
import { BAND_BAR_CLASS, BAND_TEXT_CLASS, BAND_TONE } from './labels';

/**
 * The score, its band, and the bar that puts it on a 0-100 range.
 *
 * The number is meaningless without the range, so the two are never shown apart:
 * `68` and `68/100` read very differently at a glance on a projector.
 */
export function ScoreReadout({
  score,
  band,
  size = 'lg',
  className,
}: {
  score: number;
  band: ScoreBand;
  size?: 'sm' | 'lg';
  className?: string;
}): ReactElement {
  // Clamped only for the bar geometry; the printed figure is always the
  // backend's own number.
  const width = Math.max(0, Math.min(100, score));

  return (
    <div className={cn('min-w-0', className)} data-testid="priority-score" data-band={band}>
      <p className="field-label">Investigation priority</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            'font-mono font-semibold tabular-nums',
            size === 'lg' ? 'text-2xl' : 'text-lg',
            BAND_TEXT_CLASS[band],
          )}
        >
          {score}
        </span>
        <span className="text-ink-4 font-mono text-xs">/100</span>
        <Badge tone={BAND_TONE[band]} className="ml-auto">
          {band}
        </Badge>
      </div>
      <div
        role="img"
        aria-label={`Score ${score} of 100, band ${band}`}
        className="bg-inset border-line mt-2 h-1.5 w-full overflow-hidden rounded-full border"
      >
        <div
          className={cn('h-full rounded-full', BAND_BAR_CLASS[band])}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
