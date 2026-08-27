import { cn } from '@/utils/cn';
import { formatConfidence, humanizeToken } from '@/utils/format';
import { Tooltip } from './Tooltip';

/**
 * ConfidenceMeter — renders the confidence the BACKEND assigned. Nothing here
 * computes, rescales or reinterprets a score.
 *
 * These values come from the deterministic extraction rules (e.g. 1.0 for a
 * complainant named in an explicit "reported" clause, 0.7 for a sighting
 * placement). They are rule-tier constants, not the output of a trained model,
 * and the tooltip says so — the brief forbids fabricated accuracy claims, and a
 * bare "0.70" on a slide invites exactly that misreading.
 *
 * Deliberately NOT rendered as a percentage: "70%" implies a calibrated
 * probability the system has never measured.
 */
export function ConfidenceMeter({
  value,
  method,
  className,
  showBar = true,
}: {
  value: number | null | undefined;
  /** The extraction/resolution method token, e.g. `rule:complainant_reported_suspect`. */
  method?: string | null;
  className?: string;
  showBar?: boolean;
}) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
  const clamped = numeric === null ? 0 : Math.max(0, Math.min(1, numeric));
  const tier = numeric === null ? 'unknown' : clamped >= 0.9 ? 'high' : clamped >= 0.6 ? 'medium' : 'low';

  // Full class strings: Tailwind scans source, so these cannot be assembled.
  const barClass = {
    high: 'bg-ok-400',
    medium: 'bg-cyan-400',
    low: 'bg-warn-400',
    unknown: 'bg-line-strong',
  }[tier];
  const textClass = {
    high: 'text-ok-300',
    medium: 'text-cyan-300',
    low: 'text-warn-300',
    unknown: 'text-ink-4',
  }[tier];

  return (
    <Tooltip
      content={
        <>
          Rule-assigned confidence tier
          {method ? (
            <>
              {' '}
              from <span className="text-cyan-300">{humanizeToken(method)}</span>
            </>
          ) : null}
          . These are fixed constants set by the extraction rule that fired — not the output of a
          trained model, and not a calibrated probability.
        </>
      }
    >
      <span className={cn('inline-flex items-center gap-2', className)}>
        <span className={cn('font-mono text-xs tabular-nums', textClass)}>
          {formatConfidence(numeric)}
        </span>
        {showBar ? (
          <span
            aria-hidden
            className="bg-inset relative h-1 w-12 shrink-0 overflow-hidden rounded-full"
          >
            <span
              className={cn('absolute inset-y-0 left-0 rounded-full', barClass)}
              style={{ width: `${clamped * 100}%` }}
            />
          </span>
        ) : null}
      </span>
    </Tooltip>
  );
}
