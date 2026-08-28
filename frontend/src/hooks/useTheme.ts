/**
 * Theme — dark by default, light on request, remembered locally.
 *
 * A module-level store rather than a React context: the attribute has to be on
 * `<html>` before the first paint (otherwise a light-mode reload flashes dark),
 * and every consumer wants the same single value. `useSyncExternalStore` keeps
 * React in step without a provider anyone can forget to mount.
 *
 * The colour work itself is entirely CSS: `src/styles/index.css` defines the dark
 * tokens on `:root` and overrides them under `html[data-theme='light']`, so every
 * Tailwind utility in the app resolves through the same variables and no
 * component needs a light-mode branch.
 */
import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';

/** Namespaced so it cannot collide with anything else on localhost. */
export const THEME_STORAGE_KEY = 'cna.theme';

/** Dark is the product default; light is opt-in. */
export const DEFAULT_THEME: Theme = 'dark';

const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

function readStored(): Theme {
  // Private-mode Safari throws on access, not just on write.
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    /* no persistence available — fall through to the default */
  }
  return DEFAULT_THEME;
}

let current: Theme = typeof window === 'undefined' ? DEFAULT_THEME : readStored();

/** Writes the attribute the stylesheet keys off, plus the UA colour scheme. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
}

// Runs on first import, i.e. before the app renders.
applyTheme(current);

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  if (theme === current) return;
  current = theme;
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* the theme still applies for this session */
  }
  for (const listener of listeners) listener();
}

export function toggleTheme(): void {
  setTheme(current === 'dark' ? 'light' : 'dark');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface UseThemeResult {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribe, getTheme, () => DEFAULT_THEME);
  return { theme, setTheme, toggle: toggleTheme };
}

/** Test-only reset: clears the stored preference and returns to the default. */
export function resetThemeForTests(): void {
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
  current = DEFAULT_THEME;
  applyTheme(current);
  for (const listener of listeners) listener();
}
