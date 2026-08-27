/**
 * The debounce is what keeps a search box from issuing one backend request per
 * keystroke, so its contract is: the first value is immediate, intermediate
 * keystrokes are discarded, and only the value that survives a full pause is
 * published.
 */
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDebouncedValue } from './useDebouncedValue';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDebouncedValue', () => {
  it('returns the initial value immediately, so nothing renders empty', () => {
    const { result } = renderHook(() => useDebouncedValue('ojas'));
    expect(result.current).toBe('ojas');
  });

  it('withholds a new value until the delay has fully elapsed', () => {
    const { result, rerender } = renderHook(({ value }: { value: string }) => useDebouncedValue(value, 250), {
      initialProps: { value: '' },
    });

    rerender({ value: 'oj' });
    expect(result.current).toBe('');

    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe('');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('oj');
  });

  it('publishes only the last of a burst of keystrokes', () => {
    const { result, rerender } = renderHook(({ value }: { value: string }) => useDebouncedValue(value, 250), {
      initialProps: { value: '' },
    });

    for (const value of ['o', 'oj', 'oja', 'ojas']) {
      rerender({ value });
      act(() => vi.advanceTimersByTime(100)); // never long enough to fire
    }
    expect(result.current).toBe('');

    act(() => vi.advanceTimersByTime(250));
    expect(result.current).toBe('ojas');
  });

  it('honours a custom delay', () => {
    const { result, rerender } = renderHook(({ value }: { value: string }) => useDebouncedValue(value, 50), {
      initialProps: { value: 'a' },
    });

    rerender({ value: 'b' });
    act(() => vi.advanceTimersByTime(50));
    expect(result.current).toBe('b');
  });

  it('works for non-string values too', () => {
    const { result, rerender } = renderHook(({ value }: { value: number | null }) => useDebouncedValue(value, 100), {
      initialProps: { value: null as number | null },
    });

    rerender({ value: 445 });
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe(445);
  });
});
