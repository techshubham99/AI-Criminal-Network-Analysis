/**
 * Theme toggle.
 *
 * Three things are worth pinning down, and they are the three that break:
 *
 *  1. DARK IS THE DEFAULT. With nothing stored, `<html>` carries `data-theme="dark"`.
 *  2. THE CHOICE PERSISTS. A click writes `cna.theme`, so a reload does not undo it.
 *  3. ONE STORE, MANY BUTTONS. The theme lives outside React, so every mounted
 *     toggle reflects the same value — a header toggle and a stray second copy
 *     cannot disagree.
 *
 * The colours themselves are CSS (`html[data-theme]` re-points the design tokens),
 * so what is asserted here is the attribute and the stored key, not pixel values.
 */
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_THEME, THEME_STORAGE_KEY, resetThemeForTests } from '@/hooks/useTheme';

import { ThemeToggle } from './ThemeToggle';

const stored = () => window.localStorage.getItem(THEME_STORAGE_KEY);
const applied = () => document.documentElement.getAttribute('data-theme');

describe('ThemeToggle', () => {
  beforeEach(resetThemeForTests);
  afterEach(resetThemeForTests);

  it('starts dark, with nothing stored', () => {
    render(<ThemeToggle />);

    expect(DEFAULT_THEME).toBe('dark');
    expect(applied()).toBe('dark');
    expect(stored()).toBeNull();

    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle).toHaveAttribute('data-theme-state', 'dark');
    // The label names the destination, not the current state.
    expect(toggle).toHaveAccessibleName('Switch to light theme');
  });

  it('switches to light and remembers it', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));

    expect(applied()).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(stored()).toBe('light');

    const toggle = screen.getByTestId('theme-toggle');
    expect(toggle).toHaveAttribute('data-theme-state', 'light');
    expect(toggle).toHaveAccessibleName('Switch to dark theme');
  });

  it('switches back, and stores the return trip too', () => {
    render(<ThemeToggle />);
    const toggle = screen.getByTestId('theme-toggle');

    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(applied()).toBe('dark');
    // Explicitly 'dark', not absent: an operator who chose dark on a machine that
    // later defaults to light should still get dark.
    expect(stored()).toBe('dark');
    expect(toggle).toHaveAttribute('data-theme-state', 'dark');
  });

  it('survives a remount, which is what a reload looks like from here', () => {
    const first = render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    first.unmount();

    render(<ThemeToggle />);

    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-theme-state', 'light');
    expect(applied()).toBe('light');
  });

  it('keeps every mounted toggle in step', () => {
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    );

    const [header, stray] = screen.getAllByTestId('theme-toggle');
    fireEvent.click(header);

    expect(header).toHaveAttribute('data-theme-state', 'light');
    expect(stray).toHaveAttribute('data-theme-state', 'light');
  });
});
