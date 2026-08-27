import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * Tooltip — CSS/`group`-driven, no positioning library.
 *
 * Used for the "tooltips for unfamiliar fields" requirement: every field name an
 * investigator would not immediately recognise (betweenness, provenance
 * confidence, CO_LOCATED, resolution method) carries one. The trigger is a
 * `<button>` so it is reachable by keyboard and announced by screen readers via
 * `aria-describedby`.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}) {
  return (
    <span className={cn('group/tt relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute left-1/2 z-50 w-max max-w-[17rem] -translate-x-1/2 rounded-md border border-line-strong bg-panel-3 px-2.5 py-1.5 text-left text-xs leading-relaxed font-normal normal-case tracking-normal text-ink-2 opacity-0 transition-opacity group-hover/tt:opacity-100 group-focus-within/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  );
}

/**
 * A small circled "i" that reveals an explanation. Pair it with a field label
 * whose meaning is not self-evident.
 */
export function InfoHint({ content, className }: { content: ReactNode; className?: string }) {
  return (
    <Tooltip content={content}>
      <button
        type="button"
        aria-label="What does this mean?"
        className={cn(
          'inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-line-strong text-2xs leading-none font-bold text-ink-4 transition-colors hover:border-cyan-500/60 hover:text-cyan-300',
          className,
        )}
      >
        i
      </button>
    </Tooltip>
  );
}
