/**
 * The basemap of India, drawn from vendored geometry.
 *
 * No tiles, no map API, no map library, no network call: `india-basemap.ts` ships
 * the state and district boundaries as already projected SVG paths, and this
 * component draws them. Whatever the caller passes as children is drawn on top in
 * the same projected space, so it must be positioned with `project()`.
 *
 * Strokes use `vectorEffect="non-scaling-stroke"`, which keeps a border one CSS
 * pixel wide at whatever size the panel gives us — the view box is in degrees, so
 * a plain stroke width would grow and shrink with the container.
 */
import { useId, type ReactElement, type ReactNode } from 'react';

import { INDIA_BOUNDS, INDIA_DISTRICT_LINES, INDIA_STATES, INDIA_VIEWBOX } from './india-basemap';

/** Every state boundary as one path, for the fill and the coastal glow. */
const LAND = INDIA_STATES.map((state) => state.d).join('');

/** Meridians and parallels, every five degrees, inside the drawn area. */
const MERIDIANS = [70, 75, 80, 85, 90, 95];
const PARALLELS = [10, 15, 20, 25, 30, 35];

export interface IndiaMapProps {
  /** What the map is of, for assistive technology. */
  readonly label: string;
  /**
   * States to light up because the data being plotted is in them, matched on the
   * Census spelling, case-insensitively. Everything else stays unlit.
   */
  readonly activeStates?: ReadonlySet<string>;
  /**
   * A tighter window on the same projected space, for zooming into one place.
   * Defaults to the whole country. Keep its aspect ratio equal to the country's
   * or the fitted map will move inside its box.
   */
  readonly viewBox?: string;
  readonly className?: string;
  /** Plotted layer, positioned in projected map units. */
  readonly children?: ReactNode;
}

export function IndiaMap({
  label,
  activeStates,
  viewBox = INDIA_VIEWBOX,
  className,
  children,
}: IndiaMapProps): ReactElement {
  // Two of these can be on screen at once, so the ids have to be per instance.
  const scope = useId().replace(/[^a-zA-Z0-9]/g, '');
  const sea = `sea-${scope}`;
  const glow = `glow-${scope}`;

  return (
    <svg
      viewBox={viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
      className={className}
      data-testid="india-map"
    >
      <defs>
        <radialGradient id={sea} cx="50%" cy="42%" r="72%">
          <stop offset="0%" stopColor="var(--color-panel-2)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--color-inset)" stopOpacity="0.35" />
        </radialGradient>
        <filter id={glow} x="-8%" y="-8%" width="116%" height="116%">
          <feGaussianBlur stdDeviation="0.22" />
        </filter>
      </defs>

      <rect
        x={INDIA_BOUNDS.minX}
        y={INDIA_BOUNDS.minY}
        width={INDIA_BOUNDS.maxX - INDIA_BOUNDS.minX}
        height={INDIA_BOUNDS.maxY - INDIA_BOUNDS.minY}
        fill={`url(#${sea})`}
      />

      {/* Graticule, under the land: enough to read the map as a map, no labels. */}
      <g
        stroke="var(--color-line)"
        strokeWidth="0.5"
        strokeOpacity="0.35"
        vectorEffect="non-scaling-stroke"
      >
        {MERIDIANS.map((lon) => (
          <line
            key={`m${lon}`}
            x1={lon}
            y1={-42}
            x2={lon}
            y2={-5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {PARALLELS.map((lat) => {
          const y = -(180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
          return (
            <line key={`p${lat}`} x1={66} y1={y} x2={99} y2={y} vectorEffect="non-scaling-stroke" />
          );
        })}
      </g>

      {/* Coastal halo, then the landmass itself. */}
      <path d={LAND} fill="var(--color-cyan-600)" fillOpacity="0.28" filter={`url(#${glow})`} />
      <path d={LAND} fill="var(--color-panel-3)" fillOpacity="0.95" />

      {/* District borders as texture, cut off at the coast by the land above. */}
      <path
        d={INDIA_DISTRICT_LINES}
        fill="none"
        stroke="var(--color-line)"
        strokeWidth="0.4"
        strokeOpacity="0.5"
        vectorEffect="non-scaling-stroke"
      />

      {/* States, each one its own path so the ones with data can be lit. */}
      <g fill="none" stroke="var(--color-line-strong)" strokeWidth="0.7">
        {INDIA_STATES.map((state) => {
          const active = activeStates?.has(state.name.toLowerCase()) ?? false;
          return (
            <path
              key={state.name}
              d={state.d}
              fill={active ? 'var(--color-cyan-900)' : 'none'}
              fillOpacity={active ? 0.55 : 0}
              stroke={active ? 'var(--color-line-accent)' : 'var(--color-line-strong)'}
              strokeWidth={active ? 0.9 : 0.7}
              vectorEffect="non-scaling-stroke"
              data-testid="india-map-state"
              data-state={state.name}
              data-active={active ? 'true' : undefined}
            >
              <title>{state.name}</title>
            </path>
          );
        })}
      </g>

      {children}
    </svg>
  );
}
