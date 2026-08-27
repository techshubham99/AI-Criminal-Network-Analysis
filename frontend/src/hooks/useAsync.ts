/**
 * `useAsync` — one async state machine, used by every data-bound view.
 *
 * Gives the four states the UI must distinguish (idle / loading / success /
 * error), a `retry()` that re-runs the same request, and abort-on-supersede so
 * a fast sequence of parameter changes cannot deliver a stale response into a
 * newer render.
 *
 * Deliberately not a data-fetching library: the app makes a handful of GETs
 * against a local backend, and a hand-rolled 60-line hook is easier to audit
 * than a cache framework's invalidation rules.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isAbortError } from '@/api/client';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: ApiError | null;
  /** True on the first load only — use it to pick skeleton vs. dimmed refresh. */
  isInitialLoading: boolean;
  isLoading: boolean;
  retry: () => void;
}

export interface UseAsyncOptions {
  /** When false the request is not issued (e.g. waiting on a selection). */
  enabled?: boolean;
}

/**
 * @param fn   Receives an AbortSignal; must pass it to the endpoint binding.
 * @param deps Re-runs when these change (same contract as useEffect deps).
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: UseAsyncOptions = {},
): AsyncState<T> {
  const { enabled = true } = options;

  const [status, setStatus] = useState<AsyncStatus>(enabled ? 'loading' : 'idle');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const hasLoadedOnce = useRef(false);

  // Keep the latest fn without making it a dependency of the effect: callers
  // write inline arrow functions, and `deps` is the intended trigger.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return;
    }

    const controller = new AbortController();
    let active = true;

    setStatus('loading');
    setError(null);

    fnRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        hasLoadedOnce.current = true;
        setData(result);
        setStatus('success');
      })
      .catch((cause: unknown) => {
        if (!active || isAbortError(cause)) return;
        hasLoadedOnce.current = true;
        setError(
          cause instanceof ApiError
            ? cause
            : new ApiError({
                message: cause instanceof Error ? cause.message : String(cause),
                status: 0,
                code: 'client_error',
                url: '(client)',
              }),
        );
        setStatus('error');
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt, ...deps]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return {
    status,
    data,
    error,
    isLoading: status === 'loading',
    isInitialLoading: status === 'loading' && !hasLoadedOnce.current,
    retry,
  };
}
