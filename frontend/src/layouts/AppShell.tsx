/**
 * AppShell — the frame every screen renders inside.
 *
 * Structure: a fixed-height column (top bar, then a row of nav rail + scrolling
 * main) so the graph page can own a tall canvas without the whole document
 * scrolling underneath it. The shell itself performs no data fetching; the only
 * request it is responsible for is the `/health` heartbeat inside TopBar.
 *
 * `.tactical-grid` and `.shell-vignette` are the two background helpers from
 * `src/styles/index.css`: a very low-contrast 28px grid for tactical-display
 * depth, and a single soft cyan radial at the top edge. They must sit on
 * separate elements because both set `background-image`.
 */
import type { ReactElement, ReactNode } from 'react';

import { InvestigationProvider } from '@/hooks/useInvestigation';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  return (
    <InvestigationProvider>
      <div className="tactical-grid h-screen overflow-hidden">
        <div className="shell-vignette flex h-full flex-col">
          {/* First tab stop: lets a keyboard user jump the nav rail entirely. */}
          <a
            href="#main"
            className="focus:border-cyan-600/60 focus:bg-panel-3 sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-sm focus:border focus:px-3 focus:py-1.5 focus:text-xs focus:font-semibold focus:text-cyan-200"
          >
            Skip to main content
          </a>

          <TopBar />

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <Sidebar />

            {/* `tabIndex={-1}` so the skip link can actually move focus here.
                Main owns its own scroll container: the top bar and rail stay put
                while long result tables scroll. */}
            <main
              id="main"
              tabIndex={-1}
              className="min-h-0 min-w-0 flex-1 overflow-y-auto focus:outline-none"
            >
              <div className="mx-auto w-full max-w-[108rem] px-4 py-5 sm:px-6 lg:px-7 lg:py-6">
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
    </InvestigationProvider>
  );
}
