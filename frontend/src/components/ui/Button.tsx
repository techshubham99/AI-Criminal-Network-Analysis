import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { Spinner } from './Skeleton';

/**
 * Buttons and controls.
 *
 * Restraint is the point: a flat surface, a hairline border, a one-step colour
 * shift on hover, and a visible focus ring. No gradients, no glow, no transforms
 * — the brief asks for a credible operational tool, and moving buttons read as
 * consumer software on a projector.
 *
 * `danger` is the only variant that uses red, matching the palette rule that red
 * means alert or warning and nothing else.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'border-cyan-600/55 bg-cyan-500/14 text-cyan-200 hover:bg-cyan-500/22 hover:border-cyan-500/70',
  secondary:
    'border-line-strong bg-panel-2 text-ink-2 hover:bg-panel-3 hover:text-ink hover:border-line-accent',
  ghost: 'border-transparent bg-transparent text-ink-3 hover:bg-panel-2 hover:text-ink',
  danger:
    'border-alert-500/45 bg-alert-500/12 text-alert-300 hover:bg-alert-500/20 hover:border-alert-500/60',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-2xs',
  md: 'h-8.5 gap-2 px-3 text-xs',
};

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  className,
  type = 'button',
  disabled,
  ...rest
}: {
  children?: ReactNode;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm border font-semibold whitespace-nowrap transition-colors',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  className,
  variant = 'secondary',
  ...rest
}: {
  label: string;
  icon: ReactNode;
  variant?: Variant;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-sm border transition-colors',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}

/**
 * SegmentedControl — used for the 1-hop / 2-hop depth switch, where the two
 * options are mutually exclusive and both should stay visible so the demo
 * operator can see what the alternative is.
 */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
  disabled = false,
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'bg-inset border-line inline-flex items-center gap-0.5 rounded-sm border p-0.5',
        disabled && 'pointer-events-none opacity-45',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-xs px-2.5 py-1 text-2xs font-semibold whitespace-nowrap transition-colors',
              active
                ? 'bg-cyan-500/18 text-cyan-200 ring-1 ring-cyan-600/50 ring-inset'
                : 'text-ink-3 hover:bg-panel-2 hover:text-ink-2',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A labelled checkbox styled to match. Used for filter toggles where several
 * options can be on at once (relationship-type filters).
 */
export function CheckToggle({
  checked,
  onChange,
  children,
  accentColor,
  count,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  /** Palette colour for the swatch, taken from the entity/relationship vocabulary. */
  accentColor?: string;
  count?: number;
  className?: string;
}) {
  return (
    <label
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 transition-colors',
        'hover:bg-panel-2',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="border-line-strong checked:border-cyan-500 checked:bg-cyan-500/70 focus-visible:outline-cyan-400 size-3.5 shrink-0 appearance-none rounded-xs border bg-transparent transition-colors"
      />
      {accentColor ? (
        <span
          aria-hidden
          className="h-0.5 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: accentColor }}
        />
      ) : null}
      <span
        className={cn(
          'flex-1 truncate font-mono text-2xs transition-colors',
          checked ? 'text-ink-2' : 'text-ink-4',
        )}
      >
        {children}
      </span>
      {typeof count === 'number' ? (
        <span className="text-ink-4 shrink-0 font-mono text-2xs tabular-nums">{count}</span>
      ) : null}
    </label>
  );
}
