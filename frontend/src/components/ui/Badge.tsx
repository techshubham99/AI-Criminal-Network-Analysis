import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { entityStyle, relationshipStyle } from '@/utils/entity';

/** Neutral pill. `tone` never uses red except for `alert`. */
export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'cyan' | 'azure' | 'ok' | 'warn' | 'alert' | 'muted';
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-panel-3 text-ink-2 ring-line-strong',
    cyan: 'bg-cyan-500/12 text-cyan-300 ring-cyan-500/30',
    azure: 'bg-azure-500/12 text-azure-300 ring-azure-500/30',
    ok: 'bg-ok-500/12 text-ok-300 ring-ok-500/30',
    warn: 'bg-warn-400/12 text-warn-300 ring-warn-400/30',
    alert: 'bg-alert-500/12 text-alert-300 ring-alert-500/30',
    muted: 'bg-inset text-ink-3 ring-line',
  };
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5 text-2xs font-semibold tracking-wide uppercase ring-1 ring-inset whitespace-nowrap',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Entity-type pill using the shared entity palette, with its hint as a tooltip. */
export function EntityBadge({
  entityType,
  className,
  showDot = true,
}: {
  entityType: string | null | undefined;
  className?: string;
  showDot?: boolean;
}) {
  const style = entityStyle(entityType);
  return (
    <span
      title={style.hint}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 text-2xs font-semibold tracking-wide uppercase ring-1 ring-inset whitespace-nowrap',
        style.badgeClass,
        className,
      )}
    >
      {showDot ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: style.color }}
        />
      ) : null}
      {style.label}
    </span>
  );
}

/** Relationship-type pill; dashed underline marks derived/narrative types. */
export function RelationshipBadge({
  relationshipType,
  className,
}: {
  relationshipType: string | null | undefined;
  className?: string;
}) {
  const style = relationshipStyle(relationshipType);
  return (
    <span
      title={style.hint}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xs bg-inset px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide ring-1 ring-inset ring-line whitespace-nowrap',
        className,
      )}
      style={{ color: style.color }}
    >
      <span
        aria-hidden
        className={cn('h-0 w-3 shrink-0 border-t', style.dashed && 'border-dashed')}
        style={{ borderTopWidth: 2, borderTopColor: style.color }}
      />
      {relationshipType ?? '—'}
    </span>
  );
}
