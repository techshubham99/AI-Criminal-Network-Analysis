/**
 * TopBar — identity, global search, the active subject, the theme toggle, the
 * live-channel indicator and a backend heartbeat.
 *
 * The two status readouts answer different questions: LIVE is the SSE event
 * stream (is this dashboard being told about changes?), while the heartbeat is
 * `GET /health` (is the backend up at all?). One can be off while the other is on.
 *
 * The status cluster is driven entirely by `GET /health`; nothing about the
 * backend's state is asserted from a constant in this file. If the request
 * fails, the bar says so in words the operator can act on, which is the one
 * place in this UI where red is the correct colour. The visible readout is one
 * word — the detail lives in a tooltip rather than on the chrome.
 */
import { useEffect, type ReactElement } from 'react';

import { api } from '@/api';
import { LiveIndicator } from '@/components/live';
import { GlobalSearch } from '@/components/search/GlobalSearch';
import { Mono, Spinner, ThemeToggle, Tooltip } from '@/components/ui';
import { useAsync } from '@/hooks/useAsync';
import { useInvestigation } from '@/hooks/useInvestigation';
import { humanizeToken } from '@/utils/format';
import { cn } from '@/utils/cn';

/**
 * Heartbeat interval. Slow on purpose: a backend restart should surface within
 * half a minute, and a tighter loop would be a busy timer for no analytical
 * gain. Ticks are skipped while the tab is hidden.
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
        <LiveIndicator className="hidden sm:flex" />
        <SystemStatus />
        <ThemeToggle />
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
      <p className="text-ink text-xs font-semibold tracking-[0.12em] whitespace-nowrap uppercase">
        Criminal Network Analysis
      </p>
    </div>
  );
}

/* ------------------------------------------------------ active investigation -- */

function ActiveInvestigation() {
  const { subject, setSubject } = useInvestigation();

  if (!subject) {
    return (
      <div className="border-line bg-inset hidden shrink-0 rounded-md border px-2.5 py-1 md:block">
        <p className="field-label">Active subject</p>
        <p className="text-ink-3 mt-0.5 text-xs whitespace-nowrap">None</p>
      </div>
    );
  }

  return (
    <div className="border-line-accent bg-inset hidden shrink-0 items-center gap-2 rounded-md border px-2.5 py-1 md:flex">
      <div className="min-w-0">
        <p className="field-label whitespace-nowrap">Active subject · {subject.kind}</p>
        <p className="mt-0.5 flex items-center gap-2">
          <span className="text-ink max-w-[11rem] truncate text-xs font-semibold">
            {subject.label}
          </span>
          <Mono className="hidden lg:inline">{subject.entityId}</Mono>
        </p>
      </div>
      <button
        type="button"
        onClick={() => setSubject(null)}
        aria-label={`Clear active subject ${subject.label}`}
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
      // No point polling a tab nobody is looking at.
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

  // One word where one word will do. The full picture is in the tooltip.
  let label: string;
  if (error) label = error.isNetworkError ? 'Offline' : `Error ${error.status}`;
  else if (!data) label = 'Checking';
  else if (!statusOk) label = humanizeToken(data.status);
  else if (!data.dataset_loaded) label = 'No dataset';
  else label = 'Online';

  const trigger = (
    <button
      type="button"
      onClick={retry}
      aria-label={`System status: ${label}. Re-check now.`}
      title={error ? error.message : undefined}
      className={cn(
        'border-line bg-inset hover:border-line-accent flex shrink-0 items-center gap-2 rounded-md border px-2 py-1 transition-colors',
      )}
    >
      {/* A fixed-size slot so the indicator does not shift the row when the
          spinner is replaced by the dot. Spinner is left at its default size
          rather than overridden, which avoids a same-family class conflict. */}
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {state === 'loading' ? (
          <Spinner label="Checking system status" />
        ) : (
          <span aria-hidden="true" className={cn('size-2 rounded-full', DOT_CLASS[state])} />
        )}
      </span>
      <span
        className={cn(
          'text-2xs font-semibold whitespace-nowrap',
          state === 'loading' ? 'text-ink-3' : TEXT_CLASS[state],
        )}
      >
        {label}
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
            <span className="block">Version {data.version}</span>
            <span className="block">Dataset {data.dataset_loaded ? 'loaded' : 'not loaded'}</span>
            {error ? <span className="text-alert-300 block">{error.message}</span> : null}
            <span className="text-ink-4 block pt-1">Click to re-check.</span>
          </span>
        }
      >
        {trigger}
      </Tooltip>
    </div>
  );
}
