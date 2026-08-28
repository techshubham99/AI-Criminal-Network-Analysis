import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';

/**
 * Panel — the standard bordered surface. Tight radius, hairline border, no drop
 * shadow: depth comes from the surface step, per the design tokens.
 *
 * Extra attributes pass through to the element, so a caller can attach an id,
 * `aria-*` or a test hook without wrapping the panel in a spare div.
 */
export function Panel({
  children,
  className,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'aside' | 'article';
} & Omit<HTMLAttributes<HTMLElement>, 'children' | 'className'>) {
  return (
    <Tag className={cn('bg-panel border border-line rounded-lg', className)} {...rest}>
      {children}
    </Tag>
  );
}

/**
 * PanelHeader — carries the panel title and optional right-aligned controls.
 * The 2px cyan inset rule on the left is the app's recurring "this is a section"
 * marker.
 */
export function PanelHeader({
  title,
  subtitle,
  actions,
  accent = true,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-start justify-between gap-3 border-b border-line px-4 py-3',
        accent && 'rule-accent',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-ink text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="text-ink-3 mt-0.5 text-xs">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function PanelBody({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={cn(padded && 'px-4 py-3', className)}>{children}</div>;
}
