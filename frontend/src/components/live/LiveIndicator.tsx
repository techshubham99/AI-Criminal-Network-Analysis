/**
 * LiveIndicator — a three-state dot: the SSE stream is live, connecting, or off.
 *
 * Deliberately one word. It reports the state of the connection and nothing
 * else: no counters, no toasts, no notification framework. When the stream is
 * not live it says so rather than showing a reassuring green light, because a
 * silent dashboard and a disconnected one look identical otherwise.
 */
import type { ReactElement } from 'react';

import { useLive } from '@/hooks/useLive';
import type { LiveEvent } from '@/types/api';
import { cn } from '@/utils/cn';

const LABEL = {
  live: 'LIVE',
  connecting: 'Linking',
  offline: 'Live off',
} as const;

const DOT = {
  live: 'bg-ok-400',
  connecting: 'bg-warn-400',
  offline: 'bg-ink-4',
} as const;

const TEXT = {
  live: 'text-ok-300',
  connecting: 'text-warn-300',
  offline: 'text-ink-4',
} as const;

const TITLE = {
  live: 'Connected to the live event stream.',
  connecting: 'Connecting to the live event stream.',
  offline: 'No live connection. Data refreshes only when reloaded.',
} as const;

export function LiveIndicator({
  onEvent,
  className,
}: {
  /** Called for every frame, so a page can refresh what the event touched. */
  onEvent?: (event: LiveEvent) => void;
  className?: string;
}): ReactElement {
  const status = useLive(onEvent);

  return (
    <span
      data-testid="live-indicator"
      data-status={status}
      title={TITLE[status]}
      aria-label={`Live updates: ${LABEL[status]}`}
      className={cn(
        'border-line bg-inset flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative size-2 shrink-0 rounded-full',
          DOT[status],
          status === 'live' && 'pulse-dot',
        )}
      />
      <span className={cn('text-2xs font-semibold whitespace-nowrap', TEXT[status])}>
        {LABEL[status]}
      </span>
    </span>
  );
}
