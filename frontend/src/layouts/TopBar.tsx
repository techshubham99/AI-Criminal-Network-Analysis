/**
 * TopBar — brand, search, intake, clock, LIVE indicator, system status, theme.
 */
import { useEffect, useState, type ReactElement } from 'react';

import { api } from '@/api';
import { AddIntelligenceButton, LiveIndicator } from '@/components/live';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { Spinner, ThemeToggle, Tooltip } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { cn } from '@/utils/cn';

const HEALTH_POLL_MS = 30_000;
const HEALTHY_STATUS_TOKENS = new Set(['ok', 'healthy', 'up', 'pass']);
type StatusState = 'loading' | 'ok' | 'warn' | 'error';

const DOT_CLASS: Record<Exclude<StatusState, 'loading'>, string> = {
  ok: 'bg-ok-400',
  warn: 'bg-warn-400',
  error: 'bg-alert-400',
};

function useClock() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return time;
}

export function TopBar(): ReactElement {
  return (
    <header className="border-line bg-abyss/90 sticky top-0 z-40 border-b backdrop-blur-xl">
      {/* Subtle top gradient line */}
      <div className="from-cyan-500/20 to-transparent absolute inset-x-0 top-0 h-px bg-gradient-to-r" />
      <div className="flex h-13 items-center gap-3 px-4 lg:gap-4 lg:px-5">
        <ProductMark />
        <div className="border-line mx-1 hidden h-5 w-px shrink-0 lg:block" />
        <GlobalSearch className="min-w-0 flex-1 sm:max-w-sm lg:max-w-md" />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <AddIntelligenceButton />
          <Clock />
          <LiveIndicator className="hidden sm:flex" />
          <SystemStatus />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------- product mark -- */

function ProductMark() {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <svg
        viewBox="0 0 28 28"
        aria-hidden="true"
        className="text-cyan-400 size-6 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      >
        {/* Graph icon: 4 nodes with connections */}
        <path d="M7 7 20 10M7 7 12 20M20 10 12 20M20 10 23 20.5" opacity="0.45" />
        <circle className="fill-abyss" cx="7" cy="7" r="2.5" />
        <circle className="fill-abyss" cx="20" cy="10" r="2.5" />
        <circle className="fill-abyss" cx="12" cy="20" r="2.5" />
        <circle className="fill-abyss" cx="23" cy="20.5" r="1.8" />
      </svg>
      <div className="hidden items-baseline gap-2 sm:flex">
        <span className="text-ink text-sm font-bold tracking-[0.16em] uppercase">
          TRACEX
        </span>
        <span className="text-ink-4 hidden text-2xs font-medium tracking-[0.06em] xl:inline">
          Trace Every Connection
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- clock -- */

function Clock() {
  const time = useClock();
  const hhmm = time.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  const date = time.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div className="hidden flex-col items-end md:flex">
      <span className="text-ink font-mono text-xs font-semibold tabular-nums">{hhmm}</span>
      <span className="text-ink-4 text-2xs">{date}</span>
    </div>
  );
}

/* ------------------------------------------------------------ system status -- */

function SystemStatus() {
  const health = useAsync((signal) => api.getHealth({ signal }), []);
  const { retry } = health;

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) retry();
    }, HEALTH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [retry]);

  const data = health.data;
  const error = health.error;
  const statusToken = (data?.status ?? '').trim().toLowerCase();
  const statusOk = HEALTHY_STATUS_TOKENS.has(statusToken);

  let state: StatusState;
  if (error) state = 'error';
  else if (!data) state = 'loading';
  else if (!statusOk || !data.dataset_loaded) state = 'warn';
  else state = 'ok';

  const dot = (
    <button
      type="button"
      onClick={retry}
      aria-label={`System status: ${state}. Re-check.`}
      className="border-line bg-inset hover:border-line-accent flex size-7 shrink-0 items-center justify-center rounded-sm border transition-colors"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {state === 'loading' ? (
          <Spinner label="Checking" />
        ) : (
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-full', DOT_CLASS[state])}
          />
        )}
      </span>
    </button>
  );

  if (!data) return <div className="hidden shrink-0 sm:block">{dot}</div>;

  return (
    <div className="hidden shrink-0 sm:block" aria-live="polite">
      <Tooltip
        side="bottom"
        content={
          <span className="block space-y-0.5">
            <span className="text-ink block font-semibold">{data.app}</span>
            <span className="block">v{data.version}</span>
            <span className="block">Dataset {data.dataset_loaded ? 'loaded' : 'not loaded'}</span>
            {error ? <span className="text-alert-300 block">{error.message}</span> : null}
          </span>
        }
      >
        {dot}
      </Tooltip>
    </div>
  );
}
