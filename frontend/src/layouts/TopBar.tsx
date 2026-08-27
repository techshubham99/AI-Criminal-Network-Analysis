/**
 * TopBar — identity, global search, the active subject, and a live backend
 * heartbeat.
 *
 * The status cluster is driven entirely by `GET /health`; nothing about the
 * backend's state is asserted from a constant in this file. If the request
 * fails, the bar says so in words the operator can act on, which is the one
 * place in this UI where red is the correct colour.
 */
import { useEffect, type ReactElement } from 'react';

import { api } from '@/api';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { Mono, Spinner, Tooltip } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useInvestigation } from '@/hooks/useInvestigation';
import { humanizeToken } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Heartbeat interval. Slow on purpose: a backend restart should surface within
 * half a minute of a demo, and a tighter loop would be a busy timer for no
 * analytical gain. Ticks are skipped while the tab is hidden.
 */
const HEALTH_POLL_MS = 30_000;

/** Status strings this backend is known to report for a healthy service. */
const HEALTHY_STATUS_TOKENS = new Set(['ok', 'healthy', 'up', 'pass']);

type StatusState = 'loading' | 'ok' | 'warn' | 'error';

// Full class strings in a lookup — never assembled at runtime, because
// Tailwind v4 only generates what it can find as literal source text.
const DOT_CLASS: Record<Exclude<StatusState, 'loading'>, string> = {
  ok: 'bg-ok-400',
  warn: 'bg-warn-400',
  error: 'bg-alert-400',
};

const TEXT_CLASS: Record<Exclude<StatusState, 'loading'>, string> = {
  ok: 'text-ok-300',
  warn: 'text-warn-300',
  error: 'text-alert-300',
};

export function TopBar(): ReactElement {
  return (
    <header className="border-line bg-abyss/85 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4 lg:gap-5 lg:px-6">
        <ProductMark />
        <GlobalSearch className="min-w-0 flex-1 sm:max-w-md lg:max-w-lg" />
        <ActiveInvestigation />
        <SystemStatus />
      </div>
    </header>
  );
}

/* ------------------------------------------------------------- product mark -- */

