import { IconButton } from './Button';
import { useTheme } from '@/hooks/useTheme';

/**
 * Theme toggle — one small icon button in the header, nothing more.
 *
 * The icon shows the theme you would get by clicking, which is the convention
 * users already expect from editors and terminals, and the accessible label says
 * so in words rather than relying on the glyph.
 *
 * All of the actual colour switching happens in CSS (`html[data-theme]` re-points
 * the design tokens), so this component owns no styling decisions beyond its own
 * two glyphs.
 */
function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <circle cx="12" cy="12" r="4.2" />
      <path
        strokeLinecap="round"
        d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20 14.4A8.4 8.4 0 1 1 9.6 4a6.7 6.7 0 0 0 10.4 10.4Z"
      />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <IconButton
      label={`Switch to ${next} theme`}
      variant="ghost"
      onClick={toggle}
      icon={theme === 'dark' ? <SunIcon /> : <MoonIcon />}
      className={className ? `size-7 ${className}` : 'size-7'}
      data-testid="theme-toggle"
      data-theme-state={theme}
    />
  );
}
