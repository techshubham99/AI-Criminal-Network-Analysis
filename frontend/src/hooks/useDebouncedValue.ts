import { useEffect, useState } from 'react';

/**
 * Debounce a rapidly-changing value (search box keystrokes) so the backend
 * receives one request per pause, not one per character.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
