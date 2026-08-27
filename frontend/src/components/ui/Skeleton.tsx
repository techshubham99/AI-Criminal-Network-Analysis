import { cn } from '@/utils/cn';

/**
 * Skeletons. A calm pulse only — the brief forbids unnecessary animation, and a
 * shimmering sweep on a projector reads as a rendering fault.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-xs bg-panel-3/70', className)}
      data-testid="skeleton"
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden data-testid="skeleton-text">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

/** Matches the footprint of a StatTile so the dashboard does not jump on load. */
export function SkeletonTile() {
  return (
    <div className="bg-panel border border-line rounded-lg px-4 py-3" data-testid="skeleton-tile">
      <Skeleton className="h-2.5 w-24" />
      <Skeleton className="mt-3 h-7 w-20" />
      <Skeleton className="mt-2.5 h-2.5 w-32" />
    </div>
  );
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)} aria-hidden data-testid="skeleton-rows">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      className={cn(
        'inline-block size-3.5 animate-spin rounded-full border-2 border-line-strong border-t-cyan-400',
        className,
      )}
    />
  );
}
