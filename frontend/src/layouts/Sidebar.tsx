/**
 * Sidebar — the four screens this build actually has a backend for.
 *
 * There are deliberately no entries for risk scoring, an audit/blockchain
 * ledger, or vehicle/organisation entities: the backend exposes none of those in
 * Phases 1-3, and a nav item that leads nowhere is a promise the prototype
 * cannot keep.
 *
 * Below `lg` the rail becomes a horizontally scrollable row of chips that keeps
 * both the icon and the label, so a 1024px laptop loses the descriptions but
 * never the destinations.
 */
import { NavLink } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';

import { cn } from '@/utils/cn';

interface NavItem {
  to: string;
  label: string;
  description: string;
  icon: ReactNode;
}

const ICON_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  className: 'size-4 shrink-0',
} as const;

/** Dashboard: four tiles. */
function CommandCenterIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.2" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.2" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.2" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.2" />
    </svg>
  );
}

/** Graph: three nodes and the edges between them. */
function NetworkIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M7.6 7.1 15.6 5.4M7.6 8.9 10.9 16.4M16.2 7.2 12.7 15.6" />
      <circle cx="5.5" cy="7.5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
    </svg>
  );
}

/** Document: a filed report. */
function FirIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M14 3H7a1.8 1.8 0 0 0-1.8 1.8v14.4A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V7.8z" />
      <path d="M14 3v4.8h4.8" />
      <path d="M8.6 12.6h6.8M8.6 16.2h4.6" />
    </svg>
  );
}

/** Fingerprint: provenance of a fact. */
function EvidenceIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M12 3.2a8.8 8.8 0 0 1 8.8 8.8" />
      <path d="M3.2 12A8.8 8.8 0 0 1 12 3.2" />
      <path d="M6.4 12a5.6 5.6 0 0 1 11.2 0v2.6" />
      <path d="M9.4 12a2.6 2.6 0 0 1 5.2 0v4.4" />
      <path d="M12 20.8v-8.5" />
      <path d="M6.4 15.8v1.9" />
    </svg>
  );
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    to: '/',
    label: 'Command Center',
    description: 'Dataset and graph scale, structural leads, corpus metrics',
    icon: <CommandCenterIcon />,
  },
  {
    to: '/network',
    label: 'Network Investigation',
    description: 'Expand a person one or two hops and read every edge',
    icon: <NetworkIcon />,
  },
  {
    to: '/fir',
    label: 'FIR Intelligence',
    description: 'FIR records with narrative extraction beside them',
    icon: <FirIcon />,
  },
  {
    to: '/evidence',
    label: 'Evidence & Provenance',
    description: 'Where each fact came from, and how confident the link is',
    icon: <EvidenceIcon />,
  },
];

export function Sidebar(): ReactElement {
  return (
    <nav
      aria-label="Primary"
      className="border-line bg-abyss/45 shrink-0 border-b lg:flex lg:h-full lg:w-60 lg:flex-col lg:border-r lg:border-b-0"
    >
      <div className="flex flex-row gap-1 overflow-x-auto px-2 py-2 lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-0.5 lg:overflow-x-visible lg:overflow-y-auto lg:py-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            // Without `end`, '/' would match every route and stay active.
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'group flex shrink-0 items-start gap-2.5 rounded-r-sm border-l-2 px-2.5 py-2 transition-colors lg:shrink',
                isActive
                  ? // A cyan rule plus one surface step: emphasis without a
                    // filled block, which would shout on a projector.
                    'border-cyan-500 bg-panel-2 text-ink'
                  : 'border-transparent text-ink-3 hover:border-line-strong hover:bg-panel/70 hover:text-ink-2',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span className={cn('mt-px shrink-0', isActive && 'text-cyan-300')}>
                  {item.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-semibold whitespace-nowrap">
                    {item.label}
                  </span>
                  <span className="text-ink-4 mt-0.5 hidden text-2xs leading-snug lg:block">
                    {item.description}
                  </span>
                </span>
              </>
            )}
          </NavLink>
        ))}
      </div>

      <div className="border-line hidden shrink-0 border-t px-3 py-3 lg:block">
        <p className="field-label">Build</p>
        <p className="text-ink-4 mt-1 text-2xs leading-relaxed">
          Local prototype over a synthetic dataset. No external services, no network calls beyond
          the local analysis API, read-only throughout.
        </p>
        <p className="text-ink-4 mt-2 text-2xs leading-relaxed">
          Phases 1-3 complete: data API, graph engine and analytics, narrative extraction.
        </p>
      </div>
    </nav>
  );
}