function ProductMark() {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      {/* Four nodes and their links: the subject of the whole application,
          drawn in hairline strokes. Node interiors are filled with the shell
          background so the links appear to terminate at the node boundary. */}
      <svg
        viewBox="0 0 26 26"
        aria-hidden="true"
        className="text-cyan-400 size-6 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      >
        <path d="M6.5 6.5 18 9.5M6.5 6.5 11 19M18 9.5 11 19M18 9.5 21 19.5" opacity="0.55" />
        <circle className="fill-abyss" cx="6.5" cy="6.5" r="2.3" />
        <circle className="fill-abyss" cx="18" cy="9.5" r="2.3" />
        <circle className="fill-abyss" cx="11" cy="19" r="2.3" />
        <circle className="fill-abyss" cx="21" cy="19.5" r="1.5" />
      </svg>
      <div className="min-w-0 leading-tight">
        <p className="text-ink text-xs font-semibold tracking-[0.12em] whitespace-nowrap uppercase">
          Criminal Network Analysis
        </p>
        <p className="text-ink-4 hidden text-2xs whitespace-nowrap sm:block">
          Investigative Link Analysis · Prototype
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ active investigation -- */

function ActiveInvestigation() {
  const { subject, setSubject } = useInvestigation();

  if (!subject) {
    return (
      <div className="border-line bg-inset hidden shrink-0 rounded-md border px-2.5 py-1 md:block">
        <p className="field-label">Active investigation</p>
        <p className="mt-0.5 flex items-baseline gap-1.5 text-xs whitespace-nowrap">
          <span className="text-ink-3">No active subject</span>
          <span className="text-ink-4 hidden text-2xs xl:inline">
            · selecting a person on Network Investigation sets it
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="border-line-accent bg-inset hidden shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 md:flex">
      <div className="min-w-0">
        <p className="field-label whitespace-nowrap">Active investigation · {subject.kind}</p>
        <p className="mt-0.5 flex items-center gap-2">
          <span className="text-ink max-w-[11rem] truncate text-xs font-semibold">
            {subject.label}
          </span>
          <Mono className="hidden lg:inline" title="Prefixed entity id as returned by the backend">
            {subject.entityId}
          </Mono>
        </p>
      </div>
      <button
        type="button"
        onClick={() => setSubject(null)}
        aria-label={`Clear active investigation subject ${subject.label}`}
        title="Clear active subject"
        className="border-line-strong text-ink-4 hover:border-line-accent hover:text-ink-2 inline-flex size-5 shrink-0 items-center justify-center rounded-xs border transition-colors"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="size-2.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ system status -- */

function SystemStatus() {
  const health = useAsync((signal) => api.getHealth({ signal }), []);
  const { retry } = health;

  useEffect(() => {
    const timer = window.setInterval(() => {
      // No point polling a tab nobody is looking at, and it keeps a projector
      // machine idle between demos.
      if (!document.hidden) retry();
    }, HEALTH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [retry]);

  const data = health.data;
  const error = health.error;

  // `useAsync` clears `error` at the start of every attempt, so a non-null
  // error always describes the most recent attempt.
  const statusToken = (data?.status ?? '').trim().toLowerCase();
  const statusOk = HEALTHY_STATUS_TOKENS.has(statusToken);

  let state: StatusState;
  if (error) state = 'error';
  else if (!data) state = 'loading';
  else if (!statusOk || !data.dataset_loaded) state = 'warn';
  else state = 'ok';

  let primary: string;
  let secondary: string | null = null;

  if (error) {
    primary = error.isNetworkError ? 'Backend unreachable' : `Backend error ${error.status}`;
    secondary = error.isNetworkError ? 'Start the API, then retry' : 'Click to retry';
  } else if (!data) {
    primary = 'Checking backend';
  } else if (!statusOk) {
    primary = `Backend ${humanizeToken(data.status).toLowerCase()}`;
    secondary = `v${data.version}`;
  } else if (!data.dataset_loaded) {
    primary = 'Dataset not loaded';
    secondary = `v${data.version}`;
  } else {
    primary = 'Backend online';
    secondary = `v${data.version} · dataset loaded`;
  }

  const trigger = (
    <button
      type="button"
      onClick={retry}
      aria-label="Backend status — click to re-check"
      title={error ? `${error.message} (${error.url})` : undefined}
      className="hover:bg-panel-2/70 flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors"
    >
      {/* A fixed-size slot so the indicator does not shift the row when the
          spinner is replaced by the dot. Spinner is left at its default size
          rather than overridden, which avoids a same-family class conflict. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {state === 'loading' ? (
          <Spinner label="Checking backend status" />
        ) : (
          <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[state])} />
        )}
      </span>
      <span className="min-w-0">
        <span className="field-label block">System status</span>
        <span className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
          <span
            className={cn(
              'text-xs font-semibold',
              state === 'loading' ? 'text-ink-3' : TEXT_CLASS[state],
            )}
          >
            {primary}
          </span>
          {secondary ? (
            <span className="text-ink-4 hidden font-mono text-2xs lg:inline">{secondary}</span>
          ) : null}
        </span>
      </span>
    </button>
  );

  // With no payload there is nothing truthful to put in a details tooltip, so
  // the native title (carrying the ApiError message) stands alone.
  if (!data) {
    return <div className="hidden shrink-0 sm:block">{trigger}</div>;
  }

  return (
    <div className="hidden shrink-0 sm:block" aria-live="polite">
      <Tooltip
        side="bottom"
        content={
          <span className="block space-y-0.5">
            <span className="text-ink block font-semibold">{data.app}</span>
            <span className="block">Reported status: {humanizeToken(data.status)}</span>
            <span className="block">Version: {data.version}</span>
            <span className="block">Phase: {data.phase}</span>
            <span className="block">Environment: {humanizeToken(data.environment)}</span>
            <span className="block">
              Dataset: {data.dataset_loaded ? 'loaded' : 'not loaded'}
            </span>
            {error ? <span className="text-alert-300 block">{error.message}</span> : null}
            <span className="text-ink-4 block pt-1">
              Live from GET /health, re-checked every 30 s. Click to re-check now.
            </span>
          </span>
        }
      >
        {trigger}
      </Tooltip>
    </div>
  );
}
