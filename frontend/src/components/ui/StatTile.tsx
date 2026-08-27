import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { InfoHint } from './Tooltip';

/**
 * StatTile — one number from the backend, with its provenance in the footnote.
 *
 * Every tile on the Command Center is fed from a live response field. There is no
 * default value and no placeholder number: if the backend did not report it, the
 * tile shows an em dash rather than a zero, because "0 relationships" and "not
 * reported" are different claims.
 */
export function StatTile({
  label,
  value,
  footnote,
  hint,
  accent = 'cyan',
  className,
}: {
  label: string;
  value: ReactNode;
  footnote?: ReactNode;
  hint?: ReactNode;
  accent?: 'cyan' | 'azure' | 'neutral' | 'ok' | 'warn';
  className?: string;
}) {
  const accents = {
    cyan: 'text-cyan-300',
    azure: 'text-azure-300',
    neutral: 'text-ink',
    ok: 'text-ok-300',
    warn: 'text-warn-300',
  } as const;

  return (
    <div
      className={cn(
        'bg-panel border-line hover:border-line-strong rounded-lg border px-4 py-3 transition-colors',
        className,
      )}
      data-testid="stat-tile"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="field-label">{label}</p>
        {hint ? <InfoHint content={hint} /> : null}
      </div>
      <p className={cn('mt-2 font-mono text-2xl leading-none tabular-nums', accents[accent])}>
        {value ?? '—'}
      </p>
      {footnote ? <p className="text-ink-4 mt-2 text-2xs leading-snug">{footnote}</p> : null}
    </div>
  );
}

/**
 * A compact horizontal stat, for panel headers and side rails where a full tile
 * would dominate.
 */
export function StatInline({
  label,
  value,
  hint,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline gap-2', className)}>
      <span className="field-label flex items-center gap-1">
        {label}
        {hint ? <InfoHint content={hint} /> : null}
      </span>
      <span className="text-ink font-mono text-xs tabular-nums">{value ?? '—'}</span>
    </div>
  );
}
