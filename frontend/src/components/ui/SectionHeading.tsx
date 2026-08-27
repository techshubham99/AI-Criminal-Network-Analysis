import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * SectionHeading — page-level heading with an optional right-hand control slot.
 * The thin cyan rule to the left is the only decorative element in the app; it
 * exists to give a projected slide a clear reading order.
 */
export function SectionHeading({
  title,
  subtitle,
  actions,
  className,
  as: Tag = 'h1',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <Tag className="text-ink flex items-center gap-2.5 text-base leading-tight font-semibold tracking-tight">
          <span aria-hidden className="bg-cyan-500/70 h-4 w-0.5 shrink-0 rounded-full" />
          {title}
        </Tag>
        {subtitle ? (
          <p className="text-ink-3 mt-1.5 max-w-3xl text-xs leading-relaxed">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A hairline divider with an optional inline caption. */
export function Divider({ label, className }: { label?: string; className?: string }) {
  if (!label) {
    return <hr className={cn('border-line border-t', className)} />;
  }
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <span className="field-label shrink-0">{label}</span>
      <span className="border-line flex-1 border-t" />
    </div>
  );
}
