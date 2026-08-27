import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { InfoHint } from './Tooltip';

/**
 * KeyValue — the workhorse of every details/evidence panel.
 *
 * Field names are uppercase micro-labels; values are monospace whenever they are
 * an identifier, offset, date or figure, which is the app's convention for
 * "this is data, not prose".
 */
export function KeyValueList({
  children,
  className,
  dense = false,
}: {
  children: ReactNode;
  className?: string;
  dense?: boolean;
}) {
  return (
    <dl className={cn('grid grid-cols-1 gap-y-2', dense && 'gap-y-1.5', className)}>
      {children}
    </dl>
  );
}

export function KeyValueRow({
  label,
  value,
  hint,
  mono = false,
  wrap = false,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  /** Shown behind an "i" affordance next to the label. */
  hint?: ReactNode;
  mono?: boolean;
  wrap?: boolean;
  tone?: 'default' | 'muted' | 'alert' | 'ok' | 'cyan';
  className?: string;
}) {
  const tones = {
    default: 'text-ink',
    muted: 'text-ink-3',
    alert: 'text-alert-300',
    ok: 'text-ok-300',
    cyan: 'text-cyan-300',
  } as const;

  return (
    <div className={cn('grid grid-cols-[minmax(7.5rem,38%)_1fr] items-baseline gap-3', className)}>
      <dt className="field-label flex items-center gap-1.5">
        <span>{label}</span>
        {hint ? <InfoHint content={hint} /> : null}
      </dt>
      <dd
        className={cn(
          'text-xs',
          tones[tone ?? 'default'],
          mono && 'font-mono',
          wrap ? 'break-words' : 'truncate',
        )}
      >
        {value ?? '—'}
      </dd>
    </div>
  );
}

/** A monospace identifier, rendered as data rather than text. */
export function Mono({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <code
      title={title}
      className={cn('rounded-xs bg-inset px-1 py-px font-mono text-2xs text-ink-2', className)}
    >
      {children}
    </code>
  );
}
