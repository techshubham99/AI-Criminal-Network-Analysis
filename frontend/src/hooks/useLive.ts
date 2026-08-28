/**
 * `useLive` — connection state for the live channel, plus a per-event callback.
 *
 * The handler is held in a ref so an inline arrow function does not tear the
 * subscription down and rebuild it on every render.
 */
import { useEffect, useRef, useState } from 'react';

import { subscribeLive, type LiveStatus } from '@/api/live';
import type { LiveEvent } from '@/types/api';

export function useLive(onEvent?: (event: LiveEvent) => void): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('offline');
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(
    () =>
      subscribeLive({
        onStatus: setStatus,
        onEvent: (event) => handler.current?.(event),
      }),
    [],
  );

  return status;
}
