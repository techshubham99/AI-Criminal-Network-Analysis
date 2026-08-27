/**
 * `useAsync` is the state machine behind every loading skeleton, error panel and
 * retry button in the app, so the states it can be in are worth pinning
 * precisely — especially the two that are easy to get wrong: a disabled request
 * must not fire at all, and a superseded request must never deliver its result
 * into a newer render.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/api/client';
import { useAsync } from './useAsync';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAsync', () => {
  it('starts loading, then reports success with the data', async () => {
    const fn = vi.fn(async () => 'ok');
    const { result } = renderHook(() => useAsync(fn, []));

    expect(result.current.status).toBe('loading');
    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('ok');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not issue the request at all while disabled', async () => {
    const fn = vi.fn(async () => 'ok');
    const { result } = renderHook(() => useAsync(fn, [], { enabled: false }));

    expect(result.current.status).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fn).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();
  });

  it('issues the request once it becomes enabled', async () => {
    const fn = vi.fn(async () => 'ok');
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAsync(fn, [], { enabled }),
      { initialProps: { enabled: false } },
    );

    expect(fn).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ApiError unchanged, so the UI can use its status and kind', async () => {
    const thrown = new ApiError({
      message: "Person '99999' not found",
      status: 404,
      code: 'not_found',
      url: '/api/v1/graph/persons/999999',
    });
    const { result } = renderHook(() =>
      useAsync(async () => {
        throw thrown;
      }, []),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(thrown);
    expect(result.current.error?.kind).toBe('not_found');
  });

  it('wraps a non-ApiError throw rather than leaking it to the UI', async () => {
    const { result } = renderHook(() =>
      useAsync(async () => {
        throw new Error('boom');
      }, []),
    );

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.error?.code).toBe('client_error');
  });

  it('re-runs the same request on retry()', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('first attempt fails');
      return 'second attempt works';
    });
    const { result } = renderHook(() => useAsync(fn, []));

    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.data).toBe('second attempt works');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('re-runs when a dependency changes', async () => {
    const fn = vi.fn(async (_signal: AbortSignal, id: number) => `person ${id}`);
    const { result, rerender } = renderHook(
      ({ id }: { id: number }) => useAsync((signal) => fn(signal, id), [id]),
      { initialProps: { id: 445 } },
    );

    await waitFor(() => expect(result.current.data).toBe('person 445'));
    rerender({ id: 114 });
    await waitFor(() => expect(result.current.data).toBe('person 114'));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('aborts the in-flight request when it is superseded', async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          signals.push(signal);
          setTimeout(() => resolve('late'), 50);
        }),
    );
    const { rerender } = renderHook(({ id }: { id: number }) => useAsync(fn, [id]), {
      initialProps: { id: 1 },
    });

    rerender({ id: 2 });
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
  });

  it('ignores a resolution that arrives after unmount', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release: (value: string) => void = () => {};
    const { unmount } = renderHook(() =>
      useAsync(() => new Promise<string>((resolve) => (release = resolve)), []),
    );

    unmount();
    release('too late');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No "update on an unmounted component" warning, and nothing thrown.
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not treat an abort as an error', async () => {
    const { result, unmount } = renderHook(() =>
      useAsync(async (signal) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        signal.throwIfAborted();
        return 'ok';
      }, []),
    );

    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The hook is gone; what matters is that nothing was recorded as an error
    // before it went away.
    expect(result.current.error).toBeNull();
  });
});
