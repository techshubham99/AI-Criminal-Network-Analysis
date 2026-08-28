/**
 * Sidebar — the nine product areas. Labels only, no descriptions.
 *
 * Every entry is a real route. Communication, Financial, Locations and Evidence
 * are independent screens, not tabs of the network page, so they are linked by
 * path and are reachable with no subject selected.
 */
import { NavLink, useLocation } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/utils/cn';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const P = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  className: 'size-4 shrink-0',
} as const;

const icons = {
  commandCenter: (
    <svg {...P}>
      <rect x="3" y="3" width="7" height="7" rx="1.2" />
      <rect x="14" y="3" width="7" height="7" rx="1.2" />
      <rect x="3" y="14" width="7" height="7" rx="1.2" />
      <rect x="14" y="14" width="7" height="7" rx="1.2" />
    </svg>
  ),
  investigations: (
    <svg {...P}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16.65 16.65 21 21" />
      <path d="M11 8v3l2 2" />
    </svg>
  ),
  network: (
    <svg {...P}>
      <path d="M7.5 7 16 5.2M7.5 9 11 16.5M16.5 7 13 15.8" />
      <circle cx="5.5" cy="7.5" r="2.3" />
      <circle cx="18" cy="5" r="2.3" />
      <circle cx="12" cy="19" r="2.3" />
    </svg>
  ),
  fir: (
    <svg {...P}>
      <path d="M14 3H7a1.8 1.8 0 0 0-1.8 1.8v14.4A1.8 1.8 0 0 0 7 21h10a1.8 1.8 0 0 0 1.8-1.8V7.8z" />
      <path d="M14 3v4.8h4.8" />
      <path d="M8.5 12.5h7M8.5 16h4.5" />
    </svg>
  ),
  communication: (
    <svg {...P}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.26h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.96a16 16 0 0 0 6.29 6.29l.96-1.34a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  ),
  financial: (
    <svg {...P}>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  locations: (
    <svg {...P}>
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  ),
  evidence: (
    <svg {...P}>
      <path d="M12 3.2a8.8 8.8 0 0 1 8.8 8.8" />
      <path d="M3.2 12A8.8 8.8 0 0 1 12 3.2" />
      <path d="M6.4 12a5.6 5.6 0 0 1 11.2 0v2.6" />
      <path d="M9.4 12a2.6 2.6 0 0 1 5.2 0v4.4" />
      <path d="M12 20.8v-8.5" />
      <path d="M6.4 15.8v1.9" />
    </svg>
  ),
  alerts: (
    <svg {...P}>
      <path d="M18 8.6a6 6 0 1 0-12 0c0 5-2 6.4-2 6.4h16s-2-1.4-2-6.4" />
      <path d="M13.7 19a2 2 0 0 1-3.4 0" />
    </svg>
  ),
};

const NAV_GROUPS: readonly NavGroup[] = [
  {
    items: [
      { to: '/', label: 'Command Center', icon: icons.commandCenter, end: true },
      { to: '/investigations', label: 'Investigations', icon: icons.investigations },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/network', label: 'Network', icon: icons.network },
      { to: '/fir', label: 'FIR Intelligence', icon: icons.fir },
      { to: '/communication', label: 'Communication', icon: icons.communication },
      { to: '/financial', label: 'Financial', icon: icons.financial },
      { to: '/locations', label: 'Locations', icon: icons.locations },
    ],
  },
  {
    label: 'Case',
    items: [
      { to: '/evidence', label: 'Evidence', icon: icons.evidence },
      { to: '/alerts', label: 'Alerts', icon: icons.alerts },
    ],
  },
];

export function Sidebar(): ReactElement {
  const location = useLocation();

  const isItemActive = (item: NavItem) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to);

  return (
    <nav
      aria-label="Primary"
      className="border-line bg-abyss/60 shrink-0 border-b backdrop-blur-sm lg:flex lg:h-full lg:w-52 lg:flex-col lg:border-r lg:border-b-0"
    >
      {/* Mobile: horizontal chip row */}
      <div className="flex flex-row gap-1 overflow-x-auto px-2 py-2 lg:hidden">
        {NAV_GROUPS.flatMap((g) => g.items).map((item) => {
          const active = isItemActive(item);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1.5 transition-colors',
                active
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                  : 'border-transparent text-ink-3 hover:bg-panel hover:text-ink-2',
              )}
            >
              <span className="shrink-0">{item.icon}</span>
              <span className="text-2xs font-semibold whitespace-nowrap">{item.label}</span>
            </NavLink>
          );
        })}
      </div>

      {/* Desktop: vertical grouped nav */}
      <div className="hidden min-h-0 flex-1 flex-col gap-0 overflow-y-auto py-3 lg:flex">
        {NAV_GROUPS.map((group, gi) => (
          <div key={gi} className={cn('pb-1', gi > 0 && 'mt-1')}>
            {group.label && (
              <p className="field-label px-3.5 pb-1.5 pt-2">{group.label}</p>
            )}
            {group.items.map((item) => {
              const active = isItemActive(item);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={cn(
                    'group mx-1.5 flex items-center gap-2.5 rounded-md border-l-2 px-2.5 py-2 transition-colors',
                    active
                      ? 'border-cyan-500 bg-panel-2 text-ink'
                      : 'border-transparent text-ink-3 hover:bg-panel/60 hover:text-ink-2',
                  )}
                >
                  <span className={cn('shrink-0', active && 'text-cyan-400')}>
                    {item.icon}
                  </span>
                  <span className="text-xs font-semibold whitespace-nowrap">{item.label}</span>
                </NavLink>
              );
            })}
            {gi < NAV_GROUPS.length - 1 && (
              <div className="border-line mx-3 mt-2 border-t" />
            )}
          </div>
        ))}
      </div>
    </nav>
  );
}
